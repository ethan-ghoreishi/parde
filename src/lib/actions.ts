import { db, getSetting, now, setSetting, uid, USER_FIELDS, type Episode, type Link, type Status, type Title } from './db';
import { fetchShow, showUpdates, toEpisode } from './api/tvmaze';
import { filmMeta, filmMetas, qidForImdb, wikidataMeta, type Meta } from './api/wiki';
import { byOrder, isAired, isListed, onCalendar, progress } from './schedule';
import { cleanUrl, replaceHost, hostOf } from './links';

const defined = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
/** Looked-up details worth storing: one that came back missing or empty never wipes a good one. */
const filled = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length))) as Partial<T>;

/** Puts back what an action changed, and only that. */
export type Undo = () => Promise<void>;

/** Ask the browser not to evict our data under storage pressure (matters most on iOS). */
export function persistStorage() {
  navigator.storage?.persist?.().catch(() => {});
}

const stamps = (patch: Partial<Title>, at: string) => USER_FIELDS.filter((k) => k in patch).map((k) => [k, at] as const);

function newTitle(id: string, meta: Meta, patch: Partial<Title> = {}): Title {
  const t = now();
  const row: Title = { id, ...meta, status: 'want', followed: meta.kind === 'show' ? true : undefined, addedAt: t, updatedAt: t, enrichedAt: t, ...patch };
  return { ...row, edited: Object.fromEntries(stamps({ ...patch, status: row.status }, t)) };
}

// A second tap while the first is still looking things up joins it instead of adding twice.
const adding = new Map<string, Promise<string>>();
function once(id: string, run: () => Promise<void>): Promise<string> {
  const p = adding.get(id) ?? run().then(() => id).finally(() => adding.delete(id));
  adding.set(id, p);
  return p;
}

/** A title already here is left exactly as it is. */
export const addFilm = (qid: string, patch: Partial<Title> = {}, known?: Meta) =>
  once(`wd:${qid}`, async () => {
    const id = `wd:${qid}`;
    if (await db.titles.get(id)) return;
    const meta = known ?? (await filmMeta(qid));
    await db.transaction('rw', db.titles, db.removed, async () => {
      if (await db.titles.get(id)) return;
      await db.titles.add(newTitle(id, meta, patch));
      await db.removed.delete(`title:${id}`);
    });
    persistStorage();
  });

/**
 * Many films at once (an import): metadata 50 per request, with patience when Wikimedia is busy.
 * Films already here are left alone, including any added while the metadata was loading.
 * Returns the ids actually added.
 */
export async function addFilms(entries: { qid: string; patch: Partial<Title> }[]): Promise<string[]> {
  const unique = [...new Map(entries.map((e) => [e.qid, e])).values()];
  const have = new Set((await db.titles.bulkGet(unique.map((e) => `wd:${e.qid}`))).filter(Boolean).map((t) => t!.id));
  const fresh = unique.filter((e) => !have.has(`wd:${e.qid}`));
  if (!fresh.length) return [];
  const metas = await filmMetas(fresh.map((e) => e.qid), 3);
  const rows = fresh.flatMap((e) => {
    const m = metas.get(e.qid);
    return m ? [newTitle(`wd:${e.qid}`, m, e.patch)] : [];
  });
  const added = await db.transaction('rw', db.titles, db.removed, async () => {
    const here = new Set((await db.titles.bulkGet(rows.map((r) => r.id))).filter(Boolean).map((t) => t!.id));
    const add = rows.filter((r) => !here.has(r.id));
    await db.titles.bulkAdd(add);
    await db.removed.bulkDelete(add.map((r) => `title:${r.id}`));
    return add.map((r) => r.id);
  });
  persistStorage();
  return added;
}

/**
 * Wikidata adds critics, subjects, countries and linked people to a TVmaze show, when it can be found.
 * Undefined when Wikidata could not be asked (busy, offline): callers keep what they had.
 */
async function enrichShow(meta: Meta): Promise<Meta | undefined> {
  if (!meta.imdb) return meta;
  try {
    const qid = await qidForImdb(meta.imdb);
    if (!qid) return meta;
    const wd = await wikidataMeta(qid);
    const makers = wd.people.filter((p) => p.role !== 'cast');
    return {
      ...meta,
      qid,
      wiki: wd.wiki,
      people: [...(makers.length ? makers : meta.people.filter((p) => p.role !== 'cast')), ...meta.people.filter((p) => p.role === 'cast')],
      subjects: wd.subjects,
      countries: wd.countries,
      languages: wd.languages,
      critics: [...meta.critics, ...wd.critics.filter((c) => c.source !== 'TVmaze')],
      trailer: wd.trailer,
    };
  } catch {
    return undefined;
  }
}

