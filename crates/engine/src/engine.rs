//! The voice engine: public API (`engine_configure`, `voice_join`/`voice_leave`, mute/deafen,
//! per-user gain, `set_remote_tracks`, `engine_status`) tying signaling + a single libwebrtc
//! PeerConnection + the APM pipeline + cpal I/O together (PLAN §1 Engine⇄UI surface, voice
//! subset). One SFU session = one PeerConnection: the mic is a send-only track; auto-subscribed
//! remote mics are added to the same PC and answered via renegotiate.
//!
//! The pure decision logic lives in [`crate::state`]/[`crate::remote`]/[`crate::mixer`]/
//! [`crate::pipeline`] (all unit-tested). This module is the live orchestration — first exercised
//! end-to-end at S4.3 (P6); `// ponytail:` marks the shortcuts that real hardware validates.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use libwebrtc::audio_source::native::NativeAudioSource;
use libwebrtc::audio_source::AudioSourceOptions;
use libwebrtc::audio_stream::native::NativeAudioStream;
use libwebrtc::media_stream_track::MediaStreamTrack;
use libwebrtc::peer_connection::{AnswerOptions, OfferOptions, PeerConnection, TrackEvent};
use libwebrtc::peer_connection_factory::native::PeerConnectionFactoryExt;
use libwebrtc::peer_connection_factory::{
    ContinualGatheringPolicy, IceServer, IceTransportsType, PeerConnectionFactory, RtcConfiguration,
};
use libwebrtc::rtp_transceiver::{RtpTransceiverDirection, RtpTransceiverInit};
use libwebrtc::session_description::{SdpType, SessionDescription};
use tavern_protocol::TrackInfo;
use tokio::sync::mpsc;

use crate::apm::RealApm;
use crate::audio::{self, Driver, Level, RemoteMix};
use crate::pipeline::{AudioPipeline, MicState, SAMPLE_RATE};
use crate::remote::{diff_mic, TrackRef};
use crate::signaling::{PublishTrack, Signaling};
use crate::state::{EngineError, VoiceSm, VoiceState};

const AUDIO_HZ: u32 = SAMPLE_RATE as u32;

/// Sink the Tauri layer registers to forward `engine://levels` (10 Hz RMS).
type LevelsSink = Arc<dyn Fn(Vec<Level>) + Send + Sync>;
/// Sink the Tauri layer registers to forward `engine://state`.
type StateSink = Arc<dyn Fn(String) + Send + Sync>;
/// Sink for the §1 `engine://stats {json}` @1 Hz feed (also the P6 rttMs source).
type StatsSink = Arc<dyn Fn(serde_json::Value) + Send + Sync>;
/// Sink for engine error events; codes prefixed `audio_` are device errors (P6 deviceErrors).
type ErrorSink = Arc<dyn Fn(String) + Send + Sync>;

/// Snapshot returned by `engine_status()`.
#[derive(Debug, Clone)]
pub struct EngineStatus {
    pub voice: String,
    pub publishing: Vec<PublishedTrack>,
    pub watching: Vec<WatchingTrack>,
    /// Webview WebCodecs support — reported through the engine per §1; set at S6.3 (video). Voice
    /// does not use WebCodecs, so it stays `false` here.
    pub webcodecs_ok: bool,
}

#[derive(Debug, Clone)]
pub struct PublishedTrack {
    pub kind: String,
    pub track_name: String,
}

#[derive(Debug, Clone)]
pub struct WatchingTrack {
    pub owner_id: String,
    pub track_name: String,
    pub layer: String,
}

/// Live handles for an active voice session. Dropping it tears the session down. The mic
/// `NativeAudioSource` is kept alive by the driver task's clone, so it needn't be held here.
struct Session {
    pc: Arc<PeerConnection>,
    /// Set to true on leave; the driver task + device thread watch it and exit.
    stop: Arc<AtomicBool>,
    device_thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.device_thread.take() {
            let _ = t.join();
        }
    }
}

