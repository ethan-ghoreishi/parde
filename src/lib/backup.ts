import { db, now, STORES, type StoreName, type Title } from './db';
import { cleanUrl } from './links';

export const SCHEMA_VERSION = 1;

export interface Backup {
  app: 'parde';
  schemaVersion: number;
  exportedAt: string;
  data: Record<StoreName, unknown[]>;
}

export async function buildBackup(): Promise<Backup> {
  const data = {} as Record<StoreName, unknown[]>;
  await db.transaction('r', STORES.map((s) => db.table(s)), async () => {
    for (const s of STORES) data[s] = await db.table(s).toArray();
  });
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
  return { ok: true, backup: { app: 'parde', schemaVersion: d.schemaVersion, exportedAt: String(d.exportedAt ?? ''), data }, counts };
}

/**
 * merge: keeps everything here and adds the file's records; where both have the same title,
 * the more recently edited one wins. replace: this device becomes exactly the file.
 */
export async function restore(backup: Backup, mode: 'merge' | 'replace') {
  const tables = STORES.map((s) => db.table(s));
  await db.transaction('rw', tables, async () => {
    if (mode === 'replace') {
      for (const s of STORES) {
        await db.table(s).clear();
        await db.table(s).bulkAdd(backup.data[s]);
      }
      return;
    }
    const incoming = backup.data.titles as Title[];
    const existing = new Map((await db.titles.bulkGet(incoming.map((t) => t.id))).filter(Boolean).map((t) => [t!.id, t!]));
    await db.titles.bulkPut(incoming.filter((t) => !existing.has(t.id) || existing.get(t.id)!.updatedAt <= t.updatedAt));
    // Records already here are kept as they are; only missing ones are added.
    for (const s of ['episodes', 'seen', 'watches', 'links', 'dismissed', 'settings'] as const) {
      const key = CHECKS[s].key;
      const have = new Set(await db.table(s).toCollection().primaryKeys());
      await db.table(s).bulkAdd((backup.data[s] as Record<string, unknown>[]).filter((r) => !have.has(r[key] as never)));
    }
  });
}

export function download(backup: Backup) {
  const blob = new Blob([JSON.stringify(backup, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `parde-backup-${backup.exportedAt.slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
