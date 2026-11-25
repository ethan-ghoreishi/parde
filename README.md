# Parde

A private, local-first film and TV companion for two people, run by one. Add what you have seen, are watching and want to see; Parde fills in the details, tracks episodes, remembers where you watch, and over time shows you what your taste is really like.

**Live:** https://ethan-ghoreishi.github.io/parde/ — install it (Share → Add to Home Screen on iPhone; the install icon in Chrome) so the browser keeps its data.

## What it does

- **Discover** opens with familiar films and series so you can build your library by recognition. One tap rates a film from its open card. For a partly watched series, choose **Seen some**, then pick the last episode you saw. Browse connected titles, makers, subjects, decades and countries. **Next shelf** advances through each thread without wrapping. Back and the Discover tab restore the active shelf during the session. **Second look** lets you revisit identifiable titles you passed on.
- **Add** — search titles *or people*. Every director, writer and actor opens their filmography (Wikidata), with what you already have marked.
- **Import** accepts Letterboxd, IMDb and typed lists. It can use a unique verified IMDb ID or an exact title with the supplied year. Similar titles and uncertain types are reviewed. A failed lookup stays visible for retry. Existing intentional edits take precedence. A new series and its known progress save together. The import leaves uncertain progress for you to place.
- **Series progress** follows your furthest confirmed episode. Bulk marking only touches released episodes. Automatic completion needs an ended show, a contiguous released schedule backed by season counts or the end date, and every listed episode marked. Missing episodes and their marks are retained by TVmaze episode ID. A returning show can reopen without overriding your calendar preference.
- **Tonight** — continue the series you are in the middle of (one tap opens the right episode on your saved site; *didn't work?* opens the next), a "what should we watch?" picker ordered by your own keenness and the people you rate, not by scores, and the week's new episodes.
- **Calendar** — two weeks from any day; a season drop is one card. *Released on Netflix* (the service's own date) is shown differently from *Airs on HBO (US)* (a broadcast, which says nothing certain about streaming). Neither confirms availability to you; the card says whether you have a source saved.
- **Sources** can be saved for a film, series, season or episode. If a reusable source fails on one episode, Parde can try another and still offer the first source on other episodes. Series patterns expand to the current episode. Links open without a referrer.
- **Your taste** links patterns and exceptions to titles and sample sizes. It tracks explicit Discover saves and passes against the scores available at choice time. Trailer instinct requires a recorded pre-watch entry and later viewing evidence. Score comparisons use their original source and measure.
- **Themes and reviews** — after watching, tap a few words for what it was about (suggested from Wikidata subjects and your own past words). "Draft my review" builds a copy-ready prompt from your rating, themes and notes for Claude, ChatGPT or anything else; it forbids invented opinions, marks guesses in [brackets], never asks for spoilers past the episode you are up to, and ends with a `Themes:` line you can paste back. Opening an assistant copies the prompt and starts an empty chat to paste into: notes never go in a web address, and your partner is only "my partner". No AI runs inside Parde.

## Data and privacy

- Everything is stored in this browser's IndexedDB. No account, no server, no analytics.
- Lookups send only what is needed: the title or name you search, and for imports the titles or IMDb ids in your file, to Wikipedia, Wikidata and TVmaze. All keyless and free.
- **Back up** from Settings. Parde reads the export back and flags any unreadable records. Merge recovers records and uses dated edits while respecting deletions made on this device. Distinct viewing IDs survive even on the same day. Replace uses the file as a complete snapshot. Restore Undo swaps the current collection with the immediately previous one.
- Data does not sync between devices; move it with a backup file.

## Development

```bash
npm install
npm run dev        # http://localhost:5391
npm run check      # svelte-check + tsc
npm test           # unit tests (vitest, fake-indexeddb, recorded API fixtures)
npm run test:e2e   # Playwright: Chromium + iPhone WebKit, all APIs stubbed
npm run build
node scripts/seed.mjs # rebuild Discover's starter list from Wikidata (rarely)
```

Pushing to `main` runs every check and deploys to GitHub Pages.

## Key decisions

- **Score coverage.** Wikidata provides some Tomatometer, critics’ average, audience, IMDb and Metacritic snapshots. TVmaze provides its own user average. Coverage and dates vary. Paired rules require snapshots dated within one year of each other. The cases are exploratory and scores carry no weight in discovery ranking. IMDb offers a separate [non-commercial dataset](https://developer.imdb.com/non-commercial-datasets/). Parde uses the existing keyless lookups and needs no manual score file.
- **Discover's queries start from something.** "Well-known films of a year" takes Wikidata's query service over 20 seconds; "what shares its makers with this film" takes one. Unanchored starts use the bundled list.
- **Storage.** Dexie v2 retains the existing IndexedDB stores. The backup format remains version 1 and accepts files that predate deletion history.
- **Keyless metadata.** TMDB needs a personal key; Wikidata + Wikipedia give films (posters, cast, critics' scores with their date, subjects) and TVmaze gives series (episodes, air times, network vs streaming and its country) with no sign-up. A Wikidata YouTube id is used as a trailer only if marked as one or under ten minutes (some are the full film).
- **Be a good API citizen.** Wikimedia rate-limits clients (in 2026: about 200 requests a minute for browsers, at most 3 at once). Parde keeps to 3 concurrent requests, backs off on 429/503, fetches film metadata 50 at a time, and gets posters with the search itself. Imports resolve IMDb ids and exact titles with one Wikidata query per 100–150 rows.
- **Ordinary page scrolling, fixed tab bar.** The document scrolls (status-bar tap to top, Safari's toolbar collapsing), the header is sticky and the tab bar is `position: fixed` with safe-area padding. In Safari (not installed) the bar rides above Safari's own toolbar as it expands and collapses, like any website. An iOS 26 Home Screen app with a translucent status bar gets a viewport one status bar too short while a page is shorter than the screen ([WebKit bug 301108](https://bugs.webkit.org/show_bug.cgi?id=301108)); `html` is kept that much taller in standalone mode, capped at the screen. An earlier "the document never scrolls" shell triggered that bug on every page. The status-bar style is left as is: iOS applies a new one only after a reinstall, which would delete the collection.
- **Svelte 5 + Dexie + vite-plugin-pwa**, hash routing for GitHub Pages and offline use.
- **No runtime AI.** Reflection, reviews and recaps are user-triggered, copy-ready prompts.
- Credits: Wikidata (CC0), Wikipedia (CC BY-SA), TVmaze (CC BY-SA). Posters belong to their rights holders.
