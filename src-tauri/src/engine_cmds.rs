//! §1 Engine⇄UI surface (voice subset, S4.2): Tauri commands wrapping the media engine and the
//! `engine://state` / `engine://levels` event bridge. The webview owns no media — every command
//! is a thin async pass-through into `tavern_engine::Engine`, errors surface as invoke
//! rejections (strings) for the UI toast.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tavern_engine::Engine;
use tavern_protocol::TrackInfo;

/// Managed handle to the singleton media engine.
pub struct EngineHandle(pub Arc<Engine>);

/// `{trackName}` reply shared by voice_join / screen_share_start / webcam_start (§1).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackNameDto {
    pub track_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDto {
    pub id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebcamDto {
    pub id: String,
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusDto {
    pub voice: String,
    pub publishing: Vec<PublishingDto>,
    pub watching: Vec<WatchingDto>,
    pub webcodecs_ok: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishingDto {
    pub kind: String,
    pub track_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchingDto {
    pub owner_id: String,
    pub track_name: String,
    pub layer: String,
}

/// `engine_configure({apiBase, token})` — push the signaling target into the engine. Called
/// after login/boot and on token change, before any voice command (§1).
#[tauri::command]
pub fn engine_configure(
    engine: State<'_, EngineHandle>,
    api_base: String,
    token: String,
) -> Result<(), String> {
    engine.0.configure(&api_base, &token);
    Ok(())
}

#[tauri::command]
pub async fn voice_join(
    engine: State<'_, EngineHandle>,
    channel_id: String,
) -> Result<TrackNameDto, String> {
    engine
        .0
        .voice_join(&channel_id)
        .await
        .map(|track_name| TrackNameDto { track_name })
        .map_err(|e| e.to_string())
}

/// `screen_sources() → [{id,name,kind}]` (§1). Async so source enumeration never blocks
/// the main thread.
#[tauri::command]
pub async fn screen_sources(engine: State<'_, EngineHandle>) -> Result<Vec<SourceDto>, String> {
    engine
        .0
        .screen_sources()
        .map(|v| {
            v.into_iter()
                .map(|s| SourceDto {
                    id: s.id,
                    name: s.name,
                    kind: match s.kind {
                        tavern_capture::SourceKind::Screen => "screen".into(),
                        tavern_capture::SourceKind::Window => "window".into(),
                    },
                })
                .collect()
        })
        .map_err(|e| e.to_string())
}

/// `screen_share_start({sourceId,width,height,fps}) → {trackName}`; 0×0 = native (§1).
#[tauri::command]
pub async fn screen_share_start(
    engine: State<'_, EngineHandle>,
    source_id: String,
    width: u32,
    height: u32,
    fps: u32,
) -> Result<TrackNameDto, String> {
    engine
        .0
        .screen_share_start(&source_id, width, height, fps)
        .await
        .map(|track_name| TrackNameDto { track_name })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn screen_share_stop(engine: State<'_, EngineHandle>) -> Result<(), String> {
    engine
        .0
        .screen_share_stop()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn webcam_list(engine: State<'_, EngineHandle>) -> Result<Vec<WebcamDto>, String> {
    engine
        .0
        .webcam_list()
        .map(|v| {
            v.into_iter()
                .map(|w| WebcamDto {
                    id: w.id,
                    name: w.name,
                })
                .collect()
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn webcam_start(
    engine: State<'_, EngineHandle>,
    device_id: String,
    width: u32,
    height: u32,
    fps: u32,
) -> Result<TrackNameDto, String> {
    engine
        .0
        .webcam_start(&device_id, width, height, fps)
        .await
        .map(|track_name| TrackNameDto { track_name })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn webcam_stop(engine: State<'_, EngineHandle>) -> Result<(), String> {
    engine.0.webcam_stop().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn voice_leave(engine: State<'_, EngineHandle>) -> Result<(), String> {
    engine.0.voice_leave().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_mic_muted(engine: State<'_, EngineHandle>, muted: bool) {
    engine.0.set_mic_muted(muted);
}

#[tauri::command]
pub fn set_deafened(engine: State<'_, EngineHandle>, deafened: bool) {
    engine.0.set_deafened(deafened);
}

#[tauri::command]
pub fn set_user_gain(engine: State<'_, EngineHandle>, user_id: String, gain: f32) {
    engine.0.set_user_gain(&user_id, gain);
}

/// UI forwards every `tracks` roster (hello.ok + broadcasts); the engine diffs and
/// auto-subscribes mic tracks while in voice (§1).
#[tauri::command]
pub async fn set_remote_tracks(
    engine: State<'_, EngineHandle>,
    tracks: Vec<TrackInfo>,
) -> Result<(), String> {
    engine
        .0
        .set_remote_tracks(tracks)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn engine_status(engine: State<'_, EngineHandle>) -> StatusDto {
    let s = engine.0.status();
    StatusDto {
        voice: s.voice,
        publishing: s
            .publishing
            .into_iter()
            .map(|p| PublishingDto {
                kind: p.kind,
                track_name: p.track_name,
            })
            .collect(),
        watching: s
            .watching
            .into_iter()
            .map(|w| WatchingDto {
                owner_id: w.owner_id,
                track_name: w.track_name,
                layer: w.layer,
            })
            .collect(),
        webcodecs_ok: s.webcodecs_ok,
    }
}

/// Bridge the engine's sinks onto the Tauri event bus (`engine://state {voice, err?}`,
/// `engine://levels [{userId, rms}]` @10 Hz, `engine://stats {json}` @1 Hz). Called once
/// from setup().
pub fn bridge_events(engine: &Arc<Engine>, app: &AppHandle) {
    let h = app.clone();
    engine.set_state_sink(Arc::new(move |voice: String| {
        let _ = h.emit("engine://state", serde_json::json!({ "voice": voice }));
    }));
    let h = app.clone();
    engine.set_levels_sink(Arc::new(move |levels| {
        let payload: Vec<serde_json::Value> = levels
            .iter()
            .map(|l| serde_json::json!({ "userId": l.user_id, "rms": l.rms }))
            .collect();
        let _ = h.emit("engine://levels", payload);
    }));
    let h = app.clone();
    engine.set_stats_sink(Arc::new(move |json| {
        let _ = h.emit("engine://stats", json);
    }));
    let h = app.clone();
    let eng = engine.clone();
    engine.set_error_sink(Arc::new(move |code: String| {
        let _ = h.emit(
            "engine://state",
            serde_json::json!({ "voice": eng.status().voice, "err": code }),
        );
    }));
}
