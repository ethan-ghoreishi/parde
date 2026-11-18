<script lang="ts">
  let { src, name, size = 'md' }: { src?: string; name: string; size?: 'xs' | 'sm' | 'md' | 'lg' } = $props();
  let failed = $state(false);
  const initials = $derived(name.split(/\s+/).filter((w) => /^[\p{L}\p{N}]/u.test(w)).slice(0, 2).map((w) => w[0]).join('').toUpperCase());
  // Distinct, stable hue per title so placeholders are tellable apart.
  const hue = $derived([...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7));
</script>

<div class="poster {size}" style="--h: {hue}">
  {#if src && !failed}
    <img {src} alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror={() => (failed = true)} />
  {:else}
    <span aria-hidden="true">{initials}</span>
  {/if}
</div>

<style>
  .poster {
    aspect-ratio: 2 / 3;
    border-radius: 8px;
    overflow: hidden;
    background: linear-gradient(160deg, hsl(var(--h) 35% 30%), hsl(calc(var(--h) + 40) 30% 16%));
    display: grid;
    place-items: center;
    flex-shrink: 0;
    color: rgb(255 255 255 / 0.85);
    font-family: var(--serif);
    border: 1px solid var(--line);
  }
  img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .xs { width: 48px; font-size: 0.9rem; border-radius: 6px; }
  .sm { width: 64px; font-size: 1rem; }
  .md { width: 100%; font-size: 1.6rem; }
  .lg { width: min(240px, 38vw); font-size: 2.4rem; border-radius: 12px; }
</style>
