<script lang="ts">
  import type { Title } from '../lib/db';
  import { logWatch } from '../lib/actions';
  import { dayKey } from '../lib/schedule';
  import { toast, errorText } from '../lib/ui.svelte';
  import Scale from './Scale.svelte';
  import Themes from './Themes.svelte';

  let { title, open = $bindable(false), partner }: { title: Title; open?: boolean; partner: string } = $props();
  let dialog: HTMLDialogElement;
  let date = $state(dayKey(new Date()));
  let together = $state(true);
  let rating = $state<number | undefined>();
  let partnerRating = $state<number | undefined>();
  let themes = $state<string[]>([]);

  $effect(() => {
    if (open && !dialog.open) {
      rating = title.rating;
      partnerRating = title.partnerRating;
      themes = [...(title.themes ?? [])];
      date = dayKey(new Date());
      dialog.showModal();
    } else if (!open && dialog.open) dialog.close();
  });

  async function save() {
    try {
      // Plain copies: Svelte's state proxies cannot be stored in IndexedDB.
      await logWatch(title, { date, together, rating, partnerRating, themes: [...themes] });
      open = false;
      toast(`Logged ${title.name}`);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }
</script>

<dialog bind:this={dialog} onclose={() => (open = false)} aria-labelledby="log-h">
  <form class="dialog-body stack" onsubmit={(e) => { e.preventDefault(); save(); }}>
    <h2 id="log-h">{title.kind === 'show' ? 'Finished' : 'Watched'} {title.name}</h2>
    <div>
      <label for="log-date">When</label>
      <input id="log-date" type="date" bind:value={date} max={dayKey(new Date())} required />
    </div>
    <div class="row">
      <button type="button" class="chip" class:on={together} aria-pressed={together} onclick={() => (together = true)}>Together</button>
      <button type="button" class="chip" class:on={!together} aria-pressed={!together} onclick={() => (together = false)}>Just me</button>
    </div>
    <div>
      <span class="label">How much did you enjoy it?</span>
      <Scale max={10} value={rating} onpick={(v) => (rating = v)} name="Your rating" />
    </div>
    {#if together}
      <div>
        <span class="label">{partner || 'Your partner'}'s rating (optional)</span>
        <Scale max={10} value={partnerRating} onpick={(v) => (partnerRating = v)} name="Partner rating" />
      </div>
    {/if}
    <div>
      <span class="label">What was it about for you? (optional)</span>
      <Themes {title} compact value={themes} onchange={(v) => (themes = v)} />
    </div>
    <div class="row">
      <button class="primary" type="submit">Save</button>
      <button type="button" class="ghost" onclick={() => (open = false)}>Cancel</button>
    </div>
  </form>
</dialog>

<style>
  .label { display: block; font-size: 0.9rem; color: var(--muted); margin-bottom: 0.35rem; }
</style>
