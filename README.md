# Globetrotter Games

Free daily geography games, built as a fully static site: no server, no database, no tracking.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # validates puzzles, type-checks, builds to dist/
npm run preview    # serves dist/ with the production security headers
```

## How daily puzzles are served

Each game's content bank lives in `src/games/<game>/`. At build time `scripts/banks.mjs` turns it into one small file per day (`/data/<game>/<n>.json`); a game page fetches only today's file, so the banks can grow without making any page heavier. Puzzles rotate by the player's local date and unlock at local midnight. Outline Drop's maps are cut from Natural Earth 1:50m at build time.

## Add Globe Links puzzles

Edit `src/games/globe-links/puzzles.json`. Each puzzle has 4 groups (difficulty 1–4), each with 4 country codes, a fact and a source link. Category member lists live in `categories.json`; country names and map points in `src/data/countries.ts`.

```bash
npm run validate        # checks every tile fits only its own group on that board
npm run check-sources   # also confirms every source link loads
```

Puzzles rotate daily by the player's local date (puzzle #1 = 1 Nov 2026) and loop when they run out, so add more before then.

## Add Fact or Fib days

Edit `src/games/fact-or-fib/facts.json`. Each day has 5 countries; each country has 3 statements, exactly one marked `"fib": true` with a `"truth"` correction, and every statement has a source link. `npm run validate` checks the structure and that no country repeats across days. There are 6 days so far.

## Add Rank the World days

Edit `src/games/rank-the-world/rank.json`. Each day has 4 rounds of 5 countries. A round uses one stat (`highest`, `area`, `neighbours`, `north`, `south`); every country needs a value in that stat (latitudes come from `src/data/countries.ts`). `npm run validate` rejects rounds where two values are too close to rank fairly. There are 6 days so far.

## Add Mystery Passport days

Edit `src/games/mystery-passport/passport.json`. Each day has 3 countries; each country has a `continent` (for the hint) and exactly one clue of each type: nature (free), food, phrase, currency, landmark, neighbour, each with a source. Clues must never name the country; `npm run validate` checks this. Guesses accept any of the 194 countries in `src/data/world.ts`. There are 6 days so far.

## Add Outline Drop days

Edit `src/games/outline-sketch/outline.json` (3 country codes per day, plus each code's numeric ISO id). Leave out countries with disputed or sensitive borders; the validator blocks the known ones.

## Add Flag Forge days

Edit `src/games/flag-forge/flags.json`. Only use flags the builder can reproduce exactly (layout `plain/h2/h3/v2/v3/nordic`, colours from its 8-colour palette, one centred symbol). Add the country's spec, its "Flag of …" Wikipedia article in `sources`, and a 3-country day.

## Before going live

- [x] Turn off test mode: set `TEST_MODE = false` in `src/shared/testing.ts` (removes the "Reset today's game" buttons).
- [x] Fill in `[OPERATOR NAME]` and `[CONTACT EMAIL]` in `privacy.html` and `terms.html` (the build warns until you do).
- [ ] Get a trademark check on "Globetrotter Games" and the six game names.
- [x] Deploy to Vercel (static, no settings needed; `vercel.json` sets the security headers).
- [x] In Vercel, add a Production environment variable `SITE_URL=https://www.dailyworldquiz.com`. The build then adds the sitemap, canonical links and social preview tags.
- [ ] Redirect the `*.vercel.app` address to your domain (Vercel → Domains) so Google sees one copy of the site.
- [ ] Keep Vercel Web Analytics and Speed Insights **off**, or the "no tracking" promise stops being true.
- [ ] Verify the domain in Google Search Console and submit `/sitemap.xml`.
- [ ] Grow the Mystery Passport, Outline Drop and Flag Forge banks (6 days each) so they don't repeat after a week.

## Privacy and safety by design

- No cookies, analytics, ads, accounts or third-party requests (fonts, flags and map data are bundled).
- Game progress lives only in the player's `localStorage`; the Privacy page has a "Clear my game data" button.
- Strict Content Security Policy (`default-src 'self'`), no `innerHTML`, `noopener` on outbound links.
