import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { db, PardeDB, type Episode, type Title } from '../../src/lib/db';
import { buildBackup, parseBackup, restore, undoRestore } from '../../src/lib/backup';
import { addFilm, addLink, deleteWatch, logWatch, reconcile, dismissTitle, refreshFilms, refreshTitle, removeTitle, saveFilmMeta, seenAllAired, storeShow, setExpectation, setProgress, setSeasonSeen, setSeen, setStatus, syncShows, update } from '../../src/lib/actions';
import { completeSchedule, progress } from '../../src/lib/schedule';

const T = (id: string, o: Partial<Title> = {}): Title => ({
  id, kind: 'film', name: id, genres: [], people: [], subjects: [], countries: [], languages: [], critics: [],
  status: 'want', addedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...o,
});
const show = (o: Partial<Title> = {}) => T('tvm:7', { kind: 'show', tvmaze: 7, status: 'watching', followed: true, enrichedAt: new Date().toISOString(), ...o });
const E = (id: number, number: number, o: Partial<Episode> = {}): Episode => ({ id, titleId: 'tvm:7', season: 1, number, name: `E${number}`, airdate: '2020-01-01', airtime: '', ...o });
const raw = (id: number, number: number, o: object = {}) => ({ id, name: `E${number}`, season: 1, number, airdate: '2020-01-01', airtime: '', airstamp: null, runtime: 30, summary: null, ...o });
const reply = (eps: unknown[], o: object = {}) => ({
  id: 7, name: 'Show', genres: [], status: 'Running', premiered: '2020-01-01', averageRuntime: 30, runtime: 30, rating: { average: null },
  network: null, webChannel: null, externals: { imdb: null }, image: null, summary: null, updated: 2, _embedded: { episodes: eps }, ...o,
});
const refreshWith = async (body: unknown) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));
  await refreshTitle((await db.titles.get('tvm:7'))!);
};
const get = async (id = 'tvm:7') => (await db.titles.get(id))!;
const file = (data: Record<string, unknown[]>) =>
  JSON.stringify({ app: 'parde', schemaVersion: 1, exportedAt: '2026-05-01T00:00:00Z', data: { titles: [], episodes: [], seen: [], watches: [], links: [], settings: [], dismissed: [], ...data } });
const parsed = (data: Record<string, unknown[]>) => {
  const p = parseBackup(file(data));
  if (!p.ok) throw new Error(p.error);
  return p;
};

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});
afterEach(() => vi.unstubAllGlobals());

