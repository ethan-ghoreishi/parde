<script lang="ts">
  import { parseImport, resolve, commit, type Item, type Outcome, type Row, type ShowPlan } from '../lib/importer';
  import { titleHref } from '../lib/router.svelte';
  import { toast, errorText } from '../lib/ui.svelte';
  import ProgressPicker from '../components/ProgressPicker.svelte';
  import { db } from '../lib/db';

  let text = $state('');
  let fileName = $state('');
  let status = $state<Row['status']>('watched');
  let phase = $state<'input' | 'matching' | 'review' | 'adding' | 'done'>('input');
  let items = $state<Item[]>([]);
  let plans = $state<Record<number, ShowPlan>>({});
  let progress = $state({ done: 0, total: 0 });
  let outcome = $state<Outcome | null>(null);
  let names = $state<Record<string, string>>({});

  const rows = $derived(parseImport(text, status));
  const sure = $derived(items.filter((it) => it.sure && !it.owned));
  const unsure = $derived(items.filter((it) => !it.sure && it.candidates.length && !it.owned));
  const missing = $derived(items.filter((it) => !it.candidates.length));
  const owned = $derived(items.filter((it) => it.owned));
  const seenShows = $derived(items.filter((it) => it.pick >= 0 && it.candidates[it.pick]?.kind === 'show' && !it.owned && it.row.status === 'watched' && !it.row.upTo));
  const toAdd = $derived(items.filter((it) => it.pick >= 0 && it.candidates[it.pick]).length);

  async function pick(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    (e.currentTarget as HTMLInputElement).value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return toast('That file is too large for an import.', 'error');
    text = await file.text();
    fileName = file.name;
    // Letterboxd and IMDb watchlists have no ratings: they are things you want to see.
    status = /watchlist/i.test(file.name) ? 'want' : 'watched';
  }

  async function match() {
    if (navigator.onLine === false) return toast('You are offline. Matching needs Wikidata and TVmaze.', 'error');
    phase = 'matching';
    progress = { done: 0, total: rows.length };
    try {
      items = await resolve(rows, (done, total) => (progress = { done, total }));
      plans = {};
      phase = 'review';
    } catch (e) {
      toast(errorText(e), 'error');
      phase = 'input';
    }
  }

  async function add() {
    phase = 'adding';
    progress = { done: 0, total: toAdd };
    try {
      outcome = await commit(items, plans, (done, total) => (progress = { done, total }));
      names = Object.fromEntries((await db.titles.bulkGet(outcome.toPlace)).filter(Boolean).map((t) => [t!.id, t!.name]));
      phase = 'done';
    } catch (e) {
      toast(errorText(e), 'error');
      phase = 'review';
    }
  }

  const label = (it: Item, i: number) => {
    const m = it.candidates[i];
    return `${m.name}${m.year ? ` (${m.year})` : ''} · ${m.kind === 'show' ? 'series' : 'film'}${m.note ? ` · ${m.note.slice(0, 40)}` : ''}`;
  };
  const showIndex = (it: Item) => items.indexOf(it);
</script>

<h1>Import your history</h1>

