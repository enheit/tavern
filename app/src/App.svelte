<script lang="ts">
  import { auth } from './lib/state/auth.svelte';
  import Onboarding from './lib/screens/Onboarding.svelte';
  import Main from './lib/screens/Main.svelte';
</script>

{#if auth.authed}
  <Main />
{:else}
  <Onboarding />
{/if}
