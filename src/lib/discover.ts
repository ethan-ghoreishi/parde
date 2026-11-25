import type { Dismissed, Title } from './db';
import { aboutSubject, credits, fromCountry, neighbours, type Find } from './api/wiki';
import { countryAffinity, makerAffinity, mean, rated, type Affinity } from './taste';
import seedRows from '../data/seed.json';

// ---------- Threads: where a shelf starts from ----------

/** A way in: something of yours, or somewhere you have not been. `key` is what the address keeps. */
export interface Thread {
  key: string;
  label: string;
  /** Why this one, in your own terms */
  why?: string;
}

/** Countries with a cinema worth wandering into. A list, not a ranking. */
export const PLACES: Record<string, string> = {
  Q794: 'Iran', Q884: 'South Korea', Q17: 'Japan', Q865: 'Taiwan', Q8646: 'Hong Kong', Q869: 'Thailand', Q881: 'Vietnam', Q43: 'Turkey', Q822: 'Lebanon',
  Q79: 'Egypt', Q1041: 'Senegal', Q230: 'Georgia', Q36: 'Poland', Q28: 'Hungary', Q218: 'Romania', Q33946: 'Czechoslovakia', Q15180: 'Soviet Union', Q41: 'Greece',
  Q35: 'Denmark', Q34: 'Sweden', Q20: 'Norway', Q33: 'Finland', Q189: 'Iceland', Q27: 'Ireland', Q45: 'Portugal', Q142: 'France', Q38: 'Italy',
  Q96: 'Mexico', Q414: 'Argentina', Q155: 'Brazil', Q298: 'Chile', Q739: 'Colombia', Q241: 'Cuba',
};
const placeId = (name: string) => Object.entries(PLACES).find(([, n]) => n === name)?.[0];

export const REVISIT: Thread = { key: 'revisit', label: 'Second look', why: 'Titles you previously passed on' };
export const DECADES = [1960, 1970, 1980, 1990, 2000, 2010, 2020];
export const KNOWN: Thread = { key: 'known', label: 'Remember what you’ve seen', why: 'Familiar films and series to add to your library' };
export const SERIES: Thread = { key: 'known:series', label: 'Remember a series', why: 'Familiar series to add or pick up again' };
const decade = (d: number): Thread => ({ key: `decade:${d}`, label: `The ${d}s`, why: `Films and series that began in the ${d}s` });
const avg1 = (a: Pick<Affinity, 'avg' | 'n'>) => `you average ${a.avg.toFixed(1)} over ${a.n}`;

/** Every way in your library suggests, most telling first. */
export function threads(library: Title[]): Thread[] {
  const r = rated(library);
  const loved = r.filter((t) => t.qid && t.rating! >= 8).sort((a, b) => b.rating! - a.rating! || b.updatedAt.localeCompare(a.updatedAt));
  const subjects = new Map<string, Title[]>();
  for (const t of loved) for (const s of t.subjects) subjects.set(s, [...(subjects.get(s) ?? []), t]);
  const seenFrom = new Set(library.flatMap((t) => t.countries));
  return [
    ...loved.slice(0, 12).map((t) => ({ key: `title:${t.qid}`, label: `Like ${t.name}`, why: `Shares its makers, subject or cast. You gave it ${t.rating}` })),
    ...makerAffinity(library).filter((a) => a.qid && a.lift > 0.3).slice(0, 8).map((a) => ({ key: `person:${a.qid}`, label: a.key, why: `Their other work: ${avg1(a)}` })),
    ...[...subjects].sort((a, b) => b[1].length - a[1].length).slice(0, 6).map(([s, ts]) => ({ key: `about:${s}`, label: `About ${s}`, why: `Like ${ts[0].name}` })),
    ...countryAffinity(library).flatMap((a) => (placeId(a.key) && a.lift > 0.2 ? [{ key: `place:${placeId(a.key)}`, label: `From ${a.key}`, why: avg1(a)[0].toUpperCase() + avg1(a).slice(1) }] : [])).slice(0, 3),
    ...Object.entries(PLACES).filter(([, n]) => !seenFrom.has(n)).map(([q, n]) => ({ key: `place:${q}`, label: `From ${n}`, why: 'Nothing from there in your library yet' })),
    ...DECADES.map(decade),
    KNOWN,
  ];
}

