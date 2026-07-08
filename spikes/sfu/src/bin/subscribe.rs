//! S1.3 — Subscriber SPIKE (P2 + simulcast layer pull + TURN check). Throwaway.
//!
//! Pulls a track published by publish.rs. On the pull path the client is the SDP
//! **answerer** (SFU offers, requiresImmediateRenegotiation=true). Counts decoded frames
//! via a NativeVideoStream sink and measures P2 for `--duration` s.
//!
//!   run (from spikes/sfu, with CF_APP_ID / CF_APP_SECRET in env, after publish.rs started):
//!     cargo run --bin subscribe -- [--rid h|l] [--duration 60] [--out subscribe.json]
//!
//! Reads the publisher's {sessionId, videoTrackName} from target/handoff.json.
//! Writes {iceConnectedMs, framesDecoded, zeroFrameWindows, pliCount, kbps, turnRequired,
//! rid, requestShapes}.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use libwebrtc::media_stream_track::MediaStreamTrack;
use libwebrtc::peer_connection::{AnswerOptions, IceConnectionState, IceGatheringState, TrackEvent};
use libwebrtc::peer_connection_factory::{
    ContinualGatheringPolicy, IceServer, IceTransportsType, PeerConnectionFactory, RtcConfiguration,
};
use libwebrtc::session_description::{SdpType, SessionDescription};
use libwebrtc::stats::RtcStats;
use libwebrtc::video_stream::native::NativeVideoStream;
use libwebrtc::video_track::RtcVideoTrack;
use serde_json::{json, Value};

const BASE: &str = "https://rtc.live.cloudflare.com/v1";
const WARMUP_SECS: u64 = 10; // zeroFrameWindows counted only after this

struct Args {
    rid: Option<String>,
    duration: u64,
    out: String,
    handoff: String,
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = parse_args();
    let app_id = std::env::var("CF_APP_ID").map_err(|_| "CF_APP_ID not set")?;
    let secret = std::env::var("CF_APP_SECRET").map_err(|_| "CF_APP_SECRET not set")?;

    // Wait for the publisher's handoff (its real sessionId + video trackName).
    let (pub_session, video_track_name) = read_handoff(&args.handoff).await?;
    eprintln!(
        "[cfg] pull rid={:?} {}s, publisher track={} → SFU app {}…",
        args.rid, args.duration, video_track_name, &app_id[..6]
    );

    let http = reqwest::Client::new();

    // 1. Our own session.
    let s_url = format!("{BASE}/apps/{app_id}/sessions/new");
    let resp = http.post(&s_url).bearer_auth(&secret).send().await?;
    let status = resp.status();
    let text = resp.text().await?;
    if !status.is_success() {
        eprintln!("sessions/new HTTP {status}: {text}");
        std::process::exit(2);
    }
    let local_session = serde_json::from_str::<Value>(&text)?["sessionId"]
        .as_str()
        .ok_or("no sessionId")?
        .to_string();
    eprintln!("[sfu] local session created");

    // 2. PeerConnection (same STUN-only, non-trickle config as the publisher).
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

    // on_track fires during setRemoteDescription(offer) — capture the remote VIDEO track.
    let (track_tx, track_rx) = tokio::sync::oneshot::channel::<RtcVideoTrack>();
    let track_tx = Mutex::new(Some(track_tx));
    pc.on_track(Some(Box::new(move |ev: TrackEvent| {
        eprintln!("[track] arrived, mid={:?}", ev.transceiver.mid());
        if let MediaStreamTrack::Video(vt) = ev.track {
            if let Some(tx) = track_tx.lock().unwrap().take() {
                let _ = tx.send(vt);
            }
        }
    })));

    // ICE observers.
    let connected_ms = std::sync::Arc::new(AtomicU64::new(0));
    let t0 = Instant::now();
    {
        let cms = connected_ms.clone();
        pc.on_ice_connection_state_change(Some(Box::new(move |state| {
            eprintln!("[ice] connection: {state:?}");
            if matches!(state, IceConnectionState::Connected | IceConnectionState::Completed) {
                let _ = cms.compare_exchange(
                    0,
                    t0.elapsed().as_millis() as u64,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                );
            }
        })));
    }
    let (gather_tx, gather_rx) = tokio::sync::oneshot::channel::<()>();
    let gather_tx = Mutex::new(Some(gather_tx));
    pc.on_ice_gathering_state_change(Some(Box::new(move |state| {
        if matches!(state, IceGatheringState::Complete) {
            if let Some(tx) = gather_tx.lock().unwrap().take() {
                let _ = tx.send(());
            }
        }
    })));

