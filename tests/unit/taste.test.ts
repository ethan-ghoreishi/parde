import { describe, expect, it } from 'vitest';
import { trailerInstinct, versusCritics, scoreCandidates, makerAffinity, contradictions, pearson } from '../../src/lib/taste';
import { questionsFor, recapPrompt } from '../../src/lib/handoff';
import type { Title } from '../../src/lib/db';

let n = 0;
const T = (o: Partial<Title>): Title => ({
  id: `wd:Q${++n}`, kind: 'film', name: `T${n}`, genres: [], people: [], subjects: [], countries: [], languages: [], critics: [],
  status: 'watched', addedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...o,
});

describe('insights', () => {
  it('pearson', () => {
    expect(pearson([[1, 2], [2, 4], [3, 6]])).toBeCloseTo(1);
    expect(Number.isNaN(pearson([[1, 1]]))).toBe(true);
  });
  it('trailer instinct finds surprises and letdowns', () => {
    const ts = [T({ expectation: 1, rating: 9 }), T({ expectation: 5, rating: 2 }), T({ expectation: 3, rating: 5 })];
    const r = trailerInstinct(ts);
    expect(r.n).toBe(3);
    expect(r.surprises[0].title).toBe(ts[0]);
    expect(r.letdowns[0].title).toBe(ts[1]);
  });
  it('compares only with critic scores, and never treats the Tomatometer as a score', () => {
    const rt = (score: number) => [{ source: 'Rotten Tomatoes', value: `${score}%`, score }];
    const ts = [T({ rating: 9, critics: rt(50) }), T({ rating: 4, critics: rt(90) }), T({ rating: 7, critics: rt(80) }), T({ rating: 8, critics: [{ source: 'IMDb', value: '8/10', score: 80 }] })];
    const r = versusCritics(ts);
    expect(r).toMatchObject({ source: 'Rotten Tomatoes', n: 3 });
    expect(Number.isNaN(r.meanGap)).toBe(true); // no "N points warmer" from a percentage of positive reviews
    expect(r.warmer.map((x) => x.title)).toEqual([ts[0]]);
    expect(r.colder.map((x) => x.title)).toEqual([ts[1]]);
    const mc = (score: number) => [{ source: 'Metacritic', value: `${score}/100`, score }];
    const m = versusCritics([T({ rating: 9, critics: mc(60) }), T({ rating: 5, critics: mc(40) })]);
    expect(m.source).toBe('Metacritic');
    expect(m.meanGap).toBeCloseTo(20); // (30 + 10) / 2
  });
  it('ignores expectations recorded after watching', () => {
    const r = trailerInstinct([
      T({ expectation: 5, rating: 9, expectedAt: '2026-01-01T10:00:00Z', finishedAt: '2026-02-01' }),
      T({ expectation: 5, rating: 9, expectedAt: '2026-03-01T10:00:00Z', finishedAt: '2026-02-01' }),
    ]);
    expect(r.n).toBe(1);
  });
  it('one title is not evidence: averages are pulled toward your overall average', () => {
    const a = { name: 'A', role: 'director' as const };
    const ts = [T({ rating: 10, people: [a] }), T({ rating: 5 }), T({ rating: 6 })];
    expect(makerAffinity(ts)).toEqual([]); // needs two titles
    const [x] = makerAffinity([...ts, T({ rating: 10, people: [a] })], 2);
    expect(x.avg).toBe(10);
    expect(x.lift).toBeLessThan(10 - 7.75);
  });
  it('makers you rate above your average rise to the top', () => {
    const v = { name: 'Villeneuve', role: 'director' as const, qid: 'Q1' };
    const ts = [T({ rating: 9, people: [v] }), T({ rating: 9, people: [v] }), T({ rating: 4 }), T({ rating: 5 })];
    expect(makerAffinity(ts)[0]).toMatchObject({ key: 'Villeneuve', n: 2, qid: 'Q1' });
  });
  it('flags genres you hoard but rate low', () => {
    const h = ['Horror'];
    const ts = [
      ...[3, 3, 4].map((rating) => T({ rating, genres: h })),
      ...[8, 9, 8].map((rating) => T({ rating, genres: ['Drama'] })),
      ...[1, 2, 3].map(() => T({ status: 'want', genres: h })),
    ];
    expect(contradictions(ts)[0]).toMatchObject({ genre: 'Horror', waiting: 3 });
  });
});

describe('choosing', () => {
  it('respects filters and explains itself', () => {
    const keen = T({ status: 'want', expectation: 5, runtime: 95, genres: ['Drama'] });
    const long = T({ status: 'want', expectation: 5, runtime: 200, genres: ['Drama'] });
    const meh = T({ status: 'want', expectation: 2, runtime: 90, genres: ['Comedy'] });
    const picks = scoreCandidates([keen, long, meh].map((t) => ({ title: t, minutes: t.runtime })), [], { kind: 'any', maxMinutes: 130 });
    expect(picks.map((p) => p.c.title)).toEqual([keen, meh]);
    const unknown = T({ status: 'want', expectation: 5 });
    expect(scoreCandidates([{ title: unknown }], [], { kind: 'any', maxMinutes: 130 })).toEqual([]); // cannot promise to fit
    expect(scoreCandidates([{ title: unknown }], [], { kind: 'any' })).toHaveLength(1);
    expect(picks[0].reasons.join()).toMatch(/trailer/);
    expect(scoreCandidates([{ title: keen }], [], { kind: 'show' })).toEqual([]);
    expect(scoreCandidates([{ title: keen }, { title: meh }], [], { kind: 'any', genre: 'Comedy' })[0].c.title).toBe(meh);
  });
});

describe('handoff', () => {
  it('is deterministic and spoiler-bounded', () => {
    expect(questionsFor('wd:Q1')).toEqual(questionsFor('wd:Q1'));
    expect(new Set(questionsFor('wd:Q1')).size).toBe(3);
    const p = recapPrompt(T({ name: 'Severance', kind: 'show' }), { id: 1, titleId: 't', season: 2, number: 3, name: 'Who Is Alive?', airdate: '', airtime: '' });
    expect(p).toContain('S02E03');
    expect(p).toMatch(/nothing about anything that happens after/);
  });
});

import { reviewPrompt, parseThemes } from '../../src/lib/handoff';
describe('review prompt', () => {
  it('uses only what you said, marks guesses, and closes the themes loop', () => {
    const t = T({ name: 'Past Lives', year: 2023, rating: 9, partnerRating: 7, themes: ['memory', 'belonging'], note: 'the bar scene', expectation: 3, expectedAt: '2026-01-01', finishedAt: '2026-02-01' });
    const p = reviewPrompt(t, [t], { length: 'short', spoilers: false }, 'Sara');
    expect(p).toContain('My rating: 9/10 (Sara: 7/10)');
    expect(p).toContain('memory, belonging');
    expect(p).toContain('the bar scene');
    expect(p).toMatch(/Do not invent opinions/);
    expect(p).toMatch(/\[square brackets\]/);
    expect(p).toMatch(/No spoilers/);
    expect(p).toContain('better than I expected');
    expect(p).toMatch(/Themes: one; two; three$/);
    expect(reviewPrompt(T({ name: 'X' }), [], { length: 'full', spoilers: true })).toMatch(/ask me three short questions/);
  });
  it('reads a pasted "Themes:" line', () => {
    expect(parseThemes('Themes: Memory; belonging; the road not taken.')).toEqual(['memory', 'belonging', 'the road not taken']);
    expect(parseThemes('grief, grief')).toEqual(['grief']);
  });
});
