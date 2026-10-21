# NHL Prop Simulator — working notes

Single-file HTML app (`nhl-prop-predictor.html`) + a Node build (`build-nhl-snapshot.mjs`) that turns ESPN box scores
into player-prop projections. Built 2026-10-16 ("yes build it") as a copy of `C:\Users\User\nba-prop-predictor`'s design
(read that repo's and `C:\Users\User\nfl-td-predictor`'s CLAUDE.md for the market anchor, line shopping, bankroll and
bet-log history). See README.md for the model and its backtest.

## Where things happen
- **Edit** `nhl-prop-predictor.template.html` (UI + live model) and `build-nhl-snapshot.mjs` (data + model + backtest).
  Never hand-edit `nhl-prop-predictor.html` / `nhl-snapshot.json` — the build regenerates both.
- `fetch-gamelog.mjs` keeps `data/gamelog_<season>.json` (committed): ESPN scoreboard day by day → `summary?event=` box
  scores. Rows: skater [id, team, 0 F | 1 D, toi, g, a, sog, ppToi, blk]; goalie [id, team, 2, toi, ga, sa]; game ou / ml
  from ESPN's pickcenter (DraftKings close; NONE for 2024-25). ESPN's `shotsTotal` = shots on goal (they sum to the
  goalies' shots against). Two ESPN quirks handled: requests can hang (20 s timeout + retry) and a body can arrive
  gzipped twice (gunzip by magic bytes); a game that still fails is skipped and fetched on the next run.
- `.github/workflows/refresh.yml` rebuilds daily and commits — `git pull` first once the repo is on GitHub.
- Test over http: preview config `nhl-static` (port 8793, `%TEMP%/serve_nhl.mjs`).

## Rules for model changes
- One `MODEL` config drives the backtest AND what ships; the app's `project()` / `pOver()` / `propSides()` copy the
  build's — keep them identical.
- Validate with `BT_EXPERIMENTS=1 SKIP_LIVE=1 node build-nhl-snapshot.mjs 2025 2026`; keep a switch only if it wins BOTH
  halves of the test season; under ~0.0003 Brier is noise.
- Tested 2026-10-16 (train 2025, test 2026). KEPT: opponent shots-allowed exponent (fitted 1), rateHL 80 (40 lost both
  halves), shrinkMin 100 (300/600/1200 lost; 0/50 lost), wPrior 0.7 (0.4 lost), shPseudo 60 (20/150/300 lost), calib
  points (slope 1.05). DROPPED: Vegas total context (fits 0 with the opponent + goalie in; also no totals in 2024-25, so
  it was cross-fitted on 2025-26 halves). Goalie save % vs team goals-per-shot: no measurable difference — kept because the
  user can set the goalie. Dispersion: shots NB r=8, goals / points Poisson.
- The backtest treats tonight's starting goalie as known (announced before puck drop) — the starter = the team's goalie
  with the most TOI that night. The app defaults to ESPN's scoreboard `probables` (probableStartingGoalie).

## Market-first (TESTED on real NHL prices, 2026-10-16)
- REAL-PRICE TEST: `market-backtest.mjs` (shared with the NBA repo; `DUMP_BT=1 SKIP_LIVE=1 node build-nhl-snapshot.mjs
  2025 2026` first) priced 299 games × sog / anytime / points at start−20 min (~9K credits; Utah was UTA in 2025-26 and
  UTAH now — `canon()`). Books beat the model on sog + points both halves -> model share 0 (`propW(s)`). Anytime goal:
  model == market (Brier .1199/.1244) but the app's anytime rule (market EV>3% at best FD/DK) LOST 38% on 183 bets (CI
  below 0) -> GOAL_BETS=false: anytime goal is shown, tier 'nobet', never on the card. Every over −4%, under −8%, every
  anytime −8% (+100..+400 −2.6%). Two-way app-rule bets were rare (21) — the books barely disagree on NHL props.
- Shots / points: other books' de-vigged P(over) (`consAt`, nearest line within max(1,12%) moved by the model), model
  share from market_anchor.json (0), capped ±3 pts (`MODEL_CAP`).
- Anytime goal (`player_goal_scorer_anytime`, yes-only): `yesScale()` = Σ model P(goal) / Σ other books' implied over the
  game's players (≥6) → fair = implied × that (market says who, model says how many — the NFL 1st/last-TD rule);
  GOAL_W = 0 (the NFL TD test). `player_goals` O/U 0.5 (two-way, off by default) is de-vigged like shots when posted.
- Tiers: `dart` (<6% chance, never bet) and `flag` (edge >12 pts or EV >100%) — added after a mock +17139 price showed as
  a +750% "edge".
