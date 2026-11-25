import { db, now, STORES, USER_FIELDS, type Dismissed, type Episode, type Link, type Removed, type Seen, type StoreName, type Title, type Watch } from './db';
import { reconcile } from './actions';
import { cleanUrl } from './links';

export const SCHEMA_VERSION = 1;

export interface Backup {
  app: 'parde';
  schemaVersion: number;
  exportedAt: string;
  data: Record<StoreName, unknown[]>;
  /** Records in the file that could not be read (set when parsing, never stored) */
  damaged?: number;
}

/** Settings key holding this device's data as it was just before the last restore. */
export const UNDO_KEY = 'beforeRestore';

async function snapshot(): Promise<Record<StoreName, unknown[]>> {
  const data = {} as Record<StoreName, unknown[]>;
  for (const s of STORES) data[s] = await db.table(s).toArray();
  data.settings = (data.settings as { key: string }[]).filter((r) => r.key !== UNDO_KEY);
  return data;
}

export async function buildBackup(): Promise<Backup> {
  const data = await db.transaction('r', STORES.map((s) => db.table(s)), snapshot);
  return { app: 'parde', schemaVersion: SCHEMA_VERSION, exportedAt: now(), data };
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const optNum = (v: unknown, lo: number, hi: number) => v === undefined || (isNum(v) && v >= lo && v <= hi);
const optStr = (v: unknown) => v === undefined || typeof v === 'string';
const optBool = (v: unknown) => v === undefined || typeof v === 'boolean';
/** A real date, or date and time, in the form Parde writes. */
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v));
const optDate = (v: unknown) => v === undefined || isDate(v);
const optInt = (v: unknown, lo: number, hi: number) => v === undefined || (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi);
const strs = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const STATUSES = ['want', 'watching', 'watched', 'paused', 'dropped'];
const ROLES = ['director', 'writer', 'creator', 'cast', 'composer'];

type Rec = Record<string, unknown>;
type Check = (r: Rec) => string | null;

/**
 * Details fetched from Wikidata, Wikipedia or TVmaze. One with the wrong shape is dropped (a refresh
 * fetches it again) instead of failing the whole file; what you recorded yourself is checked strictly.
 */
const META: Record<string, (v: unknown) => boolean> = {
  year: isNum, runtime: isNum, tvmaze: isNum, tvmUpdated: isNum,
  poster: isStr, overview: isStr, wiki: isStr, network: isStr, webChannel: isStr, channelCountry: isStr, showStatus: isStr,
  qid: (v) => typeof v === 'string' && /^Q\d+$/.test(v),
  imdb: (v) => typeof v === 'string' && /^tt\d+$/.test(v),
  trailer: (v) => typeof v === 'string' && /^[\w-]{6,20}$/.test(v),
  enrichedAt: isDate, syncedAt: isDate, endedOn: isDate, episodeOrders: (v) => Array.isArray(v) && v.every((n) => isNum(n) && Number.isInteger(n) && n > 0),
};
const LISTS = ['genres', 'subjects', 'countries', 'languages'];

const scores = (v: unknown) => Array.isArray(v) ? v.filter((c) => c && isStr(c.source) && isStr(c.value) && isNum(c.score) && c.score >= 0 && c.score <= 100 && optStr(c.asOf)) : [];
const titleId = (v: unknown): v is string => isStr(v) && /^(wd:Q\d+|tvm:\d+)$/.test(v);

function cleanTitle(r: Rec): Rec {
  const out: Rec = { ...r };
  for (const [k, ok] of Object.entries(META)) if (out[k] !== undefined && !ok(out[k])) delete out[k];
  for (const k of LISTS) out[k] = strs(out[k]) ? out[k] : [];
  out.people = Array.isArray(out.people)
    ? (out.people as Rec[]).filter((p) => p && isStr(p.name) && ROLES.includes(p.role as string) && (p.qid === undefined || META.qid(p.qid)))
    : [];
  out.critics = scores(out.critics);
  if (out.choiceScores !== undefined) out.choiceScores = scores(out.choiceScores);
  return out;
}

