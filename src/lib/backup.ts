import { db, now, STORES, type StoreName, type Title } from './db';
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
const arr = (v: unknown) => Array.isArray(v);

type Check = (r: Record<string, unknown>) => string | null;

const CHECKS: Record<StoreName, { key: string; check: Check }> = {
  titles: {
    key: 'id',
    check: (r) =>
      !isStr(r.id) || !/^(wd|tvm):/.test(r.id as string) ? 'bad title id'
      : r.kind !== 'film' && r.kind !== 'show' ? 'bad kind'
      : !isStr(r.name) ? 'missing name'
      : !['want', 'watching', 'watched', 'paused', 'dropped'].includes(r.status as string) ? 'bad status'
      : !isStr(r.addedAt) || !isStr(r.updatedAt) ? 'missing dates'
      : !['genres', 'people', 'subjects', 'countries', 'languages', 'critics'].every((k) => arr(r[k])) ? 'missing lists'
      : !optNum(r.rating, 1, 10) || !optNum(r.partnerRating, 1, 10) || !optNum(r.expectation, 1, 5) ? 'rating out of range'
      : r.themes !== undefined && !(arr(r.themes) && (r.themes as unknown[]).every(isStr)) ? 'bad themes'
      : null,
  },
  episodes: {
    key: 'id',
    check: (r) => (!isNum(r.id) || !isStr(r.titleId) || !isNum(r.season) || !isNum(r.number) || typeof r.airdate !== 'string' ? 'bad episode' : null),
  },
  seen: { key: 'episodeId', check: (r) => (!isNum(r.episodeId) || !isStr(r.titleId) || !isStr(r.seenAt) ? 'bad seen mark' : null) },
  watches: {
    key: 'id',
    check: (r) => (!isStr(r.id) || !isStr(r.titleId) || !isStr(r.date) || typeof r.together !== 'boolean' ? 'bad watch' : null),
  },
  links: {
    key: 'id',
    check: (r) =>
      !isStr(r.id) || !isStr(r.titleId) || !isStr(r.addedAt) ? 'bad link'
      : !isStr(r.url) || cleanUrl(r.url as string) !== r.url ? 'unsafe or invalid link URL'
      : null,
  },
  settings: { key: 'key', check: (r) => (!isStr(r.key) ? 'bad setting' : null) },
  dismissed: { key: 'qid', check: (r) => (!isStr(r.qid) ? 'bad dismissed item' : null) },
};

export type Parsed = { ok: true; backup: Backup; counts: Record<StoreName, number> } | { ok: false; error: string };

/** Validate everything before anything is written. One bad record rejects the file. */
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
    const { key, check } = CHECKS[s];
    const ids = new Set<unknown>();
    for (const [i, row] of rows.entries()) {
      if (!row || typeof row !== 'object') return { ok: false, error: `${s} #${i + 1} is not a record.` };
      const problem = check(row as Record<string, unknown>);
      if (problem) return { ok: false, error: `${s} #${i + 1}: ${problem}.` };
      const id = (row as Record<string, unknown>)[key];
      if (ids.has(id)) return { ok: false, error: `${s} has a duplicate entry (${String(id)}).` };
      ids.add(id);
    }
    data[s] = rows;
    counts[s] = rows.length;
  }
  // Records that belong to a title must belong to one in the same file.
  const titleIds = new Set((data.titles as { id: string }[]).map((t) => t.id));
  for (const s of ['episodes', 'seen', 'watches', 'links'] as const) {
    const stray = (data[s] as { titleId: string }[]).find((r) => !titleIds.has(r.titleId));
    if (stray) return { ok: false, error: `${s} refers to a title that is not in the file (${stray.titleId}).` };
  }
  return { ok: true, backup: { app: 'parde', schemaVersion: d.schemaVersion, exportedAt: String(d.exportedAt ?? ''), data }, counts };
}

/**
 * merge: keeps everything here and adds the file's records; where both have the same title,
 * the more recently edited one wins. replace: this device becomes exactly the file.
 * Either way, what was here before is kept aside first so the restore can be undone.
 */
export async function restore(backup: Backup, mode: 'merge' | 'replace', keepUndo = true) {
  const tables = STORES.map((s) => db.table(s));
  await db.transaction('rw', tables, async () => {
    const before = keepUndo ? await snapshot() : undefined;
    if (mode === 'replace') {
      for (const s of STORES) {
        await db.table(s).clear();
        await db.table(s).bulkAdd(backup.data[s]);
      }
    } else {
      const incoming = backup.data.titles as Title[];
      const existing = new Map((await db.titles.bulkGet(incoming.map((t) => t.id))).filter(Boolean).map((t) => [t!.id, t!]));
      await db.titles.bulkPut(incoming.filter((t) => !existing.has(t.id) || existing.get(t.id)!.updatedAt <= t.updatedAt));
      // Records already here are kept as they are; only missing ones are added.
      for (const s of ['episodes', 'seen', 'watches', 'links', 'dismissed', 'settings'] as const) {
        const key = CHECKS[s].key;
        const have = new Set(await db.table(s).toCollection().primaryKeys());
        await db.table(s).bulkAdd((backup.data[s] as Record<string, unknown>[]).filter((r) => !have.has(r[key] as never) && r[key] !== UNDO_KEY));
      }
    }
    if (before) await db.settings.put({ key: UNDO_KEY, value: { at: now(), data: before } });
  });
}

/** Put back what was here before the last restore. */
export async function undoRestore(): Promise<boolean> {
  const row = await db.settings.get(UNDO_KEY);
  const data = (row?.value as { data?: Backup['data'] } | undefined)?.data;
  if (!data) return false;
  await restore({ app: 'parde', schemaVersion: SCHEMA_VERSION, exportedAt: '', data }, 'replace', false);
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
