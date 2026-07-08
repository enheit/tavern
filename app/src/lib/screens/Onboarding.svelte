<script lang="ts">
  import { auth } from '../state/auth.svelte';
  import { nicknameError, passwordError } from '../validate';

  let mode = $state<'login' | 'register'>('register');
  let nickname = $state('');
  let password = $state('');
  let repeat = $state('');

  // Errors only show once a field has been typed into.
  const nickErr = $derived(nickname === '' ? null : nicknameError(nickname));
  const pwErr = $derived(password === '' ? null : passwordError(password));
  const repeatErr = $derived(
    mode === 'register' && repeat !== '' && repeat !== password ? 'Passwords do not match' : null,
  );

  const canSubmit = $derived(
    nicknameError(nickname) === null &&
      passwordError(password) === null &&
      (mode === 'login' || repeat === password),
  );

  async function submit(e: Event): Promise<void> {
    e.preventDefault();
    if (!canSubmit || auth.pending) return;
    if (mode === 'register') await auth.register(nickname, password, repeat);
    else await auth.login(nickname, password);
  }

  function switchMode(m: 'login' | 'register'): void {
    mode = m;
    auth.error = null;
  }
</script>

<main class="onboarding">
  <h1>Tavern</h1>

  <div class="tabs">
    <button class:active={mode === 'register'} onclick={() => switchMode('register')}>
      Create account
    </button>
    <button class:active={mode === 'login'} onclick={() => switchMode('login')}>Log in</button>
  </div>

  <form onsubmit={submit}>
    <label>
      Nickname
      <input bind:value={nickname} autocomplete="off" />
    </label>
    {#if nickErr}<span class="err" role="alert">{nickErr}</span>{/if}

    <label>
      Password
      <input type="password" bind:value={password} autocomplete="off" />
    </label>
    {#if pwErr}<span class="err" role="alert">{pwErr}</span>{/if}

    {#if mode === 'register'}
      <label>
        Repeat password
        <input type="password" bind:value={repeat} autocomplete="off" />
      </label>
      {#if repeatErr}<span class="err" role="alert">{repeatErr}</span>{/if}
    {/if}

    {#if auth.error}<span class="err" role="alert">{auth.error}</span>{/if}

    <button class="submit" type="submit" data-testid="submit" disabled={!canSubmit || auth.pending}>
      {mode === 'register' ? 'Create account' : 'Log in'}
    </button>
  </form>
</main>

<style>
  .onboarding {
    max-width: 340px;
    margin: 0 auto;
    padding: 3rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  h1 {
    text-align: center;
    color: var(--accent);
    margin: 0 0 0.5rem;
  }

  .tabs {
    display: flex;
    gap: 0.5rem;
  }

  .tabs button {
    flex: 1;
    padding: 0.4rem;
    border: 1px solid color-mix(in srgb, var(--muted) 40%, transparent);
    border-radius: 6px;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
  }

  .tabs button.active {
    color: var(--fg);
    border-color: var(--accent);
  }

  form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.85rem;
    color: var(--muted);
  }

  input {
    padding: 0.5rem;
    border: 1px solid color-mix(in srgb, var(--muted) 40%, transparent);
    border-radius: 6px;
    background: transparent;
    color: var(--fg);
  }

  .err {
    color: #e5534b;
    font-size: 0.8rem;
  }

  .submit {
    margin-top: 0.5rem;
    padding: 0.55rem;
    border: none;
    border-radius: 6px;
    background: var(--accent);
    color: #fff;
    cursor: pointer;
  }

  .submit:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
