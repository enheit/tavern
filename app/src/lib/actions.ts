import { api } from './api';
import { auth } from './state/auth.svelte';
import { servers } from './state/servers.svelte';
import { session } from './session';

// Orchestration between the REST client and app state (S3.4). Dialogs call these;
// they surface ApiError to the caller for inline error rendering.
function token(): string {
  return auth.token ?? '';
}

export async function createServer(name: string, password?: string): Promise<void> {
  const s = await api.createServer(token(), name.trim(), password || undefined);
  servers.setServers([...servers.list, { id: s.id, name: s.name, role: 'owner' }]);
  servers.selectServer(s.id);
  await loadChannels(s.id);
}

export async function joinServer(serverId: string, password?: string): Promise<void> {
  const s = await api.joinServer(token(), serverId.trim(), password || undefined);
  if (!servers.list.some((x) => x.id === s.id)) {
    servers.setServers([...servers.list, { id: s.id, name: s.name, role: 'member' }]);
  }
  servers.selectServer(s.id);
  await loadChannels(s.id);
}

export async function loadChannels(serverId: string): Promise<void> {
  servers.setChannels(serverId, await api.channels(token(), serverId));
}

export async function createChannel(
  serverId: string,
  name: string,
  kind: 'text' | 'voice',
  password?: string,
): Promise<void> {
  await api.createChannel(token(), serverId, name.trim(), kind, password || undefined);
  await loadChannels(serverId);
}

// Throws ApiError (403 wrong/non-member, 429 rate-limited) for the dialog to render.
export async function unlockChannel(channelId: string, password: string): Promise<void> {
  await api.unlock(token(), channelId, password);
  if (servers.currentServerId) await loadChannels(servers.currentServerId);
}

export async function saveProfile(patch: { nickname?: string; color?: string }): Promise<void> {
  auth.profile = await api.patchMe(token(), patch);
}

export const AVATAR_MAX = 512 * 1024;
export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export async function uploadAvatar(file: File): Promise<void> {
  if (!AVATAR_TYPES.includes(file.type)) throw new Error('unsupported_type');
  if (file.size > AVATAR_MAX) throw new Error('too_large');
  const { avatarKey } = await api.putAvatar(token(), file);
  if (auth.profile) auth.profile = { ...auth.profile, avatarKey };
}

export async function logout(): Promise<void> {
  try {
    await api.logout(token());
  } catch {
    // best-effort revoke — clear locally regardless
  }
  await session.clear();
  servers.reset();
  auth.reset(); // App re-routes to Onboarding
}
