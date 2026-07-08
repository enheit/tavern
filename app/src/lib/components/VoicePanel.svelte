<script lang="ts">
  import { voice } from '../state/voice.svelte';
</script>

<!-- Placeholder voice panel (§1 S3.1). S4.2 wires join/leave, sliders, speaking rings. -->
<div class="voice">
  <span class="status">{voice.inVoice ? 'In voice' : 'Not in voice'}</span>
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

<style>
  .voice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-top: 1px solid color-mix(in srgb, var(--muted) 30%, transparent);
  }

  .status {
    font-size: 0.8rem;
    color: var(--muted);
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
</style>
