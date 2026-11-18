import type { Episode, Person } from '../db';
import { getJson, NetError, stripHtml } from './http';
import { rankHits, splitYear, type Meta } from './wiki';

const API = 'https://api.tvmaze.com';

export interface TvmShow {
  id: number;
  name: string;
  genres: string[];
  status: string;
  premiered: string | null;
  averageRuntime: number | null;
  runtime: number | null;
  rating: { average: number | null };
  network: { name: string; country?: { code: string } | null } | null;
  webChannel: { name: string; country?: { code: string } | null } | null;
  externals: { imdb: string | null };
  image: { medium: string; original: string } | null;
  summary: string | null;
  updated: number;
  _embedded?: {
    episodes?: TvmEpisode[];
    cast?: { person: { name: string } }[];
    crew?: { type: string; person: { name: string } }[];
  };
}

export interface TvmEpisode {
  id: number;
  name: string;
  season: number;
  number: number | null;
  airdate: string;
  airtime: string;
  airstamp: string | null;
  runtime: number | null;
  summary: string | null;
  type?: string;
}

export interface ShowHit {
  tvmaze: number;
  name: string;
  year?: number;
  poster?: string;
  description: string;
}

export async function searchShows(q: string): Promise<ShowHit[]> {
  const res = await getJson<{ show: TvmShow }[]>(`${API}/search/shows?q=${encodeURIComponent(splitYear(q).text)}`);
  return rankHits(q, res.map(({ show: s }) => ({
    tvmaze: s.id,
    name: s.name,
    year: s.premiered ? Number(s.premiered.slice(0, 4)) : undefined,
    poster: s.image?.medium,
    description: [s.premiered?.slice(0, 4), s.network?.name ?? s.webChannel?.name, s.status === 'Ended' ? 'ended' : '']
      .filter(Boolean)
      .join(' · '),
  })));
}

/** The TVmaze show for an IMDb id, or undefined if TVmaze does not list it. */
export async function showForImdb(imdb: string): Promise<number | undefined> {
  try {
    return (await getJson<TvmShow>(`${API}/lookup/shows?imdb=${encodeURIComponent(imdb)}`)).id;
  } catch (e) {
    if (e instanceof NetError && e.status === 404) return undefined;
    throw e;
  }
}

/** Best TVmaze match for a series known only by name (and maybe year): exact name, then year. */
export async function findShow(name: string, year?: number): Promise<number | undefined> {
  const hits = await searchShows(year ? `${name} ${year}` : name);
  const k = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return hits.find((h) => k(h.name) === k(name) && (!year || !h.year || Math.abs(h.year - year) <= 1))?.tvmaze;
}

export function toEpisode(titleId: string, e: TvmEpisode): Episode | null {
  // Specials have no number; they never block "next episode" and are left out.
  if (e.number == null) return null;
  return {
    id: e.id,
    titleId,
    season: e.season,
    number: e.number,
    name: e.name,
    airdate: e.airdate ?? '',
    airtime: e.airtime ?? '',
    airstamp: e.airstamp ?? undefined,
    runtime: e.runtime ?? undefined,
    summary: stripHtml(e.summary) || undefined,
  };
}

export function showToMeta(s: TvmShow): Meta {
  const crew = s._embedded?.crew ?? [];
  const people: Person[] = [
    ...crew.filter((c) => c.type === 'Creator' || c.type === 'Developer').map((c) => ({ name: c.person.name, role: 'creator' as const })),
    ...(s._embedded?.cast ?? []).slice(0, 10).map((c) => ({ name: c.person.name, role: 'cast' as const })),
  ];
  return {
    kind: 'show',
    name: s.name,
    year: s.premiered ? Number(s.premiered.slice(0, 4)) : undefined,
    poster: s.image?.medium,
    overview: stripHtml(s.summary) || undefined,
    genres: s.genres ?? [],
    runtime: s.averageRuntime ?? s.runtime ?? undefined,
    people: people.filter((p, i) => people.findIndex((q) => q.name === p.name && q.role === p.role) === i),
    subjects: [],
    countries: [],
    languages: [],
    critics: s.rating?.average ? [{ source: 'TVmaze', value: `${s.rating.average}/10`, score: Math.round(s.rating.average * 10) }] : [],
    tvmaze: s.id,
    imdb: s.externals?.imdb ?? undefined,
    network: s.network?.name,
    webChannel: s.webChannel?.name,
    // The channel whose dates we show (see schedule.release): a network, else the streaming service.
    channelCountry: (s.network ?? s.webChannel)?.country?.code ?? undefined,
    showStatus: s.status,
    tvmUpdated: s.updated,
  };
}

export async function fetchShow(id: number): Promise<{ meta: Meta; episodes: TvmEpisode[] }> {
  const s = await getJson<TvmShow>(`${API}/shows/${id}?embed[]=episodes&embed[]=cast&embed[]=crew`);
  return { meta: showToMeta(s), episodes: s._embedded?.episodes ?? [] };
}

/** Map of show id → last-updated stamp, for shows changed in the last day/week. */
export function showUpdates(since: 'day' | 'week') {
  return getJson<Record<string, number>>(`${API}/updates/shows?since=${since}`);
}