    // 3. Pull the remote track (location:remote; +simulcast when a layer is requested).
    //    NO sessionDescription — the SFU generates the offer.
    let mut track_obj = json!({
        "location": "remote",
        "sessionId": pub_session,
        "trackName": video_track_name,
    });
    if let Some(rid) = &args.rid {
        track_obj["simulcast"] = json!({
            "preferredRid": rid,
            "priorityOrdering": "asciibetical",
            "ridNotAvailable": "asciibetical",
        });
    }
    let pull_req = json!({ "tracks": [track_obj] });
    let t_url = format!("{BASE}/apps/{app_id}/sessions/{local_session}/tracks/new");
    let resp = http.post(&t_url).bearer_auth(&secret).json(&pull_req).send().await?;
    let status = resp.status();
    let text = resp.text().await?;
    if !status.is_success() {
        eprintln!("tracks/new(remote) HTTP {status}: {text}");
        std::process::exit(2);
    }
    let pull_resp: Value = serde_json::from_str(&text)?;
    if let Some(ec) = pull_resp.get("errorCode").and_then(Value::as_str) {
        eprintln!("pull errorCode={ec}: {:?}", pull_resp.get("errorDescription"));
        std::process::exit(2);
    }
    let offer_sdp = pull_resp["sessionDescription"]["sdp"].as_str().ok_or("no offer sdp")?.to_string();
    eprintln!(
        "[sfu] pulled, requiresImmediateRenegotiation={:?}",
        pull_resp.get("requiresImmediateRenegotiation")
    );

    // 4. Answerer: setRemote(offer) → createAnswer → setLocal(answer) → renegotiate(answer).
    pc.set_remote_description(SessionDescription::parse(&offer_sdp, SdpType::Offer)?).await?;
    let answer = pc.create_answer(AnswerOptions {}).await?;
    let answer_sdp = answer.to_string(); // capture before consuming (no pending-desc accessor)
    pc.set_local_description(answer).await?;
    if !matches!(pc.ice_gathering_state(), IceGatheringState::Complete) {
        let _ = gather_rx.await;
    }
    let reneg_req = json!({ "sessionDescription": { "sdp": answer_sdp, "type": "answer" } });
    let r_url = format!("{BASE}/apps/{app_id}/sessions/{local_session}/renegotiate");
    let resp = http.put(&r_url).bearer_auth(&secret).json(&reneg_req).send().await?;
    let status = resp.status();
    let text = resp.text().await?;
    if !status.is_success() {
        eprintln!("renegotiate HTTP {status}: {text}");
        std::process::exit(2);
    }
    let reneg_resp: Value = serde_json::from_str(&text).unwrap_or(json!({}));
    if let Some(ec) = reneg_resp.get("errorCode").and_then(Value::as_str) {
        eprintln!("renegotiate errorCode={ec}: {:?}", reneg_resp.get("errorDescription"));
        std::process::exit(2);
    }
    eprintln!("[sfu] renegotiated");

    // 5. Attach a decoded-frame sink to the remote track (drives decoding + counts frames).
    let video_track = tokio::time::timeout(Duration::from_secs(10), track_rx)
        .await
        .map_err(|_| "no on_track within 10s")??;
    let frames_decoded = std::sync::Arc::new(AtomicU64::new(0));
    {
        let fd = frames_decoded.clone();
        let mut stream = Box::pin(NativeVideoStream::new(video_track));
        tokio::spawn(async move {
            while let Some(_frame) = stream.next().await {
                fd.fetch_add(1, Ordering::Relaxed);
            }
        });
    }

