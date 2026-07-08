<script lang="ts">
  import { servers } from '../state/servers.svelte';
</script>

<nav class="channels">
  <ul>
    {#each servers.channels as ch (ch.id)}
      <li>
        <button
          class="channel"
          class:active={ch.id === servers.currentChannelId}
          onclick={() => servers.selectChannel(ch.id)}
        >
          <span class="kind">{ch.kind === 'voice' ? '🔊' : '#'}</span>
          <span class="label">{ch.name}</span>
          {#if ch.hasPassword && !ch.unlocked}<span class="lock" title="Locked">🔒</span>{/if}
        </button>
      </li>
    {/each}
  </ul>
</nav>

<style>
  .channels {
    padding: 0.5rem;
    overflow-y: auto;
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
