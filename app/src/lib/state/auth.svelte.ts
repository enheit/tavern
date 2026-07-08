import { api, ApiError, type Profile } from '../api';

export class AuthStore {
  userId = $state<string | null>(null);
  token = $state<string | null>(null);
  profile = $state<Profile | null>(null);
  error = $state<string | null>(null);
  pending = $state(false);

  get authed(): boolean {
    return this.token !== null;
  }

  async register(nickname: string, password: string, repeat: string): Promise<void> {
    await this.run(() => api.register(nickname, password, repeat));
  }

  async login(nickname: string, password: string): Promise<void> {
    await this.run(() => api.login(nickname, password));
  }

  // S3.3 restores a session from the keyring; S3.4 wires POST /api/logout.
  setSession(userId: string, token: string, profile: Profile): void {
    this.userId = userId;
    this.token = token;
    this.profile = profile;
    this.error = null;
  }

  reset(): void {
    this.userId = null;
    this.token = null;
    this.profile = null;
  }

  private async run(call: () => Promise<{ userId: string; token: string; profile: Profile }>) {
    this.pending = true;
    this.error = null;
    try {
      const s = await call();
      this.setSession(s.userId, s.token, s.profile);
    } catch (e) {
      this.error = e instanceof ApiError ? e.code : 'network_error';
    } finally {
      this.pending = false;
    }
  }
}

export const auth = new AuthStore();
