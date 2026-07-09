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
use libwebrtc::peer_connection::{
    AnswerOptions, IceConnectionState, OfferOptions, PeerConnection, TrackEvent,
};
use libwebrtc::peer_connection_factory::native::PeerConnectionFactoryExt;
use libwebrtc::peer_connection_factory::{
    ContinualGatheringPolicy, IceServer, IceTransportsType, PeerConnectionFactory, RtcConfiguration,
};
use libwebrtc::rtp_transceiver::{RtpTransceiverDirection, RtpTransceiverInit};
use libwebrtc::session_description::{SdpType, SessionDescription};
use libwebrtc::video_source::native::NativeVideoSource;
use libwebrtc::video_source::VideoResolution;
use tavern_capture::{
    config, CaptureBackend, CaptureConfig, CaptureSession, FrameSink, NativeBackend, SourceInfo,
    WebcamInfo,
};
use tavern_protocol::TrackInfo;
use tokio::sync::mpsc;

use crate::apm::RealApm;
use crate::audio::{self, Driver, Level, RemoteMix};
use crate::pipeline::{AudioPipeline, MicState, SAMPLE_RATE};
use crate::remote::{diff_mic, TrackRef};
use crate::signaling::{PublishTrack, Signaling};
use crate::state::{EngineError, ReconnectDecision, ReconnectSm, VoiceSm, VoiceState};
use crate::video::{self, SharesSm, VideoKind};
use crate::watch::{self, ChunkSink, WatchHandle};

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
    /// Webview WebCodecs support — the S6.3 boot probe reports it via `set_webcodecs_ok`.
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

/// A live screen/webcam publish: the capture pump + the video source it feeds. Dropping it
/// stops the capture thread (PumpSession::drop); the transceiver stays on the PC but goes
/// silent. // ponytail: transceivers aren't removed on stop — a re-share adds a new one
/// (bounded by user actions per session); reuse them if mid exhaustion ever matters.
struct ActiveVideo {
    kind: VideoKind,
    track_name: String,
    _session: Box<dyn CaptureSession>,
    _source: NativeVideoSource,
}

/// A live video watch (S5.4): the str0m pull leg for one remote stream.
struct WatchEntry {
    owner_id: String,
    track_name: String,
    layer: String,
    handle: WatchHandle,
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
    /// Arc so the S6.1 reconnect task can mirror ICE recovery into the status label.
    sm: Arc<Mutex<VoiceSm>>,
    mic_state: MicState,
    remote: RemoteMix,
    /// Currently auto-subscribed remote mics.
    subs: Mutex<BTreeSet<TrackRef>>,
    /// Last full roster the UI forwarded (mic diff is computed against it while in voice).
    roster: Mutex<Vec<TrackInfo>>,
    /// trackNames we published (to skip our own tracks in the mic diff + report status).
    published: Mutex<Vec<PublishedTrack>>,
    /// One-share-per-kind guard (screen/webcam), pure SM in [`crate::video`].
    shares: Mutex<SharesSm>,
    /// Live screen/webcam publishes (capture pump + video source).
    videos: Mutex<Vec<ActiveVideo>>,
    /// Live video watches (str0m pull legs), shared with the 1 Hz stats task.
    watches: Arc<Mutex<Vec<WatchEntry>>>,
    /// §1: webview WebCodecs support, reported by the boot probe (S6.3).
    webcodecs_ok: AtomicBool,
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
            sm: Arc::new(Mutex::new(VoiceSm::new())),
            mic_state: MicState::default(),
            remote: RemoteMix::default(),
            subs: Mutex::new(BTreeSet::new()),
            roster: Mutex::new(Vec::new()),
            published: Mutex::new(Vec::new()),
            shares: Mutex::new(SharesSm::default()),
            videos: Mutex::new(Vec::new()),
            watches: Arc::new(Mutex::new(Vec::new())),
            webcodecs_ok: AtomicBool::new(false),
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

