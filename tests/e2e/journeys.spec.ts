import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const wd = JSON.parse(readFileSync('tests/fixtures/wd-dune2.json', 'utf8'));
const sev = JSON.parse(readFileSync('tests/fixtures/tvm-severance.json', 'utf8'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** Every external API is stubbed: tests never depend on live services. */
async function stub(page: Page) {
  await page.route(/en\.wikipedia\.org\/w\/api\.php/, (r) =>
    r.fulfill({
      json: { query: { pages: [{ index: 1, title: 'Dune: Part Two', description: '2024 film by Denis Villeneuve', pageprops: { wikibase_item: 'Q109228991' } }] } },
    }),
  );
  await page.route(/rest_v1\/page\/summary/, (r) =>
    r.fulfill({ json: { thumbnail: { source: 'https://upload.wikimedia.org/poster.png' }, extract: 'Paul Atreides unites with the Fremen.', wikibase_item: 'Q109228991' } }),
  );
  await page.route(/upload\.wikimedia\.org|static\.tvmaze\.com/, (r) => r.fulfill({ body: PNG, contentType: 'image/png' }));
  await page.route(/www\.wikidata\.org\/w\/api\.php/, (r) => {
    const u = new URL(r.request().url());
    if (u.searchParams.get('list') === 'search') return r.fulfill({ json: { query: { search: [] } } });
    const ids = u.searchParams.get('ids')!.split('|');
    if (ids[0] === 'Q109228991') return r.fulfill({ json: { entities: { Q109228991: wd } } });
    const names: Record<string, string> = { Q548823: 'Denis Villeneuve' };
    return r.fulfill({ json: { entities: Object.fromEntries(ids.map((id) => [id, { labels: { en: { value: names[id] ?? `Label ${id}` } } }])) } });
  });
  await page.route(/api\.tvmaze\.com\/search\/shows/, (r) => r.fulfill({ json: [{ show: sev }] }));
  await page.route(/api\.tvmaze\.com\/shows\/44933/, (r) => r.fulfill({ json: sev }));
  await page.route(/api\.tvmaze\.com\/updates/, (r) => r.fulfill({ json: {} }));
  // Viewing sites open in new tabs: serve a blank page so the URL can be checked.
  await page.context().route(/site-[ab]\.org/, (r) => r.fulfill({ body: '<title>site</title>', contentType: 'text/html' }));
}

async function search(page: Page, q: string) {
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByPlaceholder('Search by title…').fill(q);
}

test.beforeEach(async ({ page }) => {
  await stub(page);
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

  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download backup' }).click()]);
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

test('no horizontal scroll on key pages', async ({ page }) => {
  for (const p of ['./', './#/calendar', './#/library', './#/taste', './#/settings']) {
    await page.goto(p);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, p).toBeLessThanOrEqual(0);
  }
});
