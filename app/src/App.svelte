<script lang="ts">
  let count = $state(0);
</script>

<main>
  <h1>Tavern</h1>
  <p>Desktop shell online. Theme follows the OS.</p>
  <button onclick={() => count++}>count: {count}</button>
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    gap: 0.75rem;
  }

  h1 {
    margin: 0;
    color: var(--accent);
  }

  p {
    margin: 0;
    color: var(--muted);
  }

  button {
    padding: 0.4rem 0.9rem;
    border: 1px solid var(--muted);
    border-radius: 6px;
    background: transparent;
    color: var(--fg);
    cursor: pointer;
  }
</style>
