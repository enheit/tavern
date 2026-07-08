<script lang="ts">
  import Modal from '../Modal.svelte';
  import { joinServer } from '../../actions';
  import { ApiError } from '../../api';

  let { onclose }: { onclose: () => void } = $props();

  let serverId = $state('');
  let password = $state('');
  let error = $state<string | null>(null);
  let pending = $state(false);

  const canSubmit = $derived(serverId.trim().length > 0);

  async function submit(e: Event): Promise<void> {
    e.preventDefault();
    if (!canSubmit || pending) return;
    pending = true;
    error = null;
    try {
      await joinServer(serverId, password || undefined);
      onclose();
    } catch (err) {
      if (err instanceof ApiError) {
        error = err.status === 403 ? 'Wrong password' : err.status === 404 ? 'Server not found' : err.code;
      } else {
        error = 'error';
      }
    } finally {
      pending = false;
    }
  }
</script>

<Modal title="Join server" {onclose}>
  <form class="dialog-body" onsubmit={submit}>
    <label>Server ID <input bind:value={serverId} aria-label="Server ID" /></label>
    <label>Password (optional) <input type="password" bind:value={password} aria-label="Password" /></label>
    {#if error}<span class="err" role="alert">{error}</span>{/if}
    <button class="primary" type="submit" data-testid="submit" disabled={!canSubmit || pending}>Join</button>
  </form>
</Modal>
