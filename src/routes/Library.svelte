<script lang="ts">
  import { db, type Status, type Title } from '../lib/db';
  import { live } from '../lib/live.svelte';
  import { route, go, titleHref } from '../lib/router.svelte';
  import { ui } from '../lib/ui.svelte';
  import { EXPECTATIONS } from '../lib/taste';
  import Poster from '../components/Poster.svelte';

  const titles = live(() => () => db.titles.toArray(), [] as Title[]);

  const p = $derived(route.params);
  const status = $derived((p.get('status') ?? 'all') as Status | 'all' | 'active');
  const kind = $derived(p.get('kind') ?? 'all');
  const genre = $derived(p.get('genre') ?? '');
  const person = $derived(p.get('person') ?? '');
  const theme = $derived(p.get('theme') ?? '');
  const sort = $derived(p.get('sort') ?? 'recent');
  let q = $state('');

  function setParam(k: string, v: string) {
    const n = new URLSearchParams(p);
    if (v && v !== 'all' && !(k === 'sort' && v === 'recent')) n.set(k, v);
    else n.delete(k);
    const s = n.toString();
    go(`/library${s ? `?${s}` : ''}`);
  }

  const statusTabs: [string, string][] = [
    ['all', 'All'],
    ['want', 'Want'],
    ['active', 'Watching'],
    ['watched', 'Watched'],
    ['dropped', 'Dropped'],
  ];

  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

  const list = $derived.by(() => {
    const needle = fold(q.trim());
    const out = titles.value.filter(
      (t) =>
        (status === 'all' || (status === 'active' ? t.status === 'watching' || t.status === 'paused' : t.status === status)) &&
        (kind === 'all' || t.kind === kind) &&
        (!genre || t.genres.includes(genre)) &&
        (!person || t.people.some((x) => x.name === person)) &&
        (!theme || !!t.themes?.includes(theme)) &&
        (!needle || fold(t.name).includes(needle) || t.people.some((x) => fold(x.name).includes(needle))),
    );
    const cmp: Record<string, (a: Title, b: Title) => number> = {
      recent: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
      added: (a, b) => b.addedAt.localeCompare(a.addedAt),
      title: (a, b) => a.name.localeCompare(b.name),
      rating: (a, b) => (b.rating ?? -1) - (a.rating ?? -1) || (b.expectation ?? 0) - (a.expectation ?? 0),
      year: (a, b) => (b.year ?? 0) - (a.year ?? 0),
    };
    return out.sort(cmp[sort] ?? cmp.recent);
  });

  const genres = $derived([...new Set(titles.value.flatMap((t) => t.genres))].sort());
  const statusLabel: Record<Status, string> = { want: 'Want', watching: 'Watching', paused: 'Paused', watched: 'Watched', dropped: 'Dropped' };
</script>

<div class="spread">
  <h1>Library</h1>
  <span class="muted small">{list.length} of {titles.value.length}</span>
</div>

<div class="controls stack">
  <div class="row" role="group" aria-label="Status">
    {#each statusTabs as [k, label]}
      <button class="chip" class:on={status === k} aria-pressed={status === k} onclick={() => setParam('status', k)}>{label}</button>
    {/each}
  </div>
  <div class="row filters">
    <label class="sr-only" for="lib-q">Filter</label>
    <input id="lib-q" type="search" bind:value={q} placeholder="Filter by title or person" />
    <label class="sr-only" for="lib-kind">Type</label>
    <select id="lib-kind" value={kind} onchange={(e) => setParam('kind', e.currentTarget.value)}>
      <option value="all">Films & series</option>
      <option value="film">Films</option>
      <option value="show">Series</option>
    </select>
    <label class="sr-only" for="lib-genre">Genre</label>
    <select id="lib-genre" value={genre} onchange={(e) => setParam('genre', e.currentTarget.value)}>
      <option value="">All genres</option>
      {#each genres as g}<option>{g}</option>{/each}
    </select>
    <label class="sr-only" for="lib-sort">Sort</label>
    <select id="lib-sort" value={sort} onchange={(e) => setParam('sort', e.currentTarget.value)}>
      <option value="recent">Recently active</option>
      <option value="added">Recently added</option>
      <option value="rating">Your rating</option>
      <option value="year">Release year</option>
      <option value="title">Title A–Z</option>
    </select>
  </div>
  {#if person}
    <div class="row"><span class="chip on">{person}</span><button class="small ghost" onclick={() => setParam('person', '')}>Clear</button></div>
  {/if}
  {#if theme}
    <div class="row"><span class="chip on">About {theme}</span><button class="small ghost" onclick={() => setParam('theme', '')}>Clear</button></div>
  {/if}
</div>

{#if titles.ready && !titles.value.length}
  <div class="empty">Your library is empty. <button class="small primary" onclick={() => (ui.searchOpen = true)}>Add a title</button></div>
{:else if titles.ready && !list.length}
  <div class="empty">Nothing matches these filters.</div>
{:else}
  <ul class="grid lib">
    {#each list as t (t.id)}
      <li>
        <a href={titleHref(t.id)} class="tile">
          <Poster src={t.poster} name={t.name} />
          <span class="badge">
            {#if t.rating}<span class="r" aria-label="Your rating {t.rating} of 10">{t.rating}</span>{:else if t.expectation && t.status === 'want'}<span class="e" title="After the trailer: {EXPECTATIONS[t.expectation]}">{'★'.repeat(t.expectation)}</span>{/if}
          </span>
          <span class="name">{t.name}</span>
          <span class="meta small muted">{[t.year, t.kind === 'show' ? 'Series' : '', status === 'all' ? statusLabel[t.status] : ''].filter(Boolean).join(' · ')}</span>
        </a>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .controls { margin: 0.75rem 0 1.25rem; }
  .filters input { flex: 2 1 200px; width: auto; }
  .filters select { flex: 1 1 140px; width: auto; }
  .lib { list-style: none; padding: 0; margin: 0; }
  .tile { display: grid; gap: 0.3rem; text-decoration: none; color: var(--text); position: relative; }
  .tile:hover .name { color: var(--accent); }
  .name { font-weight: 600; font-size: 0.92rem; line-height: 1.25; }
  .badge { position: absolute; top: 6px; right: 6px; }
  .badge .r { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: var(--accent); color: var(--accent-ink); font-weight: 700; font-size: 0.9rem; }
  .badge .e { background: rgb(0 0 0 / 0.65); color: #f5c46b; padding: 1px 6px; border-radius: 999px; font-size: 0.7rem; }
</style>
