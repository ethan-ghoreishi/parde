import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseClaims, normaliseScore, tidyGenre, type Claims } from '../../src/lib/api/wiki';
import { showToMeta, toEpisode, type TvmShow } from '../../src/lib/api/tvmaze';
import { stripHtml } from '../../src/lib/api/http';

const dune = JSON.parse(readFileSync('tests/fixtures/wd-dune2.json', 'utf8')) as { claims: Claims };
const sev = JSON.parse(readFileSync('tests/fixtures/tvm-severance.json', 'utf8')) as TvmShow;

describe('Wikidata claims', () => {
  const p = parseClaims(dune.claims);
  it('reads the core facts, skipping deprecated release dates', () => {
    expect(p.year).toBe(2024);
    expect(p.runtime).toBe(165);
    expect(p.imdb).toBe('tt15239678');
    expect(p.people).toContainEqual({ qid: 'Q548823', role: 'director' });
    expect(p.people.filter((x) => x.role === 'cast').length).toBeLessThanOrEqual(10);
    expect(p.genreIds.length).toBeGreaterThan(0);
  });
  it('takes only critic scores, normalised, one per source', () => {
    const by = Object.fromEntries(p.critics.map((c) => [c.source, c.score]));
    expect(by['Rotten Tomatoes']).toBe(92);
    expect(by.Metacritic).toBe(79);
    expect(by.IMDb).toBeGreaterThanOrEqual(80);
    expect(p.critics.length).toBe(new Set(p.critics.map((c) => c.source)).size);
  });
  it('uses a YouTube id only when it is a trailer, not the full film', () => {
    expect(p.trailer).toBeUndefined(); // Dune: Part Two's id on Wikidata is the 2h46m film
    const yt = (qualifiers: Claims[string][number]['qualifiers']): Claims => ({ P1651: [{ mainsnak: { snaktype: 'value', datavalue: { value: 'abc' } }, qualifiers }] });
    const item = (id: string) => [{ snaktype: 'value', datavalue: { value: { id } } }];
    const secs = (amount: string) => [{ snaktype: 'value', datavalue: { value: { amount, unit: 'http://www.wikidata.org/entity/Q11574' } } }];
    expect(parseClaims(yt({ P3831: item('Q622550') })).trailer).toBe('abc');
    expect(parseClaims(yt({ P2047: secs('+150') })).trailer).toBe('abc');
    expect(parseClaims(yt({ P2047: secs('+9948') })).trailer).toBeUndefined();
    expect(parseClaims(yt(undefined)).trailer).toBeUndefined();
  });
  it('converts hour and second durations', () => {
    const c = (amount: string, unit: string): Claims => ({ P2047: [{ mainsnak: { snaktype: 'value', datavalue: { value: { amount, unit: `http://www.wikidata.org/entity/${unit}` } } } }] });
    expect(parseClaims(c('+2', 'Q25235')).runtime).toBe(120);
    expect(parseClaims(c('+5400', 'Q11574')).runtime).toBe(90);
  });
  it('normalises score formats', () => {
    expect(normaliseScore('92%')).toBe(92);
    expect(normaliseScore('79/100')).toBe(79);
    expect(normaliseScore('8.4/10')).toBe(84);
    expect(normaliseScore('wertvoll')).toBeUndefined();
  });
  it('tidies genre labels', () => {
    expect(tidyGenre('science fiction film')).toBe('Science fiction');
    expect(tidyGenre('drama television series')).toBe('Drama');
  });
});

describe('TVmaze', () => {
  it('maps a streaming show', () => {
    const m = showToMeta(sev);
    expect(m.kind).toBe('show');
    expect(m.webChannel).toBe('Apple TV');
    expect(m.network).toBeUndefined();
    expect(m.imdb).toBe('tt11280740');
    expect(m.people.some((p) => p.role === 'creator')).toBe(true);
    expect(m.overview).not.toMatch(/<[a-z]/);
  });
  it('maps episodes and skips unnumbered specials', () => {
    const ep = toEpisode('tvm:1', sev._embedded!.episodes![0])!;
    expect(ep).toMatchObject({ season: 1, number: 1, titleId: 'tvm:1' });
    expect(toEpisode('tvm:1', { ...sev._embedded!.episodes![0], number: null })).toBeNull();
  });
  it('strips html to inert text', () => {
    expect(stripHtml('<p>A &amp; B</p><p><script>x</script>C</p>')).toBe('A & B\n\nxC');
  });
});

import { rankByTitle } from '../../src/lib/api/wiki';
describe('film search ranking', () => {
  const P = (...t: string[]) => t.map((title) => ({ title }));
  it('drops body-only matches and puts closer titles first', () => {
    expect(rankByTitle('past lives', P('The Past-Master', 'Past Lives (film)', 'Criminal Passion')).map((p) => p.title)).toEqual(['Past Lives (film)', 'The Past-Master']);
    expect(rankByTitle('severance', P('The Runestone', 'Severance (2006 film)')).map((p) => p.title)).toEqual(['Severance (2006 film)']);
  });
  it('ignores accents and keeps everything when nothing matches', () => {
    expect(rankByTitle('amelie', P('Amélie')).length).toBe(1);
    expect(rankByTitle('jodaeiye', P('A Separation')).length).toBe(1);
  });
});
