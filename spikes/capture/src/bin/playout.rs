//! S1.6 (b) — engine-owned playout path spike. Throwaway.
//!
//! Required in BOTH capture branches (§1: remote playout is ALWAYS engine-owned). Pulls one
//! remote AUDIO track from the SFU (the publisher's 440 Hz sine), obtains its per-track decoded
//! PCM via `NativeAudioStream`, routes it through a gain stage into a `cpal` output callback, and
//! counts `framesDelivered` (PCM frames off the SFU) + `cpalCallbacks` (output callbacks fired).
//!
//!   run (from spikes/capture, CF_APP_ID/CF_APP_SECRET in env, AFTER publish started):
//!     cargo run --release --bin playout -- [--secs 6]
//!
//! Reads {sessionId, audioTrackName} from the publisher's handoff (spikes/sfu/target/handoff.json).
//! Gate: framesDelivered ≥ 100 AND cpalCallbacks ≥ 100.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use futures_util::StreamExt;
use libwebrtc::audio_stream::native::NativeAudioStream;
use libwebrtc::media_stream_track::MediaStreamTrack;
use libwebrtc::peer_connection::{AnswerOptions, IceGatheringState, TrackEvent};
use libwebrtc::peer_connection_factory::{
    ContinualGatheringPolicy, IceServer, IceTransportsType, PeerConnectionFactory, RtcConfiguration,
};
use libwebrtc::session_description::{SdpType, SessionDescription};
use serde_json::{json, Value};

