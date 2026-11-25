<script lang="ts">
  import { ui } from '../lib/ui.svelte';
  // Also placed inside each dialog: while one is open, everything outside it is behind it and cannot be reached.
</script>

<!-- The live region is always there, so what appears in it is announced. -->
<div class="region" role="status" aria-live="polite">
  {#if ui.toast}
    <div class="toast fade" class:error={ui.toast.tone === 'error'}>
      <span>{ui.toast.text}</span>
      {#if ui.toast.action}
        {@const a = ui.toast.action}
        <button type="button" class="small" onclick={() => { ui.toast = null; a.run(); }}>{a.label}</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .toast {
    position: fixed; left: 50%; transform: translateX(-50%);
    bottom: calc(var(--nav-h) + 1rem + env(safe-area-inset-bottom));
    z-index: 60; display: flex; gap: 0.75rem; align-items: center; width: max-content;
    background: var(--text); color: var(--bg); padding: 0.6rem 1rem; border-radius: 999px;
    max-width: calc(100vw - 2rem); box-shadow: 0 6px 24px rgb(0 0 0 / 0.3);
  }
  .toast.error { background: var(--danger); color: var(--danger-ink); border-radius: 18px; }
  .toast button { background: transparent; color: inherit; border-color: currentColor; flex: none; }
  @media (min-width: 721px) { .toast { bottom: 1.5rem; } }
</style>
