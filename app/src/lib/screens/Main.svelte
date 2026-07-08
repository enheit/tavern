<script lang="ts">
  import { auth } from '../state/auth.svelte';
  import { servers } from '../state/servers.svelte';
  import { theme } from '../state/theme.svelte';
  import ServerRail from '../components/ServerRail.svelte';
  import ChannelList from '../components/ChannelList.svelte';
  import ChatPane from '../components/ChatPane.svelte';
  import MemberList from '../components/MemberList.svelte';
  import VoicePanel from '../components/VoicePanel.svelte';

  const currentServer = $derived(servers.list.find((s) => s.id === servers.currentServerId));
</script>

<div class="layout">
  <ServerRail />

  <aside class="sidebar">
    <header class="server-head">{currentServer?.name ?? 'Tavern'}</header>
    <ChannelList />
    <VoicePanel />
  </aside>

  <main class="content">
    <header class="chan-head">
      <span>{servers.currentChannel?.name ?? ''}</span>
      <button class="theme" title="Theme: {theme.mode}" onclick={() => theme.cycle()}>
        {theme.mode === 'system' ? '🖥️' : theme.mode === 'light' ? '☀️' : '🌙'}
      </button>
    </header>
    <ChatPane />
  </main>

  <aside class="members-pane">
    <header class="members-head">{auth.profile?.nickname ?? ''}</header>
    <MemberList roster={servers.roster} presence={servers.presence} />
  </aside>
</div>

<style>
  .layout {
    display: grid;
    grid-template-columns: auto 220px 1fr 200px;
    height: 100vh;
  }

  .sidebar {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: color-mix(in srgb, var(--muted) 8%, transparent);
  }

  .server-head,
  .chan-head,
  .members-head {
    padding: 0.6rem 0.75rem;
    font-weight: 600;
    border-bottom: 1px solid color-mix(in srgb, var(--muted) 25%, transparent);
  }

  .chan-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .theme {
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 1rem;
  }

  .content {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .members-pane {
    background: color-mix(in srgb, var(--muted) 8%, transparent);
    border-left: 1px solid color-mix(in srgb, var(--muted) 25%, transparent);
  }
</style>
