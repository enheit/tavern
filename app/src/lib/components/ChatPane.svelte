<script lang="ts">
  import { servers } from '../state/servers.svelte';
  import { chat } from '../state/chat.svelte';

  const channel = $derived(servers.currentChannel);
  const messages = $derived(channel ? chat.messages(channel.id) : []);

  // Send is wired to the WS client in S3.2; the composer is inert for now.
  let draft = $state('');
</script>

<section class="chat">
  {#if !channel}
    <p class="empty">No channel selected.</p>
  {:else if channel.kind === 'voice'}
    <p class="empty">🔊 {channel.name} — voice channel.</p>
  {:else}
    <div class="log">
      {#each messages as m (m.id)}
        <p class="msg"><span class="who">{m.userId}</span><span class="body">{m.content}</span></p>
      {/each}
    </div>
    <form class="composer" onsubmit={(e) => e.preventDefault()}>
      <input
        placeholder={`Message #${channel.name}`}
        bind:value={draft}
        aria-label="Message"
        disabled
      />
    </form>
  {/if}
</section>

<style>
  .chat {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
  }

  .log {
    flex: 1;
    overflow-y: auto;
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .msg {
    margin: 0;
    font-size: 0.9rem;
  }

  .who {
    color: var(--muted);
    margin-right: 0.5rem;
  }

  .empty {
    padding: 1rem;
    color: var(--muted);
  }

  .composer {
    padding: 0.5rem 0.75rem;
    border-top: 1px solid color-mix(in srgb, var(--muted) 30%, transparent);
  }

  input {
    width: 100%;
    padding: 0.5rem;
    border: 1px solid color-mix(in srgb, var(--muted) 40%, transparent);
    border-radius: 6px;
    background: transparent;
    color: var(--fg);
  }
</style>
