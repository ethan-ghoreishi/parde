<script lang="ts">
  import { db, now, type Episode, type Link, type Title } from '../lib/db';
  import { live } from '../lib/live.svelte';
  import { code, dayKey, isAired, localDay, localTime, release, byOrder } from '../lib/schedule';
  import { resolveLinks, openExternal, hostOf } from '../lib/links';
  import { setSeen, editLink, syncShows } from '../lib/actions';
  import { route, go, titleHref } from '../lib/router.svelte';
  import { formatDay } from '../lib/format';
  import { toast, errorText } from '../lib/ui.svelte';
  import Poster from '../components/Poster.svelte';

  const data = live(
    () => async () => {
      const shows = (await db.titles.where('kind').equals('show').toArray()).filter((t) => t.followed);
      const ids = shows.map((t) => t.id);
      const [episodes, seen, links] = await Promise.all([
        db.episodes.where('titleId').anyOf(ids).toArray(),
        db.seen.where('titleId').anyOf(ids).primaryKeys(),
        db.links.where('titleId').anyOf(ids).toArray(),
      ]);
      return { shows, episodes, seen: new Set(seen), links };
    },
    { shows: [] as Title[], episodes: [] as Episode[], seen: new Set<number>(), links: [] as Link[] },
  );

  const today = dayKey(new Date());
  const selected = $derived(/^\d{4}-\d{2}-\d{2}$/.test(route.params.get('d') ?? '') ? route.params.get('d')! : today);
  const byDay = $derived.by(() => {
    const m = new Map<string, Episode[]>();
    for (const e of data.value.episodes) {
      const d = localDay(e);
      if (d) m.set(d, [...(m.get(d) ?? []), e]);
    }
    return m;
  });
  const showOf = $derived(new Map(data.value.shows.map((s) => [s.id, s])));

  /** Monday-start week around the selected day */
  const week = $derived.by(() => {
    const d = new Date(`${selected}T12:00:00`);
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return Array.from({ length: 7 }, (_, i) => {
      const x = new Date(monday);
      x.setDate(monday.getDate() + i);
      return x;
    });
  });

  const dayEps = $derived(
    (byDay.get(selected) ?? []).sort((a, b) => (localTime(a) ?? '').localeCompare(localTime(b) ?? '') || a.titleId.localeCompare(b.titleId) || byOrder(a, b)),
  );

  const nextDays = $derived(
    [...byDay.keys()].filter((d) => d > selected).sort().slice(0, 1)[0],
  );

  const shift = (days: number) => {
    const d = new Date(`${selected}T12:00:00`);
    d.setDate(d.getDate() + days);
    go(`/calendar?d=${dayKey(d)}`);
  };

  let syncing = $state(false);
  async function refresh() {
    syncing = true;
    try {
      const r = await syncShows(true);
      toast(r.failed ? `Updated ${r.refreshed}, ${r.failed} failed` : 'Schedules up to date', r.failed ? 'error' : 'ok');
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      syncing = false;
    }
  }

  async function open(e: Episode) {
    const src = resolveLinks(data.value.links.filter((l) => l.titleId === e.titleId), e.season, e.number).find((r) => !r.link.broken);
    if (!src) return go(titleHref(e.titleId).slice(1));
    if (openExternal(src.url)) await editLink(src.link.id, { usedAt: now() });
  }
</script>

<div class="spread">
  <h1>Calendar</h1>
  <button class="small" onclick={refresh} disabled={syncing}>{syncing ? 'Checking…' : 'Check for new episodes'}</button>
</div>