const CHECKS: Record<StoreName, { key: string; check: Check; clean?: (r: Rec) => Rec }> = {
  titles: {
    key: 'id',
    clean: cleanTitle,
    check: (r) =>
      !titleId(r.id) ? 'bad title id'
      : r.kind !== (r.id.startsWith('wd:') ? 'film' : 'show') ? 'bad kind'
      : !isStr(r.name) ? 'missing name'
      : !STATUSES.includes(r.status as string) ? 'bad status'
      : !isDate(r.addedAt) || !isDate(r.updatedAt) ? 'missing dates'
      : !optDate(r.finishedAt) || !optDate(r.firstWatchedAt) || !optBool(r.instinctRecorded) || !optDate(r.expectedAt) || !optDate(r.chosenAt) || !optDate(r.scoresAt) ? 'bad dates'
      : !optInt(r.rating, 1, 10) || !optInt(r.partnerRating, 1, 10) || !optInt(r.expectation, 1, 5) ? 'rating out of range'
      : (r.themes !== undefined && !strs(r.themes)) || (r.drawn !== undefined && !strs(r.drawn)) ? 'bad themes'
      : r.edited !== undefined && !(r.edited && typeof r.edited === 'object' && Object.values(r.edited).every(isDate)) ? 'bad edit times'
      : !optStr(r.note) ? 'bad note'
      : !optBool(r.followed) ? 'bad calendar setting'
      : null,
  },
  episodes: {
    key: 'id',
    clean: (r) => ({ ...r, name: typeof r.name === 'string' ? r.name : '', airtime: typeof r.airtime === 'string' ? r.airtime : '' }),
    check: (r) =>
      !isNum(r.id) || !isStr(r.titleId) || !isNum(r.season) || !isNum(r.number) || typeof r.airdate !== 'string' || !optStr(r.airstamp) || !optStr(r.summary) || !optNum(r.runtime, 0, 1e4) || !optDate(r.missingSince)
        ? 'bad episode'
        : null,
  },
  seen: { key: 'episodeId', check: (r) => (!isNum(r.episodeId) || !isStr(r.titleId) || !isDate(r.seenAt) || !optBool(r.bulk) ? 'bad seen mark' : null) },
  watches: {
    key: 'id',
    check: (r) => (!isStr(r.id) || !isStr(r.titleId) || !isDate(r.date) || typeof r.together !== 'boolean' ? 'bad watch' : null),
  },
  links: {
    key: 'id',
    clean: (r) => ({ ...r, url: cleanUrl(r.url as string) }),
    check: (r) =>
      !isStr(r.id) || !isStr(r.titleId) || !isDate(r.addedAt) ? 'bad link'
      : !isStr(r.url) || !cleanUrl(r.url) ? 'unsafe or invalid link URL'
      : !optNum(r.season, 0, 1e4) || !optNum(r.episode, 0, 1e5) || (r.episode !== undefined && r.season === undefined) ? 'bad link episode'
      : !optStr(r.label) || !optBool(r.broken) || !optDate(r.usedAt) || !optDate(r.editedAt) || (r.failedEpisodes !== undefined && !strs(r.failedEpisodes)) ? 'bad link details'
      : null,
  },
  settings: {
    key: 'key',
    check: (r) =>
      !isStr(r.key) ? 'bad setting'
      : r.key === 'sites' && !(Array.isArray(r.value) && r.value.every((x: Rec) => x && typeof x.name === 'string' && typeof x.url === 'string' && cleanUrl(x.url.replaceAll('{q}', 'title')))) ? 'bad search sites'
      : ['partner', 'lastBackupAt', 'showsSyncedAt', 'filmsSyncedAt'].includes(r.key) && typeof r.value !== 'string' ? `bad ${r.key}`
      : r.key === 'shown' && !strs(r.value) ? 'bad shown list'
      : null,
  },
  dismissed: { key: 'qid', clean: (r) => ({ ...r, critics: scores(r.critics) }), check: (r) => (!META.qid(r.qid) || !optDate(r.at) || !optDate(r.scoresAt) || !optStr(r.name) || !optBool(r.measured) || (r.kind !== undefined && r.kind !== 'film' && r.kind !== 'show') ? 'bad dismissed item' : null) },
  removed: { key: 'key', check: (r) => (!isStr(r.key) || !/^(title|seen|link|watch|dismissed):./.test(r.key) || !isDate(r.at) ? 'bad removal record' : null) },
};
/** Sections added after the first backups were made: an older file does not have them. */
const LATER: StoreName[] = ['removed'];

