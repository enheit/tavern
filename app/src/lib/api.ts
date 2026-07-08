// Thin REST client for the Worker. WS lives in ws.svelte.ts (S3.2); RTC in the
// Rust engine (M4). Only the endpoints the shell needs so far are wired here;
// S3.4 adds servers/channels/unlock/avatar.
const BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8787';

export interface Profile {
  userId: string;
  nickname: string;
  color: string;
  avatarKey: string | null;
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
  const res = await fetch(BASE + path, {
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
};
