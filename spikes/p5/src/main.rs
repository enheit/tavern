//! S5.4 — P5 probe. Throwaway spike driving the REAL `tavern-engine` watch pipeline.
//!
//! Joins the seeded voice channel as user "b" (§1 sequencing), then the webview watches
//! every video track via `stream_watch` (engine str0m pull → §1-framed chunks over a
//! binary Channel → WebCodecs → canvas) and measures per-tile decode fps + droppedChunks.
//! Also runs the S5.4 egress-stop proof (server-side unsubscribe while the watch socket
//! stays alive → byte delta over 10 s).
//!
//!   prereq: wrangler dev + `e2e-voice seed` + pubsynth publishers running
//!   run (from spikes/p5): cargo run --release

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;
use tavern_engine::Engine;
use tokio_tungstenite::tungstenite::Message;

const HANDOFF: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../e2e-voice/target/handoff.json");
const RESULTS_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/spike-results");

struct P5 {
    engine: Arc<Engine>,
    last_stats: Arc<Mutex<Value>>,
    handoff: Value,
    /// Flat video roster (ownerId, trackName) collected from hello.ok/tracks frames.
    roster: Arc<Mutex<Vec<(String, String)>>>,
}

/// Join voice as user "b" per §1 sequencing and keep collecting `tracks` rosters.
#[tauri::command]
async fn p5_init(state: State<'_, P5>) -> Result<Value, String> {
    let api = state.handoff["apiBase"].as_str().unwrap().to_string();
    let server_id = state.handoff["serverId"].as_str().unwrap().to_string();
    let channel_id = state.handoff["channelId"].as_str().unwrap().to_string();
    let user_id = state.handoff["b"]["userId"].as_str().unwrap().to_string();
    let token = state.handoff["b"]["token"].as_str().unwrap().to_string();

    let ws_url = format!(
        "{}/api/servers/{server_id}/ws?token={token}",
        api.replacen("http", "ws", 1)
    );
    let (ws, _) = tokio_tungstenite::connect_async(&ws_url)
        .await
        .map_err(|e| format!("ws: {e}"))?;
    let (mut ws_tx, mut ws_rx) = ws.split();
    ws_tx
        .send(Message::Text(
            json!({ "v": 1, "t": "voice.join", "channelId": channel_id }).to_string().into(),
        ))
        .await
        .map_err(|e| format!("voice.join: {e}"))?;

    // Reader: own-presence waiter + per-owner tracks aggregation (replace semantics, §1).
    let (joined_tx, joined_rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn({
        let roster = state.roster.clone();
        let user_id = user_id.clone();
        async move {
            let mut joined_tx = Some(joined_tx);
            let mut by_owner: std::collections::HashMap<String, Vec<(String, String)>> =
                std::collections::HashMap::new();
            while let Some(Ok(msg)) = ws_rx.next().await {
                let Ok(text) = msg.into_text() else { continue };
                let Ok(f) = serde_json::from_str::<Value>(&text) else { continue };
                match f["t"].as_str().unwrap_or("") {
                    "presence" => {
                        if f["userId"] == user_id.as_str() && f["state"] == "voice" {
                            if let Some(tx) = joined_tx.take() {
                                let _ = tx.send(());
                            }
                        }
                    }
                    "hello.ok" | "tracks" => {
                        let list = |arr: &Value| -> Vec<(String, String)> {
                            arr.as_array()
                                .map(|a| {
                                    a.iter()
                                        .filter(|t| t["kind"] == "screen" || t["kind"] == "webcam")
                                        .map(|t| {
                                            (
                                                t["ownerId"].as_str().unwrap_or("").to_string(),
                                                t["trackName"].as_str().unwrap_or("").to_string(),
                                            )
                                        })
                                        .collect()
                                })
                                .unwrap_or_default()
                        };
                        if f["t"] == "hello.ok" {
                            by_owner.clear();
                            for (o, tn) in list(&f["tracks"]) {
                                by_owner.entry(o.clone()).or_default().push((o, tn));
                            }
                        } else {
                            let owner = f["ownerId"].as_str().unwrap_or("").to_string();
                            let tracks = list(&f["tracks"]);
                            if tracks.is_empty() {
                                by_owner.remove(&owner);
                            } else {
                                by_owner.insert(owner, tracks);
                            }
                        }
                        *roster.lock().unwrap() =
                            by_owner.values().flatten().cloned().collect();
                    }
                    _ => {}
                }
            }
        }
    });
    tokio::time::timeout(Duration::from_secs(5), joined_rx)
        .await
        .map_err(|_| "no voice presence within 5s".to_string())
        .and_then(|r| r.map_err(|_| "presence waiter dropped".to_string()))?;

    // Heartbeats for the run's duration.
    tokio::spawn(async move {
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

    state
        .engine
        .voice_join(&channel_id)
        .await
        .map_err(|e| format!("voice_join: {e}"))?;

    // Give the roster a beat to settle, then return it.
    tokio::time::sleep(Duration::from_millis(800)).await;
    let tracks: Vec<Value> = state
        .roster
        .lock()
        .unwrap()
        .iter()
        .map(|(o, t)| json!({ "ownerId": o, "trackName": t }))
        .collect();
    Ok(json!({ "tracks": tracks }))
}

#[tauri::command]
async fn stream_watch(
    state: State<'_, P5>,
    owner_id: String,
    track_name: String,
    layer: String,
    frames: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let sink: tavern_engine::watch::ChunkSink =
        Box::new(move |bytes| frames.send(InvokeResponseBody::Raw(bytes)).is_ok());
    state
        .engine
        .stream_watch(&owner_id, &track_name, &layer, sink)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn stream_unwatch(
    state: State<'_, P5>,
    owner_id: String,
    track_name: String,
) -> Result<(), String> {
    state
        .engine
        .stream_unwatch(&owner_id, &track_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn p5_stats(state: State<'_, P5>) -> Value {
    state.last_stats.lock().unwrap().clone()
}

/// Egress-stop proof (S5.4 DoD): watch a stream, snapshot its socket bytes, unsubscribe
/// SERVER-side only (the engine's watch socket stays alive), poll 10 s, PASS if the
/// post-close delta is <5 KB.
#[tauri::command]
async fn p5_egress(
    state: State<'_, P5>,
    owner_id: String,
    track_name: String,
) -> Result<Value, String> {
    let api = state.handoff["apiBase"].as_str().unwrap().to_string();
    let channel_id = state.handoff["channelId"].as_str().unwrap().to_string();
    let token = state.handoff["b"]["token"].as_str().unwrap().to_string();

    let sink: tavern_engine::watch::ChunkSink = Box::new(|_| true); // count-only
    state
        .engine
        .stream_watch(&owner_id, &track_name, "l", sink)
        .await
        .map_err(|e| e.to_string())?;
    tokio::time::sleep(Duration::from_secs(8)).await;

    let bytes_of = |stats: &Value| -> u64 {
        stats["streams"]
            .as_array()
            .and_then(|a| {
                a.iter().find(|s| {
                    s["ownerId"] == owner_id.as_str() && s["trackName"] == track_name.as_str()
                })
            })
            .and_then(|s| s["mediaBytes"].as_u64())
            .unwrap_or(0)
    };
    let flowing = bytes_of(&state.last_stats.lock().unwrap());

    // Server-side close ONLY: the SFU force-closes the pulled track; our socket stays up.
    let resp = reqwest::Client::new()
        .post(format!("{api}/api/rtc/unsubscribe"))
        .bearer_auth(&token)
        .json(&json!({ "channelId": channel_id, "ownerId": owner_id, "trackName": track_name }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let unsub_status = resp.status().as_u16();

    // Let in-flight packets + the 1 Hz stats sampling settle, THEN take the baseline: the
    // proof is that no FURTHER media arrives once the close has taken effect.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let before = bytes_of(&state.last_stats.lock().unwrap());
    tokio::time::sleep(Duration::from_secs(10)).await;
    let after = bytes_of(&state.last_stats.lock().unwrap());
    let delta = after.saturating_sub(before);

    // Cleanup the engine side.
    let _ = state.engine.stream_unwatch(&owner_id, &track_name).await;

    Ok(json!({
        "unsubscribeStatus": unsub_status,
        "mediaBytesWhileFlowing": flowing,
        "mediaBytesBefore": before,
        "mediaBytesAfter": after,
        "deltaBytes": delta,
        "pass": delta < 5 * 1024,
    }))
}

#[tauri::command]
fn p5_report(json: String) -> Result<(), String> {
    std::fs::write(format!("{RESULTS_DIR}/p5.json"), json).map_err(|e| e.to_string())
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle, code: i32) {
    app.exit(code);
}

fn main() {
    let handoff: Value = serde_json::from_str(
        &std::fs::read_to_string(HANDOFF).expect("handoff missing — run e2e-voice seed first"),
    )
    .unwrap();
    let engine = Arc::new(Engine::new());
    engine.configure(
        handoff["apiBase"].as_str().unwrap(),
        handoff["b"]["token"].as_str().unwrap(),
    );
    let last_stats = Arc::new(Mutex::new(Value::Null));
    {
        let last = last_stats.clone();
        engine.set_stats_sink(Arc::new(move |s: Value| {
            *last.lock().unwrap() = s;
        }));
    }

    tauri::Builder::default()
        .manage(P5 { engine, last_stats, handoff, roster: Arc::new(Mutex::new(Vec::new())) })
        .invoke_handler(tauri::generate_handler![
            p5_init,
            stream_watch,
            stream_unwatch,
            p5_stats,
            p5_egress,
            p5_report,
            exit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tavern p5 probe");
}