export type Parsed = { ok: true; backup: Backup; counts: Record<StoreName, number>; problems: string[] } | { ok: false; error: string };

/**
 * Check everything before anything is written. A file with a section missing is not a full backup at all.
 * A single unreadable record does not cost you the rest: it is left out and listed, the file can be merged,
 * but it cannot replace everything.
 */
export function parseBackup(text: string): Parsed {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, error: 'This file is not valid JSON.' };
  }
  const d = doc as Partial<Backup>;
  if (!d || typeof d !== 'object' || d.app !== 'parde' || !d.data || typeof d.data !== 'object') {
    return { ok: false, error: 'This is not a Parde backup.' };
  }
  if (!Number.isInteger(d.schemaVersion) || d.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, error: Number(d.schemaVersion) > SCHEMA_VERSION ? 'This backup is from a newer version of Parde. Update the app first.' : 'This backup uses an unsupported Parde format.' };
  }
  const counts = {} as Record<StoreName, number>;
  const data = {} as Record<StoreName, unknown[]>;
  const problems: string[] = [];
  for (const s of STORES) {
    const rows = (d.data as Record<string, unknown>)[s] === undefined && LATER.includes(s) ? [] : d.data[s];
    if (!Array.isArray(rows)) return { ok: false, error: `This backup is incomplete: its ${s} section is ${rows === undefined ? 'missing' : 'damaged'}.` };
    const { key, check, clean } = CHECKS[s];
    const ids = new Set<unknown>();
    const out: Rec[] = [];
    for (const [i, row] of rows.entries()) {
      const r = row as Rec;
      if (!r || typeof r !== 'object' || Array.isArray(r)) {
        problems.push(`${s} #${i + 1} is not a record`);
        continue;
      }
      if (s === 'settings' && r.key === UNDO_KEY) continue; // this device's own undo copy never travels
      const problem = check(r) ?? (ids.has(r[key]) ? 'listed twice' : null);
      if (problem) {
        problems.push(`${s} #${i + 1}${isStr(r.name) ? ` (${r.name})` : ''}: ${problem}`);
        continue;
      }
      ids.add(r[key]);
      const safe = clean ? clean(r) : r;
      if (s === 'titles' || s === 'dismissed') {
        const changed = Object.keys(r).filter((k) => JSON.stringify(r[k]) !== JSON.stringify(safe[k]));
        if (changed.length) problems.push(`${s} #${i + 1}${isStr(r.name) ? ` (${r.name})` : ''}: invalid ${changed.join(', ')} cleaned`);
      }
      out.push(safe);
    }
    data[s] = out;
    counts[s] = out.length;
  }
  // Episodes belong to a series. A record whose title is not in the file is kept: it fits again if the title returns.
  const kinds = new Map((data.titles as Title[]).map((t) => [t.id, t.kind]));
  for (const s of ['episodes', 'seen'] as const) {
    const bad = (data[s] as Seen[]).filter((r) => (kinds.get(r.titleId) ?? (r.titleId.startsWith('tvm:') ? 'show' : 'film')) !== 'show');
    if (!bad.length) continue;
    problems.push(`${s}: ${bad.length} belong to a film`);
    data[s] = data[s].filter((r) => !bad.includes(r as Seen));
  }
  for (const s of STORES) counts[s] = data[s].length;
  const exportedAt = isDate(d.exportedAt) ? d.exportedAt : '';
  return { ok: true, backup: { app: 'parde', schemaVersion: d.schemaVersion, exportedAt, data, damaged: problems.length }, counts, problems };
}

/** What can be put back: the data from before the last restore (or, after an undo, the restored data). */
interface UndoCopy {
  at: string;
  data: Backup['data'];
  /** 'restore': the next step undoes a restore. 'undo': it redoes one. Older copies have no kind. */
  kind?: 'restore' | 'undo';
}

