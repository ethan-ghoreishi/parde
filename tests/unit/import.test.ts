import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCsv, parseImport, readImport, parseLine, choose, likely, patchFor, mergeRows, resolve, scaleOf, commit, type Item, type Row } from '../../src/lib/importer';
import { db, type Episode, type Title } from '../../src/lib/db';

describe('import parsing', () => {
  it('reads quoted CSV fields with commas, quotes and line breaks', () => {
    expect(parseCsv('a,"b, c","say ""hi"""\r\n"multi\nline",2,3\n')).toEqual([['a', 'b, c', 'say "hi"'], ['multi\nline', '2', '3']]);
  });

  it('reads a Letterboxd export: half-star ratings become 1–10, everything is a film', () => {
    const csv = 'Date,Name,Year,Letterboxd URI,Rating\n2024-03-02,"Crouching Tiger, Hidden Dragon",2000,https://boxd.it/x,4.5\n2024-03-03,Heat,1995,https://boxd.it/y,\n';
    const rows = parseImport(csv, 'want');
    expect(rows[0]).toMatchObject({ name: 'Crouching Tiger, Hidden Dragon', year: 2000, rating: 9, kind: 'film', status: 'watched', date: '2024-03-02' });
    expect(rows[1]).toMatchObject({ name: 'Heat', rating: undefined, status: 'want' }); // a watchlist row
  });

  it('reads an IMDb export: ids, 1–10 ratings, series vs films, episodes skipped', () => {
    const csv = [
      'Const,Your Rating,Date Rated,Title,Original Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres',
      'tt0113277,9,2023-05-01,Heat,Heat,https://www.imdb.com/title/tt0113277/,Movie,8.3,170,1995,"Crime, Drama"',
      'tt11280740,8,2024-01-01,Severance,Severance,https://www.imdb.com/title/tt11280740/,TV Series,8.7,55,2022,Drama',
      'tt1234567,7,2024-01-01,Pilot,Pilot,u,TV Episode,8,50,2022,Drama',
    ].join('\n');
    const rows = parseImport(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ imdb: 'tt0113277', rating: 9, kind: 'film', year: 1995 });
    expect(rows[1]).toMatchObject({ imdb: 'tt11280740', kind: 'show' });
  });

  it.each([
    ['Heat (1995) 9', { name: 'Heat', year: 1995, rating: 9 }],
    ['Heat 1995 - 8/10', { name: 'Heat', year: 1995, rating: 8 }],
    ['Amélie ★★★★½', { name: 'Amélie', rating: 9 }],
    ['Severance S02E03', { name: 'Severance', kind: 'show', upTo: { season: 2, episode: 3 } }],
    ['Fargo (series)', { name: 'Fargo', kind: 'show' }],
    ['1917', { name: '1917' }],
    ['2001: A Space Odyssey 10', { name: '2001: A Space Odyssey', rating: 10 }],
    ['- Past Lives', { name: 'Past Lives' }],
    ['3. Se7en 1995', { name: 'Se7en', year: 1995 }],
  ])('reads the line "%s"', (line, want) => {
    expect(parseLine(line, 1, 'watched')).toMatchObject(want);
  });
  it('a bare year-like title stays a title', () => {
    expect(parseLine('1917', 1, 'watched')).not.toHaveProperty('year', 1917);
  });

  it('IMDb ratings are out of 10 even when every one is 5 or less', () => {
    const csv = 'Const,Your Rating,Date Rated,Title,Title Type,Year\ntt0113277,4,2023-05-01,Heat,Movie,1995\ntt0000002,5,2023-05-01,Up,Movie,2009\n';
    expect(parseImport(csv).map((r) => r.rating)).toEqual([4, 5]);
    expect(scaleOf(parseImport(csv)).ambiguous).toBe(false);
  });
  it('bare-number ratings: any above 5 means out of 10; all 5 or under is asked, and nothing is assumed until you say', () => {
    expect(parseImport('Heat 9\nUp 4').map((r) => r.rating)).toEqual([9, 4]);
    const low = 'Heat 4.5\nUp 3';
    expect(scaleOf(parseImport(low))).toEqual({ outOf: 5, ambiguous: true });
    expect(parseImport(low).map((r) => [r.rating, r.status])).toEqual([[undefined, 'watched'], [undefined, 'watched']]);
    expect(parseImport(low, 'watched', 5).map((r) => r.rating)).toEqual([9, 6]);
    expect(parseImport(low, 'watched', 10).map((r) => r.rating)).toEqual([5, 3]);
    expect(parseImport('Heat 4\nDune 8', 'watched', 5).map((r) => r.rating)).toEqual([4, 8]); // an earlier choice cannot override a list that is clearly out of 10
    expect(parseImport('Heat 4/5\nUp 4/10').map((r) => r.rating)).toEqual([8, 4]); // written scales are never guessed
    expect(scaleOf(parseImport('Heat 4/5\nUp 4/10')).ambiguous).toBe(false);
    const generic = 'Title,Year,Rating\nHeat,1995,4\nUp,2009,3.5\n';
    expect(parseImport(generic, 'watched', 5).map((r) => r.rating)).toEqual([8, 7]);
  });
  it('the day a rating was entered is not the day it was watched; an impossible date is no date', () => {
    const lb = parseImport('Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n2024-03-09,Heat,1995,u,4.5,,,2024-03-02\n2024-03-09,Up,2009,u,4,,,2024-99-99\n');
    expect(lb.map((r) => r.watchedOn)).toEqual(['2024-03-02', undefined]);
    expect(parseImport('Const,Your Rating,Date Rated,Title,Title Type,Year\ntt0113277,9,2023-05-01,Heat,Movie,1995\n')[0]).toMatchObject({ date: '2023-05-01', watchedOn: undefined });
  });
  it('says what it could not read instead of dropping it', () => {
    const r = readImport('Title,Title Type,Your Rating,Const\nHeat,Movie,85,tt0113277\nPilot,TV Episode,8,tt1234567\nUp,Movie,9,tt1049413\n');
    expect(r.skipped).toBe(1);
    expect(r.rows.map((x) => [x.rating, x.unread])).toEqual([[undefined, '85'], [9, undefined]]);
  });

  it('skips blanks and comments; a rating means it was watched', () => {
    expect(parseImport('\n# my list\nHeat 9\nDune', 'want').map((r) => [r.name, r.status])).toEqual([['Heat', 'watched'], ['Dune', 'want']]);
  });
});

