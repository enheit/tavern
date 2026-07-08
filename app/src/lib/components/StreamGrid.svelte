<script lang="ts">
  import { voice, VoiceStore } from '../state/voice.svelte';
  import StreamTile from './StreamTile.svelte';
</script>

{#if voice.inVoice && voice.videoTiles.length}
  <div class="grid" data-testid="stream-grid">
    {#each voice.videoTiles as t (VoiceStore.tileKey(t))}
      <StreamTile track={t} />
    {/each}
  </div>
{/if}

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    overflow-y: auto;
    max-height: 55%;
  }
</style>
