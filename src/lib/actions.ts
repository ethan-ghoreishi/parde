import { db, getSetting, now, setSetting, uid, type Episode, type Link, type Status, type Title } from './db';
import { fetchShow, showUpdates, toEpisode } from './api/tvmaze';
import { filmMeta, filmMetas, qidForImdb, wikidataMeta, type Meta } from './api/wiki';
import { byOrder, isAired, progress } from './schedule';
import { cleanUrl, replaceHost, hostOf } from './links';

const defined = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/** Ask the browser not to evict our data under storage pressure (matters most on iOS). */
export function persistStorage() {
  navigator.storage?.persist?.().catch(() => {});
}

function newTitle(id: string, meta: Meta): Title {
  const t = now();
  return { id, ...meta, status: 'want', followed: meta.kind === 'show' ? true : undefined, addedAt: t, updatedAt: t, enrichedAt: t };
}

export async function addFilm(qid: string): Promise<string> {
  const id = `wd:${qid}`;
  if (await db.titles.get(id)) return id;
  const meta = await filmMeta(qid);
  await db.titles.add(newTitle(id, meta));
  persistStorage();
  return id;
}

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
    return m ? [{ ...newTitle(`wd:${e.qid}`, m), ...e.patch }] : [];
  });
  const added = await db.transaction('rw', db.titles, async () => {
    const now = new Set((await db.titles.bulkGet(rows.map((r) => r.id))).filter(Boolean).map((t) => t!.id));
    const add = rows.filter((r) => !now.has(r.id));
    await db.titles.bulkAdd(add);
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

async function saveEpisodes(titleId: string, raw: Parameters<typeof toEpisode>[1][]) {
  const eps = raw.map((e) => toEpisode(titleId, e)).filter((e): e is Episode => !!e);
  // An empty list is a broken or partial reply, not a show that lost every episode: keep what we have.
  if (!eps.length) return;
  const keep = new Set(eps.map((e) => e.id));
  await db.transaction('rw', db.episodes, db.seen, async () => {
    const gone = (await db.episodes.where('titleId').equals(titleId).toArray()).filter((e) => !keep.has(e.id));
    if (gone.length) {
      // TVmaze occasionally re-creates an episode under a new id: carry its seen mark across.
      // Marks for episodes that vanished outright are left alone, in case they come back.
      const slot = new Map(eps.map((e) => [`${e.season}x${e.number}`, e.id]));
      const marks = await db.seen.bulkGet(gone.map((e) => e.id));
      const moved = marks.flatMap((m, i) => {
        const to = m && slot.get(`${gone[i].season}x${gone[i].number}`);
        return to ? [{ from: m.episodeId, mark: { ...m, episodeId: to } }] : [];
      });
      await db.seen.bulkPut(moved.map((x) => x.mark));
      await db.seen.bulkDelete(moved.map((x) => x.from));
      await db.episodes.bulkDelete(gone.map((e) => e.id));
    }
    await db.episodes.bulkPut(eps);
  });
}

export async function addShow(tvmaze: number): Promise<string> {
  const id = `tvm:${tvmaze}`;
  if (await db.titles.get(id)) return id;
  const { meta, episodes } = await fetchShow(tvmaze);
  const full = (await enrichShow(meta)) ?? meta;
  await db.transaction('rw', db.titles, db.episodes, db.seen, async () => {
    await db.titles.add({ ...newTitle(id, full), syncedAt: now() });
    await saveEpisodes(id, episodes);
  });
  persistStorage();
  return id;
}

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
    await db.transaction('rw', db.titles, db.episodes, db.seen, async () => {
      const cur = await db.titles.get(t.id);
      if (!cur) return;
      await db.titles.put({ ...cur, ...defined(full), syncedAt: now(), enrichedAt: enriched ? now() : cur.enrichedAt });
      await saveEpisodes(t.id, episodes);
    });
    await reconcile(t.id, false);
  } else if (t.qid) {
    const meta = await filmMeta(t.qid);
    // update() merges into the stored record, so a rating made while this was loading is kept.
    await db.titles.update(t.id, { ...defined(meta), enrichedAt: now() });
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
  // Every show that can still gain episodes you care about, followed on the calendar or not.
  const shows = (await db.titles.where('kind').equals('show').toArray()).filter(
    (t) => t.tvmaze && t.status !== 'dropped' && (t.followed || t.status === 'watching' || t.status === 'paused' || (t.status === 'watched' && t.showStatus !== 'Ended')),
  );
  if (!shows.length) return { refreshed: 0, failed: 0 };
  const changed = age < 6 * 864e5 ? await showUpdates(age < 864e5 ? 'day' : 'week') : null;
  let refreshed = 0;
  let failed = 0;
  for (const t of shows) {
    const stamp = changed?.[String(t.tvmaze)];
    if (changed && t.tvmUpdated && !(stamp && stamp > t.tvmUpdated)) continue;
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

export async function update(id: string, patch: Partial<Title>) {
  await db.titles.update(id, { ...patch, updatedAt: now() });
}

export async function setStatus(t: Title, status: Status) {
  const patch: Partial<Title> = { status };
  if (t.kind === 'show') patch.followed = status === 'dropped' ? false : status === 'watched' ? t.showStatus !== 'Ended' && t.followed : t.followed ?? true;
  if (status === 'watched' && !t.finishedAt) patch.finishedAt = now();
  // "Finished" means every episode that is out has been seen; keep the marks in step with it.
  if (t.kind === 'show' && status === 'watched') await markSeen(t.id, (await episodesOf(t.id)).filter((e) => isAired(e)));
  await update(t.id, patch);
}

/** Expectations only mean something if recorded before watching: keep the time. */
export const setExpectation = (id: string, v: number | undefined) => update(id, { expectation: v, expectedAt: v ? now() : undefined });

/**
 * Record one viewing. Films become watched; a show's finish is recorded the same way. The dialog's
 * rating and themes are what you left there: clearing one clears it.
 */
export async function logWatch(t: Title, opts: { date: string; together: boolean; rating?: number; partnerRating?: number; themes?: string[] }) {
  await db.transaction('rw', db.titles, db.watches, async () => {
    await db.watches.add({ id: uid(), titleId: t.id, date: opts.date, together: opts.together });
    // finishedAt is the latest viewing: logging an older one does not move it back.
    const latest = !t.finishedAt || opts.date >= t.finishedAt.slice(0, 10) ? opts.date : t.finishedAt;
    const patch: Partial<Title> = { status: 'watched', finishedAt: latest, rating: opts.rating };
    if (opts.together) patch.partnerRating = opts.partnerRating;
    if (opts.themes) patch.themes = opts.themes.length ? opts.themes : undefined;
    await update(t.id, patch);
  });
}

export async function deleteWatch(id: string) {
  await db.watches.delete(id);
}

export async function removeTitle(id: string) {
  await db.transaction('rw', [db.titles, db.episodes, db.seen, db.watches, db.links], async () => {
    await db.titles.delete(id);
    await db.episodes.where('titleId').equals(id).delete();
    await db.seen.where('titleId').equals(id).delete();
    await db.watches.where('titleId').equals(id).delete();
    await db.links.where('titleId').equals(id).delete();
  });
}

// ---------- Episodes ----------

const episodesOf = async (titleId: string) => (await db.episodes.where('titleId').equals(titleId).toArray()).sort(byOrder);
const seenOf = async (titleId: string) => new Set(await db.seen.where('titleId').equals(titleId).primaryKeys());

/**
 * Keep a show's status in step with its episode marks. "Where you are" is the furthest episode seen;
 * an earlier one left unmarked does not hold a show back.
 * - seen through to the last episode of an ended show → watched, and off the calendar
 * - a finished show whose next episode is out → watching again: a new season (in the background, only
 *   while it is still on your calendar)
 * - after you mark something: a show you wanted or paused → watching
 * Paused and dropped are your decisions: the background never changes them, and only a status you pick
 * changes dropped.
 */
export async function reconcile(titleId: string, byUser = true) {
  const t = await db.titles.get(titleId);
  if (!t || t.kind !== 'show') return;
  const p = progress(await episodesOf(titleId), await seenOf(titleId));
  let patch: Partial<Title> | undefined;
  if (t.status === 'dropped' || (t.status === 'paused' && !byUser)) {
    // your decision: leave it
  } else if (p.lastSeen && !p.next && t.showStatus === 'Ended') {
    if (t.status !== 'watched') patch = { status: 'watched', finishedAt: t.finishedAt ?? now(), followed: false };
  } else if (t.status === 'watched' && p.lastSeen && p.next && isAired(p.next) && (byUser || t.followed)) {
    patch = { status: 'watching' };
  } else if (byUser && p.lastSeen && (t.status === 'want' || t.status === 'paused')) {
    patch = { status: 'watching' };
  }
  if (patch || byUser) await update(titleId, patch ?? {});
}

/** On this device only, no network: finished shows whose next episode has come out since are back in progress. */
export async function reconcileShows() {
  const done = await db.titles.where('status').equals('watched').filter((t) => t.kind === 'show').primaryKeys();
  for (const id of done) await reconcile(id, false);
}

async function markSeen(titleId: string, eps: Episode[]) {
  const have = await seenOf(titleId);
  const t = now();
  await db.seen.bulkPut(eps.filter((e) => !have.has(e.id)).map((e) => ({ episodeId: e.id, titleId, seenAt: t })));
}

export async function setSeen(ep: Episode, on: boolean) {
  if (on) await db.seen.put({ episodeId: ep.id, titleId: ep.titleId, seenAt: now() });
  else await db.seen.delete(ep.id);
  await reconcile(ep.titleId);
}

/** Mark this episode and everything before it as seen (catching up on a show). */
export async function seenUpTo(ep: Episode) {
  await markSeen(ep.titleId, (await episodesOf(ep.titleId)).filter((e) => byOrder(e, ep) <= 0));
  await reconcile(ep.titleId);
}

/** Every episode that is out so far: "we have seen all of it". */
export async function seenAllAired(titleId: string) {
  await markSeen(titleId, (await episodesOf(titleId)).filter((e) => isAired(e)));
  await reconcile(titleId);
}

/**
 * "We are up to here": exactly the episodes up to `ep` are seen (none if `ep` is null).
 * Returns an undo that puts the previous marks back.
 */
export async function setProgress(titleId: string, ep: Episode | null): Promise<() => Promise<void>> {
  const before = await db.seen.where('titleId').equals(titleId).toArray();
  const t = await db.titles.get(titleId);
  const eps = await episodesOf(titleId);
  const upTo = new Set(ep ? eps.filter((e) => byOrder(e, ep) <= 0).map((e) => e.id) : []);
  const listed = new Set(eps.map((e) => e.id));
  const had = new Set(before.map((m) => m.episodeId));
  await db.transaction('rw', db.seen, async () => {
    // Marks you already had keep their dates; marks for episodes no longer listed are left alone.
    await db.seen.bulkDelete(before.filter((m) => listed.has(m.episodeId) && !upTo.has(m.episodeId)).map((m) => m.episodeId));
    const stamp = now();
    await db.seen.bulkPut([...upTo].filter((id) => !had.has(id)).map((episodeId) => ({ episodeId, titleId, seenAt: stamp })));
  });
  // Back to the very start of something "finished": it is in progress again, not finished.
  if (!ep && t?.status === 'watched') await update(titleId, { status: 'watching' });
  await reconcile(titleId);
  return async () => {
    await db.transaction('rw', db.seen, async () => {
      await db.seen.where('titleId').equals(titleId).delete();
      await db.seen.bulkPut(before);
    });
    if (t) await update(titleId, { status: t.status, followed: t.followed, finishedAt: t.finishedAt });
  };
}

/** Bulk season marks touch only episodes that are out: a future season must stay unseen. */
export async function setSeasonSeen(titleId: string, season: number, on: boolean) {
  const eps = (await episodesOf(titleId)).filter((e) => e.season === season);
  if (on) await markSeen(titleId, eps.filter((e) => isAired(e)));
  else await db.seen.bulkDelete(eps.map((e) => e.id));
  await reconcile(titleId);
}

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

export const deleteLink = (id: string) => db.links.delete(id);

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
