<script lang="ts" module>
  import { SvelteMap } from 'svelte/reactivity';
  import type { Dismissed as D } from '../lib/db';
  import type { Find as F, Meta as M } from '../lib/api/wiki';
  import type { Thread as W } from '../lib/discover';
  /** The shelves you were at, so opening a title and coming Back finds them as you left them. */
  const shelves = new Map<string, { thread: W; found: F[]; items: F[]; metas: Map<string, M>; pics: Record<string, string>; shown: Set<string>; open: string | null }>();
  /** Added from a shelf on this visit, with when: undone here only while it is still that same record */
  const added = new SvelteMap<string, { at: string; passed?: D }>();
  let lastKey = 'known';
  // Somewhere new each visit, and the same for as long as it lasts.
  let turn = Math.floor(Math.random() * 12);

  /** Another collection is here now (a restore, or its undo): nothing remembered from the last one applies. */
  export function forgetShelves() {
    shelves.clear();
    added.clear();
    lastKey = 'known';
  }
</script>

<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import { db, getSetting, now, type Title } from '../lib/db';
  import { live } from '../lib/live.svelte';
  import { route, titleHref } from '../lib/router.svelte';
  import { filmMetas, posters, type Find, type Meta } from '../lib/api/wiki';
  import { findShow, showForImdb } from '../lib/api/tvmaze';
  import { addFilm, addShow, removeTitle, sawScores, sawScoresOf, rememberShelf, saveFilmMeta, update, dismissTitle, clearDismissal } from '../lib/actions';
  import { KNOWN, REVISIT, SERIES, insight, lookUp, offer, premise, revisitCandidates, shelf, threadOf, threads, type Thread } from '../lib/discover';
  import { toast, undoable, errorText, ui } from '../lib/ui.svelte';
  import { runtime } from '../lib/format';
  import Poster from '../components/Poster.svelte';
  import Scale from '../components/Scale.svelte';
  import Scores from '../components/Scores.svelte';
  import Drawn from '../components/Drawn.svelte';
  import ProgressPicker from '../components/ProgressPicker.svelte';
  import DiscoverTabs from '../components/DiscoverTabs.svelte';

  const data = live(
    () => async () => ({
      titles: await db.titles.toArray(),
      dismissed: (await db.dismissed.toArray()).sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')),
    }),
    { titles: [] as Title[], dismissed: [] as D[] },
  );
  const library = $derived(data.value.titles);
  const all = $derived(threads(library));
  // Offered ways in stay put while you use the shelf, and change when you ask for others.
  let ways = $state.raw<Thread[]>([]);

  let thread = $state.raw<Thread | undefined>();
  let found = $state.raw<Find[]>([]);
  let items = $state.raw<Find[]>([]);
  let metas = $state.raw(new Map<string, Meta>());
  let pics = $state.raw<Record<string, string>>({});
  let loading = $state(false);
  let error = $state('');
  let open = $state<string | null>(null);
  let busy = $state<Record<string, boolean>>({});
  let shown = $state.raw(new Set<string>());
  let detailsLoading = $state(false);
  let seq = 0;
  let gone = false;
  onDestroy(() => {
    gone = true;
    seq++;
  });

  const ownOf = (f: Find) => library.find((t) => t.qid === f.qid || t.id === `wd:${f.qid}` || (f.tvmaze && t.tvmaze === f.tvmaze));
  const dismissed = $derived(new Set(data.value.dismissed.map((d) => d.qid)));
  const passed = (f: Find) => dismissed.has(f.qid);
  const revisit = $derived(thread?.key === REVISIT.key);
  const reconsider = $derived(revisitCandidates(data.value.dismissed).filter((f) => !ownOf(f)));
  const unseen = $derived(shelf(revisit ? reconsider : found, library, revisit ? new Set() : dismissed, shown, undefined, !thread?.key.startsWith('known') && !revisit));

  $effect(() => {
    const key = route.params.get('from');
    const name = route.params.get('name') ?? '';
    if (!data.ready) return;
    untrack(() => {
      const t = threadOf(key ?? lastKey, library, name) ?? KNOWN;
      lastKey = t.key;
      ways = offer(all, turn).filter((x) => x.key !== t.key);
      let cached = shelves.get(t.key);
      // Every title on it decided since: a new second look, not the old one.
      if (t.key === REVISIT.key && !cached?.items.some(passed)) cached = undefined;
      if (!cached) {
        void start(t);
        return;
      }
      const mine = ++seq;
      ({ thread, found, items, metas, pics, shown, open } = cached);
      loading = false;
      error = '';
      if (items.some((f) => !metas.has(f.qid))) void enrich(mine);
      else detailsLoading = false;
    });
  });

  function keep() {
    if (gone || !thread || loading) return; // a save that outlived the page must not bring its old shelf back
    shelves.delete(thread.key);
    shelves.set(thread.key, { thread, found, items, metas, pics, shown, open });
    if (shelves.size > 12) shelves.delete(shelves.keys().next().value!);
  }

  async function start(t: Thread) {
    const mine = ++seq;
    shelves.delete(t.key);
    thread = t;
    items = [];
    found = [];
    shown = new Set();
    open = null;
    error = '';
    loading = true;
    detailsLoading = false;
    try {
      const list = t.key === REVISIT.key ? reconsider : await lookUp(t.key);
      const before = t.key === REVISIT.key ? [] : ((await getSetting<Record<string, string[]>>('browsed', {}))[t.key] ?? []);
      if (mine !== seq) return;
      found = list;
      shown = new Set(before);
      if (!unseen.length) shown = new Set(); // all of it seen before: from the top again
      if (!unseen.length && t.key === KNOWN.key && !route.params.get('from') && ways.length) {
        lastKey = ways[0].key; // nothing left to remember: somewhere new
        void start(ways[0]);
        return;
      }
      loading = false;
      fill(mine);
    } catch (e) {
      if (mine !== seq) return;
      loading = false;
      error = errorText(e);
    }
  }

  async function enrich(mine: number) {
    if (!items.length) return;
    detailsLoading = true;
    error = '';
    posters(items.flatMap((f) => f.wiki ?? [])).then((p) => {
      if (mine !== seq) return;
      pics = p;
      keep();
    }, () => {});
    try {
      const m = await filmMetas(items.map((f) => f.qid));
      if (mine !== seq) return;
      metas = m;
      for (const f of items) {
        const details = m.get(f.qid);
        if (f.kind === 'film' && details && added.has(`wd:${f.qid}`)) {
          void saveFilmMeta(`wd:${f.qid}`, details).catch(() => {});
        }
      }
    } catch (e) {
      if (mine === seq) error = `Title details are temporarily unavailable. ${errorText(e)}`;
    } finally {
      if (mine === seq) {
        detailsLoading = false;
        keep();
      }
    }
  }

  function fill(mine = ++seq) {
    items = unseen;
    shown = new Set([...shown, ...items.map((f) => f.qid)]);
    open = null;
    metas = new Map();
    pics = {};
    error = '';
    detailsLoading = false;
    keep();
    void enrich(mine);
  }

  async function another() {
    if (thread && !revisit) void rememberShelf(thread.key, [...shown]).catch(() => {}); // only where to carry on next time
    fill();
    await tick();
    document.getElementById('shelf-heading')?.focus({ preventScroll: true });
    scrollTo({ top: 0 });
  }
  function others() {
    turn++;
    ways = offer(all, turn).filter((x) => x.key !== thread?.key);
  }

  /** Nothing of the shelf moves until it is stored; a second tap waits for the first. */
  async function act(f: Find, run: () => Promise<unknown>) {
    if (busy[f.qid]) return;
    busy[f.qid] = true;
    try {
      await run();
    } catch (e) {
      toast(`Not saved: ${errorText(e)}`, 'error');
    } finally {
      busy[f.qid] = false;
      keep();
    }
  }

  async function add(f: Find, patch: Partial<Title>, progress?: 'all') {
    const before = now();
    const passed = data.value.dismissed.find((d) => d.qid === f.qid);
    let id: string;
    if (f.kind === 'film') {
      id = await addFilm(f.qid, patch, metas.get(f.qid) ?? {
        qid: f.qid, name: f.name, year: f.year, wiki: f.wiki, poster: f.wiki && pics[f.wiki], kind: 'film', genres: [], people: [], countries: [], languages: [], subjects: [], critics: [],
      }, !metas.has(f.qid));
    } else {
      const m = metas.get(f.qid);
      const tvm = f.tvmaze ?? (m?.imdb ? await showForImdb(m.imdb) : await findShow(f.name, f.year));
      if (!tvm) throw new Error(`${f.name} cannot be matched for certain. Use Add to choose the series.`);
      id = await addShow(tvm, { ...patch, qid: f.qid }, progress);
    }
    const t = await db.titles.get(id);
    if (!t || t.addedAt < before) throw new Error(`${f.name} is already in your library.`);
    added.set(id, { at: t.addedAt, passed });
  }

  const seen = (f: Find, rating?: number) =>
    act(f, async () => {
      const own = ownOf(f);
      if (own) return update(own.id, { rating });
      await add(f, { status: f.kind === 'film' ? 'watched' : 'watching', rating }, f.kind === 'show' ? 'all' : undefined);
    });

  const partly = (f: Find) => act(f, () => add(f, { status: 'watching' }));

  /** When its scores were first opened, here or before you passed on it */
  const opened = async (f: Find) => (await getSetting<Record<string, string>>('scoresSeen', {}))[f.qid] ?? (await db.dismissed.get(f.qid))?.scoresAt;
  const want = (f: Find) => act(f, async () => add(f, { status: 'want', chosenAt: now(), choiceScores: metas.get(f.qid)?.critics ?? [], scoresAt: await opened(f) }));
  const pass = (f: Find) => act(f, async () =>
    dismissTitle({ qid: f.qid, name: f.name, kind: f.kind, year: f.year, tvmaze: f.tvmaze, at: now(), critics: metas.get(f.qid)?.critics ?? [], scoresAt: await opened(f) }),
  );

  /** Still the record added here, with nothing recorded about it elsewhere: not one a restore or another page put in its place. */
  const canUndo = (own: Title) => added.get(own.id)?.at === own.addedAt && !own.note && !own.finishedAt && !own.themes?.length && own.partnerRating === undefined;
  const undo = (f: Find) =>
    act(f, async () => {
      const own = ownOf(f);
      if (!own) return clearDismissal(f.qid);
      const passed = added.get(own.id)?.passed;
      const back = await removeTitle(own.id);
      added.delete(own.id);
      if (passed) await dismissTitle(passed); // it was passed on before: so it is again
      undoable(`${f.name} taken out again`, async () => {
        if (passed) await clearDismissal(f.qid);
        await back();
      });
    });

  function sawFor(f: Find) {
    const own = ownOf(f);
    return own ? sawScores(own) : sawScoresOf(f.qid);
  }

  const people = (m: Meta | undefined, role: 'makers' | 'cast') =>
    [...new Set((m?.people ?? []).filter((p) => (role === 'cast' ? p.role === 'cast' : p.role === 'director' || p.role === 'creator')).map((p) => p.name))].slice(0, role === 'cast' ? 3 : 2).join(', ');
  /** What ties it to where the shelf started */
  const tie = (m: Meta | undefined) => {
    const from = thread?.key.startsWith('title:') ? library.find((t) => `title:${t.qid}` === thread!.key) : undefined;
    if (!from || !m) return '';
    const maker = m.people.find((p) => p.qid && p.role !== 'cast' && from.people.some((q) => q.qid === p.qid && q.role === p.role));
    if (maker) return `Also ${maker.role === 'director' ? 'directed by' : maker.role === 'writer' ? 'written by' : 'with work by'} ${maker.name}`;
    const subject = m.subjects.find((s) => from.subjects.includes(s));
    if (subject) return `Also about ${subject}`;
    const cast = m.people.find((p) => p.qid && p.role === 'cast' && from.people.some((q) => q.qid === p.qid && q.role === 'cast'));
    return cast ? `Also stars ${cast.name}` : '';
  };
  const trailer = (f: Find, m: Meta | undefined) =>
    m?.trailer ? `https://www.youtube.com/watch?v=${m.trailer}` : `https://www.youtube.com/results?search_query=${encodeURIComponent(`${f.name} ${f.year ?? ''} ${f.kind === 'show' ? 'season 1 ' : ''}trailer`)}`;
  const link = (t: Thread) => `#/discover?${new URLSearchParams({ from: t.key, ...(t.key.startsWith('person:') || t.key.startsWith('title:') ? { name: t.label.replace(/^(More by|Like) /, '') } : {}) })}`;

  const tally = $derived.by(() => {
    const own = items.map(ownOf).filter((t) => !!t);
    const n = {
      seen: own.filter((t) => t?.status === 'watched').length,
      progress: own.filter((t) => t?.status === 'watching' || t?.status === 'paused').length,
      want: own.filter((t) => t?.status === 'want').length,
      no: items.filter((f) => !ownOf(f) && passed(f)).length,
    };
    return [n.seen && `${n.seen} seen`, n.progress && `${n.progress} in progress`, n.want && `${n.want} on your list`, n.no && `${n.no} passed`].filter(Boolean).join(', ');
  });

  function close(qid: string) {
    open = null;
    keep();
    document.getElementById(`find-${qid}`)?.focus();
  }
