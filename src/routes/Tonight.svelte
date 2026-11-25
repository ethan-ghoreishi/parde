<script lang="ts">
  import { db, getSetting, now, type Episode, type Title } from '../lib/db';
  import { live } from '../lib/live.svelte';
  import { progress, code, isAired, isListed, localDay, dayKey, byOrder, onCalendar } from '../lib/schedule';
  import { resolveLinks, openExternal, hostOf, type Resolved } from '../lib/links';
  import { scoreCandidates, type Candidate, type PickFilter } from '../lib/taste';
  import { setSeen, editLink, markSource } from '../lib/actions';
  import { titleHref } from '../lib/router.svelte';
  import { formatDay, runtime } from '../lib/format';
  import { ui, toast, undoable, errorText, clock } from '../lib/ui.svelte';
  import { openSheet } from '../components/SourceSheet.svelte';
  import Poster from '../components/Poster.svelte';

  const data = live(
    () => async () => {
      const titles = await db.titles.toArray();
      const showIds = titles.filter((t) => t.kind === 'show' && t.status !== 'dropped' && t.status !== 'watched').map((t) => t.id);
      const followed = titles.filter((t) => t.kind === 'show' && onCalendar(t)).map((t) => t.id);
      const [episodes, seen, links, lastBackup] = await Promise.all([
        db.episodes.where('titleId').anyOf([...new Set([...showIds, ...followed])]).toArray(),
        db.seen.toCollection().primaryKeys(),
        db.links.toArray(),
        getSetting<string>('lastBackupAt', ''),
      ]);
      return { titles, episodes, seen: new Set(seen), links, lastBackup };
    },
    { titles: [] as Title[], episodes: [] as Episode[], seen: new Set<number>(), links: [] as import('../lib/db').Link[], lastBackup: '' },
  );

  const titleOf = $derived(new Map(data.value.titles.map((t) => [t.id, t])));
  const byTitle = $derived.by(() => {
    const m = new Map<string, Episode[]>();
    for (const e of data.value.episodes) {
      const list = m.get(e.titleId);
      if (list) list.push(e);
      else m.set(e.titleId, [e]);
    }
    return m;
  });

  const working = (t: Title, e?: Episode) => resolveLinks(data.value.links.filter((l) => l.titleId === t.id), e?.season, e?.number).filter((r) => !r.broken);

  const continuing = $derived(
    data.value.titles
      .filter((t) => t.kind === 'show' && (t.status === 'watching' || t.status === 'paused'))
      .map((t) => {
        const p = progress(byTitle.get(t.id) ?? [], data.value.seen);
        return { t, p, srcs: p.next ? working(t, p.next) : [] };
      })
      .filter((x) => x.p.next && isAired(x.p.next, new Date(clock.now)))
      .sort((a, b) => Number(a.t.status === 'paused') - Number(b.t.status === 'paused') || b.t.updatedAt.localeCompare(a.t.updatedAt)),
  );

  const today = $derived(dayKey(new Date(clock.now)));
  const weekAhead = $derived(dayKey(new Date(clock.now + 7 * 864e5)));
  const upcoming = $derived(
    data.value.episodes
      .filter((e) => onCalendar(titleOf.get(e.titleId) ?? { status: 'dropped' }) && !data.value.seen.has(e.id) && isListed(e, data.value.seen))
      .map((e) => ({ e, day: localDay(e) }))
      .filter((x) => x.day >= today && x.day <= weekAhead && !isAired(x.e))
      .sort((a, b) => a.day.localeCompare(b.day) || byOrder(a.e, b.e))
      .slice(0, 6),
  );

  // ----- Decide -----
  let filter = $state<PickFilter>({ kind: 'any' });
  let skip = $state(0);
  const candidates = $derived.by<Candidate[]>(() => {
    const out: Candidate[] = [];
    for (const t of data.value.titles) {
      if (t.kind === 'film' && t.status === 'want') out.push({ title: t, minutes: t.runtime });
      if (t.kind === 'show' && (t.status === 'want' || t.status === 'watching')) {
        const next = progress(byTitle.get(t.id) ?? [], data.value.seen).next;
        if (next && isAired(next, new Date(clock.now))) out.push({ title: t, episode: next, minutes: next.runtime ?? t.runtime });
      }
    }
    return out;
  });
  const genres = $derived([...new Set(candidates.flatMap((c) => c.title.genres))].sort());
  const picks = $derived(scoreCandidates(candidates, data.value.titles, filter));
  const pick = $derived(picks.length ? picks[skip % picks.length] : undefined);
  const unknownLength = $derived(filter.maxMinutes ? candidates.filter((c) => !c.minutes && (filter.kind === 'any' || c.title.kind === filter.kind)).length : 0);

  const backupDue = $derived(
    data.value.titles.length >= 5 && (!data.value.lastBackup || Date.now() - Date.parse(data.value.lastBackup) > 14 * 864e5),
  );

  /** The source just opened from here, so the next one is a tap away if it did not work. */
  let tried = $state.raw<{ titleId: string; src: Resolved; ep?: Episode } | null>(null);
  async function watch(t: Title, src: Resolved, ep?: Episode) {
    if (!openExternal(src.url)) return toast('That link is not valid. Edit it under Sources.', 'error');
    tried = { titleId: t.id, src, ep };
    await editLink(src.link.id, { usedAt: now() }).catch((e) => toast(errorText(e), 'error'));
  }
  async function tryNext(t: Title, next: Resolved) {
    const prior = tried;
    if (!prior) return;
    await watch(t, next, prior.ep);
    await markSource(prior.src.link.id, true, prior.ep?.season, prior.ep?.number).catch((e) => toast(errorText(e), 'error'));
  }

  /** The next episode takes the same place on screen: a second tap just after must not mark it too. */
  let settling = $state<Record<string, boolean>>({});
  async function seenNext(t: Title, ep: Episode) {
    if (settling[t.id]) return;
    settling[t.id] = true;
    try {
      undoable(`${t.name} ${code(ep)} seen`, await setSeen(ep, true));
      tried = null;
    } catch (e) {
      toast(`Not saved: ${errorText(e)}`, 'error');
    } finally {
      setTimeout(() => (settling[t.id] = false), 700);
    }
  }

  const set = (patch: Partial<PickFilter>) => {
    filter = { ...filter, ...patch };
    skip = 0;
  };