describe('import matching', () => {
  const heat = (year: number, links: number) => ({ kind: 'film' as const, qid: `Q${year}`, name: 'Heat', year, links });
  it('is sure only when the year (or a single candidate) settles it', () => {
    const c = [heat(1972, 5), heat(1995, 80), heat(1986, 9)];
    const withYear = choose({ line: 1, raw: '', name: 'Heat', year: 1995, status: 'watched' }, c);
    expect(withYear).toMatchObject({ sure: true, pick: 0 });
    expect(withYear.candidates[0].year).toBe(1995);
    const noYear = choose({ line: 1, raw: '', name: 'Heat', status: 'watched' }, c);
    expect(noYear.sure).toBe(false);
    expect(noYear.candidates[0].year).toBe(1995); // most-linked first as the suggestion
    expect(choose({ line: 1, raw: '', name: 'Heat', status: 'watched' }, [heat(1995, 80)]).sure).toBe(true);
    expect(choose({ line: 1, raw: '', name: 'Fargo', kind: 'show', status: 'watched' }, [{ kind: 'film', qid: 'Q1', name: 'Fargo', year: 1996 }, { kind: 'show', qid: 'Q2', name: 'Fargo', year: 2014 }]).candidates[0].qid).toBe('Q2');
  });
  it('never adds a film when a series was asked for (or the reverse)', () => {
    expect(choose({ line: 1, raw: '', name: 'Fargo', kind: 'show', status: 'watched' }, [{ kind: 'film', qid: 'Q1', name: 'Fargo', year: 1996 }])).toMatchObject({ sure: false, pick: -1, wrongKind: true });
  });
  it('picks nothing for you when it is not sure, but knows a fair guess from a look-alike', () => {
    const it1 = (name: string, c: Item['candidates'][0], o: Partial<Row> = {}): Item => ({ row: { line: 1, raw: '', name, status: 'watched', ...o }, candidates: [c], pick: -1, sure: false });
    expect(likely(it1('Heat', { kind: 'film', qid: 'Q1', name: 'Heat', year: 1995 }))).toBe(true);
    expect(likely(it1('Heat', { kind: 'film', qid: 'Q1', name: 'The Heat', year: 2013 }))).toBe(false);
    expect(likely(it1('Fargo', { kind: 'film', qid: 'Q1', name: 'Fargo' }, { kind: 'show' }))).toBe(false);
    expect(likely(it1('Heat', { kind: 'film', qid: 'Q1', name: 'Heat', year: 1972 }, { year: 1995 }))).toBe(false);
  });
  it('merges a diary\'s repeated lines: latest rating and date, furthest episode', () => {
    const r = (o: Partial<Row>): Row => ({ line: 1, raw: '', name: 'Heat', status: 'watched', ...o });
    expect(mergeRows([r({ rating: 6, date: '2020-01-01' }), r({ rating: 9, date: '2024-01-01' }), r({ date: '2025-01-01' })])).toMatchObject({ rating: 9, date: '2025-01-01', status: 'watched' });
    expect(mergeRows([r({ status: 'want', upTo: { season: 1, episode: 4 } }), r({ upTo: { season: 2, episode: 1 } })])).toMatchObject({ status: 'watched', upTo: { season: 2, episode: 1 } });
  });
  it('a film on your want list that the history says you watched becomes watched', () => {
    expect(patchFor({ line: 1, raw: '', name: 'x', rating: 8, status: 'watched', watchedOn: '2024-01-01' }, { kind: 'film', status: 'want' } as Title)).toEqual({ rating: 8, status: 'watched', finishedAt: '2024-01-01' });
    expect(patchFor({ line: 1, raw: '', name: 'x', status: 'watched' }, { kind: 'film', status: 'dropped' } as Title)).toEqual({});
  });
  it('never overwrites what you already recorded', () => {
    const t = { rating: 7 } as Title;
    expect(patchFor({ line: 1, raw: '', name: 'x', rating: 9, status: 'watched' }, t)).toEqual({});
    expect(patchFor({ line: 1, raw: '', name: 'x', rating: 9, status: 'watched' }, {} as Title)).toEqual({ rating: 9 });
    expect(patchFor({ line: 1, raw: '', name: 'x', rating: 9, status: 'watched', date: '2024-01-01' })).toEqual({ rating: 9, status: 'watched' });
  });
});

