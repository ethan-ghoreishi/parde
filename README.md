# Parde

A private, local-first film and TV companion for two people, run by one. Add what you have seen, are watching and want to see; Parde fills in the details, tracks episodes, remembers where you watch, and over time shows you what your taste is really like.

**Live:** https://ethan-ghoreishi.github.io/parde/ — install it (Share → Add to Home Screen on iPhone; the install icon in Chrome) so the browser keeps its data.

## What it does

- **Tonight** — continue the series you are in the middle of (one tap opens the right episode on your saved site), a "what should we watch?" picker that explains its choices, and the week's new episodes.
- **Calendar** — any day's episodes from followed series, in your time zone. *Released on Netflix* (a streaming service's own release date) is shown differently from *Airs on HBO* (a broadcast date, which does not confirm streaming availability).
- **Library** — everything, filterable by status, type, genre and person.
- **Sources** — several links per film, season or episode. Mark one broken and the next takes over. Paste one episode link and Parde offers to turn it into a pattern (`…-s{ss}e{ee}`) that works for every episode. When a site moves domain, update all its links at once. "Find on…" searches your chosen sites when everything is broken. Links only open in a new tab with no referrer; nothing is embedded.
- **Taste** — how well your trailer impressions predict your enjoyment, where you and the critics disagree, the people and genres you rate above your average, genres you hoard but don't enjoy, where you and your partner split, and more films by people you trust.
- **Thoughts** — notes per title with reflection questions, and optional "Think it through with Claude" / spoiler-safe "Recap in Claude" hand-offs (the prompt opens in claude.ai and is copied).

## Data and privacy

- Everything is stored in this browser's IndexedDB. No account, no server, no analytics.
- Lookups send only the title you search for: films via Wikipedia + Wikidata, series via TVmaze. All keyless and free.
- **Back up** from Settings: a validated JSON file. Restore can merge (keeps local data, newer edit wins per title) or replace. Parde nudges you if the last backup is over two weeks old.
- Data does not sync between devices; move it with a backup file.

## Development

```bash
npm install
npm run dev        # http://localhost:5391
npm run check      # svelte-check + tsc
npm test           # unit tests (vitest, fake-indexeddb, recorded API fixtures)
npm run test:e2e   # Playwright: Chromium + iPhone WebKit, all APIs stubbed
npm run build
```

Pushing to `main` runs every check and deploys to GitHub Pages.

## Key decisions

- **Keyless metadata.** TMDB needs a personal key; Wikidata + Wikipedia give films (posters, cast, critics' Rotten Tomatoes/Metacritic, subjects) and TVmaze gives series (episodes, air times, network vs streaming) with no sign-up. A Wikidata YouTube id is used as a trailer only if marked as one or under ten minutes (some are the full film).
- **Svelte 5 + Dexie + vite-plugin-pwa**, hash routing for GitHub Pages and offline use.
- **No runtime AI.** Reflection and recaps are user-triggered hand-offs to claude.ai.
- Credits: Wikidata (CC0), Wikipedia (CC BY-SA), TVmaze (CC BY-SA). Posters belong to their rights holders.
