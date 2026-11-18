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
  it('compares only with critic scores, not audience ones', () => {
    const rt = (score: number) => [{ source: 'Rotten Tomatoes', value: `${score}%`, score }];
    const ts = [T({ rating: 9, critics: rt(50) }), T({ rating: 4, critics: rt(90) }), T({ rating: 8, critics: [{ source: 'IMDb', value: '8/10', score: 80 }] })];
    const r = versusCritics(ts);
    expect(r.n).toBe(2);
    expect(r.warmer[0].title).toBe(ts[0]);
    expect(r.colder[0].title).toBe(ts[1]);
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
