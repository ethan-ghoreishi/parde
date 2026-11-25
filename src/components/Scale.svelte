<script lang="ts">
  import { toast, errorText } from '../lib/ui.svelte';
  let {
    max,
    value,
    labels,
    onpick,
    compact = false,
    name = 'Rating',
  }: { max: number; value?: number; labels?: readonly string[]; onpick: (v: number | undefined) => unknown; compact?: boolean; name?: string } = $props();
</script>

<div class="scale" class:words={!!labels && !compact} style="--n: {max}" role="group" aria-label={name}>
  {#each Array.from({ length: max }, (_, i) => i + 1) as n}
    <button
      type="button"
      class:on={value === n}
      aria-pressed={value === n}
      title={labels?.[n]}
      onclick={async () => {
        try { await onpick(value === n ? undefined : n); }
        catch (e) { toast(`Could not save. ${errorText(e)}`, 'error'); }
      }}
    >{labels && !compact ? labels[n] : n}</button>
  {/each}
</div>
{#if labels && compact && value}<span class="small muted">{labels[value]}</span>{/if}