/// The Tavern voice engine. `Send + Sync` so the Tauri layer can hold it as managed state; the
/// non-`Send` cpal streams are confined to a dedicated device thread.
pub struct Engine {
    factory: PeerConnectionFactory,
    sig: Mutex<Option<Signaling>>,
    sm: Mutex<VoiceSm>,
    mic_state: MicState,
    remote: RemoteMix,
    /// Currently auto-subscribed remote mics.
    subs: Mutex<BTreeSet<TrackRef>>,
    /// Last full roster the UI forwarded (mic diff is computed against it while in voice).
    roster: Mutex<Vec<TrackInfo>>,
    /// trackNames we published (to skip our own tracks in the mic diff + report status).
    published: Mutex<Vec<PublishedTrack>>,
    session: Mutex<Option<Session>>,
    /// Remote audio tracks the SFU adds to our PC, in arrival order (paired to subscribes). Held
    /// in an async mutex so the subscribe path can `recv().await` without blocking other locks.
    track_rx:
        tokio::sync::Mutex<Option<mpsc::UnboundedReceiver<libwebrtc::audio_track::RtcAudioTrack>>>,
    on_levels: Mutex<Option<LevelsSink>>,
    on_state: Mutex<Option<StateSink>>,
    on_stats: Mutex<Option<StatsSink>>,
    on_error: Mutex<Option<ErrorSink>>,
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

impl Engine {
    pub fn new() -> Self {
        Self {
            factory: PeerConnectionFactory::default(),
            sig: Mutex::new(None),
            sm: Mutex::new(VoiceSm::new()),
            mic_state: MicState::default(),
            remote: RemoteMix::default(),
            subs: Mutex::new(BTreeSet::new()),
            roster: Mutex::new(Vec::new()),
            published: Mutex::new(Vec::new()),
            session: Mutex::new(None),
            track_rx: tokio::sync::Mutex::new(None),
            on_levels: Mutex::new(None),
            on_state: Mutex::new(None),
            on_stats: Mutex::new(None),
            on_error: Mutex::new(None),
        }
    }

    /// `engine_configure({apiBase, token})` — set/rotate the signaling target. Called after
    /// login/boot and on token change, before any voice command.
    pub fn configure(&self, api_base: &str, token: &str) {
        *self.sig.lock().unwrap() = Some(Signaling::new(api_base, token));
    }

    /// Register the RMS-levels sink (Tauri bridges it to `engine://levels`). Test/UI seam.
    pub fn set_levels_sink(&self, cb: Arc<dyn Fn(Vec<Level>) + Send + Sync>) {
        *self.on_levels.lock().unwrap() = Some(cb);
    }
    /// Register the voice-state sink (Tauri bridges it to `engine://state`).
    pub fn set_state_sink(&self, cb: Arc<dyn Fn(String) + Send + Sync>) {
        *self.on_state.lock().unwrap() = Some(cb);
    }
    /// Register the §1 1 Hz stats sink (Tauri bridges it to `engine://stats`).
    pub fn set_stats_sink(&self, cb: StatsSink) {
        *self.on_stats.lock().unwrap() = Some(cb);
    }
    /// Register the error sink. Codes prefixed `audio_` are device errors (P6 deviceErrors).
    pub fn set_error_sink(&self, cb: ErrorSink) {
        *self.on_error.lock().unwrap() = Some(cb);
    }

    fn signaling(&self) -> Result<Signaling, EngineError> {
        self.sig
            .lock()
            .unwrap()
            .clone()
            .ok_or(EngineError::NotConfigured)
    }

    fn emit_state(&self, label: &str) {
        if let Some(cb) = self.on_state.lock().unwrap().clone() {
            cb(label.to_string());
        }
    }

    pub fn set_mic_muted(&self, muted: bool) {
        self.mic_state.set_muted(muted);
    }

    /// Deafen: silence all output AND suppress the mic; undeafen restores the prior mic state
    /// (suppress = muted OR deafened, so `muted` is never clobbered — §1).
    pub fn set_deafened(&self, deafened: bool) {
        self.mic_state.set_deafened(deafened);
    }

