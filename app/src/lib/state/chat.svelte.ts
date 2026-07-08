import type { ChatMsg } from '../protocol/ChatMsg';

// §1: chat pane in-memory cap is 200 messages per channel.
export const CHAT_CAP = 200;

export class ChatStore {
  byChannel = $state<Record<string, ChatMsg[]>>({});

  messages(channelId: string): ChatMsg[] {
    return this.byChannel[channelId] ?? [];
  }

  // Append a newer message, dedup by id, keeping only the most recent CHAT_CAP.
  add(msg: ChatMsg): void {
    const cur = this.byChannel[msg.channelId] ?? [];
    if (cur.some((m) => m.id === msg.id)) return;
    let next = [...cur, msg];
    if (next.length > CHAT_CAP) next = next.slice(next.length - CHAT_CAP);
    this.byChannel = { ...this.byChannel, [msg.channelId]: next };
  }

  reset(): void {
    this.byChannel = {};
  }
}

export const chat = new ChatStore();
