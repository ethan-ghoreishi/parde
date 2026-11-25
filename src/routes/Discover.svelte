<script lang="ts" module>
  import type { Find as F, Meta as M } from '../lib/api/wiki';
  import type { Thread as W } from '../lib/discover';
  /** The shelf you were at, so opening a title and coming Back finds it as you left it. */
  let left: { asked: string; thread: W; found: F[]; items: F[]; metas: Map<string, M>; here: Set<string>; opened: Record<string, string>; ways: W[] } | undefined;
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import { db, getSetting, now, setSetting, type Title } from '../lib/db';
  import { live } from '../lib/live.svelte';
  import { route, titleHref } from '../lib/router.svelte';
  import { filmMetas, posters, type Find, type Meta } from '../lib/api/wiki';
  import { findShow } from '../lib/api/tvmaze';
  import { addFilm, addShow, removeTitle, seenAllAired, sawScores, update } from '../lib/actions';
  import { KNOWN, insight, lookUp, offer, premise, remember, shelf, threadOf, threads, type Thread } from '../lib/discover';
  import { toast, undoable, errorText, ui } from '../lib/ui.svelte';
  import { runtime } from '../lib/format';
  import Poster from '../components/Poster.svelte';
  import Scale from '../components/Scale.svelte';
  import Scores from '../components/Scores.svelte';
  import Drawn from '../components/Drawn.svelte';
  import ProgressPicker from '../components/ProgressPicker.svelte';
  import DiscoverTabs from '../components/DiscoverTabs.svelte';

  const data = live(
    () => async () => ({ titles: await db.titles.toArray(), dismissed: new Set(await db.dismissed.toCollection().primaryKeys()) }),
    { titles: [] as Title[], dismissed: new Set<string>() },
  );
  const library = $derived(data.value.titles);
  const all = $derived(threads(library));
  let turn = Math.floor(Math.random() * 12);
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
  /** When the scores of something not in the library were opened, so a choice after that is not called instinct */
  let opened: Record<string, string> = {};
  /** Added from this shelf: only these can be undone here */
  let here = $state.raw(new Set<string>());
  let seq = 0;

  const ownOf = (f: Find) => library.find((t) => t.qid === f.qid || t.id === `wd:${f.qid}` || (f.tvmaze && t.tvmaze === f.tvmaze));
  const passed = (f: Find) => data.value.dismissed.has(f.qid);

  // The address says which thread (so Back works and any page can link to one); otherwise one of yours, or the well known.
  $effect(() => {
    const key = route.params.get('from') ?? '';
    const name = route.params.get('name') ?? '';
    if (!data.ready) return;
    untrack(() => {
      if (left && left.asked === key && !thread) {
        ({ thread, found, items, metas, here, opened, ways } = left);
        return;
      }
      // Yours first, whichever kind comes up; with nothing to go on, what nearly everyone has seen.
      const mine = offer(all, turn).filter((x) => /^(title|person|about)/.test(x.key));
      const t = (key && threadOf(key, library, name)) || mine[Math.floor(Math.random() * mine.length)] || KNOWN;
      ways = offer(all, turn).filter((x) => x.key !== t.key);
      asked = key;
      start(t);
    });
  });
  let asked = '';
  const keep = () => {
    if (thread && items.length) left = { asked, thread, found, items, metas, here, opened, ways };
  };

  async function start(t: Thread) {
    const mine = ++seq;
    thread = t;
    open = null;
    items = [];
    metas = new Map();
    pics = {};
    error = '';
    loading = true;
    try {
      const list = await lookUp(t.key);
      if (mine !== seq) return;
      found = list;
      await fill(mine);
    } catch (e) {
      if (mine === seq) error = errorText(e);
    } finally {
      if (mine === seq) loading = false;
      keep();
    }
  }

  /** Put the next twelve out: names at once, posters and details a moment later in one batch. */
  async function fill(mine = ++seq) {
    open = null;
    error = '';
    const shown = await getSetting<string[]>('shown', []);
    const next = shelf(found, library, data.value.dismissed, new Set(shown));
    if (mine !== seq) return;
    items = next;
    metas = new Map();
    loading = false;
    if (!next.length) return;
    await setSetting('shown', remember(shown, next.map((f) => f.qid)));
    posters(next.flatMap((f) => f.wiki ?? [])).then((p) => mine === seq && (pics = p), () => {});
    try {
      const m = await filmMetas(next.map((f) => f.qid));
      if (mine === seq) metas = m;
      keep();
    } catch (e) {
      if (mine === seq) error = `Posters and details are unavailable just now: ${errorText(e)}`;
    }
  }

  function another() {
    fill();
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

  async function add(f: Find, patch: Partial<Title>): Promise<string> {
    await db.dismissed.delete(f.qid);
    if (f.kind === 'film') return addFilm(f.qid, patch, metas.get(f.qid));
    const tvm = f.tvmaze ?? (await findShow(f.name, f.year));
    if (!tvm) throw new Error(`${f.name} is not on TVmaze, so Parde cannot track its episodes.`);
    return addShow(tvm, patch);
  }
  const added = (id: string) => {
    here = new Set([...here, id]);
    return id;
  };

  // Rating something is saying you have seen it. When, it does not know, so no date is made up.
  const seen = (f: Find, rating?: number) =>
    act(f, async () => {
      const own = ownOf(f);
      if (own) return update(own.id, { rating });
      const id = added(await add(f, f.kind === 'film' ? { status: 'watched', rating } : { rating }));
      if (f.kind === 'show') await seenAllAired(id);
    });

  const want = (f: Find) => act(f, async () => added(await add(f, { status: 'want', chosenAt: now(), ...(opened[f.qid] ? { scoresAt: opened[f.qid] } : {}) })));

  const pass = (f: Find) =>
    act(f, () => {
      const m = metas.get(f.qid);
      return db.dismissed.put({ qid: f.qid, at: now(), name: f.name, ...(f.year ? { year: f.year } : {}), critics: m?.critics ?? [], ...(opened[f.qid] ? { scoresAt: opened[f.qid] } : {}) });
    });

  const undo = (f: Find) =>
    act(f, async () => {
      const own = ownOf(f);
      // It may have a note by now: taking it back can be taken back.
      if (own) undoable(`${f.name} taken out again`, await removeTitle(own.id));
      await db.dismissed.delete(f.qid);
    });

  function sawFor(f: Find) {
    const own = ownOf(f);
    if (own) sawScores(own);
    else opened[f.qid] ??= now();
  }

  const people = (m: Meta | undefined, role: 'makers' | 'cast') =>
    [...new Set((m?.people ?? []).filter((p) => (role === 'cast' ? p.role === 'cast' : p.role === 'director' || p.role === 'creator')).map((p) => p.name))].slice(0, role === 'cast' ? 3 : 2).join(', ');
  /** What ties it to where the shelf started */
  const tie = (m: Meta | undefined) => {
    const from = thread?.key.startsWith('title:') ? library.find((t) => `title:${t.qid}` === thread!.key) : undefined;
    if (!from || !m) return '';
    const shared = [...new Set(m.people.filter((p) => from.people.some((q) => q.qid === p.qid)).map((p) => p.name)), ...m.subjects.filter((s) => from.subjects.includes(s))].slice(0, 3);
    return shared.length ? `Shares ${shared.join(', ')} with ${from.name}` : '';
  };
  const trailer = (f: Find, m: Meta | undefined) =>
    m?.trailer ? `https://www.youtube.com/watch?v=${m.trailer}` : `https://www.youtube.com/results?search_query=${encodeURIComponent(`${f.name} ${f.year ?? ''} ${f.kind === 'show' ? 'season 1 ' : ''}trailer`)}`;
  const link = (t: Thread) => `#/discover?${new URLSearchParams({ from: t.key, ...(t.key.startsWith('person:') || t.key.startsWith('title:') ? { name: t.label.replace(/^(More by|Like) /, '') } : {}) })}`;

  const tally = $derived.by(() => {
    const own = items.map(ownOf).filter((t) => !!t);
    const n = { seen: own.filter((t) => t!.status !== 'want').length, want: own.filter((t) => t!.status === 'want').length, no: items.filter((f) => !ownOf(f) && passed(f)).length };
    return [n.seen && `${n.seen} seen`, n.want && `${n.want} on your list`, n.no && `${n.no} not for you`].filter(Boolean).join(', ');
  });

  function close(qid: string) {
    open = null;
    document.getElementById(`find-${qid}`)?.focus();
  }
</script>

<DiscoverTabs current="discover" />

<div class="top">
  <div>
    <h1>{thread ? thread.label : 'Discover'}</h1>
    {#if thread?.why}<p class="muted">{thread.why}</p>{/if}
  </div>
</div>

<p class="small muted how">Tap anything you recognise, or are curious about. Ignore the rest.</p>

{#if loading && !items.length}
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
  <div class="empty">Nothing left on this thread that you have not already placed. Try another below.</div>
{:else}
  {#if error}<p class="small" role="alert">{error}</p>{/if}
  <ul class="grid shelf">
    {#each items as f (f.qid)}
      {@const m = metas.get(f.qid)}
      {@const own = ownOf(f)}
      {@const no = !own && passed(f)}
      {@const on = open === f.qid}
      <li>
        <button id="find-{f.qid}" class="tile" class:on class:no aria-expanded={on} aria-controls={on ? `panel-${f.qid}` : undefined} onclick={() => (open = on ? null : f.qid)}>
          <Poster src={m?.poster ?? (f.wiki && pics[f.wiki])} name={f.name} />
          {#if own}<span class="badge" class:want={own.status === 'want'}>{own.rating ?? (own.status === 'want' ? '＋' : '✓')}</span>{/if}
          <span class="name">{f.name}</span>
          <span class="small muted">{f.year}{f.kind === 'show' ? ' · Series' : ''}{no ? ' · Not for you' : own ? (own.status === 'want' ? ' · On your list' : ' · Seen') : ''}</span>
        </button>
      </li>
      {#if on}
        <!-- Sits under its row, whatever the number of columns -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <li class="panel card stack fade" id="panel-{f.qid}" onkeydown={(e) => e.key === 'Escape' && close(f.qid)} {@attach (el) => el.scrollIntoView({ block: 'nearest' })}>
          <div class="spread head">
            <div>
              <h2>{f.name}</h2>
              <p class="small muted">{[f.year, f.kind === 'show' ? 'Series' : 'Film', f.kind === 'film' ? runtime(m?.runtime) : '', people(m, 'makers')].filter(Boolean).join(' · ')}</p>
            </div>
            <button class="ghost icon" aria-label="Close" onclick={() => close(f.qid)}>✕</button>
          </div>
          {#if own || no}
            <!-- decided: keep it short -->
          {:else if m}
            {#if premise(m.overview)}<p>{premise(m.overview)}</p>{/if}
            <p class="small muted">{[people(m, 'cast') && `With ${people(m, 'cast')}`, tie(m)].filter(Boolean).join('. ')}</p>
          {:else if !error}
            <p class="small muted" role="status">Looking it up…</p>
          {/if}

          {#if own}
            {@const line = insight(own, library)}
            <div class="done" role="status">
              <strong>{own.status === 'want' ? 'On your list.' : own.rating ? `Seen: ${own.rating}/10.` : 'Seen.'}</strong>
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
              {#if own.kind === 'show'}<ProgressPicker titleId={own.id} label="Marked as all seen. Only some? Up to" />{/if}
            {/if}
            <div class="row">
              {#if own.status !== 'want' && own.qid && (own.rating ?? 0) >= 7}<a class="btn small" href={link({ key: `title:${own.qid}`, label: own.name })}>More like this</a>{/if}
              {#if line?.thread}<a class="btn small" href={link(line.thread)}>{line.thread.label}</a>{/if}
              <a class="btn small" href={titleHref(own.id)}>Open</a>
              {#if here.has(own.id)}<button class="small ghost" onclick={() => undo(f)} disabled={busy[f.qid]}>Undo</button>{/if}
            </div>
          {:else if no}
            <div class="done row" role="status"><strong>Not for you.</strong> <button class="small ghost" onclick={() => undo(f)} disabled={busy[f.qid]}>Undo</button></div>
          {:else}
            <div>
              <p class="label">Seen it? Rate it</p>
              <Scale max={10} onpick={(v) => v && seen(f, v)} name="Seen it: your rating of {f.name}" />
              <button class="small ghost bare" onclick={() => seen(f)} disabled={busy[f.qid]}>Seen it, no rating</button>
            </div>
            <div class="row">
              <button class="primary" onclick={() => want(f)} disabled={busy[f.qid]}>Want to watch</button>
              <button onclick={() => pass(f)} disabled={busy[f.qid]}>Not for me</button>
              <a class="small" href={trailer(f, m)} target="_blank" rel="noopener noreferrer">Trailer ↗</a>
            </div>
            {#if busy[f.qid]}<p class="small muted" role="status">Saving…</p>{/if}
          {/if}
          {#if m}<Scores critics={m.critics} open={!!own && own.status !== 'want'} onsee={() => sawFor(f)} />{/if}
        </li>
      {/if}
    {/each}
  </ul>
  <div class="after">
    {#if tally}<p class="small" role="status">This shelf: {tally}.</p>{/if}
    <div class="row">
      <button class="primary" onclick={another}>Next shelf</button>
      {#if tally}<a class="btn" href="#/taste">What this says about you</a>{/if}
    </div>
  </div>
{/if}

<section class="section">
  <div class="spread">
    <h2>Other ways in</h2>
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
  .linkish { display: inline; min-height: 0; padding: 0; border: 0; background: none; color: var(--accent); text-decoration: underline; font-size: inherit; }
</style>
