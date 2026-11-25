<script lang="ts">
  import { onMount } from 'svelte';
  import { db, type Status, type Title } from '../lib/db';
  import { live } from '../lib/live.svelte';
  import { titleHref } from '../lib/router.svelte';
  import { credits, personInfo, findPerson, posters, type Credit, type CreditRole, type PersonInfo } from '../lib/api/wiki';
  import { findShow } from '../lib/api/tvmaze';
  import { addFilm, addShow, update, seenAllAired } from '../lib/actions';
  import { toast, errorText } from '../lib/ui.svelte';
  import { mean } from '../lib/taste';
  import Poster from '../components/Poster.svelte';
  import Scale from '../components/Scale.svelte';

  let { qid: givenQid, name: givenName }: { qid?: string; name: string } = $props();

  const lib = live(() => () => db.titles.toArray(), [] as Title[]);
  let info = $state<PersonInfo | null>(null);
  let work = $state<Credit[] | null>(null);
  let pics = $state<Record<string, string>>({});
  let error = $state('');
  let busy = $state<Record<string, boolean>>({});
  let role = $state<CreditRole | 'all'>('all');
  /** Titles marked seen here, so their row can ask for a rating */
  let justSeen = $state<Record<string, string>>({});

  const qid = $derived(info?.qid ?? givenQid);
  const name = $derived(info?.name ?? givenName);
  const mine = $derived(lib.value.filter((t) => t.people.some((p) => (qid && p.qid === qid) || p.name === givenName)));
  const mineAvg = $derived(mean(mine.filter((t) => t.rating !== undefined).map((t) => t.rating!)));
  const owned = (c: Credit) => lib.value.find((t) => t.id === `wd:${c.qid}` || t.qid === c.qid || (c.tvmaze && t.tvmaze === c.tvmaze));
  const roles = $derived([...new Set((work ?? []).flatMap((c) => c.roles))]);
  const shown = $derived((work ?? []).filter((c) => role === 'all' || c.roles.includes(role)));
  // Long filmographies come in pages, and posters only for what is on screen: one request per 50.
  let limit = $state(40);
  const visible = $derived(shown.slice(0, limit));
  const asked = new Set<string>();
  $effect(() => {
    const need = [info?.wiki, ...visible.map((c) => c.wiki)].filter((w): w is string => !!w && !asked.has(w));
    if (!need.length) return;
    for (const w of need) asked.add(w);
    posters(need).then((p) => (pics = { ...pics, ...p }), () => {});
  });
  const thisYear = new Date().getFullYear();

  onMount(async () => {
    try {
      let id = givenQid;
      if (!id) {
        const hit = await findPerson(givenName);
        if (!hit) {
          error = `Wikidata has no one named exactly ${givenName}, so only what is in your library is shown.`;
          return;
        }
        id = hit.qid;
      }
      const [i, c] = await Promise.all([personInfo(id), credits([id])]);
      info = i;
      // Announced (undated or future) first, then newest.
      work = c.sort((a, b) => (b.year ?? 9999) - (a.year ?? 9999) || a.name.localeCompare(b.name));
    } catch (e) {
      error = errorText(e);
    }
  });

  async function add(c: Credit, status: Status) {
    if (busy[c.qid]) return;
    busy[c.qid] = true;
    try {
      let id: string;
      if (c.kind === 'film') id = await addFilm(c.qid, { status });
      else {
        const tvm = c.tvmaze ?? (await findShow(c.name, c.year));
        if (!tvm) throw new Error(`${c.name} is not on TVmaze, so Parde cannot track its episodes.`);
        id = await addShow(tvm);
      }
      if (status === 'watched') {
        if (c.kind === 'show') await seenAllAired(id);
        justSeen[c.qid] = id;
      } else toast(`${c.name} added to your list`);
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      busy[c.qid] = false;
    }
  }

  const roleText: Record<CreditRole, string> = { directed: 'Directed', wrote: 'Wrote', created: 'Created', acted: 'Acted' };
</script>

