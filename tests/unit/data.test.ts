import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, type Episode, type Title } from '../../src/lib/db';
import { buildBackup, parseBackup, restore, undoRestore } from '../../src/lib/backup';
import { setSeen, seenUpTo, moveDomain, addLink, removeTitle, setStatus, setSeasonSeen, setProgress, reconcile, reconcileShows, refreshTitle, seenAllAired } from '../../src/lib/actions';

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

describe('backup integrity', () => {
  const file = (data: Record<string, unknown[]>) => JSON.stringify({ app: 'parde', schemaVersion: 1, exportedAt: '', data });
  it('rejects records that point at a title missing from the file, and malformed themes', () => {
    const orphan = parseBackup(file({ titles: [T('wd:Q1')], seen: [{ episodeId: 1, titleId: 'tvm:9', seenAt: 'x' }] }));
    expect(orphan.ok).toBe(false);
    expect(parseBackup(file({ titles: [T('wd:Q1', { themes: ['memory', 3 as unknown as string] })] })).ok).toBe(false);
    expect(parseBackup(file({ titles: [T('wd:Q1', { themes: ['memory'] })] })).ok).toBe(true);
  });
  it('a replace can be undone, and the undo copy never ends up inside backups', async () => {
    await db.titles.add(T('wd:Q1', { rating: 8 }));
    const p = parseBackup(file({ titles: [T('wd:Q2')] }));
    if (!p.ok) throw new Error(p.error);
    await restore(p.backup, 'replace');
    expect(await db.titles.get('wd:Q1')).toBeUndefined();
    expect((await buildBackup()).data.settings).toEqual([]);
    expect(await undoRestore()).toBe(true);
    expect((await db.titles.get('wd:Q1'))?.rating).toBe(8);
    expect(await db.titles.get('wd:Q2')).toBeUndefined();
    expect(await undoRestore()).toBe(false); // one step only
  });
});

describe('series progress', () => {
  const FUTURE = '2999-01-01';
  beforeEach(async () => {
    await db.titles.add(T('tvm:1', { kind: 'show', showStatus: 'Running', followed: true }));
    await db.episodes.bulkAdd([E(1, 1), E(2, 2), E(3, 1, { season: 2 }), E(4, 2, { season: 2, airdate: FUTURE })]);
  });
  const status = async () => (await db.titles.get('tvm:1'))?.status;
  const seenIds = async () => (await db.seen.toCollection().primaryKeys()).sort();

  it('bulk marks never touch episodes that are not out yet', async () => {
    await setSeasonSeen('tvm:1', 2, true);
    expect(await seenIds()).toEqual([3]);
    await seenAllAired('tvm:1');
    expect(await seenIds()).toEqual([1, 2, 3]);
    expect(await status()).toBe('watching'); // caught up on a running show
  });
  it('"Finished" marks what is out, and a new episode airing reopens the show', async () => {
    await setStatus((await db.titles.get('tvm:1'))!, 'watched');
    expect(await seenIds()).toEqual([1, 2, 3]);
    await reconcile('tvm:1', false);
    expect(await status()).toBe('watched');
    await db.episodes.update(4, { airdate: '2020-02-01' }); // the next episode is now out
    await reconcile('tvm:1', false);
    expect(await status()).toBe('watching');
  });
  it('a background refresh never un-pauses a show; marking an episode does', async () => {
    await setSeen(E(1, 1), true);
    await db.titles.update('tvm:1', { status: 'paused' });
    await reconcile('tvm:1', false);
    expect(await status()).toBe('paused');
    await setSeen(E(2, 2), true);
    expect(await status()).toBe('watching');
  });
  it('"up to here" sets the exact position, and can be undone', async () => {
    await setSeen(E(3, 1, { season: 2 }), true);
    const undo = await setProgress('tvm:1', E(2, 2));
    expect(await seenIds()).toEqual([1, 2]);
    expect(await status()).toBe('watching');
    await undo();
    expect(await seenIds()).toEqual([3]);
    await setProgress('tvm:1', null);
    expect(await seenIds()).toEqual([]);
    expect(await status()).toBe('watching'); // "we are starting it" stays in progress
  });
  it('"up to here" keeps the dates of marks you already had', async () => {
    await db.seen.put({ episodeId: 1, titleId: 'tvm:1', seenAt: '2021-05-05T00:00:00Z' });
    await setProgress('tvm:1', E(3, 1, { season: 2 }));
    expect((await db.seen.get(1))?.seenAt).toBe('2021-05-05T00:00:00Z');
    expect(await seenIds()).toEqual([1, 2, 3]);
  });
  it('a background refresh never touches a dropped show, and only reopens a finished one still on the calendar', async () => {
    await setStatus((await db.titles.get('tvm:1'))!, 'watched');
    await db.titles.update('tvm:1', { followed: false });
    await db.episodes.update(4, { airdate: '2020-02-01' });
    await reconcile('tvm:1', false);
    expect(await status()).toBe('watched'); // you took it off the calendar: a new season does not pull it back
    await reconcileShows();
    expect(await status()).toBe('watched');
    await db.titles.update('tvm:1', { followed: true });
    await reconcileShows(); // no network: the episode simply came out
    expect(await status()).toBe('watching');
    await db.titles.update('tvm:1', { status: 'dropped', showStatus: 'Ended' });
    await setSeasonSeen('tvm:1', 2, true);
    await reconcile('tvm:1', false);
    expect(await status()).toBe('dropped');
  });
});

