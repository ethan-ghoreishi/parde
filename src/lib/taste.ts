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

/** Critics' view, 0–100: Rotten Tomatoes / Metacritic when present, else audience scores. */
export function criticScore(t: Pick<Title, 'critics'>): { score: number; kind: 'critics' | 'audience' } | undefined {
  const crit = t.critics.filter((c) => c.source === 'Rotten Tomatoes' || c.source === 'Metacritic');
  if (crit.length) return { score: Math.round(mean(crit.map((c) => c.score))), kind: 'critics' };
  const aud = t.critics.filter((c) => c.source === 'IMDb' || c.source === 'TVmaze');
  if (aud.length) return { score: Math.round(mean(aud.map((c) => c.score))), kind: 'audience' };
  return undefined;
}

export const rated = (titles: Title[]) => titles.filter((t) => t.rating !== undefined);

export interface Affinity {
  key: string;
  avg: number;
  n: number;
  /** avg minus your overall average */
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
    .map(([key, g]) => ({ key, avg: g.sum / g.n, n: g.n, lift: g.sum / g.n - overall, titles: g.titles, qid: g.qid }))
    .sort((a, b) => b.lift - a.lift || b.n - a.n);
}

export const makerAffinity = (titles: Title[], min = 2) =>
  group(titles, (t) => t.people.filter((p) => p.role !== 'cast' && p.role !== 'composer').map((p) => ({ key: p.name, qid: p.qid })), min);
export const castAffinity = (titles: Title[], min = 2) =>
  group(titles, (t) => t.people.filter((p) => p.role === 'cast').map((p) => ({ key: p.name, qid: p.qid })), min);
export const genreAffinity = (titles: Title[], min = 3) => group(titles, (t) => t.genres.map((g) => ({ key: g })), min);

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
  const makers = new Map(makerAffinity(library, 1).map((a) => [a.key, a]));
  const genres = new Map(genreAffinity(library, 2).map((a) => [a.key, a]));
  return cands
    .filter((c) => f.kind === 'any' || c.title.kind === f.kind)
    .filter((c) => !f.maxMinutes || !c.minutes || c.minutes <= f.maxMinutes)
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
        if (cs.score >= 85) reasons.push(`${cs.kind === 'critics' ? 'Critics' : 'Audiences'} rate it ${cs.score}%`);
      }
      for (const p of t.people) {
        const a = makers.get(p.name);
        if (a && a.lift > 0.5 && p.role !== 'cast') {
          score += Math.min(a.lift, 2);
          reasons.push(`${p.name}: you average ${a.avg.toFixed(1)} across ${a.n}`);
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

/** Expectation 1–5 against enjoyment 1–10, both mapped to 0–100. */
export function trailerInstinct(titles: Title[]) {
  const pairs = titles.filter((t) => t.expectation && t.rating !== undefined);
  const gaps: Gap[] = pairs.map((t) => ({ title: t, ref: (t.expectation! - 1) * 25, gap: (t.rating! - 1) * (100 / 9) - (t.expectation! - 1) * 25 }));
  return {
    n: pairs.length,
    r: pearson(pairs.map((t) => [t.expectation!, t.rating!])),
    surprises: gaps.filter((g) => g.gap >= 25).sort((a, b) => b.gap - a.gap).slice(0, 5),
    letdowns: gaps.filter((g) => g.gap <= -25).sort((a, b) => a.gap - b.gap).slice(0, 5),
  };
}

export function versusCritics(titles: Title[]) {
  const rows = rated(titles)
    .map((t) => ({ t, cs: criticScore(t) }))
    .filter((x) => x.cs?.kind === 'critics')
    .map(({ t, cs }) => ({ title: t, ref: cs!.score, gap: t.rating! * 10 - cs!.score }));
  return {
    n: rows.length,
    meanGap: mean(rows.map((r) => r.gap)),
    r: pearson(rows.map((r) => [r.ref, r.title.rating!])),
    warmer: rows.filter((r) => r.gap >= 15).sort((a, b) => b.gap - a.gap).slice(0, 5),
    colder: rows.filter((r) => r.gap <= -15).sort((a, b) => a.gap - b.gap).slice(0, 5),
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
