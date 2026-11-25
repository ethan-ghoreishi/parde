<script lang="ts">
  import { db, type Title } from '../lib/db';
  import { live } from '../lib/live.svelte';
  import { changeThemes } from '../lib/actions';
  import { parseThemes } from '../lib/handoff';
  import { counts } from '../lib/taste';

  /**
   * "What was it about for you?" as a few taps. Suggestions come from Wikidata's subjects for this
   * title, the words you have used before, and a short starter list; your own words always work too.
   */
  /**
   * Saves each tap straight away, unless `onchange` is given: then the caller holds the draft (the log
   * dialog saves it only on Save, so Cancel really cancels).
   */
  let { title, compact = false, value, onchange }: { title: Title; compact?: boolean; value?: string[]; onchange?: (themes: string[]) => void } = $props();
  const uid = $props.id();

  const STARTERS = [
    'identity', 'memory', 'grief', 'love', 'loneliness', 'family', 'power', 'class', 'freedom', 'faith',
    'guilt', 'justice', 'mortality', 'time', 'truth', 'ambition', 'belonging', 'violence', 'technology', 'childhood',
  ];

  const used = live(() => () => db.titles.toArray().then((ts) => counts(ts.flatMap((t) => t.themes ?? []), 12).map(([k]) => k)), [] as string[]);
  const chosen = $derived(value ?? title.themes ?? []);
  const suggestions = $derived(
    [...new Set([...title.subjects.map((s) => s.toLowerCase()).filter((s) => s.length <= 30).slice(0, 5), ...used.value, ...STARTERS])]
      .filter((x) => !chosen.includes(x))
      .slice(0, compact ? 8 : 12),
  );
  let custom = $state('');

  const change = (f: (themes: string[]) => string[]) => (onchange ? onchange(f(chosen)) : changeThemes(title.id, f));
  const toggle = (k: string) => change((ts) => (ts.includes(k) ? ts.filter((x) => x !== k) : [...ts, k]));
  function addCustom() {
    const more = parseThemes(custom);
    if (more.length) change((ts) => [...new Set([...ts, ...more])]);
    custom = '';
  }
</script>

<div class="themes" role="group" aria-label="Themes">
  <div class="row chips">
    {#each chosen as k (k)}<button type="button" class="chip on" aria-pressed="true" onclick={() => toggle(k)}>{k}</button>{/each}
    {#each suggestions as k (k)}<button type="button" class="chip" aria-pressed="false" onclick={() => toggle(k)}>{k}</button>{/each}
  </div>
  <!-- Not a <form>: this sits inside the log-a-viewing form, and forms cannot nest. -->
  <div class="row add">
    <label class="sr-only" for="theme-{uid}">Your own theme</label>
    <input id="theme-{uid}" type="text" bind:value={custom} placeholder="Your own word, or paste “Themes: a; b”" autocomplete="off" enterkeyhint="done" onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } }} />
    <button type="button" class="small" disabled={!custom.trim()} onclick={addCustom}>Add</button>
  </div>
</div>

<style>
  .themes { display: grid; gap: 0.5rem; }
  .chips { gap: 0.35rem; }
  .add input { flex: 1; width: auto; min-height: 36px; }
</style>
