import type { Member } from '../protocol/Member';
import type { Presence } from '../protocol/Presence';
import type { Channel, ServerSummary } from '../api';

// Control-plane state: which servers/channels exist, current selection, and the
// per-server roster + presence. WS frames feed the setters here (S3.2); S3.1
// tests seed them directly.
export class ServersStore {
  list = $state<ServerSummary[]>([]);
  currentServerId = $state<string | null>(null);
  currentChannelId = $state<string | null>(null);
  channelsByServer = $state<Record<string, Channel[]>>({});
  rosterByServer = $state<Record<string, Member[]>>({});
  presenceByServer = $state<Record<string, Record<string, Presence>>>({});

  get channels(): Channel[] {
    return this.currentServerId ? (this.channelsByServer[this.currentServerId] ?? []) : [];
  }

  get roster(): Member[] {
    return this.currentServerId ? (this.rosterByServer[this.currentServerId] ?? []) : [];
  }

  get presence(): Record<string, Presence> {
    return this.currentServerId ? (this.presenceByServer[this.currentServerId] ?? {}) : {};
  }

  get currentChannel(): Channel | null {
    return this.channels.find((c) => c.id === this.currentChannelId) ?? null;
  }

  setServers(list: ServerSummary[]): void {
    this.list = list;
    if (!this.currentServerId && list.length) this.selectServer(list[0].id);
  }

  selectServer(id: string): void {
    this.currentServerId = id;
    this.currentChannelId = this.defaultChannel(this.channelsByServer[id] ?? []);
  }

  setChannels(serverId: string, channels: Channel[]): void {
    this.channelsByServer = { ...this.channelsByServer, [serverId]: channels };
    if (serverId === this.currentServerId && !this.currentChannel) {
      this.currentChannelId = this.defaultChannel(channels);
    }
  }

  selectChannel(id: string): void {
    this.currentChannelId = id;
  }

  setRoster(serverId: string, roster: Member[]): void {
    this.rosterByServer = { ...this.rosterByServer, [serverId]: roster };
  }

  applyPresence(serverId: string, p: Presence): void {
    const cur = { ...(this.presenceByServer[serverId] ?? {}) };
    if (p.state === 'offline') delete cur[p.userId];
    else cur[p.userId] = p;
    this.presenceByServer = { ...this.presenceByServer, [serverId]: cur };
  }

  private defaultChannel(channels: Channel[]): string | null {
    return (channels.find((c) => c.kind === 'text') ?? channels[0])?.id ?? null;
  }
}

export const servers = new ServersStore();
