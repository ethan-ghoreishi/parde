import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCsv, parseImport, parseLine, choose, patchFor, mergeRows, scaleOf, commit, type Item, type Row } from '../../src/lib/importer';
import { db, type Title } from '../../src/lib/db';

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
  it('bare-number ratings: any above 5 means out of 10; all 5 or under is asked, defaulting to stars', () => {
    expect(parseImport('Heat 9\nUp 4').map((r) => r.rating)).toEqual([9, 4]);
    const low = 'Heat 4.5\nUp 3';
    expect(scaleOf(parseImport(low))).toEqual({ outOf: 5, ambiguous: true });
    expect(parseImport(low).map((r) => r.rating)).toEqual([9, 6]);
    expect(parseImport(low, 'watched', 10).map((r) => r.rating)).toEqual([5, 3]);
    expect(parseImport('Heat 4/5\nUp 4/10').map((r) => r.rating)).toEqual([8, 4]); // written scales are never guessed
    expect(scaleOf(parseImport('Heat 4/5\nUp 4/10')).ambiguous).toBe(false);
    const generic = 'Title,Year,Rating\nHeat,1995,4\nUp,2009,3.5\n';
    expect(parseImport(generic).map((r) => r.rating)).toEqual([8, 7]);
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
    expect(choose({ line: 1, raw: '', name: 'Fargo', kind: 'show', status: 'watched' }, [{ kind: 'film', qid: 'Q1', name: 'Fargo', year: 1996 }])).toMatchObject({ sure: false, pick: 0 });
  });
  it('merges a diary\'s repeated lines: latest rating and date, furthest episode', () => {
    const r = (o: Partial<Row>): Row => ({ line: 1, raw: '', name: 'Heat', status: 'watched', ...o });
    expect(mergeRows([r({ rating: 6, date: '2020-01-01' }), r({ rating: 9, date: '2024-01-01' }), r({ date: '2025-01-01' })])).toMatchObject({ rating: 9, date: '2025-01-01', status: 'watched' });
    expect(mergeRows([r({ status: 'want', upTo: { season: 1, episode: 4 } }), r({ upTo: { season: 2, episode: 1 } })])).toMatchObject({ status: 'watched', upTo: { season: 2, episode: 1 } });
  });
  it('a film on your want list that the history says you watched becomes watched', () => {
    expect(patchFor({ line: 1, raw: '', name: 'x', rating: 8, status: 'watched', date: '2024-01-01' }, { kind: 'film', status: 'want' } as Title)).toEqual({ rating: 8, status: 'watched', finishedAt: '2024-01-01' });
    expect(patchFor({ line: 1, raw: '', name: 'x', status: 'watched' }, { kind: 'film', status: 'dropped' } as Title)).toEqual({});
  });
  it('never overwrites what you already recorded', () => {
    const t = { rating: 7 } as Title;
    expect(patchFor({ line: 1, raw: '', name: 'x', rating: 9, status: 'watched' }, t)).toEqual({});
    expect(patchFor({ line: 1, raw: '', name: 'x', rating: 9, status: 'watched' }, {} as Title)).toEqual({ rating: 9 });
    expect(patchFor({ line: 1, raw: '', name: 'x', rating: 9, status: 'watched', date: '2024-01-01' })).toEqual({ rating: 9, status: 'watched', finishedAt: '2024-01-01' });
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
      item(row({ rating: 6, date: '2024-03-01' }), [film]),
      item(row({ rating: 9, date: '2025-01-01' }), [film]),
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
