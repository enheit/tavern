<script lang="ts">
  import type { Member } from '../protocol/Member';
  import type { Presence } from '../protocol/Presence';

  let { roster, presence }: { roster: Member[]; presence: Record<string, Presence> } = $props();

  // §1: hello.ok presence carries only online/voice rows; absence = offline.
  function stateOf(userId: string): 'online' | 'voice' | 'offline' {
    const s = presence[userId]?.state;
    return s === 'online' || s === 'voice' ? s : 'offline';
  }
</script>

<ul class="members">
  {#each roster as m (m.userId)}
    {@const state = stateOf(m.userId)}
    <li>
      <span class="dot {state}" data-testid="dot-{m.userId}" title={state}></span>
      <span class="name" style:color={m.color}>{m.nickname}</span>
    </li>
  {/each}
</ul>

<style>
  .members {
    list-style: none;
    margin: 0;
    padding: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: none;
    background: var(--muted);
  }

  .dot.online {
    background: #3ba55d;
  }

  .dot.voice {
    background: var(--accent);
  }

  .dot.offline {
    background: var(--muted);
    opacity: 0.4;
  }

  .name {
    font-size: 0.9rem;
  }
</style>
