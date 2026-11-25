<script lang="ts">
  let { current }: { current: 'discover' | 'taste' } = $props();
</script>

<!-- One tab, two halves of the same loop: what you find tells Parde about you, and what it learns leads to more. -->
<nav class="halves" aria-label="Discover">
  <a href="#/discover" aria-current={current === 'discover' ? 'page' : undefined}>Discover</a>
  <a href="#/taste" aria-current={current === 'taste' ? 'page' : undefined}>Your taste</a>
</nav>

<style>
  .halves { display: inline-flex; padding: 3px; gap: 3px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--line); margin-bottom: 1rem; }
  a { display: grid; place-items: center; min-height: 38px; padding: 0 1.1rem; border-radius: 999px; color: var(--muted); text-decoration: none; font-size: 0.95rem; }
  a[aria-current='page'] { background: var(--bg); color: var(--text); font-weight: 600; }
</style>
