import { db, type Episode, type Kind, type Title } from './db';
import { FILM_TYPES, SHOW_TYPES, lit, rankHits, searchFilms, sparql as query, splitYear } from './api/wiki';
import { searchShows, showForImdb, findShow } from './api/tvmaze';
import { addFilms, storeShow, update, setProgress } from './actions';
import { byOrder, code, isAired, progress as whereIn } from './schedule';
import { errorText } from './ui.svelte';

/** One line of someone's history, before it is matched to a title. */
export interface Row {
  line: number;
  raw: string;
  name: string;
  year?: number;
  imdb?: string;
  kind?: Kind;
  /** 1–10 */
  rating?: number;
  /** A rating written as a bare number ("Heat 4"), whose scale (5 or 10) the list as a whole decides */
  bare?: number;
  /** A rating that is not on a 1–10 or 5-star scale, as written */
  unread?: string;
  /** YYYY-MM-DD: when the line was recorded (rated, logged). Only for telling which of two lines is newer. */
  date?: string;
  /** YYYY-MM-DD: when it was actually watched */
  watchedOn?: string;
  status: 'watched' | 'want';
  /** "Severance S02E03": seen up to here */
  upTo?: { season: number; episode: number };
}

// ---------- Parsing ----------

/** RFC 4180 CSV: quoted fields may hold commas, quotes ("") and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') row.push(field), (field = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field), rows.push(row), (row = []), (field = '');
    } else field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  return rows.filter((r) => r.some((f) => f.trim()));
}

const CSV_SHOW = /^(tv ?(mini ?)?series|tvseries|tvminiseries)$/i;
const CSV_SKIP = /^(tv ?episode|tvepisode|video ?game|videogame|podcast ?(series|episode)|music ?video|musicvideo)$/i;
const year = (s?: string) => (s && /^(18|19|20)\d{2}$/.test(s.trim()) ? Number(s.trim()) : undefined);
const day = (s?: string) => {
  const d = s?.trim().match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  return d && !Number.isNaN(Date.parse(d)) ? d : undefined;
};
const within = (n: number) => (Number.isFinite(n) && n >= 1 && n <= 10 ? Math.round(n) : undefined);

/** Letterboxd export (ratings, watched, diary, watchlist), IMDb export (ratings, watchlist), or any CSV with a title column. */
function fromCsv(table: string[][], status: Row['status']): { rows: Row[]; skipped: number } | null {
  const head = table[0].map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => names.map((n) => head.indexOf(n)).find((i) => i >= 0) ?? -1;
  const nameCol = col('name', 'title', 'primarytitle', 'film', 'movie');
  if (nameCol < 0) return null;
  const letterboxd = head.includes('letterboxd uri');
  // IMDb exports have a Const column: always out of 10, even if every rating happens to be 5 or less.
  const imdbExport = head.includes('const') && head.includes('your rating');
  const c = {
    year: col('year', 'startyear', 'release year'),
    imdb: col('const', 'tconst', 'imdb id', 'imdb_id', 'imdbid'),
    type: col('title type', 'titletype'),
    rating: col('your rating', 'rating', 'my rating'),
    // The day a rating was entered is not the day the film was seen.
    watched: col('watched date', 'date watched', 'watched on', 'watched'),
    date: col('watched date', 'date rated', 'date', 'watched'),
  };
  let skipped = 0;
  const rows = table.slice(1).flatMap((r, i) => {
    const name = r[nameCol]?.trim();
    const type = c.type >= 0 ? r[c.type]?.trim() ?? '' : '';
    if (!name || CSV_SKIP.test(type)) {
      skipped++;
      return [];
    }
    const written = c.rating >= 0 ? (r[c.rating]?.trim() ?? '') : '';
    const raw = written ? Number(written) : NaN;
    // Letterboxd rates out of 5 in halves; any other CSV leaves the scale to the list as a whole.
    const rating = raw > 0 ? within(letterboxd ? raw * 2 : raw) : undefined;
    const bare = rating && !letterboxd && !imdbExport ? raw : undefined;
    const imdb = c.imdb >= 0 ? r[c.imdb]?.match(/tt\d{6,}/)?.[0] : undefined;
    return [{
      line: i + 2,
      raw: [name, r[c.year]].filter(Boolean).join(' '),
      name,
      year: year(r[c.year]),
      imdb,
      kind: letterboxd ? 'film' : CSV_SHOW.test(type) ? 'show' : type ? 'film' : undefined,
      rating,
      ...(bare ? { bare } : {}),
      ...(written && raw !== 0 && !rating ? { unread: written } : {}),
      date: day(r[c.date]),
      watchedOn: day(r[c.watched]),
      status: rating ? 'watched' : status,
    } satisfies Row];
  });
  return { rows, skipped };
}