<div class="weeknav">
  <button class="icon" onclick={() => shift(-7)} aria-label="Previous week">‹</button>
  <ol class="week">
    {#each week as d}
      {@const k = dayKey(d)}
      {@const n = byDay.get(k)?.length ?? 0}
      <li>
        <a href="#/calendar?d={k}" class:sel={k === selected} class:today={k === today} aria-current={k === selected ? 'date' : undefined} aria-label="{formatDay(k)}{n ? `, ${n} episode${n > 1 ? 's' : ''}` : ''}">
          <span class="dow">{d.toLocaleDateString('en-GB', { weekday: 'short' })}</span>
          <span class="num">{d.getDate()}</span>
          <span class="dots" aria-hidden="true">{'•'.repeat(Math.min(n, 3))}</span>
        </a>
      </li>
    {/each}
  </ol>
  <button class="icon" onclick={() => shift(7)} aria-label="Next week">›</button>
</div>
<div class="row jump">
  <label for="jump" class="sr-only">Go to date</label>
  <input id="jump" type="date" value={selected} onchange={(e) => e.currentTarget.value && go(`/calendar?d=${e.currentTarget.value}`)} />
  {#if selected !== today}<a class="btn small" href="#/calendar">Today</a>{/if}
</div>

<section class="section" aria-live="polite">
  <h2>{formatDay(selected)}{formatDay(selected).length < 10 ? ` · ${new Date(`${selected}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}` : ''}</h2>
  {#if !data.value.shows.length && data.ready}
    <div class="empty">No series on your calendar yet. Add a series you watch and its episodes will show up here.</div>
  {:else if !dayEps.length}
    <div class="empty">
      Nothing from your series on this day.
      {#if nextDays}<a href="#/calendar?d={nextDays}">Next: {formatDay(nextDays)} →</a>{/if}
    </div>
  {:else}
    <ul class="eps">
      {#each dayEps as e (e.id)}
        {@const t = showOf.get(e.titleId)!}
        {@const r = release(t)}
        {@const on = data.value.seen.has(e.id)}
        {@const aired = isAired(e)}
        <li class="card" class:on>
          <a href={titleHref(t.id)} aria-label={t.name}><Poster src={t.poster} name={t.name} size="xs" /></a>
          <div class="info">
            <a class="name" href={titleHref(t.id)}>{t.name}</a>
            <div class="small"><strong>{code(e)}</strong> {e.name}</div>
            <div class="row small">
              {#if r.kind === 'stream'}
                <span class="chip stream" title="The streaming service's own release date">Released on {r.where}</span>
              {:else if r.kind === 'broadcast'}
                <span class="chip broadcast" title="Broadcast date. Streaming availability may differ.">Airs on {r.where}</span>
              {:else}
                <span class="chip">Release date</span>
              {/if}
              {#if localTime(e)}<span class="muted">{localTime(e)} your time</span>{/if}
            </div>
          </div>
          <div class="acts">
            <label class="seen"><input type="checkbox" checked={on} onchange={(ev) => setSeen(e, ev.currentTarget.checked)} /> Seen</label>
            {#if aired && !on}<button class="small" onclick={() => open(e)}>Watch ↗</button>{/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
  <p class="small muted note">
    <span class="chip stream">Released on</span> is a streaming service's own release date.
    <span class="chip broadcast">Airs on</span> is a TV broadcast date, converted to your time zone; it does not confirm when it reaches streaming sites.
    Schedule data from <a href="https://www.tvmaze.com" target="_blank" rel="noopener noreferrer">TVmaze</a> (CC BY-SA).
  </p>
</section>

<style>
  .weeknav { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem; }
  .week { list-style: none; display: grid; grid-template-columns: repeat(7, 1fr); gap: 0.3rem; padding: 0; margin: 0; flex: 1; }
  .week a { display: grid; justify-items: center; padding: 0.4rem 0; border-radius: 10px; text-decoration: none; color: var(--text); border: 1px solid transparent; min-height: 64px; }
  .week a.today .num { color: var(--accent); font-weight: 700; }
  .week a.sel { background: var(--surface-2); border-color: var(--line); }
  .dow { font-size: 0.75rem; color: var(--muted); }
  .num { font-size: 1.1rem; font-variant-numeric: tabular-nums; }
  .dots { color: var(--accent); font-size: 0.8rem; line-height: 1; height: 0.8rem; letter-spacing: 1px; }
  .jump { margin-top: 0.5rem; }
  .jump input { max-width: 180px; }
  .eps { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.6rem; }
  .eps li { display: flex; gap: 0.75rem; align-items: flex-start; padding: 0.75rem; }
  .eps li.on { opacity: 0.6; }
  .info { flex: 1; min-width: 0; display: grid; gap: 0.25rem; }
  .name { color: var(--text); font-weight: 600; text-decoration: none; }
  .acts { display: grid; gap: 0.4rem; justify-items: end; }
  .seen { display: flex; gap: 0.35rem; align-items: center; color: var(--text); margin: 0; font-size: 0.9rem; }
  .seen input { width: 20px; height: 20px; accent-color: var(--accent); }
  .note { margin-top: 1.5rem; line-height: 2; }
  @media (max-width: 480px) { .week a { min-height: 56px; } .weeknav .icon { width: 32px; } }
</style>
