import { describe, expect, it } from 'vitest';
import { parseCsv, parseImport, parseLine, choose, patchFor } from '../../src/lib/importer';
import type { Title } from '../../src/lib/db';

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
  it('never overwrites what you already recorded', () => {
    const t = { rating: 7 } as Title;
    expect(patchFor({ line: 1, raw: '', name: 'x', rating: 9, status: 'watched' }, t)).toEqual({});
    expect(patchFor({ line: 1, raw: '', name: 'x', rating: 9, status: 'watched' }, {} as Title)).toEqual({ rating: 9 });
    expect(patchFor({ line: 1, raw: '', name: 'x', rating: 9, status: 'watched', date: '2024-01-01' })).toEqual({ rating: 9, status: 'watched', finishedAt: '2024-01-01' });
  });
});