describe('an uncertain reply from TVmaze destroys nothing', () => {
  beforeEach(async () => {
    await db.titles.add(show());
    await db.episodes.bulkAdd([E(1, 1), E(2, 2), E(3, 3), E(4, 4)]);
  });
  it('a partial list keeps every episode and mark, and does not finish an ended show', async () => {
    await setSeen(E(1, 1), true);
    await setSeen(E(2, 2), true);
    await refreshWith(reply([raw(1, 1), raw(2, 2)], { status: 'Ended' }));
    expect(await db.episodes.count()).toBe(4);
    expect(await get()).toMatchObject({ status: 'watching', followed: true });
    await refreshWith(reply([raw(1, 1), raw(2, 2), raw(3, 3), raw(4, 4)], { status: 'Ended' }));
    const p = progress(await db.episodes.toArray(), new Set([1, 2]));
    expect(p.next?.id).toBe(3); // listed again: back where you were
  });
  it('does not finish a newly added series with only a prefix of the schedule', async () => {
    await db.titles.clear();
    await db.episodes.clear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(reply([raw(1, 1)], { status: 'Ended', ended: '2020-02-01' })))));
    const result = await storeShow(7, { status: 'watching' }, 'all');
    expect(result.added).toBe(true);
    expect((await get()).status).toBe('watching');
    expect(await db.seen.toCollection().primaryKeys()).toEqual([1]);
  });

  it('uses regular season counts when an extra special carries the provider end date', async () => {
    await db.titles.clear();
    await db.episodes.clear();
    const body = reply([raw(1, 1), raw(2, 2)], {
      status: 'Ended', ended: '2022-02-01',
      _embedded: { episodes: [raw(1, 1), raw(2, 2)], seasons: [{ number: 1, episodeOrder: 2 }] },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));
    await storeShow(7, { status: 'watching' }, 'all');
    expect((await get()).status).toBe('watched');
  });

  it('a failed episode write rolls back the new title and preserves its dismissal', async () => {
    await db.titles.clear();
    await db.episodes.clear();
    await dismissTitle({ qid: 'Q7', at: '2026-01-01' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(reply([raw(1, 1)])))));
    const reject = () => { throw new Error('cannot save episode marks'); };
    db.seen.hook('creating', reject);
    try {
      await expect(storeShow(7, { status: 'watching', qid: 'Q7' }, 'all')).rejects.toThrow('cannot save episode marks');
      expect(await db.titles.count()).toBe(0);
      expect(await db.episodes.count()).toBe(0);
      expect(await db.dismissed.get('Q7')).toBeTruthy();
    } finally {
      db.seen.hook('creating').unsubscribe(reject);
    }
  });

  it('blocks future and stale selections without losing valid marks', async () => {
    const future = E(5, 5, { airdate: '2999-01-01' });
    await db.episodes.add(future);
    await setSeen(E(1, 1), true);
    await expect(setSeen(future, true)).rejects.toThrow(/not out yet/);
    await expect(setProgress('tvm:7', future)).rejects.toThrow(/not out yet/);
    expect(await db.seen.toCollection().primaryKeys()).toEqual([1]);
  });
  it('an episode that vanished is set aside, never "up next"; one you saw still counts', async () => {
    await setSeen(E(1, 1), true);
    await refreshWith(reply([raw(1, 1), raw(3, 3), raw(4, 4)]));
    expect(progress(await db.episodes.toArray(), new Set([1])).next?.id).toBe(3);
    await setSeen(E(3, 3), true);
    await refreshWith(reply([raw(1, 1), raw(4, 4)]));
    expect(progress(await db.episodes.toArray(), new Set([1, 3])).lastSeen?.id).toBe(3);
  });
  it('a mark stays on the original ID when an episode is renumbered', async () => {
    await setSeen(E(1, 1), true);
    await refreshWith(reply([raw(2, 1), raw(3, 2), raw(4, 3)])); // 1 removed, the rest shifted down
    expect(await db.seen.get(2)).toBeUndefined();
    expect(await db.seen.get(1)).toBeTruthy();
  });
  it('empty details in a reply never wipe good ones', async () => {
    await db.titles.update('tvm:7', { genres: ['Drama'], people: [{ name: 'A', role: 'cast' }] });
    await refreshWith(reply([raw(1, 1), raw(2, 2), raw(3, 3), raw(4, 4)]));
    expect(await get()).toMatchObject({ genres: ['Drama'], people: [{ name: 'A' }] });
  });
});

describe('what you decided stays decided', () => {
  beforeEach(async () => {
    await db.titles.add(show({ showStatus: 'Ended', endedOn: '2020-01-01' }));
    await db.episodes.bulkAdd([E(1, 1), E(2, 2)]);
    await seenAllAired('tvm:7');
  });
  it('a background refresh does not turn a chosen rewatch back into finished', async () => {
    for (const s of ['want', 'watching'] as const) {
      await setStatus(await get(), s);
      await reconcile('tvm:7', false);
      expect((await get()).status).toBe(s);
    }
  });
  it('a returning series reopens after earlier versions took it off the calendar', async () => {
    await db.titles.update('tvm:7', { followed: false, edited: undefined }); // as earlier versions left it
    await refreshWith(reply([raw(1, 1), raw(2, 2), raw(3, 1, { season: 2 })], { status: 'Running' }));
    expect(await get()).toMatchObject({ status: 'watching', followed: true });
  });
  it('a finished, ended series is still checked when TVmaze says it changed', async () => {
    await db.titles.update('tvm:7', { tvmUpdated: 1 });
    await db.settings.put({ key: 'showsSyncedAt', value: new Date(Date.now() - 7 * 3600e3).toISOString() });
    const fetch = vi.fn(async (u: string) => new Response(JSON.stringify(u.includes('/updates/') ? { 7: 99 } : reply([raw(1, 1), raw(2, 2), raw(3, 1, { season: 2 })]))));
    vi.stubGlobal('fetch', fetch);
    await syncShows();
    expect((await get()).status).toBe('watching');
  });
  it('dropping and picking up again keeps the calendar choice', async () => {
    await setStatus(await get(), 'dropped');
    await setStatus(await get(), 'watching');
    expect((await get()).followed).toBe(true);
    await update('tvm:7', { followed: false });
    await setStatus(await get(), 'dropped');
    await setStatus(await get(), 'watching');
    expect((await get()).followed).toBe(false);
  });
});

