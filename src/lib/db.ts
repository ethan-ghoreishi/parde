import Dexie, { type EntityTable } from 'dexie';

export type Kind = 'film' | 'show';
/** want: not started · watching: in progress (shows) · watched · paused · dropped */
export type Status = 'want' | 'watching' | 'watched' | 'paused' | 'dropped';
export type Role = 'director' | 'writer' | 'creator' | 'cast' | 'composer';

export interface Person {
  name: string;
  role: Role;
  qid?: string;
}

export interface CriticScore {
  /** 'Rotten Tomatoes' | 'Metacritic' | 'IMDb' | 'TVmaze' */
  source: string;
  /** As published, e.g. "92%", "79/100", "8.4/10" */
  value: string;
  /** Normalised 0–100 */
  score: number;
}

export interface Title {
  /** 'wd:Q123' for films, 'tvm:44933' for shows */
  id: string;
  kind: Kind;
  name: string;
  year?: number;
  poster?: string;
  overview?: string;
  genres: string[];
  /** Minutes: film length, or average episode length */
  runtime?: number;
  people: Person[];
  subjects: string[];
  countries: string[];
  languages: string[];
  critics: CriticScore[];
  /** YouTube id, only when Wikidata marks it as a trailer */
  trailer?: string;
  qid?: string;
  imdb?: string;
  tvmaze?: number;
  /** English Wikipedia article title */
  wiki?: string;
  network?: string;
  webChannel?: string;
  /** TVmaze: Running, Ended, To Be Determined, In Development */
  showStatus?: string;
  /** TVmaze `updated` stamp, to skip refetching unchanged shows */
  tvmUpdated?: number;

  status: Status;
  /** Shows only: include on the calendar */
  followed?: boolean;
  /** 1–5: how keen you were after the trailer (before watching) */
  expectation?: number;
  /** 1–10 enjoyment */
  rating?: number;
  partnerRating?: number;
  note?: string;
  addedAt: string;
  updatedAt: string;
  finishedAt?: string;
  enrichedAt?: string;
  syncedAt?: string;
}

export interface Episode {
  /** TVmaze episode id */
  id: number;
  titleId: string;
  season: number;
  number: number;
  name: string;
  airdate: string;
  airtime: string;
  airstamp?: string;
  runtime?: number;
  summary?: string;
}

export interface Seen {
  episodeId: number;
  titleId: string;
  seenAt: string;
}

/** One viewing of a film (or finishing a show). Rewatches add another. */
export interface Watch {
  id: string;
  titleId: string;
  date: string;
  together: boolean;
}

export interface Link {
  id: string;
  titleId: string;
  /** Absent for whole-title links */
  season?: number;
  episode?: number;
  url: string;
  label?: string;
  broken?: boolean;
  addedAt: string;
  usedAt?: string;
}

export interface Setting {
  key: string;
  value: unknown;
}

export interface Dismissed {
  qid: string;
  at: string;
}

export class PardeDB extends Dexie {
  titles!: EntityTable<Title, 'id'>;
  episodes!: EntityTable<Episode, 'id'>;
  seen!: EntityTable<Seen, 'episodeId'>;
  watches!: EntityTable<Watch, 'id'>;
  links!: EntityTable<Link, 'id'>;
  settings!: EntityTable<Setting, 'key'>;
  dismissed!: EntityTable<Dismissed, 'qid'>;

  constructor(name = 'parde') {
    super(name);
    this.version(1).stores({
      titles: 'id, kind, status, qid, imdb, tvmaze, updatedAt',
      episodes: 'id, titleId, airdate',
      seen: 'episodeId, titleId',
      watches: 'id, titleId, date',
      links: 'id, titleId',
      settings: 'key',
      dismissed: 'qid',
    });
  }
}

export const db = new PardeDB();

export const STORES = ['titles', 'episodes', 'seen', 'watches', 'links', 'settings', 'dismissed'] as const;
export type StoreName = (typeof STORES)[number];

export const now = () => new Date().toISOString();
export const uid = () => crypto.randomUUID();

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key);
  return row === undefined ? fallback : (row.value as T);
}

export function setSetting(key: string, value: unknown) {
  return db.settings.put({ key, value });
}