/** The thread an address names, with your own reason for it when there is one. */
export function threadOf(key: string, library: Title[], name = ''): Thread | undefined {
  if (key === REVISIT.key) return REVISIT;
  if (key === SERIES.key) return SERIES;
  const mine = threads(library).find((t) => t.key === key);
  if (mine) return mine;
  const [kind, ref] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  if ((kind === 'title' || kind === 'person') && !/^Q\d+$/.test(ref)) return undefined; // it goes into a query
  if (kind === 'title') return { key, label: `Like ${library.find((t) => t.qid === ref)?.name ?? (name || 'this title')}`, why: 'Shares its makers, subject or cast' };
  if (kind === 'person') return { key, label: name || 'This person', why: 'Their other work' };
  if (kind === 'about') return { key, label: `About ${ref}` };
  if (kind === 'place' && PLACES[ref]) return { key, label: `From ${PLACES[ref]}` };
  return undefined;
}

/** A handful to offer at once: a mix of kinds, turned over as `turn` goes up. */
export function offer(all: Thread[], turn: number): Thread[] {
  const by = (p: string) => all.filter((t) => t.key.startsWith(p));
  const unseen = by('place:').filter((t) => t.why?.startsWith('Nothing'));
  const some = (list: Thread[], n: number) => Array.from({ length: Math.min(n, list.length) }, (_, i) => list[(turn * n + i) % list.length]);
  const out = [...some(by('title:'), 2), ...some(by('person:'), 2), ...some(by('about:'), 1), ...some(by('place:').filter((t) => !unseen.includes(t)), 1), ...some(unseen, 1), ...some(by('decade:'), 1)];
  return out.length >= 5 ? out : [...out, ...by('decade:').filter((t) => !out.includes(t)), KNOWN].slice(0, 8);
}

// ---------- Shelves ----------

type Row = [qid: number, name: string, year: number, tvmaze: number, wiki?: string];
const seeds: Find[] = (seedRows as unknown as Row[]).map(([q, name, year, tvmaze, wiki]) => ({ qid: `Q${q}`, name, year, kind: tvmaze ? 'show' : 'film', tvmaze: tvmaze || undefined, wiki: wiki ?? name }));

const seedById = new Map(seeds.map((f) => [f.qid, f]));

export function revisitCandidates(dismissed: Dismissed[]): Find[] {
  return dismissed.flatMap((d) => {
    if (d.name && d.kind && d.year) return [{ qid: d.qid, name: d.name, kind: d.kind, year: d.year, tvmaze: d.tvmaze }];
    const seed = seedById.get(d.qid);
    return seed ? [seed] : [];
  });
}

/** Every title on a thread, most related or best known first. */
export async function lookUp(key: string): Promise<Find[]> {
  const ref = key.slice(key.indexOf(':') + 1);
  if (key.startsWith('title:')) return neighbours(ref);
  if (key.startsWith('person:')) {
    const all = (await credits([ref])).sort((a, b) => (b.known ?? 0) - (a.known ?? 0));
    // A director's cameos are not their work; an actor's roles are.
    const made = all.filter((c) => c.roles.some((r) => r !== 'acted'));
    return made.length >= 4 ? made : all;
  }
  if (key.startsWith('about:')) return aboutSubject(ref);
  if (key.startsWith('place:')) return fromCountry(ref);
  if (key === SERIES.key) return seeds.filter((s) => s.kind === 'show');
  if (key.startsWith('decade:')) return seeds.filter((s) => s.year! >= Number(ref) && s.year! < Number(ref) + 10);
  return seeds;
}

export const SHELF = 12;

