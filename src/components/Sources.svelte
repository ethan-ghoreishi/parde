<script lang="ts">
  import type { Link, Title } from '../lib/db';
  import { resolveLinks, hostOf, isPattern, suggestPattern, openExternal, cleanUrl, expand, type Level } from '../lib/links';
  import { code } from '../lib/schedule';
  import { addLink, deleteLink, editLink } from '../lib/actions';
  import { copy, toast, undoable, errorText } from '../lib/ui.svelte';
  import { now } from '../lib/db';
  import { live } from '../lib/live.svelte';
  import { getSetting } from '../lib/db';
  import { DEFAULT_SITES, siteUrl, validSite, type Site } from '../lib/sites';

  let {
    title,
    links,
    season,
    episode,
    heading = 'Where to watch',
    next,
  }: { title: Title; links: Link[]; season?: number; episode?: number; heading?: string; next?: { season: number; number: number } } = $props();

  const uidp = $props.id();
  const resolved = $derived(resolveLinks(links, season, episode));
  const isEpisode = $derived(season !== undefined && episode !== undefined);
  const sites = live(() => () => getSetting<Site[]>('sites', DEFAULT_SITES), DEFAULT_SITES);

  let adding = $state(false);
  let url = $state('');
  let label = $state('');
  let scope = $state<'episode' | 'season' | 'show'>('episode');
  let editing = $state<string | null>(null);
  let editUrl = $state('');
  let editLabel = $state('');
  let showBroken = $state(false);

  const working = $derived(resolved.filter((r) => !r.link.broken));
  const broken = $derived(resolved.filter((r) => r.link.broken));
  const suggestion = $derived(isEpisode && scope === 'episode' ? suggestPattern(url.trim(), season!, episode!) : null);

  const levelText: Record<Level, string> = { episode: 'this episode', season: 'this season', show: 'whole series', title: '' };

  /** A series-wide pattern listed outside an episode opens (and copies) as the episode you are up to. */
  const target = (r: (typeof resolved)[number]) => (isPattern(r.url) && next ? expand(r.url, next.season, next.number) : r.url);

  async function open(r: (typeof resolved)[number]) {
    if (isPattern(target(r))) return toast('This is a pattern for every episode: open it from an episode below.', 'error');
    if (!openExternal(target(r))) return toast('This link is not a valid web address. Edit it.', 'error');
    await editLink(r.link.id, { usedAt: now() });
  }

  async function save(asPattern = false) {
    try {
      const raw = asPattern && suggestion ? suggestion : url;
      const s = asPattern || !isEpisode ? {} : scope === 'episode' ? { season, episode } : scope === 'season' ? { season } : {};
      await addLink(title.id, raw, s, label);
      url = '';
      label = '';
      adding = false;
      toast(asPattern ? 'Pattern saved: every episode now has this source' : 'Source saved');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  async function saveEdit(l: Link) {
    try {
      await editLink(l.id, { url: editUrl, label: editLabel.trim() || undefined, broken: false });
      editing = null;
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  async function markBroken(l: Link, on: boolean) {
    await editLink(l.id, { broken: on });
    if (on) {
      const next = working.find((r) => r.link.id !== l.id);
      toast(next ? `Marked broken. Next: ${next.link.label || hostOf(next.url)}` : 'Marked broken. Add another source.', 'ok', next ? { label: `Open ${next.link.label || hostOf(next.url)}`, run: () => open(next) } : undefined);
    }
  }

  async function remove(l: Link) {
    undoable('Source removed', await deleteLink(l.id));
  }

  /** A search site can place the episode too, with the same {s}/{e} marks as a source. */
  const siteHref = (s: Site) => {
    const u = siteUrl(s, title.name);
    return isPattern(u) ? expand(u, season ?? next?.season ?? 1, episode ?? next?.number ?? 1) : u;
  };
</script>

<section class="sources" aria-label={heading}>
  <div class="spread">
    <h3>{heading}</h3>
    {#if !adding}<button class="small" onclick={() => (adding = true)}>+ Add source</button>{/if}
  </div>

  {#if working.length}
    <ul>
      {#each working as r (r.link.id)}
        {@render row(r)}
      {/each}
    </ul>
  {:else if !adding}
    <p class="muted small">No {broken.length ? 'working ' : ''}source saved{isEpisode ? ' for this episode' : ''}. Add the link you watch on, or find one below.</p>
  {/if}

  {#if broken.length}
    <button class="ghost small" onclick={() => (showBroken = !showBroken)} aria-expanded={showBroken}>
      {broken.length} broken {broken.length === 1 ? 'link' : 'links'} {showBroken ? '▴' : '▾'}
    </button>
    {#if showBroken}
      <ul class="broken">
        {#each broken as r (r.link.id)}
          {@render row(r)}
        {/each}
      </ul>
    {/if}
  {/if}

  {#if adding}
    <form class="add card" onsubmit={(e) => { e.preventDefault(); save(); }}>
      <label for="src-url-{uidp}">Link</label>
      <input id="src-url-{uidp}" type="text" inputmode="url" autocapitalize="off" spellcheck="false" bind:value={url} placeholder="https://…" autocomplete="off" required {@attach (el) => el.focus()} />
      <label for="src-label-{uidp}" style="margin-top: 0.5rem">Name (optional)</label>
      <input id="src-label-{uidp}" type="text" bind:value={label} placeholder={url && cleanUrl(url) ? hostOf(cleanUrl(url)!) : 'e.g. Site name, 1080p'} />
      {#if isEpisode}
        <fieldset class="row scope">
          <legend class="small muted">Applies to</legend>
          <label class="row"><input type="radio" bind:group={scope} value="episode" /> This episode</label>
          <label class="row"><input type="radio" bind:group={scope} value="season" /> Season {season}</label>
          <label class="row"><input type="radio" bind:group={scope} value="show" /> Whole series</label>
        </fieldset>
      {:else if title.kind === 'show'}
        <p class="small muted">Tip: use <code>{'{s}'}</code> and <code>{'{e}'}</code> (or <code>{'{ss}'}</code>/<code>{'{ee}'}</code> for 01, 02…) where the season and episode numbers go, and every episode gets this link.</p>
      {/if}
      {#if suggestion}
        <div class="suggest">
          <p class="small">This link looks like it follows a pattern. Save it once for every episode?</p>
          <code class="small">{suggestion}</code>
          <div class="row" style="margin-top: 0.4rem">
            <button type="button" class="small primary" onclick={() => save(true)}>Use for every episode</button>
          </div>
        </div>
      {/if}
      <div class="row" style="margin-top: 0.75rem">
        <button class="primary small" type="submit" disabled={!cleanUrl(url)}>Save</button>
        <button class="small ghost" type="button" onclick={() => (adding = false)}>Cancel</button>
        {#if url && !cleanUrl(url)}<span class="small" role="alert" style="color: var(--danger)">Needs a full web address</span>{/if}
      </div>
    </form>
  {/if}

  <div class="find row small">
    <span class="muted">Find on</span>
    {#each sites.value.filter(validSite) as s}
      <a href={siteHref(s)} target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">{s.name} ↗</a>
    {/each}
    <a href="#/settings" class="muted">edit sites</a>
  </div>
</section>

{#snippet row(r: (typeof resolved)[number])}
  <li class:dim={r.link.broken}>
    {#if editing === r.link.id}
      <form class="edit" onsubmit={(e) => { e.preventDefault(); saveEdit(r.link); }}>
        <input type="text" inputmode="url" autocapitalize="off" spellcheck="false" bind:value={editUrl} aria-label="Link" />
        <input type="text" bind:value={editLabel} aria-label="Name" placeholder="Name (optional)" />
        <div class="row">
          <button class="small primary" type="submit">Save</button>
          <button class="small ghost" type="button" onclick={() => (editing = null)}>Cancel</button>
        </div>
      </form>
    {:else}
      <div class="main">
        <button class="open" onclick={() => open(r)} disabled={!!r.link.broken} title={target(r)}>
          <span class="host">{r.link.label || hostOf(r.url)}</span>
          {#if r.link.label}<span class="muted small">{hostOf(r.url)}</span>{/if}
          {#if isEpisode && r.level !== 'episode'}<span class="chip">{levelText[r.level]}</span>{/if}
          {#if isPattern(r.link.url)}<span class="chip">{!isEpisode && next ? `pattern · opens ${code({ season: next.season, number: next.number })}` : 'pattern'}</span>{/if}
          <span aria-hidden="true">↗</span>
        </button>
        <div class="row tools">
          <button class="small ghost" onclick={() => copy(target(r))} aria-label="Copy link to {r.link.label || hostOf(r.url)}">Copy</button>
          {#if r.link.broken}
            <button class="small ghost" onclick={() => markBroken(r.link, false)}>Works again</button>
          {:else}
            <button class="small ghost" onclick={() => markBroken(r.link, true)} aria-label="{r.link.label || hostOf(r.url)} does not work">Doesn't work</button>
          {/if}
          <button class="small ghost" onclick={() => { editing = r.link.id; editUrl = r.link.url; editLabel = r.link.label ?? ''; }}>Edit</button>
          <button class="small ghost danger" onclick={() => remove(r.link)} aria-label="Remove {r.link.label || hostOf(r.url)}">✕</button>
        </div>
      </div>
    {/if}
  </li>
{/snippet}

<style>
  .sources { display: grid; gap: 0.5rem; }
  h3 { margin: 0; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.4rem; }
  li { border: 1px solid var(--line); border-radius: 10px; padding: 0.4rem; background: var(--surface); }
  li.dim { border-style: dashed; }
  li.dim .host { color: var(--muted); text-decoration: line-through; }
  .main { display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap; justify-content: space-between; }
  .open { background: transparent; border: none; padding: 0.2rem 0.5rem; gap: 0.5rem; flex: 1; justify-content: flex-start; min-width: 0; flex-wrap: wrap; white-space: normal; text-align: left; }
  .open:not(:disabled) .host { color: var(--accent); font-weight: 600; }
  .tools { gap: 0.1rem; }
  .add { display: grid; gap: 0.15rem; }
  .scope { border: none; padding: 0; margin: 0.5rem 0 0; gap: 1rem; }
  .scope label { color: var(--text); margin: 0; gap: 0.35rem; }
  .suggest { margin-top: 0.75rem; padding: 0.75rem; border-radius: 10px; background: var(--surface-2); }
  .suggest code { word-break: break-all; }
  .edit { display: grid; gap: 0.4rem; }
  .find { gap: 0.75rem; margin-top: 0.25rem; }
  .find a { text-decoration: none; }
</style>
