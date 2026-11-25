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
  /** When the source last published it (Wikidata point in time, YYYY-MM) */
  asOf?: string;
}

/** The parts of a title you set yourself; everything else is looked up. */
export const USER_FIELDS = ['status', 'followed', 'expectation', 'rating', 'partnerRating', 'themes', 'note', 'drawn', 'finishedAt'] as const;
export type UserField = (typeof USER_FIELDS)[number];

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
  /** Country of the network or streaming service (TVmaze), absent when worldwide */
  channelCountry?: string;
  /** TVmaze: Running, Ended, To Be Determined, In Development */
  showStatus?: string;
  endedOn?: string;
  episodeOrders?: number[];
  /** TVmaze `updated` stamp, to skip refetching unchanged shows */
  tvmUpdated?: number;

  status: Status;
  /** Shows only: include on the calendar */
  followed?: boolean;
  /** 1–5: how keen you were after the trailer (before watching) */
  expectation?: number;
  /** When the expectation was recorded, so hindsight can be told apart */
  expectedAt?: string;
  /** 1–10 enjoyment */
  rating?: number;
  partnerRating?: number;
  /** What it was about for you: a few words each, chosen after watching */
  themes?: string[];
  note?: string;
  /** Discover: when you chose to want it, and when Parde first showed you its scores before you had seen it */
  chosenAt?: string;
  scoresAt?: string;
  choiceScores?: CriticScore[];
  firstWatchedAt?: string;
  instinctRecorded?: boolean;
  /** What drew you to it (Discover, optional) */
  drawn?: string[];
  /** When you last changed each of these yourself, clearing included, so a merge keeps the newer edit */
  edited?: Partial<Record<UserField, string>>;
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
  /** Not in TVmaze's latest list (gone, or a partial reply): set aside, never deleted */
  missingSince?: string;
}

export interface Seen {
  episodeId: number;
  titleId: string;
  seenAt: string;
  /** Marked along with others ("seen all"): seenAt is when you said so, not when you watched it */
  bulk?: boolean;
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
  failedEpisodes?: string[];
  editedAt?: string;
  addedAt: string;
  usedAt?: string;
}

export interface Setting {
  key: string;
  value: unknown;
}

/** A title you chose not to watch, with what was known then (older rows have only the id and date). */
export interface Dismissed {
  qid: string;
  at: string;
  name?: string;
  year?: number;
  critics?: CriticScore[];
  kind?: Kind;
  tvmaze?: number;
  measured?: boolean;
  scoresAt?: string;
}

/** Something you removed or unmarked, so merging an older backup does not bring it back. */
export interface Removed {
  /** 'title:wd:Q1' · 'seen:123' · 'link:<id>' · 'watch:<id>' */
  key: string;
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
  removed!: EntityTable<Removed, 'key'>;

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
    this.version(2).stores({ removed: 'key' });
  }
}

export const db = new PardeDB();

export const STORES = ['titles', 'episodes', 'seen', 'watches', 'links', 'settings', 'dismissed', 'removed'] as const;
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
