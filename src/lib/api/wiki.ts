import type { CriticScore, Person, Role, Title } from '../db';
import { getJson, qs } from './http';

/** Metadata fields of a Title (everything the user does not set). */
export type Meta = Pick<
  Title,
  | 'kind' | 'name' | 'year' | 'poster' | 'overview' | 'genres' | 'runtime' | 'people' | 'subjects'
  | 'countries' | 'languages' | 'critics' | 'trailer' | 'qid' | 'imdb' | 'tvmaze' | 'wiki'
  | 'network' | 'webChannel' | 'channelCountry' | 'showStatus' | 'tvmUpdated'
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
    // A series' score for one season (P4908) says nothing certain about the whole show.
    if (cl.qualifiers?.P4908) continue;
    const score = normaliseScore(value);
    if (score === undefined || score > 100) continue;
    const at = ((cl.qualifiers?.P585?.[0]?.datavalue?.value as { time?: string })?.time ?? '').replace(/^\+/, '');
    const asOf = /^\d{4}-\d{2}/.test(at) && !at.startsWith('0000') ? at.slice(0, at.slice(5, 7) === '00' ? 4 : 7) : undefined;
    const prev = best.get(def.source);
    if (!prev || at > prev.at) best.set(def.source, { c: { source: def.source, value, score, ...(asOf ? { asOf } : {}) }, at });
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
  const out: Record<string, Entity> = {};
  for (let i = 0; i < ids.length; i += 50) {
    const res = await getJson<{ entities: Record<string, Entity> }>(
      `${WD}?${qs({
        action: 'wbgetentities', format: 'json', origin: '*', ids: ids.slice(i, i + 50).join('|'),
        props, languages: 'en|mul', languagefallback: 1, sitefilter: 'enwiki',
      })}`,
      30000,
      retries,
    );
    Object.assign(out, res.entities);
  }
  return out;
}

const label = (e: Entity | undefined) => e?.labels?.en?.value ?? e?.labels?.mul?.value;


/**
 * Knowledge-graph metadata for Wikidata items (films or series), 50 per request: one request for
 * the items, then one per 50 people, genres and places that need a name.
 */
export async function wikidataMetas(qids: string[], retries = 0) {
  const items = await entities(qids, 'claims|labels|sitelinks', retries);
  const parsed = qids.flatMap((q) => (items[q] && items[q].missing === undefined ? [{ q, e: items[q], p: parseClaims(items[q].claims ?? {}) }] : []));
  const need = [...new Set(parsed.flatMap(({ p }) => [...p.people.map((x) => x.qid), ...p.genreIds, ...p.subjectIds, ...p.countryIds, ...p.languageIds]))];
  const labels = need.length ? await entities(need, 'labels', retries) : {};
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
  const wd = await wikidataMetas(qids, retries);
  const wp = await intros([...wd.values()].map((m) => m.wiki).filter((x): x is string => !!x), retries).catch(() => new Map());
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
    `${WD}?${qs({ action: 'query', format: 'json', origin: '*', list: 'search', srsearch: `haswbstatement:P345=${imdb}`, srlimit: 1 })}`,
  );
  return res.query?.search[0]?.title;
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
}

const FILM_TYPES = ['Q11424', 'Q24869', 'Q202866', 'Q29168811', 'Q93204', 'Q506240', 'Q226730'];
const SHOW_TYPES = ['Q5398426', 'Q1259759', 'Q526877', 'Q117467246', 'Q581714'];

/**
 * Films and series these people directed, wrote, created or acted in, from the Wikidata Query Service.
 * One request for any number of people. Series come with their TVmaze id (P8600) when Wikidata has it.
 */
export async function credits(people: string[], roles: CreditRole[] = ['directed', 'wrote', 'created', 'acted']): Promise<Credit[]> {
  if (!people.length) return [];
  const props = Object.entries(ROLE_OF).filter(([, r]) => roles.includes(r)).map(([p]) => `wdt:${p}`);
  const query = `SELECT ?w ?wLabel ?prop ?type ?person (MIN(YEAR(?d)) AS ?y) (SAMPLE(?tv) AS ?tvm) (SAMPLE(?a) AS ?article) WHERE {
  VALUES ?person { ${people.map((q) => `wd:${q}`).join(' ')} }
  VALUES ?prop { ${props.join(' ')} }
  VALUES ?type { ${[...FILM_TYPES, ...SHOW_TYPES].map((q) => `wd:${q}`).join(' ')} }
  ?w ?prop ?person; wdt:P31 ?type.
  OPTIONAL { ?w wdt:P577|wdt:P580 ?d }
  OPTIONAL { ?w wdt:P8600 ?tv }
  OPTIONAL { ?a schema:about ?w; schema:isPartOf <https://en.wikipedia.org/> }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
} GROUP BY ?w ?wLabel ?prop ?type ?person LIMIT 3000`;
  const res = await getJson<{ results: { bindings: Record<string, { value: string }>[] } }>(
    `https://query.wikidata.org/sparql?${qs({ format: 'json', query })}`,
    30000,
  );
  return parseCredits(res.results.bindings);
}

const tail = (u: string) => u.slice(u.lastIndexOf('/') + 1);
const ORDER: CreditRole[] = ['directed', 'created', 'wrote', 'acted'];

export function parseCredits(bindings: Record<string, { value: string }>[]): Credit[] {
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
      wiki: b.article ? decodeURIComponent(b.article.value.split('/wiki/')[1] ?? '').replace(/_/g, ' ') || undefined : undefined,
      tvmaze: Number(b.tvm?.value) || undefined,
      roles: [],
      via: tail(b.person.value),
    };
    if (SHOW_TYPES.includes(tail(b.type.value))) c.kind = 'show';
    if (role && !c.roles.includes(role)) c.roles.push(role);
    c.roles.sort((x, y) => ORDER.indexOf(x) - ORDER.indexOf(y));
    out.set(qid, c);
  }
  return [...out.values()];
}

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
