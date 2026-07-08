<script lang="ts">
  import Modal from '../Modal.svelte';
  import { engine, type ScreenSource } from '../../engine';
  import { voice, SHARE_RES, SHARE_FPS } from '../../state/voice.svelte';

  let { onclose }: { onclose: () => void } = $props();

  let sources = $state<ScreenSource[]>([]);
  let sourceId = $state('');
  let res = $state('720');
  let fps = $state(30);
  let pending = $state(false);

  const screens = $derived(sources.filter((s) => s.kind === 'screen'));
  const windows = $derived(sources.filter((s) => s.kind === 'window'));

  $effect(() => {
    void engine.screenSources().then((list) => {
      sources = list;
      if (!sourceId && list.length) sourceId = list[0].id;
    });
  });

  async function submit(e: Event): Promise<void> {
    e.preventDefault();
    if (!sourceId || pending || voice.shareDisabled) return;
    pending = true;
    const { width, height } = SHARE_RES[res];
    await voice.shareStart(sourceId, width, height, fps);
    pending = false;
    if (voice.sharing) onclose();
  }
</script>

<Modal title="Share your screen" {onclose}>
  <form class="dialog-body" onsubmit={submit}>
    <label>
      Source
      <select bind:value={sourceId} aria-label="Source">
        {#if screens.length}
          <optgroup label="Screens">
            {#each screens as s (s.id)}
              <option value={s.id}>{s.name}</option>
            {/each}
          </optgroup>
        {/if}
        {#if windows.length}
          <optgroup label="Windows">
            {#each windows as s (s.id)}
              <option value={s.id}>{s.name}</option>
            {/each}
          </optgroup>
        {/if}
      </select>
    </label>
    <label>
      Resolution
      <select bind:value={res} aria-label="Resolution">
        {#each Object.keys(SHARE_RES) as r (r)}
          <option value={r}>{r === 'native' ? 'Native' : `${r}p`}</option>
        {/each}
      </select>
    </label>
    <label>
      Frame rate
      <select bind:value={fps} aria-label="Frame rate">
        {#each SHARE_FPS as f (f)}
          <option value={f}>{f} fps</option>
        {/each}
      </select>
    </label>
    {#if voice.shareDisabled}
      <span class="err" role="alert">Share limit reached — 3 screens are already shared here.</span>
    {/if}
    {#if voice.error}<span class="err" role="alert">{voice.error}</span>{/if}
    <button
      class="primary"
      type="submit"
      data-testid="share-start"
      disabled={!sourceId || pending || voice.shareDisabled}
    >
      Start sharing
    </button>
  </form>
</Modal>
