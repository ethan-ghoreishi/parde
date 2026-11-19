import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const wd = JSON.parse(readFileSync('tests/fixtures/wd-dune2.json', 'utf8'));
const sev = JSON.parse(readFileSync('tests/fixtures/tvm-severance.json', 'utf8'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const heat = { ...wd, id: 'Q42198', labels: { en: { value: 'Heat', language: 'en' } }, sitelinks: { enwiki: { site: 'enwiki', title: 'Heat (1995 film)' } } };
const WD_ENTITIES: Record<string, unknown> = { Q109228991: wd, Q42198: heat };
const sparqlRow = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v }]));

/** Every external API is stubbed: tests never depend on live services. */
async function stub(page: Page) {
  await page.route(/en\.wikipedia\.org\/w\/api\.php/, (r) => {
    const u = new URL(r.request().url());
    const titles = u.searchParams.get('titles');
    if (titles) {
      // Posters and opening paragraphs for known articles
      return r.fulfill({ json: { query: { pages: titles.split('|').map((title) => ({ title, thumbnail: { source: 'https://upload.wikimedia.org/poster.png?utm_source=x' }, extract: `${title}: a film.` })) } } });
    }
    return r.fulfill({
      json: { query: { pages: [{ index: 1, title: 'Dune: Part Two', description: '2024 film by Denis Villeneuve', pageprops: { wikibase_item: 'Q109228991' }, thumbnail: { source: 'https://upload.wikimedia.org/poster.png' } }] } },
    });
  });
  await page.route(/upload\.wikimedia\.org|static\.tvmaze\.com/, (r) => r.fulfill({ body: PNG, contentType: 'image/png' }));
  await page.route(/www\.wikidata\.org\/w\/api\.php/, (r) => {
    const u = new URL(r.request().url());
    if (u.searchParams.get('list') === 'search') return r.fulfill({ json: { query: { search: [] } } });
    if (u.searchParams.get('action') === 'wbsearchentities') {
      return r.fulfill({ json: { search: [{ id: 'Q548823', label: 'Denis Villeneuve', description: 'Canadian film director (born 1967)' }] } });
    }
    const ids = u.searchParams.get('ids')!.split('|');
    const names: Record<string, string> = { Q548823: 'Denis Villeneuve' };
    return r.fulfill({
      json: { entities: Object.fromEntries(ids.map((id) => [id, WD_ENTITIES[id] ?? { labels: { en: { value: names[id] ?? `Label ${id}` } }, descriptions: { en: { value: 'Canadian film director' } }, sitelinks: {} }])) },
    });
  });
  await page.route(/query\.wikidata\.org\/sparql/, (r) => {
    const q = new URL(r.request().url()).searchParams.get('query')!;
    if (q.includes('wikibase:sitelinks')) {
      return r.fulfill({ json: { results: { bindings: [
        sparqlRow({ name: 'Heat', item: 'http://www.wikidata.org/entity/Q42198', type: 'http://www.wikidata.org/entity/Q11424', links: '80', y: '1995' }),
        sparqlRow({ name: 'Heat', item: 'http://www.wikidata.org/entity/Q1', type: 'http://www.wikidata.org/entity/Q11424', links: '5', y: '1972' }),
      ] } } });
    }
    // A person's filmography
    return r.fulfill({ json: { results: { bindings: [
      sparqlRow({ w: 'http://www.wikidata.org/entity/Q109228991', wLabel: 'Dune: Part Two', prop: 'http://www.wikidata.org/prop/direct/P57', type: 'http://www.wikidata.org/entity/Q11424', person: 'http://www.wikidata.org/entity/Q548823', y: '2024', article: 'https://en.wikipedia.org/wiki/Dune:_Part_Two' }),
      sparqlRow({ w: 'http://www.wikidata.org/entity/Q42198', wLabel: 'Heat', prop: 'http://www.wikidata.org/prop/direct/P57', type: 'http://www.wikidata.org/entity/Q11424', person: 'http://www.wikidata.org/entity/Q548823', y: '1995', article: 'https://en.wikipedia.org/wiki/Heat_(1995_film)' }),
    ] } } });
  });
  await page.route(/api\.tvmaze\.com\/search\/shows/, (r) => r.fulfill({ json: [{ show: sev }] }));
  await page.route(/api\.tvmaze\.com\/lookup\/shows/, (r) => r.fulfill({ json: sev }));
  await page.route(/api\.tvmaze\.com\/shows\/44933/, (r) => r.fulfill({ json: sev }));
  await page.route(/api\.tvmaze\.com\/updates/, (r) => r.fulfill({ json: {} }));
  // Viewing sites open in new tabs: serve a blank page so the URL can be checked.
  await page.context().route(/site-[ab]\.org/, (r) => r.fulfill({ body: '<title>site</title>', contentType: 'text/html' }));
}

