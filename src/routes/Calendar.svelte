<script lang="ts">
  import { db, now, type Episode, type Link, type Title } from '../lib/db';
  import { live } from '../lib/live.svelte';
  import { code, dayKey, isAired, isListed, localDay, localTime, onCalendar, release, byOrder } from '../lib/schedule';
  import { resolveLinks, openExternal, hostOf } from '../lib/links';
  import { openSheet } from '../components/SourceSheet.svelte';
  import { setSeen, setSeenAll, editLink, syncShows, type Undo } from '../lib/actions';
  import { route, go, titleHref } from '../lib/router.svelte';
  import { formatDay } from '../lib/format';
  import { toast, undoable, errorText, clock } from '../lib/ui.svelte';
  import Poster from '../components/Poster.svelte';

  const data = live(
    () => async () => {
      const shows = (await db.titles.where('kind').equals('show').toArray()).filter(onCalendar);
      const ids = shows.map((t) => t.id);
      const [episodes, seen, links] = await Promise.all([
        db.episodes.where('titleId').anyOf(ids).toArray(),
        db.seen.where('titleId').anyOf(ids).primaryKeys(),
        db.links.where('titleId').anyOf(ids).toArray(),
      ]);
      const marks = new Set(seen);
      return { shows, episodes: episodes.filter((e) => isListed(e, marks)), seen: marks, links };
    },
    { shows: [] as Title[], episodes: [] as Episode[], seen: new Set<number>(), links: [] as Link[] },
  );

  const today = $derived(dayKey(new Date(clock.now)));
  const selected = $derived(/^\d{4}-\d{2}-\d{2}$/.test(route.params.get('d') ?? '') ? route.params.get('d')! : today);
  const byDay = $derived.by(() => {
    const m = new Map<string, Episode[]>();
    for (const e of data.value.episodes) {
      const d = localDay(e);
      if (!d) continue;
      const list = m.get(d);
      if (list) list.push(e);
      else m.set(d, [e]);
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

  const plus = (key: string, days: number) => {
    const d = new Date(`${key}T12:00:00`);
    d.setDate(d.getDate() + days);
    return dayKey(d);
  };

  /** The selected day and the two weeks after it, each day's episodes grouped by series (a season drop is one card). */
  const agenda = $derived.by(() => {
    const end = plus(selected, 14);
    return [...byDay.keys()]
      .filter((d) => d >= selected && d <= end)
      .sort()
      .map((day) => {
        const groups = new Map<string, Episode[]>();
        for (const e of [...byDay.get(day)!].sort(byOrder)) {
          const list = groups.get(e.titleId);
          if (list) list.push(e);
          else groups.set(e.titleId, [e]);
        }
        return {
          day,
          groups: [...groups].map(([id, eps]) => ({ t: showOf.get(id)!, eps })).filter((g) => g.t)
            .sort((a, b) => (localTime(a.eps[0]) ?? '').localeCompare(localTime(b.eps[0]) ?? '') || a.t.name.localeCompare(b.t.name)),
        };
      });
  });
  const later = $derived([...byDay.keys()].filter((d) => d > plus(selected, 14)).sort()[0]);

  const span = (eps: Episode[]) =>
    eps.length === 1 ? `${code(eps[0])} ${eps[0].name}` : eps.every((e) => e.season === eps[0].season) ? `${code(eps[0])}–E${String(eps.at(-1)!.number).padStart(2, '0')} · ${eps.length} episodes` : eps.map(code).join(', ');
  const where = (t: Title) => {
    const r = release(t);
    return r.where ? `${r.where}${t.channelCountry ? ` (${t.channelCountry})` : ''}` : '';
  };
  const sourceFor = (e: Episode) => resolveLinks(data.value.links.filter((l) => l.titleId === e.titleId), e.season, e.number).find((r) => !r.link.broken);

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
    const src = sourceFor(e);
    if (src && openExternal(src.url)) await editLink(src.link.id, { usedAt: now() });
    else toast('That saved link is not valid. Edit it under Sources.', 'error');
  }

  async function act(text: string, run: () => Promise<Undo>) {
    try {
      undoable(text, await run());
    } catch (e) {
      toast(`Not saved: ${errorText(e)}`, 'error');
    }
  }
  const allSeen = (t: Title, eps: Episode[]) => act(`${t.name}: ${eps.length} episodes seen`, () => setSeenAll(t.id, eps.filter((e) => isAired(e))));
  const one = (t: Title, e: Episode, on: boolean) => act(`${t.name} ${code(e)} ${on ? 'seen' : 'unmarked'}`, () => setSeen(e, on));
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
  {#if !data.value.shows.length && data.ready}
    <div class="empty">No series on your calendar yet. Add a series you watch and its episodes will show up here.</div>
  {:else if !agenda.length}
    <div class="empty">
      Nothing from your series in the two weeks from {formatDay(selected)}.
      {#if later}<a href="#/calendar?d={later}">Next: {formatDay(later)} →</a>{/if}
    </div>
  {:else}
    {#each agenda as { day, groups } (day)}
      <h2 class="day" class:today={day === today}>{formatDay(day)}{formatDay(day).length < 10 ? ` · ${new Date(`${day}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}` : ''}</h2>
      <ul class="eps">
        {#each groups as { t, eps } (t.id)}
          {@const r = release(t)}
          {@const unseen = eps.filter((e) => !data.value.seen.has(e.id))}
          {@const out = eps.every((e) => isAired(e))}
          {@const first = unseen.find((e) => isAired(e))}
          {@const src = first ? sourceFor(first) : undefined}
          <li class="card" class:on={!unseen.length}>
            <a href={titleHref(t.id)} aria-label={t.name}><Poster src={t.poster} name={t.name} size="xs" /></a>
            <div class="info">
              <a class="name" href={titleHref(t.id)}>{t.name}</a>
              <div class="small">{span(eps)}</div>
              <div class="row small">
                {#if r.kind === 'stream'}
                  <span class="chip stream" title="The streaming service's own release date">Released on {where(t)}</span>
                {:else if r.kind === 'broadcast'}
                  <span class="chip broadcast" title="Broadcast date. Streaming availability may differ.">Airs on {where(t)}</span>
                {:else}
                  <span class="chip">Release date</span>
                {/if}
                {#if localTime(eps[0])}<span class="muted">{localTime(eps[0])} your time</span>{/if}
              </div>
              {#if out && unseen.length}
                <div class="small muted">{src ? `Your source: ${src.link.label || hostOf(src.url)}` : 'No source saved for this yet'}</div>
              {/if}
            </div>
            <div class="acts">
              {#if eps.length === 1}
                <label class="seen"><input type="checkbox" checked={!unseen.length} onchange={(ev) => one(t, eps[0], ev.currentTarget.checked)} /> Seen</label>
              {:else if unseen.some((e) => isAired(e))}
                <button class="small" onclick={() => allSeen(t, eps)}>All seen</button>
              {:else if !unseen.length}
                <span class="small muted">All seen</span>
              {/if}
              {#if first}
                {#if src}<button class="small primary" onclick={() => open(first)}>Watch {eps.length > 1 ? code(first) : ''} ↗</button>{/if}
                <button class="small" onclick={() => openSheet(t, first)} aria-label="Sources for {t.name} {code(first)}">{src ? 'Sources' : 'Add a source'}</button>
              {:else if !out}
                <span class="small muted">Not out yet</span>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/each}
    {#if later}<p class="small"><a href="#/calendar?d={later}">Later: {formatDay(later)} →</a></p>{/if}
  {/if}
  <p class="small muted note">
    <span class="chip stream">Released on</span> is the streaming service's own release date; a country in brackets means it is released there first, and may come elsewhere later or not at all.
    <span class="chip broadcast">Airs on</span> is a TV broadcast, shown in your time zone; it says nothing certain about when it reaches streaming.
    Neither can confirm it is available to you: only your own sources can. Schedule data from <a href="https://www.tvmaze.com" target="_blank" rel="noopener noreferrer">TVmaze</a> (CC BY-SA).
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
  .day { margin: 1.5rem 0 0.6rem; font-size: 1.1rem; }
  .day.today { color: var(--accent); }
  .eps { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.6rem; }
  .eps li { display: flex; gap: 0.75rem; align-items: flex-start; padding: 0.75rem; }
  .eps li.on .name, .eps li.on .small { color: var(--muted); }
  .info { flex: 1; min-width: 0; display: grid; gap: 0.25rem; }
  .name { color: var(--text); font-weight: 600; text-decoration: none; }
  .acts { display: grid; gap: 0.4rem; justify-items: end; }
  .seen { display: flex; gap: 0.35rem; align-items: center; color: var(--text); margin: 0; font-size: 0.9rem; }
  .seen input { width: 20px; height: 20px; accent-color: var(--accent); }
  .note { margin-top: 1.5rem; line-height: 2; }
  @media (max-width: 480px) { .week a { min-height: 56px; } .weeknav .icon { width: 32px; } }
</style>
