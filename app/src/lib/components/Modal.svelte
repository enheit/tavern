<script lang="ts">
  import type { Snippet } from 'svelte';

  let { title, onclose, children }: { title: string; onclose: () => void; children: Snippet } = $props();
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<div class="overlay">
  <!-- Backdrop is a real button so it's keyboard-dismissable (no a11y warning). -->
  <button class="backdrop" aria-label="Close" onclick={onclose}></button>
  <div class="card" role="dialog" aria-modal="true" aria-label={title}>
    <header>
      <h2>{title}</h2>
      <button class="x" aria-label="Close" onclick={onclose}>×</button>
    </header>
    {@render children()}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    z-index: 100;
  }

  .backdrop {
    position: absolute;
    inset: 0;
    border: none;
    background: rgba(0, 0, 0, 0.5);
    cursor: pointer;
  }

  .card {
    position: relative;
    width: min(360px, 90vw);
    background: var(--bg);
    color: var(--fg);
    border: 1px solid color-mix(in srgb, var(--muted) 30%, transparent);
    border-radius: 10px;
    padding: 1rem;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.75rem;
  }

  h2 {
    margin: 0;
    font-size: 1.05rem;
  }

  .x {
    border: none;
    background: transparent;
    color: var(--muted);
    font-size: 1.3rem;
    line-height: 1;
    cursor: pointer;
  }
</style>
