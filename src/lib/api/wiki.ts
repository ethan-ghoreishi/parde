import type { CriticScore, Person, Role, Title } from '../db';
import { getJson, qs } from './http';

/** Metadata fields of a Title (everything the user does not set). */
export type Meta = Pick<
  Title,
  | 'kind' | 'name' | 'year' | 'poster' | 'overview' | 'genres' | 'runtime' | 'people' | 'subjects'
  | 'countries' | 'languages' | 'critics' | 'trailer' | 'qid' | 'imdb' | 'tvmaze' | 'wiki'
  | 'network' | 'webChannel' | 'channelCountry' | 'showStatus' | 'endedOn' | 'episodeOrders' | 'tvmUpdated'
>;

export interface FilmHit {
  qid: string;
  /** English Wikipedia article title, when there is one */
  wiki: string;
  name: string;
  description: string;
  year?: number;
  poster?: string;
}

export interface PersonHit {
  qid: string;
  name: string;
  description: string;
}

const WP = 'https://en.wikipedia.org/w/api.php';
const WD = 'https://www.wikidata.org/w/api.php';

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const key = (s: string) => fold(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const stripImg = (u?: string) => u?.replace(/\?.*$/, '');

/** "heat 1995" or "Heat (1995)" → the title words and the year, which is used only for ranking. */
export function splitYear(q: string): { text: string; year?: number } {
  const m = q.trim().match(/^(.+?)[\s,(]+((?:18|19|20)\d{2})\)?$/);
  return m ? { text: m[1].trim(), year: Number(m[2]) } : { text: q.trim() };
}

type WpPage = { title: string; index: number; description?: string; pageprops?: { wikibase_item?: string }; thumbnail?: { source: string } };

async function wpFilmSearch(search: string): Promise<WpPage[]> {
  const res = await getJson<{ query?: { pages: WpPage[] } }>(
    `${WP}?${qs({
      action: 'query', format: 'json', formatversion: 2, origin: '*',
      generator: 'search', gsrsearch: `${search} hastemplate:"Infobox film"`, gsrlimit: 12,
      // pilicense=any: film posters are non-free images, which pageimages leaves out by default.
      prop: 'description|pageprops|pageimages', ppprop: 'wikibase_item', piprop: 'thumbnail', pithumbsize: 300, pilicense: 'any',
    })}`,
  );
  return (res.query?.pages ?? []).filter((p) => p.pageprops?.wikibase_item && !/^List of /.test(p.title)).sort((a, b) => a.index - b.index);
}

const FILM_DESC = /\bfilm\b/i;
const NOT_FILM = /\b(director|producer|actor|actress|editor|critic|composer|maker|festival|studio|company|award|soundtrack|screenwriter|cinematographer|character|series|franchise|game|novel|book|song|album|distributor|genre|people)\b/i;
const PERSON_DESC = /\b(actor|actress|director|filmmaker|screenwriter|showrunner|comedian|animator|cinematographer|producer|writer|playwright|composer|television presenter)\b/i;

async function wdSearch(q: string) {
  const res = await getJson<{ search?: { id: string; label?: string; description?: string }[] }>(
    `${WD}?${qs({ action: 'wbsearchentities', format: 'json', origin: '*', search: q, language: 'en', uselang: 'en', type: 'item', limit: 50 })}`,
  );
  const films: FilmHit[] = [];
  const people: PersonHit[] = [];
  for (const x of res.search ?? []) {
    const d = x.description ?? '';
    if (!x.label) continue;
    if (FILM_DESC.test(d) && !NOT_FILM.test(d)) films.push({ qid: x.id, wiki: '', name: x.label, description: d, year: yearIn(d) });
    else if (PERSON_DESC.test(d) && !/graphy\b|^list /i.test(d) && !FILM_DESC.test(d.replace(/\bfilm (director|producer|maker|editor|actor|actress)/gi, ''))) people.push({ qid: x.id, name: x.label, description: d });
  }
  return { films, people };
}

const yearIn = (s?: string) => Number(s?.match(/\b(18|19|20)\d{2}\b/)?.[0]) || undefined;

/** Exact title first, then a matching year, otherwise keep the source's own (popularity-aware) order. */
export function rankHits<T extends { name: string; year?: number }>(q: string, hits: T[]): T[] {
  const { text, year } = splitYear(q);
  const k = key(text);
  const score = (h: T) =>
    (key(h.name) === k ? 4 : key(h.name).startsWith(k) ? 1 : 0) + (year && h.year === year ? 3 : year && h.year && Math.abs(h.year - year) === 1 ? 1 : 0);
  return hits.map((h, i) => ({ h, i, s: score(h) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.h);
}

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

/**
 * Films and people. Wikipedia titles (with posters) catch short and exact titles ("Her", "Up");
 * Wikidata labels catch prefixes and original-language titles ("oppenh", "Sen to Chihiro").
 * Full-text search only when the title search finds nothing.
 */
export async function searchFilms(q: string): Promise<{ films: FilmHit[]; people: PersonHit[] }> {
  const { text } = splitYear(q);
  const [byTitle, wd] = await Promise.allSettled([wpFilmSearch(`intitle:"${text.replace(/"/g, '')}"`), wdSearch(text)]);
  if (byTitle.status === 'rejected' && wd.status === 'rejected') throw byTitle.reason;
  const titled = byTitle.status === 'fulfilled' ? byTitle.value : [];
  const labelled = wd.status === 'fulfilled' ? wd.value : { films: [] as FilmHit[], people: [] as PersonHit[] };
  const pages = titled.length || byTitle.status === 'rejected' ? titled : rankByTitle(text, await wpFilmSearch(text));
  const films: FilmHit[] = pages.map((p) => ({
    qid: p.pageprops!.wikibase_item!,
    wiki: p.title,
    name: p.title.replace(/ \((\d{4} )?(\w+ )?film\)$/, ''),
    description: p.description ?? '',
    year: yearIn(p.description) ?? yearIn(p.title.match(/\((\d{4}) /)?.[1]),
    poster: stripImg(p.thumbnail?.source),
  }));
  const seen = new Set(films.map((f) => f.qid));
  return { films: rankHits(q, [...films, ...labelled.films.filter((f) => !seen.has(f.qid))]), people: labelled.people.slice(0, 4) };
}

/** Lead images for up to 50 Wikipedia articles in one request (posters, portraits). */
export async function posters(titles: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let i = 0; i < titles.length; i += 50) {
    const res = await getJson<{ query?: { pages: { title: string; thumbnail?: { source: string } }[]; normalized?: { from: string; to: string }[] } }>(
      `${WP}?${qs({ action: 'query', format: 'json', formatversion: 2, origin: '*', titles: titles.slice(i, i + 50).join('|'), prop: 'pageimages', piprop: 'thumbnail', pithumbsize: 300, pilicense: 'any' })}`,
    );
    const back = new Map((res.query?.normalized ?? []).map((n) => [n.to, n.from]));
    for (const p of res.query?.pages ?? []) if (p.thumbnail) out[back.get(p.title) ?? p.title] = stripImg(p.thumbnail.source)!;
  }
  return out;
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

const ROTTEN = 'Q105584';
const METACRITIC = 'Q150248';
const IMDB = 'Q37312';
/** Each is a different measurement, so each is its own source, never averaged or compared with another. */
const METHODS: Record<string, string> = {
  Q108403393: 'Rotten Tomatoes', // Tomatometer: the share of critics who were positive
  Q108403540: 'Rotten Tomatoes average', // the critics' average rating
  Q131100566: 'Rotten Tomatoes audience', // Popcornmeter: almost never on Wikidata
  Q106515043: 'Metacritic', // Metascore
};

/** What a review score measures, or undefined if the statement does not say. */
function sourceOf(by: string | undefined, method: string | undefined, value: string): string | undefined {
  if (by === IMDB) return /\/\s*10$/.test(value) ? 'IMDb' : undefined;
  const s = method && METHODS[method];
  if (s === 'Metacritic') return by === METACRITIC && /\/\s*100$/.test(value) ? s : undefined;
  if (s === 'Rotten Tomatoes average') return by === ROTTEN && /\/\s*10$/.test(value) ? s : undefined;
  if (s) return by === ROTTEN && /%\s*$/.test(value) ? s : undefined;
  // Out of 100, Metacritic can only be the Metascore (its users rate out of 10). Rotten Tomatoes has three kinds of score: do not guess.
  return by === METACRITIC && !method && /\/\s*100$/.test(value) ? 'Metacritic' : undefined;
}

export function normaliseScore(value: string): number | undefined {
  const pct = value.match(/^\s*(\d+(?:\.\d+)?)\s*%\s*$/);
  if (pct) return Math.round(Number(pct[1]));
  const frac = value.match(/^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/);
  if (frac && Number(frac[2]) > 0) return Math.round((Number(frac[1]) / Number(frac[2])) * 100);
  return undefined;
}

/** Latest score per source, by point-in-time qualifier (P585). */
export function parseCritics(claims: Claims): CriticScore[] {
  const best = new Map<string, { c: CriticScore; at: string }>();
  for (const cl of live(claims.P444)) {
    const value = str(cl.mainsnak);
    const source = value && sourceOf(itemId(cl.qualifiers?.P447?.[0]), itemId(cl.qualifiers?.P459?.[0]), value);
    if (!value || !source) continue;
    // A series' score for one season (P4908) says nothing certain about the whole show.
    if (cl.qualifiers?.P4908) continue;
    const score = normaliseScore(value);
    if (score === undefined || score > 100) continue;
    const at = ((cl.qualifiers?.P585?.[0]?.datavalue?.value as { time?: string })?.time ?? '').replace(/^\+/, '');
    const asOf = /^\d{4}-\d{2}/.test(at) && !at.startsWith('0000') ? at.slice(0, at.slice(5, 7) === '00' ? 4 : 7) : undefined;
    const prev = best.get(source);
    if (!prev || at > prev.at) best.set(source, { c: { source, value, score, ...(asOf ? { asOf } : {}) }, at });
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

async function entities(ids: string[], props: string, retries = 0): Promise<Record<string, Entity>> {
  const batches = Array.from({ length: Math.ceil(ids.length / 50) }, (_, i) => ids.slice(i * 50, i * 50 + 50));
  const replies = await Promise.all(
    batches.map((b) =>
      getJson<{ entities: Record<string, Entity> }>(
        `${WD}?${qs({
          action: 'wbgetentities', format: 'json', origin: '*', ids: b.join('|'),
          props, languages: 'en|mul', languagefallback: 1, sitefilter: 'enwiki',
        })}`,
        30000,
        retries,
      ),
    ),
  );
  return Object.assign({}, ...replies.map((r) => r.entities));
}

const label = (e: Entity | undefined) => e?.labels?.en?.value ?? e?.labels?.mul?.value;


/** Wikidata items with everything that can be read without looking up names. */
async function parsedItems(qids: string[], retries: number) {
  const items = await entities(qids, 'claims|labels|sitelinks', retries);
  return qids.flatMap((q) => (items[q] && items[q].missing === undefined ? [{ q, e: items[q], p: parseClaims(items[q].claims ?? {}) }] : []));
}

/** One more request per 50 people, genres and places that need a name. */
async function named(parsed: Awaited<ReturnType<typeof parsedItems>>, retries: number) {
  const need = [...new Set(parsed.flatMap(({ p }) => [...p.people.map((x) => x.qid), ...p.genreIds, ...p.subjectIds, ...p.countryIds, ...p.languageIds]))];
  const labels = await entities(need, 'labels', retries);
  const names = (ids: string[]) => ids.map((id) => label(labels[id])).filter((x): x is string => !!x);
  return new Map(
    parsed.map(({ q, e, p }) => [
      q,
      {
        name: label(e),
        wiki: e.sitelinks?.enwiki?.title,
        people: p.people
          .map((x) => ({ qid: x.qid, role: x.role, name: label(labels[x.qid]) ?? '' }))
          .filter((x) => x.name && !/^Q\d+$/.test(x.name)) as Person[],
        genres: [...new Set(names(p.genreIds).map(tidyGenre))],
        subjects: names(p.subjectIds),
        countries: names(p.countryIds),
        languages: names(p.languageIds),
        runtime: p.runtime,
        year: p.year,
        imdb: p.imdb,
        trailer: p.trailer,
        critics: p.critics,
      },
    ]),
  );
}

/** Knowledge-graph metadata for Wikidata items (films or series), 50 per request. */
export const wikidataMetas = async (qids: string[], retries = 0) => named(await parsedItems(qids, retries), retries);

export async function wikidataMeta(qid: string) {
  const m = (await wikidataMetas([qid])).get(qid);
  if (!m) throw new Error('That title is no longer on Wikidata.');
  return m;
}

/** Poster and opening paragraph for Wikipedia articles, 20 per request (the extracts limit). */
async function intros(titles: string[], retries = 0): Promise<Map<string, { poster?: string; extract?: string }>> {
  const out = new Map<string, { poster?: string; extract?: string }>();
  for (let i = 0; i < titles.length; i += 20) {
    const res = await getJson<{ query?: { pages: { title: string; thumbnail?: { source: string }; extract?: string }[]; normalized?: { from: string; to: string }[] } }>(
      `${WP}?${qs({
        action: 'query', format: 'json', formatversion: 2, origin: '*', titles: titles.slice(i, i + 20).join('|'),
        prop: 'pageimages|extracts', piprop: 'thumbnail', pithumbsize: 300, pilicense: 'any', exintro: 1, explaintext: 1, exlimit: 20,
      })}`,
      15000,
      retries,
    );
    const back = new Map((res.query?.normalized ?? []).map((n) => [n.to, n.from]));
    for (const p of res.query?.pages ?? []) out.set(back.get(p.title) ?? p.title, { poster: stripImg(p.thumbnail?.source), extract: p.extract?.trim() || undefined });
  }
  return out;
}

/** Everything Parde keeps about these films. Missing or deleted items are left out of the map. */
export async function filmMetas(qids: string[], retries = 0): Promise<Map<string, Meta>> {
  const items = await parsedItems(qids, retries);
  const articles = items.map(({ e }) => e.sitelinks?.enwiki?.title).filter((x): x is string => !!x);
  const [wd, wp] = await Promise.all([named(items, retries), intros(articles, retries).catch(() => new Map<string, { poster?: string; extract?: string }>())]);
  return new Map(
    [...wd].map(([qid, m]) => {
      const intro = (m.wiki && wp.get(m.wiki)) || {};
      return [qid, { kind: 'film', ...m, name: m.name ?? m.wiki ?? qid, poster: intro.poster, overview: intro.extract, qid } as Meta];
    }),
  );
}

export async function filmMeta(qid: string): Promise<Meta> {
  const m = (await filmMetas([qid])).get(qid);
  if (!m) throw new Error('That title is no longer on Wikidata.');
  return m;
}

/** Find the Wikidata item for an IMDb id (used to enrich TVmaze shows). */
export async function qidForImdb(imdb: string): Promise<string | undefined> {
  const res = await getJson<{ query?: { search: { title: string }[] } }>(
    `${WD}?${qs({ action: 'query', format: 'json', origin: '*', list: 'search', srsearch: `haswbstatement:P345=${imdb}`, srlimit: 2 })}`,
  );
  return res.query?.search.length === 1 ? res.query.search[0].title : undefined;
}

// ---------- People and their work ----------

export type CreditRole = 'directed' | 'wrote' | 'created' | 'acted';
const ROLE_OF: Record<string, CreditRole> = { P57: 'directed', P58: 'wrote', P170: 'created', P161: 'acted' };

export interface Credit {
  qid: string;
  name: string;
  kind: 'film' | 'show';
  year?: number;
  /** English Wikipedia article title */
  wiki?: string;
  tvmaze?: number;
  /** Most telling first: a film someone wrote and directed is listed as directed */
  roles: CreditRole[];
  /** Who of the people asked about made it */
  via: string;
  /** Wikipedia language editions with an article: a rough measure of how widely known it is */
  known?: number;
}

/** Wikidata types that are a film (feature, animated, silent, documentary, TV, short…) or a series. */
export const FILM_TYPES = ['Q11424', 'Q24869', 'Q202866', 'Q29168811', 'Q93204', 'Q506240', 'Q226730', 'Q24862', 'Q20650540'];
export const SHOW_TYPES = ['Q5398426', 'Q1259759', 'Q526877', 'Q117467246', 'Q581714'];

type Binding = Record<string, { value: string }>;
/** SPARQL string literal: escape backslashes and quotes; a raw line break would be a syntax error. */
export const lit = (s: string) => `"${s.replace(/[\u0000-\u001f]/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export async function sparql(query: string, timeoutMs = 30000, retries = 0): Promise<Binding[]> {
  const res = await getJson<{ results: { bindings: Binding[] } }>(`https://query.wikidata.org/sparql?${qs({ format: 'json', query })}`, timeoutMs, retries);
  return res.results.bindings;
}

/**
 * Films and series these people directed, wrote, created or acted in, from the Wikidata Query Service.
 * One request for any number of people. Series come with their TVmaze id (P8600) when Wikidata has it.
 */
export async function credits(people: string[], roles: CreditRole[] = ['directed', 'wrote', 'created', 'acted']): Promise<Credit[]> {
  if (!people.length) return [];
  const props = Object.entries(ROLE_OF).filter(([, r]) => roles.includes(r)).map(([p]) => `wdt:${p}`);
  return parseCredits(await sparql(`SELECT ?w ?wLabel ?prop ?type ?person ?l (MIN(YEAR(?d)) AS ?y) (SAMPLE(?tv) AS ?tvm) (SAMPLE(?a) AS ?article) WHERE {
  VALUES ?person { ${people.map((q) => `wd:${q}`).join(' ')} }
  VALUES ?prop { ${props.join(' ')} }
  VALUES ?type { ${[...FILM_TYPES, ...SHOW_TYPES].map((q) => `wd:${q}`).join(' ')} }
  ?w ?prop ?person; wdt:P31 ?type; wikibase:sitelinks ?l.
  OPTIONAL { ?w wdt:P577|wdt:P580 ?d }
  OPTIONAL { ?w wdt:P8600 ?tv }
  OPTIONAL { ?a schema:about ?w; schema:isPartOf <https://en.wikipedia.org/> }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
} GROUP BY ?w ?wLabel ?prop ?type ?person ?l LIMIT 3000`));
}

const tail = (u: string) => u.slice(u.lastIndexOf('/') + 1);
const ORDER: CreditRole[] = ['directed', 'created', 'wrote', 'acted'];

export function parseCredits(bindings: Binding[]): Credit[] {
  const out = new Map<string, Credit>();
  for (const b of bindings) {
    const qid = tail(b.w.value);
    const name = b.wLabel?.value;
    if (!name || /^Q\d+$/.test(name)) continue; // no English or multilingual label: nothing to show
    const role = ROLE_OF[tail(b.prop.value)];
    const c = out.get(qid) ?? {
      qid,
      name,
      kind: SHOW_TYPES.includes(tail(b.type.value)) ? 'show' : 'film',
      year: b.y?.value ? Number(b.y.value) : undefined,
      wiki: article(b.article?.value),
      tvmaze: Number(b.tvm?.value) || undefined,
      roles: [],
      via: tail(b.person.value),
      known: Number(b.l?.value) || 0,
    };
    if (SHOW_TYPES.includes(tail(b.type.value))) c.kind = 'show';
    if (role && !c.roles.includes(role)) c.roles.push(role);
    c.roles.sort((x, y) => ORDER.indexOf(x) - ORDER.indexOf(y));
    out.set(qid, c);
  }
  return [...out.values()];
}

/** A title on a shelf, before anything more is looked up. */
export interface Find {
  qid: string;
  name: string;
  kind: 'film' | 'show';
  year?: number;
  tvmaze?: number;
  known?: number;
  /** English Wikipedia article, for its poster */
  wiki?: string;
}

const article = (url: string | undefined) => (url ? decodeURIComponent(url.split('/wiki/')[1] ?? '').replace(/_/g, ' ') || undefined : undefined);
const typeList = [...FILM_TYPES, ...SHOW_TYPES].map((q) => `wd:${q}`).join(', ');

/**
 * Films and series found by `inner` (which binds ?f, ?l and ?score), most related and best known first.
 * The named subquery is evaluated first and types are a filter: as a join, the service lists every film there is.
 */
async function find(inner: string): Promise<Find[]> {
  const rows = await sparql(`SELECT ?f ?fLabel ?l ?score (GROUP_CONCAT(DISTINCT STR(?type)) AS ?types) (MIN(YEAR(?d)) AS ?y) (SAMPLE(?tv) AS ?tvm) (SAMPLE(?a) AS ?article)
WITH { ${inner} } AS %found
WHERE {
  INCLUDE %found
  ?f wdt:P31 ?type. FILTER(?type IN (${typeList}))
  OPTIONAL { ?f wdt:P577 ?d }
  OPTIONAL { ?f wdt:P580 ?d }
  OPTIONAL { ?f wdt:P8600 ?tv }
  OPTIONAL { ?a schema:about ?f; schema:isPartOf <https://en.wikipedia.org/> }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
} GROUP BY ?f ?fLabel ?l ?score ORDER BY DESC(?score) DESC(?l)`);
  return rows.flatMap((b) => {
    const name = b.fLabel?.value;
    if (!name || /^Q\d+$/.test(name)) return [];
    const show = b.types.value.split(' ').some((t) => SHOW_TYPES.includes(tail(t)));
    return [{ qid: tail(b.f.value), name, kind: show ? 'show' as const : 'film' as const, year: Number(b.y?.value) || undefined, tvmaze: Number(b.tvm?.value) || undefined, known: Number(b.l.value) || 0, wiki: article(b.article?.value) }];
  });
}

/** What shares its makers, subject, source or cast with a title: the same director counts for more than one actor. */
export const neighbours = (qid: string) =>
  find(`SELECT ?f ?l (SUM(?w) AS ?score) WHERE {
    VALUES (?p ?w) { (wdt:P57 4) (wdt:P170 4) (wdt:P58 2) (wdt:P921 2) (wdt:P144 2) (wdt:P161 1) }
    wd:${qid} ?p ?x. ?f ?p ?x; wikibase:sitelinks ?l. FILTER(?f != wd:${qid} && ?l > 4)
  } GROUP BY ?f ?l ORDER BY DESC(?score) DESC(?l) LIMIT 150`);

/** What Wikidata says is about this subject (its exact English name). */
export const aboutSubject = (name: string) =>
  find(`SELECT DISTINCT ?f ?l (1 AS ?score) WHERE { ?x rdfs:label ${lit(name)}@en. ?f wdt:P921 ?x; wdt:P31 ?t; wikibase:sitelinks ?l. FILTER(?l > 4 && ?t IN (${typeList})) } ORDER BY DESC(?l) LIMIT 120`);

/** The best-known films and series from a country. */
export const fromCountry = (qid: string) =>
  find(`SELECT DISTINCT ?f ?l (1 AS ?score) WHERE { ?f wdt:P495 wd:${qid}; wikibase:sitelinks ?l. FILTER(?l > 12) ?f wdt:P31 ?t. FILTER(?t IN (${typeList})) } ORDER BY DESC(?l) LIMIT 120`);

export interface PersonInfo {
  qid: string;
  name: string;
  description?: string;
  wiki?: string;
}

export async function personInfo(qid: string): Promise<PersonInfo> {
  const e = (await entities([qid], 'labels|descriptions|sitelinks'))[qid] as Entity & { descriptions?: Record<string, { value: string }> };
  if (!e || e.missing !== undefined) throw new Error('That person is not on Wikidata.');
  return { qid, name: label(e) ?? qid, description: e.descriptions?.en?.value, wiki: e.sitelinks?.enwiki?.title };
}

/**
 * The Wikidata person with exactly this name (TVmaze cast come without Wikidata ids). Someone with a
 * merely similar name would show the wrong filmography, so no match means undefined.
 */
export async function findPerson(name: string): Promise<PersonHit | undefined> {
  const { people } = await wdSearch(name);
  return people.find((p) => key(p.name) === key(name));
}
