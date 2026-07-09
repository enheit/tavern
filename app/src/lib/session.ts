import { invoke } from '@tauri-apps/api/core';
import { webEngine } from './engine.web';

export interface Session {
  userId: string;
  token: string;
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// S7 web build: no keyring in a browser — localStorage keeps the login across
// reloads (the usual web-app token trust model).
const WEB_KEY = 'tavern-session';

// Frontend wrappers for the S3.3 Rust commands. Outside the Tauri webview the
// keyring is replaced by localStorage (tests clear it in setup).
export const session = {
  async load(): Promise<Session | null> {
    if (!inTauri()) {
      try {
        const s = JSON.parse(localStorage.getItem(WEB_KEY) ?? 'null') as Session | null;
        return s && typeof s.userId === 'string' && typeof s.token === 'string' ? s : null;
      } catch {
        return null;
      }
    }
    return (await invoke<Session | null>('session_load')) ?? null;
  },
  async save(s: Session): Promise<void> {
    if (inTauri()) await invoke('session_save', { session: s });
    else {
      try {
        localStorage.setItem(WEB_KEY, JSON.stringify(s));
      } catch {
        // storage disabled — login just won't persist across reloads
      }
    }
  },
  async clear(): Promise<void> {
    if (inTauri()) await invoke('session_clear');
    else {
      try {
        localStorage.removeItem(WEB_KEY);
      } catch {
        // nothing to clear
      }
    }
  },
  async configureEngine(apiBase: string, token: string): Promise<void> {
    if (inTauri()) await invoke('engine_configure', { apiBase, token });
    else webEngine.configure(apiBase, token);
  },
};
