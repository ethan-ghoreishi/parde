import { db, type Kind, type Title } from './db';
import { getJson, qs } from './api/http';
import { searchFilms, splitYear, rankHits } from './api/wiki';
import { searchShows, showForImdb, findShow } from './api/tvmaze';
import { addFilms, addShow, update, seenAllAired, setProgress } from './actions';
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
  /** YYYY-MM-DD */
  date?: string;
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

const SHOW_TYPES = /^(tv ?(mini ?)?series|tvseries|tvminiseries)$/i;
const SKIP_TYPES = /^(tv ?episode|tvepisode|video ?game|videogame|podcast ?(series|episode))$/i;
const year = (s?: string) => (s && /^(18|19|20)\d{2}$/.test(s.trim()) ? Number(s.trim()) : undefined);
const day = (s?: string) => s?.trim().match(/^\d{4}-\d{2}-\d{2}/)?.[0];
const within = (n: number) => (Number.isFinite(n) && n >= 1 && n <= 10 ? Math.round(n) : undefined);

/** Letterboxd export (ratings, watched, diary, watchlist), IMDb export (ratings, watchlist), or any CSV with a title column. */
function fromCsv(table: string[][], status: Row['status']): Row[] | null {
  const head = table[0].map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => names.map((n) => head.indexOf(n)).find((i) => i >= 0) ?? -1;
  const nameCol = col('name', 'title', 'primarytitle', 'film', 'movie');
  if (nameCol < 0) return null;
  const letterboxd = head.includes('letterboxd uri');
  const c = {
    year: col('year', 'startyear', 'release year'),
    imdb: col('const', 'tconst', 'imdb id', 'imdb_id', 'imdbid'),
    type: col('title type', 'titletype'),
    rating: col('your rating', 'rating', 'my rating'),
    date: col('watched date', 'date rated', 'date', 'watched'),
  };
  const ratings = c.rating >= 0 ? table.slice(1).map((r) => Number(r[c.rating])).filter((n) => n > 0) : [];
  // Letterboxd rates out of 5 in halves; a generic CSV whose ratings never exceed 5 is treated the same.
  const halves = letterboxd || (ratings.length > 0 && ratings.every((n) => n <= 5));
  return table.slice(1).flatMap((r, i) => {
    const name = r[nameCol]?.trim();
    const type = c.type >= 0 ? r[c.type]?.trim() ?? '' : '';
    if (!name || SKIP_TYPES.test(type)) return [];
    const raw = Number(r[c.rating]);
    const rating = c.rating >= 0 && raw > 0 ? within(halves ? raw * 2 : raw) : undefined;
    const imdb = c.imdb >= 0 ? r[c.imdb]?.match(/tt\d{6,}/)?.[0] : undefined;
    return [{
      line: i + 2,
      raw: [name, r[c.year]].filter(Boolean).join(' '),
      name,
      year: year(r[c.year]),
      imdb,
      kind: letterboxd ? 'film' : SHOW_TYPES.test(type) ? 'show' : type ? 'film' : undefined,
      rating,
      date: day(r[c.date]),
      status: rating ? 'watched' : status,
    } satisfies Row];
  });
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
  const score = s.match(/[\s,;|:–-]+(\d{1,2}(?:\.\d)?)\s*(?:\/\s*10)?\s*$/);
  if (!row.rating && score && !/^(18|19|20)\d{2}$/.test(score[1]) && within(Number(score[1]))) {
    row.rating = within(Number(score[1]));
    s = s.slice(0, score.index);
  }
  const y = splitYear(s.replace(/[\s,;|:–-]+$/, ''));
  row.year = y.year;
  row.name = y.text.replace(/^[\s"'“]+|[\s"'”,;|:–-]+$/g, '');
  if (row.rating) row.status = 'watched';
  if (row.upTo && status === 'want') row.status = 'watched';
  return row.name || row.imdb ? row : null;
}

export function parseImport(text: string, status: Row['status'] = 'watched'): Row[] {
  const clean = text.replace(/^﻿/, '');
  const first = clean.split(/\r?\n/, 1)[0] ?? '';
  if (first.includes(',') && /(^|,)"?(name|title|const|tconst|letterboxd uri)"?(,|$)/i.test(first)) {
    const rows = fromCsv(parseCsv(clean), status);
    if (rows) return rows;
  }
  return clean.split(/\r?\n/).flatMap((l, i) => parseLine(l, i + 1, status) ?? []);
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
}

export interface Item {
  row: Row;
  candidates: Match[];
  /** Index into candidates, or -1 to skip */
  pick: number;
  /** Confident enough to add without asking */
  sure: boolean;
  /** Already in the library: the existing title id */
  owned?: string;
}

const FILM_T = ['Q11424', 'Q24869', 'Q202866', 'Q29168811', 'Q93204', 'Q506240', 'Q226730'];
const SHOW_T = ['Q5398426', 'Q1259759', 'Q526877', 'Q117467246', 'Q581714'];
const tail = (u: string) => u.slice(u.lastIndexOf('/') + 1);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// SPARQL string literal: escape backslashes and quotes; a raw line break would be a syntax error.
const lit = (s: string) => `"${s.replace(/[\u0000-\u001f]/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

async function sparql(query: string) {
  const res = await getJson<{ results: { bindings: Record<string, { value: string }>[] } }>(
    `https://query.wikidata.org/sparql?${qs({ format: 'json', query })}`,
    60000,
    3,
  );
  return res.results.bindings;
}

