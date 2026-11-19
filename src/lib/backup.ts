import { db, now, STORES, type Episode, type Seen, type StoreName, type Title } from './db';
import { reconcile } from './actions';
import { cleanUrl } from './links';

export const SCHEMA_VERSION = 1;

export interface Backup {
  app: 'parde';
  schemaVersion: number;
  exportedAt: string;
  data: Record<StoreName, unknown[]>;
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
  enrichedAt: isStr, syncedAt: isStr,
};
const LISTS = ['genres', 'subjects', 'countries', 'languages'];

function cleanTitle(r: Rec): Rec {
  const out: Rec = { ...r };
  for (const [k, ok] of Object.entries(META)) if (out[k] !== undefined && !ok(out[k])) delete out[k];
  for (const k of LISTS) out[k] = strs(out[k]) ? out[k] : [];
  out.people = Array.isArray(out.people)
    ? (out.people as Rec[]).filter((p) => p && isStr(p.name) && ROLES.includes(p.role as string) && (p.qid === undefined || META.qid(p.qid)))
    : [];
  out.critics = Array.isArray(out.critics)
    ? (out.critics as Rec[]).filter((c) => c && isStr(c.source) && isStr(c.value) && isNum(c.score) && c.score >= 0 && c.score <= 100 && optStr(c.asOf))
    : [];
  return out;
}

const CHECKS: Record<StoreName, { key: string; check: Check; clean?: (r: Rec) => Rec }> = {
  titles: {
    key: 'id',
    clean: cleanTitle,
    check: (r) =>
      !isStr(r.id) || !/^(wd:Q\d+|tvm:\d+)$/.test(r.id) ? 'bad title id'
      : r.kind !== (r.id.startsWith('wd:') ? 'film' : 'show') ? 'bad kind'
      : !isStr(r.name) ? 'missing name'
      : !STATUSES.includes(r.status as string) ? 'bad status'
      : !isStr(r.addedAt) || !isStr(r.updatedAt) ? 'missing dates'
      : !optStr(r.finishedAt) || !optStr(r.expectedAt) ? 'bad dates'
      : !optNum(r.rating, 1, 10) || !optNum(r.partnerRating, 1, 10) || !optNum(r.expectation, 1, 5) ? 'rating out of range'
      : r.themes !== undefined && !(Array.isArray(r.themes) && r.themes.every(isStr)) ? 'bad themes'
      : !optStr(r.note) ? 'bad note'
      : !optBool(r.followed) ? 'bad calendar setting'
      : null,
  },
  episodes: {
    key: 'id',
    clean: (r) => ({ ...r, name: typeof r.name === 'string' ? r.name : '', airtime: typeof r.airtime === 'string' ? r.airtime : '' }),
    check: (r) =>
      !isNum(r.id) || !isStr(r.titleId) || !isNum(r.season) || !isNum(r.number) || typeof r.airdate !== 'string' || !optStr(r.airstamp) || !optStr(r.summary) || !optNum(r.runtime, 0, 1e4)
        ? 'bad episode'
        : null,
  },
  seen: { key: 'episodeId', check: (r) => (!isNum(r.episodeId) || !isStr(r.titleId) || !isStr(r.seenAt) ? 'bad seen mark' : null) },
  watches: {
    key: 'id',
    check: (r) => (!isStr(r.id) || !isStr(r.titleId) || !isStr(r.date) || !/^\d{4}-\d{2}-\d{2}/.test(r.date) || typeof r.together !== 'boolean' ? 'bad watch' : null),
  },
  links: {
    key: 'id',
    check: (r) =>
      !isStr(r.id) || !isStr(r.titleId) || !isStr(r.addedAt) ? 'bad link'
      : !isStr(r.url) || cleanUrl(r.url) !== r.url ? 'unsafe or invalid link URL'
      : !optNum(r.season, 0, 1e4) || !optNum(r.episode, 0, 1e5) || (r.episode !== undefined && r.season === undefined) ? 'bad link episode'
      : !optStr(r.label) || !optBool(r.broken) || !optStr(r.usedAt) ? 'bad link details'
      : null,
  },
  settings: {
    key: 'key',
    check: (r) =>
      !isStr(r.key) ? 'bad setting'
      : r.key === 'sites' && !(Array.isArray(r.value) && r.value.every((x: Rec) => x && typeof x.name === 'string' && typeof x.url === 'string')) ? 'bad search sites'
      : ['partner', 'lastBackupAt', 'showsSyncedAt'].includes(r.key) && typeof r.value !== 'string' ? `bad ${r.key}`
      : null,
  },
  dismissed: { key: 'qid', check: (r) => (!isStr(r.qid) ? 'bad dismissed item' : null) },
};

export type Parsed = { ok: true; backup: Backup; counts: Record<StoreName, number> } | { ok: false; error: string };