    pub fn set_user_gain(&self, user_id: &str, gain: f32) {
        self.remote.set_gain(user_id, gain);
    }

    pub fn status(&self) -> EngineStatus {
        EngineStatus {
            voice: self.sm.lock().unwrap().state().label().to_string(),
            publishing: self.published.lock().unwrap().clone(),
            watching: Vec::new(), // video watching is S5
            webcodecs_ok: false,
        }
    }

    /// `voice_join(channelId)` → the mic trackName. Establishes the SFU session, publishes the mic
    /// (client is the offerer), and starts capture + playout. Double-join is rejected.
    pub async fn voice_join(&self, channel_id: &str) -> Result<String, EngineError> {
        let sig = self.signaling()?;
        // Guard first (double-join → error before any I/O).
        self.sm.lock().unwrap().begin_join(channel_id)?;
        self.emit_state("connecting");

        let joined = self.establish(&sig, channel_id).await;
        match joined {
            Ok(track_name) => {
                self.sm.lock().unwrap().mark_connected();
                self.emit_state("connected");
                // Rosters may have arrived while idle/connecting (hello.ok precedes the join) —
                // sync mic subscriptions against the remembered roster now that a session exists.
                self.sync_subscriptions().await;
                Ok(track_name)
            }
            Err(e) => {
                // Roll back the state machine + any partial SFU session on failure.
                self.sm.lock().unwrap().leave();
                let _ = sig.close(channel_id).await;
                self.emit_state("idle");
                Err(e)
            }
        }
    }

    async fn establish(&self, sig: &Signaling, channel_id: &str) -> Result<String, EngineError> {
        sig.session(channel_id).await?;

        let pc = Arc::new(
            self.factory
                .create_peer_connection(rtc_config())
                .map_err(|e| EngineError::Media(format!("create_peer_connection: {e:?}")))?,
        );

        // Route SFU-added remote audio tracks to the subscribe path (arrival order = subscribe
        // order, since subscribes are serialized). // ponytail: order-pairing; if the SFU ever
        // reorders, correlate via the pull response's mid — S4.3 validates.
        let (track_tx, track_rx) = mpsc::unbounded_channel();
        pc.on_track(Some(Box::new(move |ev: TrackEvent| {
            if let MediaStreamTrack::Audio(at) = ev.track {
                let _ = track_tx.send(at);
            }
        })));

        // Mic: NativeAudioSource fed by the driver; trackName = `mic-{uuid}` (§1).
        let mic_track_name = format!("mic-{}", uuid::Uuid::new_v4());
        let mic_source = NativeAudioSource::new(AudioSourceOptions::default(), AUDIO_HZ, 1, 1000);
        let mic_track = self
            .factory
            .create_audio_track(&mic_track_name, mic_source.clone());
        let mst: MediaStreamTrack = mic_track.into();
        let tvr = pc
            .add_transceiver(
                mst,
                RtpTransceiverInit {
                    direction: RtpTransceiverDirection::SendOnly,
                    stream_ids: vec!["tavern-mic".into()],
                    send_encodings: Vec::new(),
                },
            )
            .map_err(|e| EngineError::Media(format!("add_transceiver: {e:?}")))?;

        // Offer (send-only) → publish → apply the SFU answer.
        let offer = pc
            .create_offer(OfferOptions {
                ice_restart: false,
                offer_to_receive_audio: false,
                offer_to_receive_video: false,
            })
            .await
            .map_err(|e| EngineError::Media(format!("create_offer: {e:?}")))?;
        let offer_sdp = offer.to_string();
        pc.set_local_description(offer)
            .await
            .map_err(|e| EngineError::Media(format!("set_local: {e:?}")))?;
        let mid = tvr
            .mid()
            .ok_or_else(|| EngineError::Media("no mic mid".into()))?;

        let track = PublishTrack {
            track_name: mic_track_name.clone(),
            kind: "mic".into(),
            mid,
            width: 0,
            height: 0,
            fps: 0,
            simulcast: false,
        };
        let answer = sig.publish(channel_id, &track, &offer_sdp).await?;
        pc.set_remote_description(
            SessionDescription::parse(&answer.sdp, SdpType::Answer)
                .map_err(|e| EngineError::Media(format!("parse answer: {e:?}")))?,
        )
        .await
        .map_err(|e| EngineError::Media(format!("set_remote: {e:?}")))?;

        // Start device I/O + the 10 ms driver.
        let stop = Arc::new(AtomicBool::new(false));
        let (capture, playout) = audio::device_rings();
        let device_thread = spawn_device_thread(
            capture.clone(),
            playout.clone(),
            stop.clone(),
            self.on_error.lock().unwrap().clone(),
        );

        let driver = Driver {
            capture,
            playout,
            remote: self.remote.clone(),
            mic_state: self.mic_state.clone(),
            self_user_id: String::new(),
            stop: stop.clone(),
            on_levels: self.on_levels.lock().unwrap().clone(),
        };
        let pipe = AudioPipeline::new(RealApm::new(), self.mic_state.clone());
        let mic_for_driver = mic_source.clone();
        tokio::spawn(async move { driver.run(pipe, mic_for_driver).await });

        // §1 `engine://stats {json}` @1 Hz while the session lives (also the P6 rttMs source).
        if let Some(stats_sink) = self.on_stats.lock().unwrap().clone() {
            let pc_stats = pc.clone();
            let stop_stats = stop.clone();
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
                tick.tick().await; // skip the immediate first fire
                while !stop_stats.load(Ordering::Relaxed) {
                    tick.tick().await;
                    if let Ok(stats) = pc_stats.get_stats().await {
                        stats_sink(stats_json(&pc_stats, &stats));
                    }
                }
            });
        }

