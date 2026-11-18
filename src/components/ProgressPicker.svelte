<script lang="ts">
  import { db } from '../lib/db';
  import { live } from '../lib/live.svelte';
  import { byOrder, code, isAired } from '../lib/schedule';
  import { setProgress } from '../lib/actions';
  import { toast, errorText } from '../lib/ui.svelte';

  /** One choice records where you are in a series: everything up to it seen, nothing after. */
  let { titleId, label = 'Seen up to' }: { titleId: string; label?: string } = $props();
  const uid = $props.id();

  const data = live(
    () => {
      const id = titleId;
      return async () => ({
        eps: (await db.episodes.where('titleId').equals(id).toArray()).sort(byOrder),
        seen: new Set(await db.seen.where('titleId').equals(id).primaryKeys()),
      });
    },
    { eps: [] as import('../lib/db').Episode[], seen: new Set<number>() },
  );

  const eps = $derived(data.value.eps);
  const seen = $derived(data.value.seen);
  // Only what is out (or already marked) can be "where you are".
  const choices = $derived(eps.filter((e) => isAired(e) || seen.has(e.id)));
  const seasons = $derived([...new Set(choices.map((e) => e.season))]);
  /** The last seen episode, if everything before it is seen too; '' when marks have gaps. */
  const current = $derived.by(() => {
    const last = eps.findLastIndex((e) => seen.has(e.id));
    if (last < 0) return 'none';
    return eps.slice(0, last + 1).every((e) => seen.has(e.id)) ? String(eps[last].id) : '';
  });
  const seasonDone = (s: number) => eps.filter((e) => e.season === s).every((e) => isAired(e) || seen.has(e.id));

  async function pick(v: string) {
    const ep = v === 'none' ? null : (eps.find((e) => String(e.id) === v) ?? null);
    try {
      const undo = await setProgress(titleId, ep);
      toast(ep ? `Seen up to ${code(ep)}` : 'Set to not started', 'ok', { label: 'Undo', run: undo });
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }
</script>

{#if choices.length}
  <div class="picker">
    <label for="up-{uid}">{label}</label>
    <select id="up-{uid}" value={current} onchange={(e) => pick(e.currentTarget.value)}>
      {#if current === ''}<option value="" disabled>Some episodes skipped</option>{/if}
      <option value="none">Not started</option>
      {#each seasons as s (s)}
        {@const list = choices.filter((e) => e.season === s)}
        <optgroup label="Season {s}">
          {#each list as e, i (e.id)}
            <option value={String(e.id)}>{code(e)}{i === list.length - 1 && seasonDone(s) ? ` · end of season ${s}` : e.name ? ` · ${e.name}` : ''}</option>
          {/each}
        </optgroup>
      {/each}
    </select>
  </div>
{/if}

<style>
  .picker { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  label { margin: 0; color: var(--muted); font-size: 0.85rem; }
  select { width: auto; min-width: 0; max-width: 100%; min-height: 36px; padding: 0.25rem 0.5rem; flex: 1 1 12rem; text-overflow: ellipsis; }
</style>
