import { expect, test } from 'vitest';
import { ChatStore, CHAT_CAP } from './chat.svelte';
import type { ChatMsg } from '../protocol/ChatMsg';

function msg(id: number, channelId = 'c1'): ChatMsg {
  return { id, channelId, userId: 'u', content: `m${id}`, nonce: null, createdAt: id };
}

test('caps in-memory messages at 200, dropping the oldest', () => {
  const chat = new ChatStore();
  for (let i = 1; i <= 250; i++) chat.add(msg(i));
  const list = chat.messages('c1');
  expect(list.length).toBe(CHAT_CAP);
  expect(list[0].id).toBe(51);
  expect(list.at(-1)?.id).toBe(250);
});

test('dedups by id and isolates channels', () => {
  const chat = new ChatStore();
  chat.add(msg(1));
  chat.add(msg(1));
  chat.add(msg(2, 'c2'));
  expect(chat.messages('c1').length).toBe(1);
  expect(chat.messages('c2').length).toBe(1);
  expect(chat.messages('missing')).toEqual([]);
});
