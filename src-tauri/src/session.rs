use serde::{Deserialize, Serialize};
use tauri::State;

const SERVICE: &str = "app.tavern.desktop";
const ACCOUNT: &str = "session";

/// Persisted session (§1 Auth). camelCase over the IPC boundary to match the JS
/// `{userId, token}` shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub user_id: String,
    pub token: String,
}

/// Credential storage behind a trait so the OS keyring (which needs a live
/// keychain) is swappable for an in-memory mock in `cargo test`.
pub trait CredentialStore: Send + Sync {
    fn load(&self) -> Result<Option<Session>, String>;
    fn save(&self, session: &Session) -> Result<(), String>;
    fn clear(&self) -> Result<(), String>;
}

/// Real store: OS keychain via the `keyring` crate, session serialized as JSON.
#[derive(Default)]
pub struct KeyringStore;

impl KeyringStore {
    fn entry(&self) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
    }
}

impl CredentialStore for KeyringStore {
    fn load(&self) -> Result<Option<Session>, String> {
        match self.entry()?.get_password() {
            Ok(json) => serde_json::from_str(&json)
                .map(Some)
                .map_err(|e| e.to_string()),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    fn save(&self, session: &Session) -> Result<(), String> {
        let json = serde_json::to_string(session).map_err(|e| e.to_string())?;
        self.entry()?.set_password(&json).map_err(|e| e.to_string())
    }
    fn clear(&self) -> Result<(), String> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// Managed credential store (real keyring in the app; a mock in tests).
pub struct SessionStore(pub Box<dyn CredentialStore>);

#[tauri::command]
pub fn session_load(store: State<'_, SessionStore>) -> Result<Option<Session>, String> {
    store.0.load()
}

#[tauri::command]
pub fn session_save(store: State<'_, SessionStore>, session: Session) -> Result<(), String> {
    store.0.save(&session)
}

#[tauri::command]
pub fn session_clear(store: State<'_, SessionStore>) -> Result<(), String> {
    store.0.clear()
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    struct MockStore(Mutex<Option<Session>>);
    impl CredentialStore for MockStore {
        fn load(&self) -> Result<Option<Session>, String> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn save(&self, s: &Session) -> Result<(), String> {
            *self.0.lock().unwrap() = Some(s.clone());
            Ok(())
        }
        fn clear(&self) -> Result<(), String> {
            *self.0.lock().unwrap() = None;
            Ok(())
        }
    }

    #[test]
    fn store_roundtrip_save_load_clear() {
        let store = MockStore(Mutex::new(None));
        assert_eq!(store.load().unwrap(), None);

        let s = Session {
            user_id: "u1".into(),
            token: "t1".into(),
        };
        store.save(&s).unwrap();
        assert_eq!(store.load().unwrap(), Some(s));

        store.clear().unwrap();
        assert_eq!(store.load().unwrap(), None);
    }

    #[test]
    fn session_serializes_camelcase_for_the_ipc_boundary() {
        let s = Session {
            user_id: "u1".into(),
            token: "t1".into(),
        };
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(json, r#"{"userId":"u1","token":"t1"}"#);
        assert_eq!(serde_json::from_str::<Session>(&json).unwrap(), s);
    }
}
