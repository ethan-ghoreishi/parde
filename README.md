# Parde

A private, local-first film and TV companion for two people, run by one. Add what you have seen, are watching and want to see; Parde fills in the details, tracks episodes, remembers where you watch, and over time shows you what your taste is really like.

**Live:** https://ethan-ghoreishi.github.io/parde/ — install it (Share → Add to Home Screen on iPhone; the install icon in Chrome) so the browser keeps its data.

## What it does

- **Discover** opens with familiar films and series, so you can build your library by recognition: two taps rate a film, and a series can be marked all seen or placed at the last episode you saw. Other ways in follow what you loved, its makers and subjects, a decade, or somewhere you have nothing from; they change from visit to visit. **Next shelf** never repeats a title within a thread, and the next visit carries on from the shelf you had reached. Back and the tab bar find the shelf as you left it. **Second look** holds what you passed on. Undo on a shelf applies only to what was added there, while it is still that same record.
- **Add** — search titles *or people*. Every director, writer and actor opens their filmography (Wikidata), with what you already have marked.
- **Import** accepts Letterboxd, IMDb and typed lists. A unique IMDb id, or an exact title with the year given, goes straight in; anything else is offered, never guessed (an IMDb id nobody lists is looked for by title and asked about). A failed lookup stays visible for retry. Existing intentional edits take precedence. A new series and its progress save together; the date a finished series was seen is kept. Where progress is uncertain, you are asked.
- **Series progress** follows your furthest episode: one skipped earlier holds back neither “up next” nor finishing. Bulk marks only touch what is out. A series finishes by itself when it has ended, you marked its last listed episode, and that list really reaches the end: every season as long as TVmaze says, or the last date is the one it ended on and the last season is not short (checked against 156 ended series; a cut-off reply does not pass). An episode that disappears from TVmaze is set aside with its mark, never deleted; a mark moves to a new id only for the same place, date and name. A returning series reopens without overriding your calendar choice. *Check for new episodes* checks every series that could have them.
- **Tonight** — continue the series you are in the middle of (one tap opens the right episode on your saved site; *didn't work?* opens the next), a "what should we watch?" picker ordered by your own keenness and the people you rate, not by scores, and the week's new episodes.
- **Calendar** — two weeks from any day; a season drop is one card. *Released on Netflix* (the service's own date) is shown differently from *Airs on HBO (US)* (a broadcast, which says nothing certain about streaming). Neither confirms availability to you; the card says whether you have a source saved.
- **Sources** can be saved for a film, series, season or episode. If a reusable source fails on one episode, Parde can try another and still offer the first source on other episodes. Series patterns expand to the current episode. Links open without a referrer.
- **Your taste** links patterns and exceptions to titles and sample sizes. *Scores and you* keeps apart what you saved before opening the scores, what you saved after, and how you rated; a difference is claimed only with five on each side and more than chance. Your rules of thumb about scores are each set against the titles with the same scores that do not fit, and against choices made with the scores open. Trailer instinct counts only what was said no later than the day of the first viewing, and says how many are left out.
- **Themes and reviews** — after watching, tap a few words for what it was about (suggested from Wikidata subjects and your own past words). "Draft my review" builds a copy-ready prompt from your rating, themes and notes for Claude, ChatGPT or anything else; it forbids invented opinions, marks guesses in [brackets], never asks for spoilers past the episode you are up to, and ends with a `Themes:` line you can paste back. Opening an assistant copies the prompt and starts an empty chat to paste into: notes never go in a web address, and your partner is only "my partner". No AI runs inside Parde.

## Data and privacy

- Everything is stored in this browser's IndexedDB. No account, no server, no analytics.
- Lookups send only what is needed: the title or name you search, and for imports the titles or IMDb ids in your file, to Wikipedia, Wikidata and TVmaze. All keyless and free.
- **Back up** from Settings. Parde reads the export back and flags any unreadable record. Merge keeps the newest edit of each thing, clearing included, and everything only one side has; what you removed here stays removed unless the file has a later change to it. Leaving something blank is not clearing it. Replace uses the file as a complete snapshot. Undo swaps rather than discards, and two replaces in a row (the wrong file, then another) still undo to your own collection.
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

- **Score coverage.** Wikidata has a Tomatometer for about 27,000 titles, a Metascore for 11,000, IMDb for 2,200 (half of the well-known films) and an audience score for 9 (November 2026), so rules about audiences cannot be tested and Parde says so. TVmaze has its own user average. Two scores are read together only if recorded within a year of each other, or both three years after release. Scores carry no weight in what is suggested. IMDb offers a separate [non-commercial dataset](https://developer.imdb.com/non-commercial-datasets/); Parde uses the existing keyless lookups and needs no manual score file.
- **Discover's queries start from something.** "Well-known films of a year" takes Wikidata's query service over 20 seconds; "what shares its makers with this film" takes one. Unanchored starts use the bundled list.
- **Storage.** Dexie v2 retains the existing IndexedDB stores. The backup format remains version 1 and accepts files that predate deletion history.
- **Keyless metadata.** TMDB needs a personal key; Wikidata + Wikipedia give films (posters, cast, critics' scores with their date, subjects) and TVmaze gives series (episodes, air times, network vs streaming and its country) with no sign-up. A Wikidata YouTube id is used as a trailer only if marked as one or under ten minutes (some are the full film).
- **Be a good API citizen.** Wikimedia rate-limits clients (in 2026: about 200 requests a minute for browsers, at most 3 at once). Parde keeps to 3 concurrent requests, backs off on 429/503, fetches film metadata 50 at a time, and gets posters with the search itself. Imports resolve IMDb ids and exact titles with one Wikidata query per 100–150 rows.
- **Ordinary page scrolling, fixed tab bar.** The document scrolls (status-bar tap to top, Safari's toolbar collapsing), the header is sticky and the tab bar is `position: fixed` with safe-area padding. In Safari (not installed) the bar rides above Safari's own toolbar as it expands and collapses, like any website. An iOS 26 Home Screen app with a translucent status bar gets a viewport one status bar too short while a page is shorter than the screen ([WebKit bug 301108](https://bugs.webkit.org/show_bug.cgi?id=301108)); `html` is kept that much taller in standalone mode, capped at the screen. An earlier "the document never scrolls" shell triggered that bug on every page. The status-bar style is left as is: iOS applies a new one only after a reinstall, which would delete the collection.
- **Svelte 5 + Dexie + vite-plugin-pwa**, hash routing for GitHub Pages and offline use.
- **No runtime AI.** Reflection, reviews and recaps are user-triggered, copy-ready prompts.
- Credits: Wikidata (CC0), Wikipedia (CC BY-SA), TVmaze (CC BY-SA). Posters belong to their rights holders.
