<script lang="ts">
  import { db, getSetting, now, type Episode, type Title } from '../lib/db';
  import { live } from '../lib/live.svelte';
  import { progress, code, isAired, localDay, dayKey, byOrder } from '../lib/schedule';
  import { resolveLinks, openExternal, hostOf } from '../lib/links';
  import { scoreCandidates, type Candidate, type PickFilter } from '../lib/taste';
  import { setSeen, editLink } from '../lib/actions';
  import { titleHref } from '../lib/router.svelte';
  import { formatDay, runtime } from '../lib/format';
  import { ui, toast } from '../lib/ui.svelte';
  import Poster from '../components/Poster.svelte';

  const data = live(
    () => async () => {
      const titles = await db.titles.toArray();
      const showIds = titles.filter((t) => t.kind === 'show' && t.status !== 'dropped' && t.status !== 'watched').map((t) => t.id);
      const followed = titles.filter((t) => t.kind === 'show' && t.followed).map((t) => t.id);
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

  const byTitle = $derived.by(() => {
    const m = new Map<string, Episode[]>();
    for (const e of data.value.episodes) m.set(e.titleId, [...(m.get(e.titleId) ?? []), e]);
    return m;
  });

  const continuing = $derived(
    data.value.titles
      .filter((t) => t.kind === 'show' && (t.status === 'watching' || t.status === 'paused'))
      .map((t) => {
        const p = progress(byTitle.get(t.id) ?? [], data.value.seen);
        const src = p.next ? resolveLinks(data.value.links.filter((l) => l.titleId === t.id), p.next.season, p.next.number).find((r) => !r.link.broken) : undefined;
        return { t, p, src };
      })
      .filter((x) => x.p.next && isAired(x.p.next))
      .sort((a, b) => Number(a.t.status === 'paused') - Number(b.t.status === 'paused') || b.t.updatedAt.localeCompare(a.t.updatedAt)),
  );

  const today = dayKey(new Date());
  const weekAhead = dayKey(new Date(Date.now() + 7 * 864e5));
  const upcoming = $derived(
    data.value.episodes
      .filter((e) => data.value.titles.find((t) => t.id === e.titleId)?.followed && !data.value.seen.has(e.id))
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
        if (next && isAired(next)) out.push({ title: t, episode: next, minutes: next.runtime ?? t.runtime });
      }
    }
    return out;
  });
  const genres = $derived([...new Set(candidates.flatMap((c) => c.title.genres))].sort());
  const picks = $derived(scoreCandidates(candidates, data.value.titles, filter));
  const pick = $derived(picks.length ? picks[skip % picks.length] : undefined);

  const backupDue = $derived(
    data.value.titles.length >= 5 && (!data.value.lastBackup || Date.now() - Date.parse(data.value.lastBackup) > 14 * 864e5),
  );

  async function watch(src: ReturnType<typeof resolveLinks>[number]) {
    if (!openExternal(src.url)) return toast('That link is not valid. Edit it on the title page.', 'error');
    await editLink(src.link.id, { usedAt: now() });
  }

  function seenNext(t: Title, ep: Episode) {
    setSeen(ep, true);
    toast(`${t.name} ${code(ep)} seen`, 'ok', { label: 'Undo', run: () => setSeen(ep, false) });
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
    <p>Your private film and TV companion. Add what you have loved, what you are watching and what you want to see. Parde fills in the details, keeps track of episodes, remembers where you watch, and over time shows you what your taste is really like.</p>
    <ol class="small">
      <li>Add a few films and series you have seen and rate them — it takes seconds each.</li>
      <li>Add what you want to watch, and after each trailer note how keen you are.</li>
      <li>For series you are watching, mark where you are. New episodes appear on the calendar.</li>
    </ol>
    <div class="row">
      <button class="primary" onclick={() => (ui.searchOpen = true)}>Add your first title</button>
      <a class="btn" href="#/settings">Restore a backup</a>
    </div>
    <p class="small muted">Everything stays in this browser. Nothing is uploaded anywhere.</p>
  </section>
{/if}

{#if continuing.length}
  <section class="section">
    <h2>Continue watching</h2>
    <ul class="continue">
      {#each continuing as { t, p, src } (t.id)}
        <li class="card">
          <a href={titleHref(t.id)} class="poster-link" aria-label={t.name}><Poster src={t.poster} name={t.name} size="sm" /></a>
          <div class="info">
            <a href={titleHref(t.id)} class="name">{t.name}</a>
            <div class="small"><strong>{code(p.next!)}</strong> {p.next!.name}</div>
            <div class="small muted">{p.unseenAired > 1 ? `${p.unseenAired} episodes waiting` : 'Next episode'}{t.status === 'paused' ? ' · paused' : ''}</div>
            <div class="row acts">
              {#if src}
                <button class="small primary" onclick={() => watch(src)}>Watch on {src.link.label || hostOf(src.url)} ↗</button>
              {:else}
                <a class="btn small" href={titleHref(t.id)}>Add a source</a>
              {/if}
              <button class="small" onclick={() => seenNext(t, p.next!)}>Seen</button>
            </div>
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
          <div class="row">
            <a class="btn small primary" href={titleHref(t.id)}>Let's watch this</a>
            {#if picks.length > 1}<button class="small" onclick={() => skip++}>Another ({(skip % picks.length) + 1}/{picks.length})</button>{/if}
          </div>
        </div>
      </div>
    {:else}
      <p class="empty">Nothing on your list fits. Loosen the filters.</p>
    {/if}
  </section>
{/if}

{#if upcoming.length}
  <section class="section">
    <div class="spread"><h2>Coming this week</h2><a href="#/calendar" class="small">Calendar →</a></div>
    <ul class="upcoming">
      {#each upcoming as { e, day } (e.id)}
        {@const t = data.value.titles.find((x) => x.id === e.titleId)!}
        <li><span class="muted small when">{formatDay(day)}</span> <a href={titleHref(t.id)}>{t.name}</a> <span class="small muted">{code(e)}</span></li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .nudge { justify-content: space-between; border-color: var(--accent); margin-bottom: 1rem; }
  .welcome { max-width: 640px; margin: 2rem auto; padding: 1.5rem; }
  .welcome ol { padding-left: 1.2rem; }
  .continue { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 0.75rem; }
  .continue li { display: flex; gap: 0.9rem; padding: 0.75rem; }
  @media (max-width: 400px) { .continue { grid-template-columns: 1fr; } }
  .info { flex: 1; min-width: 0; display: grid; gap: 0.2rem; align-content: start; }
  .name { color: var(--text); font-weight: 600; text-decoration: none; }
  .name.big { font-family: var(--serif); font-size: 1.3rem; }
  .acts { margin-top: 0.35rem; }
  .sep { width: 1px; height: 24px; background: var(--line); margin: 0 0.25rem; }
  .pick { display: flex; gap: 1rem; margin-top: 0.75rem; max-width: 640px; }
  .reasons { margin: 0; padding-left: 1.1rem; color: var(--muted); }
  .upcoming { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.35rem; }
  .upcoming a { color: var(--text); }
  .when { display: inline-block; min-width: 6.5rem; }
</style>