describe('import commit', () => {
  const dune = JSON.parse(readFileSync('tests/fixtures/wd-dune2.json', 'utf8'));
  const T = (id: string, o: Partial<Title> = {}): Title => ({
    id, kind: 'film', name: id, genres: [], people: [], subjects: [], countries: [], languages: [], critics: [],
    status: 'want', addedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...o,
  });
  const row = (o: Partial<Row>): Row => ({ line: 1, raw: 'x', name: 'Dune: Part Two', status: 'watched', ...o });
  const item = (r: Row, cands: Item['candidates'], pick = 0): Item => ({ row: r, candidates: cands, pick, sure: true });
  beforeEach(async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const url = new URL(u);
      if (url.hostname === 'www.wikidata.org') {
        const ids = url.searchParams.get('ids')!.split('|');
        return new Response(JSON.stringify({ entities: Object.fromEntries(ids.map((id) => [id, id === 'Q109228991' ? dune : { labels: { en: { value: `L${id}` } } }])) }));
      }
      return new Response(JSON.stringify({ query: { pages: [] } }));
    }));
  });

  it('adds a title once however many lines name it, and checks ownership against the pick actually made', async () => {
    await db.titles.add(T('wd:Q5', { name: 'Other', status: 'want' }));
    const film = { kind: 'film' as const, qid: 'Q109228991', name: 'Dune: Part Two', year: 2024 };
    const items = [
      item(row({ rating: 6, date: '2024-03-01', watchedOn: '2024-03-01' }), [film]),
      item(row({ rating: 9, date: '2025-01-01', watchedOn: '2025-01-01' }), [film]),
      // The best guess was a title you have, but you picked the other one: that one is added, Q5 is untouched.
      item(row({ name: 'Other', rating: 3 }), [{ kind: 'film', qid: 'Q5', name: 'Other', owned: 'wd:Q5' }, { kind: 'film', qid: 'Q109228991', name: 'Dune: Part Two' }], 1),
      item(row({ name: 'Other', rating: 8, date: '2023-01-01' }), [{ kind: 'film', qid: 'Q5', name: 'Other', owned: 'wd:Q5' }]),
    ];
    try {
      const out = await commit(items, {}, () => {});
      expect(out.added).toEqual(['wd:Q109228991']);
      expect(out.merged).toBe(2);
      expect(out.updated).toBe(1);
      expect(out.failed).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(await db.titles.get('wd:Q109228991')).toMatchObject({ rating: 9, status: 'watched', finishedAt: '2025-01-01' });
    expect(await db.titles.get('wd:Q5')).toMatchObject({ rating: 8, status: 'watched' }); // want → watched, from its own line
  });
});