describe('dates are only what was really recorded', () => {
  it('marking a whole series seen invents no finish date; watching the last episode records one', async () => {
    await db.titles.add(show({ showStatus: 'Ended', endedOn: '2020-01-01' }));
    await db.episodes.bulkAdd([E(1, 1), E(2, 2)]);
    await seenAllAired('tvm:7');
    expect(await get()).toMatchObject({ status: 'watched' });
    expect((await get()).finishedAt).toBeUndefined();
    await setProgress('tvm:7', E(1, 1));
    await setSeen(E(2, 2), true);
    expect((await get()).finishedAt).toBeTruthy();
  });
  it('"Watched" on a film says nothing about when', async () => {
    await db.titles.add(T('wd:Q1'));
    await setStatus(await get('wd:Q1'), 'watched');
    expect((await get('wd:Q1')).finishedAt).toBeUndefined();
  });
  it('deleting the only viewing takes its date away too', async () => {
    await db.titles.add(T('wd:Q1'));
    await logWatch(await get('wd:Q1'), { date: '2026-02-02', together: false, rating: 8 });
    await logWatch(await get('wd:Q1'), { date: '2026-03-03', together: false, rating: 8 });
    const latest = (await db.watches.toArray()).find((w) => w.date === '2026-03-03')!;
    await deleteWatch(latest.id);
    expect((await get('wd:Q1')).finishedAt).toBe('2026-02-02');
  });
});

describe('undo puts back exactly what it changed', () => {
  beforeEach(async () => {
    await db.titles.add(show({ showStatus: 'Ended', status: 'paused' }));
    await db.episodes.bulkAdd([E(1, 1), E(2, 2), E(3, 3)]);
    await db.seen.put({ episodeId: 1, titleId: 'tvm:7', seenAt: '2021-01-01T00:00:00Z' });
  });
  const ids = async () => (await db.seen.toCollection().primaryKeys()).sort();
  it.each([
    ['one episode', () => setSeen(E(2, 2), true)],
    ['everything out', () => seenAllAired('tvm:7')],
    ['a season', () => setSeasonSeen('tvm:7', 1, true)],
    ['unmarking a season', () => setSeasonSeen('tvm:7', 1, false)],
    ['finished', async () => setStatus(await get(), 'watched')],
  ])('%s', async (_, act) => {
    const before = await get();
    const undo = (await act()) as unknown as () => Promise<void>;
    await undo();
    expect(await ids()).toEqual([1]);
    expect((await db.seen.get(1))?.seenAt).toBe('2021-01-01T00:00:00Z');
    const after = await get();
    for (const k of ['status', 'followed', 'finishedAt'] as const) expect(after[k]).toEqual(before[k]);
  });
  it('leaves alone what you did in between, and a title you have since removed', async () => {
    const undo = (await setSeen(E(2, 2), true)) as unknown as () => Promise<void>;
    await setSeen(E(3, 3), true);
    await update('tvm:7', { status: 'dropped' });
    await undo();
    expect(await ids()).toEqual([1, 3]);
    expect((await get()).status).toBe('dropped');
    const undo2 = (await setSeen(E(2, 2), true)) as unknown as () => Promise<void>;
    await removeTitle('tvm:7');
    await undo2();
    expect(await db.seen.count()).toBe(0);
  });
});

