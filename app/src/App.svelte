<script lang="ts">
  let count = $state(0);
</script>

<main>
  <h1>Tavern</h1>
  <button onclick={() => count++}>count: {count}</button>
</main>
