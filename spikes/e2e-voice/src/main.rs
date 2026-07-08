//! S4.3 — Voice E2E (P6). Throwaway harness driving the REAL `tavern-engine` crate.
//!
//! Two engine processes on one machine, a seeded LOCAL worker (wrangler dev, real SFU creds
//! in worker/.dev.vars), 60 s bidirectional voice. Each process mirrors the §1 UI sequencing:
//! WS `voice.join` → wait for own `presence {state:"voice"}` → engine `voice_join`; `tracks`
//! rosters are forwarded to `set_remote_tracks` (mic auto-subscribe), exactly like the app.
//!
//! Modes:
//!   seed                       — register A+B, create server + voice channel, B joins;
//!                                writes target/handoff.json
//!   run --user a|b [--secs 60] [--out p6-x.json]
//!   check --a p6-a.json --b p6-b.json   — evaluates the P6 gates across both files
//!
//! P6 (PLAN §1): rttMs = median of candidate-pair currentRoundTripTime @1 Hz ≤ 250 ms;
//! deviceErrors (engine error events with code prefix `audio_`) == 0; audio both ways.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use libwebrtc::media_stream_track::MediaStreamTrack;
use libwebrtc::peer_connection::OfferOptions;
use libwebrtc::rtp_parameters::RtpEncodingParameters;
use libwebrtc::rtp_transceiver::{RtpTransceiverDirection, RtpTransceiverInit};
use libwebrtc::session_description::{SdpType, SessionDescription};
use libwebrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};
use libwebrtc::video_source::native::NativeVideoSource;
use libwebrtc::video_source::VideoResolution;
use serde_json::{json, Value};
use tavern_engine::Engine;
use tokio_tungstenite::tungstenite::Message;

const HANDOFF: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/target/handoff.json");
const DEFAULT_OUT_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/spike-results");

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(String::as_str).unwrap_or("");
    let code = match mode {
        "seed" => seed(&flag(&args, "--api").unwrap_or_else(|| "http://127.0.0.1:8787".into())).await,
        "run" => run(&args).await,
        "pubsynth" => pubsynth(&args).await,
        "check" => check(&args),
        _ => {
            eprintln!(
                "usage: e2e-voice seed | run --user a|b [--secs N] [--share HxF] [--out F] | pubsynth --n N --width W --height H --fps F --kbps K [--secs N] | check --a F --b F"
            );
            2
        }
    };
    std::process::exit(code);
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.windows(2).find(|w| w[0] == name).map(|w| w[1].clone())
}

// ---- seed -------------------------------------------------------------------

async fn seed(api: &str) -> i32 {
    let http = reqwest::Client::new();
    let suffix = format!("{:x}", std::time::UNIX_EPOCH.elapsed().unwrap().as_nanos() & 0xffff_ffff);
    let register = |nick: String| {
        let http = http.clone();
        let api = api.to_string();
        async move {
            let r = http
                .post(format!("{api}/api/register"))
                .json(&json!({ "nickname": nick, "password": "p6-password", "repeat": "p6-password" }))
                .send()
                .await
                .expect("register send");
            let status = r.status();
            let v: Value = r.json().await.expect("register json");
            assert!(status.is_success(), "register failed: {v}");
            (v["userId"].as_str().unwrap().to_string(), v["token"].as_str().unwrap().to_string())
        }
    };
    let (user_a, token_a) = register(format!("e2eA_{suffix}")).await;
    let (user_b, token_b) = register(format!("e2eB_{suffix}")).await;

    let server: Value = http
        .post(format!("{api}/api/servers"))
        .bearer_auth(&token_a)
        .json(&json!({ "name": "E2E Voice" }))
        .send()
        .await
        .expect("create server")
        .json()
        .await
        .unwrap();
    let server_id = server["id"].as_str().expect("server id").to_string();

    let channel: Value = http
        .post(format!("{api}/api/servers/{server_id}/channels"))
        .bearer_auth(&token_a)
        .json(&json!({ "name": "vc", "kind": "voice" }))
        .send()
        .await
        .expect("create channel")
        .json()
        .await
        .unwrap();
    let channel_id = channel["id"].as_str().expect("channel id").to_string();

    let join = http
        .post(format!("{api}/api/servers/join"))
        .bearer_auth(&token_b)
        .json(&json!({ "serverId": server_id }))
        .send()
        .await
        .expect("join server");
    assert!(join.status().is_success(), "B join failed");

    let handoff = json!({
        "apiBase": api,
        "serverId": server_id,
        "channelId": channel_id,
        "a": { "userId": user_a, "token": token_a },
        "b": { "userId": user_b, "token": token_b },
    });
    std::fs::create_dir_all(std::path::Path::new(HANDOFF).parent().unwrap()).unwrap();
    std::fs::write(HANDOFF, serde_json::to_string_pretty(&handoff).unwrap()).unwrap();
    eprintln!("[seed] ok — server {server_id} channel {channel_id}");
    0
}