</script>

<h1 class="sr-only">Tonight</h1>

{#if backupDue}
  <div class="card nudge row">
    <span>{data.value.lastBackup ? `Last backup ${formatDay(data.value.lastBackup.slice(0, 10))}.` : 'Your collection has never been backed up.'} It lives only in this browser.</span>
    <a class="btn small" href="#/settings">Back up now</a>
  </div>
{/if}

{#if data.ready && !data.value.titles.length}
  <section class="welcome card stack">
    <h1>Welcome to Parde</h1>
    <p>Keeps your place in every series, helps you choose, and slowly shows you what you really like.</p>
    <div class="row">
      <a class="btn primary" href="#/discover">Start with what you have seen</a>
      <button onclick={() => (ui.searchOpen = true)}>Search for a title</button>
    </div>
    <p class="small muted">Twelve posters at a time: tap the ones you know. Already have a list? <a href="#/import">Import it from Letterboxd, IMDb or text</a>, or <a href="#/settings">restore a backup</a>.</p>
    <p class="small muted">Everything stays in this browser. Nothing is uploaded anywhere.</p>
  </section>
{/if}

{#snippet sources(t: Title, e: Episode | undefined, srcs: Resolved[])}
  {@const src = srcs[0]}
  {#if src}
    <button class="small primary" onclick={() => watch(t, src, e)}>Watch on {src.link.label || hostOf(src.url)} ↗</button>
  {/if}
  {#if src}
    <button class="small" onclick={() => openSheet(t, e)} aria-label="Sources for {t.name}{e ? ` ${code(e)}` : ''}">Sources{srcs.length > 1 ? ` (${srcs.length})` : ''}</button>
  {:else}
    <button class="small" onclick={() => openSheet(t, e)}>{e ? 'Add a source' : 'Where to watch'}</button>
  {/if}
{/snippet}
{#snippet didntWork(t: Title, srcs: Resolved[], ep?: Episode)}
  {#if tried?.titleId === t.id && tried.ep?.id === ep?.id}
    {@const next = srcs.find((r) => r.link.id !== tried!.src.link.id)}
    <p class="small tried" role="status">
      <span class="muted">{tried.src.link.label || hostOf(tried.src.url)} didn't work?</span>
      {#if next}<button class="small" onclick={() => tryNext(t, next)}>Try {next.link.label || hostOf(next.url)} ↗</button>
      {:else}<span class="muted">No other source saved: add one under Sources.</span>{/if}
    </p>
  {/if}
{/snippet}

{#if continuing.length}
  <section class="section">
    <h2>Continue watching</h2>
    <ul class="continue">
      {#each continuing as { t, p, srcs } (t.id)}
        <li class="card">
          <a href={titleHref(t.id)} class="poster-link" aria-label={t.name}><Poster src={t.poster} name={t.name} size="sm" /></a>
          <div class="info">
            <a href={titleHref(t.id)} class="name">{t.name}</a>
            <div class="small"><strong>{code(p.next!)}</strong> {p.next!.name}</div>
            <div class="small muted">{p.unseenAired > 1 ? `${p.unseenAired} episodes waiting` : 'Next episode'}{t.status === 'paused' ? ' · paused' : ''}</div>
            <div class="row acts">
              {@render sources(t, p.next, srcs)}
              <button class="small" onclick={() => seenNext(t, p.next!)} disabled={settling[t.id]} aria-label="{t.name} {code(p.next!)} seen">Seen</button>
            </div>
            {@render didntWork(t, srcs, p.next)}
          </div>
        </li>
      {/each}
    </ul>
  </section>
{/if}

{#if candidates.length}
  <section class="section">
    <h2>What should we watch?</h2>
    <div class="filters stack">
      <div class="row" role="group" aria-label="Kind">
        {#each [['any', 'Anything'], ['film', 'A film'], ['show', 'An episode']] as [k, label]}
          <button class="chip" class:on={filter.kind === k} aria-pressed={filter.kind === k} onclick={() => set({ kind: k as PickFilter['kind'] })}>{label}</button>
        {/each}
        <span class="sep" aria-hidden="true"></span>
        {#each [[undefined, 'Any length'], [60, '≤ 1h'], [100, '≤ 1h40'], [130, '≤ 2h10']] as [m, label]}
          <button class="chip" class:on={filter.maxMinutes === m} aria-pressed={filter.maxMinutes === m} onclick={() => set({ maxMinutes: m as number | undefined })}>{label}</button>
        {/each}
      </div>
      {#if genres.length > 1}
        <div class="row">
          <label for="mood" class="sr-only">Genre</label>
          <select id="mood" value={filter.genre ?? ''} onchange={(e) => set({ genre: e.currentTarget.value || undefined })} style="max-width: 260px">
            <option value="">Any mood</option>
            {#each genres as g}<option>{g}</option>{/each}
          </select>
        </div>
      {/if}
    </div>

    {#if pick}
      {@const t = pick.c.title}
      <div class="pick card fade">
        <a href={titleHref(t.id)} aria-label={t.name}><Poster src={t.poster} name={t.name} size="sm" /></a>
        <div class="info stack">
          <div>
            <a class="name big" href={titleHref(t.id)}>{t.name}</a>
            <div class="small muted">
              {[t.year, pick.c.episode ? `${code(pick.c.episode)} ${pick.c.episode.name}` : '', runtime(pick.c.minutes)].filter(Boolean).join(' · ')}
            </div>
          </div>
          {#if pick.reasons.length}
            <ul class="reasons small">{#each pick.reasons as r}<li>{r}</li>{/each}</ul>
          {/if}
          <div class="row acts">
            {@render sources(t, pick.c.episode, working(t, pick.c.episode))}
            {#if picks.length > 1}<button class="small" onclick={() => skip++}>Another</button>{/if}
          </div>
          {@render didntWork(t, working(t, pick.c.episode), pick.c.episode)}
        </div>
      </div>
      <p class="small muted">Ordered by your keenness, the people you rate and how long it has waited, not by scores.</p>
    {:else}
      <p class="empty">Nothing on your list fits. <button class="small" onclick={() => set({ kind: 'any', maxMinutes: undefined, genre: undefined })}>Clear the filters</button></p>
    {/if}
    {#if unknownLength}<p class="small muted">{unknownLength} title{unknownLength > 1 ? 's' : ''} of unknown length left out.</p>{/if}
  </section>
{/if}

{#if upcoming.length}
  <section class="section">
    <div class="spread"><h2>Coming this week</h2><a href="#/calendar" class="small">Calendar →</a></div>
    <ul class="upcoming">
      {#each upcoming as { e, day } (e.id)}
        {@const t = titleOf.get(e.titleId)!}
        <li><span class="muted small when">{formatDay(day)}</span> <a href={titleHref(t.id)}>{t.name}</a> <span class="small muted">{code(e)}</span></li>
      {/each}
    </ul>
  </section>
{/if}

{#if data.ready && data.value.titles.length}
  <section class="section card more">
    {#if continuing.length || candidates.length}
      <h2>In the mood for something else?</h2>
    {:else}
      <h2>Nothing waiting for tonight</h2>
      <p class="small muted">You are up to date, and there is nothing on your list yet.</p>
    {/if}
    <a class="btn" class:primary={!continuing.length && !candidates.length} href="#/discover">Discover films and series</a>
  </section>
{/if}

<style>
  .more { display: grid; gap: 0.5rem; justify-items: start; }
  .more h2, .more p { margin: 0; }
  .tried { margin: 0.5rem 0 0; display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
  .nudge { justify-content: space-between; border-color: var(--accent); margin-bottom: 1rem; }
  .welcome { max-width: 640px; margin: 2rem auto; padding: 1.5rem; }
  .continue { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 0.75rem; }
  .continue li { display: flex; gap: 0.9rem; padding: 0.75rem; }
  @media (max-width: 400px) { .continue { grid-template-columns: 1fr; } }
  .info { flex: 1; min-width: 0; display: grid; gap: 0.2rem; align-content: start; }
  .name { color: var(--text); font-weight: 600; text-decoration: none; }
  .name.big { font-family: var(--serif); font-size: 1.3rem; }
  .acts { margin-top: 0.35rem; }
  .sep { width: 1px; height: 24px; background: var(--line); margin: 0 0.25rem; }
  @media (max-width: 560px) { .sep { flex-basis: 100%; height: 0; margin: 0; } }
  .pick { display: flex; gap: 1rem; margin-top: 0.75rem; max-width: 640px; }
  .reasons { margin: 0; padding-left: 1.1rem; color: var(--muted); }
  .upcoming { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.35rem; }
  .upcoming a { color: var(--text); }
  .when { display: inline-block; min-width: 6.5rem; }
</style>
