import { describe, expect, it } from 'vitest';
import { cleanUrl, expand, hostOf, replaceHost, resolveLinks, suggestPattern } from '../../src/lib/links';
import type { Link } from '../../src/lib/db';

describe('cleanUrl', () => {
  it('accepts http(s) and bare domains', () => {
    expect(cleanUrl(' https://a.org/x ')).toBe('https://a.org/x');
    expect(cleanUrl('a.org/watch?v=1')).toBe('https://a.org/watch?v=1');
    expect(cleanUrl('http://a.org')).toBe('http://a.org');
  });
  it('rejects dangerous or broken input', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'https://user:pw@a.org', 'not a url', '', 'https://nodot', 'vbscript:x']) {
      expect(cleanUrl(bad), bad).toBeNull();
    }
  });
  it('keeps pattern braces intact', () => {
    expect(cleanUrl('https://a.org/show/{s}/{e}')).toBe('https://a.org/show/{s}/{e}');
  });
});

describe('patterns', () => {
  it('expands with and without padding', () => {
    expect(expand('https://a.org/x-s{ss}e{ee}', 2, 3)).toBe('https://a.org/x-s02e03');
    expect(expand('https://a.org/{season}/{episode}', 10, 1)).toBe('https://a.org/10/1');
  });
  it.each([
    ['https://a.org/tv/severance-s02e03', 'https://a.org/tv/severance-s{ss}e{ee}'],
    ['https://a.org/tv/severance/season-2/episode-3', 'https://a.org/tv/severance/season-{s}/episode-{e}'],
    ['https://a.org/watch/severance-2x03.html', 'https://a.org/watch/severance-{s}x{ee}.html'],
    ['https://a.org/tv/123456/2/3', 'https://a.org/tv/123456/{s}/{e}'],
    ['https://a.org/embed/tv?id=99&s=2&e=3', null],
  ])('suggests %s', (url, want) => {
    expect(suggestPattern(url, 2, 3)).toBe(want);
  });
  it('does not confuse 12 with 2', () => {
    expect(suggestPattern('https://a.org/x/s12e3', 2, 3)).toBeNull();
  });
  it('round-trips: expanding the suggestion gives back the original', () => {
    const url = 'https://a.org/tv/show-s02e03';
    expect(expand(suggestPattern(url, 2, 3)!, 2, 3)).toBe(url);
  });
});

describe('hosts', () => {
  it('finds and replaces hosts exactly', () => {
    expect(hostOf('https://www.Old.to/a')).toBe('old.to');
    expect(replaceHost('https://www.old.to/a/{s}?q=old.to', 'old.to', 'new.se')).toBe('https://www.new.se/a/{s}?q=old.to');
    expect(replaceHost('https://notold.to/a', 'old.to', 'new.se')).toBe('https://notold.to/a');
  });
});

describe('resolveLinks', () => {
  const L = (id: string, extra: Partial<Link>): Link => ({ id, titleId: 't', url: `https://${id}.org/`, addedAt: '2026-01-01', ...extra });
  const links = [
    L('show', {}),
    L('pat', { url: 'https://p.org/x/{s}/{e}' }),
    L('season', { season: 1 }),
    L('ep', { season: 1, episode: 2 }),
    L('broken', { season: 1, episode: 2, broken: true }),
    L('other', { season: 2, episode: 1 }),
  ];
  it('orders episode > season > pattern > show, working before broken', () => {
    const r = resolveLinks(links, 1, 2);
    expect(r.map((x) => x.link.id)).toEqual(['ep', 'broken', 'season', 'pat', 'show']);
    expect(r.find((x) => x.link.id === 'pat')!.url).toBe('https://p.org/x/1/2');
  });
  it('for films, uses only whole-title links', () => {
    expect(resolveLinks(links).map((x) => x.link.id).sort()).toEqual(['pat', 'show']);
  });
});