        *self.published.lock().unwrap() = vec![PublishedTrack {
            kind: "mic".into(),
            track_name: mic_track_name.clone(),
        }];
        *self.track_rx.lock().await = Some(track_rx);
        *self.session.lock().unwrap() = Some(Session {
            pc,
            stop,
            device_thread: Some(device_thread),
        });
        Ok(mic_track_name)
    }

    /// `voice_leave()` — close the SFU session and tear down capture/playout. Idempotent.
    pub async fn voice_leave(&self) -> Result<(), EngineError> {
        let channel = self.sm.lock().unwrap().leave();
        let session = self.session.lock().unwrap().take(); // Drop stops the device thread
        *self.track_rx.lock().await = None;
        self.subs.lock().unwrap().clear();
        self.remote.clear();
        self.published.lock().unwrap().clear();
        drop(session);
        if let (Some(channel), Ok(sig)) = (channel, self.signaling()) {
            let _ = sig.close(&channel).await;
        }
        self.emit_state("idle");
        Ok(())
    }

    /// `set_remote_tracks(tracks)` — store the full roster and, while in voice, auto-subscribe new
    /// remote mics + tear down vanished ones (video is never auto-subscribed).
    pub async fn set_remote_tracks(&self, tracks: Vec<TrackInfo>) -> Result<(), EngineError> {
        *self.roster.lock().unwrap() = tracks;
        self.sync_subscriptions().await;
        Ok(())
    }

    /// Diff the remembered roster against current mic subscriptions and converge. No-op when not
    /// in voice; also invoked right after `voice_join` (rosters can predate the session).
    async fn sync_subscriptions(&self) {
        let channel = {
            let sm = self.sm.lock().unwrap();
            let in_voice = matches!(
                sm.state(),
                VoiceState::Connected { .. } | VoiceState::Connecting { .. }
            );
            match (in_voice, sm.state().channel_id()) {
                (true, Some(c)) => c.to_string(),
                _ => return, // idle: the roster is just remembered
            }
        };
        let Ok(sig) = self.signaling() else { return };

        // Own published tracks are filtered out by trackName (no need to know our userId).
        let own: BTreeSet<String> = self
            .published
            .lock()
            .unwrap()
            .iter()
            .map(|p| p.track_name.clone())
            .collect();
        let visible: Vec<TrackInfo> = self
            .roster
            .lock()
            .unwrap()
            .iter()
            .filter(|t| !own.contains(&t.track_name))
            .cloned()
            .collect();
        let current = self.subs.lock().unwrap().clone();
        let diff = diff_mic(&current, &visible, "");

        for tr in diff.subscribe {
            if self.subscribe_mic(&sig, &channel, &tr).await.is_ok() {
                self.subs.lock().unwrap().insert(tr);
            }
        }
        for tr in diff.unsubscribe {
            let _ = sig
                .unsubscribe(&channel, &tr.owner_id, &tr.track_name)
                .await;
            self.remote.remove(&tr.owner_id);
            self.subs.lock().unwrap().remove(&tr);
        }
    }

    /// Pull one remote mic into our PC (client answers the SFU offer) and pipe its decoded PCM
    /// into that owner's playout ring.
    async fn subscribe_mic(
        &self,
        sig: &Signaling,
        channel: &str,
        tr: &TrackRef,
    ) -> Result<(), EngineError> {
        let pc = match self.session.lock().unwrap().as_ref() {
            Some(s) => s.pc.clone(),
            None => return Err(EngineError::Media("no session".into())),
        };
        // Mic tracks are single-encoding; layer "h" is ignored server-side.
        let offer = sig
            .subscribe(channel, &tr.owner_id, &tr.track_name, "h")
            .await?;
        pc.set_remote_description(
            SessionDescription::parse(&offer.sdp, SdpType::Offer)
                .map_err(|e| EngineError::Media(format!("parse pull offer: {e:?}")))?,
        )
        .await
        .map_err(|e| EngineError::Media(format!("set_remote(offer): {e:?}")))?;
        let answer = pc
            .create_answer(AnswerOptions::default())
            .await
            .map_err(|e| EngineError::Media(format!("create_answer: {e:?}")))?;
        let answer_sdp = answer.to_string();
        pc.set_local_description(answer)
            .await
            .map_err(|e| EngineError::Media(format!("set_local(answer): {e:?}")))?;
        if offer.requires_reneg {
            sig.renegotiate(channel, &answer_sdp).await?;
        }

        // Bind the next SFU-added audio track to this owner's ring (async mutex → no lock held
        // across the recv await).
        let at = {
            let mut guard = self.track_rx.lock().await;
            let rx = guard
                .as_mut()
                .ok_or_else(|| EngineError::Media("no session".into()))?;
            tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
                .await
                .map_err(|_| EngineError::Media("no remote track within 5s".into()))?
                .ok_or_else(|| EngineError::Media("track channel closed".into()))?
        };
        let ring = self.remote.ring_for(&tr.owner_id);
        tokio::spawn(async move {
            let mut stream = Box::pin(NativeAudioStream::new(at, SAMPLE_RATE, 1));
            while let Some(frame) = stream.next().await {
                let mut r = ring.lock().unwrap();
                r.extend(frame.data.iter().copied());
                // Bound the ring so a slow tick can't grow it without bound (~500 ms).
                while r.len() > (SAMPLE_RATE as usize) / 2 {
                    r.pop_front();
                }
            }
        });
        Ok(())
    }
}

