<script lang="ts">
  import { db, getSetting, type Status, type Title } from '../lib/db';
  import { live } from '../lib/live.svelte';
  import { update, setStatus, refreshTitle, removeTitle, setSeen, deleteWatch } from '../lib/actions';
  import { progress, code, release, isAired, localDay, byOrder } from '../lib/schedule';
  import { resolveLinks, openExternal, hostOf } from '../lib/links';
  import { formatDay, ago, runtime } from '../lib/format';
  import { EXPECTATIONS, criticScore } from '../lib/taste';
  import { questionsFor, reflectPrompt, recapPrompt, claudeUrl } from '../lib/handoff';
  import { toast, errorText, copy } from '../lib/ui.svelte';
  import { go } from '../lib/router.svelte';
  import { editLink } from '../lib/actions';
  import { now } from '../lib/db';
  import Poster from '../components/Poster.svelte';
  import Scale from '../components/Scale.svelte';
  import Sources from '../components/Sources.svelte';
  import Episodes from '../components/Episodes.svelte';
  import LogWatch from '../components/LogWatch.svelte';

  let { id }: { id: string } = $props();

  const titleQ = live(() => () => db.titles.get(id), undefined as Title | undefined);
  const linksQ = live(() => () => db.links.where('titleId').equals(id).toArray(), []);
  const epsQ = live(() => () => db.episodes.where('titleId').equals(id).toArray().then((x) => x.sort(byOrder)), []);
  const seenQ = live(() => () => db.seen.where('titleId').equals(id).primaryKeys(), [] as number[]);
  const watchesQ = live(() => () => db.watches.where('titleId').equals(id).reverse().sortBy('date'), []);
  const partnerQ = live(() => () => getSetting('partner', ''), '');

  const t = $derived(titleQ.value);
  const seen = $derived(new Set(seenQ.value));
  const prog = $derived(progress(epsQ.value, seen));
  const next = $derived(prog.next);
  const nextSources = $derived(t?.kind === 'show' && next ? resolveLinks(linksQ.value, next.season, next.number) : resolveLinks(linksQ.value));
  const best = $derived(nextSources.find((r) => !r.link.broken));
  const rel = $derived(t ? release(t) : { kind: 'unknown' as const });
  const recent = $derived(epsQ.value.filter((e) => seen.has(e.id) && e.summary).slice(-3));
  const cs = $derived(t ? criticScore(t) : undefined);
  // One line per person: "Denis Villeneuve — director, writer"
  const makers = $derived(
    [...(t?.people.filter((p) => p.role !== 'cast') ?? []).reduce((m, p) => m.set(p.name, [...(m.get(p.name) ?? []), p.role]), new Map<string, string[]>())]
      .map(([name, roles]) => ({ name, role: roles.join(', ') })),
  );
  const cast = $derived(t?.people.filter((p) => p.role === 'cast') ?? []);

  let logOpen = $state(false);
  let note = $state<string | undefined>(undefined);
  let refreshing = $state(false);
  let showTrailer = $state(false);

  // Keep the draft local while typing; save on pause and on leaving the field.
  let noteTimer: ReturnType<typeof setTimeout>;
  function onNote() {
    clearTimeout(noteTimer);
    noteTimer = setTimeout(saveNote, 800);
  }
  function saveNote() {
    clearTimeout(noteTimer);
    if (t && note !== undefined && note !== (t.note ?? '')) update(t.id, { note });
  }
  $effect(() => {
    const flush = () => document.visibilityState === 'hidden' && saveNote();
    document.addEventListener('visibilitychange', flush);
    addEventListener('pagehide', saveNote);
    return () => {
      document.removeEventListener('visibilitychange', flush);
      removeEventListener('pagehide', saveNote);
      saveNote();
    };
  });

  const statuses = $derived<[Status, string][]>(
    t?.kind === 'film'
      ? [['want', 'Want to watch'], ['watched', 'Watched'], ['dropped', 'Not for us']]
      : [['want', 'Want to watch'], ['watching', 'Watching'], ['paused', 'Paused'], ['watched', 'Finished'], ['dropped', 'Dropped']],
  );

  async function openBest() {
    if (!best) return;
    if (!openExternal(best.url)) return toast('That link is not valid. Edit it below.', 'error');
    await editLink(best.link.id, { usedAt: now() });
  }

  async function refresh() {
    if (!t) return;
    refreshing = true;
    try {
      await refreshTitle(t, true);
      toast('Updated');
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      refreshing = false;
    }
  }

  async function remove() {
    if (!t || !confirm(`Remove ${t.name} and everything you recorded about it (ratings, notes, sources, episode marks)? This cannot be undone.`)) return;
    await removeTitle(t.id);
    toast(`Removed ${t.name}`);
    go('/library');
  }

  function handoff(prompt: string) {
    copy(prompt);
    window.open(claudeUrl(prompt), '_blank', 'noopener,noreferrer');
  }

  const trailerSearch = $derived(t ? `https://www.youtube.com/results?search_query=${encodeURIComponent(`${t.name} ${t.year ?? ''} ${t.kind === 'show' ? 'season 1 ' : ''}official trailer`)}` : '');