export interface Restored {
  mode: 'merge' | 'replace';
  added: number;
  /** Titles here that took a newer edit (or a missing detail) from the file */
  updated: number;
  marks: number;
  links: number;
  watches: number;
  recovered: number;
  linkEdits: number;
  /** In the file, but removed or unmarked here since it was made */
  leftOut: number;
}


/**
 * One title recorded on two sides. Each thing you set follows its own latest edit, clearing included.
 * Where edit times are unknown (older versions), the more recently edited title wins and the other fills gaps.
 */
export function mergeTitle(here: Title, file: Title): Title {
  const [newer, older] = file.updatedAt > here.updatedAt ? [file, here] : [here, file];
  const looked = (t: Title) => [t.syncedAt, t.enrichedAt].filter(Boolean).sort().at(-1) ?? '';
  const out: Title = { ...(looked(file) > looked(here) ? file : here), updatedAt: newer.updatedAt, addedAt: [here.addedAt, file.addedAt].sort()[0], edited: {} };
  for (const k of Object.keys(META).concat(LISTS, ['people', 'critics'])) {
    const dest = out as unknown as Rec;
    const local = here as unknown as Rec;
    const incoming = file as unknown as Rec;
    if (dest[k] === undefined || (Array.isArray(dest[k]) && !dest[k].length)) {
      if (local[k] !== undefined) dest[k] = local[k];
      if ((dest[k] === undefined || (Array.isArray(dest[k]) && !dest[k].length)) && incoming[k] !== undefined) dest[k] = incoming[k];
    }
  }
  for (const f of USER_FIELDS) {
    const [h, o] = [here.edited?.[f], file.edited?.[f]];
    const from = h || o ? ((h ?? '') >= (o ?? '') ? here : file) : newer;
    for (const k of f === 'expectation' ? ([f, 'expectedAt'] as const) : [f]) {
      const v = h || o ? from[k] : (newer[k] ?? older[k]);
      if (v === undefined) delete out[k];
      else (out as unknown as Rec)[k] = v;
    }
    if (h || o) out.edited![f] = [h, o].filter(Boolean).sort().at(-1);
  }
  // What happened, rather than what you chose: known to one side is known. Scores were seen when they were first seen.
  const choice = [here, file].filter((t) => t.chosenAt).sort((a, b) => a.chosenAt!.localeCompare(b.chosenAt!))[0];
  if (choice) {
    out.chosenAt = choice.chosenAt;
    out.choiceScores = choice.choiceScores;
  }
  out.firstWatchedAt = [here.firstWatchedAt, file.firstWatchedAt].filter(Boolean).sort()[0];
  const e = (here.edited?.expectation ?? '') >= (file.edited?.expectation ?? '') ? here : file;
  if (e.instinctRecorded !== undefined || here.instinctRecorded === false || file.instinctRecorded === false) out.instinctRecorded = e.expectedAt === out.expectedAt && e.instinctRecorded && !(here.instinctRecorded === false && here.expectedAt === out.expectedAt) && !(file.instinctRecorded === false && file.expectedAt === out.expectedAt);
  const saw = [here.scoresAt, file.scoresAt].filter((x) => !!x).sort()[0];
  if (saw) out.scoresAt = saw;
  return out;
}

