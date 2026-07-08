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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceJoined {
    pub track_name: String,
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
) -> Result<VoiceJoined, String> {
    engine
        .0
        .voice_join(&channel_id)
        .await
        .map(|track_name| VoiceJoined { track_name })
        .map_err(|e| e.to_string())
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

/// Bridge the engine's sinks onto the Tauri event bus (`engine://state {voice}`,
/// `engine://levels [{userId, rms}]` @10 Hz). Called once from setup().
pub fn bridge_events(engine: &Engine, app: &AppHandle) {
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
}
