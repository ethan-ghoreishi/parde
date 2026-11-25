import type { Episode, Title } from './db';

const two = (n: number) => String(n).padStart(2, '0');
export const dayKey = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;

/**
 * The local calendar day an episode becomes available. With a known air time we convert the
 * UTC airstamp to this device's time zone (a 9pm New York airing is the next morning in London).
 * Without one (most streaming drops), the published date stands as-is.
 */
export function localDay(ep: Pick<Episode, 'airdate' | 'airtime' | 'airstamp'>): string {
  if (ep.airtime && ep.airstamp) {
    const d = new Date(ep.airstamp);
    if (!Number.isNaN(d.getTime())) return dayKey(d);
  }
  return ep.airdate;
}

export function localTime(ep: Pick<Episode, 'airtime' | 'airstamp'>): string | null {
  if (!ep.airtime || !ep.airstamp) return null;
  const d = new Date(ep.airstamp);
  return Number.isNaN(d.getTime()) ? null : `${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function isAired(ep: Pick<Episode, 'airdate' | 'airtime' | 'airstamp'>, now = new Date()): boolean {
  if (ep.airtime && ep.airstamp) return new Date(ep.airstamp).getTime() <= now.getTime();
  return !!ep.airdate && ep.airdate <= dayKey(now);
}

/**
 * Where the date comes from. A streaming service's own release is a confirmed availability date;
 * a broadcast network's date is when it airs on TV, and says nothing certain about streaming.
 */
export function release(t: Pick<Title, 'network' | 'webChannel'>): { kind: 'stream' | 'broadcast' | 'unknown'; where?: string } {
  if (t.webChannel && !t.network) return { kind: 'stream', where: t.webChannel };
  if (t.network) return { kind: 'broadcast', where: t.network };
  return { kind: 'unknown' };
}

export const byOrder = (a: Episode, b: Episode) => a.season - b.season || a.number - b.number;

export const code = (e: Pick<Episode, 'season' | 'number'>) => `S${two(e.season)}E${two(e.number)}`;

export interface Progress {
  /** The episode after the furthest one seen: where you are, even if you skipped something earlier */
  next?: Episode;
  /** Aired episodes from `next` on */
  unseenAired: number;
  seenCount: number;
  total: number;
  lastSeen?: Episode;
  /** Unmarked episodes before the furthest one seen (skipped, or never ticked) */
  skipped: number;
  /** Out, unseen, and no longer in TVmaze's list: cannot be "next", but the series may not be over either */
  unlisted: number;
}

/** Worth showing: in TVmaze's list, or one you have seen. */
export const isListed = (e: Pick<Episode, 'id' | 'missingSince'>, seen: Set<number>) => !e.missingSince || seen.has(e.id);

/** Dropping a series hides it from the calendar without changing your calendar choice. */
export const onCalendar = (t: Pick<Title, 'followed' | 'status'>) => !!t.followed && t.status !== 'dropped';

export function progress(episodes: Episode[], seen: Set<number>, now = new Date()): Progress {
  const sorted = episodes.filter((e) => isListed(e, seen)).sort(byOrder);
  const last = sorted.findLastIndex((e) => seen.has(e.id));
  const ahead = sorted.slice(last + 1);
  return {
    next: ahead[0],
    unseenAired: ahead.filter((e) => isAired(e, now)).length,
    seenCount: sorted.filter((e) => seen.has(e.id)).length,
    total: sorted.length,
    lastSeen: sorted[last],
    skipped: last + 1 - sorted.slice(0, last + 1).filter((e) => seen.has(e.id)).length,
    unlisted: episodes.filter((e) => !isListed(e, seen) && isAired(e, now) && (!sorted[last] || byOrder(e, sorted[last]) > 0)).length,
  };
}
