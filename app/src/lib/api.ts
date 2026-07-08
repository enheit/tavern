// Thin REST client for the Worker. WS lives in ws.svelte.ts (S3.2); RTC in the
// Rust engine (M4). Only the endpoints the shell needs so far are wired here;
// S3.4 adds servers/channels/unlock/avatar.
export const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8787';

export interface Profile {
  userId: string;
  nickname: string;
  color: string;
  avatarKey: string | null;
}

export interface Me {
  userId: string;
  nickname: string;
  color: string;
  avatarKey: string | null;
  servers: { id: string; name: string }[];
}

export interface Session {
  userId: string;
  token: string;
  profile: Profile;
}

// REST shapes (not WS frames, so not in crates/protocol).
export interface ServerSummary {
  id: string;
  name: string;
  role?: 'owner' | 'member';
}

export interface Channel {
  id: string;
  name: string;
  kind: 'text' | 'voice';
  hasPassword: boolean;
  unlocked: boolean;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

async function req<T>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  const res = await fetch(API_BASE + path, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (!res.ok) {
    let code = 'error';
    try {
      code = ((await res.json()) as { code?: string }).code ?? code;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, code);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const api = {
  register: (nickname: string, password: string, repeat: string) =>
    req<Session>('/api/register', { method: 'POST', body: { nickname, password, repeat } }),
  login: (nickname: string, password: string) =>
    req<Session>('/api/login', { method: 'POST', body: { nickname, password } }),
  logout: (token: string) => req<void>('/api/logout', { method: 'POST', token }),
  me: (token: string) => req<Me>('/api/me', { token }),
  patchMe: (token: string, patch: { nickname?: string; color?: string }) =>
    req<Profile>('/api/me', { method: 'PATCH', token, body: patch }),

  servers: (token: string) => req<ServerSummary[]>('/api/servers', { token }),
  createServer: (token: string, name: string, password?: string) =>
    req<{ id: string; name: string }>('/api/servers', { method: 'POST', token, body: { name, password } }),
  joinServer: (token: string, serverId: string, password?: string) =>
    req<{ id: string; name: string }>('/api/servers/join', { method: 'POST', token, body: { serverId, password } }),

  channels: (token: string, serverId: string) =>
    req<Channel[]>(`/api/servers/${serverId}/channels`, { token }),
  createChannel: (token: string, serverId: string, name: string, kind: 'text' | 'voice', password?: string) =>
    req<{ id: string }>(`/api/servers/${serverId}/channels`, { method: 'POST', token, body: { name, kind, password } }),
  unlock: (token: string, channelId: string, password: string) =>
    req<void>(`/api/channels/${channelId}/unlock`, { method: 'POST', token, body: { password } }),

  async putAvatar(token: string, file: Blob): Promise<{ avatarKey: string }> {
    const res = await fetch(API_BASE + '/api/me/avatar', {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': file.type },
      body: file,
    });
    if (!res.ok) throw new ApiError(res.status, 'avatar');
    return res.json() as Promise<{ avatarKey: string }>;
  },
};
