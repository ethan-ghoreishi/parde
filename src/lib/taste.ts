import type { Episode, Title } from './db';

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

/** One from each person in turn, most trusted first, so one prolific director cannot fill the list. */
export function interleave<T extends { via: string }>(items: T[], order: string[]): T[] {
  const queues = order.map((q) => items.filter((x) => x.via === q));
  const out: T[] = [];
  for (let i = 0; queues.some((q) => q.length > i); i++) for (const q of queues) if (q[i]) out.push(q[i]);
  return out;
}

export interface Reference {
  score: number;
  source: string;
  kind: 'critics' | 'audience';
}

/**
 * The outside view of a title. Metacritic first (a weighted average of review scores), then the
 * Tomatometer (the share of positive reviews, not a score), then audience ratings.
 */
export function criticScore(t: Pick<Title, 'critics'>): Reference | undefined {
  for (const source of ['Metacritic', 'Rotten Tomatoes']) {
    const c = t.critics.find((x) => x.source === source);
    if (c) return { score: c.score, source, kind: 'critics' };
  }
  const aud = t.critics.find((x) => x.source === 'IMDb') ?? t.critics.find((x) => x.source === 'TVmaze');
  return aud && { score: aud.score, source: aud.source, kind: 'audience' };
}

export const referenceText = (r: Reference) =>
  r.source === 'Rotten Tomatoes' ? `${r.score}% of critics positive` : r.source === 'Metacritic' ? `Metacritic ${r.score}` : `${r.source} users ${(r.score / 10).toFixed(1)}/10`;

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
  titles: string[];
  qid?: string;
}

function group(titles: Title[], keys: (t: Title) => { key: string; qid?: string }[], min: number): Affinity[] {
  const r = rated(titles);
  const overall = mean(r.map((t) => t.rating!));
  const m = new Map<string, { sum: number; n: number; titles: string[]; qid?: string }>();
  for (const t of r) {
    for (const k of new Map(keys(t).map((k) => [k.key, k])).values()) {
      const g = m.get(k.key) ?? { sum: 0, n: 0, titles: [], qid: k.qid };
      g.sum += t.rating!;
      g.n++;
      g.titles.push(t.name);
      g.qid ??= k.qid;
      m.set(k.key, g);
    }
  }
  return [...m.entries()]
    .filter(([, g]) => g.n >= min)
    .map(([key, g]) => ({ key, avg: g.sum / g.n, n: g.n, lift: (g.sum + PRIOR * overall) / (g.n + PRIOR) - overall, titles: g.titles, qid: g.qid }))
    .sort((a, b) => b.lift - a.lift || b.n - a.n);
}

export const makerAffinity = (titles: Title[], min = 2) =>
  group(titles, (t) => t.people.filter((p) => p.role !== 'cast' && p.role !== 'composer').map((p) => ({ key: p.name, qid: p.qid })), min);
export const castAffinity = (titles: Title[], min = 2) =>
  group(titles, (t) => t.people.filter((p) => p.role === 'cast').map((p) => ({ key: p.name, qid: p.qid })), min);
export const genreAffinity = (titles: Title[], min = 3) => group(titles, (t) => t.genres.map((g) => ({ key: g })), min);
export const themeAffinity = (titles: Title[], min = 3) => group(titles, (t) => (t.themes ?? []).map((g) => ({ key: g })), min);

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

export function scoreCandidates(cands: Candidate[], library: Title[], f: PickFilter, today = new Date()): Choice[] {
  const makers = new Map(makerAffinity(library, 2).map((a) => [a.key, a]));
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
        if (t.expectation >= 4) reasons.push(`You were ${t.expectation === 5 ? 'desperate to see it' : 'keen'} after the trailer`);
      }
      const cs = criticScore(t);
      if (cs) {
        score += (cs.score - 70) / 15;
        if (cs.score >= 85) reasons.push(referenceText(cs));
      }
      for (const p of t.people) {
        const a = makers.get(p.name);
        if (a && a.lift > 0.4 && p.role !== 'cast') {
          score += Math.min(a.lift, 2);
          reasons.push(`${p.name}: you rated their other ${a.n} ${a.avg.toFixed(1)} on average`);
          break;
        }
      }
      const g = t.genres.map((x) => genres.get(x)).filter((x): x is Affinity => !!x).sort((a, b) => b.lift - a.lift)[0];
      if (g) score += g.lift * 0.5;
      if (c.episode) {
        score += 1;
        reasons.push(t.status === 'watching' ? 'You are in the middle of it' : 'Ready to start');
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
  /** your score minus the reference, on a 0–100 scale */
  gap: number;
  ref: number;
}

/** An expectation recorded after the viewing is hindsight, not a prediction. */
export const beforeWatching = (t: Title) => !(t.expectedAt && t.finishedAt && t.expectedAt.slice(0, 10) > t.finishedAt.slice(0, 10));

/** Expectation 1–5 against enjoyment 1–10, both mapped to 0–100. */
export function trailerInstinct(titles: Title[]) {
  const pairs = titles.filter((t) => t.expectation && t.rating !== undefined && beforeWatching(t));
  const avg = mean(rated(titles).map((t) => t.rating!));
  const gaps: Gap[] = pairs.map((t) => ({ title: t, ref: (t.expectation! - 1) * 25, gap: (t.rating! - 1) * (100 / 9) - (t.expectation! - 1) * 25 }));
  const keen = pairs.filter((t) => t.expectation! >= 4);
  const unsure = pairs.filter((t) => t.expectation! <= 2);
  return {
    n: pairs.length,
    r: spearman(pairs.map((t) => [t.expectation!, t.rating!])),
    /** Plain counts read better than a coefficient while there are few titles */
    keen: { n: keen.length, above: keen.filter((t) => t.rating! > avg).length },
    unsure: { n: unsure.length, above: unsure.filter((t) => t.rating! > avg).length },
    surprises: gaps.filter((g) => g.gap >= 25).sort((a, b) => b.gap - a.gap).slice(0, 5),
    letdowns: gaps.filter((g) => g.gap <= -25).sort((a, b) => a.gap - b.gap).slice(0, 5),
  };
}

/**
 * You against the critics, one source at a time. A level comparison ("warmer by N points") only for
 * Metacritic; with the Tomatometer only rank agreement and clear disagreements make sense.
 */
export function versusCritics(titles: Title[]) {
  const rows = (source: string) =>
    rated(titles).flatMap((t) => {
      const c = t.critics.find((x) => x.source === source);
      return c ? [{ title: t, ref: c.score, gap: t.rating! * 10 - c.score }] : [];
    });
  const mc = rows('Metacritic');
  const rt = rows('Rotten Tomatoes');
  const source = mc.length >= 5 || mc.length >= rt.length ? 'Metacritic' : 'Rotten Tomatoes';
  const use = source === 'Metacritic' ? mc : rt;
  const isMc = source === 'Metacritic';
  return {
    source,
    n: use.length,
    meanGap: isMc ? mean(use.map((r) => r.gap)) : NaN,
    r: spearman(use.map((r) => [r.ref, r.title.rating!])),
    warmer: use.filter((r) => (isMc ? r.gap >= 15 : r.title.rating! >= 8 && r.ref <= 60)).sort((a, b) => b.gap - a.gap).slice(0, 5),
    colder: use.filter((r) => (isMc ? r.gap <= -15 : r.title.rating! <= 5 && r.ref >= 85)).sort((a, b) => a.gap - b.gap).slice(0, 5),
  };
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
