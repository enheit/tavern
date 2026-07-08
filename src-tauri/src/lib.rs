mod session;

use session::{EngineConfig, KeyringStore, SessionStore};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SessionStore(Box::new(KeyringStore)))
        .manage(EngineConfig::default())
        .invoke_handler(tauri::generate_handler![
            session::session_load,
            session::session_save,
            session::session_clear,
            session::engine_configure,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tavern application");
}
