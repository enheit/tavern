<script lang="ts">
  import { servers } from '../state/servers.svelte';
  import { chat } from '../state/chat.svelte';
  import { wsPool } from '../state/ws.svelte';

  const channel = $derived(servers.currentChannel);
  const messages = $derived(channel ? chat.messages(channel.id) : []);
  // §0: author shown as nickname in their chosen color (falls back to the raw id
  // for users who left the server — their messages remain).
  const byId = $derived(new Map(servers.roster.map((m) => [m.userId, m])));

  let draft = $state('');

  // Live send over the per-server WS (§1 chat.send). No optimistic row: the server
  // echoes chat.msg to everyone including the sender; the nonce guards re-sends.
  function send(): void {
    const content = draft.trim();
    if (!content || !channel || !servers.currentServerId) return;
    wsPool
      .get(servers.currentServerId)
      ?.send({ t: 'chat.send', channelId: channel.id, content, nonce: crypto.randomUUID() });
    draft = '';
  }
</script>

<section class="chat">
  {#if !channel}
    <p class="empty">No channel selected.</p>
  {:else if channel.kind === 'voice'}
    <p class="empty">🔊 {channel.name} — voice channel.</p>
  {:else}
    <div class="log">
      {#each messages as m (m.id)}
        <p class="msg">
          <span class="who" style:color={byId.get(m.userId)?.color}>
            {byId.get(m.userId)?.nickname ?? m.userId}
          </span><span class="body">{m.content}</span>
        </p>
      {/each}
    </div>
    <form
      class="composer"
      onsubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <input placeholder={`Message #${channel.name}`} bind:value={draft} aria-label="Message" />
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