async function merge(file: Record<StoreName, unknown[]>): Promise<Restored> {
  const r: Restored = { mode: 'merge', added: 0, updated: 0, marks: 0, links: 0, watches: 0, recovered: 0, linkEdits: 0, leftOut: 0 };
  const gone = new Map((await db.removed.toArray()).map((x) => [x.key, x.at]));
  const blocked = (key: string, at = '') => {
    if (!gone.has(key) || gone.get(key)! < at) return false;
    r.leftOut++;
    return true;
  };
  const here = new Map((await db.titles.toArray()).map((t) => [t.id, t]));
  const priorSchedules = new Set((await db.episodes.toArray()).filter((e) => !e.missingSince).map((e) => e.titleId));
  for (const t of file.titles as Title[]) {
    const mine = here.get(t.id);
    if (blocked(`title:${t.id}`, t.addedAt)) continue;
    const next = mine ? mergeTitle(mine, t) : t;
    if (!mine) r.added++;
    else if (JSON.stringify(sorted(next)) !== JSON.stringify(sorted(mine))) r.updated++;
    here.set(next.id, next);
    await db.titles.put(next);
  }

  const fileTitles = new Map((file.titles as Title[]).map((t) => [t.id, t]));
  const keep = (x: { titleId: string }, addedAt = '') => {
    const deleted = gone.get(`title:${x.titleId}`);
    // Keep recoverable orphan rows. A deletion also covers the earlier incarnation's child records.
    return !deleted || !blocked(`title:${x.titleId}`, fileTitles.get(x.titleId)?.addedAt ?? addedAt);
  };
  const eps = new Map((await db.episodes.toArray()).map((e) => [e.id, e]));
  for (const e of file.episodes as Episode[]) {
    if (eps.has(e.id)) {
      if (eps.get(e.id)?.titleId !== e.titleId) r.leftOut++;
      continue;
    }
    if (!keep(e)) continue;
    const row = priorSchedules.has(e.titleId) ? { ...e, missingSince: e.missingSince ?? now() } : e;
    await db.episodes.put(row);
    eps.set(e.id, row);
    r.recovered++;
  }
  const seen = new Set(await db.seen.toCollection().primaryKeys());
  const touched = new Set<string>();
  for (const m of file.seen as Seen[]) {
    if (seen.has(m.episodeId) || blocked(`seen:${m.episodeId}`, m.seenAt) || !keep(m, m.seenAt)) continue;
    if (eps.has(m.episodeId) && eps.get(m.episodeId)?.titleId !== m.titleId) {
      r.leftOut++;
      continue;
    }
    await db.seen.put(m);
    seen.add(m.episodeId);
    touched.add(m.titleId);
    r.marks++;
  }

  const links = new Map((await db.links.toArray()).map((l) => [l.id, l]));
  for (const l of file.links as Link[]) {
    const mine = links.get(l.id);
    if (mine) {
      if (mine.titleId !== l.titleId) r.leftOut++;
      else if ((l.editedAt ?? '') > (mine.editedAt ?? '')) {
        await db.links.put({ ...l, usedAt: [l.usedAt, mine.usedAt].filter(Boolean).sort().at(-1) });
        r.linkEdits++;
      }
      continue;
    }
    if (blocked(`link:${l.id}`, l.addedAt) || !keep(l, l.addedAt)) continue;
    if ([...links.values()].some((x) => x.titleId === l.titleId && x.season === l.season && x.episode === l.episode && x.url === l.url && x.label === l.label && !!x.broken === !!l.broken && !x.failedEpisodes?.length && !l.failedEpisodes?.length)) continue;
    links.set(l.id, l);
    await db.links.put(l);
    r.links++;
  }
  const watches = new Set(await db.watches.toCollection().primaryKeys());
  for (const w of file.watches as Watch[]) {
    if (watches.has(w.id) || blocked(`watch:${w.id}`) || !keep(w)) continue;
    await db.watches.put(w);
    watches.add(w.id);
    r.watches++;
  }
  const dismissed = new Map((await db.dismissed.toArray()).map((d) => [d.qid, d]));
  for (const d of file.dismissed as Dismissed[]) {
    if (blocked(`dismissed:${d.qid}`, d.at) || (dismissed.has(d.qid) && (dismissed.get(d.qid)!.at ?? '') >= (d.at ?? ''))) continue;
    await db.dismissed.put(d);
    dismissed.set(d.qid, d);
    r.recovered++;
  }
  const active = (key: string) => {
    const [kind, ...rest] = key.split(':');
    const id = rest.join(':');
    return kind === 'title' ? here.has(id) : kind === 'seen' ? seen.has(Number(id)) : kind === 'watch' ? watches.has(id) : kind === 'link' ? links.has(id) : dismissed.has(id);
  };
  for (const x of file.removed as Removed[]) {
    if (!active(x.key) && x.at > (gone.get(x.key) ?? '')) {
      await db.removed.put(x);
      r.recovered++;
    }
  }
  const settings = new Set(await db.settings.toCollection().primaryKeys());
  const extraSettings = (file.settings as { key: string; value: unknown }[]).filter((x) => !settings.has(x.key) && x.key !== UNDO_KEY);
  await db.settings.bulkAdd(extraSettings);
  r.recovered += extraSettings.length;

  for (const id of touched) {
    const t = here.get(id);
    if (t?.status === 'want' && !t.edited?.status && [...eps.values()].some((e) => e.titleId === id && !e.missingSince && seen.has(e.id))) await db.titles.update(id, { status: 'watching' });
    await reconcile(id, false);
  }
  return r;
}

