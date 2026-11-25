# Parde

A private, local-first film and TV companion for two people, run by one. Add what you have seen, are watching and want to see; Parde fills in the details, tracks episodes, remembers where you watch, and over time shows you what your taste is really like.

**Live:** https://ethan-ghoreishi.github.io/parde/ — install it (Share → Add to Home Screen on iPhone; the install icon in Chrome) so the browser keeps its data.

## What it does

- **Discover** — shelves of twelve posters on a thread: something you loved, a maker you trust, a subject, a country, a decade, somewhere you have nothing from. Tap what you recognise or wonder about and ignore the rest. Tapping a rating *is* saying you have seen it (no date is made up); Want and Not for me are one tap. What others thought stays closed until you open it: Parde only notes whether it was open when you chose. Each rating gets one plain line back ("Your 4th by Michael Mann: 8.5 on average") and a way on. No account, key or scores file needed; a new collection starts from a bundled list of well-known titles.
- **Add** — search titles *or people*. Every director, writer and actor opens their filmography (Wikidata), with what you already have marked.
- **Import** — bring in a Letterboxd or IMDb export, or type a list (`Heat 1995 9`, `Amélie ★★★★½`, `Severance S02E03`). Exact ids and exact titles go straight in. Anything else is asked, never guessed: more than one possible title, a type the file and Wikidata disagree on, ratings that could be out of 5 or 10. A service that did not answer is "not checked" (with a retry), not "not found". The day a rating was entered is not stored as the day it was watched. Nothing recorded is overwritten; a series where your list is further on is offered, never moved.
- **Series progress** — one choice ("Seen up to S03E04", "end of season 2") places a series you are part-way through, with undo. "Up next" follows the furthest episode you have seen, so a skipped episode never drags a show back (the page says how many are unmarked, with one tap to mark them). Finishing a series marks what is out; a new season reopens it on Tonight if it is still on your calendar; paused and dropped are never changed by a background refresh; future episodes are never marked by bulk actions. TVmaze's list is news, not truth: an episode missing from it is set aside, never deleted, and returns if listed again; empty details never replace good ones. Every bulk change has an Undo that reverts only what it changed, and only where nothing has touched it since. Marking a whole series seen records no finish date; watching its last episode does.
- **Tonight** — continue the series you are in the middle of (one tap opens the right episode on your saved site; *didn't work?* opens the next), a "what should we watch?" picker ordered by your own keenness and the people you rate, not by scores, and the week's new episodes.
- **Calendar** — two weeks from any day; a season drop is one card. *Released on Netflix* (the service's own date) is shown differently from *Airs on HBO (US)* (a broadcast, which says nothing certain about streaming). Neither confirms availability to you; the card says whether you have a source saved.
- **Sources** — several links per film, season or episode, opened, copied, switched or added in place from Tonight and the Calendar. Mark one broken and the next takes over. Paste one episode link and Parde offers a pattern (`…-s{ss}e{ee}`) for every episode; a series-wide pattern opens and copies as the episode you are up to. When a site moves domain, update all its links at once. Links open in a new tab with no referrer; nothing is embedded or checked automatically.
- **Your taste** (beside Discover) — every pattern shows how many titles it rests on and opens to them: directors, writers and actors (told apart by Wikidata id), genres, themes, trailer instinct (before or after the scores were opened, and hindsight left out), what draws you in against how you liked it, and *Scores and you*: by Tomatometer band, what you chose without the scores, what you chose knowing them, and how you rated. A difference is claimed only with five on each side and more than chance. It says plainly that you mostly rate what you chose to watch.
- **Themes and reviews** — after watching, tap a few words for what it was about (suggested from Wikidata subjects and your own past words). "Draft my review" builds a copy-ready prompt from your rating, themes and notes for Claude, ChatGPT or anything else; it forbids invented opinions, marks guesses in [brackets], never asks for spoilers past the episode you are up to, and ends with a `Themes:` line you can paste back. Opening an assistant copies the prompt and starts an empty chat to paste into: notes never go in a web address, and your partner is only "my partner". No AI runs inside Parde.

## Data and privacy

- Everything is stored in this browser's IndexedDB. No account, no server, no analytics.
- Lookups send only what is needed: the title or name you search, and for imports the titles or IMDb ids in your file, to Wikipedia, Wikidata and TVmaze. All keyless and free.
- **Back up** from Settings (on a phone, the share sheet lets you save to Files). Before a backup is handed over it is read back, so it is known to be restorable. A file with a section missing is refused; one with an unreadable record can be merged (the record is left out and named) but never replaces everything. Merge keeps the newest edit of each thing (rating, note, status…), clearing included, leaves out what you removed here, and never takes a mark or a note away. Undo swaps rather than discards, and two restores in a row still undo to what you had. Parde nudges you if the last backup is over two weeks old.
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

- **Scores: what is and is not available.** Wikidata (CC0) has about 27,000 Tomatometers, 25,000 Rotten Tomatoes critic averages and 11,000 Metascores, dated (many Tomatometers from 2021); each is kept as its own measurement, never merged, averaged or compared unit for unit. It has nine audience scores and few IMDb ratings. There is no free open source for audience scores: Rotten Tomatoes has no public API, IMDb's dataset may be kept for personal use but not republished and cannot be fetched by a web page, and aggregators (MDBList, OMDb) need a personal key and would learn what you look at. So nothing in Parde depends on scores, and ideas about critics and audiences disagreeing are tested by the reasons you tap, not by numbers Parde does not have.
- **Discover's queries start from something.** "Well-known films of a year" takes Wikidata's query service over 20 seconds; "what shares its makers with this film" takes one. Unanchored starts use the bundled list.
- **Storage.** Dexie v2 adds one store (`removed`: what you deleted or unmarked, so a merge does not bring it back). Backups keep schema version 1: older backups restore here, and the previous version can open this database.
- **Keyless metadata.** TMDB needs a personal key; Wikidata + Wikipedia give films (posters, cast, critics' scores with their date, subjects) and TVmaze gives series (episodes, air times, network vs streaming and its country) with no sign-up. A Wikidata YouTube id is used as a trailer only if marked as one or under ten minutes (some are the full film).
- **Be a good API citizen.** Wikimedia rate-limits clients (in 2026: about 200 requests a minute for browsers, at most 3 at once). Parde keeps to 3 concurrent requests, backs off on 429/503, fetches film metadata 50 at a time, and gets posters with the search itself. Imports resolve IMDb ids and exact titles with one Wikidata query per 100–150 rows.
- **Ordinary page scrolling, fixed tab bar.** The document scrolls (status-bar tap to top, Safari's toolbar collapsing), the header is sticky and the tab bar is `position: fixed` with safe-area padding. In Safari (not installed) the bar rides above Safari's own toolbar as it expands and collapses, like any website. An iOS 26 Home Screen app with a translucent status bar gets a viewport one status bar too short while a page is shorter than the screen ([WebKit bug 301108](https://bugs.webkit.org/show_bug.cgi?id=301108)); `html` is kept that much taller in standalone mode, capped at the screen. An earlier "the document never scrolls" shell triggered that bug on every page. The status-bar style is left as is: iOS applies a new one only after a reinstall, which would delete the collection.
- **Svelte 5 + Dexie + vite-plugin-pwa**, hash routing for GitHub Pages and offline use.
- **No runtime AI.** Reflection, reviews and recaps are user-triggered, copy-ready prompts.
- Credits: Wikidata (CC0), Wikipedia (CC BY-SA), TVmaze (CC BY-SA). Posters belong to their rights holders.
