import { cleanUrl } from './links';

/** A site you can search when a saved link stops working. `{q}` is replaced by the title. */
export interface Site {
  name: string;
  url: string;
}

const region = (navigator.language.split('-')[1] ?? 'gb').toLowerCase();

export const DEFAULT_SITES: Site[] = [
  { name: 'JustWatch', url: `https://www.justwatch.com/${region === 'gb' ? 'uk' : region}/search?q={q}` },
];

export const siteUrl = (s: Site, q: string) => s.url.replace(/\{q\}/g, encodeURIComponent(q));

export function validSite(s: Site): boolean {
  return !!s.name.trim() && s.url.includes('{q}') && !!cleanUrl(s.url.replace(/\{q\}/g, 'x'));
}