describe('backups', () => {
  it('a file with missing sections is not a full backup', () => {
    expect(parseBackup('{"app":"parde","schemaVersion":1,"exportedAt":"","data":{}}').ok).toBe(false);
    expect(parseBackup(file({})).ok).toBe(true);
  });
  it('a stray record never makes your own backup unrestorable', async () => {
    await db.titles.add(T('wd:Q1'));
    await db.watches.add({ id: 'w', titleId: 'wd:GONE', date: '2026-01-01', together: true });
    const p = parseBackup(JSON.stringify(await buildBackup()));
    expect(p.ok).toBe(true);
    if (p.ok) await restore(p.backup, 'replace');
    expect(await db.titles.count()).toBe(1);
  });
  it('a damaged record can be merged around, but never replaces everything', async () => {
    await db.titles.add(T('wd:Q9', { rating: 8 }));
    const p = parsed({ titles: [T('wd:Q1'), { ...T('wd:Q2'), rating: 99 }] });
    expect(p.problems).toHaveLength(1);
    await expect(restore(p.backup, 'replace')).rejects.toThrow();
    expect(await db.titles.count()).toBe(1);
    await restore(p.backup, 'merge');
    expect((await db.titles.toCollection().primaryKeys()).sort()).toEqual(['wd:Q1', 'wd:Q9']);
  });
  it('impossible dates are damage, not data', () => {
    expect(parsed({ titles: [T('wd:Q1', { updatedAt: 'zzzz' })] }).problems).toHaveLength(1);
    expect(parsed({ titles: [T('wd:Q1')], watches: [{ id: 'w', titleId: 'wd:Q1', date: '2024-99-99', together: true }] }).problems).toHaveLength(1);
  });
  it('merge keeps the newest edit of each thing, and never loses the other side', async () => {
    await db.titles.add(T('wd:Q1', { updatedAt: '2026-01-01T00:00:00Z', status: 'watched', rating: 9, note: 'mine' }));
    await restore(parsed({ titles: [T('wd:Q1', { updatedAt: '2026-02-01T00:00:00Z', status: 'watched', themes: ['time'] })] }).backup, 'merge');
    expect(await get('wd:Q1')).toMatchObject({ rating: 9, note: 'mine', themes: ['time'] });
  });
  it('merge respects a rating you cleared, a title you removed and an episode you unmarked', async () => {
    await db.titles.bulkAdd([T('wd:Q1', { rating: 9 }), T('wd:Q2'), show()]);
    await db.episodes.bulkAdd([E(1, 1), E(2, 2)]);
    await setSeen(E(1, 1), true);
    await setSeen(E(2, 2), true);
    const old = parseBackup(JSON.stringify(await buildBackup()));
    if (!old.ok) throw new Error();
    await update('wd:Q1', { rating: undefined });
    await removeTitle('wd:Q2');
    await setSeen(E(2, 2), false);
    await restore(old.backup, 'merge');
    expect((await get('wd:Q1')).rating).toBeUndefined();
    expect(await db.titles.get('wd:Q2')).toBeUndefined();
    expect(await db.seen.toCollection().primaryKeys()).toEqual([1]);
  });
  it('a newer choice of status elsewhere does not lose the date it was watched, or that scores were seen', async () => {
    await db.titles.add(T('wd:Q1', { status: 'watched', finishedAt: '2026-02-02', scoresAt: '2026-01-05T00:00:00Z', updatedAt: '2026-02-02T00:00:00Z', edited: { status: '2026-02-02T00:00:00Z' } }));
    await restore(parsed({ titles: [T('wd:Q1', { status: 'watched', chosenAt: '2026-01-01T00:00:00Z', scoresAt: '2026-01-09T00:00:00Z', updatedAt: '2026-03-03T00:00:00Z', edited: { status: '2026-03-03T00:00:00Z' } })] }).backup, 'merge');
    expect(await get('wd:Q1')).toMatchObject({ finishedAt: '2026-02-02', chosenAt: '2026-01-01T00:00:00Z', scoresAt: '2026-01-05T00:00:00Z' });
  });
  it('an expectation you cleared takes its date with it', async () => {
    await db.titles.add(T('wd:Q1', { updatedAt: '2026-03-03T00:00:00Z', edited: { expectation: '2026-03-03T00:00:00Z' } }));
    await restore(parsed({ titles: [T('wd:Q1', { expectation: 4, expectedAt: '2026-01-01T00:00:00Z' })] }).backup, 'merge');
    expect(await get('wd:Q1')).not.toHaveProperty('expectedAt');
    expect((await get('wd:Q1')).expectation).toBeUndefined();
  });
  it('applies the newest note once and keeps the prior one in restore undo', async () => {
    await db.titles.add(T('wd:Q1', { note: 'mine', updatedAt: '2026-01-02T00:00:00Z' }));
    const incoming = parsed({ titles: [T('wd:Q1', { note: 'theirs', updatedAt: '2026-02-02T00:00:00Z', edited: { note: '2026-02-02T00:00:00Z' } })] }).backup;
    expect((await restore(incoming, 'merge')).updated).toBe(1);
    expect((await get('wd:Q1')).note).toBe('theirs');
    await undoRestore();
    expect((await get('wd:Q1')).note).toBe('mine');
  });
  it('merge reports what it did and keeps distinct same-day viewings and avoids identical links', async () => {
    await db.titles.add(T('wd:Q1', { updatedAt: '2026-03-01T00:00:00Z' }));
    await addLink('wd:Q1', 'https://a.org/x');
    await db.watches.add({ id: 'here', titleId: 'wd:Q1', date: '2026-01-05', together: true });
    const r = await restore(parsed({
      titles: [T('wd:Q1'), T('wd:Q5')],
      links: [{ id: 'other', titleId: 'wd:Q1', url: 'https://a.org/x', addedAt: '2026-01-01T00:00:00Z' }],
      watches: [{ id: 'there', titleId: 'wd:Q1', date: '2026-01-05', together: true }],
    }).backup, 'merge');
    expect(r).toMatchObject({ added: 1, links: 0, watches: 1 });
    expect(await db.links.count()).toBe(1);
    expect(await db.watches.count()).toBe(2);
  });
  it('a bulk Undo records an unmark so an older backup cannot resurrect it', async () => {
    await db.titles.add(show());
    await db.episodes.bulkAdd([E(1, 1), E(2, 2)]);
    const undo = await setProgress('tvm:7', E(2, 2));
    const old = await buildBackup();
    await undo();
    await restore(old, 'merge');
    expect(await db.seen.count()).toBe(0);
  });

  it('recovers episodes for a new series and keeps matching orphan records', async () => {
    const old = parsed({ titles: [show({ syncedAt: '2026-01-08' })], episodes: [E(1, 1)], watches: [{ id: 'orphan', titleId: 'wd:Q3', date: '2026-01-08', together: false }] }).backup;
    await restore(old, 'merge');
    expect((await db.episodes.get(1))?.missingSince).toBeUndefined();
    expect(await db.watches.get('orphan')).toMatchObject({ titleId: 'wd:Q3' });
  });

  it('a merged-in series whose marks arrive is not left as "want"', async () => {
    await db.titles.add(show({ status: 'want' }));
    await db.episodes.bulkAdd([E(1, 1), E(2, 2)]);
    await restore(parsed({ titles: [show({ status: 'want' })], episodes: [E(1, 1), E(2, 2)], seen: [{ episodeId: 1, titleId: 'tvm:7', seenAt: '2026-01-01T00:00:00Z' }] }).backup, 'merge');
    expect((await get()).status).toBe('watching');
  });
  it('the wrong file and then another still undo to your own collection', async () => {
    await db.titles.add(T('wd:Q1', { rating: 10 }));
    await restore(parsed({ titles: [T('wd:Q2')] }).backup, 'replace');
    await restore(parsed({ titles: [T('wd:Q3')] }).backup, 'replace');
    await undoRestore();
    expect(await db.titles.toCollection().primaryKeys()).toEqual(['wd:Q1']);
    await undoRestore(); // and the undo can be undone
    expect(await db.titles.toCollection().primaryKeys()).toEqual(['wd:Q3']);
  });
  it.each([
    ['an episode marked', () => setSeen(E(1, 1), true)],
    ['a pass', () => dismissTitle({ qid: 'Q8', name: 'x', at: new Date().toISOString() })],
    ['a source', () => addLink('tvm:7', 'https://a.org/x')],
    ['a rating', () => update('tvm:7', { rating: 9 })],
  ])('but %s in between is the collection to go back to', async (_, act) => {
    await db.titles.add(T('wd:Q1'));
    await restore(parsed({ titles: [show()], episodes: [E(1, 1)] }).backup, 'replace');
    await new Promise((r) => setTimeout(r, 5));
    await act();
    await restore(parsed({ titles: [T('wd:Q3')] }).backup, 'replace');
    await undoRestore();
    expect(await db.titles.toCollection().primaryKeys()).toEqual(['tvm:7']);
  });
  it('a looked-up detail that cannot be read is fetched again, and does not stop a file replacing everything', async () => {
    const p = parsed({ titles: [{ ...T('wd:Q1', { rating: 8 }), poster: 7, runtime: 'long', imdb: 'nonsense' }] });
    expect(p.problems).toEqual([]);
    await restore(p.backup, 'replace');
    expect(await get('wd:Q1')).toMatchObject({ rating: 8 });
    expect(await get('wd:Q1')).not.toHaveProperty('poster');
  });
  it('scores you chose by cannot be fetched again: that is said', () => {
    expect(parsed({ titles: [{ ...T('wd:Q1'), choiceScores: [{ source: 'Rotten Tomatoes' }] }] }).problems).toHaveLength(1);
  });
  it('two different notes with no way to tell which is newer are both kept, once', async () => {
    await db.titles.add(T('wd:Q1', { note: 'mine', updatedAt: '2026-01-02T00:00:00Z' }));
    const incoming = parsed({ titles: [T('wd:Q1', { note: 'theirs', updatedAt: '2026-02-02T00:00:00Z' })] }).backup;
    await restore(incoming, 'merge');
    const note = (await get('wd:Q1')).note!;
    expect(note).toContain('mine');
    expect(note).toContain('theirs');
    await restore(incoming, 'merge');
    expect((await get('wd:Q1')).note).toBe(note);
  });
});

