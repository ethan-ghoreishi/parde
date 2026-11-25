<script lang="ts">
  import { db, getSetting, type Status, type Title } from '../lib/db';
  import { live } from '../lib/live.svelte';
  import { update, setStatus, setExpectation, refreshTitle, removeTitle, sawScores, setSeen, seenUpTo, deleteWatch, editLink, type Undo } from '../lib/actions';
  import { progress, completeSchedule, code, release, isAired, localDay, byOrder, onCalendar } from '../lib/schedule';
  import { resolveLinks, openExternal, hostOf } from '../lib/links';
  import { formatDay, ago, runtime } from '../lib/format';
  import { EXPECTATIONS } from '../lib/taste';
  import { premise } from '../lib/discover';
  import { questionsFor, reflectPrompt, reviewPrompt, recapPrompt, finishedAll, ASSISTANTS, type ReviewOptions } from '../lib/handoff';
  import { toast, undoable, errorText, copy } from '../lib/ui.svelte';
  import { go, personHref } from '../lib/router.svelte';
  import { now } from '../lib/db';
  import Poster from '../components/Poster.svelte';
  import Scale from '../components/Scale.svelte';
  import Sources from '../components/Sources.svelte';
  import Episodes from '../components/Episodes.svelte';
  import LogWatch from '../components/LogWatch.svelte';
  import ProgressPicker from '../components/ProgressPicker.svelte';
  import Themes from '../components/Themes.svelte';
  import Scores from '../components/Scores.svelte';
  import Drawn from '../components/Drawn.svelte';

  let { id }: { id: string } = $props();

  const titleQ = live(() => () => db.titles.get(id), undefined as Title | undefined);
  const linksQ = live(() => () => db.links.where('titleId').equals(id).toArray(), []);
  const epsQ = live(() => () => db.episodes.where('titleId').equals(id).toArray().then((x) => x.sort(byOrder)), []);
  const seenQ = live(() => () => db.seen.where('titleId').equals(id).primaryKeys(), [] as number[]);
  const watchesQ = live(() => () => db.watches.where('titleId').equals(id).reverse().sortBy('date'), []);
  const partnerQ = live(() => () => getSetting('partner', ''), '');
  const libraryQ = live(() => () => db.titles.toArray(), [] as Title[]);

  const t = $derived(titleQ.value);
  const seen = $derived(new Set(seenQ.value));
  const prog = $derived(progress(epsQ.value, seen));
  const next = $derived(prog.next);
  const nextSources = $derived(t?.kind === 'show' && next ? resolveLinks(linksQ.value, next.season, next.number) : resolveLinks(linksQ.value));
  const best = $derived(nextSources.find((r) => !r.broken));
  const rel = $derived(t ? release(t) : { kind: 'unknown' as const });
  const recent = $derived(epsQ.value.filter((e) => seen.has(e.id) && e.summary).slice(-3));
  // One line per person: "Denis Villeneuve — director, writer"
  const makers = $derived(
    [...(t?.people.filter((p) => p.role !== 'cast') ?? []).reduce((m, p) => m.set(p.name, [...(m.get(p.name) ?? []), p.role]), new Map<string, string[]>())]
      .map(([name, roles]) => ({ name, role: roles.join(', '), qid: t?.people.find((p) => p.name === name && p.qid)?.qid })),
  );
  const cast = $derived(t?.people.filter((p) => p.role === 'cast') ?? []);
  // Once you have started or watched it, "how keen were you?" would be hindsight: keep it as it was.
  const expectationLocked = $derived(
    !!t && (t.status === 'watched' || t.status === 'watching' || t.status === 'paused' || t.firstWatchedAt || t.finishedAt || t.rating !== undefined || prog.seenCount > 0),
  );
  /** Not started: what you need is what it is and where to find it, not somewhere to write about it */
  const ahead = $derived(!!t && !expectationLocked && t.status !== 'dropped');
  const place = $derived({ ...prog, scheduleVerified: !!t && completeSchedule(t, epsQ.value) });
  const finished = $derived(!!t && finishedAll(t, place));
  $effect(() => {
    if (t) document.title = `${t.name} · Parde`;
  });

  let logOpen = $state(false);
  let note = $state<string | undefined>(undefined);
  let refreshing = $state(false);
  let noteWrite = 0;
  let submittedNote: string | undefined;
  let showTrailer = $state(false);

  // Keep the draft local while typing; save on pause and on leaving the field.
  let noteTimer: ReturnType<typeof setTimeout>;
  function onNote() {
    noteWrite++;
    noteState = '';
    clearTimeout(noteTimer);
    noteTimer = setTimeout(saveNote, 800);
  }
  let noteState = $state<'' | 'saving' | 'saved'>('');
  function saveNote() {
    clearTimeout(noteTimer);
    if (!t || note === undefined || note === (submittedNote ?? t.note ?? '')) return;
    submittedNote = note;
    const write = ++noteWrite;
    noteState = 'saving';
    update(t.id, { note }).then(
      () => { if (write === noteWrite) noteState = 'saved'; },
      (e) => {
        if (write === noteWrite) { submittedNote = undefined; noteState = ''; }
        toast(`Your note is not saved: ${errorText(e)}`, 'error');
      },
    );
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
    await editLink(best.link.id, { usedAt: now() }).catch((e) => toast(errorText(e), 'error'));
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
    if (!t || !confirm(`Remove ${t.name} and everything you recorded about it (ratings, notes, sources, episode marks)?`)) return;
    const name = t.name;
    if (await act(`Removed ${name}`, () => removeTitle(id))) go('/library');
  }

  /** Save, then say so, with a way back. */
  async function act(text: string, run: () => Promise<Undo>): Promise<boolean> {
    try {
      undoable(text, await run());
      return true;
    } catch (e) {
      toast(`Not saved: ${errorText(e)}`, 'error');
      return false;
    }
  }
  async function pickStatus(s: Status, label: string) {
    if (!t || t.status === s) return;
    const marked = t.kind === 'show' && s === 'watched' && prog.unseenAired > 0;
    await act(marked ? `Finished: ${prog.unseenAired} more episode${prog.unseenAired > 1 ? 's' : ''} marked seen` : `${t.name}: ${label.toLowerCase()}`, () => setStatus(t, s));
  }
  // The next episode takes this one's place on screen: a second tap just after must not mark it too.
  let settling = $state(false);
  async function seenNext() {
    if (!next || settling) return;
    settling = true;
    await act(`${code(next)} seen`, () => setSeen(next, true));
    setTimeout(() => (settling = false), 700);
  }

  /** Copy first (inside the tap, as browsers require), then open an empty chat to paste into. */
  function handoff(prompt: string, where: keyof typeof ASSISTANTS = 'claude') {
    copy(prompt, 'Prompt copied: paste it into the new chat');
    window.open(ASSISTANTS[where], '_blank', 'noopener,noreferrer');
  }

  // ----- After watching: a review or a deeper look, written by an assistant of your choice -----
  let mode = $state<'review' | 'reflect'>('review');
  let opts = $state<ReviewOptions>({ length: 'short', spoilers: false });
  const reflectable = $derived(!!t && (t.status === 'watched' || t.status === 'watching' || t.rating !== undefined));
  const prompt = $derived.by(() => {
    if (!t) return '';
    const cur = { ...t, note: note ?? t.note };
    return mode === 'review' ? reviewPrompt(cur, libraryQ.value, opts, place) : reflectPrompt(cur, libraryQ.value, place);
  });
  function send(where: 'copy' | keyof typeof ASSISTANTS) {
    saveNote();
    if (where === 'copy') copy(prompt);
    else handoff(prompt, where);
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
          {#if t.genres.length}<div class="row">{#each t.genres.slice(0, 4) as g}<a class="chip" href="#/library?genre={encodeURIComponent(g)}">{g}</a>{/each}</div>{/if}
        </div>

        {#if ahead && premise(t.overview)}<p class="premise">{premise(t.overview)}</p>{/if}

        <div class="row status" role="group" aria-label="Status">
          {#each statuses as [s, label]}
            <button class="chip" class:on={t.status === s} aria-pressed={t.status === s} onclick={() => pickStatus(s, label)}>{label}</button>
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
                <button class="ghost small" onclick={() => copy(best.url)} aria-label="Copy the link for {code(next)}">Copy link</button>
              {/if}
              <button onclick={seenNext} disabled={!isAired(next) || settling}>Mark {code(next)} seen</button>
            </div>
            {#if !best}<a class="small" href="#sources" onclick={(e) => { e.preventDefault(); document.getElementById('sources')?.scrollIntoView(); }}>Add where you watch it ↓</a>{/if}
            <ProgressPicker titleId={t.id} label={prog.seenCount ? 'Seen up to' : 'Seen some already? Up to'} />
          {:else if t.kind === 'show' && epsQ.value.length}
            <p>{finished ? 'You’ve finished the series.' : t.showStatus === 'Ended' ? 'You’ve reached the end of the available schedule. Check the episode list if anything is missing.' : 'There are no more dated episodes in this schedule.'}</p>
            {#if t.status !== 'watched'}<button onclick={() => (logOpen = true)}>Log as finished</button>{/if}
            <ProgressPicker titleId={t.id} />
          {:else if t.kind === 'film'}
            <div class="row">
              {#if best}<button class="primary" onclick={openBest}>Watch on {best.link.label || hostOf(best.url)} ↗</button>{/if}
              <button class:primary={!best} onclick={() => (logOpen = true)}>{t.status === 'watched' ? 'Log a rewatch' : 'We watched it'}</button>
            </div>
          {:else}
            <p class="muted small">No episodes listed yet.</p>
          {/if}
          {#if t.kind === 'show' && prog.skipped}
            <p class="small muted">
              {prog.skipped} earlier episode{prog.skipped > 1 ? 's are' : ' is'} not marked seen.
              <button class="small ghost" onclick={() => act(`Seen up to ${code(prog.lastSeen!)}`, () => seenUpTo(prog.lastSeen!))}>Mark {prog.skipped > 1 ? 'them' : 'it'} seen</button>
            </p>
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
        <button class="small" onclick={() => handoff(recapPrompt(t, prog.lastSeen!, prog.skipped))}>Fuller recap in Claude ↗</button>
        <p class="small muted">Only episodes you have seen. Copies a prompt that asks for nothing past {code(prog.lastSeen!)} and opens a new Claude chat to paste it into.</p>
      </section>
    {/if}

    <div class="cols">
      <div class="main-col">
        {#if expectationLocked}
          {#if t.expectation}
            <p class="small muted">Recorded keenness: <strong>{EXPECTATIONS[t.expectation].toLowerCase()}</strong>.{t.drawn?.length ? ` What drew you: ${t.drawn.join(', ')}.` : ''}</p>
          {/if}
        {:else if ahead}
          <section class="section">
            <h2>After the trailer</h2>
            <p class="small muted">How keen are you? Later you can see how often that turns out right.</p>
            <Scale max={5} value={t.expectation} labels={EXPECTATIONS} onpick={(v) => setExpectation(t.id, v)} name="Expectation" />
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
            <p class="small muted" style="margin: 1rem 0 0.4rem">What drew you? (optional)</p>
            <Drawn id={t.id} value={t.drawn} />
          </section>
        {/if}

        {#if t.status === 'watched' || t.rating || t.status === 'watching' || t.status === 'dropped'}
          <section class="section">
            <h2>Your rating</h2>
            <Scale max={10} value={t.rating} onpick={(v) => update(t.id, { rating: v })} name="Your rating" />
            {#if partnerQ.value || t.partnerRating}
              <p class="small muted" style="margin: 0.75rem 0 0.35rem">{partnerQ.value || 'Partner'}</p>
              <Scale max={10} value={t.partnerRating} onpick={(v) => update(t.id, { partnerRating: v })} name="Partner rating" />
            {/if}
          </section>
        {/if}

        {#if t.critics.length}
          <section class="section"><Scores critics={t.critics} open={!ahead && t.rating !== undefined} onsee={() => sawScores(t)} /></section>
        {/if}

        {#if ahead}{@render where()}{/if}

        <section class="section">
          <h2>{ahead ? 'Notes' : 'Thoughts'}</h2>
          {#if reflectable}
            <p class="small muted" style="margin-bottom: 0.4rem">What was it about for you? Tap any that fit.</p>
            <Themes title={t} />
            <ul class="questions small muted">
              {#each questionsFor(t.id, finished) as q}<li>{q}</li>{/each}
            </ul>
          {/if}
          <label class="sr-only" for="note">Your notes</label>
          <textarea id="note" value={note ?? t.note ?? ''} oninput={(e) => { note = e.currentTarget.value; onNote(); }} onblur={saveNote} placeholder={ahead ? 'Who told you about it, why it caught your eye…' : 'A few words are enough: moments, arguments you had about it, what it made you think…'}></textarea>
          <p class="small muted state" role="status">{noteState === 'saving' ? 'Saving…' : noteState === 'saved' ? 'Saved' : ''}</p>
          {#if reflectable}
            <div class="assist card">
              <div class="row" role="group" aria-label="Prompt">
                <button class="chip" class:on={mode === 'review'} aria-pressed={mode === 'review'} onclick={() => (mode = 'review')}>Draft my review</button>
                <button class="chip" class:on={mode === 'reflect'} aria-pressed={mode === 'reflect'} onclick={() => (mode = 'reflect')}>Explore interpretations</button>
              </div>
              {#if mode === 'review'}
                <div class="row small">
                  <button class="chip" class:on={opts.length === 'short'} aria-pressed={opts.length === 'short'} onclick={() => (opts.length = 'short')}>Short</button>
                  <button class="chip" class:on={opts.length === 'full'} aria-pressed={opts.length === 'full'} onclick={() => (opts.length = 'full')}>Full</button>
                  <label class="row spoil"><input type="checkbox" bind:checked={opts.spoilers} /> Spoilers allowed</label>
                </div>
              {/if}
              <div class="row">
                <button class="small primary" onclick={() => send('copy')}>Copy prompt</button>
                <button class="small" onclick={() => send('claude')}>Open Claude ↗</button>
                <button class="small" onclick={() => send('chatgpt')}>Open ChatGPT ↗</button>
              </div>
              <details>
                <summary class="small muted">See the prompt</summary>
                <pre class="small">{prompt}</pre>
              </details>
              <p class="small muted">Built only from your rating, themes and notes (your partner is just “my partner”); it asks the assistant not to invent opinions and to mark guesses. Opening copies the prompt and starts an empty chat: paste it there. Nothing is sent until you do. {mode === 'review' ? 'Paste its closing “Themes:” line into your own word box above.' : ''}</p>
            </div>
          {/if}
        </section>

        {#if t.kind === 'show'}
          <section class="section">
            <div class="spread">
              <h2>Episodes</h2>
              {#if t.status !== 'dropped'}<label class="row follow"><input type="checkbox" checked={onCalendar(t)} onchange={(e) => update(t.id, { followed: e.currentTarget.checked })} /> On my calendar</label>{/if}
            </div>
            {#if rel.kind !== 'unknown'}
              <p class="small muted">{rel.kind === 'stream' ? `Dates are ${rel.where}'s own release dates.` : `Dates are when it airs on ${rel.where} (shown in your time). Streaming sites may get it later.`}</p>
            {/if}
            <Episodes title={t} episodes={epsQ.value} {seen} links={linksQ.value} focus={next} />
          </section>
        {/if}

        {#if !ahead}{@render where()}{/if}
      </div>

      <aside class="side-col">
        {#if t.overview && !(ahead && premise(t.overview) === t.overview.replace(/\s+/g, ' ').trim())}
          <section class="section">
            <h2>About</h2>
            <p class="small">{t.overview}</p>
          </section>
        {/if}
        {#if makers.length || cast.length}
          <section class="section">
            <h2>People</h2>
            <p class="small muted">Tap a name for their other work.</p>
            <ul class="people small">
              {#each makers as p}<li><a href={personHref(p.qid, p.name)}>{p.name}</a> <span class="muted">{p.role}</span></li>{/each}
              {#each cast.filter((c) => !makers.some((m) => m.name === c.name)) as p}<li><a href={personHref(p.qid, p.name)}>{p.name}</a></li>{/each}
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
                <li class="spread"><span>{formatDay(w.date)} · {w.together ? 'together' : 'solo'}</span><button class="small ghost" onclick={() => act('Viewing deleted', () => deleteWatch(w.id))} aria-label="Delete this viewing">✕</button></li>
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

  {#snippet where()}
    <section class="section" id="sources">
      <Sources title={t!} links={linksQ.value} heading={t!.kind === 'show' ? 'Sources for the whole series' : 'Where to watch'} next={t!.kind === 'show' ? next : undefined} />
    </section>
  {/snippet}
{/if}

<style>
  .hero { display: flex; gap: 1.5rem; align-items: flex-start; }
  .head { flex: 1; min-width: 0; }
  .premise { margin-bottom: 0; }
  .state { min-height: 1.3em; margin: 0.2rem 0 0; }
  #sources { scroll-margin-top: 80px; }
  .next { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0.5rem; }
  .next-ep { font-size: 1.1rem; }
  .cols { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 2rem; }
  .questions { margin: 0.75rem 0; padding-left: 1.2rem; }
  .assist { display: grid; gap: 0.6rem; margin-top: 0.75rem; }
  .assist pre { white-space: pre-wrap; word-break: break-word; background: var(--surface-2); padding: 0.75rem; border-radius: 8px; max-height: 18rem; overflow: auto; }
  .spoil { margin: 0; gap: 0.35rem; color: var(--text); }
  .people, .history { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.3rem; }
  .people a { color: var(--text); }
  .follow { color: var(--text); margin: 0; gap: 0.4rem; }
  .video { width: 100%; aspect-ratio: 16 / 9; border-radius: 10px; overflow: hidden; background: #000; }
  .video iframe { width: 100%; height: 100%; border: 0; }
  .links { gap: 1rem; }
  @media (max-width: 860px) {
    .cols { grid-template-columns: 1fr; gap: 0; }
  }
  /* Phone: poster beside the title, everything else full width, so what to do next is on the first screen. */
  @media (max-width: 560px) {
    .hero { display: grid; grid-template-columns: 104px minmax(0, 1fr); gap: 0.9rem; }
    .hero :global(.poster) { width: 104px; }
    .head { display: contents; }
    .head > * { grid-column: 1 / -1; margin: 0; }
    .head > :first-child { grid-column: 2; }
    .head > :first-child p { margin-bottom: 0.4rem; }
  }
</style>
