import { render } from 'vitest-browser-svelte';
import { expect, test } from 'vitest';
import MemberList from './MemberList.svelte';
import type { Member } from '../protocol/Member';
import type { Presence } from '../protocol/Presence';

const roster: Member[] = [
  { userId: 'alice', nickname: 'Alice', color: '#ff0000', avatarKey: null },
  { userId: 'bob', nickname: 'Bob', color: '#00ff00', avatarKey: null },
  { userId: 'carol', nickname: 'Carol', color: '#0000ff', avatarKey: null },
];

const presence: Record<string, Presence> = {
  alice: { userId: 'alice', state: 'online', channelId: null },
  bob: { userId: 'bob', state: 'voice', channelId: 'c1' },
};

test('renders each member with a presence-dot class matching state (absent = offline)', async () => {
  const screen = render(MemberList, { roster, presence });

  await expect.element(screen.getByTestId('dot-alice')).toHaveClass('online');
  await expect.element(screen.getByTestId('dot-bob')).toHaveClass('voice');
  await expect.element(screen.getByTestId('dot-carol')).toHaveClass('offline');
  await expect.element(screen.getByText('Alice')).toBeInTheDocument();
});
