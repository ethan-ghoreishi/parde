<script lang="ts">
  import { db, getSetting, type Dismissed, type Title } from '../lib/db';
  import { live } from '../lib/live.svelte';
  import { titleHref, personHref } from '../lib/router.svelte';
  import {
    trailerInstinct, versusCritics, makerAffinity, castAffinity, genreAffinity, themeAffinity, contradictions, scoreBands, compare, drawnOutcomes,
    partnerSplits, counts, decade, rated, mean, reliable, type Affinity, type Gap, type Tally,
  } from '../lib/taste';
  import { formatDay } from '../lib/format';
  import DiscoverTabs from '../components/DiscoverTabs.svelte';

  const data = live(
    () => async () => ({ titles: await db.titles.toArray(), dismissed: await db.dismissed.toArray(), partner: await getSetting('partner', '') }),
    { titles: [] as Title[], dismissed: [] as Dismissed[], partner: '' },
  );

  const titles = $derived(data.value.titles);
  const r = $derived(rated(titles));
  const watched = $derived(titles.filter((t) => t.status === 'watched'));
  const avg = $derived(mean(r.map((t) => t.rating!)));
  const instinct = $derived(trailerInstinct(titles));
  const critics = $derived(versusCritics(titles));
  const bands = $derived(scoreBands(titles, data.value.dismissed));
  const drawn = $derived(drawnOutcomes(titles).filter((d) => d.n >= 2));
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
  const ratedN = $derived(r.length);
  const withMakers = $derived(r.filter((t) => t.people.some((p) => p.role !== 'cast' && p.role !== 'composer')).length);
  const likedIds = $derived(new Set(liked.map((m) => m.qid ?? m.key)));
  // Already on your list, by people you rate highly: the most actionable thing here.
  const queued = $derived(titles.filter((t) => t.status === 'want' && t.people.some((p) => p.role !== 'cast' && likedIds.has(p.qid ?? p.name))).slice(0, 5));

  // ----- Scores and you -----
  const sourceName: Record<string, string> = { Metacritic: 'Metacritic', 'Rotten Tomatoes': 'the Tomatometer', 'Rotten Tomatoes average': 'the critics’ average on Rotten Tomatoes' };
  const chosen = $derived(bands.reduce((n, b) => n + b.blind.n + b.aware.n, 0));
  // The top band against the lowest one with enough in it to compare.
  const other = $derived(bands[2].ratings.length >= 5 ? bands[2] : bands[1]);
  const enjoy = $derived(compare(bands[0].ratings, other.ratings));
  const low = $derived(bands[2].ratings.length);
  const of = (t: Tally) => (t.n ? `${t.yes} of ${t.n}` : '–');
  const inBand = $derived(bands.reduce((n, b) => n + b.ratings.length, 0));
  const showBands = $derived(inBand >= 5 || chosen >= 4);

  // What would unlock more, said once rather than as a wall of locked cards.
  const pending = $derived(
    [
      instinct.n < 4 && `trailer instinct, after ${4 - instinct.n} more title${4 - instinct.n > 1 ? 's' : ''} with a “how keen” from before watching and a rating`,
      !showBands && 'how scores sway you, as you rate films and choose in Discover',
      !makers.length && 'people you trust, once you rate two titles by the same director or writer',
      !themesA.length && 'recurring themes, once three rated titles share one',
    ].filter((x): x is string => !!x),
  );
</script>