<article class="fade">
  <header class="head">
    <Poster src={info?.wiki ? pics[info.wiki] : undefined} name={name} size="sm" />
    <div>
      <h1>{name}</h1>
      {#if info?.description}<p class="muted">{info.description}</p>{/if}
      {#if info?.wiki}<a class="small" href="https://en.wikipedia.org/wiki/{encodeURIComponent(info.wiki.replace(/ /g, '_'))}" target="_blank" rel="noopener noreferrer">Wikipedia ↗</a>{/if}
    </div>
  </header>

  {#if mine.length}
    <section class="section">
      <h2>In your library</h2>
      <p class="small muted">{mine.length} title{mine.length > 1 ? 's' : ''}{Number.isNaN(mineAvg) ? '' : ` · you rate them ${mineAvg.toFixed(1)} on average`}</p>
      <ul class="grid lib">
        {#each mine as t (t.id)}
          <li><a href={titleHref(t.id)} class="tile"><Poster src={t.poster} name={t.name} /><span class="name">{t.name}</span><span class="small muted">{[t.year, t.rating ? `${t.rating}/10` : ''].filter(Boolean).join(' · ')}</span></a></li>
        {/each}
      </ul>
    </section>
  {/if}

  <section class="section">
    <div class="spread">
      <h2>Filmography</h2>
      {#if roles.length > 1}
        <div class="row" role="group" aria-label="Role">
          <button class="chip" class:on={role === 'all'} aria-pressed={role === 'all'} onclick={() => ((role = 'all'), (limit = 40))}>All</button>
          {#each roles as r}<button class="chip" class:on={role === r} aria-pressed={role === r} onclick={() => ((role = r), (limit = 40))}>{roleText[r]}</button>{/each}
        </div>
      {/if}
    </div>
    {#if error}
      <p class="small" role="alert">{error}</p>
    {:else if !work}
      <p class="muted small" aria-busy="true">Looking up their work on Wikidata…</p>
    {:else if !shown.length}
      <p class="muted small">Wikidata lists no films or series for {name}.</p>
    {:else}
      <ul class="work">
        {#each visible as c (c.qid)}
          {@const own = owned(c)}
          <li>
            <Poster src={c.wiki ? pics[c.wiki] : undefined} name={c.name} size="xs" />
            <div class="info">
              {#if own}<a class="name" href={titleHref(own.id)}>{c.name}</a>{:else}<span class="name">{c.name}</span>{/if}
              <div class="small muted">
                {[!c.year || c.year > thisYear ? (c.year ? `${c.year}, announced` : 'Announced') : c.year, c.kind === 'show' ? 'Series' : '', c.roles.map((r) => roleText[r].toLowerCase()).join(', ')].filter(Boolean).join(' · ')}
              </div>
              {#if justSeen[c.qid] && own}
                <div class="rate"><span class="small muted">Your rating</span><Scale max={10} value={own.rating} onpick={(v) => update(own.id, { rating: v })} compact /></div>
              {/if}
            </div>
            <div class="acts">
              {#if own}
                <span class="small muted">{own.rating ? `${own.rating}/10` : own.status === 'want' ? 'On your list' : 'In library'}</span>
              {:else if busy[c.qid]}
                <span class="small muted">Adding…</span>
              {:else}
                <button class="small primary" onclick={() => add(c, 'want')}>Want</button>
                {#if c.year && c.year <= thisYear}<button class="small" onclick={() => add(c, 'watched')}>{c.kind === 'show' ? 'Seen all' : 'Seen'}</button>{/if}
              {/if}
            </div>
          </li>
        {/each}
      </ul>
      {#if shown.length > limit}
        <button class="small" onclick={() => (limit += 40)}>Show more ({shown.length - limit} left)</button>
      {/if}
      <p class="small muted">From Wikidata, which can be incomplete, especially for television.</p>
    {/if}
  </section>
</article>

<style>
  .head { display: flex; gap: 1rem; align-items: flex-start; }
  .lib { list-style: none; padding: 0; margin: 0; }
  .tile { display: grid; gap: 0.3rem; text-decoration: none; color: var(--text); }
  .tile .name { font-weight: 600; font-size: 0.92rem; line-height: 1.25; }
  .work { list-style: none; padding: 0; margin: 0.75rem 0; display: grid; }
  .work li { display: flex; gap: 0.75rem; align-items: center; padding: 0.5rem 0; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .info { flex: 1; min-width: 10rem; }
  .info .name { font-weight: 600; color: var(--text); text-decoration: none; }
  a.name { color: var(--accent); }
  .rate { display: grid; gap: 0.25rem; margin-top: 0.35rem; }
  .acts { display: flex; gap: 0.35rem; align-items: center; }
</style>
