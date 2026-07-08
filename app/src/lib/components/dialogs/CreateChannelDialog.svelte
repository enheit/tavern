<script lang="ts">
  import Modal from '../Modal.svelte';
  import { entityNameError } from '../../validate';
  import { createChannel } from '../../actions';
  import { ApiError } from '../../api';

  let { serverId, onclose }: { serverId: string; onclose: () => void } = $props();

  let name = $state('');
  let kind = $state<'text' | 'voice'>('text');
  let password = $state('');
  let error = $state<string | null>(null);
  let pending = $state(false);

  const nameErr = $derived(name === '' ? null : entityNameError(name));
  const canSubmit = $derived(entityNameError(name) === null);

  async function submit(e: Event): Promise<void> {
    e.preventDefault();
    if (!canSubmit || pending) return;
    pending = true;
    error = null;
    try {
      await createChannel(serverId, name, kind, password || undefined);
      onclose();
    } catch (err) {
      error = err instanceof ApiError ? err.code : 'error';
    } finally {
      pending = false;
    }
  }
</script>

<Modal title="Create channel" {onclose}>
  <form class="dialog-body" onsubmit={submit}>
    <label>Name <input bind:value={name} aria-label="Name" /></label>
    {#if nameErr}<span class="err" role="alert">{nameErr}</span>{/if}
    <label>
      Type
      <select bind:value={kind} aria-label="Type">
        <option value="text">Text</option>
        <option value="voice">Voice</option>
      </select>
    </label>
    <label>Password (optional) <input type="password" bind:value={password} aria-label="Password" /></label>
    {#if error}<span class="err" role="alert">{error}</span>{/if}
    <button class="primary" type="submit" data-testid="submit" disabled={!canSubmit || pending}>Create</button>
  </form>
</Modal>
