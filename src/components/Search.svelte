<script lang="ts">
  import { ui, toast, errorText } from '../lib/ui.svelte';
  import { searchFilms, type FilmHit, type PersonHit } from '../lib/api/wiki';
  import { searchShows, type ShowHit } from '../lib/api/tvmaze';
  import { addFilm, addShow, update, setExpectation, seenAllAired } from '../lib/actions';
  import { db, type Status } from '../lib/db';
  import { live } from '../lib/live.svelte';
  import { titleHref, personHref, go } from '../lib/router.svelte';
  import Poster from './Poster.svelte';
  import Scale from './Scale.svelte';
  import ProgressPicker from './ProgressPicker.svelte';
  import { EXPECTATIONS } from '../lib/taste';

  let dialog: HTMLDialogElement;
  let input = $state<HTMLInputElement>();
  let films = $state<FilmHit[]>([]);
  let shows = $state<ShowHit[]>([]);
  let people = $state<PersonHit[]>([]);
  let loading = $state(false);
  let error = $state('');
  let busy = $state<string | null>(null);
  /** Items added in this session, so the row can ask a follow-up question */
  let added = $state<Record<string, Status>>({});
  let seq = 0;

  const ids = $derived([...films.map((f) => `wd:${f.qid}`), ...shows.map((s) => `tvm:${s.tvmaze}`)]);
  const owned = live(() => {
    const list = ids;
    return () => db.titles.bulkGet(list);
  }, []);
  const byId = $derived(new Map(owned.value.filter((t) => !!t).map((t) => [t!.id, t!])));

  $effect(() => {
    if (ui.searchOpen && !dialog.open) {
      dialog.showModal();
      input?.select();
    } else if (!ui.searchOpen && dialog.open) dialog.close();
  });

  $effect(() => {
    const close = () => (ui.searchOpen = false);
    addEventListener('hashchange', close);
    return () => removeEventListener('hashchange', close);
  });

  let timer: ReturnType<typeof setTimeout>;
  function onInput() {
    clearTimeout(timer);
    timer = setTimeout(run, 350);
  }

  async function run() {
    const q = ui.searchQuery.trim();
    const mine = ++seq;
    if (q.length < 2) {
      films = [];
      shows = [];
      people = [];
      error = '';
      return;
    }
    loading = true;
    error = '';
    const [f, s] = await Promise.allSettled([searchFilms(q), searchShows(q)]);
    if (mine !== seq) return;
    loading = false;
    films = f.status === 'fulfilled' ? f.value.films.slice(0, 8) : [];
    people = f.status === 'fulfilled' ? f.value.people : [];
    shows = s.status === 'fulfilled' ? s.value.slice(0, 6) : [];
    // Say which half is missing rather than showing an empty list as if nothing matched.
    if (f.status === 'rejected' && s.status === 'rejected') error = errorText(f.reason);
    else if (f.status === 'rejected') error = `Films and people unavailable just now: ${errorText(f.reason)}`;
    else if (s.status === 'rejected') error = `Series unavailable just now: ${errorText(s.reason)}`;
  }

  async function add(kind: 'film' | 'show', key: string | number, status: Status) {
    busy = `${key}`;
    try {
      const id = kind === 'film' ? await addFilm(key as string) : await addShow(key as number);
      if (status !== 'want') {
        if (kind === 'show' && status === 'watched') {
          // "Seen all" of a running show means caught up: it stays in progress for the next season.
          await seenAllAired(id);
          const t = await db.titles.get(id);
          if (t?.status !== 'watched') await update(id, { status: t?.showStatus === 'Ended' ? 'watched' : 'watching' });
        } else {
          await update(id, { status });
        }
      }
      added[id] = status;
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      busy = null;
    }
  }

  function open(id: string) {
    ui.searchOpen = false;
    go(titleHref(id).slice(1));
  }

  const trailerSearch = (name: string, year?: number) =>
    `https://www.youtube.com/results?search_query=${encodeURIComponent(`${name} ${year ?? ''} trailer`)}`;
</script>