- Links: FanDuel / DraftKings / BetMGM (`t.g` options token, needs state) / Caesars (state) / Fanatics = home page. No
  BetRivers (not in the user's state). State falls back to the NFL app's `nfltd_oddscfg.state` (same site).

## App structure
- localStorage prefix `nhlp_` (bets, bank, boards 3 days, status per day incl. `G|game|team` goalie picks, oddscfg,
  oddskey → falls back to `nfltd_oddskey` / `nbap_oddskey`, mtab).
- Phone tab bar: sections carry `data-m` card | games | priced | bets in the HTML.
- `autoSettle()`: ESPN summary by `b.ev`; keys `shotsTotal` / `goals` / `assists`; a skater not in the box = scratched → void.

## ⚡ Automatic closing prices (2026-10-20 — 16 NHL bets went 5-11 with NO Close on any, so the log had no CLV)
- The NFL app's rule, ported (NBA has the same code). `autoCloses()` runs 8 s after opened() (after the first sync), every
  2 min, and on `visibilitychange` (phones pause timers): `autoLiveCloses()` then `autoHistCloses()`.
- LIVE (AUTO.close, on by default): open bets whose start (SLATE tip, else `b.ko`) is ≤15 min away → `pullGame(g, only the
  bets' markets)` → `applyBoard(g, board, true)` (b.cur) → `applyClose()` = `closeView()` (the bet's book at the bet's
  line; a moved line is translated → `closeEst`). 1 credit per market per game. Errors other than key/credits retry next check.
- HISTORY (AUTO.hist, OPT-IN, off by default): bets with no Close whose game started <14 days ago (pushes/voids skipped) →
  `histBoard()`: HIST_API `/events?date=start−5min` (1 credit) + `/events/{id}/odds?date=…&bookmakers=myBooks()` (10 per
  market). Free plan → `nhlp_histoff` pauses 3 days; offline / 401 / 429 → 30-min pause (memory); other errors mark the game 'fail'.
- Each game|start|market is tried ONCE, live or history (`nhlp_closed`, pruned after 21 days). Both stop at CFG.reserve
  (no confirm — a note in #autoMsg). `nhlp_auto` {close, hist}; checkboxes #autoCloseChk / #autoHistChk under odds
  settings, #histCost = "N bets waiting · about C credits" (what ticking history would spend now). Filled bets carry
  `closeSrc` 'live' | 'hist' (title on the Close box); a typed close deletes it. `applyClose()` is shared with ⚡ Closing
  prices (`pullCloses`, still there for a close taken by hand). apiGet awaits opened() and the timers skip
  document.prerendering, so a page built in the background spends nothing.
- Two devices open at once can each pull the same close (`nhlp_closed` is per browser; sync merges `closeOdds`) — 1 credit.
- TESTED 2026-10-20 with a mocked fetch only (no real credits): a throwaway copy of the built page with fetch mocked (fake
  ESPN scoreboard + Odds API events / odds / history, x-requests-remaining) and fresh localStorage on its own port. Start
  in 10 min → filled live (exact −115; a 3.5 bet vs the book's 2.5 → ≈ translated), 1 credit; started game untouched until
  history was ticked → filled from start−5 min (11 credits); start in 20 min → nothing; re-checks spend nothing; credits
  below the reserve → paused with a note; document.prerendering → nothing until activation. The real historical endpoint
  was NOT called — it is the NFL app's (tested there on IND@WAS 2026-10-04).

## One site, one pot (2026-10-16, user: "combine all into one sim … make them like the nfl sim … one pot")
- The NFL, NBA and NHL apps are separate repos on ONE site (popcawn.github.io), so they share one browser storage. Each
  page has a sport switcher (🏈 · 🏀 · 🏒, relative links ../<repo>/) and a 💰 pot chip.
- ONE POT: `nfltd_bank` {amt, at, mt} is the bankroll for all three; bankNow() = amt + the dollar P/L of EVERY sport's bets
  settled after `at` (`allBets()` reads nfltd_bets / nbap_bets / nhlp_bets). Typing a balance in any app writes nfltd_bank
  (with mt). A `storage` listener redraws when another tab changes it. The NBA / NHL apps' own *_bank keys are only a
  fallback for old data.
- ☁ SYNC: the NFL app owns the token + secret gist (`nfltd_sync` {token, gistId}); the NBA / NHL apps reuse them and
  write their OWN file in that gist (nba-sync.json / nhl-sync.json: bets + tombstones + the pot), merged like the NFL
  app's (mt newest wins, tombstones). If no token: "☁ Sync: set up in 🏈 NFL".
- NBA / NHL bet log = the NFL layout: weeks (Mon→Sun) with the money line (won/lost pill · spent · still riding) -> nights (collapsed; tonight's marked 📍) -> bets.

## Look (2026-10-19, user: "its a little dark. Modernize the site … markets in the background … just a pull odds and the bets across all games with click-to-open links" → "light default, apply it to all three")
- One look for all three apps (+ the front door): light theme by default, 🌙 dim (`sims_theme` in localStorage — one setting for the
  whole site; a head script sets it before first paint). Fonts: Inter (text), Space Grotesk (headings), JetBrains Mono (odds,
  money) from Google Fonts; base 16px. Colors are CSS variables redefined under `:root[data-theme="dim"]` — never hardcode a
  dark-only color (team names as text go through teamText(), which is theme-aware).
- Sticky top bar (`#topbar`): brand → popcawn.github.io, sport pills, the pot as stat boxes (renderPotChip: bankroll ·
  this week = every sport's bets settled since Monday · bets · open · this game), light/dim button, then the tabs (`#dtabs`).
  Phones keep the bottom bar (`#mtabbar`); showTab() keeps both in step. Sticky offsets use --navh = top bar height.
- Tabs at EVERY width now (sections carry data-m): card = ⚡ Bets (Pull tonight hero + tonight's card as cards), games = players by game, priced = ★ every priced bet, bets = 📓 Bet log (bankroll beside it ≥1200px).
- The first tab is a big pull button (.hero) and the bets as cards (betCard(): name, market, price + book, Bet $, chance bar
  vs the price's chance, EV, an Open-on-<book> link). The internals (pulls, card rules, staking, log) did not change.
- Name: PROP SIM (tab title, brand, front door; user 2026-10-19). Switching sports must feel seamless: links go STRAIGHT to
  `<repo>/<repo>.html` — never the folder (its index.html is only a redirect for old links/bookmarks, and linking it
  flashed a page between sports). How a switch works (recorded frame by frame in a throwaway headless Chrome, 2026-10-19 — the user still saw a flash
  NBA -> NFL): `@view-transition{navigation:auto}` with NO animation (a 160 ms cross-fade showed both pages at once) and
  no separate top-bar layer (its see-through background let the old tabs show for a frame), so the page you leave stays
  on screen until the next is fully drawn, then they swap in one frame (~100 ms into NFL). Speculation rules PRERENDER
  the other sports on hover; `opened()` holds everything that spends or writes (odds pulls — NFL fetchGameOdds, NBA/NHL
  apiGet — settling, closes, gist sync) until the page is actually opened. `sims_chip` = the last pot boxes, shown
  instantly. Fonts are self-hosted on popcawn.github.io/fonts (preloaded, `font-display: optional` — no late re-draw of
  the text). NBA / NHL also open with the last slate + injuries this browser saw (`*_slate`, `*_inj`), refreshed from
  ESPN a moment later, so the date line and tonight's bets don't pop in. Test harness idea: Chrome --headless=new +
  CDP Page.startScreencast, with a normal user agent (ESPN doesn't answer HeadlessChrome).
- First paint waits for the app to draw itself: `<link rel="expect" href="#sims-ready" blocking="render">` in the head and
  `<i id="sims-ready" hidden>` right AFTER the main script (keep it last in body), so a sport switch fades from one finished
  page to the next instead of showing a half-drawn one.
- The ⚡ Bets list draws ONLY new bets (user, 2026-10-21: "logged bets shouldnt be shown. Only new bets"); the status line
  still counts the logged ones ("· 1 already in your log") and the log has them. Your card (NFL game tab) still shows both.
- The ⚡ Bets list is grouped BY SPORTSBOOK (user, 2026-10-21: "doesnt need to stacked. or even seperated by game … if
  anything seperate by book"): FanDuel, DraftKings, BetMGM, Caesars, Fanatics; each section is one grid of cards with an
  "Open all N on <book>" button, and each card names its game and start time. Fanatics (no slip link) opens its home page.
- Tonight's card shows EVERY take (user, 2026-10-21: "remove show up to, show all take bets"): no bets-a-night select, no
  team or game limit — one bet per player per STAT (statOf(); a stat in your log holds it at any line; logBet refuses a
  second). NIGHT_CAP (12%) still scales the stakes down when there are many, so the night's total risk doesn't grow.
- ✕ Skip + "bet at X or better" (user, 2026-10-21: FanDuel showed +104 for a +114 card bet — "should it be a removed
  button … when i recheck for bets it doesnt pop up again"): each card has ✕ Skip (SKIP map in localStorage *_skip, key
  game|player|stat, kept 4 days NBA/NHL, 8 NFL) — the bet stays hidden through re-pulls; "↩ Bring back" under the list undoes
  it. floorPrice() = the worst price that still passes the card's rule (EV > 3%; NBA/NHL also 1.5 points of edge), shown
  as "bet at +110 or better" so the user can compare with the slip. NFL: Your card on the game tab ignores skips.

## The user
- Bets FanDuel + DraftKings (+ BetMGM), wants "what do I bet and how much, in dollars", gets overwhelmed — keep the card
  short. Be honest that an edge means "out of line with the other books". Commits end with the Co-Authored-By line from
  the session's instructions.
