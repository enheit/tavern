//! Voice session state machine (pure). Guards the join/leave transitions the engine drives; the
//! actual signaling + PeerConnection work hangs off these transitions. `Reconnecting` is part of
//! the §1 status contract; its transitions land with reconnection (S6.1).

/// Errors surfaced by engine operations.
#[derive(Debug)]
pub enum EngineError {
    /// `voice_join` called while already joining/joined (double-join rejected, §1).
    AlreadyInVoice,
    /// A screen/webcam start while a share of that kind is already live (§1: one per kind).
    AlreadySharing,
    /// A voice/media op was attempted before `engine_configure`.
    NotConfigured,
    /// Signaling (`/api/rtc/*`) failure.
    Signaling(crate::signaling::SignalError),
    /// Audio-processing failure.
    Apm(crate::apm::ApmError),
    /// Screen/webcam capture failure (typed: permission / portal / source / device).
    Capture(tavern_capture::CaptureError),
    /// Capture / playout / PeerConnection failure.
    Media(String),
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineError::AlreadyInVoice => write!(f, "already in voice"),
            EngineError::AlreadySharing => write!(f, "already sharing"),
            EngineError::NotConfigured => write!(f, "engine not configured"),
            EngineError::Signaling(e) => write!(f, "{e}"),
            EngineError::Apm(e) => write!(f, "{e}"),
            EngineError::Capture(e) => write!(f, "capture: {e}"),
            EngineError::Media(e) => write!(f, "media: {e}"),
        }
    }
}
impl std::error::Error for EngineError {}

impl From<crate::signaling::SignalError> for EngineError {
    fn from(e: crate::signaling::SignalError) -> Self {
        EngineError::Signaling(e)
    }
}
impl From<crate::apm::ApmError> for EngineError {
    fn from(e: crate::apm::ApmError) -> Self {
        EngineError::Apm(e)
    }
}
impl From<tavern_capture::CaptureError> for EngineError {
    fn from(e: tavern_capture::CaptureError) -> Self {
        EngineError::Capture(e)
    }
}

/// Voice connection state (`engine_status().voice`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VoiceState {
    Idle,
    Connecting { channel_id: String },
    Connected { channel_id: String },
    Reconnecting { channel_id: String },
}

impl VoiceState {
    /// The `engine_status().voice` label.
    pub fn label(&self) -> &'static str {
        match self {
            VoiceState::Idle => "idle",
            VoiceState::Connecting { .. } => "connecting",
            VoiceState::Connected { .. } => "connected",
            VoiceState::Reconnecting { .. } => "reconnecting",
        }
    }
    /// The channel we're in (any active state), else None.
    pub fn channel_id(&self) -> Option<&str> {
        match self {
            VoiceState::Idle => None,
            VoiceState::Connecting { channel_id }
            | VoiceState::Connected { channel_id }
            | VoiceState::Reconnecting { channel_id } => Some(channel_id),
        }
    }
}

/// The voice state machine. Transitions are total and guarded; the engine performs I/O between
/// `begin_join` and `mark_connected`.
pub struct VoiceSm {
    state: VoiceState,
}

impl Default for VoiceSm {
    fn default() -> Self {
        Self {
            state: VoiceState::Idle,
        }
    }
}

impl VoiceSm {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn state(&self) -> &VoiceState {
        &self.state
    }

    /// Idle → Connecting. Any already-active state is a double-join and is rejected.
    pub fn begin_join(&mut self, channel_id: &str) -> Result<(), EngineError> {
        match self.state {
            VoiceState::Idle => {
                self.state = VoiceState::Connecting {
                    channel_id: channel_id.to_string(),
                };
                Ok(())
            }
            _ => Err(EngineError::AlreadyInVoice),
        }
    }

    /// Connecting/Reconnecting → Connected (same channel). No-op if already Connected.
    pub fn mark_connected(&mut self) {
        if let Some(ch) = self.state.channel_id() {
            self.state = VoiceState::Connected {
                channel_id: ch.to_string(),
            };
        }
    }

    /// Connected → Reconnecting (ICE dropped, S6.1). Other states are left alone —
    /// a disconnect during teardown/join is handled by those flows.
    pub fn mark_reconnecting(&mut self) {
        if let VoiceState::Connected { channel_id } = &self.state {
            self.state = VoiceState::Reconnecting {
                channel_id: channel_id.clone(),
            };
        }
    }

    /// Leave to Idle. Idempotent: returns the channel we left, or None if already idle.
    pub fn leave(&mut self) -> Option<String> {
        let ch = self.state.channel_id().map(str::to_string);
        self.state = VoiceState::Idle;
        ch
    }
}

/// §1/S6.1: bounded recovery attempts — 5 windows, then give up with an error event.
pub const RECONNECT_MAX_ATTEMPTS: u32 = 5;

/// What the reconnect driver should do next (pure decision, I/O-free).
#[derive(Debug, PartialEq, Eq)]
pub enum ReconnectDecision {
    /// ICE dropped while stable → run restart attempt 1.
    Start,
    /// ICE-drop event while a restart loop is already running → ignore it.
    AlreadyRestarting,
    /// An attempt reconnected → back to stable.
    Recovered,
    /// Attempt failed → run the next one.
    Retry { attempt: u32 },
    /// All `RECONNECT_MAX_ATTEMPTS` attempts failed → surface the error event.
    GiveUp,
}

