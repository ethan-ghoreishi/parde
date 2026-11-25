<script lang="ts">
  import { changeDrawn } from '../lib/actions';
  import { REASONS } from '../lib/discover';

  let { id, value = [] }: { id: string; value?: string[] } = $props();
  import { toast, errorText } from '../lib/ui.svelte';
  const toggle = (k: string) => changeDrawn(id, k).catch((e) => toast(errorText(e), 'error'));
</script>

<div class="row chips" role="group" aria-label="What drew you">
  {#each REASONS as k}
    <button type="button" class="chip" class:on={value.includes(k)} aria-pressed={value.includes(k)} onclick={() => toggle(k)}>{k}</button>
  {/each}
</div>

<style>
  .chips { gap: 0.35rem; }
</style>
