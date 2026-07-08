<script lang="ts">
  import { servers } from '../state/servers.svelte';
  import CreateServerDialog from './dialogs/CreateServerDialog.svelte';
  import JoinServerDialog from './dialogs/JoinServerDialog.svelte';

  let menu = $state(false);
  let dialog = $state<'none' | 'create' | 'join'>('none');

  function initials(name: string): string {
    return name.slice(0, 2).toUpperCase();
  }

  function open(which: 'create' | 'join'): void {
    dialog = which;
    menu = false;
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
  <button class="server add" title="Add server" aria-label="Add server" onclick={() => (menu = !menu)}>+</button>
  {#if menu}
    <div class="menu">
      <button onclick={() => open('create')}>Create server</button>
      <button onclick={() => open('join')}>Join server</button>
    </div>
  {/if}
</nav>

{#if dialog === 'create'}<CreateServerDialog onclose={() => (dialog = 'none')} />{/if}
{#if dialog === 'join'}<JoinServerDialog onclose={() => (dialog = 'none')} />{/if}

<style>
  .rail {
    position: relative;
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

  .menu {
    position: absolute;
    left: 100%;
    bottom: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.25rem;
    background: var(--bg);
    border: 1px solid color-mix(in srgb, var(--muted) 30%, transparent);
    border-radius: 8px;
    z-index: 50;
  }

  .menu button {
    white-space: nowrap;
    padding: 0.35rem 0.6rem;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--fg);
    text-align: left;
    cursor: pointer;
  }
</style>