{#if phase === 'input'}
  <section class="card stack">
    <p>Bring in what you have already seen and rated, so Parde knows your taste from day one. Nothing is overwritten: titles already in your library only get a missing rating filled in.</p>
    <details>
      <summary><strong>From Letterboxd or IMDb</strong></summary>
      <ul class="small">
        <li><strong>Letterboxd</strong>: Settings → Data → Export your data. Unzip it and choose <code>ratings.csv</code> (or <code>watched.csv</code>, <code>diary.csv</code>, <code>watchlist.csv</code>).</li>
        <li><strong>IMDb</strong>: Your Ratings → ⋯ → Export (or your Watchlist → Export). IMDb ids match exactly, including series.</li>
      </ul>
    </details>
    <label class="btn file">Choose a CSV or text file…<input type="file" accept=".csv,.txt,text/csv,text/plain" onchange={pick} /></label>
    <label for="imp-text">…or type or paste a list, one per line</label>
    <textarea id="imp-text" bind:value={text} placeholder={'Heat 1995 9\nPast Lives 8/10\nAmélie ★★★★½\nSeverance S02E03\nThe Bear (series)'}></textarea>
    <p class="small muted">A year makes matching exact. A rating (out of 10, or stars) is optional. For a series, <code>S02E03</code> records where you are.</p>
    <div class="row" role="group" aria-label="These are">
      <span class="small muted">Lines without a rating are</span>
      <button class="chip" class:on={status === 'watched'} aria-pressed={status === 'watched'} onclick={() => (status = 'watched')}>Seen</button>
      <button class="chip" class:on={status === 'want'} aria-pressed={status === 'want'} onclick={() => (status = 'want')}>Want to watch</button>
    </div>
    <div class="row">
      <button class="primary" onclick={match} disabled={!rows.length}>Find {rows.length || ''} title{rows.length === 1 ? '' : 's'}</button>
      {#if fileName}<span class="small muted">{fileName}</span>{/if}
    </div>
    <p class="small muted">Matching asks Wikidata, Wikipedia and TVmaze about each title. Large lists take a few minutes; keep this page open.</p>
  </section>
{:else if phase === 'matching' || phase === 'adding'}
  <section class="card stack" aria-live="polite">
    <p>{phase === 'matching' ? 'Matching' : 'Adding'} {progress.done} of {progress.total}…</p>
    <progress max={progress.total || 1} value={progress.done}></progress>
    <p class="small muted">Keep this page open. If you leave or the phone locks, run the same import again: anything already added is skipped.</p>
  </section>
{:else if phase === 'review'}
  <section class="stack">
    <p>
      <strong>{sure.length}</strong> ready ·
      <strong>{unsure.length}</strong> to check ·
      <strong>{missing.length}</strong> not found{owned.length ? ` · ${owned.length} already in your library` : ''}
    </p>

    {#if unsure.length}
      <div class="card stack">
        <h2>Check these</h2>
        <p class="small muted">More than one title fits. The first choice is the best guess; pick another or skip.</p>
        <ul class="rows">
          {#each unsure as it (it.row.line)}
            <li>
              <span class="raw">“{it.row.raw}”</span>
              <select aria-label="Match for {it.row.raw}" bind:value={it.pick}>
                {#each it.candidates as _, i}<option value={i}>{label(it, i)}</option>{/each}
                <option value={-1}>Skip</option>
              </select>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if seenShows.length}
      <div class="card stack">
        <h2>Series you have seen</h2>
        <p class="small muted">All of it so far, or only some? If only some, you can set where you are right after.</p>
        <ul class="rows">
          {#each seenShows as it (it.row.line)}
            {@const i = showIndex(it)}
            <li>
              <span class="raw">{it.candidates[it.pick].name}</span>
              <span class="row">
                <button class="chip" class:on={plans[i] !== 'partly'} aria-pressed={plans[i] !== 'partly'} onclick={() => (plans[i] = 'all')}>All of it</button>
                <button class="chip" class:on={plans[i] === 'partly'} aria-pressed={plans[i] === 'partly'} onclick={() => (plans[i] = 'partly')}>Some</button>
              </span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <details class="card">
      <summary>Ready to add ({sure.length})</summary>
      <ul class="rows small">
        {#each sure as it (it.row.line)}
          <li>
            <span class="raw">{label(it, it.pick >= 0 ? it.pick : 0)}{it.row.rating ? ` · ${it.row.rating}/10` : ''}</span>
            <label class="row keep"><input type="checkbox" checked={it.pick >= 0} onchange={(e) => (it.pick = e.currentTarget.checked ? 0 : -1)} /> add</label>
          </li>
        {/each}
      </ul>
    </details>

    {#if missing.length}
      <details class="card">
        <summary>Not found ({missing.length})</summary>
        <ul class="small">{#each missing as it}<li>{it.row.raw}</li>{/each}</ul>
        <p class="small muted">Try adding these one by one from Add, perhaps with the year or original title.</p>
      </details>
    {/if}

    <div class="row">
      <button class="primary" onclick={add} disabled={!toAdd}>Add {toAdd} title{toAdd === 1 ? '' : 's'}</button>
      <button class="ghost" onclick={() => (phase = 'input')}>Back</button>
    </div>
  </section>
{:else if outcome}
  <section class="card stack">
    <h2>Done</h2>
    <p>Added {outcome.added.length}{outcome.updated ? `, filled in ${outcome.updated} rating${outcome.updated === 1 ? '' : 's'}` : ''}.</p>
    {#if outcome.toPlace.length}
      <h3>Where are you in these?</h3>
      <ul class="rows">
        {#each outcome.toPlace as id (id)}
          <li><a href={titleHref(id)}>{names[id] ?? id}</a><ProgressPicker titleId={id} label="" /></li>
        {/each}
      </ul>
    {/if}
    {#if outcome.failed.length}
      <details open>
        <summary>{outcome.failed.length} could not be added</summary>
        <ul class="small">{#each outcome.failed as f}<li>{f.row.raw} <span class="muted">— {f.error}</span></li>{/each}</ul>
      </details>
    {/if}
    <div class="row">
      <a class="btn primary" href="#/library">See your library</a>
      <a class="btn" href="#/taste">See your taste</a>
      <button class="ghost" onclick={() => { text = ''; fileName = ''; phase = 'input'; }}>Import more</button>
    </div>
  </section>
{/if}

<style>
  .file { position: relative; overflow: hidden; align-self: start; }
  .file input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
  details ul { margin: 0.5rem 0 0; padding-left: 1.1rem; }
  summary { cursor: pointer; }
  progress { width: 100%; height: 10px; accent-color: var(--accent); }
  .rows { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.5rem; }
  .rows li { display: flex; gap: 0.5rem; align-items: center; justify-content: space-between; flex-wrap: wrap; border-top: 1px solid var(--line); padding-top: 0.5rem; }
  .rows select { width: auto; flex: 1 1 16rem; }
  .raw { flex: 1 1 10rem; min-width: 0; overflow-wrap: anywhere; }
  .keep { margin: 0; gap: 0.3rem; color: var(--text); }
</style>
