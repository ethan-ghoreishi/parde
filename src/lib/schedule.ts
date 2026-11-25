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

/**
 * "Ended" alone does not mean our list reaches the end: it may be a partial reply. Either every season is as long as
 * TVmaze says, or the last date we hold is the one it ended on and the last season is not short. Neither alone will
 * do: lengths are often off by one or two in long seasons (The Office, Buffy), a later special can carry the end date
 * (Breaking Bad), and a season released in one day reaches the end date with its first episode. Episodes that never
 * got a date (Firefly) are not waited for.
 */
export function completeSchedule(t: Pick<Title, 'showStatus' | 'endedOn' | 'episodeOrders'>, episodes: Episode[]) {
  const listed = episodes.filter((e) => !e.missingSince);
  const dated = listed.filter((e) => e.airdate);
  if (t.showStatus !== 'Ended' || !dated.length || dated.some((e) => !isAired(e))) return false;
  const orders = t.episodeOrders ?? [];
  const last = Math.max(...listed.map((e) => e.season));
  if (orders.length > last) return false;
  const inSeason = (n: number) => listed.filter((e) => e.season === n).length;
  if (orders.length && orders.every((n, i) => n === inSeason(i + 1))) return true;
  const order = orders[last - 1] ?? 0;
  return dated.map((e) => e.airdate).sort().at(-1) === t.endedOn && order - inSeason(last) <= order * 0.08;
}

/** Out, or never given a date by a series that is over: either can have been seen. */
export const canMark = (t: Pick<Title, 'showStatus'>, e: Episode) => !e.missingSince && (isAired(e) || (!e.airdate && t.showStatus === 'Ended'));

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
  const currentSlots = new Set(sorted.filter((e) => !e.missingSince).map(code));
  const last = sorted.findLastIndex((e) => seen.has(e.id) && (!e.missingSince || !currentSlots.has(code(e))));
  const ahead = sorted.slice(last + 1).filter((e) => !e.missingSince);
  return {
    next: ahead.find((e) => isAired(e, now)) ?? ahead.find((e) => e.airdate),
    unseenAired: ahead.filter((e) => isAired(e, now)).length,
    seenCount: sorted.filter((e) => seen.has(e.id)).length,
    total: sorted.length,
    lastSeen: sorted[last],
    skipped: last + 1 - sorted.slice(0, last + 1).filter((e) => seen.has(e.id)).length,
    unlisted: episodes.filter((e) => !isListed(e, seen) && isAired(e, now) && (!sorted[last] || byOrder(e, sorted[last]) > 0)).length,
  };
}
