<script lang="ts">
  import { db, now, getSetting, type Title } from '../lib/db';
  import { live } from '../lib/live.svelte';
  import { titleHref, personHref } from '../lib/router.svelte';
  import {
    EXPECTATIONS, trailerInstinct, versusCritics, makerAffinity, castAffinity, genreAffinity, themeAffinity, contradictions,
    partnerSplits, counts, decade, rated, mean, reliable, interleave, type Affinity, type Gap,
  } from '../lib/taste';
  import { credits, posters, type Credit } from '../lib/api/wiki';
  import { addFilm } from '../lib/actions';
  import { toast, errorText } from '../lib/ui.svelte';
  import { formatDay } from '../lib/format';
  import Poster from '../components/Poster.svelte';

  const data = live(
    () => async () => ({
      titles: await db.titles.toArray(),
      dismissed: new Set(await db.dismissed.toCollection().primaryKeys()),
      partner: await getSetting('partner', ''),
    }),
    { titles: [] as Title[], dismissed: new Set<string>(), partner: '' },
  );

  const titles = $derived(data.value.titles);
  const r = $derived(rated(titles));
  const watched = $derived(titles.filter((t) => t.status === 'watched'));
  const avg = $derived(mean(r.map((t) => t.rating!)));
  const instinct = $derived(trailerInstinct(titles));
  const critics = $derived(versusCritics(titles));
  const makers = $derived(makerAffinity(titles));
  const actors = $derived(castAffinity(titles, 3).filter((a) => a.lift > 0.4).slice(0, 6));
  const genresA = $derived(genreAffinity(titles));
  const themesA = $derived(themeAffinity(titles));
  const themeCounts = $derived(counts(titles.flatMap((t) => t.themes ?? []), 12).filter(([, n]) => n >= 2));
  const contra = $derived(contradictions(titles));
  const splits = $derived(partnerSplits(titles));
  const decades = $derived(counts(watched.map((t) => decade(t.year)).filter((x): x is string => !!x), 10).sort((a, b) => a[0].localeCompare(b[0])));
  const countries = $derived(counts(watched.flatMap((t) => t.countries), 8));
  const diary = $derived(watched.filter((t) => t.finishedAt).sort((a, b) => b.finishedAt!.localeCompare(a.finishedAt!)).slice(0, 12));
  const thisYear = $derived(watched.filter((t) => t.finishedAt?.startsWith(String(new Date().getFullYear()))).length);

  const liked = $derived(makers.filter((m) => m.lift > 0.3).slice(0, 8));
  const notYours = $derived(makers.filter((m) => m.lift < -0.5).slice(-4).reverse());
  const above = $derived(genresA.filter((g) => g.lift > 0.3).slice(0, 6));
  const below = $derived(genresA.filter((g) => g.lift < -0.3).slice(-6).reverse());

  /** Words for how sure a pattern is: it is only ever as strong as the number of titles behind it. */
  const strength = (n: number) => (n >= 8 ? 'consistent' : n >= 4 ? 'a pattern' : 'an early sign');
  // A coefficient is described only when it is more than chance for this many titles.
  const describeR = (x: number, n: number) =>
    !reliable(x, n) ? 'shows no reliable link yet with' : x >= 0.5 ? 'clearly tracks' : x > 0 ? 'loosely tracks' : 'runs against';
  const affLine = (a: Affinity) => `${a.avg.toFixed(1)} avg · ${a.n} title${a.n > 1 ? 's' : ''}${a.n < 4 ? ', an early sign' : ''}`;
  const ratedN = $derived(r.length);
  const withMakers = $derived(r.filter((t) => t.people.some((p) => p.role !== 'cast' && p.role !== 'composer')).length);
  const likedNames = $derived(new Set(liked.map((m) => m.key)));
  // Already on your list, by people you rate highly: the most actionable thing here.
  const queued = $derived(titles.filter((t) => t.status === 'want' && t.people.some((p) => p.role !== 'cast' && likedNames.has(p.name))).slice(0, 5));

  // What would unlock more, said once rather than as a wall of locked cards.
  const pending = $derived(
    [
      instinct.n < 4 && `trailer instinct after ${4 - instinct.n} more title${4 - instinct.n > 1 ? 's' : ''} with a before-watching “how keen” and a rating`,
      critics.n < 5 && `you vs critics after ${5 - critics.n} more rated film${5 - critics.n > 1 ? 's' : ''} with a Metacritic or Rotten Tomatoes score`,
      !makers.length && 'people you trust once you rate two titles by the same director or writer',
      !themesA.length && 'recurring themes once three rated titles share a theme',
    ].filter((x): x is string => !!x),
  );

  // ----- Discovery: more from people you trust -----
  let suggestions = $state<Credit[]>([]);
  let pics = $state<Record<string, string>>({});
  let finding = $state(false);
  let found = $state(false);
  const people = $derived.by(() => {
    const trusted = makers.filter((m) => m.qid && m.lift > 0.3).slice(0, 10).map((m) => ({ qid: m.qid!, name: m.key }));
    if (trusted.length) return trusted;
    // Too few ratings for averages: start from the makers of anything you rated 9 or 10.
    const fav = r.filter((t) => t.rating! >= 9).flatMap((t) => t.people.filter((p) => p.qid && p.role !== 'cast' && p.role !== 'composer'));
    return [...new Map(fav.map((p) => [p.qid!, { qid: p.qid!, name: p.name }])).values()].slice(0, 10);
  });
  const nameOf = $derived(new Map(people.map((p) => [p.qid, p.name])));
  const owned = $derived(new Set(titles.map((t) => t.qid).filter(Boolean)));
  const thisYearN = new Date().getFullYear();
  const visible = $derived(
    interleave(
      suggestions.filter((s) => s.kind === 'film' && s.year && s.year <= thisYearN && !owned.has(s.qid) && !data.value.dismissed.has(s.qid)),
      people.map((p) => p.qid),
    ).slice(0, 18),
  );
  const why = (qid: string) => {
    const m = makers.find((x) => x.qid === qid);
    return m ? `you rate their work ${m.avg.toFixed(1)} across ${m.n}` : 'you rated one of theirs 9 or more';
  };

  async function discover() {
    finding = true;
    try {
      suggestions = (await credits(people.map((p) => p.qid), ['directed', 'wrote', 'created'])).sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
      found = true;
      pics = await posters(visible.map((s) => s.wiki).filter((x): x is string => !!x)).catch(() => ({}));
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      finding = false;
    }
  }

  async function want(s: Credit) {
    try {
      await addFilm(s.qid);
      toast(`${s.name} added to your list`);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }
  const dismiss = (s: Credit) => db.dismissed.put({ qid: s.qid, at: now() });
</script>

{#snippet gapList(items: Gap[], kind: 'trailer' | 'critics')}
  <ul class="gaps small">
    {#each items as g}
      <li>
        <a href={titleHref(g.title.id)}>{g.title.name}</a>
        <span class="muted">
          {kind === 'trailer' ? `${EXPECTATIONS[g.title.expectation!]} → ${g.title.rating}/10` : critics.source === 'Metacritic' ? `Metacritic ${g.ref} · you ${g.title.rating}/10` : `${g.ref}% of critics positive · you ${g.title.rating}/10`}
        </span>
      </li>
    {/each}
  </ul>
{/snippet}

{#snippet affList(items: Affinity[], people: boolean)}
  <ul class="aff small">
    {#each items as a}
      <li>
        {#if people}<a href={personHref(a.qid, a.key)}>{a.key}</a>{:else}{a.key}{/if}
        <span class="muted">{affLine(a)}</span>
      </li>
    {/each}
  </ul>
{/snippet}

<h1>Your taste</h1>

{#if data.ready && !titles.length}
  <div class="empty">Insights grow from what you add, rate and note. Start with a few films you know well, or import your ratings in Settings.</div>
{:else}
  <div class="stats">
    <div class="card"><strong>{watched.filter((t) => t.kind === 'film').length}</strong><span class="small muted">films watched</span></div>
    <div class="card"><strong>{watched.filter((t) => t.kind === 'show').length}</strong><span class="small muted">series finished</span></div>
    <div class="card"><strong>{thisYear}</strong><span class="small muted">finished this year</span></div>
    <div class="card"><strong>{Number.isNaN(avg) ? '–' : avg.toFixed(1)}</strong><span class="small muted">average of {r.length} rating{r.length === 1 ? '' : 's'}</span></div>
  </div>

  <p class="small muted lead">Every pattern below shows how many titles it rests on. A few titles make an early sign, not a conclusion; averages from small groups are pulled toward your overall average so one great film cannot dominate.</p>

  <div class="cards">
    {#if instinct.n >= 4}
      <section class="card">
        <h2>Trailer instinct</h2>
        <p>
          {#if instinct.keen.n}Of the <strong>{instinct.keen.n}</strong> you were keen on after the trailer, <strong>{instinct.keen.above}</strong> beat your average rating.{/if}
          {#if instinct.unsure.n}Of the <strong>{instinct.unsure.n}</strong> you doubted, <strong>{instinct.unsure.above}</strong> did.{/if}
        </p>
        {#if instinct.n >= 12}
          <p class="small">Across {instinct.n} titles your trailer read {describeR(instinct.r, instinct.n)} how much you enjoy things (rank correlation {instinct.r.toFixed(2)}).</p>
        {:else}
          <p class="small muted">{instinct.n} titles so far: {strength(instinct.n)}. A firmer read comes at 12.</p>
        {/if}
        {#if instinct.surprises.length}<h3>Better than the trailer</h3>{@render gapList(instinct.surprises, 'trailer')}{/if}
        {#if instinct.letdowns.length}<h3>The trailer oversold it</h3>{@render gapList(instinct.letdowns, 'trailer')}{/if}
      </section>
    {/if}

    {#if critics.n >= 5}
      <section class="card">
        <h2>You and the critics</h2>
        {#if critics.source === 'Metacritic'}
          <p>Against Metacritic you rate {Math.abs(critics.meanGap) < 3 ? 'about the same' : `${Math.round(Math.abs(critics.meanGap))} points ${critics.meanGap > 0 ? 'warmer' : 'colder'}`} on average, and their scores {describeR(critics.r, critics.n)} yours ({critics.n} of your {ratedN} rated titles have a Metacritic score).</p>
        {:else}
          <p>How many critics liked something {describeR(critics.r, critics.n)} how much you do ({critics.n} of your {ratedN} rated titles have a Rotten Tomatoes score). The Tomatometer counts positive reviews, so it is not compared point for point.</p>
        {/if}
        {#if critics.warmer.length}<h3>You liked, critics less so</h3>{@render gapList(critics.warmer, 'critics')}{/if}
        {#if critics.colder.length}<h3>Critics liked, you less so</h3>{@render gapList(critics.colder, 'critics')}{/if}
        <p class="small muted">Scores via Wikidata; they can lag the live sites.</p>
      </section>
    {/if}

    {#if liked.length || notYours.length}
      <section class="card">
        <h2>Directors and writers</h2>
        {#if liked.length}<h3>Above your average</h3>{@render affList(liked, true)}{/if}
        {#if queued.length}
          <p class="small note">Already on your list by them: {#each queued as t, i}<a href={titleHref(t.id)}>{t.name}</a>{i < queued.length - 1 ? ', ' : ''}{/each}.</p>
        {/if}
        {#if notYours.length}<h3>Not really your people</h3>{@render affList(notYours, true)}{/if}
        {#if withMakers < ratedN}<p class="small muted">From {withMakers} of your {ratedN} rated titles; the rest have no director or writer listed.</p>{/if}
      </section>
    {/if}

    {#if themeCounts.length}
      <section class="card">
        <h2>Themes you return to</h2>
        <p class="small muted">From the words you chose after watching.</p>
        <div class="row">
          {#each themeCounts as [k, n]}
            {@const a = themesA.find((x) => x.key === k)}
            <a class="chip" href="#/library?theme={encodeURIComponent(k)}">{k} · {n}{a ? ` · ${a.avg.toFixed(1)} avg` : ''}</a>
          {/each}
        </div>
        {#each themesA.filter((a) => Math.abs(a.lift) >= 0.4).slice(0, 3) as a}
          <p class="small note">Titles about <strong>{a.key}</strong> {a.lift > 0 ? 'move you more than most' : 'land less well with you'}: {a.avg.toFixed(1)} across {a.n} ({strength(a.n)}).</p>
        {/each}
      </section>
    {/if}

    {#if above.length || below.length}
      <section class="card">
        <h2>Genres</h2>
        {#if above.length}<h3>Above your average</h3>{@render affList(above, false)}{/if}
        {#if below.length}<h3>Below</h3>{@render affList(below, false)}{/if}
        {#each contra as c}
          <p class="small note">You have {c.waiting} {c.genre.toLowerCase()} titles waiting on your list, yet rate the genre {c.avg.toFixed(1)} on average. Worth a second look at that list?</p>
        {/each}
      </section>
    {/if}

    {#if actors.length}
      <section class="card">
        <h2>Actors in what you love</h2>
        {@render affList(actors, true)}
      </section>
    {/if}

    {#if splits.length}
      <section class="card">
        <h2>Where you two disagree</h2>
        <ul class="gaps small">
          {#each splits as t}
            <li><a href={titleHref(t.id)}>{t.name}</a> <span class="muted">you {t.rating} · {data.value.partner || 'partner'} {t.partnerRating}</span></li>
          {/each}
        </ul>
      </section>
    {/if}

  </div>

  {#if pending.length}
    <p class="small muted pending">Still learning: {pending.join('; ')}.</p>
  {/if}

  <section class="section">
    <div class="spread">
      <h2>More from people you trust</h2>
      {#if people.length}<button class="small" onclick={discover} disabled={finding}>{finding ? 'Looking…' : found ? 'Look again' : 'Find films'}</button>{/if}
    </div>
    {#if !people.length}
      <p class="muted small">Rate two titles by the same director or writer (or anything 9 or 10) and Parde will find their other work. You can also search any person from Add.</p>
    {:else if !found}
      <p class="muted small">Other films by {people.slice(0, 4).map((p) => p.name).join(', ')}{people.length > 4 ? ' and others' : ''}. Looked up on Wikidata when you ask.</p>
    {:else if !visible.length}
      <p class="muted small">You already have everything we found.</p>
    {:else}
      <ul class="grid sugg">
        {#each visible as s (s.qid)}
          <li class="stack">
            <Poster src={s.wiki ? pics[s.wiki] : undefined} name={s.name} />
            <div>
              <div class="name">{s.name}</div>
              <div class="small muted">{s.year ?? ''} · <a href={personHref(s.via, nameOf.get(s.via) ?? '')}>{nameOf.get(s.via)}</a> {s.roles[0]}</div>
              <div class="small muted">{why(s.via)}</div>
            </div>
            <div class="row">
              <button class="small primary" onclick={() => want(s)}>Want</button>
              <button class="small ghost" onclick={() => dismiss(s)} aria-label="Not interested in {s.name}">Not for us</button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if diary.length}
    <section class="section">
      <h2>Recently finished</h2>
      <ul class="diary small">
        {#each diary as t (t.id)}
          <li><span class="muted">{formatDay(t.finishedAt!.slice(0, 10))}</span> <a href={titleHref(t.id)}>{t.name}</a> {#if t.rating}<span class="chip">{t.rating}/10</span>{/if}</li>
        {/each}
      </ul>
    </section>
  {/if}
{/if}

{#if decades.length >= 2}
  <section class="section card">
    <h2>Across time and place</h2>
    <div class="bars" role="list" aria-label="Watched titles by decade">
      {#each decades as [d, n]}
        {@const max = Math.max(...decades.map((x) => x[1]))}
        <div class="bar" role="listitem" aria-label="{d}: {n}"><span class="fill" style="height: {(n / max) * 100}%"></span><span class="small muted">{d.slice(2)}</span></div>
      {/each}
    </div>
    {#if countries.length}<p class="small" style="margin-top: 0.75rem"><span class="muted">From</span> {countries.map(([c, n]) => `${c} (${n})`).join(', ')}</p>{/if}
  </section>
{/if}

<style>
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.75rem; margin: 1rem 0 1rem; }
  .stats .card { display: grid; gap: 0.1rem; padding: 0.75rem 1rem; }
  .stats strong { font-family: var(--serif); font-size: 1.8rem; font-variant-numeric: tabular-nums; }
  @media (max-width: 640px) { .stats { grid-template-columns: repeat(2, 1fr); } }
  .lead { max-width: 60ch; margin-bottom: 1.25rem; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1rem; }
  @media (max-width: 400px) { .cards { grid-template-columns: 1fr; } }
  .cards h3 { font-family: var(--sans); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-top: 0.9rem; }
  .gaps, .aff { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.3rem; }
  .gaps a, .aff a { color: var(--text); }
  .note { margin-top: 0.75rem; padding: 0.6rem 0.75rem; background: var(--surface-2); border-radius: 8px; }
  .pending { margin-top: 1.25rem; }
  .bars { display: flex; gap: 0.4rem; align-items: flex-end; height: 120px; }
  .bar { flex: 1; display: grid; grid-template-rows: 1fr auto; justify-items: center; height: 100%; align-items: end; }
  .fill { width: 100%; background: var(--accent); border-radius: 4px 4px 0 0; min-height: 3px; }
  .diary { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.35rem; }
  .diary li { display: flex; gap: 0.6rem; align-items: center; }
  .diary .muted { min-width: 6.5rem; }
  .diary a { color: var(--text); }
  .sugg { list-style: none; padding: 0; margin: 0.75rem 0 0; }
  .sugg .name { font-weight: 600; font-size: 0.92rem; }
</style>