/**
 * TVmaze's list is taken as news, not as truth: an episode missing from it (removed, rescheduled, or just
 * a partial reply) is set aside, never deleted, and comes back if it is listed again.
 */
async function saveEpisodes(titleId: string, raw: Parameters<typeof toEpisode>[1][]) {
  const eps = raw.map((e) => toEpisode(titleId, e)).filter((e): e is Episode => !!e);
  if (!eps.length) return;
  await db.transaction('rw', db.episodes, db.seen, async () => {
    const old = await db.episodes.where('titleId').equals(titleId).toArray();
    const listed = new Set(eps.map((e) => e.id));
    const had = new Set(old.map((e) => e.id));
    const slot = (e: Episode) => `${e.season}x${e.number}`;
    // TVmaze sometimes re-creates an episode: a new id in the same place takes over the mark. An id we
    // already had there is a different episode that was renumbered.
    const recreated = new Map(eps.filter((e) => !had.has(e.id)).map((e) => [slot(e), e.id]));
    for (const e of old.filter((e) => !listed.has(e.id))) {
      const to = recreated.get(slot(e));
      if (to) {
        const mark = await db.seen.get(e.id);
        if (mark) await db.seen.put({ ...mark, episodeId: to });
        await db.seen.delete(e.id);
        await db.episodes.delete(e.id);
      } else if (!e.missingSince) await db.episodes.put({ ...e, missingSince: now() });
    }
    await db.episodes.bulkPut(eps);
  });
}

export const addShow = (tvmaze: number, patch: Partial<Title> = {}) =>
  once(`tvm:${tvmaze}`, async () => {
    const id = `tvm:${tvmaze}`;
    if (await db.titles.get(id)) return;
    const { meta, episodes } = await fetchShow(tvmaze);
    const full = (await enrichShow(meta)) ?? meta;
    await db.transaction('rw', db.titles, db.episodes, db.seen, db.removed, async () => {
      if (await db.titles.get(id)) return;
      await db.titles.add({ ...newTitle(id, full, patch), syncedAt: now() });
      await db.removed.delete(`title:${id}`);
      await saveEpisodes(id, episodes);
    });
    persistStorage();
  });

/** Refresh metadata (and episodes) without touching anything the user set. */
export async function refreshTitle(t: Title, deep = false) {
  if (t.kind === 'show' && t.tvmaze) {
    const { meta, episodes } = await fetchShow(t.tvmaze);
    // Wikidata changes slowly: re-enrich monthly, not on every episode sync.
    const reEnrich = deep || !t.enrichedAt || Date.now() - Date.parse(t.enrichedAt) > 30 * 864e5;
    const enriched = reEnrich ? await enrichShow(meta) : undefined;
    const kept = { ...meta, ...pickWd(t), critics: [...meta.critics, ...t.critics.filter((c) => c.source !== 'TVmaze')] };
    // A failed (or suddenly empty) Wikidata lookup keeps the people, subjects and scores found before.
    const full = enriched && (enriched.qid || !t.qid) ? enriched : kept;
    const justEnded = await db.transaction('rw', db.titles, db.episodes, db.seen, async () => {
      const cur = await db.titles.get(t.id);
      if (!cur) return false;
      // Back from the dead: worth knowing about, even if finishing it once took it off the calendar.
      const revived = cur.status === 'watched' && cur.showStatus === 'Ended' && !!full.showStatus && full.showStatus !== 'Ended';
      await db.titles.put({ ...cur, ...filled(full), ...(revived ? { followed: true } : {}), syncedAt: now(), enrichedAt: enriched ? now() : cur.enrichedAt });
      await saveEpisodes(t.id, episodes);
      return cur.showStatus !== 'Ended' && full.showStatus === 'Ended';
    });
    await reconcile(t.id, false, { justEnded });
  } else if (t.qid) {
    const meta = await filmMeta(t.qid);
    await saveFilmMeta(t.id, meta);
  }
}

/** Merges into the stored record, so a rating made while this was loading is kept. */
async function saveFilmMeta(id: string, meta: Meta) {
  const { name, ...rest } = meta;
  // Without a label, `name` is only the article title or the id: keep the one we have.
  const named = name !== meta.qid && name !== meta.wiki;
  await db.titles.update(id, { ...filled(rest), ...(named ? { name } : {}), enrichedAt: now() });
}

