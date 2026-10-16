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
- NBA / NHL bet log = the NFL layout: weeks (Mon→Sun) with the money line (spent · won/lost · still riding · season so
  far) -> nights (collapsed; tonight's marked 📍) -> bets.

## The user
- Bets FanDuel + DraftKings (+ BetMGM), wants "what do I bet and how much, in dollars", gets overwhelmed — keep the card
  short. Be honest that an edge means "out of line with the other books". Commits end with the Co-Authored-By line from
  the session's instructions.