    fn emit_error(&self, code: &str) {
        if let Some(cb) = self.on_error.lock().unwrap().clone() {
            cb(code.to_string());
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

    /// S6.3 boot probe result: `typeof VideoDecoder !== 'undefined'` in the webview,
    /// reported through the engine per §1 (`engine_status().webcodecsOk`).
    pub fn set_webcodecs_ok(&self, ok: bool) {
        self.webcodecs_ok.store(ok, Ordering::Relaxed);
    }

    pub fn status(&self) -> EngineStatus {
        EngineStatus {
            voice: self.sm.lock().unwrap().state().label().to_string(),
            publishing: self.published.lock().unwrap().clone(),
            watching: self
                .watches
                .lock()
                .unwrap()
                .iter()
                .map(|w| WatchingTrack {
                    owner_id: w.owner_id.clone(),
                    track_name: w.track_name.clone(),
                    layer: w.layer.clone(),
                })
                .collect(),
            webcodecs_ok: self.webcodecs_ok.load(Ordering::Relaxed),
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

        // S6.1 reconnection: ICE disconnect/failure → bounded recovery windows, then a
        // `reconnect_failed` error event. The stop flag is created early so leave()
        // cancels the task along with everything else.
        let stop = Arc::new(AtomicBool::new(false));
        let (ice_tx, ice_rx) = mpsc::unbounded_channel();
        pc.on_ice_connection_state_change(Some(Box::new(move |st: IceConnectionState| {
            let _ = ice_tx.send(st);
        })));
        self.spawn_reconnect_task(pc.clone(), stop.clone(), ice_rx);

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

        // §1 `engine://stats {json}` @1 Hz while the session lives (also the P6 rttMs and
        // P5 droppedChunks source — per-stream counters ride along from the watch legs).
        if let Some(stats_sink) = self.on_stats.lock().unwrap().clone() {
            let pc_stats = pc.clone();
            let stop_stats = stop.clone();
            let watches = self.watches.clone();
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
                tick.tick().await; // skip the immediate first fire
                while !stop_stats.load(Ordering::Relaxed) {
                    tick.tick().await;
                    if let Ok(stats) = pc_stats.get_stats().await {
                        let mut json = stats_json(&pc_stats, &stats);
                        let streams: Vec<serde_json::Value> = watches
                            .lock()
                            .unwrap()
                            .iter()
                            .map(|w| {
                                serde_json::json!({
                                    "ownerId": w.owner_id,
                                    "trackName": w.track_name,
                                    "layer": w.layer,
                                    "droppedChunks": w.handle.dropped_chunks(),
                                    "bytesReceived": w.handle.bytes_received(),
                                    "mediaBytes": w.handle.media_bytes(),
                                })
                            })
                            .collect();
                        json["streams"] = serde_json::Value::Array(streams);
                        stats_sink(json);
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

    /// `voice_leave()` — close the SFU session and tear down capture/playout + any live
    /// screen/webcam shares (rtc/close clears them server-side). Idempotent.
    pub async fn voice_leave(&self) -> Result<(), EngineError> {
        let channel = self.sm.lock().unwrap().leave();
        let session = self.session.lock().unwrap().take(); // Drop stops the device thread
        if let Some(s) = session.as_ref() {
            // Drop the ICE observer: its channel sender is what keeps the S6.1 reconnect
            // task (and through it the PC) alive — clearing it lets both wind down.
            s.pc.on_ice_connection_state_change(None);
        }
        *self.track_rx.lock().await = None;
        self.subs.lock().unwrap().clear();
        self.remote.clear();
        self.published.lock().unwrap().clear();
        self.shares.lock().unwrap().clear();
        self.videos.lock().unwrap().clear(); // Drop joins the capture pumps
        self.watches.lock().unwrap().clear(); // Drop stops the str0m pull threads
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

    // ---- screen share / webcam (S5.2) ------------------------------------------------------

    /// `screen_sources()` — shareable screens + windows (§1 command).
    pub fn screen_sources(&self) -> Result<Vec<SourceInfo>, EngineError> {
        Ok(NativeBackend.list_screen_sources()?)
    }

    /// `webcam_list()` (§1 command).
    pub fn webcam_list(&self) -> Result<Vec<WebcamInfo>, EngineError> {
        Ok(NativeBackend.list_webcams()?)
    }

    /// `screen_share_start({sourceId,width,height,fps})` → the screen trackName.
    /// `width=0,height=0` = native (§1). Requires an active voice session.
    pub async fn screen_share_start(
        &self,
        source_id: &str,
        width: u32,
        height: u32,
        fps: u32,
    ) -> Result<String, EngineError> {
        self.start_video(
            VideoKind::Screen,
            source_id,
            CaptureConfig { width, height, fps },
        )
        .await
    }

    /// `screen_share_stop()` — `/api/rtc/unpublish` + capture teardown. Idempotent.
    pub async fn screen_share_stop(&self) -> Result<(), EngineError> {
        self.stop_video(VideoKind::Screen).await
    }

    /// `webcam_start({deviceId,width,height,fps})` → the webcam trackName.
    pub async fn webcam_start(
        &self,
        device_id: &str,
        width: u32,
        height: u32,
        fps: u32,
    ) -> Result<String, EngineError> {
        self.start_video(
            VideoKind::Webcam,
            device_id,
            CaptureConfig { width, height, fps },
        )
        .await
    }

    /// `webcam_stop()` — `/api/rtc/unpublish` + capture teardown. Idempotent.
    pub async fn webcam_stop(&self) -> Result<(), EngineError> {
        self.stop_video(VideoKind::Webcam).await
    }

    async fn start_video(
        &self,
        kind: VideoKind,
        source_id: &str,
        cfg: CaptureConfig,
    ) -> Result<String, EngineError> {
        let sig = self.signaling()?;
        let (channel, pc) = {
            let sm = self.sm.lock().unwrap();
            let channel = match sm.state() {
                VoiceState::Connected { channel_id } => channel_id.clone(),
                _ => return Err(EngineError::Media("not in voice".into())),
            };
            let pc = self
                .session
                .lock()
                .unwrap()
                .as_ref()
                .map(|s| s.pc.clone())
                .ok_or_else(|| EngineError::Media("no session".into()))?;
            (channel, pc)
        };
        self.shares.lock().unwrap().begin(kind)?;

        match self
            .publish_video(kind, source_id, cfg, &sig, &channel, pc)
            .await
        {
            Ok(active) => {
                let name = active.track_name.clone();
                self.shares.lock().unwrap().mark_active(kind, &name);
                self.published.lock().unwrap().push(PublishedTrack {
                    kind: kind.as_str().into(),
                    track_name: name.clone(),
                });
                self.videos.lock().unwrap().push(active);
                Ok(name)
            }
            Err(e) => {
                self.shares.lock().unwrap().abort(kind);
                // DoD: the share-cap 409 surfaces as a typed engine event.
                if let Some(code) = video::error_event_code(&e) {
                    self.emit_error(code);
                }
                Err(e)
            }
        }
    }

    /// Capture → NativeVideoSource (`is_screencast` on screens) → offer → `/api/rtc/publish`
    /// with the §1 layers/bitrates → SFU answer. Frames drop until the publish succeeds
    /// (the sink's source cell stays empty), then flow on the capture thread.
    async fn publish_video(
        &self,
        kind: VideoKind,
        source_id: &str,
        cfg: CaptureConfig,
        sig: &Signaling,
        channel: &str,
        pc: Arc<PeerConnection>,
    ) -> Result<ActiveVideo, EngineError> {
        let fps = if cfg.fps == 0 { 30 } else { cfg.fps };

        let target: Arc<Mutex<Option<NativeVideoSource>>> = Arc::new(Mutex::new(None));
        let sink: FrameSink = {
            let target = target.clone();
            Box::new(move |frame| {
                if let Some(source) = target.lock().unwrap().as_ref() {
                    source.capture_frame(&frame);
                }
            })
        };
        let session = match kind {
            VideoKind::Screen => NativeBackend.open_screen(source_id, cfg, sink)?,
            VideoKind::Webcam => NativeBackend.open_webcam(source_id, cfg, sink)?,
        };

        // The §1 plan: webcams are planned from the requested cfg; screens need the real
        // source dims (native sizing + bucketing), known after the first frame.
        let plan = match kind {
            VideoKind::Webcam => config::plan_webcam(cfg.width, cfg.height, fps),
            VideoKind::Screen => {
                let (sw, sh) = wait_source_size(session.as_ref()).await?;
                config::plan_screen(cfg.height, fps, sw, sh)
            }
        };

        let source = NativeVideoSource::new(
            VideoResolution {
                width: plan.h.width,
                height: plan.h.height,
            },
            matches!(kind, VideoKind::Screen), // is_screencast=true on screen tracks (§1)
        );
        let track_name = format!("{}-{}", kind.as_str(), uuid::Uuid::new_v4());
        let track = self.factory.create_video_track(&track_name, source.clone());
        let mst: MediaStreamTrack = track.into();
        let tvr = pc
            .add_transceiver(
                mst,
                RtpTransceiverInit {
                    direction: RtpTransceiverDirection::SendOnly,
                    stream_ids: vec!["tavern-video".into()],
                    send_encodings: video::encodings_for(&plan),
                },
            )
            .map_err(|e| EngineError::Media(format!("add_transceiver(video): {e:?}")))?;

        let offer = pc
            .create_offer(OfferOptions {
                ice_restart: false,
                offer_to_receive_audio: false,
                offer_to_receive_video: false,
            })
            .await
            .map_err(|e| EngineError::Media(format!("create_offer(video): {e:?}")))?;
        let offer_sdp = offer.to_string();
        pc.set_local_description(offer)
            .await
            .map_err(|e| EngineError::Media(format!("set_local(video): {e:?}")))?;
        let mid = tvr
            .mid()
            .ok_or_else(|| EngineError::Media("no video mid".into()))?;

        let publish_track = PublishTrack {
            track_name: track_name.clone(),
            kind: kind.as_str().into(),
            mid,
            width: plan.h.width,
            height: plan.h.height,
            fps: plan.h.fps,
            simulcast: plan.simulcast(),
        };
        let answer = sig.publish(channel, &publish_track, &offer_sdp).await?;
        pc.set_remote_description(
            SessionDescription::parse(&answer.sdp, SdpType::Answer)
                .map_err(|e| EngineError::Media(format!("parse video answer: {e:?}")))?,
        )
        .await
        .map_err(|e| EngineError::Media(format!("set_remote(video): {e:?}")))?;

        // Arm the sink — frames start reaching the encoder.
        *target.lock().unwrap() = Some(source.clone());
        Ok(ActiveVideo {
            kind,
            track_name,
            _session: session,
            _source: source,
        })
    }

    /// `stream_watch({ownerId, trackName, layer, frames})` — pull one remote video stream
    /// via the str0m watch leg (S1.4 branch) and feed §1-framed chunks into `sink`.
    /// A live watch of the same stream is replaced (§1 layer change = unsubscribe+subscribe).
    pub async fn stream_watch(
        &self,
        owner_id: &str,
        track_name: &str,
        layer: &str,
        sink: ChunkSink,
    ) -> Result<(), EngineError> {
        let sig = self.signaling()?;
        let channel = {
            let sm = self.sm.lock().unwrap();
            match sm.state() {
                VoiceState::Connected { channel_id } => channel_id.clone(),
                _ => return Err(EngineError::Media("not in voice".into())),
            }
        };
        // Replace an existing watch of this stream (pin swap re-subscribes).
        self.stream_unwatch(owner_id, track_name).await?;

        let offer = sig.subscribe(&channel, owner_id, track_name, layer).await?;
        let (answer_sdp, handle) = watch::start_watch(&offer.sdp, sink)?;
        sig.renegotiate_watch(&channel, owner_id, track_name, &answer_sdp)
            .await?;
        self.watches.lock().unwrap().push(WatchEntry {
            owner_id: owner_id.to_string(),
            track_name: track_name.to_string(),
            layer: layer.to_string(),
            handle,
        });
        Ok(())
    }

    /// `stream_unwatch({ownerId, trackName})` — stop the pull leg and tell the server
    /// (accrual stops; the SFU force-closes the pulled track). Idempotent.
    pub async fn stream_unwatch(
        &self,
        owner_id: &str,
        track_name: &str,
    ) -> Result<(), EngineError> {
        let entry = {
            let mut watches = self.watches.lock().unwrap();
            let pos = watches
                .iter()
                .position(|w| w.owner_id == owner_id && w.track_name == track_name);
            pos.map(|i| watches.remove(i))
        };
        let Some(mut entry) = entry else {
            return Ok(());
        };
        entry.handle.stop();
        let channel = self
            .sm
            .lock()
            .unwrap()
            .state()
            .channel_id()
            .map(str::to_string);
        if let (Some(channel), Ok(sig)) = (channel, self.signaling()) {
            let _ = sig.unsubscribe(&channel, owner_id, track_name).await;
        }
        Ok(())
    }

    /// S6.1: drive [`ReconnectSm`] off the PC's ICE state events. On disconnect/failure:
    /// mark `reconnecting`, then up to 5 paced recovery windows (≤5 s each) waiting for
    /// continual gathering to reconnect the ICE-lite SFU peer-reflexively (see
    /// [`rtc_config`] — the SFU rejects restart offers, so no SDP is exchanged here);
    /// recovery restores `connected`, exhaustion emits the `reconnect_failed` error event
    /// (the UI reacts with a full re-join).
    fn spawn_reconnect_task(
        &self,
        pc: Arc<PeerConnection>,
        stop: Arc<AtomicBool>,
        mut ice_rx: mpsc::UnboundedReceiver<IceConnectionState>,
    ) {
        let sm = self.sm.clone();
        let on_state = self.on_state.lock().unwrap().clone();
        let on_error = self.on_error.lock().unwrap().clone();
        let emit_state = move |label: &str| {
            if let Some(cb) = &on_state {
                cb(label.to_string());
            }
        };
        tokio::spawn(async move {
            let mut rsm = ReconnectSm::default();
            while let Some(st) = ice_rx.recv().await {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                if !matches!(
                    st,
                    IceConnectionState::Disconnected | IceConnectionState::Failed
                ) {
                    continue;
                }
                if rsm.on_ice_down() != ReconnectDecision::Start {
                    continue;
                }
                sm.lock().unwrap().mark_reconnecting();
                emit_state("reconnecting");
                loop {
                    if stop.load(Ordering::Relaxed) {
                        return;
                    }
                    let connected = recovery_window(&pc).await;
                    match rsm.on_attempt(connected) {
                        ReconnectDecision::Recovered => {
                            sm.lock().unwrap().mark_connected();
                            emit_state("connected");
                            break;
                        }
                        ReconnectDecision::Retry { .. } => continue,
                        _ => {
                            // GiveUp: stay in `reconnecting`; the UI reacts to the event
                            // (its WS-resume flow re-joins, or the user leaves).
                            if let Some(cb) = &on_error {
                                cb("reconnect_failed".to_string());
                            }
                            break;
                        }
                    }
                }
            }
        });
    }

    async fn stop_video(&self, kind: VideoKind) -> Result<(), EngineError> {
        // Idempotent: nothing active (or a start still in flight) → no-op.
        let Some(track_name) = self.shares.lock().unwrap().stop(kind) else {
            return Ok(());
        };
        // Local teardown first (dropping ActiveVideo joins the capture pump)...
        let removed: Vec<ActiveVideo> = {
            let mut videos = self.videos.lock().unwrap();
            let (gone, keep): (Vec<ActiveVideo>, Vec<ActiveVideo>) =
                videos.drain(..).partition(|v| v.kind == kind);
            *videos = keep;
            gone
        };
        drop(removed);
        self.published
            .lock()
            .unwrap()
            .retain(|p| p.track_name != track_name);
        // ...then tell the server (skipped when already out of voice — rtc/close covers it).
        let channel = self
            .sm
            .lock()
            .unwrap()
            .state()
            .channel_id()
            .map(str::to_string);
        if let (Some(channel), Ok(sig)) = (channel, self.signaling()) {
            sig.unpublish(&channel, &track_name).await?;
        }
        Ok(())
    }
}

/// One recovery window: 5 attempts × 5 s = 25 s of grace, comfortably past a
/// short blip while still bounding how long a dead session lingers.
const RECONNECT_ATTEMPT_WINDOW: std::time::Duration = std::time::Duration::from_secs(5);

/// Wait out one window for ICE to return (continual gathering re-establishes the pair
/// once the network is back — no signaling involved).
async fn recovery_window(pc: &Arc<PeerConnection>) -> bool {
    let deadline = std::time::Instant::now() + RECONNECT_ATTEMPT_WINDOW;
    while std::time::Instant::now() < deadline {
        if matches!(
            pc.ice_connection_state(),
            IceConnectionState::Connected | IceConnectionState::Completed
        ) {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    false
}

/// Poll a capture session until its first frame reveals the raw source dims (≤5 s).
async fn wait_source_size(session: &dyn CaptureSession) -> Result<(u32, u32), EngineError> {
    for _ in 0..100 {
        if let Some(wh) = session.source_size() {
            return Ok(wh);
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    Err(EngineError::Media("no capture frames within 5s".into()))
}

fn rtc_config() -> RtcConfiguration {
    RtcConfiguration {
        ice_servers: vec![IceServer {
            urls: vec!["stun:stun.cloudflare.com:3478".to_string()],
            username: String::new(),
            password: String::new(),
        }],
        // S6.1: GatherContinually (was GatherOnce) — when an interface drops and returns,
        // libwebrtc re-gathers on it and reconnects the ICE-lite SFU peer-reflexively with
        // UNCHANGED credentials. This is the only engine-level recovery the SFU supports:
        // it 406es offer-type renegotiation, so a classic restart_ice can never complete
        // (and a half-applied restart offer bricks ICE — P7 run 1 evidence).
        continual_gathering_policy: ContinualGatheringPolicy::GatherContinually,
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
