import type { ChatMsg } from '../protocol/ChatMsg';

// §1: chat pane in-memory cap is 200 messages per channel.
export const CHAT_CAP = 200;

export class ChatStore {
  byChannel = $state<Record<string, ChatMsg[]>>({});

  messages(channelId: string): ChatMsg[] {
    return this.byChannel[channelId] ?? [];
  }

  add(msg: ChatMsg): void {
    this.merge(msg.channelId, [msg]);
  }

  // Merge messages (live or a history page) into a channel, kept ascending by id.
  // Dedup by id; also dedup by nonce so an optimistic own-send is replaced by the
  // server's authoritative row when it echoes (§1). Keeps the newest CHAT_CAP.
  // ponytail: full re-sort per merge — n ≤ 200, so O(n log n) is irrelevant.
  merge(channelId: string, msgs: ChatMsg[]): void {
    const byId = new Map((this.byChannel[channelId] ?? []).map((m) => [m.id, m]));
    for (const m of msgs) {
      if (m.nonce) {
        for (const [id, ex] of byId) if (ex.nonce === m.nonce && id !== m.id) byId.delete(id);
      }
      byId.set(m.id, m);
    }
    let next = [...byId.values()].sort((a, b) => a.id - b.id);
    if (next.length > CHAT_CAP) next = next.slice(next.length - CHAT_CAP);
    this.byChannel = { ...this.byChannel, [channelId]: next };
  }

  reset(): void {
    this.byChannel = {};
  }
}

export const chat = new ChatStore();