fn rtc_config() -> RtcConfiguration {
    RtcConfiguration {
        ice_servers: vec![IceServer {
            urls: vec!["stun:stun.cloudflare.com:3478".to_string()],
            username: String::new(),
            password: String::new(),
        }],
        continual_gathering_policy: ContinualGatheringPolicy::GatherOnce,
        ice_transport_type: IceTransportsType::All,
    }
}

/// cpal `Stream`s are `!Send`, so they live on their own thread that parks until `stop`.
/// Device-init failures are reported through the error sink with `audio_*` codes — the
/// P6 `deviceErrors` definition counts exactly these.
fn spawn_device_thread(
    capture: audio::Ring,
    playout: audio::Ring,
    stop: Arc<AtomicBool>,
    on_error: Option<ErrorSink>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let report = |code: String| {
            eprintln!("[engine] {code}");
            if let Some(cb) = &on_error {
                cb(code);
            }
        };
        let _in =
            audio::start_capture(capture).map_err(|e| report(format!("audio_capture_init: {e}")));
        let _out =
            audio::start_playout(playout).map_err(|e| report(format!("audio_playout_init: {e}")));
        while !stop.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        // Streams drop here, stopping cpal.
    })
}

/// Build the §1 `engine://stats` JSON from one `get_stats` snapshot: aggregate RTP counters,
/// the ICE state, and `rttMs` from the nominated/succeeded candidate pair (the P6 measure).
fn stats_json(pc: &PeerConnection, stats: &[libwebrtc::stats::RtcStats]) -> serde_json::Value {
    use libwebrtc::stats::{IceCandidatePairState, RtcStats};
    let (mut bytes_sent, mut bytes_received) = (0u64, 0u64);
    let (mut frames_encoded, mut frames_decoded, mut pli_count) = (0u32, 0u32, 0u32);
    let mut rtt_ms: Option<f64> = None;
    for s in stats {
        match s {
            RtcStats::OutboundRtp(o) => {
                bytes_sent += o.sent.bytes_sent;
                frames_encoded += o.outbound.frames_encoded;
                pli_count += o.outbound.pli_count;
            }
            RtcStats::InboundRtp(i) => {
                bytes_received += i.inbound.bytes_received;
                frames_decoded += i.inbound.frames_decoded;
                pli_count += i.inbound.pli_count;
            }
            RtcStats::CandidatePair(p) => {
                let usable = p.candidate_pair.nominated
                    || matches!(
                        p.candidate_pair.state,
                        Some(IceCandidatePairState::Succeeded)
                    );
                if usable && p.candidate_pair.current_round_trip_time > 0.0 {
                    rtt_ms = Some(p.candidate_pair.current_round_trip_time * 1000.0);
                }
            }
            _ => {}
        }
    }
    serde_json::json!({
        "bytesSent": bytes_sent,
        "bytesReceived": bytes_received,
        "framesEncoded": frames_encoded,
        "framesDecoded": frames_decoded,
        "pliCount": pli_count,
        "iceState": format!("{:?}", pc.ice_connection_state()),
        "rttMs": rtt_ms,
    })
}