describe('whether a list reaches the end of a series', () => {
  const eps = (...seasons: number[]) => seasons.flatMap((n, s) => Array.from({ length: n }, (_, i) => E(s * 100 + i + 1, i + 1, { season: s + 1, airdate: `20${10 + s}-01-${String(i + 1).padStart(2, '0')}` })));
  const ended = (endedOn: string | undefined, episodeOrders?: number[]) => ({ showStatus: 'Ended', endedOn, episodeOrders });
  it.each([
    ['every season as long as TVmaze says, though a special carries the end date', ended('2030-01-01', [10, 8]), eps(10, 8), true],
    ['long seasons counted differently (The Office), to the date it ended', ended('2011-01-25', [22, 27]), eps(24, 25), true],
    ['season numbers that skip (Money Heist)', ended('2012-01-08', [15, 0, 8]), eps(15, 0, 8), true],
    ['no season lengths known, to the date it ended', ended('2010-01-06'), eps(6), true],
    ['cut off before the date it ended', ended('2011-01-08', [10, 8]), eps(10, 5), false],
    ['nothing to check it against', ended(undefined), eps(6), false],
    ['a whole season still to come', ended('2010-01-10', [10, 8]), eps(10), false],
    ['still running', { showStatus: 'Running', endedOn: undefined, episodeOrders: [6] }, eps(6), false],
  ])('%s', (_, t, list, complete) => {
    expect(completeSchedule(t as Title, list)).toBe(complete);
  });
  it('a season released in one day is not over with its first episode', () => {
    const day = Array.from({ length: 7 }, (_, i) => E(i + 1, i + 1, { airdate: '2020-10-23' }));
    expect(completeSchedule(ended('2020-10-23', [7]), day)).toBe(true);
    for (const n of [1, 4, 6]) expect(completeSchedule(ended('2020-10-23', [7]), day.slice(0, n))).toBe(false);
  });
  it('an episode that never got a date (Firefly) can be ticked, and is not waited for', async () => {
    await db.titles.add(show({ showStatus: 'Ended', endedOn: '2020-01-01', episodeOrders: [3] }));
    await db.episodes.bulkAdd([E(1, 1), E(2, 2), E(3, 3, { airdate: '' })]);
    await seenAllAired('tvm:7');
    expect((await get()).status).toBe('watched');
    expect(await db.seen.toCollection().primaryKeys()).toEqual([1, 2]);
    await setSeen(E(3, 3, { airdate: '' }), true);
    expect(await db.seen.count()).toBe(3);
    await db.titles.update('tvm:7', { showStatus: 'Running' });
    await db.episodes.add(E(4, 4, { airdate: '' }));
    await expect(setSeen(E(4, 4, { airdate: '' }), true)).rejects.toThrow(/not out yet/); // still to come, when a series goes on
  });
  it('logging a running series as finished leaves what has no date yet alone', async () => {
    await db.titles.add(show());
    await db.episodes.bulkAdd([E(1, 1), E(2, 2, { airdate: '' })]);
    await logWatch(await get(), { date: '2026-01-01', together: false });
    expect(await db.seen.toCollection().primaryKeys()).toEqual([1]);
  });
});