    // 6. Measure: framesDecoded (sink), zeroFrameWindows (post-warmup dead 1 s windows),
    //    bytesReceived + pliCount (getStats InboundRtp), steady-state kbps.
    let mut zero_windows = 0u32;
    let mut prev_fd = 0u64;
    let mut pli_count = 0u32;
    let (mut bytes_start, mut sec_start, mut bytes_last, mut sec_last) = (0u64, 0u64, 0u64, 0u64);
    for sec in 1..=args.duration {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let fd = frames_decoded.load(Ordering::Relaxed);
        let mut bytes_received = 0u64;
        if let Ok(stats) = pc.get_stats().await {
            for s in stats {
                if let RtcStats::InboundRtp(i) = s {
                    if i.stream.kind == "video" {
                        bytes_received = i.inbound.bytes_received;
                        pli_count = i.inbound.pli_count;
                    }
                }
            }
        }
        if sec > WARMUP_SECS {
            if fd == prev_fd {
                zero_windows += 1;
            }
            // kbps window starts at the first post-warmup sample with media flowing.
            if bytes_start == 0 && bytes_received > 0 {
                bytes_start = bytes_received;
                sec_start = sec;
            }
            if bytes_received > 0 {
                bytes_last = bytes_received;
                sec_last = sec;
            }
        }
        prev_fd = fd;
        eprintln!("[{sec:02}s] framesDecoded={fd} bytesRecv={bytes_received} pli={pli_count} iceMs={}", connected_ms.load(Ordering::SeqCst));
    }

    let ice_ms = connected_ms.load(Ordering::SeqCst);
    let frames_total = frames_decoded.load(Ordering::Relaxed);
    let window = sec_last.saturating_sub(sec_start).max(1);
    let kbps = ((bytes_last.saturating_sub(bytes_start)) * 8) / 1000 / window;
    let turn_required = ice_ms == 0; // STUN-only connected ⇒ false

    let mut pull_req_redacted = pull_req.clone();
    if let Some(t) = pull_req_redacted["tracks"][0].as_object_mut() {
        t.insert("sessionId".into(), json!("{publisherSessionId}"));
    }
    let out = json!({
        "step": "S1.3/subscriber",
        "gate": "P2",
        "rid": args.rid,
        "durationS": args.duration,
        "iceConnectedMs": ice_ms,
        "framesDecoded": frames_total,
        "zeroFrameWindows": zero_windows,
        "pliCount": pli_count,
        "kbps": kbps,
        "bytesReceived": bytes_last,
        "turnRequired": turn_required,
        "requestShapes": {
            "tracksNewRemote": {
                "method": "POST",
                "url": format!("{BASE}/apps/{{appId}}/sessions/{{localSessionId}}/tracks/new"),
                "request": pull_req_redacted,
                "response": pull_resp,
            },
            "renegotiate": {
                "method": "PUT",
                "url": format!("{BASE}/apps/{{appId}}/sessions/{{localSessionId}}/renegotiate"),
                "request": json!({ "sessionDescription": { "sdp": answer_sdp, "type": "answer" } }),
                "response": reneg_resp,
            }
        }
    });
    std::fs::create_dir_all(Path::new(&args.out).parent().unwrap())?;
    std::fs::write(&args.out, serde_json::to_string_pretty(&out)?)?;
    eprintln!("[out] wrote {}", args.out);

    println!(
        "P2 rid={:?}: iceMs={ice_ms} framesDecoded={frames_total} zeroFrameWindows={zero_windows} pliCount={pli_count} kbps={kbps} turnRequired={turn_required}",
        args.rid
    );
    Ok(())
}

async fn read_handoff(path: &str) -> Result<(String, String), Box<dyn std::error::Error>> {
    for _ in 0..40 {
        if let Ok(s) = std::fs::read_to_string(path) {
            if let Ok(v) = serde_json::from_str::<Value>(&s) {
                if let (Some(sid), Some(tn)) =
                    (v["sessionId"].as_str(), v["videoTrackName"].as_str())
                {
                    return Ok((sid.to_string(), tn.to_string()));
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err("handoff not available (publisher not started?)".into())
}

fn parse_args() -> Args {
    let mut args = Args {
        rid: None,
        duration: 60,
        out: concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/spike-results/subscribe.json").to_string(),
        handoff: concat!(env!("CARGO_MANIFEST_DIR"), "/target/handoff.json").to_string(),
    };
    let a: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i + 1 < a.len() {
        match a[i].as_str() {
            "--rid" => args.rid = Some(a[i + 1].clone()),
            "--duration" => args.duration = a[i + 1].parse().unwrap_or(args.duration),
            "--out" => args.out = a[i + 1].clone(),
            "--handoff" => args.handoff = a[i + 1].clone(),
            _ => {}
        }
        i += 1;
    }
    args
}
