import { db, getSetting, now, setSetting, uid, type Episode, type Link, type Status, type Title } from './db';
import { fetchShow, showUpdates, toEpisode } from './api/tvmaze';
import { filmMeta, qidForImdb, wikidataMeta, type Meta } from './api/wiki';
import { byOrder } from './schedule';
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

export async function addFilm(qid: string, wiki?: string): Promise<string> {
  const id = `wd:${qid}`;
  if (await db.titles.get(id)) return id;
  const meta = await filmMeta(qid, wiki);
  await db.titles.add(newTitle(id, meta));
  persistStorage();
  return id;
}

/** Wikidata adds critics, subjects, countries and linked people to a TVmaze show, when it can be found. */
async function enrichShow(meta: Meta): Promise<Meta> {
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
    return meta; // enrichment is a bonus; the show itself is already good
  }
}

async function saveEpisodes(titleId: string, raw: Parameters<typeof toEpisode>[1][]) {
  const eps = raw.map((e) => toEpisode(titleId, e)).filter((e): e is Episode => !!e);
  const keep = new Set(eps.map((e) => e.id));
  await db.transaction('rw', db.episodes, async () => {
    const old = await db.episodes.where('titleId').equals(titleId).primaryKeys();
    await db.episodes.bulkDelete(old.filter((id) => !keep.has(id)));
    await db.episodes.bulkPut(eps);
  });
}

export async function addShow(tvmaze: number): Promise<string> {
  const id = `tvm:${tvmaze}`;
  if (await db.titles.get(id)) return id;
  const { meta, episodes } = await fetchShow(tvmaze);
  const full = await enrichShow(meta);
  await db.transaction('rw', db.titles, db.episodes, async () => {
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
    const full = reEnrich ? await enrichShow(meta) : { ...meta, ...pickWd(t), critics: [...meta.critics, ...t.critics.filter((c) => c.source !== 'TVmaze')] };
    await db.transaction('rw', db.titles, db.episodes, async () => {
      const cur = await db.titles.get(t.id);
      if (!cur) return;
      await db.titles.put({ ...cur, ...defined(full), syncedAt: now(), enrichedAt: reEnrich ? now() : cur.enrichedAt });
      await saveEpisodes(t.id, episodes);
    });
  } else if (t.qid) {
    const meta = await filmMeta(t.qid, t.wiki);
    const cur = await db.titles.get(t.id);
    if (cur) await db.titles.put({ ...cur, ...defined(meta), enrichedAt: now() });
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
export async function syncShows(force = false): Promise<{ refreshed: number; failed: number }> {
  const last = await getSetting<string>('showsSyncedAt', '');
  const age = last ? Date.now() - Date.parse(last) : Infinity;
  if (!force && age < 6 * 3600e3) return { refreshed: 0, failed: 0 };
  const shows = (await db.titles.where('kind').equals('show').toArray()).filter((t) => t.followed && t.status !== 'dropped' && t.tvmaze);
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
  if (!failed) await setSetting('showsSyncedAt', now());
  return { refreshed, failed };
}

export async function update(id: string, patch: Partial<Title>) {
  await db.titles.update(id, { ...patch, updatedAt: now() });
}

export async function setStatus(t: Title, status: Status) {
  const patch: Partial<Title> = { status };
  if (t.kind === 'show') patch.followed = status === 'dropped' ? false : status === 'watched' ? t.showStatus !== 'Ended' && t.followed : t.followed ?? true;
  if (status === 'watched' && !t.finishedAt) patch.finishedAt = now();
  await update(t.id, patch);
}

/** Record one viewing. Films become watched; a show's finish is recorded the same way. */
export async function logWatch(t: Title, opts: { date: string; together: boolean; rating?: number; partnerRating?: number }) {
  await db.transaction('rw', db.titles, db.watches, async () => {
    await db.watches.add({ id: uid(), titleId: t.id, date: opts.date, together: opts.together });
    const patch: Partial<Title> = { status: 'watched', finishedAt: opts.date };
    if (opts.rating) patch.rating = opts.rating;
    if (opts.partnerRating) patch.partnerRating = opts.partnerRating;
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

async function afterSeenChange(titleId: string) {
  const t = await db.titles.get(titleId);
  if (!t) return;
  const eps = await db.episodes.where('titleId').equals(titleId).toArray();
  const seen = new Set(await db.seen.where('titleId').equals(titleId).primaryKeys());
  const all = eps.length > 0 && eps.every((e) => seen.has(e.id));
  if (all && t.showStatus === 'Ended' && t.status !== 'watched') {
    await update(titleId, { status: 'watched', finishedAt: now(), followed: false });
  } else if (seen.size > 0 && (t.status === 'want' || t.status === 'paused')) {
    await update(titleId, { status: 'watching' });
  } else {
    await update(titleId, {});
  }
}

export async function setSeen(ep: Episode, on: boolean) {
  if (on) await db.seen.put({ episodeId: ep.id, titleId: ep.titleId, seenAt: now() });
  else await db.seen.delete(ep.id);
  await afterSeenChange(ep.titleId);
}

/** Mark this episode and everything before it as seen (catching up on a show). */
export async function seenUpTo(ep: Episode) {
  const eps = (await db.episodes.where('titleId').equals(ep.titleId).toArray()).filter((e) => byOrder(e, ep) <= 0);
  const have = new Set(await db.seen.where('titleId').equals(ep.titleId).primaryKeys());
  const t = now();
  await db.seen.bulkPut(eps.filter((e) => !have.has(e.id)).map((e) => ({ episodeId: e.id, titleId: e.titleId, seenAt: t })));
  await afterSeenChange(ep.titleId);
}

export async function setSeasonSeen(titleId: string, season: number, on: boolean) {
  const eps = (await db.episodes.where('titleId').equals(titleId).toArray()).filter((e) => e.season === season);
  if (on) {
    const have = new Set(await db.seen.where('titleId').equals(titleId).primaryKeys());
    const t = now();
    await db.seen.bulkPut(eps.filter((e) => !have.has(e.id)).map((e) => ({ episodeId: e.id, titleId, seenAt: t })));
  } else {
    await db.seen.bulkDelete(eps.map((e) => e.id));
  }
  await afterSeenChange(titleId);
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
