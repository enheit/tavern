<script lang="ts">
  import Modal from '../Modal.svelte';
  import { auth } from '../../state/auth.svelte';
  import { nicknameError, colorError } from '../../validate';
  import { saveProfile, uploadAvatar, logout, AVATAR_MAX, AVATAR_TYPES } from '../../actions';
  import { ApiError } from '../../api';

  let { onclose }: { onclose: () => void } = $props();

  let nickname = $state(auth.profile?.nickname ?? '');
  let color = $state(auth.profile?.color ?? '#8a8f98');
  let avatarFile = $state<File | null>(null);
  let avatarErr = $state<string | null>(null);
  let error = $state<string | null>(null);
  let pending = $state(false);

  const nickErr = $derived(nicknameError(nickname));
  const colErr = $derived(colorError(color));
  const canSave = $derived(nickErr === null && colErr === null && avatarErr === null);

  function onFile(e: Event): void {
    const f = (e.target as HTMLInputElement).files?.[0] ?? null;
    avatarErr = null;
    if (f && !AVATAR_TYPES.includes(f.type)) {
      avatarErr = 'PNG, JPEG, or WebP only';
      avatarFile = null;
      return;
    }
    if (f && f.size > AVATAR_MAX) {
      avatarErr = 'Image must be ≤ 512 KB';
      avatarFile = null;
      return;
    }
    avatarFile = f;
  }

  async function save(e: Event): Promise<void> {
    e.preventDefault();
    if (!canSave || pending) return;
    pending = true;
    error = null;
    try {
      const patch: { nickname?: string; color?: string } = {};
      if (nickname !== auth.profile?.nickname) patch.nickname = nickname;
      if (color !== auth.profile?.color) patch.color = color;
      if (patch.nickname !== undefined || patch.color !== undefined) await saveProfile(patch);
      if (avatarFile) await uploadAvatar(avatarFile);
      onclose();
    } catch (err) {
      error = err instanceof ApiError ? err.code : err instanceof Error ? err.message : 'error';
    } finally {
      pending = false;
    }
  }

  async function doLogout(): Promise<void> {
    await logout();
    onclose();
  }
</script>

<Modal title="Settings" {onclose}>
  <form class="dialog-body" onsubmit={save}>
    <label>Nickname <input bind:value={nickname} aria-label="Nickname" /></label>
    {#if nickErr}<span class="err" role="alert">{nickErr}</span>{/if}
    <label>Color <input bind:value={color} aria-label="Color" /></label>
    {#if colErr}<span class="err" role="alert">{colErr}</span>{/if}
    <label>
      Avatar
      <input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Avatar" onchange={onFile} />
    </label>
    {#if avatarErr}<span class="err" role="alert">{avatarErr}</span>{/if}
    {#if error}<span class="err" role="alert">{error}</span>{/if}
    <button class="primary" type="submit" data-testid="save" disabled={!canSave || pending}>Save</button>
    <button class="danger" type="button" data-testid="logout" onclick={doLogout}>Log out</button>
  </form>
</Modal>