// ---- run --------------------------------------------------------------------

async fn run(args: &[String]) -> i32 {
    let user = flag(args, "--user").unwrap_or_default();
    let secs: u64 = flag(args, "--secs").and_then(|s| s.parse().ok()).unwrap_or(60);
    // S5.2 mode: --share HxF (e.g. 720x30) publishes the primary screen after voice_join and
    // gates on framesEncoded ≥ 0.8×F×secs instead of the P6 audio gates.
    let share: Option<(u32, u32)> = flag(args, "--share").and_then(|s| {
        let (h, f) = s.split_once('x')?;
        Some((h.parse().ok()?, f.parse().ok()?))
    });
    let out = flag(args, "--out").unwrap_or_else(|| {
        if share.is_some() {
            format!("{DEFAULT_OUT_DIR}/s5.2-share.json")
        } else {
            format!("{DEFAULT_OUT_DIR}/p6-{user}.json")
        }
    });

    let handoff: Value = serde_json::from_str(&std::fs::read_to_string(HANDOFF).expect("handoff (run seed first)")).unwrap();
    let api = handoff["apiBase"].as_str().unwrap().to_string();
    let server_id = handoff["serverId"].as_str().unwrap().to_string();
    let channel_id = handoff["channelId"].as_str().unwrap().to_string();
    let me = &handoff[&user];
    let (user_id, token) = (
        me["userId"].as_str().expect("--user a|b").to_string(),
        me["token"].as_str().unwrap().to_string(),
    );
    eprintln!("[{user}] user {user_id}, {secs}s");

    // Engine + P6 collectors (registered before join so the 1 Hz stats task starts with it).
    let engine = Arc::new(Engine::new());
    engine.configure(&api, &token);
    let rtt_samples: Arc<Mutex<Vec<f64>>> = Arc::new(Mutex::new(Vec::new()));
    let last_bytes: Arc<Mutex<(u64, u64)>> = Arc::new(Mutex::new((0, 0)));
    let frames_encoded: Arc<Mutex<u64>> = Arc::new(Mutex::new(0));
    let errors: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    {
        let (rtt, bytes, frames, user) = (
            rtt_samples.clone(),
            last_bytes.clone(),
            frames_encoded.clone(),
            user.clone(),
        );
        engine.set_stats_sink(Arc::new(move |s: Value| {
            if let Some(ms) = s["rttMs"].as_f64() {
                rtt.lock().unwrap().push(ms);
            }
            *bytes.lock().unwrap() = (
                s["bytesSent"].as_u64().unwrap_or(0),
                s["bytesReceived"].as_u64().unwrap_or(0),
            );
            *frames.lock().unwrap() = s["framesEncoded"].as_u64().unwrap_or(0);
            eprintln!("[{user}] stats {s}");
        }));
        let errs = errors.clone();
        engine.set_error_sink(Arc::new(move |code: String| {
            errs.lock().unwrap().push(code);
        }));
    }

    // WS per §1: connect (?token=), send voice.join, wait for OUR presence{voice} broadcast,
    // and keep forwarding `tracks` rosters to the engine for the whole run.
    let ws_url = format!(
        "{}/api/servers/{server_id}/ws?token={token}",
        api.replacen("http", "ws", 1)
    );
    let (ws, _) = tokio_tungstenite::connect_async(&ws_url).await.expect("ws connect");
    let (mut ws_tx, mut ws_rx) = ws.split();
    let (joined_tx, joined_rx) = tokio::sync::oneshot::channel::<()>();

    // Reader: presence waiter + tracks forwarding (replace-per-owner, §1) like the app store.
    let reader = {
        let engine = engine.clone();
        let (user_id, channel_id, user) = (user_id.clone(), channel_id.clone(), user.clone());
        tokio::spawn(async move {
            let mut joined_tx = Some(joined_tx);
            let mut by_owner: std::collections::HashMap<String, Vec<tavern_protocol::TrackInfo>> =
                std::collections::HashMap::new();
            while let Some(Ok(msg)) = ws_rx.next().await {
                let Ok(text) = msg.into_text() else { continue };
                let Ok(frame) = serde_json::from_str::<Value>(&text) else { continue };
                match frame["t"].as_str().unwrap_or("") {
                    "presence" => {
                        if frame["userId"] == user_id.as_str()
                            && frame["state"] == "voice"
                            && frame["channelId"] == channel_id.as_str()
                        {
                            if let Some(tx) = joined_tx.take() {
                                let _ = tx.send(());
                            }
                        }
                    }
                    "hello.ok" | "tracks" => {
                        if frame["t"] == "hello.ok" {
                            by_owner.clear();
                            for t in frame["tracks"].as_array().cloned().unwrap_or_default() {
                                let info: tavern_protocol::TrackInfo = serde_json::from_value(t).unwrap();
                                by_owner.entry(info.owner_id.clone()).or_default().push(info);
                            }
                        } else {
                            let owner = frame["ownerId"].as_str().unwrap_or("").to_string();
                            let tracks: Vec<tavern_protocol::TrackInfo> =
                                serde_json::from_value(frame["tracks"].clone()).unwrap_or_default();
                            if tracks.is_empty() {
                                by_owner.remove(&owner);
                            } else {
                                by_owner.insert(owner, tracks);
                            }
                        }
                        let flat: Vec<_> = by_owner.values().flatten().cloned().collect();
                        eprintln!("[{user}] tracks roster: {} track(s)", flat.len());
                        let _ = engine.set_remote_tracks(flat).await;
                    }
                    _ => {}
                }
            }
        })
    };

    ws_tx
        .send(Message::Text(json!({ "v": 1, "t": "voice.join", "channelId": channel_id }).to_string().into()))
        .await
        .expect("send voice.join");
    tokio::time::timeout(Duration::from_secs(5), joined_rx)
        .await
        .expect("no voice presence within 5s (§1 timeout)")
        .expect("presence waiter dropped");
    eprintln!("[{user}] presence voice confirmed — engine voice_join");

    let track_name = engine.voice_join(&channel_id).await.expect("engine voice_join");
    eprintln!("[{user}] publishing mic {track_name}");

    // S5.2: publish the primary screen through the real engine path (capture → I420 →
    // NativeVideoSource(is_screencast) → §1 encodings → /api/rtc/publish).
    let mut share_track = String::new();
    if let Some((h, f)) = share {
        share_track = engine
            .screen_share_start("screen:primary", 0, h, f)
            .await
            .expect("screen_share_start");
        eprintln!("[{user}] publishing screen {share_track} ({h}p{f})");
    }

    // Heartbeats keep the DO's stale sweep away while we measure.
    let hb = tokio::spawn(async move {
        let mut t = tokio::time::interval(Duration::from_secs(20));
        t.tick().await;
        loop {
            t.tick().await;
            if ws_tx
                .send(Message::Text(json!({ "v": 1, "t": "heartbeat" }).to_string().into()))
                .await
                .is_err()
            {
                break;
            }
        }
    });

    tokio::time::sleep(Duration::from_secs(secs)).await;

    // S5.2 report path: framesEncoded gate, then clean stop (unpublish) + leave.
    if let Some((h, f)) = share {
        let frames = *frames_encoded.lock().unwrap();
        engine.screen_share_stop().await.expect("screen_share_stop");
        engine.voice_leave().await.ok();
        hb.abort();
        reader.abort();

        let expected = f as u64 * secs;
        let gate = (expected as f64 * 0.8) as u64;
        let pass = frames >= gate;
        let report = json!({
            "step": "S5.2/publish-screen",
            "gate": "framesEncoded >= 0.8 x expected",
            "user": user,
            "durationS": secs,
            "share": format!("{h}p{f}"),
            "trackName": share_track,
            "framesEncoded": frames,
            "expected": expected,
            "gateFloor": gate,
            "pass": pass,
        });
        std::fs::create_dir_all(std::path::Path::new(&out).parent().unwrap()).unwrap();
        std::fs::write(&out, serde_json::to_string_pretty(&report).unwrap()).unwrap();
        println!(
            "[{user}] S5.2 {}: framesEncoded={frames} (>= {gate} of expected {expected})",
            if pass { "PASS" } else { "FAIL" }
        );
        return if pass { 0 } else { 1 };
    }

    engine.voice_leave().await.ok();
    hb.abort();
    reader.abort();

    // ---- P6 report ----
    let rtt = rtt_samples.lock().unwrap().clone();
    let rtt_median = median(&rtt);
    let (bytes_sent, bytes_received) = *last_bytes.lock().unwrap();
    let errs = errors.lock().unwrap().clone();
    let device_errors = errs.iter().filter(|e| e.starts_with("audio_")).count();
    let gates = json!({
        "rttMedian_le_250": rtt_median.map(|m| m <= 250.0).unwrap_or(false),
        "deviceErrors_eq_0": device_errors == 0,
        "audioBothWays": bytes_sent > 1000 && bytes_received > 1000,
    });
    let pass = gates.as_object().unwrap().values().all(|v| v.as_bool() == Some(true));
    let report = json!({
        "step": "S4.3/e2e-voice",
        "gate": "P6",
        "user": user,
        "durationS": secs,
        "trackName": track_name,
        "rttMsMedian": rtt_median,
        "rttSamples": rtt.len(),
        "deviceErrors": device_errors,
        "errors": errs,
        "bytesSent": bytes_sent,
        "bytesReceived": bytes_received,
        "gates": gates,
        "pass": pass,
    });
    std::fs::create_dir_all(std::path::Path::new(&out).parent().unwrap()).unwrap();
    std::fs::write(&out, serde_json::to_string_pretty(&report).unwrap()).unwrap();
    println!(
        "[{user}] P6 {}: rttMedian={rtt_median:?}ms samples={} deviceErrors={device_errors} sent={bytes_sent} recv={bytes_received}",
        if pass { "PASS" } else { "FAIL" },
        rtt.len(),
    );
    if pass {
        0
    } else {
        1
    }
}

