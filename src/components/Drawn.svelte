<script lang="ts">
  import { update } from '../lib/actions';
  import { REASONS } from '../lib/discover';

  let { id, value = [] }: { id: string; value?: string[] } = $props();
  const toggle = (k: string) => update(id, { drawn: value.includes(k) ? value.filter((x) => x !== k) : [...value, k] });
</script>

<div class="row chips" role="group" aria-label="What drew you">
  {#each REASONS as k}
    <button type="button" class="chip" class:on={value.includes(k)} aria-pressed={value.includes(k)} onclick={() => toggle(k)}>{k}</button>
  {/each}
</div>

<style>
  .chips { gap: 0.35rem; }
</style>