const sorted = (t: Title) => Object.fromEntries(Object.entries(t).filter(([k, v]) => v !== undefined && !(k === 'edited' && !Object.keys(v as object).length)).sort(([a], [b]) => a.localeCompare(b)));

/**
 * merge: keeps everything here and adds what the file has (see mergeTitle). replace: this device becomes
 * exactly the file. Either way it is all or nothing, and what was here before is kept aside first, so the
 * restore can be undone.
 */
export async function restore(backup: Backup, mode: 'merge' | 'replace', undoKind: UndoCopy['kind'] | null = 'restore'): Promise<Restored> {
  if (mode === 'replace' && backup.damaged) throw new Error('This file has records that cannot be read, so it cannot replace everything. Merge it instead.');
  return db.transaction('rw', STORES.map((s) => db.table(s)), async () => {
    const before = undoKind ? await snapshot() : undefined;
    let result: Restored;
    if (mode === 'replace') {
      for (const s of STORES) {
        await db.table(s).clear();
        await db.table(s).bulkAdd(backup.data[s] ?? []);
      }
      const n = (s: StoreName) => backup.data[s]?.length ?? 0;
      result = { mode, added: n('titles'), updated: 0, marks: n('seen'), links: n('links'), watches: n('watches'), recovered: 0, linkEdits: 0, leftOut: 0 };
    } else result = await merge(backup.data);
    if (before && undoKind) await db.settings.put({ key: UNDO_KEY, value: { at: now(), data: before, kind: undoKind } satisfies UndoCopy });
    return result;
  });
}

export async function undoInfo(): Promise<{ at: string; kind: 'restore' | 'undo' } | null> {
  const v = (await db.settings.get(UNDO_KEY))?.value as Partial<UndoCopy> | undefined;
  return v?.data && v.at ? { at: v.at, kind: v.kind ?? 'restore' } : null;
}

/**
 * Put back what was here before the last restore. Nothing is thrown away: what is here now (the
 * restore, and anything changed since) is kept aside in turn, so the undo itself can be undone.
 */
export async function undoRestore(): Promise<boolean> {
  return db.transaction('rw', STORES.map((s) => db.table(s)), async () => {
    const v = (await db.settings.get(UNDO_KEY))?.value as Partial<UndoCopy> | undefined;
    if (!v?.data) return false;
    await restore({ app: 'parde', schemaVersion: SCHEMA_VERSION, exportedAt: '', data: v.data }, 'replace', v.kind === 'undo' ? 'restore' : 'undo');
    return true;
  });
}

const fileName = (b: Backup) => `parde-backup-${b.exportedAt.slice(0, 10)}.json`;

/**
 * Hand the file to the person. On phones the share sheet ("Save to Files") is the only reliable
 * way out of an installed web app; elsewhere a normal download.
 * 'blocked': the browser wants the share to start from a fresh tap; call `shareBackup` from one.
 */
export async function saveBackup(backup: Backup): Promise<'saved' | 'cancelled' | 'blocked'> {
  const json = JSON.stringify(backup, null, 1);
  const file = new File([json], fileName(backup), { type: 'application/json' });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    const r = await shareBackup(backup);
    if (r !== 'failed') return r;
  }
  download(backup, json);
  return 'saved';
}

export async function shareBackup(backup: Backup): Promise<'saved' | 'cancelled' | 'blocked' | 'failed'> {
  const file = new File([JSON.stringify(backup, null, 1)], fileName(backup), { type: 'application/json' });
  try {
    await navigator.share({ files: [file] });
    return 'saved';
  } catch (e) {
    const name = (e as Error).name;
    return name === 'AbortError' ? 'cancelled' : name === 'NotAllowedError' ? 'blocked' : 'failed';
  }
}

function download(backup: Backup, json: string) {
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName(backup);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