describe('an undo leaves no trace', () => {
  it('how keen you were can still be said after a tap taken back', async () => {
    await db.titles.add(show({ status: 'want' }));
    await db.episodes.bulkAdd([E(1, 1), E(2, 2)]);
    await (await setProgress('tvm:7', E(2, 2)))();
    expect(await get()).toMatchObject({ status: 'want' });
    expect((await get()).firstWatchedAt).toBeUndefined();
    expect((await get()).hindsight).toBeUndefined();
    await setExpectation('tvm:7', 4);
    expect((await get()).expectation).toBe(4);
  });
  it('so can a film put straight back on the list, but not one you had really seen', async () => {
    await db.titles.add(T('wd:Q1'));
    await setStatus({ id: 'wd:Q1' }, 'watched');
    await expect(setExpectation('wd:Q1', 4)).rejects.toThrow();
    await setStatus({ id: 'wd:Q1' }, 'want');
    await setExpectation('wd:Q1', 4);
    await logWatch({ id: 'wd:Q1' }, { date: '2026-01-01', together: false, rating: 7 });
    await setStatus({ id: 'wd:Q1' }, 'want');
    await expect(setExpectation('wd:Q1', 5)).rejects.toThrow();
  });
});

describe('leaving something blank is not clearing it', () => {
  it('a film added without a rating takes the rating another copy has', async () => {
    const item = { claims: {}, labels: { en: { value: 'Heat' } }, sitelinks: {} };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ entities: { Q1: item } }))));
    await addFilm('Q1', { status: 'watched', rating: undefined });
    expect((await get('wd:Q1')).edited).not.toHaveProperty('rating');
    await restore(parsed({ titles: [T('wd:Q1', { status: 'watched', rating: 9, edited: { rating: '2026-01-01T00:00:00Z' } })] }).backup, 'merge');
    expect((await get('wd:Q1')).rating).toBe(9);
  });
  it('logging a viewing without a rating neither', async () => {
    await db.titles.add(T('wd:Q1'));
    await logWatch({ id: 'wd:Q1' }, { date: '2026-01-01', together: false });
    expect((await get('wd:Q1')).edited).not.toHaveProperty('rating');
  });
  it('a series finished by bulk marks keeps the date another copy has', async () => {
    await db.titles.add(show({ showStatus: 'Ended', endedOn: '2020-01-01' }));
    await db.episodes.bulkAdd([E(1, 1), E(2, 2)]);
    await seenAllAired('tvm:7');
    expect((await get()).edited).not.toHaveProperty('finishedAt');
  });
});

