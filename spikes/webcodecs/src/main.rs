//! S1.5 — WebCodecs decode probe (P3). Throwaway spike.
//!
//! Standalone Tauri app. Rust parses the S1.4 IVF dumps and streams each encoded frame over a
//! binary `Channel` (InvokeResponseBody::Raw → ArrayBuffer in JS); the webview feeds them to a
//! WebCodecs `VideoDecoder`, renders to canvas, and measures decode fps. The frontend writes
//! results via `save_results` and exits via `exit_app`.
//!
//!   run (from spikes/webcodecs): cargo run   (dumps must exist: spikes/sfu/run_tap.sh)

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::ipc::{Channel, InvokeResponseBody};

const RESULTS_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/spike-results");

/// Parse an IVF file (32-byte file header + per-frame [size:u32 LE][ts:u64 LE][data]) into its
/// encoded frames.
fn parse_ivf(bytes: &[u8]) -> Vec<Vec<u8>> {
    let mut frames = Vec::new();
    if bytes.len() < 32 || &bytes[0..4] != b"DKIF" {
        return frames;
    }
    let mut pos = 32;
    while pos + 12 <= bytes.len() {
        let sz =
            u32::from_le_bytes([bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]]) as usize;
        pos += 12;
        if pos + sz > bytes.len() {
            break;
        }
        frames.push(bytes[pos..pos + sz].to_vec());
        pos += sz;
    }
    frames
}

/// Stream every encoded frame of the requested dump to the webview over `channel`. Returns the
/// frame count so JS can wait until all have arrived.
#[tauri::command]
async fn probe_frames(kind: String, channel: Channel<InvokeResponseBody>) -> Result<usize, String> {
    let name = match kind.as_str() {
        "1080p" => "dump_1080p.ivf",
        "360p" => "dump_360p.ivf",
        _ => return Err(format!("bad kind {kind}")),
    };
    let path = format!("{RESULTS_DIR}/{name}");
    let bytes = std::fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
    let frames = parse_ivf(&bytes);
    if frames.is_empty() {
        return Err(format!("no frames parsed from {path}"));
    }
    for f in &frames {
        channel
            .send(InvokeResponseBody::Raw(f.clone()))
            .map_err(|e| e.to_string())?;
    }
    Ok(frames.len())
}

#[tauri::command]
fn save_results(json: String) -> Result<(), String> {
    std::fs::write(format!("{RESULTS_DIR}/webcodecs.json"), json).map_err(|e| e.to_string())
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![probe_frames, save_results, exit_app])
        .run(tauri::generate_context!())
        .expect("error while running tavern webcodecs probe");
}