<dialog bind:this={dialog} onclose={() => (ui.searchOpen = false)} aria-labelledby="search-h">
  <div class="dialog-body">
    <div class="spread">
      <h2 id="search-h">Add a film or series</h2>
      <button class="ghost icon" onclick={() => (ui.searchOpen = false)} aria-label="Close">✕</button>
    </div>
    <label class="sr-only" for="q">Title</label>
    <input id="q" type="search" bind:this={input} bind:value={ui.searchQuery} oninput={onInput} placeholder="Title or person…" autocomplete="off" enterkeyhint="search" onkeydown={(e) => e.key === 'Enter' && (clearTimeout(timer), run())} />

    <div class="results" aria-live="polite" aria-busy={loading}>
      {#if loading}<p class="muted small">Searching…</p>{/if}
      {#if error}<p class="small" style="color: var(--danger)">{error}</p>{/if}

      {#snippet hitRow(id: string, kind: 'film' | 'show', key: string | number, name: string, desc: string, poster: string | undefined, year: number | undefined)}
        {@const own = byId.get(id)}
        <li class="hit">
          <Poster src={poster} {name} size="xs" />
          <div class="info">
            <div class="name">{name}</div>
            <div class="muted small">{desc}</div>
            {#if added[id] === 'want' && own}
              <div class="follow">
                <span class="small muted">After the trailer, how keen are you?</span>
                <Scale max={5} value={own.expectation} labels={EXPECTATIONS} onpick={(v) => setExpectation(id, v)} compact />
                <a class="small" href={own.trailer ? `https://www.youtube.com/watch?v=${own.trailer}` : trailerSearch(name, year)} target="_blank" rel="noopener noreferrer">Watch trailer ↗</a>
              </div>
            {:else if added[id] === 'watching' && own?.kind === 'show'}
              <div class="follow">
                <ProgressPicker titleId={id} label="Where are you up to?" />
              </div>
            {:else if added[id] === 'watched' && own}
              <div class="follow">
                <span class="small muted">Your rating</span>
                <Scale max={10} value={own.rating} onpick={(v) => update(id, { rating: v })} compact />
              </div>
            {/if}
          </div>
          <div class="acts">
            {#if own}
              <button class="small" onclick={() => open(id)}>Open</button>
              {#if !added[id]}<span class="small muted">{own.status === 'want' ? 'On list' : 'In library'}</span>{/if}
            {:else if busy === `${key}`}
              <span class="small muted">Adding…</span>
            {:else}
              <button class="small primary" onclick={() => add(kind, key, 'want')}>Want</button>
              {#if kind === 'show'}
                <button class="small" onclick={() => add(kind, key, 'watching')}>Watching</button>
              {/if}
              <button class="small" onclick={() => add(kind, key, 'watched')}>{kind === 'show' ? 'Seen all' : 'Seen'}</button>
            {/if}
          </div>
        </li>
      {/snippet}

      {#if films.length}
        <h3 class="sub">Films</h3>
        <ul>
          {#each films as f (f.qid)}
            {@render hitRow(`wd:${f.qid}`, 'film', f.qid, f.name, f.description, f.poster, f.year)}
          {/each}
        </ul>
      {/if}
      {#if shows.length}
        <h3 class="sub">Series</h3>
        <ul>
          {#each shows as s (s.tvmaze)}
            {@render hitRow(`tvm:${s.tvmaze}`, 'show', s.tvmaze, s.name, s.description, s.poster, s.year)}
          {/each}
        </ul>
      {/if}
      {#if people.length}
        <h3 class="sub">People</h3>
        <ul class="people">
          {#each people as p (p.qid)}
            <li><a href={personHref(p.qid, p.name)}><strong>{p.name}</strong> <span class="muted small">{p.description}</span></a></li>
          {/each}
        </ul>
      {/if}
      {#if !loading && !error && ui.searchQuery.trim().length >= 2 && !films.length && !shows.length && !people.length}
        <p class="muted small">Nothing found. Try the original title, fewer words, or add the year (e.g. “Heat 1995”).</p>
      {/if}
    </div>
    <p class="muted small credit">Search titles or people (directors, writers, actors). Films from Wikipedia & Wikidata, series from TVmaze.</p>
  </div>
</dialog>

<style>
  dialog { margin-top: 5vh; }
  .results { margin-top: 0.75rem; min-height: 4rem; }
  .sub { margin: 1rem 0 0.4rem; font-size: 0.9rem; color: var(--muted); font-family: var(--sans); text-transform: uppercase; letter-spacing: 0.06em; }
  ul { list-style: none; padding: 0; margin: 0; }
  .hit { display: flex; gap: 0.75rem; align-items: flex-start; padding: 0.6rem 0; border-bottom: 1px solid var(--line); }
  .info { flex: 1; min-width: 0; }
  .name { font-weight: 600; }
  .acts { display: flex; gap: 0.35rem; flex-wrap: wrap; justify-content: flex-end; align-items: center; max-width: 45%; }
  .follow { margin-top: 0.4rem; display: grid; gap: 0.3rem; }
  .credit { margin: 1rem 0 0; }
  .people li { border-bottom: 1px solid var(--line); }
  .people a { display: block; padding: 0.6rem 0; color: var(--text); text-decoration: none; }
  @media (max-width: 520px) {
    .hit { flex-wrap: wrap; }
    .acts { max-width: none; width: 100%; justify-content: flex-start; padding-left: calc(48px + 0.75rem); }
  }
</style>
