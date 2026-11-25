<script lang="ts" module>
  import type { Episode, Title } from '../lib/db';
  /** Opened from Tonight or the Calendar: every way to watch this one thing, without leaving the page. */
  export const sheet = $state<{ title: Title | null; episode?: Episode }>({ title: null });
  export const openSheet = (title: Title, episode?: Episode) => Object.assign(sheet, { title, episode });
</script>

<script lang="ts">
  import { db, type Link } from '../lib/db';
  import { live } from '../lib/live.svelte';
  import { code } from '../lib/schedule';
  import { titleHref } from '../lib/router.svelte';
  import Sources from './Sources.svelte';
  import Toast from './Toast.svelte';

  let dialog: HTMLDialogElement;
  const close = () => (sheet.title = null);
  const links = live(
    () => {
      const id = sheet.title?.id ?? '';
      return () => db.links.where('titleId').equals(id).toArray();
    },
    [] as Link[],
  );
  $effect(() => {
    if (sheet.title && !dialog.open) dialog.showModal();
    else if (!sheet.title && dialog.open) dialog.close();
  });
  $effect(() => {
    addEventListener('hashchange', close);
    return () => removeEventListener('hashchange', close);
  });
</script>

<dialog bind:this={dialog} onclose={close} aria-labelledby="sheet-h">
  <div class="dialog-body stack">
    {#if sheet.title}
      <div class="spread head">
        <h2 id="sheet-h">{sheet.title.name}{sheet.episode ? ` ${code(sheet.episode)}` : ''}</h2>
        <button class="ghost icon" onclick={close} aria-label="Close">✕</button>
      </div>
      <Sources title={sheet.title} links={links.value} season={sheet.episode?.season} episode={sheet.episode?.number} heading="Where to watch" />
      <a class="small" href={titleHref(sheet.title.id)}>Open the {sheet.title.kind === 'film' ? 'film' : 'series'} page</a>
    {/if}
  </div>
  <Toast />
</dialog>

<style>
  .head { flex-wrap: nowrap; align-items: flex-start; }
  h2 { margin: 0; }
</style>
