<script lang="ts">
  import { servers } from '../state/servers.svelte';
  import { openChannel } from '../actions';
  import type { Channel } from '../api';
  import CreateChannelDialog from './dialogs/CreateChannelDialog.svelte';
  import UnlockDialog from './dialogs/UnlockDialog.svelte';

  let showCreate = $state(false);
  let unlockTarget = $state<Channel | null>(null);

  const isOwner = $derived(servers.currentServer?.role === 'owner');

  function onChannel(ch: Channel): void {
    if (ch.hasPassword && !ch.unlocked) unlockTarget = ch;
    else openChannel(ch); // text → chat target + history; voice → §1 join sequence
  }
</script>

<nav class="channels">
  <div class="head">
    <span>Channels</span>
    {#if isOwner}
      <button class="add" aria-label="Create channel" onclick={() => (showCreate = true)}>+</button>
    {/if}
  </div>
  <ul>
    {#each servers.channels as ch (ch.id)}
      <li>
        <button
          class="channel"
          class:active={ch.id === servers.currentChannelId}
          onclick={() => onChannel(ch)}
        >
          <span class="kind">{ch.kind === 'voice' ? '🔊' : '#'}</span>
          <span class="label">{ch.name}</span>
          {#if ch.hasPassword && !ch.unlocked}<span class="lock" title="Locked">🔒</span>{/if}
        </button>
      </li>
    {/each}
  </ul>
</nav>

{#if showCreate && servers.currentServerId}
  <CreateChannelDialog serverId={servers.currentServerId} onclose={() => (showCreate = false)} />
{/if}
{#if unlockTarget}
  <UnlockDialog
    channelId={unlockTarget.id}
    channelName={unlockTarget.name}
    onclose={() => (unlockTarget = null)}
  />
{/if}

<style>
  .channels {
    padding: 0.5rem;
    overflow-y: auto;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 0.5rem 0.35rem;
    font-size: 0.75rem;
    text-transform: uppercase;
    color: var(--muted);
  }

  .add {
    border: none;
    background: transparent;
    color: var(--muted);
    font-size: 1rem;
    cursor: pointer;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .channel {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
    padding: 0.3rem 0.5rem;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--fg);
    text-align: left;
    cursor: pointer;
    font-size: 0.9rem;
  }

  .channel.active {
    background: color-mix(in srgb, var(--accent) 22%, transparent);
  }

  .kind {
    color: var(--muted);
    width: 1em;
    text-align: center;
  }

  .label {
    flex: 1;
  }
</style>