{#snippet gapList(items: Gap[])}
  <ul class="gaps small">
    {#each items as g (g.title.id)}
      <li><a href={titleHref(g.title.id)}>{g.title.name}</a> <span class="muted">{g.ref} · you {g.title.rating}/10</span></li>
    {/each}
  </ul>
{/snippet}

<!-- Every pattern opens to the titles and ratings it rests on. -->
{#snippet affList(items: Affinity[], people: boolean)}
  <ul class="aff small">
    {#each items as a (a.qid ?? a.key)}
      <li>
        <details>
          <summary><strong>{a.key}</strong> <span class="muted">{a.avg.toFixed(1)} over {a.n}{a.n < 4 ? ', an early sign' : ''}</span></summary>
          <p>{#each a.of.slice(0, 8) as t, i (t.id)}<a href={titleHref(t.id)}>{t.name}</a> {t.rating}{i < Math.min(a.of.length, 8) - 1 ? ', ' : ''}{/each}{a.of.length > 8 ? '…' : ''}</p>
          {#if people}
            <p class="row">{#if a.qid}<a class="chip" href="#/discover?{new URLSearchParams({ from: `person:${a.qid}`, name: a.key })}">Explore their work</a>{/if}<a class="chip" href={personHref(a.qid, a.key)}>Filmography</a></p>
          {/if}
        </details>
      </li>
    {/each}
  </ul>
{/snippet}

<DiscoverTabs current="taste" />
<h1>Your taste</h1>

{#if data.ready && !titles.length}
  <div class="empty">
    <p>What you rate and choose in Discover shows up here as patterns, each with the titles behind it.</p>
    <a class="btn primary" href="#/discover">Start with what you have seen</a>
  </div>
{:else}
  <div class="stats">
    <div class="card"><strong>{watched.filter((t) => t.kind === 'film').length}</strong><span class="small muted">films seen</span></div>
    <div class="card"><strong>{watched.filter((t) => t.kind === 'show').length}</strong><span class="small muted">series finished</span></div>
    <div class="card"><strong>{thisYear}</strong><span class="small muted">with a date this year</span></div>
    <div class="card"><strong>{Number.isNaN(avg) ? '–' : avg.toFixed(1)}</strong><span class="small muted">average of {r.length} rating{r.length === 1 ? '' : 's'}</span></div>
  </div>

  <p class="small muted lead">Open any pattern to see the titles behind it. A few titles are an early sign, not a conclusion, and you mostly rate what you chose to watch, so things you avoid are barely represented.</p>

  <div class="cards">
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

    {#if showBands}
      <section class="card">
        <h2>Scores and you</h2>
        <div class="scroll">
          <table class="small">
            <caption class="sr-only">By Tomatometer: how you rated, and how often you said yes in Discover before and after opening the scores</caption>
            <thead><tr><th scope="col">Critics positive</th><th scope="col">You rated</th><th scope="col">Said yes unseen</th><th scope="col">Said yes knowing</th></tr></thead>
            <tbody>
              {#each bands as b (b.label)}
                <tr><th scope="row">{b.label}</th><td>{b.ratings.length ? `${mean(b.ratings).toFixed(1)} (${b.ratings.length})` : '–'}</td><td>{of(b.blind)}</td><td>{of(b.aware)}</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="small">
          {#if enjoy === 'few'}Too few rated so far to compare.
          {:else if enjoy === 'unclear'}No reliable difference yet between how you rate 80% or more and {other.label}.
          {:else}You rate 80% or more {enjoy === 'higher' ? 'higher' : 'lower'} than {other.label}, by more than chance.{/if}
          {#if low < 5}You have rated {low || 'none'} under 60%: too few to say whether a low score would steer you right.{/if}
        </p>
        {#if critics.n >= 5}
          <p class="small">Your order {describeR(critics.r, critics.n)} {sourceName[critics.source]} ({critics.n} of your {ratedN} rated titles have it).</p>
        {/if}
        {#if critics.n >= 8 && critics.warmer.length}<h3>You place higher than critics do</h3>{@render gapList(critics.warmer)}{/if}
        {#if critics.n >= 8 && critics.colder.length}<h3>Critics place higher than you do</h3>{@render gapList(critics.colder)}{/if}
        <p class="small muted">“Unseen” means before you opened the scores in Discover. Audience scores (Rotten Tomatoes, IMDb) have no open source, so ideas about critics and audiences disagreeing can only be tested by what drew you, below.</p>
      </section>
    {/if}

    {#if drawn.length}
      <section class="card">
        <h2>What draws you in</h2>
        <ul class="gaps small">
          {#each drawn as d (d.why)}
            <li><strong>{d.why}</strong> <span class="muted">{d.n} chosen{d.ratings.length ? `, ${d.ratings.length} watched: ${mean(d.ratings).toFixed(1)} on average` : ', none rated yet'}{d.ratings.length && d.ratings.length < 4 ? ', an early sign' : ''}</span></li>
          {/each}
        </ul>
        <p class="small muted">Against {Number.isNaN(avg) ? 'your average' : `${avg.toFixed(1)} overall`}. From the reasons you tapped before watching.</p>
      </section>
    {/if}

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
        <p class="small muted">{instinct.blind} said before opening the scores, {instinct.aware} after{instinct.n - instinct.blind - instinct.aware ? `, ${instinct.n - instinct.blind - instinct.aware} from before Parde kept track` : ''}.</p>
        {#if instinct.surprises.length}<h3>Better than the trailer</h3>{@render gapList(instinct.surprises)}{/if}
        {#if instinct.letdowns.length}<h3>The trailer oversold it</h3>{@render gapList(instinct.letdowns)}{/if}
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
          <p class="small note">Titles about <strong>{a.key}</strong> {a.lift > 0 ? 'move you more than most' : 'land less well with you'}: {a.avg.toFixed(1)} over {a.n} ({strength(a.n)}). <a href="#/discover?{new URLSearchParams({ from: `about:${a.key}` })}">Find others</a></p>
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
    <div class="bars" role="list" aria-label="Seen titles by decade">
      {#each decades as [d, n]}
        {@const max = Math.max(...decades.map((x) => x[1]))}
        <div class="bar" role="listitem" aria-label="{d}: {n}"><span class="small">{n}</span><span class="fill" style="height: {(n / max) * 100}%"></span><span class="small muted">{d.slice(2)}</span></div>
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
  .bars { display: flex; gap: 0.4rem; align-items: flex-end; height: 150px; }
  .bar { flex: 1; display: grid; grid-template-rows: auto 1fr auto; justify-items: center; height: 100%; align-items: end; }
  summary { cursor: pointer; min-height: 36px; display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
  summary::-webkit-details-marker { display: none; }
  summary::before { content: '▸'; color: var(--muted); }
  details[open] summary::before { content: '▾'; }
  .aff p { margin: 0.1rem 0 0.5rem 1rem; }
  .scroll { overflow-x: auto; margin-bottom: 0.75rem; }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 0.4rem 0.6rem 0.4rem 0; border-bottom: 1px solid var(--line); font-weight: 400; vertical-align: bottom; }
  thead th { color: var(--muted); }
  .empty p { margin-bottom: 0.75rem; }
  .fill { width: 100%; background: var(--accent); border-radius: 4px 4px 0 0; min-height: 3px; }
  .diary { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.35rem; }
  .diary li { display: flex; gap: 0.6rem; align-items: center; }
  .diary .muted { min-width: 6.5rem; }
  .diary a { color: var(--text); }
</style>
