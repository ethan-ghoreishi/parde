<script lang="ts">
  import { db, now, type Title } from '../lib/db';
  import { live } from '../lib/live.svelte';
  import { titleHref } from '../lib/router.svelte';
  import {
    EXPECTATIONS, trailerInstinct, versusCritics, makerAffinity, genreAffinity, contradictions, partnerSplits,
    counts, decade, rated, mean, type Gap,
  } from '../lib/taste';
  import { filmsByPeople, wikiSummary, type Suggestion } from '../lib/api/wiki';
  import { addFilm } from '../lib/actions';
  import { toast, errorText } from '../lib/ui.svelte';
  import { getSetting } from '../lib/db';
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
  const instinct = $derived(trailerInstinct(titles));
  const critics = $derived(versusCritics(titles));
  const makers = $derived(makerAffinity(titles));
  const genresA = $derived(genreAffinity(titles));
  const contra = $derived(contradictions(titles));
  const splits = $derived(partnerSplits(titles));
  const decades = $derived(counts(watched.map((t) => decade(t.year)).filter((x): x is string => !!x), 10).sort((a, b) => a[0].localeCompare(b[0])));
  const countries = $derived(counts(watched.flatMap((t) => t.countries), 8));
  const subjects = $derived(counts(r.filter((t) => t.rating! >= 8).flatMap((t) => t.subjects), 10).filter(([, n]) => n >= 2));
  const avg = $derived(mean(r.map((t) => t.rating!)));
  const thisYear = $derived(watched.filter((t) => t.finishedAt?.startsWith(String(new Date().getFullYear()))).length);

  const pct = (n: number) => `${Math.round(n)}`;
  const describeR = (x: number) =>
    Number.isNaN(x) ? '' : x >= 0.5 ? 'strongly predicts' : x >= 0.25 ? 'somewhat predicts' : x > -0.1 ? 'barely predicts' : 'runs against';

  // ----- Discovery -----
  let suggestions = $state<Suggestion[]>([]);
  let posters = $state<Record<string, string>>({});
  let finding = $state(false);
  let found = $state(false);
  const trusted = $derived(makers.filter((m) => m.qid && (m.lift > 0.3 || m.avg >= 8)).slice(0, 10));
  const fallbackTrusted = $derived(
    r.filter((t) => t.rating! >= 9).flatMap((t) => t.people.filter((p) => p.qid && (p.role === 'director' || p.role === 'writer' || p.role === 'creator'))).slice(0, 10),
  );
  const people = $derived(
    trusted.length ? trusted.map((m) => ({ qid: m.qid!, name: m.key })) : [...new Map(fallbackTrusted.map((p) => [p.qid!, { qid: p.qid!, name: p.name }])).values()],
  );
  const owned = $derived(new Set(titles.map((t) => t.qid).filter(Boolean)));
  const visible = $derived(suggestions.filter((s) => !owned.has(s.qid) && !data.value.dismissed.has(s.qid)).slice(0, 18));

  async function discover() {
    finding = true;
    try {
      suggestions = (await filmsByPeople(people)).sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
      found = true;
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      finding = false;
    }
  }

  $effect(() => {
    for (const s of visible) {
      if (posters[s.qid] === undefined) {
        posters[s.qid] = '';
        wikiSummary(s.wiki).then((x) => x.poster && (posters[s.qid] = x.poster)).catch(() => {});
      }
    }
  });

  async function want(s: Suggestion) {
    try {
      await addFilm(s.qid, s.wiki);
      toast(`${s.name} added to your list`);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }
  const dismiss = (s: Suggestion) => db.dismissed.put({ qid: s.qid, at: now() });
</script>

{#snippet gapList(items: Gap[], kind: 'trailer' | 'critics')}
  <ul class="gaps small">
    {#each items as g}
      <li>
        <a href={titleHref(g.title.id)}>{g.title.name}</a>
        <span class="muted">
          {kind === 'trailer' ? `${EXPECTATIONS[g.title.expectation!]} → ${g.title.rating}/10` : `critics ${g.ref} · you ${g.title.rating! * 10}`}
        </span>
      </li>
    {/each}
  </ul>
{/snippet}

{#snippet locked(text: string, have: number, need: number)}
  <p class="muted small">{text} <span class="chip">{have}/{need}</span></p>
{/snippet}

<h1>Your taste</h1>

{#if data.ready && !titles.length}
  <div class="empty">Insights grow from what you add, rate and note. Start with a few films you know well.</div>
{:else}
  <div class="stats">
    <div class="card"><strong>{watched.filter((t) => t.kind === 'film').length}</strong><span class="small muted">films watched</span></div>
    <div class="card"><strong>{watched.filter((t) => t.kind === 'show').length}</strong><span class="small muted">series finished</span></div>
    <div class="card"><strong>{thisYear}</strong><span class="small muted">finished this year</span></div>
    <div class="card"><strong>{Number.isNaN(avg) ? '–' : avg.toFixed(1)}</strong><span class="small muted">your average rating</span></div>
  </div>

  <div class="cards">
    <section class="card">
      <h2>Trailer instinct</h2>
      {#if instinct.n >= 5}
        <p>Across {instinct.n} titles, how keen you were after the trailer <strong>{describeR(instinct.r)}</strong> how much you enjoyed it{Number.isNaN(instinct.r) ? '' : ` (r = ${instinct.r.toFixed(2)})`}.</p>
        {#if instinct.surprises.length}<h3>Pleasant surprises</h3>{@render gapList(instinct.surprises, 'trailer')}{/if}
        {#if instinct.letdowns.length}<h3>Trailer oversold it</h3>{@render gapList(instinct.letdowns, 'trailer')}{/if}
      {:else}
        {@render locked('Note how keen you are after a trailer, then rate it once watched.', instinct.n, 5)}
      {/if}
    </section>

    <section class="card">
      <h2>You and the critics</h2>
      {#if critics.n >= 5}
        <p>
          On average you rate {Math.abs(critics.meanGap) < 3 ? 'about the same as' : `${pct(Math.abs(critics.meanGap))} points ${critics.meanGap > 0 ? 'warmer than' : 'colder than'}`} critics,
          and their scores {describeR(critics.r)} yours.
        </p>
        {#if critics.warmer.length}<h3>You liked more than critics</h3>{@render gapList(critics.warmer, 'critics')}{/if}
        {#if critics.colder.length}<h3>Critics liked more than you</h3>{@render gapList(critics.colder, 'critics')}{/if}
      {:else}
        {@render locked('Rate films that have Rotten Tomatoes or Metacritic scores.', critics.n, 5)}
      {/if}
    </section>

    <section class="card">
      <h2>People you trust</h2>
      {#if makers.length}
        <ul class="aff small">
          {#each makers.filter((m) => m.lift > 0).slice(0, 8) as m}
            <li><a href="#/library?person={encodeURIComponent(m.key)}">{m.key}</a> <span class="muted">{m.avg.toFixed(1)} avg · {m.n} titles</span></li>
          {/each}
        </ul>
        {#if makers.some((m) => m.lift < -1)}
          <h3>Not really your people</h3>
          <ul class="aff small">
            {#each makers.filter((m) => m.lift < -1).slice(-4).reverse() as m}
              <li>{m.key} <span class="muted">{m.avg.toFixed(1)} avg · {m.n} titles</span></li>
            {/each}
          </ul>
        {/if}
      {:else}
        {@render locked('Rate at least two titles by the same director, writer or creator.', 0, 2)}
      {/if}
    </section>

    <section class="card">
      <h2>Genres</h2>
      {#if genresA.length >= 2}
        <h3>Above your average</h3>
        <p class="small">{genresA.filter((g) => g.lift > 0.3).slice(0, 6).map((g) => `${g.key} (${g.avg.toFixed(1)})`).join(', ') || 'None stand out yet.'}</p>
        <h3>Below</h3>
        <p class="small">{genresA.filter((g) => g.lift < -0.3).slice(-6).reverse().map((g) => `${g.key} (${g.avg.toFixed(1)})`).join(', ') || 'None stand out yet.'}</p>
      {:else}
        {@render locked('Rate three or more titles in a couple of genres.', genresA.length, 2)}
      {/if}
      {#each contra as c}
        <p class="small contra">You have {c.waiting} {c.genre.toLowerCase()} titles waiting on your list, yet rate the genre {Math.abs(c.lift).toFixed(1)} below your average. Worth a second look at that list?</p>
      {/each}
    </section>

    {#if subjects.length}
      <section class="card">
        <h2>What draws you in</h2>
        <p class="small muted">Recurring subjects among titles you rated 8 or more.</p>
        <div class="row">{#each subjects as [s, n]}<span class="chip">{s} · {n}</span>{/each}</div>
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

    {#if decades.length >= 2}
      <section class="card">
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
  </div>

  <section class="section">
    <div class="spread">
      <h2>More from people you trust</h2>
      {#if people.length}<button class="small" onclick={discover} disabled={finding}>{finding ? 'Looking…' : found ? 'Look again' : 'Find films'}</button>{/if}
    </div>
    {#if !people.length}
      <p class="muted small">Rate films 9 or 10 (or two by the same director) and Parde will find their other work.</p>
    {:else if !found}
      <p class="muted small">Other films by {people.slice(0, 4).map((p) => p.name).join(', ')}{people.length > 4 ? ' and others' : ''}. Looked up on Wikidata when you ask.</p>
    {:else if !visible.length}
      <p class="muted small">You have already got everything we found.</p>
    {:else}
      <ul class="grid sugg">
        {#each visible as s (s.qid)}
          <li class="stack">
            <Poster src={posters[s.qid] || undefined} name={s.name} />
            <div>
              <div class="name">{s.name}</div>
              <div class="small muted">{s.year ?? ''} · {s.via} {s.role}</div>
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
{/if}

<style>
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.75rem; margin: 1rem 0 1.5rem; }
  .stats .card { display: grid; gap: 0.1rem; padding: 0.75rem 1rem; }
  .stats strong { font-family: var(--serif); font-size: 1.8rem; font-variant-numeric: tabular-nums; }
  @media (max-width: 640px) { .stats { grid-template-columns: repeat(2, 1fr); } }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1rem; }
  @media (max-width: 400px) { .cards { grid-template-columns: 1fr; } }
  .cards h3 { font-family: var(--sans); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-top: 0.9rem; }
  .gaps, .aff { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.3rem; }
  .gaps a, .aff a { color: var(--text); }
  .contra { margin-top: 0.75rem; padding: 0.6rem 0.75rem; background: var(--surface-2); border-radius: 8px; }
  .bars { display: flex; gap: 0.4rem; align-items: flex-end; height: 120px; }
  .bar { flex: 1; display: grid; grid-template-rows: 1fr auto; justify-items: center; height: 100%; align-items: end; }
  .fill { width: 100%; background: var(--accent); border-radius: 4px 4px 0 0; min-height: 3px; }
  .sugg { list-style: none; padding: 0; margin: 0.75rem 0 0; }
  .sugg .name { font-weight: 600; font-size: 0.92rem; }
</style>