async function search(page: Page, q: string) {
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByPlaceholder('Title or person…').fill(q);
}

test.beforeEach(async ({ page }) => {
  await stub(page);
  // Phones get the share sheet for backups; tests take the download path everywhere.
  await page.addInitScript(() => Object.defineProperty(navigator, 'canShare', { value: undefined }));
  await page.goto('./');
});

test('add a film as seen, rate it inline, and see it in the library and taste page', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Welcome to Parde' })).toBeVisible();
  await search(page, 'dune');
  const row = page.locator('li.hit', { hasText: 'Dune: Part Two' });
  await row.getByRole('button', { name: 'Seen' }).click();
  await expect(row.getByText('Your rating')).toBeVisible();
  await row.getByRole('button', { name: '9', exact: true }).click();
  await expect(row.getByRole('button', { name: '9', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await row.getByRole('button', { name: 'Open' }).click();

  await expect(page.getByRole('heading', { name: 'Dune: Part Two', level: 1 })).toBeVisible();
  await expect(page.getByText('92% Rotten Tomatoes')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Denis Villeneuve' })).toBeVisible();
  await expect(page.getByText('director, writer')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Your rating' }).getByRole('button', { name: '9', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('link', { name: 'Library' }).first().click();
  await expect(page.locator('.tile', { hasText: 'Dune: Part Two' })).toContainText('9');
  await page.goto('./#/taste');
  await expect(page.locator('.stats')).toContainText('1films watched');
});

test('want a film, record trailer keenness, log a watch with partner rating', async ({ page }) => {
  await page.goto('./#/settings');
  await page.getByLabel(/Partner's name/).fill('Sara');
  await page.getByLabel(/Partner's name/).blur();
  await search(page, 'dune');
  const row = page.locator('li.hit', { hasText: 'Dune: Part Two' });
  await row.getByRole('button', { name: 'Want' }).click();
  await expect(row.getByText('After the trailer, how keen are you?')).toBeVisible();
  await row.getByRole('button', { name: '4', exact: true }).click();
  await row.getByRole('button', { name: 'Open' }).click();

  await expect(page.getByRole('group', { name: 'Expectation' }).getByRole('button', { name: 'Keen' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'We watched it' }).click();
  const dlg = page.getByRole('dialog', { name: /Watched/ });
  await dlg.getByRole('group', { name: 'Your rating' }).getByRole('button', { name: '6', exact: true }).click();
  await dlg.getByRole('group', { name: 'Partner rating' }).getByRole('button', { name: '9', exact: true }).click();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Watched', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(/together/)).toBeVisible();
  await expect(page.getByText('Sara', { exact: true })).toBeVisible();
  // Hindsight cannot change the expectation any more
  await expect(page.getByText(/Before watching you were keen/)).toBeVisible();

  // Themes in a tap, then a review prompt built only from what was said
  await page.getByRole('group', { name: 'Themes' }).getByRole('button', { name: 'memory' }).click();
  await expect(page.getByRole('group', { name: 'Themes' }).getByRole('button', { name: 'memory' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByText('See the prompt').click();
  const prompt = page.locator('.assist pre');
  await expect(prompt).toContainText('My rating: 6/10 (my partner: 9/10)');
  await expect(prompt).not.toContainText('Sara'); // nobody else's name goes to an assistant
  await expect(prompt).toContainText('What it was about for me: memory');
  await expect(prompt).toContainText('Do not invent opinions');

  // The assistant opens as an empty chat: the prompt travels by clipboard, never in the address.
  await page.context().route(/claude\.ai/, (r) => r.fulfill({ body: '<title>claude</title>', contentType: 'text/html' }));
  const [chat] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'Open Claude ↗' }).click()]);
  await chat.waitForLoadState();
  expect(chat.url()).toBe('https://claude.ai/new');
  await chat.close();

  // Cancel in the log dialog really cancels, themes included.
  await page.getByRole('button', { name: 'Log a rewatch' }).click();
  const again = page.getByRole('dialog', { name: /Watched/ });
  await again.getByRole('group', { name: 'Themes' }).getByRole('button', { name: 'grief' }).click();
  await again.getByRole('button', { name: 'Cancel' }).click();
  await expect(again).toBeHidden();
  await expect(page.getByRole('group', { name: 'Themes' }).getByRole('button', { name: 'grief' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('group', { name: 'Themes' }).getByRole('button', { name: 'memory' })).toHaveAttribute('aria-pressed', 'true');
});

test('a series already part-watched is placed in one step, and Tonight resumes there', async ({ page }) => {
  await search(page, 'severance');
  const row = page.locator('li.hit', { hasText: 'Severance' });
  await row.getByRole('button', { name: 'Watching' }).click();
  await row.getByLabel('Where are you up to?').selectOption({ label: 'S01E09 · end of season 1' });
  await expect(page.getByRole('status')).toContainText('Seen up to S01E09');
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(page.locator('.next-ep')).toContainText('S02E01');
  await page.getByRole('link', { name: 'Tonight' }).first().click();
  await expect(page.locator('.continue li', { hasText: 'Severance' })).toContainText('S02E01');
});

test('discover through people: a director’s filmography, one tap to want', async ({ page }) => {
  await search(page, 'dune');
  await page.locator('li.hit', { hasText: 'Dune: Part Two' }).getByRole('button', { name: 'Seen' }).click();
  await page.locator('li.hit').getByRole('button', { name: 'Open' }).click();
  await page.getByRole('link', { name: 'Denis Villeneuve' }).click();
  await expect(page.getByRole('heading', { name: 'Denis Villeneuve', level: 1 })).toBeVisible();
  await expect(page.getByText('In your library')).toBeVisible();
  const heatRow = page.locator('.work li', { hasText: 'Heat' });
  await heatRow.getByRole('button', { name: 'Want' }).click();
  await expect(heatRow).toContainText('On your list');
  // People are also searchable directly
  await search(page, 'villeneuve');
  await expect(page.getByRole('link', { name: /Denis Villeneuve/ })).toBeVisible();
});

test('import a typed list: exact matches go straight in, series land where you are', async ({ page }) => {
  await page.goto('./#/import');
  await page.getByLabel(/type or paste a list/).fill('Heat 1995 9\nSeverance S01E05');
  await page.getByRole('button', { name: 'Find 2 titles' }).click();
  await expect(page.getByText(/2\s*ready/)).toBeVisible();
  await page.getByRole('button', { name: 'Add 2 titles' }).click();
  await expect(page.getByRole('heading', { name: 'Done' })).toBeVisible();
  await expect(page.getByText('Added 2')).toBeVisible();
  await page.goto('./#/library');
  await expect(page.locator('.tile', { hasText: 'Heat' })).toContainText('9');
  await page.locator('.tile', { hasText: 'Severance' }).click();
  await expect(page.locator('.next-ep')).toContainText('S01E06');
});

test('calendar groups a season drop and says where the date comes from', async ({ page }) => {
  await search(page, 'severance');
  await page.locator('li.hit', { hasText: 'Severance' }).getByRole('button', { name: 'Watching' }).click();
  await page.keyboard.press('Escape');
  await page.goto('./#/calendar?d=2022-02-18');
  const card = page.locator('.eps li', { hasText: 'Severance' }).first();
  await expect(card).toContainText('S01E01–E02 · 2 episodes');
  await expect(card).toContainText('Released on Apple TV');
  await expect(card).toContainText('No source saved');
  await card.getByRole('button', { name: 'All seen' }).click();
  await expect(card).toContainText('All seen');
});

test('follow a series: pattern source, resume from Tonight, broken-link fallback', async ({ page }) => {
  await search(page, 'severance');
  const row = page.locator('li.hit', { hasText: 'Severance' });
  await row.getByRole('button', { name: 'Watching' }).click();
  await row.getByRole('button', { name: 'Open' }).click();

  await expect(page.getByRole('heading', { name: 'Severance', level: 1 })).toBeVisible();
  await expect(page.locator('.next-ep')).toContainText('S01E01');
  // Save a whole-series pattern from an episode link
  await page.locator('button.line', { hasText: 'S01E01' }).click();
  await page.getByRole('region', { name: 'Sources for S01E01' }).getByRole('button', { name: '+ Add source' }).click();
  await page.getByRole('textbox', { name: 'Link' }).fill('https://site-a.org/tv/severance-s01e01');
  await page.getByRole('button', { name: 'Use for every episode' }).click();
  await expect(page.getByRole('button', { name: /Watch on site-a\.org/ })).toBeVisible();

  // A plain backup source for the whole series
  await page.getByRole('region', { name: 'Sources for the whole series' }).getByRole('button', { name: '+ Add source' }).click();
  await page.getByRole('region', { name: 'Sources for the whole series' }).getByRole('textbox', { name: 'Link' }).fill('site-b.org/severance');
  await page.getByRole('region', { name: 'Sources for the whole series' }).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toContainText('Source saved');

  // Resume from Tonight
  await page.getByRole('link', { name: 'Tonight' }).first().click();
  const card = page.locator('.continue li', { hasText: 'Severance' });
  await expect(card).toContainText('S01E01');
  await card.getByRole('button', { name: 'Seen' }).click();
  await expect(card).toContainText('S01E02');

  // Opening a source opens a new tab with the expanded pattern, without referrer/opener
  const [popup] = await Promise.all([page.waitForEvent('popup'), card.getByRole('button', { name: /Watch on site-a\.org/ }).click()]);
  await expect.poll(() => popup.url()).toContain('site-a.org/tv/severance-s01e02');
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  await popup.close();

  // Mark it broken: the next source takes over
  await card.locator('a.name').click();
  await page.getByRole('region', { name: 'Sources for the whole series' }).getByRole('button', { name: 'Broken' }).first().click();
  await expect(page.getByRole('button', { name: /Watch on site-b\.org/ })).toBeVisible();
});

test('backup downloads, rejects junk, and restores into an empty browser', async ({ page, browser }) => {
  await search(page, 'dune');
  await page.locator('li.hit', { hasText: 'Dune: Part Two' }).getByRole('button', { name: 'Want' }).click();
  await expect(page.locator('li.hit').getByRole('button', { name: 'Open' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto('./#/settings');

  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save a backup' }).click()]);
  const path = await dl.path();
  const text = readFileSync(path, 'utf8');
  expect(JSON.parse(text)).toMatchObject({ app: 'parde', schemaVersion: 1 });

  await page.locator('input[type=file]').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"nope":1}') });
  await expect(page.getByRole('alert')).toContainText('not a Parde backup');

  // Restore into a brand-new browser profile
  const fresh = await browser.newContext();
  const p2 = await fresh.newPage();
  await stub(p2);
  await p2.goto('./#/settings');
  await p2.locator('input[type=file]').setInputFiles({ name: 'parde.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await expect(p2.getByRole('region', { name: 'Backup preview' })).toContainText('1 titles');
  await p2.getByRole('button', { name: 'Merge into this browser' }).click();
  await expect(p2.getByRole('status')).toContainText('merged');
  await p2.goto('./#/library');
  await expect(p2.locator('.tile', { hasText: 'Dune: Part Two' })).toBeVisible();
  await fresh.close();
});

test('layout: no horizontal scroll; the page scrolls, the tab bar stays on the bottom edge and never covers the end of a page', async ({ page, isMobile }) => {
  await search(page, 'severance');
  const hit = page.locator('li.hit', { hasText: 'Severance' });
  await hit.getByRole('button', { name: 'Watching' }).click();
  // Navigating away while the series is still being saved would abort the save.
  await expect(hit.getByText('Where are you up to?')).toBeVisible();
  await page.keyboard.press('Escape');
  // Short pages (an empty calendar day) and long ones (a series with its episode list)
  for (const p of ['./', './#/calendar?d=2001-01-01', './#/library', './#/taste', './#/settings', './#/import', './#/t/tvm%3A44933']) {
    await page.goto(p);
    await page.waitForTimeout(150);
    const at = (where: 'top' | 'end') =>
      page.evaluate((where) => {
        if (where === 'end') scrollTo(0, document.documentElement.scrollHeight);
        const nav = document.querySelector('nav.bottom')!.getBoundingClientRect();
        const main = document.getElementById('main')!;
        const last = [...main.querySelectorAll('*')].filter((el) => el.getClientRects().length).at(-1)!.getBoundingClientRect();
        return {
          docX: document.documentElement.scrollWidth - innerWidth,
          navBottom: Math.round(nav.bottom) - innerHeight,
          lastClear: Math.round(nav.top - last.bottom),
          headerTop: Math.round(document.querySelector('header')!.getBoundingClientRect().top),
        };
      }, where);
    const top = await at('top');
    expect(top.docX, p).toBeLessThanOrEqual(0);
    const end = await at('end');
    expect(end.headerTop, p).toBe(0);
    if (isMobile) {
      expect(top.navBottom, p).toBe(0);
      expect(end.navBottom, p).toBe(0);
      expect(end.lastClear, `${p}: end of the page is above the tab bar`).toBeGreaterThanOrEqual(0);
    }
  }
  if (isMobile) {
    // A long page really scrolls the document (so iOS can collapse Safari's toolbar and status-bar taps scroll up).
    await page.goto('./#/t/tvm%3A44933');
    await page.getByRole('button', { name: /Season 1/ }).first().waitFor();
    await page.evaluate(() => scrollBy(0, 600));
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
    // Changing page starts at the top.
    await page.getByRole('link', { name: 'Library' }).last().click();
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  }
});

test('when Wikimedia is busy, search says so instead of showing no films', async ({ page }) => {
  await page.route(/wikipedia\.org|wikidata\.org/, (r) => r.fulfill({ status: 429, body: 'Too many requests' }));
  await search(page, 'severance');
  await expect(page.locator('li.hit', { hasText: 'Severance' })).toBeVisible();
  await expect(page.getByText(/Films and people unavailable just now/)).toBeVisible();
});

test.describe('offline', () => {
  test.use({ serviceWorkers: 'allow' });
  test('with no connection the installed app still opens with your collection', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'Playwright drives service workers reliably only in Chromium');
    await search(page, 'dune');
    await page.locator('li.hit', { hasText: 'Dune: Part Two' }).getByRole('button', { name: 'Seen' }).click();
    await expect(page.locator('li.hit', { hasText: 'Dune: Part Two' }).getByText('Your rating')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

    await context.setOffline(true);
    await page.goto('./#/library');
    await page.reload(); // the page itself now comes from the service worker's cache
    await expect(page.locator('.tile', { hasText: 'Dune: Part Two' })).toBeVisible();
    await page.locator('.tile', { hasText: 'Dune: Part Two' }).click();
    await expect(page.getByRole('heading', { name: 'Dune: Part Two' })).toBeVisible();
    await page.getByRole('link', { name: 'Taste' }).first().click();
    await expect(page.getByRole('heading', { name: 'Your taste' })).toBeVisible();
    await context.setOffline(false);
  });
});