describe('deleting, adding again and merging', () => {
  const old = () => parsed({
    titles: [show({ rating: 9, updatedAt: '2026-01-05T00:00:00Z' })], episodes: [E(1, 1), E(2, 2)],
    seen: [{ episodeId: 1, titleId: 'tvm:7', seenAt: '2026-01-05T00:00:00Z' }],
    links: [{ id: 'l', titleId: 'tvm:7', url: 'https://a.org/x', addedAt: '2026-01-05T00:00:00Z' }],
    watches: [{ id: 'w', titleId: 'tvm:7', date: '2026-01-05', together: false }],
  }).backup;
  const removedOnce = async () => {
    await restore(old(), 'replace');
    return removeTitle('tvm:7');
  };
  it('an older copy of something you removed stays out, counted once', async () => {
    await removedOnce();
    const r = await restore(old(), 'merge');
    expect(r).toMatchObject({ added: 0, marks: 0, links: 0, watches: 0, leftOut: 1 });
    expect(await Promise.all([db.titles, db.seen, db.links, db.watches, db.episodes].map((t) => t.count()))).toEqual([0, 0, 0, 0, 0]);
  });
  it('one changed elsewhere after you removed it here comes back, with what it had', async () => {
    await removedOnce();
    const b = old();
    (b.data.titles[0] as Title).updatedAt = '2999-01-01T00:00:00Z';
    expect(await restore(b, 'merge')).toMatchObject({ added: 1, marks: 1, links: 1, watches: 1, leftOut: 0 });
  });
  it('added again after removing: what went with the first stays gone', async () => {
    await removedOnce();
    await db.titles.add(show({ status: 'want', addedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
    await restore(old(), 'merge');
    expect((await get()).rating).toBeUndefined();
    expect(await db.seen.count()).toBe(0);
  });
  it('removed, added again: the undo of the removal no longer applies', async () => {
    const undo = await removedOnce();
    await db.titles.add(show({ status: 'want' }));
    await undo();
    expect((await get()).status).toBe('want');
  });
  it('a source edited elsewhere after you removed it here comes back; one only older does not', async () => {
    await restore(old(), 'replace');
    const { deleteLink } = await import('../../src/lib/actions');
    await deleteLink('l');
    expect((await restore(old(), 'merge')).links).toBe(0);
    const b = old();
    (b.data.links[0] as { editedAt?: string }).editedAt = '2999-01-01T00:00:00Z';
    expect((await restore(b, 'merge')).links).toBe(1);
  });
  it('a title you have is not also one you passed on', async () => {
    await db.titles.add(T('wd:Q1', { qid: 'Q1' }));
    await restore(parsed({ dismissed: [{ qid: 'Q1', at: '2026-01-01T00:00:00Z', name: 'x' }, { qid: 'Q2', at: '2026-01-01T00:00:00Z', name: 'y' }] }).backup, 'merge');
    expect(await db.dismissed.toCollection().primaryKeys()).toEqual(['Q2']);
  });
});

it('a choice from the previous version keeps the scores it was made with when newer ones arrive', async () => {
  const rt = (score: number) => ({ source: 'Rotten Tomatoes', value: `${score}%`, score });
  await db.titles.add(T('wd:Q1', { qid: 'Q1', chosenAt: '2026-01-02T00:00:00Z', critics: [rt(90)] }));
  const meta = { kind: 'film' as const, name: 'Heat', qid: 'Q1', genres: [], people: [], subjects: [], countries: [], languages: [], critics: [rt(50)] };
  for (let i = 0; i < 2; i++) await saveFilmMeta('wd:Q1', meta, new Date(Date.now() + 1000).toISOString());
  expect(await get('wd:Q1')).toMatchObject({ critics: [rt(50)], choiceScores: [rt(90)] });
});

describe('asking for new episodes checks every series that could have them', () => {
  const library = async (n: number) => {
    await db.titles.bulkAdd(Array.from({ length: n }, (_, i) => show({ id: `tvm:${i + 1}`, tvmaze: i + 1, status: 'watched', showStatus: 'Ended', tvmUpdated: 5, syncedAt: new Date().toISOString() })));
    await db.settings.put({ key: 'showsSyncedAt', value: new Date().toISOString() });
  };
  const serve = (index: Record<string, number> | null) => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (u.includes('/updates/')) return index ? new Response(JSON.stringify(index)) : new Response('', { status: 500 });
      const id = Number(u.match(/shows\/(\d+)/)![1]);
      asked.push(String(id));
      return new Response(JSON.stringify({ ...reply([raw(id * 10, 1)]), id }));
    }));
    return asked;
  };
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout'] }); });
  afterEach(() => { vi.useRealTimers(); });
  const run = async (force: boolean) => {
    const p = syncShows(force);
    for (let i = 0; i < 400; i++) { await vi.advanceTimersByTimeAsync(600); await new Promise((r) => setImmediate(r)); }
    return p;
  };
  it('one that came back is found however many are finished, and the rest are not refetched', async () => {
    await library(20);
    const asked = serve({ 19: 99 });
    expect(await run(true)).toMatchObject({ refreshed: 1, failed: 0 });
    expect(asked).toEqual(['19']);
  }, 20000);
  it('without the list of changes, all of them are asked', async () => {
    await library(14);
    const asked = serve(null);
    expect((await run(true)).refreshed).toBe(14);
    expect(asked).toHaveLength(14);
  }, 20000);
});

