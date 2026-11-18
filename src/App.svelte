<script lang="ts">
  import { onMount } from 'svelte';
  import { route } from './lib/router.svelte';
  import { ui } from './lib/ui.svelte';
  import { syncShows } from './lib/actions';
  import Search from './components/Search.svelte';
  import Tonight from './routes/Tonight.svelte';
  import Calendar from './routes/Calendar.svelte';
  import Library from './routes/Library.svelte';
  import TitlePage from './routes/TitlePage.svelte';
  import Taste from './routes/Taste.svelte';
  import Settings from './routes/Settings.svelte';

  const tabs = [
    { href: '#/', path: '/', label: 'Tonight', icon: 'M4 18h16M6 14l3-8 3 5 3-3 3 6' },
    { href: '#/calendar', path: '/calendar', label: 'Calendar', icon: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4' },
    { href: '#/library', path: '/library', label: 'Library', icon: 'M5 4h3v16H5zM10 4h3v16h-3zM15 5l3-1 3 15-3 1z' },
    { href: '#/taste', path: '/taste', label: 'Taste', icon: 'M12 3v18M5 8c0-3 3-5 7-5s7 2 7 5-3 5-7 5-7 2-7 5 3 5 7 5' },
  ];

  const active = (p: string) => (p === '/' ? route.path === '/' : route.path.startsWith(p));

  async function sync() {
    try {
      await syncShows(); // background: failures are retried later; the Calendar's button reports them
    } catch {
      /* offline or TVmaze down: the calendar shows what we already have */
    }
  }

  onMount(() => {
    sync();
    const onVisible = () => document.visibilityState === 'visible' && sync();
    document.addEventListener('visibilitychange', onVisible);
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest('input, textarea, select, [contenteditable]');
      if (!typing && (e.key === '/' || (e.key === 'k' && (e.metaKey || e.ctrlKey)))) {
        e.preventDefault();
        ui.searchOpen = true;
      }
    };
    addEventListener('keydown', onKey);
    return () => {
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
  {#if route.path === '/'}
    <Tonight />
  {:else if route.path === '/calendar'}
    <Calendar />
  {:else if route.path === '/library'}
    <Library />
  {:else if route.path === '/taste'}
    <Taste />
  {:else if route.path === '/settings'}
    <Settings />
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

{#if ui.toast}
  <div class="toast fade" class:error={ui.toast.tone === 'error'} role="status" aria-live="polite">
    <span>{ui.toast.text}</span>
    {#if ui.toast.action}
      {@const a = ui.toast.action}
      <button class="small" onclick={() => { a.run(); ui.toast = null; }}>{a.label}</button>
    {/if}
  </div>
{/if}

<style>
  .skip { position: absolute; left: -9999px; }
  .skip:focus { left: 1rem; top: 1rem; z-index: 50; background: var(--surface); padding: 0.5rem 1rem; border-radius: 8px; }
  header {
    position: sticky; top: 0; z-index: 20;
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--line);
    padding-top: env(safe-area-inset-top);
  }
  .inner { max-width: 1120px; margin: 0 auto; padding: 0.6rem 1rem; display: flex; align-items: center; gap: 1.5rem; }
  .brand { display: flex; align-items: center; gap: 0.5rem; text-decoration: none; color: var(--text); font-family: var(--serif); font-size: 1.35rem; font-weight: 600; }
  .top { display: flex; gap: 0.25rem; flex: 1; }
  .top a { color: var(--muted); text-decoration: none; padding: 0.4rem 0.8rem; border-radius: 999px; }
  .top a[aria-current='page'] { color: var(--text); background: var(--surface-2); }
  .actions { margin-left: auto; }
  main { max-width: 1120px; margin: 0 auto; padding: 1.25rem 1rem calc(var(--nav-h) + 2rem + env(safe-area-inset-bottom)); outline: none; }
  .bottom { display: none; }
  @media (max-width: 720px) {
    .top { display: none; }
    .bottom {
      display: grid; grid-template-columns: repeat(4, 1fr);
      position: fixed; bottom: 0; left: 0; right: 0; z-index: 20;
      background: var(--surface); border-top: 1px solid var(--line);
      padding-bottom: env(safe-area-inset-bottom);
    }
    .bottom a { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; height: var(--nav-h); color: var(--muted); text-decoration: none; font-size: 0.75rem; }
    .bottom a[aria-current='page'] { color: var(--accent); }
  }
  @media (min-width: 721px) { main { padding-bottom: 3rem; } }
  .toast {
    position: fixed; left: 50%; transform: translateX(-50%);
    bottom: calc(var(--nav-h) + 1rem + env(safe-area-inset-bottom));
    z-index: 60; display: flex; gap: 0.75rem; align-items: center;
    background: var(--text); color: var(--bg); padding: 0.6rem 1rem; border-radius: 999px;
    max-width: calc(100vw - 2rem); box-shadow: 0 6px 24px rgb(0 0 0 / 0.3);
  }
  .toast.error { background: var(--danger); color: #1a0d08; }
  .toast button { background: transparent; color: inherit; border-color: currentColor; }
  @media (min-width: 721px) { .toast { bottom: 1.5rem; } }
</style>
