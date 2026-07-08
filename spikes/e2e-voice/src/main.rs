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
        "check" => check(&args),
        _ => {
            eprintln!("usage: e2e-voice seed | run --user a|b [--secs N] [--out F] | check --a F --b F");
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
    let out = flag(args, "--out").unwrap_or_else(|| format!("{DEFAULT_OUT_DIR}/p6-{user}.json"));

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
    let errors: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    {
        let (rtt, bytes, user) = (rtt_samples.clone(), last_bytes.clone(), user.clone());
        engine.set_stats_sink(Arc::new(move |s: Value| {
            if let Some(ms) = s["rttMs"].as_f64() {
                rtt.lock().unwrap().push(ms);
            }
            *bytes.lock().unwrap() = (
                s["bytesSent"].as_u64().unwrap_or(0),
                s["bytesReceived"].as_u64().unwrap_or(0),
            );
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
