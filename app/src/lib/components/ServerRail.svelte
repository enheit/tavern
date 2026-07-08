<script lang="ts">
  import { servers } from '../state/servers.svelte';

  function initials(name: string): string {
    return name.slice(0, 2).toUpperCase();
  }
</script>

<nav class="rail">
  {#each servers.list as s (s.id)}
    <button
      class="server"
      class:active={s.id === servers.currentServerId}
      title={s.name}
      onclick={() => servers.selectServer(s.id)}
    >
      {initials(s.name)}
    </button>
  {/each}
  <!-- Create/Join dialogs land in S3.4. -->
  <button class="server add" title="Add server" disabled>+</button>
</nav>

<style>
  .rail {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem;
    background: color-mix(in srgb, var(--muted) 12%, transparent);
  }

  .server {
    width: 44px;
    height: 44px;
    border-radius: 12px;
    border: 1px solid transparent;
    background: color-mix(in srgb, var(--muted) 20%, transparent);
    color: var(--fg);
    cursor: pointer;
    font-size: 0.85rem;
    font-weight: 600;
  }

  .server.active {
    border-color: var(--accent);
    border-radius: 14px;
  }

  .server.add {
    color: var(--muted);
    font-size: 1.3rem;
    line-height: 1;
  }
</style>