</script>

{#if !titleQ.ready}
  <p class="muted">Loading…</p>
{:else if !t}
  <div class="empty">This title is not in your library. <a href="#/library">Back to library</a></div>
{:else}
  <article class="fade">
    <div class="hero">
      <Poster src={t.poster} name={t.name} size="lg" />
      <div class="head stack">
        <div>
          <h1>{t.name}</h1>
          <p class="muted">
            {[t.year, t.kind === 'film' ? 'Film' : 'Series', runtime(t.runtime) && (t.kind === 'show' ? `${runtime(t.runtime)} episodes` : runtime(t.runtime)), t.network ?? t.webChannel, t.showStatus === 'Ended' ? 'Ended' : ''].filter(Boolean).join(' · ')}
          </p>
          {#if t.genres.length}<div class="row">{#each t.genres.slice(0, 5) as g}<a class="chip" href="#/library?genre={encodeURIComponent(g)}">{g}</a>{/each}</div>{/if}
        </div>

        {#if t.critics.length}
          <div class="row critics" aria-label="Scores">
            {#each t.critics as c}<span class="chip" title={c.source}><strong>{c.value}</strong> {c.source}</span>{/each}
          </div>
        {/if}

        <div class="row status" role="group" aria-label="Status">
          {#each statuses as [s, label]}
            <button class="chip" class:on={t.status === s} aria-pressed={t.status === s} onclick={() => setStatus(t, s)}>{label}</button>
          {/each}
        </div>

        <!-- The one thing to do next -->
        <div class="next card">
          {#if t.kind === 'show' && next}
            <div class="small muted">{prog.seenCount ? 'Up next' : 'Start with'}</div>
            <div class="next-ep"><strong>{code(next)}</strong> {next.name}</div>
            {#if !isAired(next)}
              <p class="small muted">{rel.kind === 'stream' ? `Released on ${rel.where}` : rel.kind === 'broadcast' ? `Airs on ${rel.where}` : 'Airs'} {formatDay(localDay(next))}</p>
            {/if}
            <div class="row">
              {#if best}
                <button class="primary" onclick={openBest}>Watch on {best.link.label || hostOf(best.url)} ↗</button>
              {/if}
              <button onclick={() => setSeen(next, true)} disabled={!isAired(next)}>Mark {code(next)} seen</button>
            </div>
            {#if !best}<p class="small muted">No source yet: open the episode below to add one, or save a whole-series pattern.</p>{/if}
          {:else if t.kind === 'show' && epsQ.value.length}
            <p>You are all caught up.{t.showStatus === 'Ended' ? '' : ' New episodes will appear on your calendar.'}</p>
            {#if t.status !== 'watched'}<button onclick={() => (logOpen = true)}>Log as finished</button>{/if}
          {:else if t.kind === 'film'}
            <div class="row">
              {#if best}<button class="primary" onclick={openBest}>Watch on {best.link.label || hostOf(best.url)} ↗</button>{/if}
              <button class:primary={!best} onclick={() => (logOpen = true)}>{t.status === 'watched' ? 'Log a rewatch' : 'We watched it'}</button>
            </div>
          {:else}
            <p class="muted small">No episodes listed yet.</p>
          {/if}
        </div>
      </div>
    </div>

    {#if t.kind === 'show' && recent.length && next && prog.seenCount}
      <section class="section card">
        <div class="spread">
          <h2>Previously</h2>
          {#if prog.lastSeen}<span class="small muted">You stopped at {code(prog.lastSeen)}</span>{/if}
        </div>
        {#each recent as e}
          <p class="small"><strong>{code(e)} {e.name}.</strong> {e.summary}</p>
        {/each}
        <button class="small" onclick={() => handoff(recapPrompt(t, prog.lastSeen!))}>Fuller recap in Claude ↗</button>
        <p class="small muted">Only episodes you have seen. The Claude prompt is copied too, and asks for nothing past {code(prog.lastSeen!)}.</p>
      </section>
    {/if}

    <div class="cols">
      <div class="main-col">
        {#if t.status !== 'watched' || t.expectation}
          <section class="section">
            <h2>After the trailer</h2>
            <p class="small muted">How keen are you? Parde later compares this with how much you actually enjoyed it.</p>
            <Scale max={5} value={t.expectation} labels={EXPECTATIONS} onpick={(v) => update(t.id, { expectation: v })} name="Expectation" />
            <div class="row" style="margin-top: 0.75rem">
              {#if t.trailer}
                {#if showTrailer}
                  <div class="video">
                    <iframe src="https://www.youtube-nocookie.com/embed/{t.trailer}?autoplay=1" title="Trailer for {t.name}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>
                  </div>
                {:else}
                  <button onclick={() => (showTrailer = true)}>▶ Play trailer</button>
                {/if}
              {/if}
              <a class="small" href={trailerSearch} target="_blank" rel="noopener noreferrer">{t.trailer ? 'Other trailers' : 'Find the trailer'} on YouTube ↗</a>
            </div>
          </section>
        {/if}

        {#if t.status === 'watched' || t.rating || t.status === 'watching' || t.status === 'dropped'}
          <section class="section">
            <h2>Your verdict</h2>
            <Scale max={10} value={t.rating} onpick={(v) => update(t.id, { rating: v })} name="Your rating" />
            {#if partnerQ.value || t.partnerRating}
              <p class="small muted" style="margin: 0.75rem 0 0.35rem">{partnerQ.value || 'Partner'}</p>
              <Scale max={10} value={t.partnerRating} onpick={(v) => update(t.id, { partnerRating: v })} name="Partner rating" />
            {/if}
            {#if t.rating && cs}
              <p class="small muted" style="margin-top: 0.5rem">{cs.kind === 'critics' ? 'Critics' : 'Audiences'}: {cs.score}/100 · you: {t.rating * 10}/100{Math.abs(t.rating * 10 - cs.score) >= 20 ? ` — you ${t.rating * 10 > cs.score ? 'liked it more' : 'liked it less'} than most` : ''}</p>
            {/if}
          </section>
        {/if}

        <section class="section">
          <h2>Thoughts</h2>
          {#if t.status === 'watched' || t.status === 'watching'}
            <ul class="questions small muted">
              {#each questionsFor(t.id) as q}<li>{q}</li>{/each}
            </ul>
          {/if}
          <label class="sr-only" for="note">Your notes</label>
          <textarea id="note" value={note ?? t.note ?? ''} oninput={(e) => { note = e.currentTarget.value; onNote(); }} onblur={saveNote} placeholder="What stayed with you? Interpretations, moments, arguments you had about it…"></textarea>
          {#if t.status === 'watched' || t.status === 'watching'}
            <button class="small" style="margin-top: 0.5rem" onclick={() => { saveNote(); handoff(reflectPrompt({ ...t, note: note ?? t.note })); }}>Think it through with Claude ↗</button>
          {/if}
        </section>

        {#if t.kind === 'show'}
          <section class="section">
            <div class="spread">
              <h2>Episodes</h2>
              <label class="row follow"><input type="checkbox" checked={!!t.followed} onchange={(e) => update(t.id, { followed: e.currentTarget.checked })} /> On my calendar</label>
            </div>
            {#if rel.kind !== 'unknown'}
              <p class="small muted">{rel.kind === 'stream' ? `Dates are ${rel.where}'s own release dates.` : `Dates are when it airs on ${rel.where} (shown in your time). Streaming sites may get it later.`}</p>
            {/if}
            <Episodes title={t} episodes={epsQ.value} {seen} links={linksQ.value} focus={next} />
          </section>
        {/if}

        <section class="section">
          <Sources title={t} links={linksQ.value} heading={t.kind === 'show' ? 'Sources for the whole series' : 'Where to watch'} />
        </section>
      </div>

      <aside class="side-col">
        {#if t.overview}
          <section class="section">
            <h2>About</h2>
            <p class="small">{t.overview}</p>
          </section>
        {/if}
        {#if makers.length || cast.length}
          <section class="section">
            <h2>People</h2>
            <ul class="people small">
              {#each makers as p}<li><a href="#/library?person={encodeURIComponent(p.name)}">{p.name}</a> <span class="muted">{p.role}</span></li>{/each}
              {#each cast.filter((c) => !makers.some((m) => m.name === c.name)) as p}<li><a href="#/library?person={encodeURIComponent(p.name)}">{p.name}</a></li>{/each}
            </ul>
          </section>
        {/if}
        {#if t.subjects.length || t.countries.length || t.languages.length}
          <section class="section small">
            {#if t.subjects.length}<p><span class="muted">About</span> {t.subjects.join(', ')}</p>{/if}
            {#if t.countries.length}<p><span class="muted">From</span> {t.countries.join(', ')}</p>{/if}
            {#if t.languages.length}<p><span class="muted">In</span> {t.languages.join(', ')}</p>{/if}
          </section>
        {/if}
        {#if watchesQ.value.length}
          <section class="section">
            <h2>History</h2>
            <ul class="history small">
              {#each watchesQ.value as w (w.id)}
                <li class="spread"><span>{formatDay(w.date)} · {w.together ? 'together' : 'solo'}</span><button class="small ghost" onclick={() => deleteWatch(w.id)} aria-label="Delete this viewing">✕</button></li>
              {/each}
            </ul>
          </section>
        {/if}
        <section class="section small stack">
          <div class="row links">
            {#if t.wiki}<a href="https://en.wikipedia.org/wiki/{encodeURIComponent(t.wiki.replace(/ /g, '_'))}" target="_blank" rel="noopener noreferrer">Wikipedia ↗</a>{/if}
            {#if t.imdb}<a href="https://www.imdb.com/title/{t.imdb}/" target="_blank" rel="noopener noreferrer">IMDb ↗</a>{/if}
            {#if t.tvmaze}<a href="https://www.tvmaze.com/shows/{t.tvmaze}" target="_blank" rel="noopener noreferrer">TVmaze ↗</a>{/if}
            {#if t.qid}<a href="https://www.wikidata.org/wiki/{t.qid}" target="_blank" rel="noopener noreferrer">Wikidata ↗</a>{/if}
          </div>
          <p class="muted">Added {ago(t.addedAt)}{t.syncedAt ? ` · episodes checked ${ago(t.syncedAt)}` : ''}</p>
          <div class="row">
            <button class="small" onclick={refresh} disabled={refreshing}>{refreshing ? 'Updating…' : 'Refresh details'}</button>
            <button class="small danger" onclick={remove}>Remove</button>
          </div>
        </section>
      </aside>
    </div>
  </article>

  <LogWatch title={t} bind:open={logOpen} partner={partnerQ.value} />
{/if}

<style>
  .hero { display: flex; gap: 1.5rem; align-items: flex-start; }
  .head { flex: 1; min-width: 0; }
  .critics .chip strong { font-variant-numeric: tabular-nums; }
  .next { display: grid; gap: 0.5rem; }
  .next-ep { font-size: 1.1rem; }
  .cols { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 2rem; }
  .questions { margin: 0 0 0.75rem; padding-left: 1.2rem; }
  .people, .history { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.3rem; }
  .people a { color: var(--text); }
  .follow { color: var(--text); margin: 0; gap: 0.4rem; }
  .follow input { accent-color: var(--accent); width: 18px; height: 18px; }
  .video { width: 100%; aspect-ratio: 16 / 9; border-radius: 10px; overflow: hidden; background: #000; }
  .video iframe { width: 100%; height: 100%; border: 0; }
  .links { gap: 1rem; }
  @media (max-width: 860px) {
    .cols { grid-template-columns: 1fr; gap: 0; }
  }
  @media (max-width: 560px) {
    .hero { flex-direction: column; align-items: center; text-align: center; }
    .hero :global(.row) { justify-content: center; }
    .next { text-align: left; }
  }
</style>