</script>

<DiscoverTabs current="discover" />

<div class="top">
  <div>
    <h1 id="shelf-heading" tabindex="-1">{thread ? thread.label : 'Discover'}</h1>
    {#if thread?.why}<p class="muted">{thread.why}</p>{/if}
  </div>
</div>

<div class="row how">
  {#if thread?.key !== KNOWN.key}<a class="chip" href="#/discover?from=known">{KNOWN.label}</a>{:else}<a class="chip" href={link(SERIES)}>Series only</a>{/if}
  {#if reconsider.length && !revisit}<a class="chip" href="#/discover?from=revisit">Second look</a>{/if}
  <button class="chip" onclick={() => document.getElementById('ways')?.focus()}>Other ways in ↓</button>
</div>

{#if !data.ready || (loading && !items.length)}
  <p class="muted small" role="status">Putting a shelf together…</p>
  <ul class="grid shelf" aria-hidden="true">{#each Array(12) as _}<li><div class="blank"></div></li>{/each}</ul>
{:else if error && !items.length}
  <div class="empty" role="alert">
    <p>{error}</p>
    <div class="row centre">
      <button class="primary" onclick={() => thread && start(thread)}>Try again</button>
      {#if thread?.key !== KNOWN.key}<a class="btn" href="#/discover?from=known">Show well-known titles instead</a>{/if}
    </div>
  </div>
{:else if !items.length}
  <div class="empty">{revisit ? 'No passed titles to revisit here.' : 'No more titles on this shelf. Try another route below.'}</div>
{:else}
  {#if error}<div class="row small"><span role="alert">{error}</span><button class="small" onclick={() => enrich(seq)}>Retry details</button></div>{/if}
  <ul class="grid shelf">
    {#each items as f (f.qid)}
      {@const m = metas.get(f.qid)}
      {@const own = ownOf(f)}
      {@const no = !own && passed(f)}
      {@const on = open === f.qid}
      <li>
        <button id="find-{f.qid}" class="tile" class:on class:no aria-expanded={on} aria-controls={on ? `panel-${f.qid}` : undefined} onclick={async (e) => { if (on) return close(f.qid); open = f.qid; keep(); if (!e.detail) { await tick(); document.getElementById(`heading-${f.qid}`)?.focus(); } }}>
          <Poster src={m?.poster ?? (f.wiki && pics[f.wiki])} name={f.name} />
          {#if own}<span class="badge" class:want={own.status === 'want'}>{own.rating ?? (own.status === 'want' ? '＋' : '✓')}</span>{/if}
          <span class="name">{f.name}</span>
          <span class="small muted">{f.year}{f.kind === 'show' ? ' · Series' : ''}{no ? ' · Not for you' : own ? (own.status === 'want' ? ' · On your list' : own.status === 'watched' ? ' · Seen' : ' · In library') : ''}</span>
        </button>
      </li>
      {#if on}
        <!-- Sits under its row, whatever the number of columns -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <li class="panel card stack fade" id="panel-{f.qid}" onkeydown={(e) => e.key === 'Escape' && close(f.qid)} {@attach (el) => el.scrollIntoView({ block: 'nearest' })}>
          <div class="spread head">
            <div>
              <h2 id="heading-{f.qid}" tabindex="-1">{f.name}</h2>
              <p class="small muted">{[f.year, f.kind === 'show' ? 'Series' : 'Film', f.kind === 'film' ? runtime(m?.runtime) : '', people(m, 'makers')].filter(Boolean).join(' · ')}</p>
            </div>
            <button class="ghost icon" aria-label="Close" onclick={() => close(f.qid)}>✕</button>
          </div>
          {#if own || no}
            <!-- decided: keep it short -->
          {:else if m}
            {#if premise(m.overview)}<p>{premise(m.overview)}</p>{/if}
            <p class="small muted">{[people(m, 'cast') && `With ${people(m, 'cast')}`, tie(m)].filter(Boolean).join('. ')}</p>
          {:else if detailsLoading}
            <p class="small muted" role="status">Looking it up…</p>
          {/if}

          {#if own}
            {@const line = insight(own, library)}
            <div class="done" role="status">
              <strong>{own.status === 'want' ? 'On your list.' : own.status !== 'watched' ? 'Saved to your library.' : own.rating ? `Seen: ${own.rating}/10.` : 'Seen.'}</strong>
              {#if line}{line.text}{/if}
            </div>
            {#if own.status === 'want'}
              <div>
                <p class="label">What drew you? <span class="muted">(optional)</span></p>
                <Drawn id={own.id} value={own.drawn} />
              </div>
            {:else}
              <div>
                <p class="label">{own.rating ? 'Change your rating' : 'How was it?'} {#if !own.rating}<span class="muted">(optional)</span>{/if}</p>
                <Scale max={10} value={own.rating} onpick={(v) => seen(f, v)} name="Your rating of {f.name}" />
              </div>
              {#if own.kind === 'show'}<ProgressPicker titleId={own.id} label="Seen up to" />{/if}
            {/if}
            <div class="row">
              {#if own.status !== 'want' && own.qid && (own.rating ?? 0) >= 7}<a class="btn small" href={link({ key: `title:${own.qid}`, label: own.name })}>More like this</a>{/if}
              {#if line?.thread}<a class="btn small" href={link(line.thread)}>{line.thread.label}</a>{/if}
              <a class="btn small" href={titleHref(own.id)}>Open</a>
              {#if canUndo(own)}<button class="small ghost" onclick={() => undo(f)} disabled={busy[f.qid]}>Undo</button>{/if}
            </div>
          {:else if no && !revisit}
            <div class="done row" role="status"><strong>Not for you.</strong> <button class="small ghost" onclick={() => undo(f)} disabled={busy[f.qid]}>Undo</button></div>
          {:else}
            <div>
              <p class="label">{f.kind === 'show' ? 'Seen all released episodes? Rate it' : 'Seen it? Rate it'}</p>
              <Scale max={10} onpick={(v) => v && seen(f, v)} name="Seen it: your rating of {f.name}" />
              <button class="small ghost bare" onclick={() => seen(f)} disabled={busy[f.qid]}>{f.kind === 'show' ? 'Seen all, no rating' : 'Seen it, no rating'}</button>
              {#if f.kind === 'show'}<button class="small" onclick={() => partly(f)} disabled={busy[f.qid]}>Seen some</button>{/if}
            </div>
            <div class="row">
              <button class="primary" onclick={() => want(f)} disabled={busy[f.qid]}>Want to watch</button>
              {#if !revisit}<button onclick={() => pass(f)} disabled={busy[f.qid]}>Not for me</button>{/if}
              <a class="small" href={trailer(f, m)} target="_blank" rel="noopener noreferrer">Trailer ↗</a>
            </div>
            {#if busy[f.qid]}<p class="small muted" role="status">Saving…</p>{/if}
          {/if}
          {#if m}<Scores critics={m.critics} onsee={() => sawFor(f)} />{/if}
        </li>
      {/if}
    {/each}
  </ul>
  <div class="after">
    {#if tally}<p class="small" role="status">This shelf: {tally}.</p>{/if}
    <div class="row">
      {#if unseen.length}<button class="primary" onclick={another}>Next shelf</button>
        {#if tally}<a class="btn" href="#/taste">What this says about you</a>{/if}
      {:else}<p class="small muted">You’ve reached the end. Pick another route below or <button class="linkish" onclick={() => { shown = new Set(); void another(); }}>browse this one again</button>.</p>{/if}
    </div>
  </div>
{/if}

<section class="section">
  <div class="spread">
    <h2 id="ways" tabindex="-1">Other ways in</h2>
    <button class="small ghost" onclick={others}>Show others</button>
  </div>
  <ul class="ways">
    {#each ways as w (w.key)}
      <li><a class="card" href={link(w)}><strong>{w.label}</strong>{#if w.why}<span class="small muted">{w.why}</span>{/if}</a></li>
    {/each}
  </ul>
  <p class="small muted">Know the name? <button class="linkish" onclick={() => (ui.searchOpen = true)}>Search for it</button>, or <a href="#/import">import a list</a>.</p>
</section>

<style>
  h1 { margin-bottom: 0.2rem; }
  .top p { margin: 0; }
  #ways { scroll-margin-top: calc(72px + env(safe-area-inset-top)); }
  .how { margin: 0.6rem 0 0.9rem; }
  /* Each tile has room for its outline; pull that back so posters line up with the page. */
  .shelf { list-style: none; padding: 0; margin: 0 -6px; grid-template-columns: repeat(6, minmax(0, 1fr)); grid-auto-flow: dense; gap: 0.75rem 0.4rem; }
  @media (max-width: 900px) { .shelf { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
  @media (max-width: 560px) { .shelf { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.4rem 0.15rem; } }
  .tile { position: relative; display: grid; gap: 0.25rem; width: 100%; padding: 4px; border: 2px solid transparent; border-radius: 12px; background: none; text-align: left; justify-content: stretch; justify-items: stretch; white-space: normal; align-content: start; }
  .tile.on { border-color: var(--accent); background: var(--surface); }
  .tile.no :global(.poster) { opacity: 0.35; }
  .name { font-weight: 600; font-size: 0.92rem; line-height: 1.25; }
  .badge { position: absolute; top: 10px; right: 10px; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: var(--accent); color: var(--accent-ink); font-weight: 700; }
  .badge.want { background: var(--ok); color: var(--bg); }
  /* Clear of the header and the tab bar when scrolled into view */
  .panel { grid-column: 1 / -1; scroll-margin: calc(70px + env(safe-area-inset-top)) 0 calc(var(--nav-h) + env(safe-area-inset-bottom) + 12px); }
  .head { align-items: flex-start; flex-wrap: nowrap; }
  .head .icon { margin: -0.4rem -0.4rem 0 0; flex: none; }
  .head h2 { margin: 0; }
  .head p { margin: 0.15rem 0 0; }
  .panel p { margin-bottom: 0; }
  .label { font-size: 0.9rem; margin: 0 0 0.35rem !important; }
  .bare { margin-top: 0.35rem; padding-left: 0; }
  .done { background: var(--surface-2); border-radius: 10px; padding: 0.6rem 0.8rem; }
  .after { display: grid; gap: 0.6rem; margin-top: 1.25rem; }
  .after p { margin: 0; }
  .centre { justify-content: center; }
  .blank { aspect-ratio: 2 / 3; border-radius: 8px; background: var(--surface-2); }
  .ways { list-style: none; padding: 0; margin: 0 0 1rem; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 0.6rem; }
  .ways a { display: grid; gap: 0.15rem; color: var(--text); text-decoration: none; padding: 0.75rem 0.9rem; height: 100%; align-content: start; }
  .ways a:hover { border-color: var(--muted); }
  .linkish { display: inline; min-height: 24px; padding: 0; border: 0; background: none; color: var(--accent); text-decoration: underline; font-size: inherit; }
</style>