const BASE: &str = "https://rtc.live.cloudflare.com/v1";
const GAIN: f32 = 0.5; // engine per-user gain stage

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let secs: u64 = std::env::args()
        .collect::<Vec<_>>()
        .windows(2)
        .find(|w| w[0] == "--secs")
        .and_then(|w| w[1].parse().ok())
        .unwrap_or(6);
    let out = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/spike-results/playout.json");
    let handoff = concat!(env!("CARGO_MANIFEST_DIR"), "/../sfu/target/handoff.json");

    let app_id = std::env::var("CF_APP_ID").map_err(|_| "CF_APP_ID not set")?;
    let secret = std::env::var("CF_APP_SECRET").map_err(|_| "CF_APP_SECRET not set")?;
    let (pub_session, audio_track_name) = read_handoff(handoff).await?;
    eprintln!("[cfg] pull audio track={audio_track_name} from SFU app {}…", &app_id[..6]);

    let http = reqwest::Client::new();

    // 1. Our subscriber session.
    let s_url = format!("{BASE}/apps/{app_id}/sessions/new");
    let resp = http.post(&s_url).bearer_auth(&secret).send().await?;
    let (status, text) = (resp.status(), resp.text().await?);
    if !status.is_success() {
        return Err(format!("sessions/new HTTP {status}: {text}").into());
    }
    let local_session = serde_json::from_str::<Value>(&text)?["sessionId"]
        .as_str().ok_or("no sessionId")?.to_string();

    // 2. PeerConnection (STUN-only, GatherOnce — same as the video subscriber).
    let factory = PeerConnectionFactory::default();
    let config = RtcConfiguration {
        ice_servers: vec![IceServer {
            urls: vec!["stun:stun.cloudflare.com:3478".to_string()],
            username: String::new(),
            password: String::new(),
        }],
        continual_gathering_policy: ContinualGatheringPolicy::GatherOnce,
        ice_transport_type: IceTransportsType::All,
    };
    let pc = factory.create_peer_connection(config)?;

    let (track_tx, track_rx) = tokio::sync::oneshot::channel();
    let track_tx = Mutex::new(Some(track_tx));
    pc.on_track(Some(Box::new(move |ev: TrackEvent| {
        if let MediaStreamTrack::Audio(at) = ev.track {
            if let Some(tx) = track_tx.lock().unwrap().take() {
                let _ = tx.send(at);
            }
        }
    })));
    let (gather_tx, gather_rx) = tokio::sync::oneshot::channel();
    let gather_tx = Mutex::new(Some(gather_tx));
    pc.on_ice_gathering_state_change(Some(Box::new(move |state| {
        if matches!(state, IceGatheringState::Complete) {
            if let Some(tx) = gather_tx.lock().unwrap().take() {
                let _ = tx.send(());
            }
        }
    })));

    // 3. Pull the remote audio track (location remote) → SFU offer.
    let pull_req = json!({ "tracks": [{ "location": "remote", "sessionId": pub_session, "trackName": audio_track_name }]});
    let t_url = format!("{BASE}/apps/{app_id}/sessions/{local_session}/tracks/new");
    let resp = http.post(&t_url).bearer_auth(&secret).json(&pull_req).send().await?;
    let (status, text) = (resp.status(), resp.text().await?);
    if !status.is_success() {
        return Err(format!("tracks/new(remote) HTTP {status}: {text}").into());
    }
    let offer_sdp = serde_json::from_str::<Value>(&text)?["sessionDescription"]["sdp"]
        .as_str().ok_or("no offer sdp")?.to_string();

    // 4. Answer → renegotiate.
    pc.set_remote_description(SessionDescription::parse(&offer_sdp, SdpType::Offer)?).await?;
    let answer = pc.create_answer(AnswerOptions {}).await?;
    let answer_sdp = answer.to_string();
    pc.set_local_description(answer).await?;
    if !matches!(pc.ice_gathering_state(), IceGatheringState::Complete) {
        let _ = gather_rx.await;
    }
    let reneg = json!({ "sessionDescription": { "sdp": answer_sdp, "type": "answer" } });
    let r_url = format!("{BASE}/apps/{app_id}/sessions/{local_session}/renegotiate");
    let resp = http.put(&r_url).bearer_auth(&secret).json(&reneg).send().await?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("renegotiate HTTP {status}: {}", resp.text().await?).into());
    }
    eprintln!("[sfu] renegotiated — waiting for audio track…");

    // 5. Per-track decoded PCM → shared ring buffer (gain applied). Mutex<VecDeque> is fine for a
    //    ~6 s spike (production would use a lock-free ring; noted).
    let audio_track = tokio::time::timeout(Duration::from_secs(10), track_rx)
        .await
        .map_err(|_| "no on_track within 10s")??;
    let ring: Arc<Mutex<VecDeque<f32>>> = Arc::new(Mutex::new(VecDeque::with_capacity(48000)));
    let frames_delivered = Arc::new(AtomicU64::new(0));
    let cpal_callbacks = Arc::new(AtomicU64::new(0));

    // NativeAudioStream: pull 48 kHz stereo decoded PCM from the remote track.
    {
        let ring = ring.clone();
        let fd = frames_delivered.clone();
        let mut stream = Box::pin(NativeAudioStream::new(audio_track, 48_000, 2));
        tokio::spawn(async move {
            while let Some(frame) = stream.next().await {
                fd.fetch_add(1, Ordering::Relaxed);
                let mut r = ring.lock().unwrap();
                for &s in frame.data.iter() {
                    r.push_back((s as f32 / i16::MAX as f32) * GAIN);
                }
                // Bound the buffer so a slow consumer can't grow it unboundedly.
                while r.len() > 48_000 {
                    r.pop_front();
                }
            }
        });
    }

    // 6. cpal output: pull from the ring in the audio callback, counting callbacks.
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or("no default output device")?;
    let cfg = device.default_output_config()?;
    let channels = cfg.channels() as usize;
    let sample_format = cfg.sample_format();
    eprintln!("[cpal] out {:?} {}ch @{}Hz", sample_format, channels, cfg.sample_rate());
    let stream_cfg: cpal::StreamConfig = cfg.clone().into();
    let err_fn = |e| eprintln!("[cpal] stream error: {e}");
    let ring_cb = ring.clone();
    let cb_count = cpal_callbacks.clone();
    // macOS CoreAudio default is f32; handle it (note if not).
    if sample_format != cpal::SampleFormat::F32 {
        return Err(format!("unexpected cpal sample format {sample_format:?} (expected f32 on macOS)").into());
    }
    let stream = device.build_output_stream(
        stream_cfg,
        move |out: &mut [f32], _: &cpal::OutputCallbackInfo| {
            cb_count.fetch_add(1, Ordering::Relaxed);
            let mut r = ring_cb.lock().unwrap();
            for frame in out.chunks_mut(channels) {
                let s = r.pop_front().unwrap_or(0.0);
                for x in frame.iter_mut() {
                    *x = s; // mono ring → all channels
                }
            }
        },
        err_fn,
        None,
    )?;
    stream.play()?;

    tokio::time::sleep(Duration::from_secs(secs)).await;

    let fd = frames_delivered.load(Ordering::Relaxed);
    let cb = cpal_callbacks.load(Ordering::Relaxed);
    let pass = fd >= 100 && cb >= 100;
    let result = json!({
        "step": "S1.6/playout-path", "gate": "S1.6(b)",
        "framesDelivered": fd, "cpalCallbacks": cb,
        "durationS": secs, "gainApplied": GAIN,
        "cpalSampleFormat": format!("{sample_format:?}"), "cpalChannels": channels,
        "pass": pass
    });
    std::fs::create_dir_all(Path::new(out).parent().unwrap())?;
    std::fs::write(out, serde_json::to_string_pretty(&result)?)?;
    println!("playout: framesDelivered={fd} cpalCallbacks={cb} (both ≥100 {}) → {out}", if pass { "PASS" } else { "FAIL" });
    if !pass {
        std::process::exit(1);
    }
    Ok(())
}

async fn read_handoff(path: &str) -> Result<(String, String), Box<dyn std::error::Error>> {
    for _ in 0..40 {
        if let Ok(s) = std::fs::read_to_string(path) {
            if let Ok(v) = serde_json::from_str::<Value>(&s) {
                if let (Some(sid), Some(tn)) = (v["sessionId"].as_str(), v["audioTrackName"].as_str()) {
                    return Ok((sid.to_string(), tn.to_string()));
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err("handoff not available (publisher not started?)".into())
}
