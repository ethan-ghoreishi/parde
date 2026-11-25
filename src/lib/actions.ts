import { db, getSetting, now, setSetting, uid, USER_FIELDS, type Dismissed, type Episode, type Link, type Status, type Title } from './db';
import { fetchShow, showUpdates, toEpisode } from './api/tvmaze';
import { filmMeta, filmMetas, qidForImdb, wikidataMeta, type Meta } from './api/wiki';
import { byOrder, completeSchedule, isAired, isListed, onCalendar, progress } from './schedule';
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
  const row: Title = { id, ...meta, status: 'want', followed: meta.kind === 'show' ? true : undefined, addedAt: t, updatedAt: t, enrichedAt: t, ...(patch.status && patch.status !== 'want' ? { firstWatchedAt: t } : {}), ...patch };
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
export const addFilm = (qid: string, patch: Partial<Title> = {}, known?: Meta, needsDetails = false) =>
  once(`wd:${qid}`, async () => {
    const id = `wd:${qid}`;
    if (await db.titles.get(id)) return;
    const meta = known ?? (await filmMeta(qid));
    await db.transaction('rw', db.titles, db.removed, db.dismissed, async () => {
      if (await db.titles.get(id)) return;
      await db.titles.add(newTitle(id, meta, needsDetails ? { ...patch, enrichedAt: undefined } : patch));
      await clearDismissal(qid);
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
  const added = await db.transaction('rw', db.titles, db.removed, db.dismissed, async () => {
    const here = new Set((await db.titles.bulkGet(rows.map((r) => r.id))).filter(Boolean).map((t) => t!.id));
    const add = rows.filter((r) => !here.has(r.id));
    await db.titles.bulkAdd(add);
    for (const r of add) await clearDismissal(r.qid!);
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
  const old = await episodesOf(titleId);
  if (!eps.length && old.length) throw new Error('TVmaze returned an empty schedule. Your last schedule was kept.');
  const listed = new Set(eps.map((e) => e.id));
  if (listed.size !== eps.length || (await db.episodes.bulkGet([...listed])).some((e) => e && e.titleId !== titleId)) throw new Error('TVmaze returned conflicting episode IDs. Your schedule was kept.');
  const missing = old.filter((e) => !listed.has(e.id) && !e.missingSince);
  // A reused season/episode number does not establish that two different episode IDs are the same.
  await db.episodes.bulkPut([...missing.map((e) => ({ ...e, missingSince: now() })), ...eps]);
}

export type InitialProgress = 'all' | { season: number; episode: number };

export async function storeShow(tvmaze: number, patch: Partial<Title> = {}, initial?: InitialProgress) {
  const id = `tvm:${tvmaze}`;
  if (await db.titles.get(id)) return { id, added: false, needsProgress: false };
  const { meta, episodes } = await fetchShow(tvmaze);
  const full = (await enrichShow(meta)) ?? meta;
  const qid = full.qid ?? patch.qid;
  if (full.qid && patch.qid && full.qid !== patch.qid) throw new Error('Wikidata and TVmaze disagree about this series. Choose it in Add.');
  const result = await db.transaction('rw', db.titles, db.episodes, db.seen, db.removed, db.dismissed, async () => {
    if (await db.titles.get(id)) return { id, added: false, needsProgress: false };
    await db.titles.add({ ...newTitle(id, full, patch), syncedAt: now() });
    if (qid) await clearDismissal(qid);
    await saveEpisodes(id, episodes);
    const aired = (await episodesOf(id)).filter((e) => isAired(e));
    const matches = initial && initial !== 'all' ? aired.filter((e) => e.season === initial.season && e.number === initial.episode) : [];
    const selected = initial === 'all' ? aired : matches.length === 1 ? aired.filter((e) => byOrder(e, matches[0]) <= 0) : [];
    if (selected.length) {
      await mark(id, selected, true);
      await reconcile(id);
    }
    return { id, added: true, needsProgress: !!initial && !selected.length };
  });
  persistStorage();
  return result;
}

export const addShow = async (tvmaze: number, patch: Partial<Title> = {}, initial?: InitialProgress) =>
  (await storeShow(tvmaze, patch, initial)).id;

export function dismissTitle(item: Dismissed) {
  return db.transaction('rw', db.dismissed, db.removed, db.titles, async () => {
    if (await db.titles.where('qid').equals(item.qid).count() || (item.tvmaze && await db.titles.get(`tvm:${item.tvmaze}`))) throw new Error('This title is already in your library.');
    await db.dismissed.put({ ...item, measured: true });
    await db.removed.delete(`dismissed:${item.qid}`);
  });
}

export function clearDismissal(qid: string) {
  return db.transaction('rw', db.dismissed, db.removed, async () => {
    if (!(await db.dismissed.get(qid))) return;
    await db.dismissed.delete(qid);
    await db.removed.put({ key: `dismissed:${qid}`, at: now() });
  });
}

/** Refresh metadata (and episodes) without touching anything the user set. */
export async function refreshTitle(t: Title, deep = false) {
  const started = now();
  if (t.kind === 'show' && t.tvmaze) {
    const { meta, episodes } = await fetchShow(t.tvmaze);
    // Wikidata changes slowly: re-enrich monthly, not on every episode sync.
    const reEnrich = deep || !t.enrichedAt || Date.now() - Date.parse(t.enrichedAt) > 30 * 864e5;
    const enriched = reEnrich ? await enrichShow(meta) : undefined;
    const kept = { ...meta, ...pickWd(t), critics: [...meta.critics, ...t.critics.filter((c) => c.source !== 'TVmaze')] };
    // A failed (or suddenly empty) Wikidata lookup keeps the people, subjects and scores found before.
    const full = enriched?.qid && (!t.qid || enriched.qid === t.qid) ? enriched : kept;
    await db.transaction('rw', db.titles, db.episodes, db.seen, async () => {
      const cur = await db.titles.get(t.id);
      if (!cur || cur.addedAt !== t.addedAt || (cur.tvmUpdated ?? 0) > (meta.tvmUpdated ?? 0) ||
        ((cur.syncedAt ?? '') > started && (cur.tvmUpdated ?? 0) >= (meta.tvmUpdated ?? 0))) return;
      const revived = cur.status === 'watched' && cur.showStatus === 'Ended' && !!full.showStatus && full.showStatus !== 'Ended';
      await saveEpisodes(t.id, episodes);
      await db.titles.put({ ...cur, ...filled(full), ...(cur.qid ? { qid: cur.qid } : {}), endedOn: full.endedOn, episodeOrders: full.episodeOrders, ...(revived && !cur.edited?.followed ? { followed: true } : {}), syncedAt: now(), enrichedAt: enriched ? now() : cur.enrichedAt });
      await reconcile(t.id, false, { justEnded: cur.showStatus !== 'Ended' && full.showStatus === 'Ended' });
    });
  } else if (t.qid) {
    const meta = await filmMeta(t.qid);
    await saveFilmMeta(t.id, meta, started, t.addedAt);
  }
}

/** Merges into the stored record, so a rating made while this was loading is kept. */
export async function saveFilmMeta(id: string, meta: Meta, started?: string, addedAt?: string) {
  const { name, ...rest } = meta;
  // Without a label, `name` is only the article title or the id: keep the one we have.
  const named = name !== meta.qid && name !== meta.wiki;
  await db.transaction('rw', db.titles, async () => {
    const t = await db.titles.get(id);
    if (!t || (addedAt && t.addedAt !== addedAt) || (t.enrichedAt && (!started || t.enrichedAt > started))) return;
    await db.titles.update(id, { ...filled(rest), ...(named ? { name } : {}), enrichedAt: now() });
  });
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
  const started = now();
  const metas = await filmMetas(stale.map((t) => t.qid!));
  for (const t of stale) {
    const m = metas.get(t.qid!);
    if (m) await saveFilmMeta(t.id, m, started, t.addedAt);
  }
  await setSetting('filmsSyncedAt', started);
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
let forcing = false;

export function syncShows(force = false): Promise<{ refreshed: number; failed: number }> {
  // App start and tab-focus can both trigger this: never run two at once.
  if (syncing) return force && !forcing ? syncing.then(() => syncShows(true), () => syncShows(true)) : syncing;
  forcing = force;
  syncing = runSync(force).finally(() => (syncing = null));
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
  const changed = !force && age < 28 * DAY ? await showUpdates(age < DAY ? 'day' : age < 6 * DAY ? 'week' : 'month').catch(() => null) : null;
  let refreshed = 0;
  let failed = 0;
  let fallbackEnded = 0;
  for (const t of shows.sort((a, b) => (a.syncedAt ?? '').localeCompare(b.syncedAt ?? ''))) {
    const stamp = changed?.[String(t.tvmaze)];
    const stale = Date.now() - Date.parse(t.syncedAt ?? t.addedAt) > (over(t) ? 28 : 2) * DAY;
    const hasUpdate = !!stamp && stamp > (t.tvmUpdated ?? 0);
    if (!force && !stale && t.tvmUpdated && !hasUpdate) continue;
    if (!hasUpdate && over(t) && fallbackEnded++ >= 12) continue;
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
  const n = await db.titles.update(id, { ...patch, ...Object.fromEntries(stamps(patch, at).map(([k, v]) => [`edited.${k}`, v])), updatedAt: at } as Partial<Title>);
  if (!n) throw new Error(GONE);
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
    const deleted = new Map((await db.removed.bulkGet([...m0.keys()].map((id) => `seen:${id}`))).flatMap((x) => x ? [[x.key, x.at]] : []));
    return () =>
      db.transaction('rw', tables, async () => {
        const cur = await db.titles.get(titleId);
        if (!cur || cur.addedAt !== t0.addedAt) return;
        for (const [id, m] of m1) if (!m0.has(id) && (await db.seen.get(id))?.seenAt === m.seenAt) await unmark(titleId, [id]);
        for (const [id, m] of m0) {
          const key = `seen:${id}`;
          if (m1.has(id) || (await db.seen.get(id)) || !deleted.has(key) || (await db.removed.get(key))?.at !== deleted.get(key)) continue;
          await db.seen.put(m);
          await db.removed.delete(key);
        }
        const back = (['status', 'followed', 'finishedAt'] as const).filter((k) => t0[k] !== t1[k] && cur[k] === t1[k] && cur.edited?.[k] === t1.edited?.[k]);
        if (back.length) await update(titleId, Object.fromEntries(back.map((k) => [k, t0[k]])));
      });
  });
}

export const setStatus = (t: Pick<Title, 'id'>, status: Status) =>
  undoable(t.id, async (cur) => {
    const patch: Partial<Title> = { status };
    if (status === 'watched' && !cur.firstWatchedAt) patch.firstWatchedAt = now();
    // Earlier versions took a dropped show off the calendar: picking it up again puts it back, unless you took it off.
    if (cur.status === 'dropped' && status !== 'dropped' && cur.followed === false && !cur.edited?.followed) patch.followed = true;
    // "Finished" means every episode that is out has been seen; keep the marks in step with it.
    if (cur.kind === 'show' && status === 'watched') await mark(t.id, (await episodesOf(t.id)).filter((e) => isAired(e)), true);
    await update(t.id, patch);
  });

/** Expectations only mean something if recorded before watching: keep the time. */
export function setExpectation(id: string, v: number | undefined) {
  return db.transaction('rw', db.titles, async () => {
    const t = await db.titles.get(id);
    if (!t || t.status !== 'want' || t.rating !== undefined || t.finishedAt || t.firstWatchedAt) throw new Error('Pre-watch instinct can only be recorded before starting.');
    await update(id, { expectation: v, expectedAt: v ? now() : undefined, instinctRecorded: !!v });
  });
}

export function sawScores(t: Pick<Title, 'id'>) {
  return db.transaction('rw', db.titles, async () => {
    const cur = await db.titles.get(t.id);
    if (cur?.status === 'want' && !cur.scoresAt && cur.rating === undefined && !cur.firstWatchedAt) await db.titles.update(t.id, { scoresAt: now() });
  });
}

/** Two quick taps both count: the list is read and written in one step, not from what was on screen. */
export async function changeThemes(id: string, change: (themes: string[]) => string[]) {
  await db.transaction('rw', db.titles, async () => {
    const t = await db.titles.get(id);
    if (!t) throw new Error(GONE);
    const themes = change(t.themes ?? []);
    await update(id, { themes: themes.length ? themes : undefined });
  });
}

export function changeDrawn(id: string, reason: string) {
  return db.transaction('rw', db.titles, async () => {
    const t = await db.titles.get(id);
    if (!t || t.status !== 'want' || t.firstWatchedAt || t.rating !== undefined) throw new Error('This can only be recorded before watching.');
    const drawn = new Set(t.drawn);
    if (drawn.has(reason)) drawn.delete(reason);
    else drawn.add(reason);
    await update(id, { drawn: [...drawn] });
  });
}

/**
 * Record one viewing. Films become watched; a show's finish is recorded the same way. The dialog's
 * rating and themes are what you left there: clearing one clears it.
 */
export async function logWatch(t: Pick<Title, 'id'>, opts: { date: string; together: boolean; rating?: number; partnerRating?: number; themes?: string[] }) {
  await db.transaction('rw', db.titles, db.watches, db.episodes, db.seen, db.removed, async () => {
    const cur = await db.titles.get(t.id);
    if (!cur) throw new Error(GONE);
    if (cur.kind === 'show') await mark(t.id, await episodesOf(t.id), true);
    await db.watches.add({ id: uid(), titleId: t.id, date: opts.date, together: opts.together });
    // finishedAt is the latest viewing: logging an older one does not move it back.
    const latest = !cur.finishedAt || opts.date >= cur.finishedAt.slice(0, 10) ? opts.date : cur.finishedAt;
    const patch: Partial<Title> = { status: 'watched', finishedAt: latest, rating: opts.rating, firstWatchedAt: [cur.firstWatchedAt, opts.date].filter(Boolean).sort()[0] };
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
    const at = now();
    await db.watches.delete(id);
    await db.removed.put({ key: `watch:${id}`, at });
    const t = await db.titles.get(w.titleId);
    const moved = t?.finishedAt?.slice(0, 10) === w.date;
    const rest = (await db.watches.where('titleId').equals(w.titleId).sortBy('date')).at(-1)?.date;
    if (moved) await update(w.titleId, { finishedAt: rest });
    return () =>
      db.transaction('rw', tables, async () => {
        const cur = await db.titles.get(w.titleId);
        if (!cur || cur.addedAt !== t?.addedAt || (await db.removed.get(`watch:${id}`))?.at !== at) return;
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
    const at = now();
    await db.titles.delete(id);
    await db.removed.put({ key: `title:${id}`, at });
    return () =>
      db.transaction('rw', tables, async () => {
        if ((await db.titles.get(id)) || (await db.removed.get(`title:${id}`))?.at !== at) return;
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
  const eps = await episodesOf(titleId);
  const p = progress(eps, await seenOf(titleId));
  const marked = byUser && !o.unmarked;
  let patch: Partial<Title> | undefined;
  if (t.status === 'dropped' || (t.status === 'paused' && !byUser)) {
    // your decision: leave it
  } else if (t.status === 'watched' && p.next && (byUser || (p.lastSeen && isAired(p.next) && onCalendar(t)))) {
    if (!p.lastSeen || isAired(p.next)) patch = { status: 'watching' };
  } else if (p.lastSeen && !p.next && p.seenCount === p.total && completeSchedule(t, eps) && (marked || (o.justEnded && t.status === 'watching' && !p.unlisted))) {
    if (t.status !== 'watched') {
      const last = await db.seen.get(p.lastSeen.id);
      patch = { status: 'watched', finishedAt: t.finishedAt ?? (last?.bulk ? undefined : last?.seenAt) };
    }
  } else if (marked && p.lastSeen && (t.status === 'want' || t.status === 'paused')) {
    patch = { status: 'watching' };
  }
  if (marked && p.lastSeen && !t.firstWatchedAt) {
    const first = await db.seen.get(p.lastSeen.id);
    patch = { ...patch, firstWatchedAt: now(), ...(first?.bulk ? { instinctRecorded: false } : {}) };
  }
  if (byUser && patch) await update(titleId, patch);
  else if (!byUser && patch) await db.titles.update(titleId, patch); // not an edit of yours: no edit time
}

/** On this device only, no network: finished shows whose next episode has come out since are back in progress. */
export function reconcileShows() {
  // One transaction: pages follow the stored data, and would reload everything after each series.
  return db.transaction('rw', db.titles, db.episodes, db.seen, async () => {
    const done = await db.titles.where('status').equals('watched').filter((t) => t.kind === 'show').primaryKeys();
    for (const id of done) await reconcile(id, false);
  });
}

async function mark(titleId: string, eps: Pick<Episode, 'id'>[], bulk = false) {
  const have = await seenOf(titleId);
  const stored = await db.episodes.bulkGet(eps.map((e) => e.id));
  const seenAt = now();
  const add = stored.filter((e): e is Episode => !!e && e.titleId === titleId && !e.missingSince && isAired(e) && !have.has(e.id));
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
    if (on && !(await db.episodes.get(ep.id).then((e) => e && !e.missingSince && isAired(e)))) throw new Error('This episode is not confirmed as released.');
    await (on ? mark(ep.titleId, [ep]) : unmark(ep.titleId, [ep.id]));
    await reconcile(ep.titleId, true, { unmarked: !on });
  });

/** Several episodes of one show just watched (a season drop on the calendar). */
export const setSeenAll = (titleId: string, eps: Episode[]) =>
  undoable(titleId, async () => {
    const current = await db.episodes.bulkGet(eps.map((e) => e.id));
    if (current.some((e) => !e || e.titleId !== titleId || e.missingSince || !isAired(e))) throw new Error('The schedule changed. Check the episode list and try again.');
    await mark(titleId, eps);
    await reconcile(titleId);
  });

/** Mark this episode and everything before it as seen (catching up on a show). */
export const seenUpTo = (ep: Episode) =>
  undoable(ep.titleId, async () => {
    const eps = await episodesOf(ep.titleId);
    const target = eps.find((e) => e.id === ep.id && byOrder(e, ep) === 0 && !e.missingSince && isAired(e));
    if (!target) throw new Error('This episode changed or is not released.');
    await mark(ep.titleId, eps.filter((e) => byOrder(e, target) <= 0), true);
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
    const target = ep && eps.find((e) => e.id === ep.id && byOrder(e, ep) === 0 && !e.missingSince && isAired(e));
    if (ep && !target) throw new Error('This episode changed or is not released. Choose your position again.');
    const upTo = new Set(target ? eps.filter((e) => byOrder(e, target) <= 0 && isListed(e, have) && (isAired(e) || have.has(e.id))).map((e) => e.id) : []);
    // Marks you already had keep their dates; marks for episodes no longer stored are left alone.
    await unmark(titleId, eps.filter((e) => !e.missingSince && !upTo.has(e.id)).map((e) => e.id));
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
  await db.transaction('rw', db.titles, db.links, async () => {
    if (!(await db.titles.get(titleId))) throw new Error(GONE);
    await db.links.add(link);
  });
  return link;
}

export async function editLink(id: string, patch: Partial<Pick<Link, 'url' | 'label' | 'broken' | 'usedAt' | 'failedEpisodes'>>) {
  if (patch.url !== undefined) {
    const url = cleanUrl(patch.url);
    if (!url) throw new Error('That does not look like a web address.');
    patch.url = url;
  }
  const edit = Object.keys(patch).some((k) => k !== 'usedAt');
  if (!(await db.links.update(id, edit ? { ...patch, editedAt: now() } : patch))) throw new Error('This source is no longer saved.');
}

export async function markSource(id: string, broken: boolean, season?: number, episode?: number) {
  await db.transaction('rw', db.links, async () => {
    const link = await db.links.get(id);
    if (!link) throw new Error('This source is no longer saved.');
    if (season !== undefined && episode !== undefined && link.episode === undefined && !link.broken) {
      const key = `${season}:${episode}`;
      const failed = new Set(link.failedEpisodes);
      if (broken) failed.add(key);
      else failed.delete(key);
      await editLink(id, { failedEpisodes: [...failed] });
    } else await editLink(id, { broken });
  });
}

export function deleteLink(id: string): Promise<Undo> {
  return db.transaction('rw', db.links, db.removed, async () => {
    const l = await db.links.get(id);
    if (!l) return async () => {};
    const at = now();
    await db.links.delete(id);
    await db.removed.put({ key: `link:${id}`, at });
    return () =>
      db.transaction('rw', db.titles, db.links, db.removed, async () => {
        if (!(await db.titles.get(l.titleId)) || (await db.removed.get(`link:${id}`))?.at !== at) return;
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
        await db.links.update(l.id, { url, broken: false, failedEpisodes: undefined, editedAt: now() });
        n++;
      }
    }
  });
  return n;
}