// ---- pubsynth (S5.4 P5 publishers) -------------------------------------------
//
// N synthetic single-encoding video publishers through the REAL path: register → join
// server → WS voice.join (own-presence wait, §1 sequencing) → engine Signaling
// session/publish (libwebrtc PC, scrolling bars with high-freq detail from the S1.2/S1.3
// spikes) → pump frames for --secs. One process, N PCs.

async fn pubsynth(args: &[String]) -> i32 {
    use libwebrtc::peer_connection_factory::native::PeerConnectionFactoryExt;
    use libwebrtc::peer_connection_factory::{
        ContinualGatheringPolicy, IceServer, IceTransportsType, PeerConnectionFactory,
        RtcConfiguration,
    };
    use tavern_engine::signaling::{PublishTrack, Signaling};

    let n: usize = flag(args, "--n").and_then(|s| s.parse().ok()).unwrap_or(1);
    let width: u32 = flag(args, "--width").and_then(|s| s.parse().ok()).unwrap_or(640);
    let height: u32 = flag(args, "--height").and_then(|s| s.parse().ok()).unwrap_or(360);
    let fps: u32 = flag(args, "--fps").and_then(|s| s.parse().ok()).unwrap_or(30);
    let kbps: u64 = flag(args, "--kbps").and_then(|s| s.parse().ok()).unwrap_or(300);
    let secs: u64 = flag(args, "--secs").and_then(|s| s.parse().ok()).unwrap_or(120);

    let handoff: Value =
        serde_json::from_str(&std::fs::read_to_string(HANDOFF).expect("handoff (run seed first)"))
            .unwrap();
    let api = handoff["apiBase"].as_str().unwrap().to_string();
    let server_id = handoff["serverId"].as_str().unwrap().to_string();
    let channel_id = handoff["channelId"].as_str().unwrap().to_string();

    let http = reqwest::Client::new();
    let factory = PeerConnectionFactory::default();
    let suffix = format!(
        "{:x}",
        std::time::UNIX_EPOCH.elapsed().unwrap().as_nanos() & 0xffff_ffff
    );

    let mut hb_writers = Vec::new();
    for i in 0..n {
        // Register + join the seeded server.
        let nick = format!("p5pub{i}_{suffix}");
        let reg: Value = http
            .post(format!("{api}/api/register"))
            .json(&json!({ "nickname": nick, "password": "p5-password", "repeat": "p5-password" }))
            .send()
            .await
            .expect("register")
            .json()
            .await
            .unwrap();
        let (user_id, token) = (
            reg["userId"].as_str().expect("register ok").to_string(),
            reg["token"].as_str().unwrap().to_string(),
        );
        let join = http
            .post(format!("{api}/api/servers/join"))
            .bearer_auth(&token)
            .json(&json!({ "serverId": server_id }))
            .send()
            .await
            .expect("join");
        assert!(join.status().is_success());

        // WS voice.join → wait own presence{voice} (§1), then keep heartbeating.
        let ws_url = format!(
            "{}/api/servers/{server_id}/ws?token={token}",
            api.replacen("http", "ws", 1)
        );
        let (ws, _) = tokio_tungstenite::connect_async(&ws_url).await.expect("ws");
        let (mut ws_tx, mut ws_rx) = ws.split();
        ws_tx
            .send(Message::Text(
                json!({ "v": 1, "t": "voice.join", "channelId": channel_id }).to_string().into(),
            ))
            .await
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            assert!(std::time::Instant::now() < deadline, "no voice presence for {nick}");
            let Some(Ok(msg)) = ws_rx.next().await else { continue };
            let Ok(text) = msg.into_text() else { continue };
            let Ok(f) = serde_json::from_str::<Value>(&text) else { continue };
            if f["t"] == "presence" && f["userId"] == user_id.as_str() && f["state"] == "voice" {
                break;
            }
        }
        // Reader drain + heartbeats keep the DO from sweeping us.
        tokio::spawn(async move { while ws_rx.next().await.is_some() {} });
        hb_writers.push(ws_tx);

        // SFU session + publish one synthetic single-encoding video track.
        let sig = Signaling::new(&api, &token);
        sig.session(&channel_id).await.expect("rtc session");

        let pc = factory
            .create_peer_connection(RtcConfiguration {
                ice_servers: vec![IceServer {
                    urls: vec!["stun:stun.cloudflare.com:3478".into()],
                    username: String::new(),
                    password: String::new(),
                }],
                continual_gathering_policy: ContinualGatheringPolicy::GatherOnce,
                ice_transport_type: IceTransportsType::All,
            })
            .expect("pc");

        let source = NativeVideoSource::new(VideoResolution { width, height }, true);
        // kind "webcam": the §1 share cap allows only 3 SCREEN tracks per channel and P5
        // needs 10 concurrent video tiles; webcam tracks are uncapped and tile identically.
        let track_name = format!("webcam-{}", uuid::Uuid::new_v4());
        let track = factory.create_video_track(&track_name, source.clone());
        let mst: MediaStreamTrack = track.into();
        let tvr = pc
            .add_transceiver(
                mst,
                RtpTransceiverInit {
                    direction: RtpTransceiverDirection::SendOnly,
                    stream_ids: vec!["p5".into()],
                    send_encodings: vec![RtpEncodingParameters {
                        max_bitrate: Some(kbps * 1000),
                        max_framerate: Some(fps as f64),
                        scale_resolution_down_by: Some(1.0),
                        ..Default::default()
                    }],
                },
            )
            .expect("transceiver");
        let offer = pc
            .create_offer(OfferOptions { ice_restart: false, offer_to_receive_audio: false, offer_to_receive_video: false })
            .await
            .expect("offer");
        let offer_sdp = offer.to_string();
        pc.set_local_description(offer).await.expect("set_local");
        let mid = tvr.mid().expect("mid");
        let answer = sig
            .publish(
                &channel_id,
                &PublishTrack {
                    track_name: track_name.clone(),
                    kind: "webcam".into(),
                    mid,
                    width,
                    height,
                    fps,
                    simulcast: false,
                },
                &offer_sdp,
            )
            .await
            .expect("publish");
        pc.set_remote_description(
            SessionDescription::parse(&answer.sdp, SdpType::Answer).expect("answer parse"),
        )
        .await
        .expect("set_remote");

        spawn_synth_pump(source, width, height, fps as u64);
        // Keep the PC alive for the whole run.
        std::mem::forget(pc);
        eprintln!("[pubsynth] {i}: {nick} publishing {track_name} {width}x{height}@{fps} {kbps}kbps");
    }

    // Heartbeat all sockets every 20 s for the duration.
    let hb = tokio::spawn(async move {
        let mut t = tokio::time::interval(Duration::from_secs(20));
        t.tick().await;
        loop {
            t.tick().await;
            for ws_tx in hb_writers.iter_mut() {
                let _ = ws_tx
                    .send(Message::Text(json!({ "v": 1, "t": "heartbeat" }).to_string().into()))
                    .await;
            }
        }
    });
    eprintln!("[pubsynth] {n} publisher(s) live for {secs}s");
    tokio::time::sleep(Duration::from_secs(secs)).await;
    hb.abort();
    0
}

