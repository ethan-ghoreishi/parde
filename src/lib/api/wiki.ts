import type { CriticScore, Person, Role, Title } from '../db';
import { getJson, qs } from './http';

/** Metadata fields of a Title (everything the user does not set). */
export type Meta = Pick<
  Title,
  | 'kind' | 'name' | 'year' | 'poster' | 'overview' | 'genres' | 'runtime' | 'people' | 'subjects'
  | 'countries' | 'languages' | 'critics' | 'trailer' | 'qid' | 'imdb' | 'tvmaze' | 'wiki'
  | 'network' | 'webChannel' | 'showStatus' | 'tvmUpdated'
>;

export interface FilmHit {
  qid: string;
  wiki: string;
  name: string;
  description: string;
  year?: number;
}

const WP = 'https://en.wikipedia.org/w/api.php';
const WD = 'https://www.wikidata.org/w/api.php';

export async function searchFilms(q: string): Promise<FilmHit[]> {
  const res = await getJson<{
    query?: { pages: { title: string; index: number; description?: string; pageprops?: { wikibase_item?: string } }[] };
  }>(
    `${WP}?${qs({
      action: 'query', format: 'json', formatversion: 2, origin: '*',
      generator: 'search', gsrsearch: `${q} hastemplate:"Infobox film"`, gsrlimit: 10,
      prop: 'description|pageprops', ppprop: 'wikibase_item',
    })}`,
  );
  return rankByTitle(q, (res.query?.pages ?? []).filter((p) => p.pageprops?.wikibase_item).sort((a, b) => a.index - b.index))
    .map((p) => ({
      qid: p.pageprops!.wikibase_item!,
      wiki: p.title,
      name: p.title.replace(/ \((\d{4} )?film\)$/, ''),
      description: p.description ?? '',
      year: Number(p.description?.match(/\b(18|19|20)\d{2}\b/)?.[0]) || undefined,
    }));
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * Full-text search also matches article bodies ("severance" finds films about layoffs).
 * Keep titles that share words with the query, best overlap first; fall back to all if none do.
 */
export function rankByTitle<T extends { title: string }>(q: string, pages: T[]): T[] {
  const words = fold(q).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 || /\d/.test(w));
  if (!words.length) return pages;
  const scored = pages.map((p) => {
    const t = fold(p.title.replace(/ \([^)]*\)$/, ''));
    return { p, s: words.filter((w) => t.includes(w)).length / words.length };
  });
  const hits = scored.filter((x) => x.s > 0);
  return hits.length ? hits.sort((a, b) => b.s - a.s).map((x) => x.p) : pages;
}

export interface Summary {
  poster?: string;
  extract?: string;
  qid?: string;
}

