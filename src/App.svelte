<script lang="ts">
  import { onMount } from 'svelte';
  import { route } from './lib/router.svelte';
  import { ui, clock, toast, errorText } from './lib/ui.svelte';
  import { syncShows, reconcileShows, refreshFilms } from './lib/actions';
  import Search from './components/Search.svelte';
  import Toast from './components/Toast.svelte';
  import SourceSheet from './components/SourceSheet.svelte';
  import Tonight from './routes/Tonight.svelte';
  import Calendar from './routes/Calendar.svelte';
  import Library from './routes/Library.svelte';
  import TitlePage from './routes/TitlePage.svelte';
  import Discover from './routes/Discover.svelte';
  import Taste from './routes/Taste.svelte';
  import Settings from './routes/Settings.svelte';
  import Person from './routes/Person.svelte';
  import Import from './routes/Import.svelte';

  const tabs = [
    { href: '#/', path: '/', label: 'Tonight', icon: 'M4 18h16M6 14l3-8 3 5 3-3 3 6' },
    { href: '#/calendar', path: '/calendar', label: 'Calendar', icon: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4' },
    { href: '#/library', path: '/library', label: 'Library', icon: 'M5 4h3v16H5zM10 4h3v16h-3zM15 5l3-1 3 15-3 1z' },
    { href: '#/discover', path: '/discover', label: 'Discover', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M15.5 8.5l-2 5-5 2 2-5z' },
  ];

  const active = (p: string) => (p === '/' ? route.path === '/' : route.path.startsWith(p) || (p === '/discover' && route.path === '/taste'));
  const names: Record<string, string> = { '/': 'Tonight', '/calendar': 'Calendar', '/library': 'Library', '/discover': 'Discover', '/taste': 'Your taste', '/settings': 'Settings & backup', '/import': 'Import' };
  $effect(() => {
    document.title = names[route.path] ? `${names[route.path]} · Parde` : 'Parde'; // title pages add their own
  });

  async function sync() {
    try {
      await syncShows(); // background: failures are retried later; the Calendar's button reports them
    } catch {
      /* offline or TVmaze down: the calendar shows what we already have */
    }
    // Episodes already listed can come out without TVmaze changing anything.
    await reconcileShows().catch(() => {});
    await refreshFilms().catch(() => {}); // busy or offline: tried again later
  }

  onMount(() => {
    sync();
    // An installed app can sit in the background for days: "today" moves on when it comes back.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      clock.now = Date.now();
      sync();
    };
    const tick = setInterval(() => (clock.now = Date.now()), 5 * 60e3);
    document.addEventListener('visibilitychange', onVisible);
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest('input, textarea, select, [contenteditable]');
      if (!typing && (e.key === '/' || (e.key === 'k' && (e.metaKey || e.ctrlKey)))) {
        e.preventDefault();
        ui.searchOpen = true;
      }
    };
    addEventListener('keydown', onKey);
    // Anything that failed without being caught where it happened is a save that did not happen: never silent.
    const onFail = (e: PromiseRejectionEvent) => toast(`Not saved: ${errorText(e.reason)}`, 'error');
    addEventListener('unhandledrejection', onFail);
    return () => {
      removeEventListener('unhandledrejection', onFail);
      clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisible);
      removeEventListener('keydown', onKey);
    };
  });
</script>

<a class="skip" href="#main" onclick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to content</a>

