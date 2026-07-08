<script lang="ts">
  import Modal from '../Modal.svelte';
  import { engine, type WebcamDevice } from '../../engine';
  import { voice, CAM_RES, CAM_FPS } from '../../state/voice.svelte';

  let { onclose }: { onclose: () => void } = $props();

  let devices = $state<WebcamDevice[]>([]);
  let deviceId = $state('');
  let res = $state('720');
  let fps = $state(30);
  let pending = $state(false);

  $effect(() => {
    void engine.webcamList().then((list) => {
      devices = list;
      if (!deviceId && list.length) deviceId = list[0].id;
    });
  });

  async function submit(e: Event): Promise<void> {
    e.preventDefault();
    if (!deviceId || pending) return;
    pending = true;
    const { width, height } = CAM_RES[res];
    await voice.camStart(deviceId, width, height, fps);
    pending = false;
    if (voice.camera) onclose();
  }
</script>

<Modal title="Turn on webcam" {onclose}>
  <form class="dialog-body" onsubmit={submit}>
    <label>
      Camera
      <select bind:value={deviceId} aria-label="Camera">
        {#each devices as d (d.id)}
          <option value={d.id}>{d.name}</option>
        {/each}
      </select>
    </label>
    <label>
      Resolution
      <select bind:value={res} aria-label="Webcam resolution">
        {#each Object.keys(CAM_RES) as r (r)}
          <option value={r}>{r}p</option>
        {/each}
      </select>
    </label>
    <label>
      Frame rate
      <select bind:value={fps} aria-label="Webcam frame rate">
        {#each CAM_FPS as f (f)}
          <option value={f}>{f} fps</option>
        {/each}
      </select>
    </label>
    {#if voice.error}<span class="err" role="alert">{voice.error}</span>{/if}
    <button class="primary" type="submit" data-testid="cam-start" disabled={!deviceId || pending}>
      Turn on
    </button>
  </form>
</Modal>