/** "Heat (1995) 9", "Heat 1995 - 8/10", "Amélie ★★★★½", "Severance S02E03", "Fargo (series)", "tt0113277" */
export function parseLine(text: string, line: number, status: Row['status']): Row | null {
  let s = text.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, ''); // list bullets and "1. " numbering
  if (!s || s.startsWith('#')) return null;
  const row: Row = { line, raw: s, name: '', status };
  const imdb = s.match(/\btt\d{6,}\b/);
  if (imdb) (row.imdb = imdb[0]), (s = s.replace(imdb[0], ' '));
  const ep = s.match(/\bS(\d{1,2})\s*E(\d{1,3})\b/i) ?? s.match(/\bseason\s*(\d{1,2})\W+episode\s*(\d{1,3})\b/i);
  if (ep) (row.upTo = { season: Number(ep[1]), episode: Number(ep[2]) }), (row.kind = 'show'), (s = s.replace(ep[0], ' '));
  if (/[([]\s*(series|tv|show|tv series)\s*[)\]]/i.test(s)) (row.kind = 'show'), (s = s.replace(/[([]\s*(series|tv|show|tv series)\s*[)\]]/i, ' '));
  if (/[([]\s*film\s*[)\]]/i.test(s)) (row.kind = 'film'), (s = s.replace(/[([]\s*film\s*[)\]]/i, ' '));
  const stars = s.match(/(★+)(½)?/);
  if (stars) (row.rating = within(stars[1].length * 2 + (stars[2] ? 1 : 0))), (s = s.replace(stars[0], ' '));
  // "8/10", "4.5/5", or a bare number whose scale the whole list decides (see parseImport)
  const score = s.match(/[\s,;|:–-]+(\d{1,2}(?:\.\d)?)\s*(?:\/\s*(10|5)\b)?\s*$/);
  if (!row.rating && score && !/^(18|19|20)\d{2}$/.test(score[1]) && within(Number(score[1]) * (score[2] === '5' ? 2 : 1))) {
    const n = Number(score[1]);
    row.rating = within(score[2] === '5' ? n * 2 : n);
    if (!score[2]) row.bare = n;
    s = s.slice(0, score.index);
  }
  const y = splitYear(s.replace(/[\s,;|:–-]+$/, ''));
  row.year = y.year;
  row.name = y.text.replace(/^[\s"'“]+|[\s"'”,;|:–-]+$/g, '');
  if (row.rating) row.status = 'watched';
  if (row.upTo && status === 'want') row.status = 'watched';
  return row.name || row.imdb ? row : null;
}

export interface Read {
  rows: Row[];
  /** Lines that are not a film or series (TV episodes, games, no title) */
  skipped: number;
}

/**
 * Bare-number ratings ("Heat 4"): any above 5 means the list is out of 10; if none are, they could be
 * stars or a harsh 10-point scale, which only the person can say (see `scaleOf`). Until they do, no
 * rating is assumed.
 */
export function readImport(text: string, status: Row['status'] = 'watched', outOf?: 5 | 10): Read {
  const clean = text.replace(/^\uFEFF/, '');
  const first = clean.split(/\r?\n/, 1)[0] ?? '';
  let read: Read | null = null;
  if (first.includes(',') && /(^|,)"?(name|title|const|tconst|letterboxd uri)"?(,|$)/i.test(first)) read = fromCsv(parseCsv(clean), status);
  read ??= { rows: clean.split(/\r?\n/).flatMap((l, i) => parseLine(l, i + 1, status) ?? []), skipped: 0 };
  // Your choice applies only while the list leaves it open: a later "Dune 8" settles it as out of 10.
  const found = scaleOf(read.rows);
  const scale = found.ambiguous ? outOf : found.outOf;
  for (const r of read.rows) if (r.bare !== undefined) r.rating = scale && within(scale === 5 ? r.bare * 2 : r.bare);
  return read;
}
export const parseImport = (text: string, status: Row['status'] = 'watched', outOf?: 5 | 10) => readImport(text, status, outOf).rows;

/** Whether the bare-number ratings in a list are out of 5 or 10, and whether that is a guess. */
export function scaleOf(rows: Row[]): { outOf: 5 | 10; ambiguous: boolean } {
  const bare = rows.flatMap((r) => (r.bare !== undefined ? [r.bare] : []));
  if (!bare.length || bare.some((n) => n > 5)) return { outOf: 10, ambiguous: false };
  return { outOf: 5, ambiguous: true };
}

// ---------- Matching ----------

export interface Match {
  kind: Kind;
  /** Wikidata id (films always; series when known) */
  qid?: string;
  tvmaze?: number;
  name: string;
  year?: number;
  note?: string;
  /** Already in the library: the existing title id */
  owned?: string;
}

export interface Item {
  row: Row;
  candidates: Match[];
  /** Index into candidates, or -1 to skip */
  pick: number;
  /** Confident enough to add without asking */
  sure: boolean;
  /** A service did not answer: "not checked" is not "not found" */
  error?: string;
}

/** The title already in the library that a match refers to, if any. */
export function ownedId(m: Pick<Match, 'kind' | 'qid' | 'tvmaze'>, library: Title[]): string | undefined {
  return library.find((t) => (m.qid && (t.id === `wd:${m.qid}` || t.qid === m.qid)) || (m.tvmaze && t.tvmaze === m.tvmaze))?.id;
}

export const ownedOf = (it: Item) => it.candidates[it.pick]?.owned;

const tail = (u: string) => u.slice(u.lastIndexOf('/') + 1);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sparql = (q: string) => query(q, 60000, 3);

/** Wikidata items for IMDb ids, up to 150 per query. `typed`: Wikidata says it is a film or a series. */
export async function byImdb(ids: string[]) {
  const out = new Map<string, (Match & { typed: boolean })[]>();
  for (let i = 0; i < ids.length; i += 150) {
    const rows = await sparql(`SELECT ?imdb ?item ?itemLabel (MIN(YEAR(?d)) AS ?y) (SAMPLE(?tv) AS ?tvm) (GROUP_CONCAT(DISTINCT STR(?t)) AS ?types) WHERE {
  VALUES ?imdb { ${ids.slice(i, i + 150).map(lit).join(' ')} }
  ?item wdt:P345 ?imdb.
  OPTIONAL { ?item wdt:P31 ?t }
  OPTIONAL { ?item wdt:P577|wdt:P580 ?d }
  OPTIONAL { ?item wdt:P8600 ?tv }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
} GROUP BY ?imdb ?item ?itemLabel`);
    for (const b of rows) {
      const types = (b.types?.value ?? '').split(' ').map(tail);
      const show = types.some((t) => SHOW_TYPES.includes(t));
      const list = out.get(b.imdb.value) ?? [];
      list.push({
        kind: show ? 'show' : 'film',
        typed: show || types.some((t) => FILM_TYPES.includes(t)),
        qid: tail(b.item.value),
        tvmaze: Number(b.tvm?.value) || undefined,
        name: b.itemLabel?.value ?? b.imdb.value,
        year: Number(b.y?.value) || undefined,
      });
      out.set(b.imdb.value, list);
    }
  }
  return out;
}

/**
 * Films and series whose English (or language-neutral "mul") label is exactly one of these names,
 * 100 names per query. Many titles now carry only a "mul" label.
 */
export async function byLabel(names: string[]) {
  const out = new Map<string, (Match & { links: number })[]>();
  for (let i = 0; i < names.length; i += 100) {
    const rows = await sparql(`SELECT (STR(?label) AS ?name) ?item ?type ?links (MIN(YEAR(?d)) AS ?y) (SAMPLE(?tv) AS ?tvm) WHERE {
  VALUES ?label { ${names.slice(i, i + 100).flatMap((n) => [`${lit(n)}@en`, `${lit(n)}@mul`]).join(' ')} }
  VALUES ?type { ${[...FILM_TYPES, ...SHOW_TYPES].map((q) => `wd:${q}`).join(' ')} }
  ?item rdfs:label ?label; wdt:P31 ?type; wikibase:sitelinks ?links.
  OPTIONAL { ?item wdt:P577|wdt:P580 ?d }
  OPTIONAL { ?item wdt:P8600 ?tv }
} GROUP BY ?label ?item ?type ?links`);
    for (const b of rows) {
      const list = out.get(b.name.value) ?? [];
      const qid = tail(b.item.value);
      const kind: Kind = SHOW_TYPES.includes(tail(b.type.value)) ? 'show' : 'film';
      const prev = list.find((m) => m.qid === qid);
      if (prev) prev.kind = prev.kind === 'show' ? 'show' : kind;
      else list.push({ kind, qid, tvmaze: Number(b.tvm?.value) || undefined, name: b.name.value, year: Number(b.y?.value) || undefined, links: Number(b.links.value) || 0 });
      out.set(b.name.value, list);
    }
  }
  return out;
}

/** Candidates, best first, and whether the first is safe to add without asking. If not, nothing is picked. */
export function choose(row: Row, cands: (Match & { links?: number })[]): { candidates: Match[]; pick: number; sure: boolean; wrongKind?: boolean } {
  let list = row.kind ? cands.filter((c) => c.kind === row.kind) : cands;
  // Asked for a series and found only films (or the reverse): offer them, never add one unasked.
  const wrongKind = !list.length;
  if (wrongKind) list = cands;
  if (!list.length) return { candidates: [], pick: -1, sure: false };
  const exactYear = row.year ? list.filter((c) => c.year === row.year) : [];
  const near = row.year ? list.filter((c) => c.year && Math.abs(c.year - row.year!) <= 1) : [];
  // Most-linked first stands in for "the one people mean" when nothing else decides.
  const ordered = [...exactYear, ...near.filter((c) => !exactYear.includes(c)), ...[...list].filter((c) => !near.includes(c)).sort((a, b) => (b.links ?? 0) - (a.links ?? 0))];
  const sure = !wrongKind && (row.year ? exactYear.length === 1 : list.length === 1);
  return { candidates: ordered.slice(0, 5).map(({ links: _links, ...m }) => m), pick: sure ? 0 : -1, sure, wrongKind };
}

const k = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** `complete` is false when one of the services did not answer, so nothing found is certain. */
async function bySearch(row: Row): Promise<{ found: Match[]; complete: boolean }> {
  const q = row.year ? `${row.name} ${row.year}` : row.name;
  const [f, s] = await Promise.allSettled([
    row.kind === 'show' ? { films: [] } : searchFilms(q),
    row.kind === 'film' ? [] : searchShows(q),
  ]);
  const failed = [f, s].filter((x) => x.status === 'rejected');
  if (failed.length && ![f, s].some((x) => x.status === 'fulfilled' && ('films' in x.value ? x.value.films : x.value).length)) throw failed[0].reason;
  const films: Match[] = f.status === 'fulfilled' ? f.value.films.slice(0, 4).map((x) => ({ kind: 'film', qid: x.qid, name: x.name, year: x.year, note: x.description })) : [];
  const shows: Match[] = s.status === 'fulfilled' ? s.value.slice(0, 3).map((x) => ({ kind: 'show', tvmaze: x.tvmaze, name: x.name, year: x.year, note: x.description })) : [];
  return { found: rankHits(q, [...films, ...shows]), complete: !failed.length };
}

/**
 * Match every row to a film or series. Exact ids first (IMDb → Wikidata/TVmaze), then exact English
 * titles in bulk, and only the leftovers one by one through search (gently: Wikimedia rate-limits).
 * A service that does not answer leaves an `error` on the row, so it can be tried again.
 */
export async function resolve(rows: Row[], progress: (done: number, total: number) => void): Promise<Item[]> {
  const library = await db.titles.toArray();
  const items: Item[] = rows.map((row) => ({ row, candidates: [], pick: -1, sure: false }));
  let done = 0;
  const tick = (n = 1) => progress((done += n), rows.length);

  const imdbRows = items.filter((it) => it.row.imdb);
  const ids = [...new Set(imdbRows.map((it) => it.row.imdb!))];
  const fromImdb = new Map<string, (Match & { typed: boolean })[]>();
  const unavailable = new Set<string>();
  for (let i = 0; i < ids.length; i += 150) {
    const batch = ids.slice(i, i + 150);
    try {
      for (const [id, matches] of await byImdb(batch)) fromImdb.set(id, matches);
    } catch {
      batch.forEach((id) => unavailable.add(id));
    }
  }
  for (const it of imdbRows) {
    const found = fromImdb.get(it.row.imdb!) ?? [];
    const unchecked = unavailable.has(it.row.imdb!);
    const [m] = found;
    // The id is exact, but not always the type: what the file calls a film, Wikidata may call a series.
    const agrees = !m || (m.typed ? !it.row.kind || it.row.kind === m.kind : !!it.row.kind);
    const kind = m?.typed ? m.kind : (it.row.kind ?? m?.kind);
    try {
      if ((kind === 'show' || unchecked && !kind && it.row.kind !== 'film') && !m?.tvmaze && found.length <= 1) {
        // TVmaze allows 20 requests per 10 seconds.
        const tvmaze = await showForImdb(it.row.imdb!);
        await sleep(550);
        if (tvmaze) Object.assign(it, { candidates: [{ ...m, kind: 'show', tvmaze, name: m?.name ?? it.row.name }] });
      } else if (m) it.candidates = found.map((x) => ({ ...x, kind: x.typed ? x.kind : (it.row.kind ?? x.kind) }));
    } catch (e) {
      it.error = errorText(e);
    }
    if (it.candidates.length === 1 && agrees && found.length <= 1) Object.assign(it, { pick: 0, sure: true });
    if (!it.candidates.length && !it.error) it.error = unchecked ? 'IMDb ID could not be checked. Try again.' : 'No verified match for this IMDb ID';
    tick();
  }

  const named = items.filter((it) => !it.candidates.length && !it.error && it.row.name);
  const labels = named.length ? await byLabel([...new Set(named.map((it) => it.row.name))]).catch(() => undefined) : undefined;
  for (const it of named) {
    const c = labels?.get(it.row.name);
    if (c?.length) {
      const { wrongKind: _, ...best } = choose(it.row, c);
      Object.assign(it, best);
      if (it.sure) tick();
    }
  }

  for (const it of items) {
    if (it.sure || it.error || it.row.imdb && it.candidates.length) continue;
    if (it.row.name) {
      try {
        const { found, complete } = await bySearch(it.row);
        const merged = [...it.candidates, ...found.filter((f) => !it.candidates.some((c) => (f.qid && c.qid === f.qid) || (f.tvmaze && c.tvmaze === f.tvmaze)))];
        const { wrongKind, ...best } = choose(it.row, merged);
        const top = best.candidates[0];
        const same = (c: Match) => k(c.name) === k(it.row.name);
        // Search finds look-alikes ("Heat" → "The Heat"): a hit is added without asking only when its title is
        // exactly the one given, of the kind asked for, the year agrees, and nothing else fits as well.
        const fits = best.candidates.filter((c) => same(c) && (!it.row.year || c.year === it.row.year));
        const exact = complete && !wrongKind && fits.length === 1 && fits[0] === top;
        Object.assign(it, { ...best, sure: exact, pick: exact ? 0 : -1 });
      } catch (e) {
        if (!it.candidates.length) it.error = errorText(e);
      }
    }
    tick();
  }

  for (const it of items) for (const c of it.candidates) c.owned = ownedId(c, library);
  return items;
}

/** Whether the first candidate is a fair guess: the same title, of the kind asked for. Look-alikes are not. */
export const likely = (it: Item) => {
  const c = it.candidates[0];
  return !!c && k(c.name) === k(it.row.name) && (!it.row.kind || c.kind === it.row.kind) && (!it.row.year || !c.year || Math.abs(c.year - it.row.year) <= 1);
};

/** What the person decided for a series that is marked seen: all of it, or set progress afterwards. */
export type ShowPlan = 'all' | 'partly';

export interface Outcome {
  added: string[];
  updated: number;
  /** Lines that named a title already given earlier in the same list (a diary's rewatches) */
  merged: number;
  failed: { row: Row; error: string }[];
  /** Series to place with the "seen up to" picker */
  toPlace: string[];
  /** Series you are already in, where the list says you are further on: yours is kept unless you say so */
  ahead: { id: string; name: string; here: string; ep: Episode }[];
}

/**
 * Ratings and dates for a title that is new, or only fills gaps in one you already have. A film on your
 * want list that the history says you watched becomes watched; nothing else you recorded is changed.
 */
export function patchFor(row: Row, existing?: Title): Partial<Title> {
  const p: Partial<Title> = {};
  if (row.rating && existing?.rating === undefined && !existing?.edited?.rating) p.rating = row.rating;
  const upgrade = existing?.kind === 'film' && existing.status === 'want' && !existing.firstWatchedAt && (!existing.edited?.status || existing.edited.status === existing.addedAt) && row.status === 'watched';
  if (!existing || (upgrade && !existing?.edited?.finishedAt)) {
    p.status = row.status;
    if (row.status === 'watched' && row.watchedOn && !existing?.finishedAt) p.finishedAt = row.watchedOn;
  }
  return p;
}

/**
 * One row per title. A Letterboxd diary lists a film once per viewing: keep the latest rating and date,
 * "watched" over "want", and the furthest episode reached.
 */
export function mergeRows(rows: Row[]): Row {
  const latest = [...rows].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  const furthest = rows.map((r) => r.upTo).filter((u) => !!u).sort((a, b) => b!.season - a!.season || b!.episode - a!.episode)[0];
  return {
    ...rows[0],
    rating: latest.find((r) => r.rating)?.rating,
    date: latest[0].date,
    watchedOn: rows.map((r) => r.watchedOn).filter(Boolean).sort().at(-1),
    status: rows.some((r) => r.status === 'watched') ? 'watched' : rows[0].status,
    ...(furthest ? { upTo: { ...furthest } } : {}),
  };
}

/** The episode a line says you have seen up to, if it exists and is out. */
const episodeAt = (eps: Episode[], row: Row) => eps.find((e) => e.season === row.upTo?.season && e.number === row.upTo?.episode && isAired(e) && !e.missingSince);

const targetKey = (m: Match) => (m.kind === 'film' ? `wd:${m.qid}` : m.tvmaze ? `tvm:${m.tvmaze}` : `show:${m.qid ?? `${k(m.name)}|${m.year}`}`);

/**
 * Add what was matched. Films go in batches; series one at a time (TVmaze has its own limits).
 * Running it again with the same file only fills gaps: nothing already here is overwritten.
 * Ownership is checked again here, against the choice actually made and the library as it is now.
 */
export async function commit(items: Item[], plans: Record<number, ShowPlan>, progress: (done: number, total: number) => void): Promise<Outcome> {
  const out: Outcome = { added: [], updated: 0, merged: 0, failed: [], toPlace: [], ahead: [] };
  const groups = new Map<string, { i: number; m: Match; rows: Row[]; partly: boolean }>();
  items.forEach((it, i) => {
    const m = it.candidates[it.pick];
    if (!m) return;
    const g = groups.get(targetKey(m));
    if (g) {
      g.rows.push(it.row);
      g.partly ||= plans[i] === 'partly';
      out.merged++;
    } else groups.set(targetKey(m), { i, m, rows: [it.row], partly: plans[i] === 'partly' });
  });
  const chosen = [...groups.values()].map((g) => ({ ...g, row: mergeRows(g.rows) }));
  const library = await db.titles.toArray();
  let done = 0;
  const tick = (n = 1) => progress((done += n), chosen.length);

  const fill = (id: string, row: Row) => db.transaction('rw', db.titles, db.episodes, db.seen, db.removed, async () => {
    const t = await db.titles.get(id);
    if (!t) throw new Error('This title was removed while importing.');
    const p = patchFor(row, t);
    if (Object.keys(p).length) {
      await update(t.id, p);
      out.updated++;
    }
    if (t.kind !== 'show' || row.status !== 'watched') return;
    const eps = await db.episodes.where('titleId').equals(id).toArray();
    const here = whereIn(eps, new Set(await db.seen.where('titleId').equals(id).primaryKeys())).lastSeen;
    const at = episodeAt(eps, row);
    if (!here && at && !t.firstWatchedAt && t.status === 'want' && !(await db.removed.where('key').startsWith('seen:').and((x) => eps.some((e) => x.key === `seen:${e.id}`)).count())) {
      await setProgress(id, at);
      out.updated++;
    } else if (!here && t.status === 'want') out.toPlace.push(id);
    else if (here && at && byOrder(at, here) > 0) out.ahead.push({ id, name: t.name, here: code(here), ep: at });
  });

  const owned = chosen.flatMap((x) => {
    const id = ownedId(x.m, library);
    return id ? [{ ...x, id }] : [];
  });
  for (const x of owned) {
    try {
      await fill(x.id, x.row);
    } catch (e) {
      out.failed.push({ row: x.row, error: errorText(e) });
    }
    tick();
  }
  const fresh = chosen.filter((x) => !owned.some((o) => o.i === x.i));

  const films = fresh.filter((x) => x.m.kind === 'film' && x.m.qid);
  for (let i = 0; i < films.length; i += 50) {
    const batch = films.slice(i, i + 50);
    try {
      const added = await addFilms(batch.map(({ row, m }) => ({ qid: m.qid!, patch: patchFor(row) })));
      out.added.push(...added);
      for (const { row, m } of batch) {
        if (added.includes(`wd:${m.qid}`)) continue;
        try {
          if (await db.titles.get(`wd:${m.qid}`)) await fill(`wd:${m.qid}`, row);
          else out.failed.push({ row, error: 'No matching film metadata returned by Wikidata' });
        } catch (e) {
          out.failed.push({ row, error: errorText(e) });
        }
      }
    } catch (e) {
      out.failed.push(...batch.map(({ row }) => ({ row, error: errorText(e) })));
    }
    tick(batch.length);
  }

  for (const { row, m, partly } of fresh.filter((x) => x.m.kind === 'show')) {
    try {
      const tvm = m.tvmaze ?? (row.imdb ? await showForImdb(row.imdb) : await findShow(m.name, m.year));
      if (!tvm) throw new Error('Not on TVmaze, so its episodes cannot be tracked');
      const p = patchFor(row);
      const initial = row.upTo ?? (row.status === 'watched' && !partly ? 'all' : undefined);
      const result = await storeShow(tvm, {
        ...p, ...(m.qid ? { qid: m.qid } : {}), ...(row.status === 'watched' ? { status: 'watching', finishedAt: undefined } : {}),
      }, initial);
      if (!result.added) await fill(result.id, row);
      else {
        out.added.push(result.id);
        if (result.needsProgress || partly) out.toPlace.push(result.id);
      }
    } catch (e) {
      out.failed.push({ row, error: errorText(e) });
    }
    tick();
    await sleep(400); // each series is three TVmaze/Wikidata calls; stay well inside their limits
  }
  return out;
}
