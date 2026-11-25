<script lang="ts">
  import type { Episode, Link, Title } from '../lib/db';
  import { code, isAired, isListed, localDay, localTime } from '../lib/schedule';
  import { setSeen, seenUpTo, setSeasonSeen, type Undo } from '../lib/actions';
  import { formatDay } from '../lib/format';
  import { toast, undoable, errorText } from '../lib/ui.svelte';
  import Sources from './Sources.svelte';

  let { title, episodes, seen, links, focus }: { title: Title; episodes: Episode[]; seen: Set<number>; links: Link[]; focus?: Episode } = $props();

  const listed = $derived(episodes.filter((e) => isListed(e, seen)));
  const seasons = $derived(
    [...new Set(listed.map((e) => e.season))].map((s) => ({ s, eps: listed.filter((e) => e.season === s) })),
  );
  /** Many marks at once: always undoable, and never said to be done before it is. */
  async function bulk(text: string, act: () => Promise<Undo>) {
    try {
      undoable(text, await act());
    } catch (e) {
      toast(`Not saved: ${errorText(e)}`, 'error');
    }
  }
  async function check(e: Episode, box: HTMLInputElement) {
    try {
      await setSeen(e, box.checked);
    } catch (err) {
      box.checked = !box.checked; // show what is stored, not what was tapped
      toast(`Not saved: ${errorText(err)}`, 'error');
    }
  }
  // The season you are in opens by itself until you open or close one yourself.
  let chosen = $state<Set<number> | null>(null);
  const openSeasons = $derived(chosen ?? new Set<number>(focus ? [focus.season] : seasons.length === 1 ? [seasons[0].s] : []));
  let expanded = $state<number | null>(null);
  let revealed = $state(new Set<number>());

  const toggle = (s: number) => {
    const n = new Set(openSeasons);
    if (n.has(s)) n.delete(s);
    else n.add(s);
    chosen = n;
  };
</script>

<div class="seasons">
  {#each seasons as { s, eps } (s)}
    {@const done = eps.filter((e) => seen.has(e.id)).length}
    <section>
      <div class="season-head">
        <button class="ghost head" onclick={() => toggle(s)} aria-expanded={openSeasons.has(s)}>
          <span class="chev" aria-hidden="true">{openSeasons.has(s) ? '▾' : '▸'}</span>
          <strong>Season {s}</strong>
          <span class="muted small">{done}/{eps.length} seen</span>
        </button>
        {#if openSeasons.has(s)}
          {#if eps.some((e) => !seen.has(e.id) && isAired(e))}
            <button class="small ghost" onclick={() => bulk(`Season ${s} marked seen`, () => setSeasonSeen(title.id, s, true))}>Mark {eps.every((e) => isAired(e)) ? 'season' : 'all out so far'} seen</button>
          {:else if done}
            <button class="small ghost" onclick={() => bulk(`Season ${s} unmarked`, () => setSeasonSeen(title.id, s, false))}>Unmark season</button>
          {/if}
        {/if}
      </div>
      {#if openSeasons.has(s)}
        <ol>
          {#each eps as e (e.id)}
            {@const on = seen.has(e.id)}
            {@const aired = isAired(e)}
            <li class:on class:next={focus?.id === e.id}>
              <div class="ep">
                <input type="checkbox" checked={on} onchange={(ev) => check(e, ev.currentTarget)} aria-label="Seen {code(e)}" />
                <button class="ghost line" onclick={() => (expanded = expanded === e.id ? null : e.id)} aria-expanded={expanded === e.id}>
                  <span class="code">{code(e)}</span>
                  <span class="name">{e.name}</span>
                  <span class="muted small when">
                    {#if e.airdate}{aired ? '' : 'Coming '}{formatDay(localDay(e))}{localTime(e) && !aired ? ` · ${localTime(e)}` : ''}{:else}Date to be announced{/if}{#if e.missingSince} · no longer listed{/if}
                  </span>
                </button>
              </div>
              {#if expanded === e.id}
                <div class="detail stack">
                  {#if e.summary}
                    {#if on || revealed.has(e.id)}
                      <p class="small">{e.summary}</p>
                    {:else}
                      <button class="small ghost" onclick={() => (revealed = new Set([...revealed, e.id]))}>Show summary (may spoil)</button>
                    {/if}
                  {/if}
                  {#if !on && aired}
                    <button class="small" onclick={() => bulk(`Seen up to ${code(e)}`, () => seenUpTo(e))}>Seen everything up to here</button>
                  {/if}
                  <Sources {title} {links} season={e.season} episode={e.number} heading="Sources for {code(e)}" />
                </div>
              {/if}
            </li>
          {/each}
        </ol>
      {/if}
    </section>
  {/each}
</div>

<style>
  .seasons { display: grid; gap: 0.5rem; }
  section { border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
  .season-head { display: flex; justify-content: space-between; align-items: center; padding: 0.25rem 0.5rem; flex-wrap: wrap; }
  .head { gap: 0.6rem; }
  .chev { width: 1em; }
  ol { list-style: none; margin: 0; padding: 0 0.5rem 0.5rem; }
  li { border-top: 1px solid var(--line); }
  li.next { background: color-mix(in srgb, var(--accent) 10%, transparent); border-radius: 8px; }
  .ep { display: flex; align-items: center; gap: 0.25rem; }
  input[type='checkbox'] { margin: 0 0.5rem; }
  .line { flex: 1; justify-content: flex-start; gap: 0.6rem; min-width: 0; border-radius: 8px; white-space: normal; text-align: left; flex-wrap: wrap; }
  .code { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 0.85rem; }
  li.on .name { color: var(--muted); }
  .when { margin-left: auto; }
  .detail { padding: 0.25rem 0.5rem 0.75rem 2.75rem; }
  @media (max-width: 520px) { .detail { padding-left: 0.5rem; } }
</style>
