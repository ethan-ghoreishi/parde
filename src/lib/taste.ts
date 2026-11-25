import type { CriticScore, Dismissed, Episode, Title } from './db';

export const EXPECTATIONS = ['', 'Not for us', 'Unsure', 'Curious', 'Keen', 'Must see'] as const;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function pearson(pairs: [number, number][]): number {
  if (pairs.length < 3) return NaN;
  const mx = mean(pairs.map((p) => p[0]));
  const my = mean(pairs.map((p) => p[1]));
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
}

/** Spearman rank correlation: robust to the very different scales of critics' scores and yours. */
export function spearman(pairs: [number, number][]): number {
  const ranks = (xs: number[]) => {
    const sorted = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(xs.length);
    for (let i = 0; i < sorted.length; ) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1][0] === sorted[i][0]) j++;
      for (let k = i; k <= j; k++) r[sorted[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const a = ranks(pairs.map((p) => p[0]));
  const b = ranks(pairs.map((p) => p[1]));
  return pearson(a.map((x, i) => [x, b[i]]));
}

/**
 * Whether a correlation over n titles is more than chance: |t| ≥ 2, roughly the usual 5% level.
 * With 12 titles that needs r ≈ 0.53; with 30, r ≈ 0.36.
 */
export function reliable(r: number, n: number): boolean {
  if (Number.isNaN(r) || n < 4) return false;
  if (Math.abs(r) >= 1) return true;
  return Math.abs(r) * Math.sqrt((n - 2) / (1 - r * r)) >= 2;
}

/** A score in words that say what it measures. They are never averaged together or compared with each other. */
export function scoreText(c: CriticScore): string {
  switch (c.source) {
    case 'Rotten Tomatoes': return `${c.value} of critics positive (Rotten Tomatoes)`;
    case 'Rotten Tomatoes average': return `critics' average ${c.value} (Rotten Tomatoes)`;
    case 'Rotten Tomatoes audience': return `${c.value} of audience positive (Rotten Tomatoes)`;
    case 'Metacritic': return `Metascore ${c.value} (Metacritic)`;
    default: return `${c.value} from ${c.source} users`;
  }
}

export const tomatometer = (critics: CriticScore[] | undefined) => critics?.find((c) => c.source === 'Rotten Tomatoes')?.score;

export const rated = (titles: Title[]) => titles.filter((t) => t.rating !== undefined);

/** Averages from a handful of titles are pulled toward your overall average by this many "typical" titles. */
export const PRIOR = 3;

export interface Affinity {
  key: string;
  /** Your plain average across these titles */
  avg: number;
  n: number;
  /** How far above your overall average, after allowing for how few titles there are */
  lift: number;
  /** The titles behind it, best rated first */
  of: Title[];
  qid?: string;
}

function group(titles: Title[], keys: (t: Title) => { id?: string; key: string; qid?: string }[], min: number): Affinity[] {
  const r = rated(titles);
  const overall = mean(r.map((t) => t.rating!));
  const m = new Map<string, { key: string; qid?: string; of: Title[] }>();
  for (const t of r) {
    for (const k of new Map(keys(t).map((k) => [k.id ?? k.key, k])).values()) {
      const g = m.get(k.id ?? k.key) ?? { key: k.key, qid: k.qid, of: [] };
      g.of.push(t);
      m.set(k.id ?? k.key, g);
    }
  }
  return [...m.values()]
    .filter((g) => g.of.length >= min)
    .map((g) => {
      const sum = g.of.reduce((a, t) => a + t.rating!, 0);
      const n = g.of.length;
      return { ...g, avg: sum / n, n, lift: (sum + PRIOR * overall) / (n + PRIOR) - overall, of: [...g.of].sort((a, b) => b.rating! - a.rating!) };
    })
    .sort((a, b) => b.lift - a.lift || b.n - a.n);
}

/**
 * People are told apart by Wikidata id: two directors can share a name. A name without an id (TVmaze) belongs
 * to the one person known by it, if there is only one.
 */
function people(titles: Title[], want: (p: Title['people'][number]) => boolean) {
  const ids = new Map<string, Set<string>>();
  for (const t of titles) for (const p of t.people) if (p.qid) ids.set(p.name, (ids.get(p.name) ?? new Set()).add(p.qid));
  const idOf = (p: Title['people'][number]) => p.qid ?? (ids.get(p.name)?.size === 1 ? [...ids.get(p.name)!][0] : undefined);
  return (t: Title) => t.people.filter(want).map((p) => ({ id: idOf(p) ?? p.name, key: p.name, qid: idOf(p) }));
}

const isMaker = (p: Title['people'][number]) => p.role !== 'cast' && p.role !== 'composer';
export const makerAffinity = (titles: Title[], min = 2) => group(titles, people(titles, isMaker), min);
export const castAffinity = (titles: Title[], min = 2) => group(titles, people(titles, (p) => p.role === 'cast'), min);
export const genreAffinity = (titles: Title[], min = 3) => group(titles, (t) => t.genres.map((key) => ({ key })), min);
export const themeAffinity = (titles: Title[], min = 3) => group(titles, (t) => (t.themes ?? []).map((key) => ({ key })), min);
export const countryAffinity = (titles: Title[], min = 3) => group(titles, (t) => t.countries.map((key) => ({ key })), min);

// ---------- Choosing what to watch ----------

export interface Candidate {
  title: Title;
  /** For shows: the next episode to watch */
  episode?: Episode;
  minutes?: number;
}

export interface Choice {
  c: Candidate;
  score: number;
  reasons: string[];
}

export interface PickFilter {
  kind: 'any' | 'film' | 'show';
  maxMinutes?: number;
  genre?: string;
}

/** Ordered by what you have said and done: critics' and audience scores play no part. */
export function scoreCandidates(cands: Candidate[], library: Title[], f: PickFilter, today = new Date()): Choice[] {
  const makers = makerAffinity(library, 2);
  const genres = new Map(genreAffinity(library, 2).map((a) => [a.key, a]));
  return cands
    .filter((c) => f.kind === 'any' || c.title.kind === f.kind)
    // An unknown length cannot promise to fit a time limit.
    .filter((c) => !f.maxMinutes || (!!c.minutes && c.minutes <= f.maxMinutes))
    .filter((c) => !f.genre || c.title.genres.includes(f.genre))
    .map((c) => {
      const t = c.title;
      const reasons: string[] = [];
      let score = 0;
      if (t.expectation) {
        score += (t.expectation - 3) * 1.2;
        if (t.expectation >= 4) reasons.push(t.expectation === 5 ? 'A “must see” after the trailer' : 'You were keen after the trailer');
      }
      const a = makers.find((m) => m.lift > 0.4 && t.people.some((p) => isMaker(p) && (m.qid && p.qid ? m.qid === p.qid : m.key === p.name)));
      if (a) {
        score += Math.min(a.lift, 2);
        reasons.push(`${a.key}: you average ${a.avg.toFixed(1)} over ${a.n} of theirs`);
      }
      if (t.drawn?.length) reasons.push(`What drew you: ${t.drawn.join(', ')}`);
      const g = t.genres.map((x) => genres.get(x)).filter((x): x is Affinity => !!x).sort((a, b) => b.lift - a.lift)[0];
      if (g) score += g.lift * 0.5;
      if (c.episode && t.status === 'watching') {
        score += 1;
        reasons.push('You are in the middle of it');
      }
      const days = (today.getTime() - Date.parse(t.addedAt)) / 864e5;
      if (!c.episode && days > 120) {
        score += 0.4;
        reasons.push(`Waiting on your list for ${Math.round(days / 30)} months`);
      }
      return { c, score, reasons: reasons.slice(0, 3) };
    })
    .sort((a, b) => b.score - a.score);
}

// ---------- Insights ----------

export interface Gap {
  title: Title;
  /** Text of the other side: the keenness, or the score as published */
  ref: string;
}

/** Require a pre-watch entry from a version that actually enforced it. A same-day diary date is ambiguous. */
export const beforeWatching = (t: Title) => !!(t.instinctRecorded && t.expectedAt && t.firstWatchedAt && t.expectedAt < t.firstWatchedAt);

export const blindExpectation = (t: Title) => t.instinctRecorded && t.expectedAt ? !t.scoresAt || t.scoresAt > t.expectedAt : undefined;

/** Expectation 1–5 against enjoyment 1–10, in plain counts against your own average. */
export function trailerInstinct(titles: Title[]) {
  const pairs = titles.filter((t) => t.expectation && t.rating !== undefined && beforeWatching(t));
  const avg = mean(rated(titles).map((t) => t.rating!));
  const gap = (t: Title) => t.rating! - avg;
  const list = (ts: Title[]): Gap[] => ts.slice(0, 5).map((title) => ({ title, ref: EXPECTATIONS[title.expectation!] }));
  const keen = pairs.filter((t) => t.expectation! >= 4);
  const unsure = pairs.filter((t) => t.expectation! <= 2);
  return {
    n: pairs.length,
    r: spearman(pairs.map((t) => [t.expectation!, t.rating!])),
    keen: { n: keen.length, above: keen.filter((t) => t.rating! > avg).length },
    unsure: { n: unsure.length, above: unsure.filter((t) => t.rating! > avg).length },
    blind: pairs.filter((t) => blindExpectation(t)).length,
    aware: pairs.filter((t) => blindExpectation(t) === false).length,
    surprises: list(pairs.filter((t) => t.expectation! <= 2 && gap(t) >= 0.5).sort((a, b) => gap(b) - gap(a))),
    letdowns: list(pairs.filter((t) => t.expectation! >= 4 && gap(t) <= -0.5).sort((a, b) => gap(a) - gap(b))),
  };
}

/**
 * You against the critics, one source at a time, by order only: a 1–10 of yours and a critics' score are not the
 * same unit, so what can be compared is whether you rank titles alike. Disagreements are titles at opposite
 * ends of the two orders.
 */
export function versusCritics(titles: Title[]) {
  const rows = (source: string) =>
    rated(titles).flatMap((t) => {
      const c = t.critics.find((x) => x.source === source);
      return c ? [{ title: t, c }] : [];
    });
  const source = ['Metacritic', 'Rotten Tomatoes average', 'Rotten Tomatoes'].sort((a, b) => rows(b).length - rows(a).length)[0];
  const use = rows(source);
  const place = (xs: number[]) => (x: number) => (xs.filter((y) => y < x).length + xs.filter((y) => y === x).length / 2) / xs.length;
  const mine = place(use.map((r) => r.title.rating!));
  const theirs = place(use.map((r) => r.c.score));
  const gap = (r: (typeof use)[number]) => mine(r.title.rating!) - theirs(r.c.score);
  const list = (rs: typeof use): Gap[] => rs.slice(0, 5).map((r) => ({ title: r.title, ref: scoreText(r.c) }));
  return {
    source,
    n: use.length,
    r: spearman(use.map((r) => [r.c.score, r.title.rating!])),
    warmer: list(use.filter((r) => gap(r) >= 0.5).sort((a, b) => gap(b) - gap(a))),
    colder: list(use.filter((r) => gap(r) <= -0.5).sort((a, b) => gap(a) - gap(b))),
  };
}

// ---------- Scores and you ----------

export interface Tally {
  yes: number;
  n: number;
}
export interface Band {
  label: string;
  /** Titles with a Tomatometer in this band that you have rated */
  ratings: number[];
  /** Discover choices made before its scores were opened, and after */
  blind: Tally;
  aware: Tally;
}

/** Kept apart on purpose: what you choose without the scores, what you choose with them, and what you enjoy. */
export function scoreBands(titles: Title[], dismissed: Dismissed[]): Band[] {
  const bands: (Band & { min: number })[] = [
    { label: '80% or more', min: 80, ratings: [], blind: { yes: 0, n: 0 }, aware: { yes: 0, n: 0 } },
    { label: '60–79%', min: 60, ratings: [], blind: { yes: 0, n: 0 }, aware: { yes: 0, n: 0 } },
    { label: 'under 60%', min: 0, ratings: [], blind: { yes: 0, n: 0 }, aware: { yes: 0, n: 0 } },
  ];
  const band = (score: number | undefined) => (score === undefined ? undefined : bands.find((b) => score >= b.min));
  const choose = (score: number | undefined, yes: boolean, at: string, scoresAt?: string) => {
    const t = band(score)?.[!scoresAt || scoresAt > at ? 'blind' : 'aware'];
    if (t) (t.n++, (t.yes += yes ? 1 : 0));
  };
  for (const t of titles) {
    if (t.rating !== undefined) band(tomatometer(t.critics))?.ratings.push(t.rating);
    if (t.chosenAt) choose(tomatometer(t.choiceScores), true, t.chosenAt, t.scoresAt);
  }
  // A title you passed over and then added anyway was wanted in the end: counted there, not twice.
  const wanted = new Set(titles.map((t) => t.qid));
  for (const d of dismissed) if (d.measured && !wanted.has(d.qid)) choose(tomatometer(d.critics), false, d.at, d.scoresAt);
  return bands.map(({ min: _, ...b }) => b);
}

const ruleNames = [
  'Critics and audience both under 60%',
  'Critics under 60% and audience at least 70%',
  'Critics over 80% and audience under 70%',
  'IMDb 5.5–6.5',
  'IMDb over 7.5 and critics over 80%',
];

/** Find real cases to inspect. The two scores in a pair must have been reported within a year. */
export function scoreCases(titles: Title[], dismissed: Dismissed[]) {
  const cases = ruleNames.map((label) => ({ label, liked: [] as Title[], chosen: { yes: 0, n: 0 } }));
  const eligible = (scores: CriticScore[]) => {
    const critic = scores.find((c) => c.source === 'Rotten Tomatoes');
    const audience = scores.find((c) => c.source === 'Rotten Tomatoes audience');
    const imdb = scores.find((c) => c.source === 'IMDb');
    const paired = (other?: CriticScore) => critic?.asOf && other?.asOf &&
      Math.abs(Date.parse(critic.asOf) - Date.parse(other.asOf)) <= 366 * 864e5;
    const high = critic && critic.score > 80;
    return [
      critic && critic.score < 60 && paired(audience) && audience!.score < 60,
      critic && critic.score < 60 && paired(audience) && audience!.score >= 70,
      high && paired(audience) && audience!.score < 70,
      imdb && imdb.score >= 55 && imdb.score <= 65,
      high && paired(imdb) && imdb!.score > 75,
    ];
  };
  for (const t of rated(titles)) eligible(t.critics).forEach((fits, i) => { if (fits) cases[i].liked.push(t); });
  const count = (scores: CriticScore[], yes: boolean) => eligible(scores).forEach((fits, i) => {
    if (fits) {
      cases[i].chosen.n++;
      if (yes) cases[i].chosen.yes++;
    }
  });
  for (const t of titles) if (t.choiceScores && t.chosenAt) count(t.choiceScores, true);
  const have = new Set(titles.map((t) => t.qid));
  for (const d of dismissed) if (d.measured && !have.has(d.qid)) count(d.critics ?? [], false);
  return cases;
}

/** Whether two groups of your ratings differ by more than chance. Under five in either, there is nothing to say. */
export function compare(a: number[], b: number[]): 'few' | 'higher' | 'lower' | 'unclear' {
  if (a.length < 5 || b.length < 5) return 'few';
  const v = (xs: number[]) => xs.reduce((s, x) => s + (x - mean(xs)) ** 2, 0) / (xs.length - 1) / xs.length;
  const d = mean(a) - mean(b);
  const se = Math.sqrt(v(a) + v(b));
  // Identical ratings on both sides have no spread to judge by; a real difference with none is as clear as it gets.
  if (!se ? !d : Math.abs(d) / se < 2) return 'unclear';
  return d > 0 ? 'higher' : 'lower';
}

/** For each reason something drew you: how often, and how you liked what you went on to rate. */
export function drawnOutcomes(titles: Title[]) {
  const m = new Map<string, { n: number; ratings: number[] }>();
  for (const t of titles) {
    for (const why of t.drawn ?? []) {
      const g = m.get(why) ?? { n: 0, ratings: [] };
      g.n++;
      if (t.rating !== undefined) g.ratings.push(t.rating);
      m.set(why, g);
    }
  }
  return [...m].map(([why, g]) => ({ why, ...g })).sort((a, b) => b.n - a.n);
}

/** Genres you keep adding but don't enjoy as much as the rest. */
export function contradictions(titles: Title[]) {
  const want = titles.filter((t) => t.status === 'want');
  const counts = new Map<string, number>();
  for (const t of want) for (const g of t.genres) counts.set(g, (counts.get(g) ?? 0) + 1);
  return genreAffinity(titles, 3)
    .filter((a) => a.lift <= -0.7 && (counts.get(a.key) ?? 0) >= 3)
    .map((a) => ({ genre: a.key, avg: a.avg, lift: a.lift, waiting: counts.get(a.key)! }));
}

export function partnerSplits(titles: Title[]) {
  return titles
    .filter((t) => t.rating !== undefined && t.partnerRating !== undefined && Math.abs(t.rating - t.partnerRating) >= 3)
    .sort((a, b) => Math.abs(b.rating! - b.partnerRating!) - Math.abs(a.rating! - a.partnerRating!))
    .slice(0, 6);
}

export function counts<T extends string>(items: T[], top = 8): [T, number][] {
  const m = new Map<T, number>();
  for (const x of items) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
}

export const decade = (y?: number) => (y ? `${Math.floor(y / 10) * 10}s` : undefined);
export { mean };
