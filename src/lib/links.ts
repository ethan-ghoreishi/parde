import type { Link } from './db';

const TOKEN = /\{(s|e|ss|ee|season|episode)\}/;
const pad = (n: number) => String(n).padStart(2, '0');

export const isPattern = (url: string) => TOKEN.test(url);

export function expand(url: string, season: number, episode: number): string {
  return url
    .replace(/\{ss\}/g, pad(season))
    .replace(/\{ee\}/g, pad(episode))
    .replace(/\{(s|season)\}/g, String(season))
    .replace(/\{(e|episode)\}/g, String(episode));
}

/**
 * Accept only http(s) URLs, without embedded credentials. A bare domain gets https://.
 * Returns the cleaned string (not URL.href, which would encode pattern braces), or null.
 */
export function cleanUrl(input: string): string | null {
  let s = input.trim();
  if (!s || /[\s\\\u0000-\u001f\u007f]/.test(s)) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    if (!/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/.test(s)) return null;
    s = `https://${s}`;
  }
  let u: URL;
  try {
    u = new URL(expand(s, 1, 1));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (isPattern(s.split(/[/?#]/).slice(0, 3).join('/'))) return null;
  if (u.username || u.password || !u.hostname.includes('.') && u.hostname !== 'localhost') return null;
  return s;
}

export function hostOf(url: string): string {
  const m = url.match(/^https?:\/\/([^/:?#]+)/i);
  return (m?.[1] ?? '').toLowerCase().replace(/^www\./, '');
}

/** Swap the host of a stored link when a site moves domain, keeping path and query exactly. */
export function replaceHost(url: string, from: string, to: string): string {
  return url.replace(/^(https?:\/\/)(www\.)?([^/:?#]+)/i, (all, scheme: string, www: string | undefined, host: string) =>
    host.toLowerCase() === from.toLowerCase() ? `${scheme}${www ?? ''}${to}` : all,
  );
}

/**
 * If an episode link contains its season and episode numbers in a recognisable shape,
 * return it as a pattern ({s}/{e}, or {ss}/{ee} when zero-padded) that works for every episode.
 */
export function suggestPattern(url: string, season: number, episode: number): string | null {
  if (isPattern(url)) return null;
  const S = `(0*${season})`;
  const E = `(0*${episode})`;
  const shapes = [
    `(s)${S}([-_.]?e)${E}(?!\\d)`,
    `(season[-_/=]?)${S}([-_/&]+(?:episode|ep|e)[-_/=]?)${E}(?!\\d)`,
    `(\\D)${S}(x)${E}(?!\\d)`,
    `(\\D)${S}([-_/])${E}(?!\\d)`,
  ];
  const tail = url.indexOf('://') + 3;
  const pathStart = url.indexOf('/', tail);
  if (pathStart < 0) return null;
  for (const shape of shapes) {
    const matches = [...url.matchAll(new RegExp(shape, 'gi'))].filter((m) => m.index! + 1 >= pathStart);
    const m = matches.at(-1);
    if (!m) continue;
    const tok = (digits: string, short: string, long: string) => (digits.length > 1 && digits.startsWith('0') ? long : short);
    const replaced = m[1] + tok(m[2], '{s}', '{ss}') + m[3] + tok(m[4], '{e}', '{ee}');
    return url.slice(0, m.index) + replaced + url.slice(m.index! + m[0].length);
  }
  return null;
}

export type Level = 'episode' | 'season' | 'show' | 'title';
export interface Resolved {
  link: Link;
  url: string;
  level: Level;
  broken?: boolean;
}

const order = (a: Resolved, b: Resolved) =>
  Number(!!a.broken) - Number(!!b.broken) ||
  (b.link.usedAt ?? '').localeCompare(a.link.usedAt ?? '') ||
  b.link.addedAt.localeCompare(a.link.addedAt);

/**
 * Sources for a film, or for one episode of a show: exact episode links first, then the
 * season's, then show-wide patterns expanded for this episode, then plain show links.
 * Within a level, working links before broken ones, most recently used first.
 */
export function resolveLinks(links: Link[], season?: number, episode?: number): Resolved[] {
  if (season === undefined || episode === undefined) {
    return links.filter((l) => l.season === undefined).map((link) => ({ link, url: link.url, level: 'title' as const, broken: link.broken })).sort(order);
  }
  const ep: Resolved[] = [];
  const se: Resolved[] = [];
  const pat: Resolved[] = [];
  const show: Resolved[] = [];
  for (const link of links) {
    const broken = link.broken || link.failedEpisodes?.includes(`${season}:${episode}`);
    if (link.season === season && link.episode === episode) ep.push({ link, url: link.url, level: 'episode', broken });
    else if (link.season === season && link.episode === undefined) se.push({ link, url: expand(link.url, season, episode), level: 'season', broken });
    else if (link.season === undefined && isPattern(link.url)) pat.push({ link, url: expand(link.url, season, episode), level: 'show', broken });
    else if (link.season === undefined) show.push({ link, url: link.url, level: 'show', broken });
  }
  return [...ep.sort(order), ...se.sort(order), ...pat.sort(order), ...show.sort(order)];
}

/** Open an external source without giving it a handle on Parde or a referrer. */
export function openExternal(url: string) {
  const clean = cleanUrl(url);
  if (!clean || isPattern(clean)) return false;
  const a = document.createElement('a');
  a.href = clean;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.referrerPolicy = 'no-referrer';
  a.click();
  return true;
}
