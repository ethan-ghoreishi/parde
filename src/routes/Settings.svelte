<script lang="ts">
  import { onMount } from 'svelte';
  import { db, getSetting, setSetting, type Link } from '../lib/db';
  import { live } from '../lib/live.svelte';
  import { buildBackup, saveBackup, shareBackup, parseBackup, restore, undoRestore, undoInfo, type Backup, type Restored } from '../lib/backup';
  import { moveDomain, persistStorage } from '../lib/actions';
  import { hostOf } from '../lib/links';
  import { DEFAULT_SITES, validSite, type Site } from '../lib/sites';
  import { formatDay, ago } from '../lib/format';
  import { toast, errorText } from '../lib/ui.svelte';

  const data = live(
    () => async () => ({
      lastBackup: await getSetting<string>('lastBackupAt', ''),
      partner: await getSetting('partner', ''),
      sites: (await getSetting<Site[]>('sites', DEFAULT_SITES)).filter(validSite),
      undo: await undoInfo(),
      links: await db.links.toArray(),
      count: await db.titles.count(),
    }),
    { lastBackup: '', partner: '', sites: DEFAULT_SITES, undo: null as Awaited<ReturnType<typeof undoInfo>>, links: [] as Link[], count: 0 },
  );

  let persisted = $state<boolean | null>(null);
  onMount(async () => {
    persisted = (await navigator.storage?.persisted?.()) ?? null;
  });

  async function exportNow() {
    try {
      const b = await buildBackup();
      // Read it back first: a backup that could not be restored is worse than none.
      const check = parseBackup(JSON.stringify(b));
      if (!check.ok) throw new Error(`Parde could not make a backup it can read back. ${check.error}`);
      unreadable = check.problems;
      const r = await saveBackup(b);
      if (r === 'cancelled') return toast('Backup not saved', 'error');
      // Safari can refuse a share that did not start straight from a tap: offer one.
      if (r === 'blocked') return toast('Backup ready', 'ok', { label: 'Save', run: async () => (await shareBackup(b)) === 'saved' && saved(b) });
      await saved(b);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  async function saved(b: Backup) {
    await setSetting('lastBackupAt', b.exportedAt);
    persistStorage();
    // Parde hands the file over; where it ends up is between you and the browser.
    toast('Backup handed over. Check the file is where you want it.');
  }

  let unreadable = $state<string[]>([]);
  const n = (x: number, one: string, many = `${one}s`) => `${x} ${x === 1 ? one : many}`;
  function summary(r: Restored): string {
    if (r.mode === 'replace') return `Replaced: ${n(r.added, 'title')}, ${n(r.marks, 'episode')} seen, ${n(r.links, 'source')}, ${n(r.watches, 'viewing')}.`;
    const parts = [
      r.added && `${n(r.added, 'title')} added`, r.updated && `${n(r.updated, 'title')} updated`, r.marks && `${n(r.marks, 'episode')} marked seen`,
      r.links && `${n(r.links, 'source')} added`, r.linkEdits && `${n(r.linkEdits, 'source')} updated`,
      r.recovered && `${n(r.recovered, 'other record')} recovered`, r.watches && `${n(r.watches, 'viewing')} added`,
    ].filter(Boolean);
    return `${parts.length ? `Merged: ${parts.join(', ')}.` : 'Nothing new in that file.'}${r.leftOut ? ` ${n(r.leftOut, 'record')} skipped because of a deletion or conflict.` : ''}`;
  }
  let done = $state('');

  let pending = $state.raw<{ backup: Backup; counts: Record<string, number>; name: string; problems: string[] } | null>(null);
  let importError = $state('');
  let reading = 0;
  let restoring = $state(false);
  async function pick(e: Event) {
    const read = ++reading;
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    (e.currentTarget as HTMLInputElement).value = '';
    importError = '';
    done = '';
    pending = null;
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) return (importError = 'That file is too large to be a Parde backup.');
    try {
      const parsed = parseBackup(await file.text());
      if (read !== reading) return;
      if (!parsed.ok) return (importError = parsed.error);
      pending = { backup: parsed.backup, counts: parsed.counts, name: file.name, problems: parsed.problems };
    } catch (e) {
      if (read === reading) importError = errorText(e);
    }
  }

  async function apply(mode: 'merge' | 'replace') {
    if (!pending || restoring) return;
    if (mode === 'replace' && !confirm(`Replace everything in this browser with ${pending.name}? What is here now is kept aside so you can undo this straight afterwards.`)) return;
    restoring = true;
    try {
      done = summary(await restore(pending.backup, mode));
      pending = null;
      toast(mode === 'merge' ? 'Merged' : 'Restored', 'ok', { label: 'Undo', run: () => undo(false) });
    } catch (e) {
      toast(`Nothing was changed: ${errorText(e)}`, 'error');
    } finally {
      restoring = false;
    }
  }

  /** Undo (or redo) the last restore. Nothing is lost either way: the other side is kept to switch back to. */
  async function undo(ask = true) {
    const u = data.value.undo ?? (await undoInfo());
    if (!u) return toast('Nothing to undo');
    const what = u.kind === 'undo' ? 'the restored data' : 'what was here before the restore';
    if (ask && !confirm(`Put back ${what} (from ${ago(u.at)})? Anything changed since then is kept aside too, so you can switch back afterwards.`)) return;
    try {
      toast((await undoRestore()) ? `Put back ${what}` : 'Nothing to undo');
      done = '';
    } catch (e) {
      toast(`Nothing was changed: ${errorText(e)}`, 'error');
    }
  }

  // ----- Sites -----
  let siteName = $state('');
  let siteUrlIn = $state('');
  async function addSite() {
    const s = { name: siteName.trim(), url: siteUrlIn.trim() };
    if (!validSite(s)) return toast('Give it a name and a search address containing {q}', 'error');
    await setSetting('sites', [...data.value.sites, s]);
    siteName = '';
    siteUrlIn = '';
  }
  const removeSite = (i: number) => setSetting('sites', data.value.sites.filter((_, j) => j !== i));

  // ----- Hosts -----
  const hosts = $derived(
    [...data.value.links.reduce((m, l) => {
      const h = hostOf(l.url);
      const x = m.get(h) ?? { total: 0, broken: 0 };
      x.total++;
      if (l.broken) x.broken++;
      return m.set(h, x);
    }, new Map<string, { total: number; broken: number }>())].sort((a, b) => b[1].total - a[1].total),
  );
  let moving = $state<string | null>(null);
  let newDomain = $state('');
  async function doMove(from: string) {
    try {
      const n = await moveDomain(from, newDomain);
      toast(`Updated ${n} link${n === 1 ? '' : 's'}`);
      moving = null;
      newDomain = '';
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  const ios = /iPhone|iPad/.test(navigator.userAgent) && !matchMedia('(display-mode: standalone)').matches;
</script>

<h1>Settings & backup</h1>

<section class="section card stack">
  <h2>Backup</h2>
  <p class="small">Your collection lives only in this browser. Download a backup now and then and keep it somewhere safe; restoring it on any device brings everything back.</p>
  <p class="small muted">
    {data.value.lastBackup ? `Last backup: ${formatDay(data.value.lastBackup.slice(0, 10))} (${ago(data.value.lastBackup)}).` : 'Never backed up.'}
    {data.value.count} titles.
    {#if persisted === true}Storage is protected from automatic clearing.{:else if persisted === false}The browser may clear storage under pressure: install Parde or back up regularly.{/if}
  </p>
  <div class="row">
    <button class="primary" onclick={exportNow}>Save a backup</button>
    <label class="btn file">Restore from file…<input type="file" accept="application/json,.json" onchange={pick} /></label>
  </div>
  {#if importError}<p class="small" style="color: var(--danger)" role="alert">{importError}</p>{/if}
  {#if pending}
    <div class="card preview stack" role="region" aria-label="Backup preview">
      <p class="small"><strong>{pending.name}</strong>{pending.backup.exportedAt ? `, made ${formatDay(pending.backup.exportedAt.slice(0, 10))}` : ''}: {pending.counts.titles} titles, {pending.counts.links} sources, {pending.counts.seen} episodes seen, {pending.counts.watches} viewings.</p>
      <div class="row">
        <button class="primary" disabled={restoring} onclick={() => apply('merge')}>Merge into this browser</button>
        {#if !pending.problems.length}<button class="danger" onclick={() => apply('replace')}>Replace everything</button>{/if}
        <button class="ghost" onclick={() => (pending = null)}>Cancel</button>
      </div>
      {#if pending.problems.length}
        <div class="small" role="alert">
          <p>{n(pending.problems.length, 'record')} in this file cannot be read and will be left out, so it can be merged but not used to replace everything:</p>
          <ul>{#each pending.problems.slice(0, 5) as p}<li>{p}</li>{/each}</ul>
          {#if pending.problems.length > 5}<p>…and {pending.problems.length - 5} more.</p>{/if}
        </div>
      {/if}
      <p class="small muted">Merge adds missing records and uses the latest dated edits. Deletions made on this device stay in effect. Undo swaps back to the collection you had immediately before the restore.</p>
    </div>
  {/if}
  {#if done}<p class="small" role="status">{done}</p>{/if}
  {#if unreadable.length}
    <p class="small" role="alert">{n(unreadable.length, 'record')} here cannot be read back from a backup, for example {unreadable[0]}. Everything else is in the file.</p>
  {/if}
  {#if data.value.undo && !pending}
    <p class="small muted">
      {data.value.undo.kind === 'undo' ? `Undid a restore ${ago(data.value.undo.at)}.` : `Restored ${ago(data.value.undo.at)}.`}
      <button class="small" onclick={() => undo()}>{data.value.undo.kind === 'undo' ? 'Redo the restore' : 'Undo that restore'}</button>
    </p>
  {/if}
  {#if ios}
    <p class="small muted">On iPhone and iPad, tap Share → Add to Home Screen. Safari can clear data for websites you have not opened for a while; the installed app is kept.</p>
  {/if}
</section>

<section class="section card stack">
  <h2>Import</h2>
  <p class="small">Bring in your history from Letterboxd, IMDb or a typed list, with ratings and where you are in series.</p>
  <a class="btn" href="#/import">Import ratings and history…</a>
</section>

<section class="section card stack">
  <h2>Who you watch with</h2>
  <label for="partner">Partner's name (adds a second rating when you watch together)</label>
  <input id="partner" type="text" value={data.value.partner} onchange={(e) => setSetting('partner', e.currentTarget.value.trim())} placeholder="Optional" style="max-width: 320px" />
</section>

<section class="section card stack">
  <h2>Sites to search when a link breaks</h2>
  <p class="small muted">Shown as “Find on …” under every source list. Use <code>{'{q}'}</code> where the title goes, and <code>{'{ss}'}</code>/<code>{'{ee}'}</code> if it can search for an episode.</p>
  <ul class="list">
    {#each data.value.sites as s, i}
      <li class="spread"><span><strong>{s.name}</strong> <span class="small muted break">{s.url}</span></span><button class="small ghost danger" onclick={() => removeSite(i)} aria-label="Remove {s.name}">Remove</button></li>
    {/each}
  </ul>
  <form class="row" onsubmit={(e) => { e.preventDefault(); addSite(); }}>
    <input type="text" bind:value={siteName} placeholder="Name" aria-label="Site name" style="flex: 1 1 120px; width: auto" />
    <input type="text" inputmode="url" autocapitalize="off" spellcheck="false" bind:value={siteUrlIn} placeholder={'https://example.org/search?q={q}'} aria-label="Search address" style="flex: 3 1 240px; width: auto" />
    <button type="submit">Add site</button>
  </form>
</section>

<section class="section card stack">
  <h2>Your saved sources</h2>
  {#if !hosts.length}
    <p class="small muted">Links you save on films and episodes are grouped here by site.</p>
  {:else}
    <p class="small muted">When a site moves to a new address, update every saved link at once.</p>
    <ul class="list">
      {#each hosts as [h, n] (h)}
        <li>
          <div class="spread">
            <span><strong>{h}</strong> <span class="small muted">{n.total} link{n.total === 1 ? '' : 's'}{n.broken ? `, ${n.broken} broken` : ''}</span></span>
            <button class="small" onclick={() => { moving = moving === h ? null : h; newDomain = ''; }}>Site moved…</button>
          </div>
          {#if moving === h}
            <form class="row move" onsubmit={(e) => { e.preventDefault(); doMove(h); }}>
              <input type="text" bind:value={newDomain} placeholder="new-domain.example" aria-label="New domain for {h}" style="flex: 1; width: auto" />
              <button class="primary small" type="submit">Update links</button>
            </form>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<section class="section small muted stack">
  <h2>About</h2>
  <p>Parde {__APP_VERSION__}. Private and local: no account, no tracking, no AI at runtime. Searches send only the title you type to Wikipedia, Wikidata and TVmaze.</p>
  <p>
    Film data from <a href="https://www.wikidata.org" target="_blank" rel="noopener noreferrer">Wikidata</a> (CC0) and
    <a href="https://en.wikipedia.org" target="_blank" rel="noopener noreferrer">Wikipedia</a> (CC BY-SA). Series data from
    <a href="https://www.tvmaze.com" target="_blank" rel="noopener noreferrer">TVmaze</a> (CC BY-SA). Posters belong to their rights holders.
  </p>
</section>

<style>
  .file { position: relative; overflow: hidden; }
  .file input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
  .preview { background: var(--surface-2); }
  .list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
  .list li { border-top: 1px solid var(--line); padding-top: 0.5rem; }
  .break { word-break: break-all; }
  .move { margin-top: 0.5rem; }
</style>