// Both tests build a `PeerConnectionFactory` (real libwebrtc), so the whole module is macOS-only
// (hard gate per §1); on Linux/Windows the engine still compiles and the device-free module tests
// run. The live orchestration in this file is validated end-to-end at S4.3 (P6).
#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    /// The non-I/O public API works without a network/device: configure, status, mute/deafen,
    /// gain, and idle set_remote_tracks (which just remembers the roster, no subscribe).
    #[tokio::test]
    async fn non_io_api_surface() {
        let eng = Engine::new();
        // Not configured yet → voice ops error out cleanly.
        assert!(matches!(
            eng.voice_join("c1").await,
            Err(EngineError::NotConfigured)
        ));

        eng.configure("http://localhost:8787", "tok");
        assert_eq!(eng.status().voice, "idle");
        assert!(eng.status().publishing.is_empty());

        eng.set_mic_muted(true);
        eng.set_deafened(true);
        eng.set_user_gain("bob", 1.5);

        // Idle set_remote_tracks stores the roster and does not subscribe (no network hit).
        let roster = vec![TrackInfo {
            owner_id: "bob".into(),
            track_name: "mic-b".into(),
            kind: "mic".into(),
            simulcast: false,
            width: 0,
            height: 0,
            fps: 0,
        }];
        eng.set_remote_tracks(roster).await.unwrap();
        assert!(eng.subs.lock().unwrap().is_empty());

        // voice_leave when idle is a no-op.
        eng.voice_leave().await.unwrap();
        assert_eq!(eng.status().voice, "idle");
    }

    #[test]
    fn state_sink_fires_on_configure_changes() {
        use std::sync::atomic::AtomicUsize;
        let eng = Engine::new();
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        eng.set_state_sink(Arc::new(move |_s| {
            c.fetch_add(1, Ordering::Relaxed);
        }));
        eng.emit_state("idle");
        assert_eq!(count.load(Ordering::Relaxed), 1);
    }
}
