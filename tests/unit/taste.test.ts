import { describe, expect, it } from 'vitest';
import { trailerInstinct, versusCritics, scoreCandidates, scoreBands, scoreRules, scoreText, compare, drawnOutcomes, makerAffinity, castAffinity, contradictions, beforeWatching, pearson } from '../../src/lib/taste';
import { questionsFor, recapPrompt, reflectPrompt } from '../../src/lib/handoff';
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
    const ts = [T({ expectation: 1, rating: 9 }), T({ expectation: 5, rating: 2 }), T({ expectation: 3, rating: 5 })].map((t) => ({ ...t, expectedAt: '2026-01-01T10:00:00Z', firstWatchedAt: '2026-01-02' }));
    const r = trailerInstinct(ts);
    expect(r.n).toBe(3);
    expect(r.surprises[0].title).toBe(ts[0]);
    expect(r.letdowns[0].title).toBe(ts[1]);
  });
  it('compares with one kind of critics’ score at a time, by order only, never unit for unit', () => {
    const rt = (score: number) => [{ source: 'Rotten Tomatoes', value: `${score}%`, score }];
    const ts = [T({ rating: 9, critics: rt(50) }), T({ rating: 4, critics: rt(90) }), T({ rating: 7, critics: rt(80) }), T({ rating: 8, critics: [{ source: 'IMDb', value: '8/10', score: 80 }] })];
    const r = versusCritics(ts);
    expect(r).toMatchObject({ source: 'Rotten Tomatoes', n: 3 });
    expect(r).not.toHaveProperty('meanGap'); // no "N points warmer" between two different scales
    expect(r.warmer.map((x) => x.title)).toEqual([ts[0]]);
    expect(r.colder.map((x) => x.title)).toEqual([ts[1]]);
    // Rating everything two points under the critics but in the same order is agreement, not disagreement.
    const mc = (score: number) => [{ source: 'Metacritic', value: `${score}/100`, score }];
    const same = versusCritics([60, 70, 80, 90].map((s, i) => T({ rating: 4 + i, critics: mc(s) })));
    expect(same.r).toBeCloseTo(1);
    expect([...same.warmer, ...same.colder]).toEqual([]);
  });
  it('ignores expectations recorded after watching', () => {
    const r = trailerInstinct([
      T({ expectation: 5, rating: 9, expectedAt: '2026-01-01T10:00:00Z', finishedAt: '2026-02-01', firstWatchedAt: '2026-02-01' }),
      T({ expectation: 5, rating: 9, expectedAt: '2026-03-01T10:00:00Z', finishedAt: '2026-02-01', firstWatchedAt: '2026-02-01' }),
    ]);
    expect(r).toMatchObject({ n: 1, uncounted: 1 });
  });
  it('counts the trailer before dinner and the film after it, and leaves out what it cannot date', () => {
    const t = (o: Partial<Title>) => T({ expectation: 5, rating: 9, ...o });
    const at = (o: Partial<Title>) => beforeWatching(t(o));
    const noon = new Date('2026-02-01T12:00:00').toISOString();
    expect(at({ expectedAt: noon, firstWatchedAt: '2026-02-01' })).toBe(true); // logged for the same day
    expect(at({ expectedAt: noon, firstWatchedAt: '2026-01-31' })).toBe(false); // logged for the day before
    expect(at({ expectedAt: noon, firstWatchedAt: new Date('2026-02-01T11:00:00').toISOString() })).toBe(false); // an hour earlier
    expect(at({ expectedAt: noon, finishedAt: '2026-03-01' })).toBe(true); // recorded by an earlier version
    expect(at({ expectedAt: noon, firstWatchedAt: '2026-03-01', finishedAt: '2019-01-01' })).toBe(false); // an imported date from before
    expect(at({ expectedAt: noon })).toBe(false); // seen, nothing says when
    expect(at({ expectedAt: noon, firstWatchedAt: '2026-03-01', hindsight: true })).toBe(false); // marked in bulk, or imported without a date
    expect(at({ firstWatchedAt: '2026-03-01' })).toBe(false);
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
  it('tells two people with one name apart, and gives a name without an id to the only one it can be', () => {
    const steve = (qid?: string) => ({ name: 'Steve McQueen', role: 'director' as const, ...(qid ? { qid } : {}) });
    const two = [T({ rating: 9, people: [steve('Q1')] }), T({ rating: 9, people: [steve('Q1')] }), T({ rating: 3, people: [steve('Q2')] }), T({ rating: 2, people: [steve('Q2')] })];
    expect(makerAffinity(two).map((a) => [a.qid, a.avg])).toEqual([['Q1', 9], ['Q2', 2.5]]);
    const cast = (qid?: string) => ({ name: 'A', role: 'cast' as const, ...(qid ? { qid } : {}) });
    expect(castAffinity([T({ rating: 8, people: [cast('Q9')] }), T({ rating: 6, people: [cast()] })])[0]).toMatchObject({ n: 2, qid: 'Q9' });
  });
  it('shows the titles behind a pattern, best first', () => {
    const v = { name: 'V', role: 'director' as const, qid: 'Q1' };
    const ts = [T({ rating: 6, people: [v] }), T({ rating: 9, people: [v] })];
    expect(makerAffinity(ts)[0].of).toEqual([ts[1], ts[0]]);
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

describe('scores and you', () => {
  const rt = (score: number) => [{ source: 'Rotten Tomatoes', value: `${score}%`, score }];
  it('keeps choices made without the scores apart from choices made with them, and from enjoyment', () => {
    const b = scoreBands(
      [
        T({ status: 'want', critics: rt(91), choiceScores: rt(40), chosenAt: '2026-01-02', scoresAt: undefined }),
        T({ status: 'want', critics: rt(91), choiceScores: rt(40), chosenAt: '2026-01-02', scoresAt: '2026-01-03' }), // opened only afterwards
        T({ status: 'want', choiceScores: rt(90), chosenAt: '2026-01-02', scoresAt: '2026-01-01' }),
        T({ rating: 8, critics: rt(45) }),
        T({ status: 'want', critics: rt(10) }), // not chosen in Discover: says nothing about instinct
      ],
      [
        { qid: 'Q91', at: '2026-01-02', name: 'x', critics: rt(30), scoresAt: '2026-01-01' },
        { qid: 'Q92', at: '2026-01-02', name: 'y', critics: rt(95) },
        { qid: 'Q93', at: '2026-01-02' }, // from an earlier version: nothing known about it
      ],
    );
    expect(b.map((x) => [x.ratings, x.blind, x.aware])).toEqual([
      [[], { yes: 0, n: 1 }, { yes: 1, n: 1 }],
      [[], { yes: 0, n: 0 }, { yes: 0, n: 0 }],
      [[8], { yes: 2, n: 2 }, { yes: 0, n: 1 }],
    ]);
  });
  it('saves and passes from the previous version count alike', () => {
    const b = scoreBands([T({ status: 'want', chosenAt: '2026-01-02', critics: rt(90) })], [{ qid: 'Q91', at: '2026-01-02', name: 'x', critics: rt(90) }]);
    expect(b[0].blind).toEqual({ yes: 1, n: 2 });
  });
  it('tests a rule of thumb against the titles with the same scores that do not fit it', () => {
    const s = (source: string, score: number, asOf = '2025-07') => ({ source, score, value: `${score}`, asOf });
    const both = (c: number, i: number, o: Partial<Title> = {}) => T({ year: 2000, critics: [s('Rotten Tomatoes', c), s('IMDb', i)], ...o });
    const fits = both(92, 81, { rating: 9 });
    const misses = both(92, 60, { rating: 5 });
    const r = scoreRules([fits, misses, T({ rating: 10, critics: [s('Rotten Tomatoes', 92)] })], []);
    const rule = (text: RegExp) => r.find((x) => text.test(x.label))!;
    expect(rule(/IMDb over 7.5/)).toMatchObject({ fit: [fits], rest: [5] }); // the one without IMDb is in neither
    expect(rule(/IMDb around 6/)).toMatchObject({ fit: [misses], rest: [9] });
    expect(rule(/audience under 70/)).toMatchObject({ audience: true, fit: [], rest: [] });
  });
  it('reads two scores together only if they were taken together, or long after release', () => {
    const t = (year: number, rt: string, imdb: string) => T({ rating: 9, year, critics: [{ source: 'Rotten Tomatoes', score: 92, value: '92%', asOf: rt }, { source: 'IMDb', score: 81, value: '8.1/10', asOf: imdb }] });
    const n = (x: Title) => scoreRules([x], [])[4].fit.length;
    expect(n(t(2023, '2023-09', '2024-02'))).toBe(1);
    expect(n(t(2023, '2023-09', '2026-02'))).toBe(0); // a first week against years later
    expect(n(t(1999, '2019-01', '2026-02'))).toBe(1); // settled long before either
  });
  it('only choices made with the scores open say anything about a rule', () => {
    const scores = [{ source: 'IMDb', score: 60, value: '6/10', asOf: '2025-07' }];
    const r = scoreRules(
      [T({ status: 'want', choiceScores: scores, chosenAt: '2026-01-02', scoresAt: '2026-01-01' }), T({ status: 'want', choiceScores: scores, chosenAt: '2026-01-02' }), T({ status: 'want', choiceScores: [], critics: scores, chosenAt: '2026-01-02', scoresAt: '2026-01-01' })],
      [{ qid: 'Q91', at: '2026-01-02', name: 'x', critics: scores, scoresAt: '2026-01-01' }, { qid: 'Q92', at: '2026-01-02', name: 'y', critics: scores }],
    );
    expect(r[3].knowing).toEqual({ yes: 1, n: 2 });
  });
  it('says two groups differ only with enough titles and more than chance', () => {
    expect(compare([9, 9, 9, 9], [1, 1, 1, 1])).toBe('few');
    expect(compare([9, 9, 8, 9, 9], [4, 5, 4, 5, 4])).toBe('higher');
    expect(compare([4, 5, 4, 5, 4], [9, 9, 8, 9, 9])).toBe('lower');
    expect(compare([9, 3, 8, 5, 7], [8, 4, 9, 6, 5])).toBe('unclear');
    expect(compare([7, 7, 7, 7, 7], [7, 7, 7, 7, 7])).toBe('unclear');
  });
  it('every kind of score says what it measures', () => {
    expect(scoreText({ source: 'Rotten Tomatoes', value: '84%', score: 84 })).toMatch(/84% of critics positive/);
    expect(scoreText({ source: 'TVmaze', value: '8.4/10', score: 84 })).toBe('8.4/10 from TVmaze users');
  });
  it('what drew you, against what you made of it', () => {
    expect(drawnOutcomes([T({ drawn: ['the people'], rating: 9 }), T({ drawn: ['the people', 'the trailer'], status: 'want' })])).toEqual([
      { why: 'the people', n: 2, ratings: [9] },
      { why: 'the trailer', n: 1, ratings: [] },
    ]);
  });
  it('knows which keenness came before the scores, which after, and which it cannot know', () => {
    const t = (o: Partial<Title>) => T({ expectation: 4, rating: 7, expectedAt: '2026-01-05T10:00:00Z', firstWatchedAt: '2026-01-06', ...o });
    const edited = { expectation: '2026-01-05T10:00:00Z' };
    const r = trailerInstinct([t({}), t({ edited }), t({ edited, scoresAt: '2026-01-01T00:00:00Z' })]);
    expect([r.n, r.blind, r.aware]).toEqual([3, 1, 1]);
  });
});

describe('choosing', () => {
  it('critics’ and audience scores play no part in what is suggested', () => {
    const c = (score: number) => [{ source: 'Metacritic', value: `${score}/100`, score }, { source: 'TVmaze', value: `${score / 10}/10`, score }];
    const order = (a: number, b: number) => scoreCandidates([T({ name: 'A', status: 'want', critics: c(a) }), T({ name: 'B', status: 'want', critics: c(b) })].map((title) => ({ title })), [], { kind: 'any' }).map((x) => [x.c.title.name, x.score]);
    expect(order(10, 99)).toEqual(order(99, 10));
  });
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
  it('never asks for spoilers past where you are in a series', () => {
    const ep = { id: 1, titleId: 't', season: 2, number: 3, name: '', airdate: '2020-01-01', airtime: '' };
    const show = T({ name: 'Severance', kind: 'show', status: 'watching', showStatus: 'Ended' });
    const mid = { lastSeen: ep, next: { ...ep, number: 4 }, skipped: 1, unlisted: 0 };
    for (const p of [reflectPrompt(show, [], mid), reviewPrompt(show, [], { length: 'short', spoilers: true }, mid), reviewPrompt(show, [], { length: 'short', spoilers: false }, mid)]) {
      expect(p).toContain('only up to and including S02E03');
      expect(p).not.toContain('Spoilers are fine');
      expect(p).toContain('skipped 1 earlier episode');
    }
    expect(reflectPrompt(show, [], mid)).toContain('I am watching');
    expect(reflectPrompt(show, [], { skipped: 0, unlisted: 0 })).toContain('Ask me how far I am');
    expect(reflectPrompt(show, [], { lastSeen: ep, skipped: 0, unlisted: 0, scheduleVerified: true })).toContain('Spoilers are fine'); // seen to the end
    expect(reflectPrompt({ ...show, showStatus: 'Running' }, [], { lastSeen: ep, skipped: 0, unlisted: 0 })).toContain('only up to and including'); // caught up, not over
    expect(reflectPrompt(T({ name: 'Heat' }))).toContain('Spoilers are fine');
    for (let i = 0; i < 40; i++) expect(questionsFor(`tvm:${i}`, false).join()).not.toMatch(/ending/);
  });
});

import { reviewPrompt, parseThemes } from '../../src/lib/handoff';
describe('review prompt', () => {
  it('uses only what you said, marks guesses, and closes the themes loop', () => {
    const t = T({ name: 'Past Lives', year: 2023, rating: 9, partnerRating: 7, themes: ['memory', 'belonging'], note: 'the bar scene', expectation: 3, expectedAt: '2026-01-01', finishedAt: '2026-02-01', firstWatchedAt: '2026-02-01' });
    const p = reviewPrompt(t, [t], { length: 'short', spoilers: false });
    expect(p).toContain('My rating: 9/10 (my partner: 7/10)'); // no one else's name leaves the device
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

import { reliable } from '../../src/lib/taste';
describe('evidence', () => {
  it('calls a correlation reliable only when it beats chance for that many titles', () => {
    expect(reliable(0.5, 12)).toBe(false);
    expect(reliable(0.6, 12)).toBe(true);
    expect(reliable(0.4, 30)).toBe(true);
    expect(reliable(-0.7, 12)).toBe(true);
    expect(reliable(NaN, 40)).toBe(false);
  });
});
