<script lang="ts">
  import { auth } from './lib/state/auth.svelte';
  import { runtime, isLinux } from './lib/state/runtime.svelte';
  import Onboarding from './lib/screens/Onboarding.svelte';
  import Main from './lib/screens/Main.svelte';
  import Modal from './lib/components/Modal.svelte';
</script>

{#if !runtime.webcodecsOk}
  <!-- S6.3 §1: WebCodecs VideoDecoder is the video path — blocking error screen. -->
  <div class="fatal" data-testid="webcodecs-error">
    <h1>Tavern can’t run here</h1>
    {#if isLinux()}
      <p>Tavern requires WebKitGTK ≥ 2.46 (WebCodecs VideoDecoder is missing).</p>
    {:else}
      <p>This system’s webview lacks WebCodecs (VideoDecoder), which Tavern requires for video.</p>
    {/if}
  </div>
{:else if auth.authed}
  <Main />
{:else}
  <Onboarding />
{/if}

{#if runtime.captureError}
  <Modal title="Screen capture unavailable" onclose={() => runtime.dismissCaptureError()}>
    <p data-testid="capture-error">{runtime.captureError}</p>
    <p>Voice and chat still work; screen sharing is disabled until this is fixed.</p>
  </Modal>
{/if}

<style>
  .fatal {
    height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    text-align: center;
    padding: 1rem;
  }
</style>