it('a film saved before its details arrived gets them at the next chance, not in half a day', async () => {
  await db.titles.add(T('wd:Q1', { qid: 'Q1', enrichedAt: undefined }));
  await db.settings.put({ key: 'filmsSyncedAt', value: new Date().toISOString() });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ entities: { Q1: { claims: {}, labels: { en: { value: 'Heat' } }, sitelinks: {} } } }))));
  await refreshFilms();
  expect(await get('wd:Q1')).toMatchObject({ name: 'Heat', enrichedAt: expect.any(String) });
});

describe('adding twice at once', () => {
  it('two taps make one title and no error', async () => {
    const item = { claims: {}, labels: { en: { value: 'Heat' } }, sitelinks: {} };
    vi.stubGlobal('fetch', vi.fn(async (u: string) => new Response(JSON.stringify(String(u).includes('wbgetentities') ? { entities: { Q1: item } } : {}))));
    const r = await Promise.all([addFilm('Q1'), addFilm('Q1')]);
    expect(r).toEqual(['wd:Q1', 'wd:Q1']);
    expect(await db.titles.count()).toBe(1);
  });
});

describe('upgrading the stored collection', () => {
  const V1 = { titles: 'id, kind, status, qid, imdb, tvmaze, updatedAt', episodes: 'id, titleId, airdate', seen: 'episodeId, titleId', watches: 'id, titleId, date', links: 'id, titleId', settings: 'key', dismissed: 'qid' };
  const old = () => {
    const d = new Dexie('migration-test');
    d.version(1).stores(V1);
    return d;
  };
  it('a collection from the previous version opens with everything in it, and the previous version can still open it', async () => {
    const v1 = old();
    await v1.table('titles').add(T('wd:Q1', { rating: 9, note: 'n' }));
    await v1.table('seen').add({ episodeId: 5, titleId: 'tvm:7', seenAt: '2026-01-01' });
    v1.close();
    const v2 = new PardeDB('migration-test');
    expect(await v2.titles.get('wd:Q1')).toMatchObject({ rating: 9, note: 'n' });
    expect(await v2.seen.count()).toBe(1);
    await v2.removed.put({ key: 'seen:5', at: '2026-01-02' });
    v2.close();
    const back = old(); // a rollback, or the cached older app on another tab
    expect(await back.table('titles').get('wd:Q1')).toMatchObject({ rating: 9 });
    back.close();
  });
});
