mod engine_cmds;
mod session;

use std::sync::Arc;

use engine_cmds::EngineHandle;
use session::{KeyringStore, SessionStore};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Singleton media engine (S4.1): all voice/media lives here, the webview is pure UI.
    let engine = Arc::new(tavern_engine::Engine::new());
    let engine_for_setup = engine.clone();
    tauri::Builder::default()
        .manage(SessionStore(Box::new(KeyringStore)))
        .manage(EngineHandle(engine))
        .setup(move |app| {
            engine_cmds::bridge_events(&engine_for_setup, app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            session::session_load,
            session::session_save,
            session::session_clear,
            engine_cmds::engine_configure,
            engine_cmds::voice_join,
            engine_cmds::voice_leave,
            engine_cmds::set_mic_muted,
            engine_cmds::set_deafened,
            engine_cmds::set_user_gain,
            engine_cmds::set_remote_tracks,
            engine_cmds::engine_status,
            engine_cmds::screen_sources,
            engine_cmds::screen_share_start,
            engine_cmds::screen_share_stop,
            engine_cmds::webcam_list,
            engine_cmds::webcam_start,
            engine_cmds::webcam_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tavern application")
}
