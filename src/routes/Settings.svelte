<script lang="ts">
  import { onMount } from 'svelte';
  import { db, getSetting, setSetting, type Link } from '../lib/db';
  import { live } from '../lib/live.svelte';
  import { buildBackup, saveBackup, parseBackup, restore, undoRestore, UNDO_KEY, type Backup } from '../lib/backup';
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
      undoAt: (await getSetting<{ at?: string } | null>(UNDO_KEY, null))?.at ?? '',
      links: await db.links.toArray(),
      count: await db.titles.count(),
    }),
    { lastBackup: '', partner: '', sites: DEFAULT_SITES, undoAt: '', links: [] as Link[], count: 0 },
  );

  let persisted = $state<boolean | null>(null);
  onMount(async () => {
    persisted = (await navigator.storage?.persisted?.()) ?? null;
  });

  async function exportNow() {
    try {
      const b = await buildBackup();
      if (!(await saveBackup(b))) return toast('Backup not saved', 'error');
      await setSetting('lastBackupAt', b.exportedAt);
      persistStorage();
      toast('Backup saved. Keep it somewhere safe (iCloud Drive, NAS…).');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  let pending = $state.raw<{ backup: Backup; counts: Record<string, number>; name: string } | null>(null);
  let importError = $state('');
  async function pick(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    (e.currentTarget as HTMLInputElement).value = '';
    importError = '';
    pending = null;
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) return (importError = 'That file is too large to be a Parde backup.');
    const parsed = parseBackup(await file.text());
    if (!parsed.ok) return (importError = parsed.error);
    pending = { backup: parsed.backup, counts: parsed.counts, name: file.name };
  }

  async function apply(mode: 'merge' | 'replace') {
    if (!pending) return;
    if (mode === 'replace' && !confirm(`Replace everything in this browser with ${pending.name}? What is here now is kept aside so you can undo this straight afterwards.`)) return;
    try {
      await restore(pending.backup, mode);
      toast(mode === 'merge' ? 'Backup merged in' : 'Restored from backup', 'ok', { label: 'Undo', run: undo });
      pending = null;
    } catch (e) {
      toast(`Nothing was changed: ${errorText(e)}`, 'error');
    }
  }

  async function undo() {
    try {
      toast((await undoRestore()) ? 'Put back what was here before the restore' : 'Nothing to undo');
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
        <button class="primary" onclick={() => apply('merge')}>Merge into this browser</button>
        <button class="danger" onclick={() => apply('replace')}>Replace everything</button>
        <button class="ghost" onclick={() => (pending = null)}>Cancel</button>
      </div>
      <p class="small muted">Merge keeps everything here and adds what is missing; where both have the same title, the more recently edited version wins. Either way you can undo it afterwards.</p>
    </div>
  {/if}
  {#if data.value.undoAt && !pending}
    <p class="small muted">Restored {ago(data.value.undoAt)}. <button class="small" onclick={undo}>Undo that restore</button></p>
  {/if}
  {#if ios}
    <p class="small muted">On iPhone and iPad, tap Share → Add to Home Screen. Safari can clear data for websites you have not opened for a while; the installed app is kept.</p>
  {/if}
</section>

<section class="section card stack">
  <h2>Who you watch with</h2>
  <label for="partner">Partner's name (adds a second rating when you watch together)</label>
  <input id="partner" type="text" value={data.value.partner} onchange={(e) => setSetting('partner', e.currentTarget.value.trim())} placeholder="Optional" style="max-width: 320px" />
</section>

<section class="section card stack">
  <h2>Sites to search when a link breaks</h2>
  <p class="small muted">Shown as “Find on …” under every source list. Use <code>{'{q}'}</code> where the title goes.</p>
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