describe('skipped episodes', () => {
  beforeEach(async () => {
    await db.titles.add(T('tvm:1', { kind: 'show', showStatus: 'Ended', followed: true, status: 'watching' }));
    await db.episodes.bulkAdd([E(1, 1), E(2, 2), E(3, 3), E(4, 4)]);
  });
  it('an unmarked episode in the middle neither holds the show back nor stops it finishing', async () => {
    await db.seen.bulkPut([1, 3].map((episodeId) => ({ episodeId, titleId: 'tvm:1', seenAt: 'x' })));
    const { progress } = await import('../../src/lib/schedule');
    const p = progress(await db.episodes.toArray(), new Set([1, 3]));
    expect(p.next?.id).toBe(4);
    expect(p.skipped).toBe(1);
    expect(p.unseenAired).toBe(1);
    await setSeen(E(4, 4), true);
    const t = await db.titles.get('tvm:1');
    expect(t?.status).toBe('watched');
    expect(t?.followed).toBe(false);
  });
});

describe('episode refresh', () => {
  it('carries a seen mark across when TVmaze re-creates an episode under a new id', async () => {
    await db.titles.add(T('tvm:7', { kind: 'show', tvmaze: 7, status: 'watching', enrichedAt: new Date().toISOString() }));
    await db.episodes.bulkAdd([E(70, 1, { titleId: 'tvm:7' }), E(71, 2, { titleId: 'tvm:7' })]);
    await setSeen(E(70, 1, { titleId: 'tvm:7' }), true);
    const ep = (id: number, number: number) => ({ id, name: `E${number}`, season: 1, number, airdate: '2020-01-01', airtime: '', airstamp: null, runtime: 30, summary: null });
    const show = { id: 7, name: 'Show', genres: [], status: 'Running', premiered: '2020-01-01', averageRuntime: 30, runtime: 30, rating: { average: null }, network: null, webChannel: null, externals: { imdb: null }, image: null, summary: null, updated: 2, _embedded: { episodes: [ep(80, 1), ep(71, 2)] } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(show))));
    try {
      await refreshTitle((await db.titles.get('tvm:7'))!);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(await db.episodes.get(70)).toBeUndefined();
    expect(await db.seen.get(80)).toMatchObject({ titleId: 'tvm:7' });
    expect(await db.seen.get(70)).toBeUndefined(); // no orphan left behind
  });

  const show = (eps: unknown[] | undefined, imdb: string | null = null) => ({
    id: 7, name: 'Show', genres: [], status: 'Running', premiered: '2020-01-01', averageRuntime: 30, runtime: 30, rating: { average: null },
    network: null, webChannel: null, externals: { imdb }, image: null, summary: null, updated: 2, ...(eps ? { _embedded: { episodes: eps } } : {}),
  });
  const refreshWith = async (body: unknown, deep = false) => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => (String(u).includes('tvmaze') ? new Response(JSON.stringify(body)) : new Response('busy', { status: 503 }))));
    try {
      await refreshTitle((await db.titles.get('tvm:7'))!, deep);
    } finally {
      vi.unstubAllGlobals();
    }
  };
  it('an empty or missing episode list from TVmaze keeps the episodes and marks you have', async () => {
    await db.titles.add(T('tvm:7', { kind: 'show', tvmaze: 7, status: 'watching', enrichedAt: new Date().toISOString() }));
    await db.episodes.bulkAdd([E(70, 1, { titleId: 'tvm:7' }), E(71, 2, { titleId: 'tvm:7' })]);
    await setSeen(E(70, 1, { titleId: 'tvm:7' }), true);
    await refreshWith(show([]));
    await refreshWith(show(undefined));
    expect(await db.episodes.where('titleId').equals('tvm:7').count()).toBe(2);
    expect(await db.seen.get(70)).toBeTruthy();
  });
  it('a failed Wikidata lookup keeps the people, subjects and scores found before', async () => {
    const people = [{ name: 'Dan Erickson', role: 'creator' as const, qid: 'Q1' }];
    const critics = [{ source: 'Rotten Tomatoes', value: '97%', score: 97 }];
    await db.titles.add(T('tvm:7', { kind: 'show', tvmaze: 7, qid: 'Q9', status: 'watching', people, subjects: ['work'], critics, enrichedAt: '2000-01-01T00:00:00Z' }));
    await db.episodes.add(E(70, 1, { titleId: 'tvm:7' }));
    await refreshWith(show([{ id: 70, name: 'E1', season: 1, number: 1, airdate: '2020-01-01', airtime: '', airstamp: null, runtime: 30, summary: null }], 'tt1'), true);
    const t = await db.titles.get('tvm:7');
    expect(t?.people).toEqual(people);
    expect(t?.subjects).toEqual(['work']);
    expect(t?.critics).toEqual(critics);
    expect(t?.enrichedAt).toBe('2000-01-01T00:00:00Z'); // retried next time
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

import { syncShows } from '../../src/lib/actions';
describe('show sync', () => {
  it('records a failed sync so tab focus does not refetch everything, and never throws', async () => {
    await db.titles.add(T('tvm:1', { kind: 'show', tvmaze: 1, followed: true, status: 'watching' }));
    const fetchMock = vi.fn(async () => new Response('down', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect(await syncShows()).toEqual({ refreshed: 0, failed: 1 });
      const calls = fetchMock.mock.calls.length;
      expect(await syncShows()).toEqual({ refreshed: 0, failed: 0 });
      expect(fetchMock.mock.calls.length).toBe(calls);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
