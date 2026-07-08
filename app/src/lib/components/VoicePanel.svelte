<script lang="ts">
  import { voice, SHARE_CAP } from '../state/voice.svelte';
  import { servers } from '../state/servers.svelte';
  import ShareDialog from './dialogs/ShareDialog.svelte';
  import WebcamDialog from './dialogs/WebcamDialog.svelte';

  let sharePickerOpen = $state(false);
  let camPickerOpen = $state(false);

  // Roster/channel names come from the VOICE server (which can differ from the
  // server currently being viewed).
  const roster = $derived(voice.serverId ? (servers.rosterByServer[voice.serverId] ?? []) : []);
  const channelName = $derived(
    voice.serverId && voice.channelId
      ? ((servers.channelsByServer[voice.serverId] ?? []).find((c) => c.id === voice.channelId)
          ?.name ?? voice.channelId)
      : null,
  );

  function nick(userId: string): string {
    return roster.find((m) => m.userId === userId)?.nickname ?? userId;
  }
</script>

<div class="voice">
  {#if voice.error}
    <p class="toast" role="alert">{voice.error}</p>
  {/if}

  <div class="row">
    {#if voice.status === 'joining'}
      <span class="status">Joining…</span>
    {:else if voice.inVoice}
      <span class="status in">🔊 {channelName}</span>
      <button class="ctl" onclick={() => void voice.leave()}>Leave</button>
    {:else}
      <span class="status">Not in voice</span>
    {/if}
    <div class="controls">
      <button
        class="ctl"
        class:on={voice.muted}
        aria-pressed={voice.muted}
        onclick={() => voice.toggleMute()}
      >
        {voice.muted ? 'Unmute' : 'Mute'}
      </button>
      <button
        class="ctl"
        class:on={voice.deafened}
        aria-pressed={voice.deafened}
        onclick={() => voice.toggleDeafen()}
      >
        {voice.deafened ? 'Undeafen' : 'Deafen'}
      </button>
    </div>
  </div>

  {#if voice.inVoice}
    <div class="row">
      {#if voice.sharing}
        <span class="status in" data-testid="sharing-indicator">🖥️ You are sharing</span>
        <button class="ctl" onclick={() => void voice.shareStop()}>Stop sharing</button>
      {:else}
        <button
          class="ctl"
          disabled={voice.shareDisabled}
          title={voice.shareDisabled ? `Share limit reached (${SHARE_CAP} per channel)` : undefined}
          onclick={() => (sharePickerOpen = true)}
        >
          Share screen
        </button>
      {/if}
      {#if voice.camera}
        <span class="status in" data-testid="camera-indicator">📷 Webcam on</span>
        <button class="ctl" onclick={() => void voice.camStop()}>Turn off webcam</button>
      {:else}
        <button class="ctl" onclick={() => (camPickerOpen = true)}>Webcam</button>
      {/if}
    </div>
  {/if}

  {#if sharePickerOpen}
    <ShareDialog onclose={() => (sharePickerOpen = false)} />
  {/if}
  {#if camPickerOpen}
    <WebcamDialog onclose={() => (camPickerOpen = false)} />
  {/if}

  {#if voice.inVoice && voice.participants.length}
    <ul class="members">
      {#each voice.participants as userId (userId)}
        <li class="member">
          <span class="dot" class:speaking={voice.speaking[userId]} data-testid={`vdot-${userId}`}
          ></span>
          <span class="name">{nick(userId)}</span>
          <input
            class="gain"
            type="range"
            min="0"
            max="200"
            value={Math.round(voice.gain(userId) * 100)}
            aria-label={`Volume for ${nick(userId)}`}
            oninput={(e) => voice.setGain(userId, Number(e.currentTarget.value) / 100)}
          />
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .voice {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.5rem 0.75rem;
    border-top: 1px solid color-mix(in srgb, var(--muted) 30%, transparent);
  }

  .toast {
    margin: 0;
    padding: 0.35rem 0.5rem;
    border-radius: 6px;
    background: color-mix(in srgb, #e5484d 18%, transparent);
    color: #e5484d;
    font-size: 0.78rem;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .status {
    font-size: 0.8rem;
    color: var(--muted);
  }

  .status.in {
    color: var(--fg);
    font-weight: 600;
  }

  .controls {
    display: flex;
    gap: 0.4rem;
  }

  .ctl {
    padding: 0.3rem 0.6rem;
    border: 1px solid color-mix(in srgb, var(--muted) 40%, transparent);
    border-radius: 6px;
    background: transparent;
    color: var(--fg);
    cursor: pointer;
    font-size: 0.8rem;
  }

  .ctl.on {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }

  .members {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .member {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.85rem;
  }

  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--muted) 45%, transparent);
    outline: 2px solid transparent;
  }

  /* §1 speaking ring: RMS > 0.02 sustained ≥100 ms. */
  .dot.speaking {
    background: #30a46c;
    outline-color: color-mix(in srgb, #30a46c 55%, transparent);
  }

  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .gain {
    width: 80px;
  }
</style>