/** Wikidata items for IMDb ids, up to 150 per query. */
export async function byImdb(ids: string[]) {
  const out = new Map<string, Match>();
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
      out.set(b.imdb.value, {
        kind: types.some((t) => SHOW_T.includes(t)) ? 'show' : 'film',
        qid: tail(b.item.value),
        tvmaze: Number(b.tvm?.value) || undefined,
        name: b.itemLabel?.value ?? b.imdb.value,
        year: Number(b.y?.value) || undefined,
      });
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
  VALUES ?type { ${[...FILM_T, ...SHOW_T].map((q) => `wd:${q}`).join(' ')} }
  ?item rdfs:label ?label; wdt:P31 ?type; wikibase:sitelinks ?links.
  OPTIONAL { ?item wdt:P577|wdt:P580 ?d }
  OPTIONAL { ?item wdt:P8600 ?tv }
} GROUP BY ?label ?item ?type ?links`);
    for (const b of rows) {
      const list = out.get(b.name.value) ?? [];
      const qid = tail(b.item.value);
      const kind: Kind = SHOW_T.includes(tail(b.type.value)) ? 'show' : 'film';
      const prev = list.find((m) => m.qid === qid);
      if (prev) prev.kind = prev.kind === 'show' ? 'show' : kind;
      else list.push({ kind, qid, tvmaze: Number(b.tvm?.value) || undefined, name: b.name.value, year: Number(b.y?.value) || undefined, links: Number(b.links.value) || 0 });
      out.set(b.name.value, list);
    }
  }
  return out;
}

/** The one candidate we would pick, and whether it is safe to pick it without asking. */
export function choose(row: Row, cands: (Match & { links?: number })[]): { candidates: Match[]; pick: number; sure: boolean } {
  let list = row.kind ? cands.filter((c) => c.kind === row.kind) : cands;
  if (!list.length) list = cands;
  if (!list.length) return { candidates: [], pick: -1, sure: false };
  const exactYear = row.year ? list.filter((c) => c.year === row.year) : [];
  const near = row.year ? list.filter((c) => c.year && Math.abs(c.year - row.year!) <= 1) : [];
  // Most-linked first stands in for "the one people mean" when nothing else decides.
  const ordered = [...exactYear, ...near.filter((c) => !exactYear.includes(c)), ...[...list].filter((c) => !near.includes(c)).sort((a, b) => (b.links ?? 0) - (a.links ?? 0))];
  const sure = exactYear.length === 1 || (near.length === 1 && !exactYear.length) || (!row.year && list.length === 1);
  return { candidates: ordered.slice(0, 5).map(({ links: _links, ...m }) => m), pick: 0, sure };
}

const k = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

async function bySearch(row: Row): Promise<Match[]> {
  const q = row.year ? `${row.name} ${row.year}` : row.name;
  const [f, s] = await Promise.all([
    row.kind === 'show' ? Promise.resolve({ films: [] }) : searchFilms(q).catch(() => ({ films: [] })),
    row.kind === 'film' ? Promise.resolve([]) : searchShows(q).catch(() => []),
  ]);
  const films: Match[] = f.films.slice(0, 4).map((x) => ({ kind: 'film', qid: x.qid, name: x.name, year: x.year, note: x.description }));
  const shows: Match[] = s.slice(0, 3).map((x) => ({ kind: 'show', tvmaze: x.tvmaze, name: x.name, year: x.year, note: x.description }));
  return rankHits(q, [...films, ...shows]);
}

/**
 * Match every row to a film or series. Exact ids first (IMDb → Wikidata/TVmaze), then exact English
 * titles in bulk, and only the leftovers one by one through search (gently: Wikimedia rate-limits).
 */
export async function resolve(rows: Row[], progress: (done: number, total: number) => void): Promise<Item[]> {
  const library = await db.titles.toArray();
  const items: Item[] = rows.map((row) => ({ row, candidates: [], pick: -1, sure: false }));
  let done = 0;
  const tick = (n = 1) => progress((done += n), rows.length);

  const imdbRows = items.filter((it) => it.row.imdb);
  const fromImdb = imdbRows.length ? await byImdb([...new Set(imdbRows.map((it) => it.row.imdb!))]) : new Map<string, Match>();
  for (const it of imdbRows) {
    const m = fromImdb.get(it.row.imdb!);
    const kind = it.row.kind ?? m?.kind;
    if (kind === 'show' && !m?.tvmaze) {
      // TVmaze allows 20 requests per 10 seconds.
      const tvmaze = await showForImdb(it.row.imdb!).catch(() => undefined);
      await sleep(550);
      if (tvmaze) Object.assign(it, { candidates: [{ ...m, kind: 'show', tvmaze, name: m?.name ?? it.row.name }], pick: 0, sure: true });
    } else if (m) Object.assign(it, { candidates: [{ ...m, kind: kind ?? m.kind }], pick: 0, sure: true });
    if (it.candidates.length) tick();
  }

  const named = items.filter((it) => !it.candidates.length && it.row.name);
  const labels = named.length ? await byLabel([...new Set(named.map((it) => it.row.name))]).catch(() => new Map()) : new Map();
  for (const it of named) {
    const c = labels.get(it.row.name);
    if (c?.length) {
      Object.assign(it, choose(it.row, c));
      if (it.sure) tick();
    }
  }

  for (const it of items) {
    if (it.sure) continue;
    if (it.row.name) {
      const found = await bySearch(it.row).catch(() => [] as Match[]);
      const merged = [...it.candidates, ...found.filter((f) => !it.candidates.some((c) => (f.qid && c.qid === f.qid) || (f.tvmaze && c.tvmaze === f.tvmaze)))];
      const best = choose(it.row, merged);
      const top = best.candidates[0];
      // A search hit is trusted only when its title is exactly the one given and the year agrees.
      const exact = !!top && k(top.name) === k(it.row.name) && (!it.row.year || top.year === it.row.year);
      Object.assign(it, { ...best, sure: best.sure || (exact && !!it.row.year) });
    }
    tick();
  }

  for (const it of items) {
    const m = it.candidates[it.pick];
    const own = m && library.find((t) => (m.qid && (t.id === `wd:${m.qid}` || t.qid === m.qid)) || (m.tvmaze && t.tvmaze === m.tvmaze));
    if (own) it.owned = own.id;
  }
  return items;
}

/** What the person decided for a series that is marked seen: all of it, or set progress afterwards. */
export type ShowPlan = 'all' | 'partly';

export interface Outcome {
  added: string[];
  updated: number;
  failed: { row: Row; error: string }[];
  /** Series to place with the "seen up to" picker */
  toPlace: string[];
}

/** Ratings and dates for a title that is new, or only fills gaps in one you already have. */
export function patchFor(row: Row, existing?: Title): Partial<Title> {
  const p: Partial<Title> = {};
  if (row.rating && existing?.rating === undefined) p.rating = row.rating;
  if (!existing) {
    p.status = row.status;
    if (row.status === 'watched' && row.date) p.finishedAt = row.date;
  }
  return p;
}

/**
 * Add what was matched. Films go in batches; series one at a time (TVmaze has its own limits).
 * Running it again with the same file only fills gaps: nothing already here is overwritten.
 */
export async function commit(items: Item[], plans: Record<number, ShowPlan>, progress: (done: number, total: number) => void): Promise<Outcome> {
  const out: Outcome = { added: [], updated: 0, failed: [], toPlace: [] };
  const chosen = items.map((it, i) => ({ it, i, m: it.candidates[it.pick] })).filter((x) => x.m);
  let done = 0;
  const tick = (n = 1) => progress((done += n), chosen.length);

  for (const { it } of chosen.filter((x) => x.it.owned)) {
    const t = await db.titles.get(it.owned!);
    const p = t ? patchFor(it.row, t) : {};
    if (t && Object.keys(p).length) {
      await update(t.id, p);
      out.updated++;
    }
    tick();
  }

  const films = chosen.filter((x) => !x.it.owned && x.m.kind === 'film' && x.m.qid);
  for (let i = 0; i < films.length; i += 50) {
    const batch = films.slice(i, i + 50);
    try {
      const added = await addFilms(batch.map(({ it, m }) => ({ qid: m.qid!, patch: patchFor(it.row) })));
      out.added.push(...added);
      for (const { it, m } of batch) if (!added.includes(`wd:${m.qid}`) && !(await db.titles.get(`wd:${m.qid}`))) out.failed.push({ row: it.row, error: 'No longer on Wikidata' });
    } catch (e) {
      out.failed.push(...batch.map(({ it }) => ({ row: it.row, error: errorText(e) })));
    }
    tick(batch.length);
  }

  for (const { it, i, m } of chosen.filter((x) => !x.it.owned && x.m.kind === 'show')) {
    try {
      const tvm = m.tvmaze ?? (await findShow(m.name, m.year));
      if (!tvm) throw new Error('Not on TVmaze, so its episodes cannot be tracked');
      const id = await addShow(tvm);
      out.added.push(id);
      await update(id, patchFor(it.row));
      const eps = await db.episodes.where('titleId').equals(id).toArray();
      const at = it.row.upTo && eps.find((e) => e.season === it.row.upTo!.season && e.number === it.row.upTo!.episode);
      if (at) await setProgress(id, at);
      else if (it.row.upTo || (it.row.status === 'watched' && plans[i] === 'partly')) {
        await update(id, { status: 'watching' });
        out.toPlace.push(id);
      } else if (it.row.status === 'watched') await seenAllAired(id);
    } catch (e) {
      out.failed.push({ row: it.row, error: errorText(e) });
    }
    tick();
    await sleep(400); // each series is three TVmaze/Wikidata calls; stay well inside their limits
  }
  return out;
}
