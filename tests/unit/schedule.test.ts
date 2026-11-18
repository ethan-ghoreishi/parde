import { afterEach, describe, expect, it } from 'vitest';
import { localDay, localTime, isAired, progress, release } from '../../src/lib/schedule';
import { formatDay } from '../../src/lib/format';
import type { Episode } from '../../src/lib/db';

const orig = process.env.TZ;
afterEach(() => {
  process.env.TZ = orig;
});

const ep = (o: Partial<Episode>): Episode => ({ id: 1, titleId: 't', season: 1, number: 1, name: '', airdate: '', airtime: '', ...o });

describe('localDay', () => {
  // A 9pm New York airing on 31 May is 1am UTC on 1 June.
  const us = ep({ airdate: '2026-05-31', airtime: '21:00', airstamp: '2026-06-01T01:00:00+00:00' });
  it('moves a US evening airing to the next morning in London', () => {
    process.env.TZ = 'Europe/London';
    expect(localDay(us)).toBe('2026-06-01');
    expect(localTime(us)).toBe('02:00');
  });
  it('keeps it on the same day in New York', () => {
    process.env.TZ = 'America/New_York';
    expect(localDay(us)).toBe('2026-05-31');
  });
  it('handles the night clocks change', () => {
    process.env.TZ = 'Europe/London';
    // BST starts 01:00 UTC on 29 March 2026
    expect(localTime(ep({ airtime: '20:30', airstamp: '2026-03-29T00:30:00+00:00' }))).toBe('00:30');
    expect(localTime(ep({ airtime: '21:30', airstamp: '2026-03-29T01:30:00+00:00' }))).toBe('02:30');
  });
  it('uses the published date for streaming drops without a time', () => {
    process.env.TZ = 'Pacific/Auckland';
    expect(localDay(ep({ airdate: '2026-01-17', airtime: '', airstamp: '2026-01-17T12:00:00+00:00' }))).toBe('2026-01-17');
  });
});

describe('progress', () => {
  const eps = [ep({ id: 1, number: 1, airdate: '2020-01-01' }), ep({ id: 2, number: 2, airdate: '2020-01-08' }), ep({ id: 3, number: 3, airdate: '2999-01-01' })];
  it('finds the next unseen and counts aired ones', () => {
    const p = progress(eps, new Set([1]), new Date('2026-01-01'));
    expect(p.next?.id).toBe(2);
    expect(p.unseenAired).toBe(1);
    expect(p.lastSeen?.id).toBe(1);
    expect(isAired(eps[2], new Date('2026-01-01'))).toBe(false);
  });
});

describe('release', () => {
  it('distinguishes streaming from broadcast', () => {
    expect(release({ webChannel: 'Netflix' })).toEqual({ kind: 'stream', where: 'Netflix' });
    expect(release({ network: 'HBO', webChannel: 'Max' })).toEqual({ kind: 'broadcast', where: 'HBO' });
  });
});

describe('formatDay', () => {
  it('names nearby days', () => {
    const today = new Date('2026-11-18T10:00:00');
    expect(formatDay('2026-11-18', today)).toBe('Today');
    expect(formatDay('2026-11-19', today)).toBe('Tomorrow');
    expect(formatDay('2024-02-01', today)).toBe('1 Feb 2024');
  });
});