fn spawn_synth_pump(src: NativeVideoSource, w: u32, h: u32, fps: u64) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis((1000 / fps).max(1)));
        let mut phase = 0usize;
        loop {
            ticker.tick().await;
            let mut buf = I420Buffer::new(w, h);
            fill_bars(&mut buf, w as usize, h as usize, phase);
            phase = (phase + 4) % (w as usize).max(1);
            let mut frame = VideoFrame::new(VideoRotation::VideoRotation0, buf);
            frame.timestamp_us =
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_micros() as i64;
            src.capture_frame(&frame);
        }
    });
}

/// Scrolling color bars + high-frequency detail (S1.2/S1.3 spikes): encode cost scales
/// with pixel count so 1080p genuinely costs more than 360p.
fn fill_bars(buf: &mut libwebrtc::video_frame::I420Buffer, w: usize, h: usize, phase: usize) {
    const fn rgb2i(r: i32, g: i32, b: i32) -> (u8, u8, u8) {
        const fn cl(v: i32) -> u8 {
            if v < 0 {
                0
            } else if v > 255 {
                255
            } else {
                v as u8
            }
        }
        (
            cl(((66 * r + 129 * g + 25 * b + 128) >> 8) + 16),
            cl(((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128),
            cl(((112 * r - 94 * g - 18 * b + 128) >> 8) + 128),
        )
    }
    const BARS: [(u8, u8, u8); 7] = [
        rgb2i(191, 191, 191),
        rgb2i(191, 191, 0),
        rgb2i(0, 191, 191),
        rgb2i(0, 191, 0),
        rgb2i(191, 0, 191),
        rgb2i(191, 0, 0),
        rgb2i(0, 0, 191),
    ];
    let (sy, su, sv) = buf.strides();
    let (sy, su, sv) = (sy as usize, su as usize, sv as usize);
    let (y, u, v) = buf.data_mut();
    let n = BARS.len();
    for row in 0..h {
        for col in 0..w {
            let bar = BARS[(((col + phase) % w) * n / w).min(n - 1)].0;
            // Weak detail: P5's per-tile fps gate needs the ENCODERS to hold 30 fps at
            // 300 kbps — the S1.3-strength high-freq term forces frame-dropping there.
            let detail = (col
                .wrapping_mul(31)
                .wrapping_add(row.wrapping_mul(17))
                .wrapping_add(phase) as u8)
                & 0x07;
            y[row * sy + col] = bar.wrapping_add(detail);
        }
    }
    let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
    for row in 0..ch {
        for col in 0..cw {
            let bar = (((col * 2 + phase) % w) * n / w).min(n - 1);
            u[row * su + col] = BARS[bar].1;
            v[row * sv + col] = BARS[bar].2;
        }
    }
}

fn median(xs: &[f64]) -> Option<f64> {
    if xs.is_empty() {
        return None;
    }
    let mut v = xs.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    Some(v[v.len() / 2])
}

// ---- check ------------------------------------------------------------------

fn check(args: &[String]) -> i32 {
    let load = |p: &str| -> Value { serde_json::from_str(&std::fs::read_to_string(p).expect(p)).unwrap() };
    let a = load(&flag(args, "--a").expect("--a"));
    let b = load(&flag(args, "--b").expect("--b"));
    let mut ok = true;
    for (name, r) in [("a", &a), ("b", &b)] {
        let pass = r["pass"].as_bool() == Some(true);
        println!(
            "P6[{name}]: pass={pass} rttMedian={} deviceErrors={} sent={} recv={}",
            r["rttMsMedian"], r["deviceErrors"], r["bytesSent"], r["bytesReceived"]
        );
        ok &= pass;
    }
    println!("P6 overall: {}", if ok { "PASS" } else { "FAIL" });
    if ok {
        0
    } else {
        1
    }
}
