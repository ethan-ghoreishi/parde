import { describe, expect, it, vi } from 'vitest';
import { DECADES, KNOWN, insight, lookUp, offer, premise, remember, shelf, threadOf, threads } from '../../src/lib/discover';
import { parseCritics, type Find } from '../../src/lib/api/wiki';
import type { Title } from '../../src/lib/db';

let n = 0;
const T = (o: Partial<Title> = {}): Title => ({
  id: `wd:Q${++n}`, qid: `Q${n}`, kind: 'film', name: `T${n}`, genres: [], people: [], subjects: [], countries: [], languages: [], critics: [],
  status: 'watched', addedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...o,
});
const mann = { name: 'Michael Mann', role: 'director' as const, qid: 'Q900' };
const F = (i: number, o: Partial<Find> = {}): Find => ({ qid: `QF${i}`, name: `F${i}`, kind: 'film', year: 1990, known: 100 - i, ...o });

describe('ways in', () => {
  it('a new collection starts from what nearly everyone has seen, and every decade', () => {
    const t = threads([]);
    expect(t.map((x) => x.key)).toEqual(expect.arrayContaining(['known', ...DECADES.map((d) => `decade:${d}`)]));
    expect(t.some((x) => /^(title|person|about)/.test(x.key))).toBe(false);
    expect(offer(t, 0).length).toBeGreaterThanOrEqual(5);
  });
  it('yours lead from what you loved, who made it, what it is about and where from', () => {
    const lib = [T({ rating: 9, people: [mann], subjects: ['obsession'], countries: ['Iran'] }), T({ rating: 9, people: [mann], countries: ['Iran'] }), T({ rating: 9, countries: ['Iran'] }), T({ rating: 4 }), T({ rating: 3 })];
    const keys = threads(lib).map((x) => x.key);
    expect(keys).toEqual(expect.arrayContaining([`title:${lib[0].qid}`, 'person:Q900', 'about:obsession', 'place:Q794']));
    expect(keys.filter((k) => k === 'place:Q794')).toHaveLength(1); // yours, so not also "somewhere new"
    expect(keys).not.toContain(`title:${lib[3].qid}`); // not loved
  });
  it('offers a mix, and others when asked', () => {
    const lib = Array.from({ length: 12 }, (_, i) => T({ rating: 9, people: [{ name: `D${i % 3}`, role: 'director', qid: `Q80${i % 3}` }], subjects: [`s${i}`] }));
    const a = offer(threads(lib), 0);
    const kinds = new Set(a.map((x) => x.key.split(':')[0]));
    expect(kinds.size).toBeGreaterThanOrEqual(4);
    expect(offer(threads(lib), 1).map((x) => x.key)).not.toEqual(a.map((x) => x.key));
  });
  it('an address always names something sensible', () => {
    expect(threadOf('person:Q5', [], 'Agnès Varda')?.label).toBe('Agnès Varda');
    expect(threadOf('place:Q794', [])?.label).toBe('From Iran');
    expect(threadOf('nonsense', [])).toBeUndefined();
    expect(threadOf('place:Q1', [])).toBeUndefined();
  });
  it('decades and the well known need no network', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const nineties = await lookUp('decade:1990');
    expect(nineties.length).toBeGreaterThan(20);
    expect(nineties.every((f) => f.year! >= 1990 && f.year! < 2000)).toBe(true);
    const all = await lookUp(KNOWN.key);
    expect(all.filter((f) => f.kind === 'show').length).toBeGreaterThan(50);
    expect(all.filter((f) => f.kind === 'show').every((f) => f.tvmaze)).toBe(true);
    expect(new Set(all.map((f) => f.qid)).size).toBe(all.length);
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('a shelf', () => {
  const all = Array.from({ length: 40 }, (_, i) => F(i));
  it('is twelve: eight near, four from further along', () => {
    const s = shelf(all, [], new Set(), new Set(), 2026);
    expect(s).toHaveLength(12);
    expect(s.slice(0, 8)).toEqual(all.slice(0, 8));
    expect(s.slice(8).every((f) => Number(f.qid.slice(2)) >= 8)).toBe(true);
    expect(Number(s[11].qid.slice(2))).toBeGreaterThan(20);
  });
  it('leaves out what you have, have passed on, or cannot have seen yet', () => {
    const lib = [T({ qid: 'QF0' }), T({ id: 'tvm:5', kind: 'show', qid: undefined, tvmaze: 5 })];
    const s = shelf([F(0), F(1), F(2, { year: 2030 }), F(3, { year: undefined }), F(4, { kind: 'show', tvmaze: 5 }), F(5)], lib, new Set(['QF1']), new Set(), 2026);
    expect(s.map((f) => f.qid)).toEqual(['QF5']);
  });
  it('does not repeat what was just shown until a thread runs out', () => {
    const first = shelf(all, [], new Set(), new Set(), 2026);
    const second = shelf(all, [], new Set(), new Set(first.map((f) => f.qid)), 2026);
    expect(second.some((f) => first.includes(f))).toBe(false);
    expect(shelf([F(1), F(2)], [], new Set(), new Set(['QF1', 'QF2']), 2026)).toHaveLength(2);
  });
  it('remembers only the latest few hundred', () => {
    expect(remember(['a', 'b'], ['c', 'a'])).toEqual(['c', 'a', 'b']);
    expect(remember(Array.from({ length: 700 }, (_, i) => `${i}`), ['x'])).toHaveLength(600);
  });
});

describe('what a rating just told you', () => {
  it('counts you against yourself, and says nothing without other ratings behind it', () => {
    const one = T({ rating: 9, people: [mann] });
    expect(insight(one, [one])).toBeUndefined();
    const lib = [T({ rating: 8, people: [mann] }), T({ rating: 7, people: [mann] }), one];
    expect(insight(one, lib)).toEqual({ text: 'Your 3rd by Michael Mann: 8.0 on average.', thread: { key: 'person:Q900', label: 'More by Michael Mann' } });
    expect(insight({ ...one, rating: undefined }, lib)).toBeUndefined();
  });
  it('a namesake is someone else', () => {
    const one = T({ rating: 9, people: [{ name: 'Steve McQueen', role: 'director', qid: 'Q1' }] });
    expect(insight(one, [one, T({ rating: 2, people: [{ name: 'Steve McQueen', role: 'director', qid: 'Q2' }] })])).toBeUndefined();
  });
  it.each([[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [11, '11th'], [12, '12th'], [21, '21st'], [23, '23rd']])('counts %i as %s', (k, word) => {
    const one = T({ rating: 5, people: [mann] });
    const r = insight(one, [one, ...Array.from({ length: k - 1 }, () => T({ rating: 5, people: [mann] }))]);
    if (k === 1) expect(r).toBeUndefined();
    else expect(r!.text).toContain(`Your ${word} `);
  });
});

describe('a premise', () => {
  it('says what it is, then what happens', () => {
    expect(premise('Heat is a 1995 American crime film. It stars Al Pacino. The film follows a detective and a thief. It was acclaimed.')).toBe('Heat is a 1995 American crime film. The film follows a detective and a thief.');
  });
  it('does not stop at initials or titles', () => {
    expect(premise('L.A. Takedown is a 1989 film. It tells of Dr. No and Mr. Big in L.A. Later it was remade.')).toMatch(/^L\.A\. Takedown is a 1989 film\. It tells of Dr\. No and Mr\. Big/);
    expect(premise('One sentence only')).toBe('One sentence only');
    expect(premise(undefined)).toBe('');
  });
});

describe('scores keep their meaning', () => {
  const claim = (value: string, by: string, method?: string, at = '+2024-01-00T00:00:00Z') => ({
    mainsnak: { snaktype: 'value', datavalue: { value } },
    qualifiers: {
      P447: [{ snaktype: 'value', datavalue: { value: { id: by } } }],
      ...(method ? { P459: [{ snaktype: 'value', datavalue: { value: { id: method } } }] } : {}),
      P585: [{ snaktype: 'value', datavalue: { value: { time: at } } }],
    },
  });
  it('tells the Tomatometer, the critics’ average and the Metascore apart, and drops what does not say which it is', () => {
    const got = parseCritics({ P444: [
      claim('84%', 'Q105584', 'Q108403393'), claim('7.8/10', 'Q105584', 'Q108403540'), claim('76/100', 'Q150248', 'Q106515043'),
      claim('91%', 'Q105584', undefined, '+2026-01-00T00:00:00Z'), // newer, but which of the three?
    ] });
    expect(Object.fromEntries(got.map((c) => [c.source, c.value]))).toEqual({ 'Rotten Tomatoes': '84%', 'Rotten Tomatoes average': '7.8/10', Metacritic: '76/100' });
  });
  it('an unlabelled Metacritic number is the Metascore only out of 100', () => {
    expect(parseCritics({ P444: [claim('76/100', 'Q150248')] })).toHaveLength(1);
    expect(parseCritics({ P444: [claim('8.1/10', 'Q150248')] })).toHaveLength(0);
  });
});