/// The S6.1 reconnect state machine: disconnect → restarting(1..=5) → connected,
/// or 5-attempt exhaustion → GiveUp. Pure; the engine's ICE task drives it.
#[derive(Default)]
pub struct ReconnectSm {
    restarting: bool,
    attempts: u32,
}

impl ReconnectSm {
    /// ICE went down (disconnected/failed).
    pub fn on_ice_down(&mut self) -> ReconnectDecision {
        if self.restarting {
            return ReconnectDecision::AlreadyRestarting;
        }
        self.restarting = true;
        self.attempts = 0;
        ReconnectDecision::Start
    }

    /// Outcome of one restart attempt (`connected` = ICE came back within the window).
    pub fn on_attempt(&mut self, connected: bool) -> ReconnectDecision {
        if connected {
            self.restarting = false;
            self.attempts = 0;
            return ReconnectDecision::Recovered;
        }
        self.attempts += 1;
        if self.attempts >= RECONNECT_MAX_ATTEMPTS {
            self.restarting = false;
            ReconnectDecision::GiveUp
        } else {
            ReconnectDecision::Retry {
                attempt: self.attempts + 1,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// DoD: join→connected→leave, idempotent, and double-join is an error.
    #[test]
    fn join_connected_leave_idempotent_and_double_join_rejected() {
        let mut sm = VoiceSm::new();
        assert_eq!(sm.state().label(), "idle");

        sm.begin_join("chan1").unwrap();
        assert_eq!(sm.state().label(), "connecting");
        assert_eq!(sm.state().channel_id(), Some("chan1"));

        // Double-join while connecting → error, state unchanged.
        assert!(matches!(
            sm.begin_join("chan2"),
            Err(EngineError::AlreadyInVoice)
        ));
        assert_eq!(sm.state().channel_id(), Some("chan1"));

        sm.mark_connected();
        assert_eq!(sm.state().label(), "connected");

        // Double-join while connected → error too.
        assert!(matches!(
            sm.begin_join("chan1"),
            Err(EngineError::AlreadyInVoice)
        ));

        // Leave returns the channel, goes idle.
        assert_eq!(sm.leave().as_deref(), Some("chan1"));
        assert_eq!(sm.state().label(), "idle");

        // Leave again is idempotent (no error, no channel).
        assert_eq!(sm.leave(), None);
        assert_eq!(sm.state().label(), "idle");

        // Can re-join after leaving.
        sm.begin_join("chan3").unwrap();
        assert_eq!(sm.state().channel_id(), Some("chan3"));
    }

    /// S6.1 DoD: disconnect → restarting → connected, mirrored on the voice SM labels.
    #[test]
    fn reconnect_disconnect_restarting_connected() {
        let mut vsm = VoiceSm::new();
        vsm.begin_join("chan1").unwrap();
        vsm.mark_connected();

        let mut rsm = ReconnectSm::default();
        assert_eq!(rsm.on_ice_down(), ReconnectDecision::Start);
        vsm.mark_reconnecting();
        assert_eq!(vsm.state().label(), "reconnecting");
        assert_eq!(vsm.state().channel_id(), Some("chan1"));

        // A second ICE-down event while restarting is ignored.
        assert_eq!(rsm.on_ice_down(), ReconnectDecision::AlreadyRestarting);

        // Attempt 1 fails, attempt 2 reconnects.
        assert_eq!(
            rsm.on_attempt(false),
            ReconnectDecision::Retry { attempt: 2 }
        );
        assert_eq!(rsm.on_attempt(true), ReconnectDecision::Recovered);
        vsm.mark_connected();
        assert_eq!(vsm.state().label(), "connected");

        // Fully reset: a later drop starts a fresh 5-attempt budget.
        assert_eq!(rsm.on_ice_down(), ReconnectDecision::Start);
    }

    /// S6.1 DoD: 5-retry exhaustion → GiveUp (the error event).
    #[test]
    fn reconnect_five_attempt_exhaustion_gives_up() {
        let mut rsm = ReconnectSm::default();
        assert_eq!(rsm.on_ice_down(), ReconnectDecision::Start);
        for attempt in 2..=RECONNECT_MAX_ATTEMPTS {
            assert_eq!(rsm.on_attempt(false), ReconnectDecision::Retry { attempt });
        }
        assert_eq!(rsm.on_attempt(false), ReconnectDecision::GiveUp);

        // After giving up, a new ICE drop starts over.
        assert_eq!(rsm.on_ice_down(), ReconnectDecision::Start);
    }

    /// mark_reconnecting only fires from Connected (idle/connecting are left alone).
    #[test]
    fn mark_reconnecting_only_from_connected() {
        let mut sm = VoiceSm::new();
        sm.mark_reconnecting();
        assert_eq!(sm.state().label(), "idle");
        sm.begin_join("c").unwrap();
        sm.mark_reconnecting();
        assert_eq!(sm.state().label(), "connecting");
    }
}
