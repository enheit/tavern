import { invoke } from '@tauri-apps/api/core';

export interface Session {
  userId: string;
  token: string;
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// Frontend wrappers for the S3.3 Rust commands. No-ops outside the Tauri webview
// (browser dev / component tests without mockIPC) so nothing throws there.
export const session = {
  async load(): Promise<Session | null> {
    if (!inTauri()) return null;
    return (await invoke<Session | null>('session_load')) ?? null;
  },
  async save(s: Session): Promise<void> {
    if (inTauri()) await invoke('session_save', { session: s });
  },
  async clear(): Promise<void> {
    if (inTauri()) await invoke('session_clear');
  },
  async configureEngine(apiBase: string, token: string): Promise<void> {
    if (inTauri()) await invoke('engine_configure', { apiBase, token });
  },
};
