<script lang="ts">
  import type { CriticScore } from '../lib/db';
  import { scoreText } from '../lib/taste';

  /**
   * What others thought, closed until you ask: it is your own reaction Parde learns from, so it only notes whether
   * these were open when you chose. Open from the start once there is nothing left to influence.
   */
  let { critics, open = false, onsee }: { critics: CriticScore[]; open?: boolean; onsee?: () => void } = $props();
  let shown = $state(false);
</script>

{#if critics.length}
  <details open={open || shown} ontoggle={(e) => { if (e.currentTarget.open && !open && !shown) { shown = true; onsee?.(); } }}>
    <summary>What others thought</summary>
    <ul class="small">
      {#each critics as c (c.source)}
        <li>{scoreText(c)}{#if c.asOf}<span class="muted">, as of {c.asOf.slice(0, 4)}</span>{/if}</li>
      {/each}
    </ul>
    <p class="small muted">{critics.some((c) => c.source !== 'TVmaze') ? 'From Wikidata, which can lag the live sites and rarely has audience scores.' : 'From TVmaze.'} Different scales: not comparable with each other.</p>
  </details>
{/if}

<style>
  summary { cursor: pointer; color: var(--muted); font-size: 0.9rem; min-height: 36px; display: flex; align-items: center; gap: 0.35rem; }
  summary::before { content: '▸'; }
  details[open] summary::before { content: '▾'; }
  summary::-webkit-details-marker { display: none; }
  ul { margin: 0.1rem 0 0.4rem; padding-left: 1.1rem; }
  ul li::first-letter { text-transform: uppercase; }
  p { margin: 0; }
</style>
