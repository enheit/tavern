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

    /// Leave to Idle. Idempotent: returns the channel we left, or None if already idle.
    pub fn leave(&mut self) -> Option<String> {
        let ch = self.state.channel_id().map(str::to_string);
        self.state = VoiceState::Idle;
        ch
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
}
