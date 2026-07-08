import { auth } from './state/auth.svelte';
import { servers } from './state/servers.svelte';
import { api, API_BASE, ApiError } from './api';
import { session, type Session } from './session';

// Bring a session online: confirm it via /api/me, hydrate auth + servers, persist
// to the keyring, and configure the engine (§1). A 401 means the stored token is
// dead → clear the keyring and fall back to Onboarding. Returns whether it stuck.
export async function activate(s: Session): Promise<boolean> {
  try {
    const me = await api.me(s.token);
    auth.setSession(me.userId, s.token, {
      userId: me.userId,
      nickname: me.nickname,
      color: me.color,
      avatarKey: me.avatarKey,
    });
    servers.setServers(me.servers.map((x) => ({ id: x.id, name: x.name })));
    await session.save(s);
    await session.configureEngine(API_BASE, s.token);
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      await session.clear();
      auth.reset();
    }
    return false;
  }
}

// Boot: restore a stored session if present, else stay on Onboarding.
export async function restoreSession(): Promise<void> {
  const s = await session.load();
  if (s) await activate(s);
}
