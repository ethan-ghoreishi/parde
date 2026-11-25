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
    if (q.includes('AS %found')) {
      // Discover: what shares a thread
      return r.fulfill({ json: { results: { bindings: [
        sparqlRow({ f: 'http://www.wikidata.org/entity/Q42198', fLabel: 'Heat', types: 'http://www.wikidata.org/entity/Q11424', l: '60', score: '9', y: '1995', article: 'https://en.wikipedia.org/wiki/Heat_(1995_film)' }),
        sparqlRow({ f: 'http://www.wikidata.org/entity/Q700', fLabel: 'Thief', types: 'http://www.wikidata.org/entity/Q11424', l: '30', score: '5', y: '1981' }),
        sparqlRow({ f: 'http://www.wikidata.org/entity/Q701', fLabel: 'Manhunter', types: 'http://www.wikidata.org/entity/Q11424', l: '30', score: '4', y: '1986' }),
        sparqlRow({ f: 'http://www.wikidata.org/entity/Q702', fLabel: 'Severance', types: 'http://www.wikidata.org/entity/Q5398426', l: '30', score: '3', y: '2022', tvm: '44933' }),
      ] } } });
    }
    if (q.includes('VALUES ?label')) {
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
  // Rated: nothing left to influence, so what others thought is open, in words that say what it measures
  await expect(page.getByRole('listitem').filter({ hasText: '92% of critics positive (Rotten Tomatoes)' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Denis Villeneuve' })).toBeVisible();
  await expect(page.getByText('director, writer')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Your rating' }).getByRole('button', { name: '9', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('link', { name: 'Library' }).first().click();
  await expect(page.locator('.tile', { hasText: 'Dune: Part Two' })).toContainText('9');
  await page.goto('./#/taste');
  await expect(page.locator('.stats')).toContainText('1films seen');
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
  await expect(page.getByText(/Recorded keenness: keen/)).toBeVisible();

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
  // The toast is inside the open dialog, so its Undo can be reached
  const undo = page.locator('dialog[open]').getByRole('button', { name: 'Undo' });
  await undo.click();
  await expect(row.getByLabel('Where are you up to?')).toHaveValue('none');
  await row.getByLabel('Where are you up to?').selectOption({ label: 'S01E09 · end of season 1' });
  await expect(undo).toBeVisible();
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
  await expect(card.getByRole('button', { name: 'Sources for Severance S01E01' })).toContainText('Add a source');
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
  await expect(page.locator('.toast').first()).toContainText('Source saved');

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

  // It did not work: one tap opens the next source, and the broken one steps aside
  const [second] = await Promise.all([page.waitForEvent('popup'), card.getByRole('button', { name: 'Try site-b.org ↗' }).click()]);
  await expect.poll(() => second.url()).toContain('site-b.org/severance');
  await second.close();
  await expect(card.getByRole('button', { name: /Watch on site-b\.org/ })).toBeVisible();

  // Moving to the next episode leaves the reusable source available there.
  await card.getByRole('button', { name: 'Severance S01E02 seen', exact: true }).click();
  await expect(card).toContainText('S01E03');
  await expect(card.getByRole('button', { name: 'Sources for Severance S01E03' })).toHaveText('Sources (2)');
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(card).toContainText('S01E02');

  // Every source for this exact episode, without leaving Tonight
  await card.getByRole('button', { name: 'Sources for Severance S01E02' }).click();
  const sheet = page.getByRole('dialog', { name: 'Severance S01E02' });
  await expect(sheet.getByRole('button', { name: /site-b\.org whole series/ })).toBeVisible();
  await sheet.getByRole('button', { name: '1 broken link' }).click();
  await sheet.getByRole('button', { name: 'Works again' }).click();
  await sheet.getByRole('button', { name: '+ Add source' }).click();
  await sheet.getByRole('textbox', { name: 'Link' }).fill('https://site-b.org/just-this-one');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet.getByRole('button', { name: 'Copy link to site-b.org' }).first()).toBeVisible();
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(card.getByRole('button', { name: 'Sources for Severance S01E02' })).toHaveText('Sources (3)');
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

  await page.locator('input[type=file]').setInputFiles({ name: 'partial.json', mimeType: 'application/json', buffer: Buffer.from('{"app":"parde","schemaVersion":1,"data":{"titles":[]}}') });
  await expect(page.getByRole('alert')).toContainText('incomplete');
  // One damaged record: the rest can be merged, but never replaces everything
  const damaged = JSON.parse(text);
  damaged.data.watches.push({ id: 'w', titleId: damaged.data.titles[0].id, date: 'yesterday', together: true });
  await page.locator('input[type=file]').setInputFiles({ name: 'damaged.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(damaged)) });
  await expect(page.getByRole('alert')).toContainText('1 record in this file cannot be fully read');
  await expect(page.getByRole('button', { name: 'Replace everything' })).toBeHidden();
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Restore into a brand-new browser profile
  const fresh = await browser.newContext();
  const p2 = await fresh.newPage();
  await stub(p2);
  await p2.goto('./#/settings');
  await p2.locator('input[type=file]').setInputFiles({ name: 'parde.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await expect(p2.getByRole('region', { name: 'Backup preview' })).toContainText('1 titles');
  await p2.getByRole('button', { name: 'Merge into this browser' }).click();
  await expect(p2.getByText('Merged: 1 title added.')).toBeVisible();
  await p2.goto('./#/library');
  await expect(p2.locator('.tile', { hasText: 'Dune: Part Two' })).toBeVisible();
  await fresh.close();
});

/** A stored record, as it really is. */
const stored = (page: Page, store: string, key: string) =>
  page.evaluate(([store, key]) => new Promise<Record<string, unknown> | undefined>((ok, no) => {
    const open = indexedDB.open('parde');
    open.onerror = () => no(open.error);
    open.onsuccess = () => {
      const q = open.result.transaction(store).objectStore(store).get(key);
      q.onsuccess = () => (open.result.close(), ok(q.result));
      q.onerror = () => no(q.error);
    };
  }), [store, key] as const);

test('discover: rating is saying you have seen it; scores stay closed, and opening them first is remembered', async ({ page }) => {
  await page.getByRole('link', { name: 'Start with what you have seen' }).click();
  await expect(page.getByRole('heading', { name: /Remember what you.ve seen/ })).toBeVisible();
  await expect(page.locator('.tile')).toHaveCount(12);
  // Two taps: the poster, then the rating
  await page.locator('.tile').first().click();
  const panel = page.locator('.panel');
  await panel.getByRole('button', { name: '9', exact: true }).click();
  await expect(panel).toContainText('Seen: 9/10.');
  await expect(page.locator('.tile').first()).toContainText('9');
  const qid = (await page.locator('.tile').first().getAttribute('id'))!.slice(5);
  const added = await stored(page, 'titles', `wd:${qid}`);
  expect(added).toMatchObject({ status: 'watched', rating: 9 });
  expect(added!.finishedAt).toBeUndefined(); // no viewing date is made up

  // A thread: Heat's scores are opened before choosing, Thief's are not
  await page.goto('./#/discover?from=title:Q42&name=Collateral');
  await expect(page.getByRole('heading', { name: 'Like Collateral' })).toBeVisible();
  await page.locator('.tile', { hasText: 'Heat' }).click();
  await expect(page.getByText(/of critics positive/)).toBeHidden();
  await panel.getByText('What others thought').click();
  await expect(page.getByText(/92% of critics positive/)).toBeVisible();
  await panel.getByRole('button', { name: 'Want to watch' }).click();
  await expect(panel).toContainText('On your list.');
  await panel.getByRole('button', { name: 'the people' }).click();
  await expect(panel.getByRole('button', { name: 'the people' })).toHaveAttribute('aria-pressed', 'true');
  const heat = await stored(page, 'titles', 'wd:Q42198');
  expect(heat).toMatchObject({ status: 'want', drawn: ['the people'] });
  expect((heat!.scoresAt as string) <= (heat!.chosenAt as string)).toBe(true);

  await page.locator('.tile', { hasText: 'Thief' }).click();
  await panel.getByRole('button', { name: 'Want to watch' }).click();
  await expect(panel).toContainText('On your list.');
  expect((await stored(page, 'titles', 'wd:Q700'))!.scoresAt).toBeUndefined();

  // Not for me, and back again
  await page.locator('.tile', { hasText: 'Manhunter' }).click();
  await panel.getByRole('button', { name: 'Not for me' }).click();
  await expect(page.locator('.tile', { hasText: 'Manhunter' })).toContainText('Not for you');
  expect(await stored(page, 'dismissed', 'Q701')).toMatchObject({ name: 'Manhunter' });
  await panel.getByRole('button', { name: 'Undo' }).click();
  await expect(panel.getByRole('button', { name: 'Want to watch' })).toBeVisible();

  // A partially watched series can be placed without ever marking later episodes
  await page.locator('.tile', { hasText: 'Severance' }).click();
  await panel.getByRole('button', { name: 'Seen some' }).click();
  await expect(panel.getByLabel('Seen up to')).toHaveValue('none');
  await panel.getByLabel('Seen up to').selectOption({ label: 'S01E09 · end of season 1' });
  await expect(page.getByText('This shelf: 1 in progress, 2 on your list.')).toBeVisible();

  // Opening a title and coming back finds the shelf as it was
  await panel.getByRole('link', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: 'Severance', level: 1 })).toBeVisible();
  await expect(page.locator('.next-ep')).toContainText('S02E01');
  await page.goBack();
  await expect(page.getByText('This shelf: 1 in progress, 2 on your list.')).toBeVisible();
  // The same by the tab bar: an installed app has no Back button
  await page.locator('.tile', { hasText: 'Heat' }).click();
  await panel.getByRole('link', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: 'Heat', level: 1 })).toBeVisible();
  await page.getByRole('link', { name: 'Discover', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Like Collateral' })).toBeVisible();
  await expect(page.getByText('This shelf: 1 in progress, 2 on your list.')).toBeVisible();
});

test('a passed title can be reconsidered and saved without leaving a live dismissal', async ({ page }) => {
  await page.goto('./#/discover?from=title:Q42&name=Collateral');
  const tile = page.locator('.tile', { hasText: 'Heat' });
  const panel = page.locator('.panel');
  await tile.click();
  await panel.getByRole('button', { name: 'Not for me' }).click();
  await page.getByRole('link', { name: 'Second look' }).click();
  await expect(page.getByRole('heading', { name: 'Second look' })).toBeVisible();
  await tile.click();
  await panel.getByRole('button', { name: 'Want to watch' }).click();
  await expect(panel).toContainText('On your list.');
  expect(await stored(page, 'dismissed', 'Q42198')).toBeUndefined();
  expect(await stored(page, 'removed', 'dismissed:Q42198')).toBeTruthy();
});

test('Next shelf advances during delayed details and Back restores the page without repeating titles', async ({ page }) => {
  await page.route(/www\.wikidata\.org\/w\/api\.php/, async (r) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await r.fallback();
  });
  await page.goto('./#/discover?from=decade:1990');
  const tiles = page.locator('.shelf .tile');
  await expect(tiles).toHaveCount(12);
  const first = await tiles.evaluateAll((rows) => rows.map((row) => row.id));
  await page.getByRole('button', { name: 'Next shelf', exact: true }).first().click();
  const second = await tiles.evaluateAll((rows) => rows.map((row) => row.id));
  expect(second).toHaveLength(12);
  expect(second.filter((id) => first.includes(id))).toEqual([]);
  await page.getByRole('link', { name: 'Your taste' }).click();
  await expect(page.getByRole('heading', { name: 'Your taste' })).toBeVisible();
  await page.goBack();
  await expect(tiles.first()).toHaveAttribute('id', second[0]);
  await expect(page.getByRole('heading', { name: 'The 1990s' })).toBeVisible();
});

test('a new visit carries on from the shelf you had reached, and Second look still has what you passed on', async ({ page }) => {
  await page.goto('./#/discover?from=decade:1990');
  const tiles = page.locator('.shelf .tile');
  const ids = () => tiles.evaluateAll((rows) => rows.map((row) => row.id));
  await expect(tiles).toHaveCount(12);
  const first = await ids();
  await tiles.first().click();
  await page.locator('.panel').getByRole('button', { name: 'Not for me' }).click();
  await expect(tiles.first()).toContainText('Not for you');
  await page.getByRole('button', { name: 'Next shelf' }).click();
  await expect.poll(async () => (await ids())[0]).not.toBe(first[0]);
  const second = await ids();
  await expect.poll(() => stored(page, 'settings', 'browsed')).toBeTruthy();
  await page.reload(); // the app was closed and opened again
  await expect(tiles).toHaveCount(12);
  expect(await ids()).toEqual(second);
  await page.goto('./#/discover?from=revisit');
  await expect(tiles).toHaveCount(1);
  expect(await ids()).toEqual([first[0]]);
});

test('scores opened on an earlier visit still count as opened when you choose, also after a pass', async ({ page }) => {
  const panel = page.locator('.panel');
  const heat = page.locator('.tile', { hasText: 'Heat' });
  const collateral = './#/discover?from=title:Q42&name=Collateral';
  await page.goto(collateral);
  await heat.click();
  await panel.getByText('What others thought').click();
  await expect(page.getByText(/92% of critics positive/)).toBeVisible();
  await page.reload();
  await heat.click();
  await panel.getByRole('button', { name: 'Not for me' }).click();
  await expect(heat).toContainText('Not for you');
  expect((await stored(page, 'dismissed', 'Q42198'))!.scoresAt).toBeTruthy();
  await page.reload();
  await page.getByRole('link', { name: 'Second look' }).click();
  await heat.click();
  await panel.getByRole('button', { name: 'Want to watch' }).click();
  await expect(panel).toContainText('On your list.');
  const t = (await stored(page, 'titles', 'wd:Q42198')) as { scoresAt: string; chosenAt: string };
  expect(t.scoresAt < t.chosenAt).toBe(true);
  // Taking it back leaves it as it was: passed on
  await panel.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => stored(page, 'titles', 'wd:Q42198')).toBeUndefined();
  expect(await stored(page, 'dismissed', 'Q42198')).toBeTruthy();
});

test('Undo on a shelf is only for what was added there: not for the same title added again elsewhere, nor after a restore', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  const panel = page.locator('.panel');
  await page.goto('./#/discover?from=title:Q42&name=Collateral');
  const heat = page.locator('.tile', { hasText: 'Heat' });
  await heat.click();
  await panel.getByRole('button', { name: 'Want to watch' }).click();
  await expect(panel.getByRole('button', { name: 'Undo' })).toBeVisible();
  // Removed on its own page, then added again from a filmography: another record
  await panel.getByRole('link', { name: 'Open' }).click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
  await page.goto('./#/p?q=Q548823&name=Denis+Villeneuve');
  const row = page.locator('.work li', { hasText: 'Heat' });
  await row.getByRole('button', { name: 'Seen' }).click();
  await row.getByRole('button', { name: '8', exact: true }).click();
  await page.getByRole('link', { name: 'Discover', exact: true }).first().click();
  await expect(heat).toContainText('Seen');
  if (!(await panel.isVisible())) await heat.click();
  await expect(panel).toContainText('Seen: 8/10.');
  await expect(panel.getByRole('button', { name: 'Undo' })).toBeHidden();

  // Added here, then the collection is replaced: a fresh start, with nothing of the old shelf to undo
  await page.locator('.tile', { hasText: 'Manhunter' }).click();
  await panel.getByRole('button', { name: 'Want to watch' }).click();
  await expect(panel.getByRole('button', { name: 'Undo' })).toBeVisible();
  await page.goto('./#/settings');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save a backup' }).click()]);
  const text = readFileSync(await dl.path(), 'utf8');
  await page.locator('input[type=file]').setInputFiles({ name: 'parde.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await page.getByRole('button', { name: 'Replace everything' }).click();
  await expect(page.getByText(/^Replaced:/)).toBeVisible();
  await page.getByRole('link', { name: 'Discover', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: /Remember what.you.ve seen/ })).toBeVisible();
  await page.goto('./#/discover?from=title:Q42&name=Collateral');
  await expect(page.locator('.tile', { hasText: 'Thief' })).toBeVisible();
  await expect(page.locator('.tile', { hasText: 'Manhunter' })).toBeHidden(); // it is in the library now: not offered, not undoable
});

test('a save that outlives its page does not bring the old shelf back', async ({ page }) => {
  let release = () => {};
  const held = new Promise<void>((ok) => (release = ok));
  await page.route(/api\.tvmaze\.com\/shows\/\d+/, async (r) => {
    await held;
    await r.fulfill({ json: { ...sev, id: Number(new URL(r.request().url()).pathname.split('/').pop()) } });
  });
  await page.goto('./#/discover?from=known:series');
  const tiles = page.locator('.shelf .tile');
  const ids = () => tiles.evaluateAll((rows) => rows.map((row) => row.id));
  await expect(tiles).toHaveCount(12);
  const first = await ids();
  await tiles.first().click();
  await page.locator('.panel').getByRole('button', { name: 'Seen some' }).click();
  await page.getByRole('link', { name: 'Your taste' }).click();
  await expect(page.getByRole('heading', { name: 'Your taste' })).toBeVisible();
  await page.goBack();
  await expect(tiles).toHaveCount(12);
  await page.getByRole('button', { name: 'Next shelf' }).click();
  await expect.poll(async () => (await ids())[0]).not.toBe(first[0]);
  const second = await ids();
  release();
  await expect.poll(() => page.evaluate(() => new Promise<number>((ok) => {
    const open = indexedDB.open('parde');
    open.onsuccess = () => {
      const q = open.result.transaction('titles').objectStore('titles').count();
      q.onsuccess = () => (open.result.close(), ok(q.result));
    };
  }))).toBe(1);
  await page.waitForTimeout(200);
  await page.getByRole('link', { name: 'Your taste' }).click();
  await page.goBack();
  await expect(tiles).toHaveCount(12);
  expect(await ids()).toEqual(second);
});

test('a write that fails is never reported as done', async ({ page }) => {
  await search(page, 'dune');
  await page.locator('li.hit', { hasText: 'Dune: Part Two' }).getByRole('button', { name: 'Seen' }).click();
  await page.locator('li.hit').getByRole('button', { name: 'Open' }).click();
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function () {
      throw new DOMException('no room', 'QuotaExceededError');
    };
  });
  await page.getByRole('group', { name: 'Your rating' }).getByRole('button', { name: '9', exact: true }).click();
  await expect(page.locator('.toast').first()).toContainText('Could not save');
  await expect(page.getByRole('group', { name: 'Your rating' }).getByRole('button', { name: '9', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('textbox', { name: 'Your notes' }).fill('lost?');
  await expect(page.locator('.toast').first()).toContainText('Your note is not saved');
  await expect(page.getByText('Saved', { exact: true })).toBeHidden();
});

test('import asks what it cannot know: the scale, the title, and where you are', async ({ page }) => {
  await search(page, 'severance');
  const hit = page.locator('li.hit', { hasText: 'Severance' });
  await hit.getByRole('button', { name: 'Watching' }).click();
  await hit.getByLabel('Where are you up to?').selectOption({ label: 'S01E02 · Half Loop' });
  await page.keyboard.press('Escape');
  await page.goto('./#/import');
  const find = page.getByRole('button', { name: /Find 2 titles/ });
  await page.getByLabel(/type or paste a list/).fill('Heat 5\nSeverance S01E05');
  await expect(find).toBeDisabled(); // out of 5 or 10? not guessed
  await page.getByRole('button', { name: '10', exact: true }).click();
  await find.click();
  // "Heat" without a year is two films: neither is chosen
  const choose = page.getByLabel('Match for Heat 5');
  await expect(choose).toHaveValue('-1');
  await choose.selectOption({ index: 1 });
  await page.getByRole('button', { name: /Add 1 title and update 1/ }).click();
  await expect(page.getByText('here S01E02, in your list S01E05')).toBeVisible();
  await page.getByRole('button', { name: 'Move to S01E05' }).click();
  await page.goto('./#/t/tvm%3A44933');
  await expect(page.locator('.next-ep')).toContainText('S01E06');
  expect(await stored(page, 'titles', 'wd:Q42198')).toMatchObject({ rating: 5 });
});

test('finding your way: page titles, focus and the way back', async ({ page, browserName }) => {
  await search(page, 'severance');
  await page.locator('li.hit', { hasText: 'Severance' }).getByRole('button', { name: 'Watching' }).click();
  await page.locator('li.hit', { hasText: 'Severance' }).getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveTitle('Severance · Parde');
  await expect(page.locator('#main')).toBeFocused();
  await page.locator('.season-head').first().waitFor();
  await page.evaluate(() => scrollTo(0, 600));
  await page.waitForTimeout(400);
  const y = await page.evaluate(() => scrollY);
  expect(y).toBeGreaterThan(300);
  await page.goto('./#/library');
  await expect(page).toHaveTitle('Library · Parde');
  // A slow phone: the page fills in over several steps, above where you were too.
  if (browserName === 'chromium') await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 20 });
  await page.goBack();
  await page.locator('.season-head').first().waitFor();
  await page.waitForTimeout(1500);
  // WebKit can restore to a nearby layout pixel when viewport measurements settle.
  expect(Math.abs((await page.evaluate(() => scrollY)) - y)).toBeLessThanOrEqual(3);
});

test('layout: no horizontal scroll; the page scrolls, the tab bar stays on the bottom edge and never covers the end of a page', async ({ page, isMobile }) => {
  await search(page, 'severance');
  const hit = page.locator('li.hit', { hasText: 'Severance' });
  await hit.getByRole('button', { name: 'Watching' }).click();
  // Navigating away while the series is still being saved would abort the save.
  await expect(hit.getByText('Where are you up to?')).toBeVisible();
  await page.keyboard.press('Escape');
  // Short pages (an empty calendar day) and long ones (a series with its episode list)
  for (const p of ['./', './#/calendar?d=2001-01-01', './#/library', './#/discover?from=decade:1990', './#/taste', './#/settings', './#/import', './#/t/tvm%3A44933']) {
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
    await page.getByRole('link', { name: 'Discover' }).first().click();
    await page.getByRole('link', { name: 'Your taste' }).click();
    await expect(page.getByRole('heading', { name: 'Your taste' })).toBeVisible();
    await context.setOffline(false);
  });
});