<header>
  <div class="inner">
    <a class="brand" href="#/" aria-label="Parde, home">
      <svg viewBox="0 0 512 512" width="28" height="28" aria-hidden="true">
        <path d="M96 104h320v24c-40 6-72 40-84 96-12 60-14 140-10 224H190c4-84 2-164-10-224-12-56-44-90-84-96z" fill="var(--curtain)" />
        <rect x="80" y="88" width="352" height="28" rx="10" fill="var(--accent)" />
      </svg>
      <span>Parde</span>
    </a>
    <nav class="top" aria-label="Main">
      {#each tabs as t}
        <a href={t.href} aria-current={active(t.path) ? 'page' : undefined}>{t.label}</a>
      {/each}
    </nav>
    <div class="row actions">
      <button class="primary" onclick={() => (ui.searchOpen = true)} aria-keyshortcuts="/">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" /></svg>
        Add
      </button>
      <a class="btn icon ghost" href="#/settings" aria-label="Settings and backup" aria-current={active('/settings') ? 'page' : undefined}>
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
      </a>
    </div>
  </div>
</header>

<main id="main" tabindex="-1">
  {#if ui.storageError}
    <div class="card" role="alert">
      <p><strong>Parde cannot read your collection just now.</strong> {ui.storageError} Nothing has been lost: reloading usually fixes it.</p>
      <button class="primary" onclick={() => location.reload()}>Reload</button>
    </div>
  {/if}
  {#if route.path === '/'}
    <Tonight />
  {:else if route.path === '/calendar'}
    <Calendar />
  {:else if route.path === '/library'}
    <Library />
  {:else if route.path === '/discover'}
    <Discover />
  {:else if route.path === '/taste'}
    <Taste />
  {:else if route.path === '/settings'}
    <Settings />
  {:else if route.path === '/import'}
    <Import />
  {:else if route.path === '/p'}
    {#key route.params.toString()}
      <Person qid={route.params.get('q') || undefined} name={route.params.get('name') ?? ''} />
    {/key}
  {:else if route.path.startsWith('/t/')}
    {#key route.path}
      <TitlePage id={decodeURIComponent(route.path.slice(3))} />
    {/key}
  {:else}
    <div class="empty">That page does not exist. <a href="#/">Go to Tonight</a></div>
  {/if}
</main>

<nav class="bottom" aria-label="Main">
  {#each tabs as t}
    <a href={t.href} aria-current={active(t.path) ? 'page' : undefined}>
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d={t.icon} fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></svg>
      <span>{t.label}</span>
    </a>
  {/each}
</nav>

<Search />
<SourceSheet />

<Toast />

<style>
  .skip { position: absolute; left: -9999px; }
  .skip:focus { left: 1rem; top: 1rem; z-index: 50; background: var(--surface); padding: 0.5rem 1rem; border-radius: 8px; }
  header {
    position: sticky; top: 0; z-index: 20;
    background: var(--bg);
    border-bottom: 1px solid var(--line);
    padding-top: env(safe-area-inset-top);
    padding-left: env(safe-area-inset-left);
    padding-right: env(safe-area-inset-right);
  }
  .inner { max-width: 1120px; margin: 0 auto; padding: 0.6rem 1rem; display: flex; align-items: center; gap: 1.5rem; }
  .brand { display: flex; align-items: center; gap: 0.5rem; text-decoration: none; color: var(--text); font-family: var(--serif); font-size: 1.35rem; font-weight: 600; }
  .top { display: flex; gap: 0.25rem; flex: 1; }
  .top a { color: var(--muted); text-decoration: none; padding: 0.4rem 0.8rem; border-radius: 999px; }
  .top a[aria-current='page'] { color: var(--text); background: var(--surface-2); }
  .actions { margin-left: auto; }
  /* position: relative keeps absolutely positioned descendants (sr-only labels) from widening the page. */
  main {
    position: relative; max-width: 1120px; margin: 0 auto; outline: none;
    padding: 1.25rem calc(1rem + env(safe-area-inset-right)) 3rem calc(1rem + env(safe-area-inset-left));
  }
  .bottom { display: none; }
  @media (max-width: 720px) {
    .top { display: none; }
    /* Room for the tab bar, so the end of every page can be scrolled clear of it. */
    main { padding-bottom: calc(var(--nav-h) + env(safe-area-inset-bottom) + 2rem); }
    .bottom {
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 20;
      display: grid; grid-template-columns: repeat(4, 1fr);
      background: var(--surface); border-top: 1px solid var(--line);
      padding-bottom: env(safe-area-inset-bottom);
      padding-left: env(safe-area-inset-left);
      padding-right: env(safe-area-inset-right);
    }
    .bottom a { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; height: var(--nav-h); color: var(--muted); text-decoration: none; font-size: 0.75rem; }
    .bottom a[aria-current='page'] { color: var(--accent); }
  }
</style>
