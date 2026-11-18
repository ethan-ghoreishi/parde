import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, type Episode, type Title } from '../../src/lib/db';
import { buildBackup, parseBackup, restore } from '../../src/lib/backup';
import { setSeen, seenUpTo, moveDomain, addLink, removeTitle, setStatus } from '../../src/lib/actions';

const T = (id: string, o: Partial<Title> = {}): Title => ({
  id, kind: 'film', name: id, genres: [], people: [], subjects: [], countries: [], languages: [], critics: [],
  status: 'want', addedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...o,
});
const E = (id: number, number: number, o: Partial<Episode> = {}): Episode => ({ id, titleId: 'tvm:1', season: 1, number, name: `E${number}`, airdate: '2020-01-01', airtime: '', ...o });

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('backup', () => {
  it('round-trips everything', async () => {
    await db.titles.add(T('wd:Q1', { rating: 8 }));
    await addLink('wd:Q1', 'https://a.org/x');
    const b = await buildBackup();
    const parsed = parseBackup(JSON.stringify(b));
    expect(parsed.ok).toBe(true);
    await Promise.all(db.tables.map((t) => t.clear()));
    if (parsed.ok) await restore(parsed.backup, 'replace');
    expect((await db.titles.get('wd:Q1'))?.rating).toBe(8);
    expect(await db.links.count()).toBe(1);
  });

  it.each([
    ['{', 'not valid JSON'],
    ['{"app":"other","data":{}}', 'not a Parde backup'],
    ['{"app":"parde","schemaVersion":99,"data":{}}', 'newer version'],
  ])('rejects %s', (text, msg) => {
    const r = parseBackup(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(msg);
  });

  it('rejects duplicates, bad ratings and unsafe links before writing anything', () => {
    const base = { app: 'parde', schemaVersion: 1, exportedAt: '', data: {} as Record<string, unknown[]> };
    const dup = { ...base, data: { titles: [T('wd:Q1'), T('wd:Q1')] } };
    expect(parseBackup(JSON.stringify(dup)).ok).toBe(false);
    const rating = { ...base, data: { titles: [T('wd:Q1', { rating: 11 })] } };
    expect(parseBackup(JSON.stringify(rating)).ok).toBe(false);
    const js = { ...base, data: { links: [{ id: 'l', titleId: 'wd:Q1', url: 'javascript:alert(1)', addedAt: 'x' }] } };
    const r = parseBackup(JSON.stringify(js));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unsafe/);
  });

  it('merge keeps local data and lets the newer title edit win', async () => {
    await db.titles.bulkAdd([T('wd:Q1', { rating: 5, updatedAt: '2026-03-01' }), T('wd:Q2', { rating: 7, updatedAt: '2026-01-01' })]);
    await db.links.add({ id: 'local', titleId: 'wd:Q1', url: 'https://a.org/', addedAt: 'x', broken: true });
    const file = {
      app: 'parde', schemaVersion: 1, exportedAt: '',
      data: {
        titles: [T('wd:Q1', { rating: 9, updatedAt: '2026-02-01' }), T('wd:Q2', { rating: 3, updatedAt: '2026-02-01' }), T('wd:Q3')],
        links: [{ id: 'local', titleId: 'wd:Q1', url: 'https://a.org/', addedAt: 'x' }],
      },
    };
    const p = parseBackup(JSON.stringify(file));
    if (!p.ok) throw new Error(p.error);
    await restore(p.backup, 'merge');
    expect((await db.titles.get('wd:Q1'))?.rating).toBe(5); // local newer
    expect((await db.titles.get('wd:Q2'))?.rating).toBe(3); // file newer
    expect(await db.titles.get('wd:Q3')).toBeTruthy();
    expect((await db.links.get('local'))?.broken).toBe(true); // existing record untouched
  });
});

describe('episodes', () => {
  beforeEach(async () => {
    await db.titles.add(T('tvm:1', { kind: 'show', showStatus: 'Ended', followed: true }));
    await db.episodes.bulkAdd([E(1, 1), E(2, 2), E(3, 3)]);
  });
  it('starting a show moves it to watching; finishing an ended one marks it watched', async () => {
    await setSeen(E(1, 1), true);
    expect((await db.titles.get('tvm:1'))?.status).toBe('watching');
    await seenUpTo(E(3, 3));
    const t = await db.titles.get('tvm:1');
    expect(t?.status).toBe('watched');
    expect(t?.followed).toBe(false);
    expect(await db.seen.count()).toBe(3);
  });
  it('removing a title removes all its records', async () => {
    await setSeen(E(1, 1), true);
    await addLink('tvm:1', 'https://a.org/{s}/{e}');
    await removeTitle('tvm:1');
    expect(await db.episodes.count()).toBe(0);
    expect(await db.seen.count()).toBe(0);
    expect(await db.links.count()).toBe(0);
  });
  it('dropping a show takes it off the calendar', async () => {
    await setStatus((await db.titles.get('tvm:1'))!, 'dropped');
    expect((await db.titles.get('tvm:1'))?.followed).toBe(false);
  });
});

describe('links', () => {
  it('refuses unsafe URLs', async () => {
    await expect(addLink('wd:Q1', 'javascript:alert(1)')).rejects.toThrow();
  });
  it('moves a domain across all links and clears broken marks', async () => {
    await addLink('wd:Q1', 'https://old.to/a');
    const l = await addLink('wd:Q2', 'https://www.old.to/{s}/{e}');
    await db.links.update(l.id, { broken: true });
    await addLink('wd:Q3', 'https://other.to/a');
    expect(await moveDomain('old.to', 'https://new.se/')).toBe(2);
    const urls = (await db.links.toArray()).map((x) => x.url).sort();
    expect(urls).toEqual(['https://new.se/a', 'https://other.to/a', 'https://www.new.se/{s}/{e}']);
    expect((await db.links.get(l.id))?.broken).toBe(false);
    await expect(moveDomain('old.to', 'not a domain')).rejects.toThrow();
  });
});