const DAY = 864e5;

/** Film details (scores above all) go stale: in the background, the 20 oldest over a month, twice a day at most. */
export async function refreshFilms() {
  const last = await getSetting<string>('filmsSyncedAt', '');
  if (last && Date.now() - Date.parse(last) < DAY / 2) return;
  const old = new Date(Date.now() - 30 * DAY).toISOString();
  const stale = (await db.titles.where('kind').equals('film').toArray())
    .filter((t) => t.qid && (t.enrichedAt ?? '') < old)
    .sort((a, b) => (a.enrichedAt ?? '').localeCompare(b.enrichedAt ?? ''))
    .slice(0, 20);
  if (!stale.length) return;
  await setSetting('filmsSyncedAt', now());
  const metas = await filmMetas(stale.map((t) => t.qid!));
  for (const t of stale) {
    const m = metas.get(t.qid!);
    if (m) await saveFilmMeta(t.id, m);
    else await db.titles.update(t.id, { enrichedAt: now() }); // gone from Wikidata: keep ours, ask again next month
  }
}

/** Keep the Wikidata-sourced parts of a show between frequent episode syncs. */
function pickWd(t: Title): Partial<Meta> {
  return defined({
    qid: t.qid, wiki: t.wiki, subjects: t.subjects, countries: t.countries, languages: t.languages, trailer: t.trailer,
    people: t.people.some((p) => p.qid) ? t.people : undefined,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Bring followed shows up to date. TVmaze's update index tells us which changed, so a normal
 * day costs one request. Throttled well under TVmaze's 20 requests per 10 seconds.
 */
let syncing: Promise<{ refreshed: number; failed: number }> | null = null;

export function syncShows(force = false) {
  // App start and tab-focus can both trigger this: never run two at once.
  syncing ??= runSync(force).finally(() => (syncing = null));
  return syncing;
}

async function runSync(force: boolean): Promise<{ refreshed: number; failed: number }> {
  const last = await getSetting<string>('showsSyncedAt', '');
  const age = last ? Date.now() - Date.parse(last) : Infinity;
  if (!force && age < 6 * 3600e3) return { refreshed: 0, failed: 0 };
  const over = (t: Title) => t.status === 'watched' && t.showStatus === 'Ended';
  // A finished, ended show is refetched only when TVmaze says it changed: it may be coming back.
  const shows = (await db.titles.where('kind').equals('show').toArray()).filter(
    (t) => t.tvmaze && t.status !== 'dropped' && (t.followed || t.status !== 'want'),
  );
  if (!shows.length) return { refreshed: 0, failed: 0 };
  const changed = age < 28 * DAY ? await showUpdates(age < DAY ? 'day' : age < 6 * DAY ? 'week' : 'month') : null;
  let refreshed = 0;
  let failed = 0;
  for (const t of shows) {
    const stamp = changed?.[String(t.tvmaze)];
    if (changed ? t.tvmUpdated && !(stamp && stamp > t.tvmUpdated) : over(t)) continue;
    try {
      await refreshTitle(t);
      refreshed++;
    } catch {
      failed++;
    }
    await sleep(600);
  }
  // Record the attempt even if some shows failed (offline, show removed upstream): otherwise every
  // tab focus would refetch everything. Failures are retried within the hour.
  await setSetting('showsSyncedAt', failed ? new Date(Date.now() - 5 * 3600e3).toISOString() : now());
  return { refreshed, failed };
}

/** Save something you set. Each such field remembers when, so a merge can keep the newer edit. */
export async function update(id: string, patch: Partial<Title>) {
  const at = now();
  await db.titles.update(id, { ...patch, ...Object.fromEntries(stamps(patch, at).map(([k, v]) => [`edited.${k}`, v])), updatedAt: at } as Partial<Title>);
}

const GONE = 'This title is no longer in your library.';
const marksOf = (titleId: string) => db.seen.where('titleId').equals(titleId).toArray();

/**
 * Run a change to one title's status and episode marks as one unit: all of it is saved, or none. The undo
 * reverts only what the change did, and only where nothing has touched it since.
 */
function undoable(titleId: string, change: (t: Title) => Promise<void>): Promise<Undo> {
  const tables = [db.titles, db.episodes, db.seen, db.removed];
  return db.transaction('rw', tables, async () => {
    const t0 = await db.titles.get(titleId);
    if (!t0) throw new Error(GONE);
    const m0 = new Map((await marksOf(titleId)).map((m) => [m.episodeId, m]));
    await change(t0);
    const t1 = (await db.titles.get(titleId))!;
    const m1 = new Map((await marksOf(titleId)).map((m) => [m.episodeId, m]));
    return () =>
      db.transaction('rw', tables, async () => {
        const cur = await db.titles.get(titleId);
        if (!cur) return;
        for (const [id, m] of m1) if (!m0.has(id) && (await db.seen.get(id))?.seenAt === m.seenAt) await db.seen.delete(id);
        for (const [id, m] of m0) {
          if (m1.has(id) || (await db.seen.get(id))) continue;
          await db.seen.put(m);
          await db.removed.delete(`seen:${id}`);
        }
        const back = (['status', 'followed', 'finishedAt'] as const).filter((k) => t0[k] !== t1[k] && cur[k] === t1[k]);
        if (back.length) await update(titleId, Object.fromEntries(back.map((k) => [k, t0[k]])));
      });
  });
}

export const setStatus = (t: Pick<Title, 'id'>, status: Status) =>
  undoable(t.id, async (cur) => {
    const patch: Partial<Title> = { status };
    // Earlier versions took a dropped show off the calendar: picking it up again puts it back, unless you took it off.
    if (cur.status === 'dropped' && status !== 'dropped' && cur.followed === false && !cur.edited?.followed) patch.followed = true;
    // "Finished" means every episode that is out has been seen; keep the marks in step with it.
    if (cur.kind === 'show' && status === 'watched') await mark(t.id, (await episodesOf(t.id)).filter((e) => isAired(e)), true);
    await update(t.id, patch);
  });

/** Expectations only mean something if recorded before watching: keep the time. */
export const setExpectation = (id: string, v: number | undefined) => update(id, { expectation: v, expectedAt: v ? now() : undefined });

/** Parde is showing this title's scores before you have seen it: instincts recorded from now on are not blind. */
export const sawScores = (t: Title) => (t.scoresAt || t.status !== 'want' || t.rating ? undefined : db.titles.update(t.id, { scoresAt: now() }));

/** Two quick taps both count: the list is read and written in one step, not from what was on screen. */
export async function changeThemes(id: string, change: (themes: string[]) => string[]) {
  await db.transaction('rw', db.titles, async () => {
    const t = await db.titles.get(id);
    if (!t) throw new Error(GONE);
    const themes = change(t.themes ?? []);
    await update(id, { themes: themes.length ? themes : undefined });
  });
}

/**
 * Record one viewing. Films become watched; a show's finish is recorded the same way. The dialog's
 * rating and themes are what you left there: clearing one clears it.
 */
export async function logWatch(t: Pick<Title, 'id'>, opts: { date: string; together: boolean; rating?: number; partnerRating?: number; themes?: string[] }) {
  await db.transaction('rw', db.titles, db.watches, async () => {
    const cur = await db.titles.get(t.id);
    if (!cur) throw new Error(GONE);
    await db.watches.add({ id: uid(), titleId: t.id, date: opts.date, together: opts.together });
    // finishedAt is the latest viewing: logging an older one does not move it back.
    const latest = !cur.finishedAt || opts.date >= cur.finishedAt.slice(0, 10) ? opts.date : cur.finishedAt;
    const patch: Partial<Title> = { status: 'watched', finishedAt: latest, rating: opts.rating };
    if (opts.together) patch.partnerRating = opts.partnerRating;
    if (opts.themes) patch.themes = opts.themes.length ? opts.themes : undefined;
    await update(t.id, patch);
  });
}

/** The finish date follows the viewings: deleting the one it came from moves it to the latest left. */
export function deleteWatch(id: string): Promise<Undo> {
  const tables = [db.titles, db.watches, db.removed];
  return db.transaction('rw', tables, async () => {
    const w = await db.watches.get(id);
    if (!w) return async () => {};
    await db.watches.delete(id);
    await db.removed.put({ key: `watch:${id}`, at: now() });
    const t = await db.titles.get(w.titleId);
    const moved = t?.finishedAt?.slice(0, 10) === w.date;
    const rest = (await db.watches.where('titleId').equals(w.titleId).sortBy('date')).at(-1)?.date;
    if (moved) await update(w.titleId, { finishedAt: rest });
    return () =>
      db.transaction('rw', tables, async () => {
        const cur = await db.titles.get(w.titleId);
        if (!cur) return;
        await db.watches.put(w);
        await db.removed.delete(`watch:${id}`);
        if (moved && cur.finishedAt === rest) await update(w.titleId, { finishedAt: t!.finishedAt });
      });
  });
}

export function removeTitle(id: string): Promise<Undo> {
  const parts = [db.episodes, db.seen, db.watches, db.links];
  const tables = [db.titles, ...parts, db.removed];
  return db.transaction('rw', tables, async () => {
    const t = await db.titles.get(id);
    if (!t) return async () => {};
    const rows: unknown[][] = [];
    for (const p of parts) {
      rows.push(await p.where('titleId').equals(id).toArray());
      await p.where('titleId').equals(id).delete();
    }
    await db.titles.delete(id);
    await db.removed.put({ key: `title:${id}`, at: now() });
    return () =>
      db.transaction('rw', tables, async () => {
        if (await db.titles.get(id)) return; // added again meanwhile: leave that one
        await db.titles.add(t);
        for (const [i, p] of parts.entries()) await db.table(p.name).bulkPut(rows[i]);
        await db.removed.delete(`title:${id}`);
      });
  });
}

// ---------- Episodes ----------

const episodesOf = async (titleId: string) => (await db.episodes.where('titleId').equals(titleId).toArray()).sort(byOrder);
const seenOf = async (titleId: string) => new Set(await db.seen.where('titleId').equals(titleId).primaryKeys());

/**
 * Keep a show's status in step with its episode marks. "Where you are" is the furthest episode seen;
 * an earlier one left unmarked does not hold a show back.
 * - you mark the last episode of an ended show → watched (or it ends while you are up to date)
 * - a finished show whose next episode is out → watching again: a new season (in the background, only
 *   while it is still on your calendar)
 * - after you mark something: a show you wanted or paused → watching
 * Paused, dropped and a rewatch you chose are your decisions: the background never changes them, and only
 * a status you pick changes dropped.
 */
export async function reconcile(titleId: string, byUser = true, o: { unmarked?: boolean; justEnded?: boolean } = {}) {
  const t = await db.titles.get(titleId);
  if (!t || t.kind !== 'show') return;
  const p = progress(await episodesOf(titleId), await seenOf(titleId));
  const marked = byUser && !o.unmarked;
  let patch: Partial<Title> | undefined;
  if (t.status === 'dropped' || (t.status === 'paused' && !byUser)) {
    // your decision: leave it
  } else if (t.status === 'watched' && p.next && (byUser || (p.lastSeen && isAired(p.next) && onCalendar(t)))) {
    if (!p.lastSeen || isAired(p.next)) patch = { status: 'watching' };
  } else if (p.lastSeen && !p.next && t.showStatus === 'Ended' && (marked || (o.justEnded && t.status === 'watching' && !p.unlisted))) {
    if (t.status !== 'watched') {
      const last = await db.seen.get(p.lastSeen.id);
      patch = { status: 'watched', finishedAt: t.finishedAt ?? (last?.bulk ? undefined : last?.seenAt) };
    }
  } else if (marked && p.lastSeen && (t.status === 'want' || t.status === 'paused')) {
    patch = { status: 'watching' };
  }
  if (byUser) await update(titleId, patch ?? {});
  else if (patch) await db.titles.update(titleId, patch); // not an edit of yours: no edit time
}

/** On this device only, no network: finished shows whose next episode has come out since are back in progress. */
export async function reconcileShows() {
  const done = await db.titles.where('status').equals('watched').filter((t) => t.kind === 'show').primaryKeys();
  for (const id of done) await reconcile(id, false);
}

async function mark(titleId: string, eps: Pick<Episode, 'id'>[], bulk = false) {
  const have = await seenOf(titleId);
  const seenAt = now();
  const add = eps.filter((e) => !have.has(e.id));
  await db.seen.bulkPut(add.map((e) => ({ episodeId: e.id, titleId, seenAt, ...(bulk ? { bulk } : {}) })));
  await db.removed.bulkDelete(add.map((e) => `seen:${e.id}`));
}

async function unmark(titleId: string, ids: number[]) {
  const have = await seenOf(titleId);
  const at = now();
  const gone = ids.filter((id) => have.has(id));
  await db.seen.bulkDelete(gone);
  await db.removed.bulkPut(gone.map((id) => ({ key: `seen:${id}`, at })));
}

export const setSeen = (ep: Episode, on: boolean) =>
  undoable(ep.titleId, async () => {
    await (on ? mark(ep.titleId, [ep]) : unmark(ep.titleId, [ep.id]));
    await reconcile(ep.titleId, true, { unmarked: !on });
  });

/** Several episodes of one show just watched (a season drop on the calendar). */
export const setSeenAll = (titleId: string, eps: Episode[]) =>
  undoable(titleId, async () => {
    await mark(titleId, eps);
    await reconcile(titleId);
  });

/** Mark this episode and everything before it as seen (catching up on a show). */
export const seenUpTo = (ep: Episode) =>
  undoable(ep.titleId, async () => {
    await mark(ep.titleId, (await episodesOf(ep.titleId)).filter((e) => e.id === ep.id || (byOrder(e, ep) < 0 && isAired(e))), true);
    await reconcile(ep.titleId);
  });

/** Every episode that is out so far: "we have seen all of it". */
export const seenAllAired = (titleId: string) =>
  undoable(titleId, async () => {
    await mark(titleId, (await episodesOf(titleId)).filter((e) => isAired(e)), true);
    await reconcile(titleId);
  });

/** "We are up to here": exactly the episodes up to `ep` that are out are seen (none if `ep` is null). */
export const setProgress = (titleId: string, ep: Episode | null) =>
  undoable(titleId, async () => {
    const eps = await episodesOf(titleId);
    const have = await seenOf(titleId);
    const upTo = new Set(ep ? eps.filter((e) => byOrder(e, ep) <= 0 && isListed(e, have) && (isAired(e) || have.has(e.id))).map((e) => e.id) : []);
    // Marks you already had keep their dates; marks for episodes no longer stored are left alone.
    await unmark(titleId, eps.filter((e) => !upTo.has(e.id)).map((e) => e.id));
    await mark(titleId, eps.filter((e) => upTo.has(e.id)), true);
    await reconcile(titleId, true, { unmarked: !ep });
  });

/** Bulk season marks touch only episodes that are out: a future season must stay unseen. */
export const setSeasonSeen = (titleId: string, season: number, on: boolean) =>
  undoable(titleId, async () => {
    const eps = (await episodesOf(titleId)).filter((e) => e.season === season);
    await (on ? mark(titleId, eps.filter((e) => isAired(e)), true) : unmark(titleId, eps.map((e) => e.id)));
    await reconcile(titleId, true, { unmarked: !on });
  });

// ---------- Links ----------

export async function addLink(titleId: string, rawUrl: string, scope: { season?: number; episode?: number } = {}, label?: string) {
  const url = cleanUrl(rawUrl);
  if (!url) throw new Error('That does not look like a web address (it must start with http:// or https://).');
  const link: Link = { id: uid(), titleId, url, addedAt: now(), ...defined(scope), ...(label?.trim() ? { label: label.trim() } : {}) };
  await db.links.add(link);
  return link;
}

export async function editLink(id: string, patch: Partial<Pick<Link, 'url' | 'label' | 'broken' | 'usedAt'>>) {
  if (patch.url !== undefined) {
    const url = cleanUrl(patch.url);
    if (!url) throw new Error('That does not look like a web address.');
    patch.url = url;
  }
  await db.links.update(id, patch);
}

export function deleteLink(id: string): Promise<Undo> {
  return db.transaction('rw', db.links, db.removed, async () => {
    const l = await db.links.get(id);
    await db.links.delete(id);
    await db.removed.put({ key: `link:${id}`, at: now() });
    return () =>
      db.transaction('rw', db.titles, db.links, db.removed, async () => {
        if (!l || !(await db.titles.get(l.titleId))) return;
        await db.links.put(l);
        await db.removed.delete(`link:${id}`);
      });
  });
}

/** A site moved domain: rewrite every saved link on the old host and clear their broken marks. */
export async function moveDomain(from: string, to: string): Promise<number> {
  const target = to.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(target)) throw new Error('Enter just the new domain, like example.org');
  let n = 0;
  await db.transaction('rw', db.links, async () => {
    const all = await db.links.toArray();
    for (const l of all) {
      if (hostOf(l.url) !== from) continue;
      const url = replaceHost(l.url, from, target);
      if (url !== l.url && cleanUrl(url)) {
        await db.links.update(l.id, { url, broken: false });
        n++;
      }
    }
  });
  return n;
}