describe('import: series you already have', () => {
  const ep = (id: number, number: number, season = 1): Episode => ({ id, titleId: 'tvm:7', season, number, name: '', airdate: '2020-01-01', airtime: '' });
  const item = (r: Partial<Row>): Item => ({ row: { line: 1, raw: 'x', name: 'Show', status: 'watched', kind: 'show', ...r }, candidates: [{ kind: 'show', tvmaze: 7, name: 'Show' }], pick: 0, sure: true });
  beforeEach(async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
    await db.titles.add({ id: 'tvm:7', kind: 'show', name: 'Show', tvmaze: 7, genres: [], people: [], subjects: [], countries: [], languages: [], critics: [], status: 'want', addedAt: '2026-01-01', updatedAt: '2026-01-01' });
    await db.episodes.bulkAdd([ep(1, 1), ep(2, 2), ep(3, 3)]);
  });
  it('places one you have not started, and asks about one merely "seen"', async () => {
    expect((await commit([item({})], {}, () => {})).toPlace).toEqual(['tvm:7']);
    await commit([item({ upTo: { season: 1, episode: 2 } })], {}, () => {});
    expect((await db.seen.toCollection().primaryKeys()).sort()).toEqual([1, 2]);
  });
  it('never moves you backwards, and never forwards without asking', async () => {
    await db.seen.bulkAdd([1, 2].map((episodeId) => ({ episodeId, titleId: 'tvm:7', seenAt: '2026-01-01' })));
    expect((await commit([item({ upTo: { season: 1, episode: 1 } })], {}, () => {})).ahead).toEqual([]);
    const out = await commit([item({ upTo: { season: 1, episode: 3 } })], {}, () => {});
    expect(out.ahead).toMatchObject([{ id: 'tvm:7', here: 'S01E02', ep: { id: 3 } }]);
    expect(await db.seen.count()).toBe(2);
  });
});

describe('import: what could not be checked is not "not found"', () => {
  const b = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([x, value]) => [x, { value }]));
  const Q = 'http://www.wikidata.org/entity/';
  const serve = (o: { sparql?: unknown[] | number; wiki?: unknown[] | number; wd?: unknown[]; tv?: unknown[] | number }) =>
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const url = new URL(u);
      const send = (v: unknown, ok: (x: unknown) => unknown) => (typeof v === 'number' ? new Response('no', { status: v }) : new Response(JSON.stringify(ok(v ?? []))));
      if (url.hostname === 'query.wikidata.org') return send(o.sparql, (x) => ({ results: { bindings: x } }));
      if (url.hostname === 'en.wikipedia.org') return send(o.wiki, (x) => ({ query: { pages: x } }));
      if (url.hostname === 'www.wikidata.org') return send(typeof o.wiki === 'number' ? o.wiki : o.wd, (x) => ({ search: x }));
      return send(o.tv, (x) => x);
    }));
  const row = (o: Partial<Row>): Row => ({ line: 1, raw: 'x', name: 'Fargo', status: 'watched', ...o });
  beforeEach(() => Promise.all(db.tables.map((t) => t.clear())).then(() => undefined));
  afterEach(() => vi.unstubAllGlobals());

  it('a search that fails says so', async () => {
    serve({ sparql: 404, wiki: 500, tv: 500 });
    const [it] = await resolve([row({})], () => {});
    expect(it.error).toBeTruthy();
    expect(it.candidates).toEqual([]);
  });
  it('a film found by its exact title is still not added when a series was asked for', async () => {
    serve({ wiki: [{ title: 'Fargo', index: 1, description: '1996 film', pageprops: { wikibase_item: 'Q222720' } }] });
    const [it] = await resolve([row({ kind: 'show', year: 1996 })], () => {});
    expect(it.sure).toBe(false);
    expect(it.pick).toBe(-1);
  });
  it('a film and a series of the same name and year are both offered, neither chosen', async () => {
    serve({ wiki: [{ title: 'Dune', index: 1, description: '2021 film', pageprops: { wikibase_item: 'Q1' } }], tv: [{ show: { id: 5, name: 'Dune', genres: [], premiered: '2021-01-01', rating: {}, externals: {} } }] });
    const [it] = await resolve([row({ name: 'Dune', year: 2021 })], () => {});
    expect(it).toMatchObject({ sure: false, pick: -1 });
    expect(it.candidates).toHaveLength(2);
  });
  it('an IMDb id settles the title but not a type the two disagree on, or one Wikidata does not know', async () => {
    serve({ sparql: [
      b({ imdb: 'tt1', item: `${Q}Q1`, itemLabel: 'A', types: `${Q}Q5398426`, tvm: '3' }),
      b({ imdb: 'tt2', item: `${Q}Q2`, itemLabel: 'B', types: `${Q}Q21191270` }),
      b({ imdb: 'tt3', item: `${Q}Q3`, itemLabel: 'C', types: `${Q}Q11424` }),
    ] });
    const r = await resolve([row({ imdb: 'tt1', kind: 'film' }), row({ imdb: 'tt2' }), row({ imdb: 'tt3' })], () => {});
    expect(r.map((x) => x.sure)).toEqual([false, false, true]);
  });
});
