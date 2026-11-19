# Parde

A private, local-first film and TV companion for two people, run by one. Add what you have seen, are watching and want to see; Parde fills in the details, tracks episodes, remembers where you watch, and over time shows you what your taste is really like.

**Live:** https://ethan-ghoreishi.github.io/parde/ — install it (Share → Add to Home Screen on iPhone; the install icon in Chrome) so the browser keeps its data.

## What it does

- **Add and discover** — search titles *or people*. Every director, writer and actor opens their filmography (Wikidata), with what you already have marked and one tap to Want or Seen. Taste's "More from people you trust" uses the same lookup.
- **Import** — bring in a Letterboxd or IMDb export, or type a list (`Heat 1995 9`, `Amélie ★★★★½`, `Severance S02E03`). Exact ids and exact titles go straight in; anything ambiguous is shown for a quick check. Letterboxd is read out of 5 and IMDb out of 10; for a typed list whose ratings are all 5 or under, you say which. A diary's rewatches become one title (latest rating and date). Nothing already recorded is overwritten; a film on your want list that the history says you watched becomes watched.
- **Series progress** — one choice ("Seen up to S03E04", "end of season 2") places a series you are part-way through, with undo. "Up next" follows the furthest episode you have seen, so a skipped episode never drags a show back (the page says how many are unmarked, with one tap to mark them). Finishing a series marks what is out; a new season reopens it on Tonight if it is still on your calendar; paused and dropped are never changed by a background refresh; future episodes are never marked by bulk actions; a refresh never deletes episodes or details because TVmaze or Wikidata answered badly.
- **Tonight** — continue the series you are in the middle of (one tap opens the right episode on your saved site), a "what should we watch?" picker that explains its choices, and the week's new episodes.
- **Calendar** — two weeks from any day; a season drop is one card. *Released on Netflix* (the service's own date) is shown differently from *Airs on HBO (US)* (a broadcast, which says nothing certain about streaming). Neither confirms availability to you; the card says whether you have a source saved.
- **Sources** — several links per film, season or episode. Mark one broken and the next takes over. Paste one episode link and Parde offers a pattern (`…-s{ss}e{ee}`) for every episode; a series-wide pattern opens and copies as the episode you are up to. When a site moves domain, update all its links at once. Links open in a new tab with no referrer; nothing is embedded or checked automatically.
- **Taste** — patterns with their sample size and coverage shown: trailer instinct in plain counts (expectations recorded after starting are hindsight and left out), you vs critics (Metacritic compared point for point; the Tomatometer only by agreement), directors, writers and actors you rate above your average (and what of theirs is already on your list), genres, recurring themes, where you and your partner split. A correlation is described only when it beats chance for that many titles; small groups are pulled toward your overall average and called an early sign. "More from people you trust" takes one film from each in turn and says why.
- **Themes and reviews** — after watching, tap a few words for what it was about (suggested from Wikidata subjects and your own past words). "Draft my review" builds a copy-ready prompt from your rating, themes and notes for Claude, ChatGPT or anything else; it forbids invented opinions, marks guesses in [brackets], and ends with a `Themes:` line you can paste back. Opening an assistant copies the prompt and starts an empty chat to paste into: notes never go in a web address, and your partner is only "my partner". No AI runs inside Parde.

## Data and privacy

- Everything is stored in this browser's IndexedDB. No account, no server, no analytics.
- Lookups send only what is needed: the title or name you search, and for imports the titles or IMDb ids in your file, to Wikipedia, Wikidata and TVmaze. All keyless and free.
- **Back up** from Settings (on a phone, the share sheet lets you save to Files). Restore validates the whole file first (your own records strictly; a malformed fetched detail is dropped and refetched later), can merge (newer edit wins per title; a series keeps this device's episode list and the file's marks are matched to it) or replace. Undo swaps rather than discards: what is there at that moment, including anything changed after the restore, is kept for a redo. Parde nudges you if the last backup is over two weeks old.
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

- **Keyless metadata.** TMDB needs a personal key; Wikidata + Wikipedia give films (posters, cast, critics' scores with their date, subjects) and TVmaze gives series (episodes, air times, network vs streaming and its country) with no sign-up. A Wikidata YouTube id is used as a trailer only if marked as one or under ten minutes (some are the full film).
- **Be a good API citizen.** Wikimedia rate-limits clients (in 2026: about 200 requests a minute for browsers, at most 3 at once). Parde keeps to 3 concurrent requests, backs off on 429/503, fetches film metadata 50 at a time, and gets posters with the search itself. Imports resolve IMDb ids and exact titles with one Wikidata query per 100–150 rows.
- **Ordinary page scrolling, fixed tab bar.** The document scrolls (status-bar tap to top, Safari's toolbar collapsing), the header is sticky and the tab bar is `position: fixed` with safe-area padding. In Safari (not installed) the bar rides above Safari's own toolbar as it expands and collapses, like any website. An iOS 26 Home Screen app with a translucent status bar gets a viewport one status bar too short while a page is shorter than the screen ([WebKit bug 301108](https://bugs.webkit.org/show_bug.cgi?id=301108)); `html` is kept that much taller in standalone mode, capped at the screen. An earlier "the document never scrolls" shell triggered that bug on every page. The status-bar style is left as is: iOS applies a new one only after a reinstall, which would delete the collection.
- **Svelte 5 + Dexie + vite-plugin-pwa**, hash routing for GitHub Pages and offline use.
- **No runtime AI.** Reflection, reviews and recaps are user-triggered, copy-ready prompts.
- Credits: Wikidata (CC0), Wikipedia (CC BY-SA), TVmaze (CC BY-SA). Posters belong to their rights holders.