/** Browse every eligible candidate once per thread, with familiar titles first on the collection shelf. */
export function shelf(all: Find[], library: Title[], dismissed: Set<string>, shown: Set<string>, year = new Date().getFullYear(), mix = true): Find[] {
  const have = new Set(library.flatMap((t) => [t.qid ?? t.id.replace(/^wd:/, ''), t.tvmaze ? `tvm:${t.tvmaze}` : t.id]));
  const list = [...new Map(all.map((f) => [f.tvmaze ? `tvm:${f.tvmaze}` : f.qid, f])).values()]
    .filter((f) => f.year && f.year <= year && !have.has(f.qid) && !have.has(`tvm:${f.tvmaze}`) && !dismissed.has(f.qid) && !shown.has(f.qid));
  if (!mix || list.length <= SHELF) return list.slice(0, SHELF);
  const rest = list.slice(8);
  return [...list.slice(0, 8), ...[0, 1, 2, 3].map((i) => rest[Math.floor(i * rest.length / 4)])];
}

// ---------- What a choice just told you ----------

const ordinals = new Intl.PluralRules('en', { type: 'ordinal' });
const nth = (n: number) => `${n}${{ one: 'st', two: 'nd', few: 'rd' }[ordinals.select(n) as 'one'] ?? 'th'}`;

/** One plain line about the rating you just gave, and where it leads. Nothing is said without other ratings behind it. */
export function insight(t: Pick<Title, 'id' | 'people' | 'countries' | 'rating'>, library: Title[]): { text: string; thread?: Thread } | undefined {
  const others = rated(library.filter((x) => x.id !== t.id));
  if (!t.rating) return undefined;
  for (const p of t.people.filter((p) => p.role === 'director' || p.role === 'creator')) {
    const same = others.filter((x) => x.people.some((y) => y.role !== 'cast' && (p.qid && y.qid ? y.qid === p.qid : y.name === p.name)));
    if (!same.length) continue;
    const all = [...same.map((x) => x.rating!), t.rating];
    return { text: `Your ${nth(all.length)} by ${p.name}: ${mean(all).toFixed(1)} on average.`, thread: p.qid ? { key: `person:${p.qid}`, label: `More by ${p.name}` } : undefined };
  }
  for (const c of t.countries.filter((c) => placeId(c))) {
    const same = others.filter((x) => x.countries.includes(c));
    if (same.length < 2) continue;
    const all = [...same.map((x) => x.rating!), t.rating];
    return { text: `Your ${nth(all.length)} from ${c}: ${mean(all).toFixed(1)} on average.`, thread: { key: `place:${placeId(c)}`, label: `More from ${c}` } };
  }
  return undefined;
}

/** What drew you to something you want to see: yours to say, never required. */
export const REASONS = ['the people', 'the story', 'the trailer', 'how it looks', 'good reviews', 'mixed reviews', 'someone said so', 'just curious'] as const;

/** Enough to decide by: what it is, then the first sentence that says what happens. */
export function premise(text: string | undefined): string {
  if (!text) return '';
  // Sentences, without breaking at initials or titles ("L.A. Confidential", "Dr. Strangelove")
  const all: string[] = [];
  for (const part of text.replace(/\s+/g, ' ').split(/(?=[.!?]["”)]? ["“(A-Z])/)) {
    const prev = all.at(-1);
    const piece = prev === undefined ? part : part.replace(/^([.!?]["”)]?) /, '');
    const stop = part.slice(0, part.length - piece.length).trim();
    if (prev === undefined) all.push(piece);
    else if (/(^|[\s.])(\p{Lu}|Mr|Mrs|Ms|Dr|St|Jr|Sr|vs)$/u.test(prev)) all[all.length - 1] = `${prev}${stop} ${piece}`;
    else (all[all.length - 1] = prev + stop), all.push(piece);
  }
  const story = all.slice(1).find((x) => /\b(follows|tells|centers|centres|revolves|depicts|concerns|set in|story|plot)\b/i.test(x)) ?? all[1] ?? '';
  return `${all[0]} ${story}`.trim();
}