/** The REST summary is the one keyless source that returns non-free film posters. */
export async function wikiSummary(title: string): Promise<Summary> {
  const s = await getJson<{ thumbnail?: { source: string }; extract?: string; wikibase_item?: string }>(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`,
  );
  return { poster: s.thumbnail?.source.replace(/\?.*$/, ''), extract: s.extract, qid: s.wikibase_item };
}

// ---------- Wikidata entity parsing ----------

type Snak = { snaktype: string; datavalue?: { value: unknown } };
export type Claim = { mainsnak: Snak; qualifiers?: Record<string, Snak[]>; rank?: string };
export type Claims = Record<string, Claim[]>;

const itemId = (s: Snak | undefined) => (s?.datavalue?.value as { id?: string } | undefined)?.id;
const str = (s: Snak | undefined) => (typeof s?.datavalue?.value === 'string' ? (s.datavalue.value as string) : undefined);
const live = (c: Claim[] | undefined) => (c ?? []).filter((x) => x.rank !== 'deprecated');

const ROLE_PROPS: [string, Role, number][] = [
  ['P57', 'director', 4],
  ['P170', 'creator', 4],
  ['P58', 'writer', 5],
  ['P161', 'cast', 10],
  ['P86', 'composer', 2],
];

const CRITICS: Record<string, { source: string; methods?: string[] }> = {
  Q105584: { source: 'Rotten Tomatoes', methods: ['Q108403393'] }, // Tomatometer, not audience score
  Q150248: { source: 'Metacritic', methods: ['Q106515043'] }, // Metascore, not user score
  Q37312: { source: 'IMDb' },
};

export function normaliseScore(value: string): number | undefined {
  const pct = value.match(/^\s*(\d+(?:\.\d+)?)\s*%\s*$/);
  if (pct) return Math.round(Number(pct[1]));
  const frac = value.match(/^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/);
  if (frac && Number(frac[2]) > 0) return Math.round((Number(frac[1]) / Number(frac[2])) * 100);
  return undefined;
}

/** Latest score per critic source, by point-in-time qualifier (P585). */
export function parseCritics(claims: Claims): CriticScore[] {
  const best = new Map<string, { c: CriticScore; at: string }>();
  for (const cl of live(claims.P444)) {
    const by = itemId(cl.qualifiers?.P447?.[0]);
    const def = by && CRITICS[by];
    const value = str(cl.mainsnak);
    if (!def || !value) continue;
    const method = itemId(cl.qualifiers?.P459?.[0]);
    if (def.methods && method && !def.methods.includes(method)) continue;
    const score = normaliseScore(value);
    if (score === undefined || score > 100) continue;
    const at = ((cl.qualifiers?.P585?.[0]?.datavalue?.value as { time?: string })?.time ?? '').replace(/^\+/, '');
    const prev = best.get(def.source);
    if (!prev || at > prev.at) best.set(def.source, { c: { source: def.source, value, score }, at });
  }
  return [...best.values()].map((b) => b.c);
}

/** Wikidata ids that need labels, plus everything parseable without them. */
export function parseClaims(claims: Claims) {
  const people: { qid: string; role: Role }[] = [];
  for (const [prop, role, max] of ROLE_PROPS) {
    for (const cl of live(claims[prop]).slice(0, max)) {
      const qid = itemId(cl.mainsnak);
      if (qid && !people.some((p) => p.qid === qid && p.role === role)) people.push({ qid, role });
    }
  }
  const ids = (p: string, max = 6) => live(claims[p]).map((c) => itemId(c.mainsnak)).filter((x): x is string => !!x).slice(0, max);

  let runtime: number | undefined;
  const dur = live(claims.P2047)[0]?.mainsnak.datavalue?.value as { amount?: string; unit?: string } | undefined;
  if (dur?.amount) {
    const n = Math.abs(Number(dur.amount));
    runtime = dur.unit?.endsWith('/Q25235') ? Math.round(n * 60) : dur.unit?.endsWith('/Q11574') ? Math.round(n / 60) : Math.round(n);
  }

  const years = live(claims.P577)
    .map((c) => Number(((c.mainsnak.datavalue?.value as { time?: string })?.time ?? '').slice(1, 5)))
    .filter((y) => y > 1800);

  // P1651 is sometimes the full film. Trust it only when marked as a trailer, or when it is short.
  const seconds = (c: Claim) => {
    const d = c.qualifiers?.P2047?.[0]?.datavalue?.value as { amount?: string; unit?: string } | undefined;
    const n = Number(d?.amount);
    return !d || !Number.isFinite(n) ? undefined : d.unit?.endsWith('/Q7727') ? n * 60 : n;
  };
  const trailer = live(claims.P1651).find(
    (c) => c.qualifiers?.P3831?.some((q) => itemId(q) === 'Q622550') || (seconds(c) ?? Infinity) <= 600,
  );

  return {
    people,
    genreIds: ids('P136'),
    subjectIds: ids('P921'),
    countryIds: ids('P495', 3),
    languageIds: ids('P364', 2),
    runtime,
    year: years.length ? Math.min(...years) : undefined,
    imdb: str(live(claims.P345)[0]?.mainsnak),
    trailer: str(trailer?.mainsnak),
    critics: parseCritics(claims),
  };
}

/** "science fiction film" → "Science fiction" */
export function tidyGenre(label: string): string {
  const t = label.replace(/\s+(film|films|television series|TV series|television program|series|drama series)$/i, '').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

type Entity = {
  claims?: Claims;
  labels?: Record<string, { value: string }>;
  sitelinks?: Record<string, { title: string }>;
  missing?: string;
};

async function entities(ids: string[], props: string): Promise<Record<string, Entity>> {
  const out: Record<string, Entity> = {};
  for (let i = 0; i < ids.length; i += 50) {
    const res = await getJson<{ entities: Record<string, Entity> }>(
      `${WD}?${qs({
        action: 'wbgetentities', format: 'json', origin: '*', ids: ids.slice(i, i + 50).join('|'),
        props, languages: 'en|mul', languagefallback: 1, sitefilter: 'enwiki',
      })}`,
    );
    Object.assign(out, res.entities);
  }
  return out;
}

const label = (e: Entity | undefined) => e?.labels?.en?.value ?? e?.labels?.mul?.value;

/** Knowledge-graph metadata for any Wikidata item (film or series). */
export async function wikidataMeta(qid: string) {
  const main = (await entities([qid], 'claims|labels|sitelinks'))[qid];
  if (!main || main.missing !== undefined) throw new Error('That title is no longer on Wikidata.');
  const p = parseClaims(main.claims ?? {});
  const need = [...new Set([...p.people.map((x) => x.qid), ...p.genreIds, ...p.subjectIds, ...p.countryIds, ...p.languageIds])];
  const labels = need.length ? await entities(need, 'labels') : {};
  const names = (ids: string[]) => ids.map((id) => label(labels[id])).filter((x): x is string => !!x);
  const people: Person[] = p.people
    .map((x) => ({ qid: x.qid, role: x.role, name: label(labels[x.qid]) ?? '' }))
    .filter((x) => x.name && !/^Q\d+$/.test(x.name));
  return {
    name: label(main),
    wiki: main.sitelinks?.enwiki?.title,
    people,
    genres: [...new Set(names(p.genreIds).map(tidyGenre))],
    subjects: names(p.subjectIds),
    countries: names(p.countryIds),
    languages: names(p.languageIds),
    runtime: p.runtime,
    year: p.year,
    imdb: p.imdb,
    trailer: p.trailer,
    critics: p.critics,
  };
}

/** `wiki` (the article title, known from search) lets the summary load in parallel. */
export async function filmMeta(qid: string, wiki?: string): Promise<Meta> {
  const early = wiki ? wikiSummary(wiki).catch(() => ({}) as Summary) : undefined;
  const wd = await wikidataMeta(qid);
  const summary = (await early) ?? (wd.wiki ? await wikiSummary(wd.wiki).catch(() => ({}) as Summary) : {});
  return {
    kind: 'film',
    name: wd.name ?? wd.wiki ?? qid,
    year: wd.year,
    poster: summary.poster,
    overview: summary.extract,
    genres: wd.genres,
    runtime: wd.runtime,
    people: wd.people,
    subjects: wd.subjects,
    countries: wd.countries,
    languages: wd.languages,
    critics: wd.critics,
    trailer: wd.trailer,
    qid,
    imdb: wd.imdb,
    wiki: wd.wiki,
  };
}

/** Find the Wikidata item for an IMDb id (used to enrich TVmaze shows). */
export async function qidForImdb(imdb: string): Promise<string | undefined> {
  const res = await getJson<{ query?: { search: { title: string }[] } }>(
    `${WD}?${qs({ action: 'query', format: 'json', origin: '*', list: 'search', srsearch: `haswbstatement:P345=${imdb}`, srlimit: 1 })}`,
  );
  return res.query?.search[0]?.title;
}

// ---------- Discovery: more by people you rate highly ----------

export interface Suggestion {
  qid: string;
  name: string;
  year?: number;
  wiki: string;
  via: string;
  role: string;
}

/** Films by these people, newest first, each with an English Wikipedia article. */
export async function filmsByPeople(people: { qid: string; name: string }[]): Promise<Suggestion[]> {
  if (!people.length) return [];
  const values = people.map((p) => `wd:${p.qid}`).join(' ');
  const query = `SELECT ?film ?filmLabel ?person ?prop (MIN(YEAR(?date)) AS ?year) ?article WHERE {
  VALUES ?person { ${values} }
  VALUES ?prop { wdt:P57 wdt:P58 }
  ?film ?prop ?person; wdt:P31 ?type.
  VALUES ?type { wd:Q11424 wd:Q202866 wd:Q93204 wd:Q506240 wd:Q24869 }
  ?article schema:about ?film; schema:isPartOf <https://en.wikipedia.org/>.
  OPTIONAL { ?film wdt:P577 ?date }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
} GROUP BY ?film ?filmLabel ?person ?prop ?article LIMIT 400`;
  const res = await getJson<{ results: { bindings: Record<string, { value: string }>[] } }>(
    `https://query.wikidata.org/sparql?${qs({ format: 'json', query })}`,
    30000,
  );
  const byQid = new Map(people.map((p) => [p.qid, p.name]));
  const out = new Map<string, Suggestion>();
  for (const b of res.results.bindings) {
    const qid = b.film.value.split('/').pop()!;
    const personQid = b.person.value.split('/').pop()!;
    if (out.has(qid)) continue;
    out.set(qid, {
      qid,
      name: b.filmLabel?.value ?? qid,
      year: b.year ? Number(b.year.value) : undefined,
      wiki: decodeURIComponent(b.article.value.split('/wiki/')[1] ?? '').replace(/_/g, ' '),
      via: byQid.get(personQid) ?? '',
      role: b.prop.value.endsWith('P57') ? 'directed' : 'wrote',
    });
  }
  return [...out.values()];
}