/** Validate everything before anything is written. One bad record of yours rejects the file. */
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
  if (!isNum(d.schemaVersion) || d.schemaVersion > SCHEMA_VERSION) {
    return { ok: false, error: 'This backup is from a newer version of Parde. Update the app first.' };
  }
  const counts = {} as Record<StoreName, number>;
  const data = {} as Record<StoreName, unknown[]>;
  for (const s of STORES) {
    const rows = (d.data as Record<string, unknown>)[s] ?? [];
    if (!Array.isArray(rows)) return { ok: false, error: `The ${s} section is damaged.` };
    const { key, check, clean } = CHECKS[s];
    const ids = new Set<unknown>();
    const out: Rec[] = [];
    for (const [i, row] of rows.entries()) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return { ok: false, error: `${s} #${i + 1} is not a record.` };
      const problem = check(row as Rec);
      if (problem) return { ok: false, error: `${s} #${i + 1}: ${problem}.` };
      const id = (row as Rec)[key];
      if (ids.has(id)) return { ok: false, error: `${s} has a duplicate entry (${String(id)}).` };
      ids.add(id);
      if (s === 'settings' && id === UNDO_KEY) continue; // this device's own undo copy never travels
      out.push(clean ? clean(row as Rec) : (row as Rec));
    }
    data[s] = out;
    counts[s] = out.length;
  }
  // Records that belong to a title must belong to one in the same file; episodes to a series.
  const kinds = new Map((data.titles as { id: string; kind: string }[]).map((t) => [t.id, t.kind]));
  for (const s of ['episodes', 'seen', 'watches', 'links'] as const) {
    const stray = (data[s] as { titleId: string }[]).find((r) => !kinds.has(r.titleId) || ((s === 'episodes' || s === 'seen') && kinds.get(r.titleId) !== 'show'));
    if (stray) return { ok: false, error: `${s} refers to a title that is not in the file, or is not a series (${stray.titleId}).` };
  }
  return { ok: true, backup: { app: 'parde', schemaVersion: d.schemaVersion, exportedAt: String(d.exportedAt ?? ''), data }, counts };
}

/** What can be put back: the data from before the last restore (or, after an undo, the restored data). */
interface UndoCopy {
  at: string;
  data: Backup['data'];
  /** 'restore': the next step undoes a restore. 'undo': it redoes one. Older copies have no kind. */
  kind?: 'restore' | 'undo';
}

/**
 * merge: keeps everything here and adds the file's records; where both have the same title, the more
 * recently edited one wins. A series already here keeps its own episode list (it is the fresher one);
 * the file's seen marks are matched to it by season and episode number. replace: this device becomes
 * exactly the file. Either way, what was here before is kept aside first so the restore can be undone.
 */
export async function restore(backup: Backup, mode: 'merge' | 'replace', undoKind: UndoCopy['kind'] | null = 'restore') {
  const tables = STORES.map((s) => db.table(s));
  const merged: string[] = [];
  await db.transaction('rw', tables, async () => {
    const before = undoKind ? await snapshot() : undefined;
    if (mode === 'replace') {
      for (const s of STORES) {
        await db.table(s).clear();
        await db.table(s).bulkAdd(backup.data[s]);
      }
    } else {
      const incoming = backup.data.titles as Title[];
      const existing = new Map((await db.titles.bulkGet(incoming.map((t) => t.id))).filter(Boolean).map((t) => [t!.id, t!]));
      await db.titles.bulkPut(incoming.filter((t) => !existing.has(t.id) || existing.get(t.id)!.updatedAt <= t.updatedAt));
      const fileEps = backup.data.episodes as Episode[];
      await db.episodes.bulkPut(fileEps.filter((e) => !existing.has(e.titleId)));
      // The file's marks for a series already here, moved onto this device's episode in the same slot.
      const slot = (e: Pick<Episode, 'season' | 'number'>) => `${e.season}x${e.number}`;
      const fileSlot = new Map(fileEps.map((e) => [e.id, slot(e)]));
      const local = new Map<string, Map<string, number>>();
      for (const id of existing.keys()) {
        if (existing.get(id)!.kind !== 'show') continue;
        merged.push(id);
        local.set(id, new Map((await db.episodes.where('titleId').equals(id).toArray()).map((e) => [slot(e), e.id])));
      }
      const marks = (backup.data.seen as Seen[]).map((m) => {
        const to = local.get(m.titleId)?.get(fileSlot.get(m.episodeId) ?? '');
        return to ? { ...m, episodeId: to } : m;
      });
      const haveSeen = new Set(await db.seen.toCollection().primaryKeys());
      await db.seen.bulkAdd([...new Map(marks.filter((m) => !haveSeen.has(m.episodeId)).map((m) => [m.episodeId, m])).values()]);
      // Everything else: records already here are kept as they are; only missing ones are added.
      for (const s of ['watches', 'links', 'dismissed', 'settings'] as const) {
        const key = CHECKS[s].key;
        const have = new Set(await db.table(s).toCollection().primaryKeys());
        await db.table(s).bulkAdd((backup.data[s] as Rec[]).filter((r) => !have.has(r[key] as never) && r[key] !== UNDO_KEY));
      }
    }
    if (before && undoKind) await db.settings.put({ key: UNDO_KEY, value: { at: now(), data: before, kind: undoKind } satisfies UndoCopy });
  });
  for (const id of merged) await reconcile(id, false);
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
  const v = (await db.settings.get(UNDO_KEY))?.value as Partial<UndoCopy> | undefined;
  if (!v?.data) return false;
  await restore({ app: 'parde', schemaVersion: SCHEMA_VERSION, exportedAt: '', data: v.data }, 'replace', v.kind === 'undo' ? 'restore' : 'undo');
  return true;
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
