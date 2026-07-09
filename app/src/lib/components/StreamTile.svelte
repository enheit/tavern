<script lang="ts">
  import { engine, inTauri } from '../engine';
  import { voice, VoiceStore } from '../state/voice.svelte';
  import { servers } from '../state/servers.svelte';
  import type { TrackInfo } from '../protocol/TrackInfo';

  let { track }: { track: TrackInfo } = $props();

  const key = $derived(VoiceStore.tileKey(track));
  const joined = $derived(key in voice.watched);
  const pinnedHere = $derived(voice.pinned === key);
  const nick = $derived(
    voice.serverId
      ? ((servers.rosterByServer[voice.serverId] ?? []).find((m) => m.userId === track.ownerId)
          ?.nickname ?? track.ownerId)
      : track.ownerId,
  );

  // Desktop renders decoded chunks on a canvas; the web build (S7) attaches the
  // watch PeerConnection's MediaStream to a <video> — same tile, same controls.
  const desktop = inTauri();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let video = $state<HTMLVideoElement | null>(null);
  let fps = $state(0); // decoded frames in the last second (P5 per-tile measure)

  // Web watch effect: startStream resolves once the remote track arrived, then the
  // stream is live in engine.streamMedia. rVFC counts decoded frames for data-fps.
  $effect(() => {
    if (desktop || !joined || !video) return;
    const layer = voice.watched[key] ?? 'l';
    const el = video;
    let closed = false;
    let frames = 0;
    let rvfc = 0;
    const fpsTimer = setInterval(() => {
      fps = frames;
      frames = 0;
    }, 1000);
    const count = () => {
      frames += 1;
      rvfc = el.requestVideoFrameCallback(count);
    };
    void voice.startStream(track, layer, () => {}).then(() => {
      if (closed) return;
      const ms = engine.streamMedia(track.ownerId, track.trackName);
      if (ms) {
        el.srcObject = ms;
        void el.play().catch(() => {});
        rvfc = el.requestVideoFrameCallback(count);
      }
    });
    return () => {
      closed = true;
      clearInterval(fpsTimer);
      fps = 0;
      el.cancelVideoFrameCallback(rvfc);
      el.srcObject = null;
      void voice.stopStream(track);
    };
  });

  // One watch session per (joined, layer): pin swaps flip the layer → the effect re-runs,
  // which is exactly §1's "layer change = unwatch then watch" (cleanup → stopStream, then
  // startStream at the new layer; brief tile blank acceptable).
  $effect(() => {
    if (!desktop || !joined || !canvas) return;
    const layer = voice.watched[key] ?? 'l';
    const ctx = canvas.getContext('2d');
    let closed = false;
    let frames = 0;
    // §1 codec decision: VP8, plain codec string, no description (S1.5).
    const decoder = new VideoDecoder({
      output: (frame) => {
        if (canvas && !closed) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
          ctx?.drawImage(frame, 0, 0);
          frames += 1;
        }
        frame.close();
      },
      error: () => {},
    });
    decoder.configure({ codec: 'vp8' });
    const fpsTimer = setInterval(() => {
      fps = frames;
      frames = 0;
    }, 1000);

    // §1 chunk: {u32 len | u8 keyframe | u64 ptsMs | bytes}, little-endian; first chunk is
    // guaranteed keyframe (engine drops until then).
    void voice.startStream(track, layer, (buf) => {
      if (closed || decoder.state !== 'configured') return;
      const view = new DataView(buf);
      const len = view.getUint32(0, true);
      const keyframe = view.getUint8(4) === 1;
      const ptsMs = Number(view.getBigUint64(5, true));
      decoder.decode(
        new EncodedVideoChunk({
          type: keyframe ? 'key' : 'delta',
          timestamp: ptsMs * 1000,
          data: new Uint8Array(buf, 13, len),
        }),
      );
    });

    return () => {
      closed = true;
      clearInterval(fpsTimer);
      fps = 0;
      try {
        decoder.close();
      } catch {
        // already closed
      }
      void voice.stopStream(track);
    };
  });
</script>

<div class="tile" data-testid={`tile-${key}`} data-fps={fps}>
  <header class="bar">
    <span class="label">{track.kind === 'screen' ? '🖥️' : '📷'} {nick}</span>
    <span class="ctls">
      {#if joined}
        <button
          class="ctl"
          class:on={pinnedHere}
          aria-pressed={pinnedHere}
          aria-label={`Pin ${nick}`}
          disabled={!track.simulcast || voice.budgetLevel !== 'ok'}
          title={!track.simulcast
            ? 'Single-quality stream'
            : voice.budgetLevel !== 'ok'
              ? 'Egress budget limited — high quality disabled'
              : 'Pin for high quality'}
          onclick={() => voice.togglePin(track)}
        >
          📌
        </button>
        <button class="ctl" onclick={() => voice.leaveStream(track)}>Leave</button>
      {:else}
        <button
          class="ctl"
          disabled={voice.budgetLevel === 'hard'}
          title={voice.budgetLevel === 'hard'
            ? 'Egress budget exhausted — watching disabled until next month'
            : undefined}
          onclick={() => voice.joinStream(track)}
        >
          Join Stream
        </button>
      {/if}
    </span>
  </header>
  {#if joined}
    {#if desktop}
      <canvas data-testid={`canvas-${key}`} bind:this={canvas}></canvas>
    {:else}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video data-testid={`video-${key}`} bind:this={video} autoplay playsinline muted></video>
    {/if}
  {/if}
</div>

<style>
  .tile {
    display: flex;
    flex-direction: column;
    border: 1px solid color-mix(in srgb, var(--muted) 30%, transparent);
    border-radius: 8px;
    overflow: hidden;
    background: color-mix(in srgb, var(--muted) 8%, transparent);
  }

  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem;
    padding: 0.3rem 0.5rem;
    font-size: 0.8rem;
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ctls {
    display: flex;
    gap: 0.3rem;
  }

  .ctl {
    padding: 0.15rem 0.45rem;
    border: 1px solid color-mix(in srgb, var(--muted) 40%, transparent);
    border-radius: 5px;
    background: transparent;
    color: var(--fg);
    cursor: pointer;
    font-size: 0.75rem;
  }

  .ctl.on {
    background: var(--accent);
    border-color: var(--accent);
  }

  .ctl:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  canvas,
  video {
    width: 100%;
    display: block;
    background: #000;
    aspect-ratio: 16 / 9;
    object-fit: contain;
  }
</style>
