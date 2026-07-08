<script lang="ts">
  import Modal from '../Modal.svelte';
  import { unlockChannel } from '../../actions';
  import { ApiError } from '../../api';

  let { channelId, channelName, onclose }: { channelId: string; channelName: string; onclose: () => void } =
    $props();

  let password = $state('');
  let error = $state<string | null>(null);
  let pending = $state(false);

  async function submit(e: Event): Promise<void> {
    e.preventDefault();
    if (pending || password === '') return;
    pending = true;
    error = null;
    try {
      await unlockChannel(channelId, password);
      onclose();
    } catch (err) {
      if (err instanceof ApiError) {
        error = err.status === 429 ? 'Too many attempts — wait a minute' : 'Wrong password';
      } else {
        error = 'error';
      }
    } finally {
      pending = false;
    }
  }
</script>

<Modal title={`Unlock #${channelName}`} {onclose}>
  <form class="dialog-body" onsubmit={submit}>
    <label>Password <input type="password" bind:value={password} aria-label="Password" /></label>
    {#if error}<span class="err" role="alert">{error}</span>{/if}
    <button class="primary" type="submit" data-testid="submit" disabled={pending || password === ''}>Unlock</button>
  </form>
</Modal>
