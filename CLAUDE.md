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
- 🕶 BACKGROUND ONLY (2026-10-27, user: "should we go all in on nfl and backgroudn nba and nhl" → "yes"): PAPER (localStorage `nhlp_paper`, default ON, #paperChk first under odds settings). buildCard puts nothing on the card; every would-be bet (the card's picks not already in the log, no bankroll limit) goes to SHADOW with why ['paper'] at its card stake, settles with the real bets, rides in sync. Card: "🕶 BACKGROUND ONLY · N would-be bets tracked" + record/ROI/CLV so far; Priced verdict 🕶 tracked; ⚙ More table row "Background mode". Real money goes to NFL only until the ~Nov 8 review. The user must still ⚡ Pull once a day (~60 credits NBA+NHL) or nothing is tracked; closes for paper bets come from the 🤖 closing-prices bot (2026-11-04, below; before it only a pull in the last 30 min gave one).
- BANKROLL LIMIT (2026-10-26, user said yes to the plan — "whatever profits the most money"): the $ on open bets across NFL/NBA/NHL (one pot, allBets()) never goes above bankNow(). fitRoom(list, usdOf) takes new bets biggest $ first; the rest wait (card note 💰 "$X of your $Y bankroll in play · N more bets wait for room", Priced verdict 💰 no room; NFL: week list + TD picks, fun picks and parlays exempt). Held/logged bets already count as riding. A season simulation said a HALF-bankroll limit cost growth for almost no safety — keep it at the full bankroll. Logging by hand from Priced / the game card isn't limited. ON/OFF SWITCH (2026-11-01, user: "create a on/off toggle for bankroll limit"): ☑ 💰 Bankroll limit (#limitChk) under the bankroll box, default ON. Off = BANK.lim===false — it lives IN the pot (nfltd_bank), so it is one switch for NFL/NBA/NHL, rides in ☁ Sync with the pot, and typing a new balance keeps it (setBank / the bankUsd handler copy lim). fitRoom() lets every bet through when off (no 💰 notes, no "no room"). renderLimit() runs from renderBank().
- ALL FIVE BOOKS BY DEFAULT (2026-10-24, user: "is it intentional to have betmgm turned off for nba" — no): the book list is saved per device and a new device started with FanDuel + DraftKings only (the user's desktop had all five; the phone likely not). Default is now FD, DK, BetMGM, Caesars, Fanatics; a device that saved fewer gets the rest added ONCE (`nhlp_oddscfg.booksV2`, kept by the settings save); unticking after that sticks. Don't drop books from the default: the real-price test found the NBA edge in shopping all five.
- localStorage prefix `nhlp_` (bets, bank, boards 3 days, status per day incl. `G|game|team` goalie picks, oddscfg,
  oddskey → falls back to `nfltd_oddskey` / `nbap_oddskey`, mtab).
- Phone tab bar: sections carry `data-m` card | games | priced | bets in the HTML.
- `autoSettle()`: ESPN summary by `b.ev`; keys `shotsTotal` / `goals` / `assists`; a skater not in the box = scratched → void.

## Filters + 🕶 background log (2026-10-23, user: "add both filters … these bets will still be pulled but not shown to me
## and logged to your own bet sheet … if the trend changes you can tell me")
- FILTERS = {fdOnly: the edge is at FanDuel and no other book of the user's has that price, ev10: EV ≥ 10%}. On last
  season's real prices (299 games, all 5 of the user's books) the app's rule made only 34 bets (−17.7%): FanDuel-alone
  16 bets −58% (down in both halves), 10%+ EV 0 for 3; BetMGM-best +10.9% on 13. Tiny samples — the NHL has no proven
  edge; the filters cut the worst of it. `parseBoard()`'s best price carries `solo` (no other book of yours matches it
  at that line); candidates carry `solo`.
- A filtered take gets `tier='filtered'` + `c.why` (filter keys) in `buildCands()` (after the tiers, before the
  same-side de-dup, where an unfiltered price at another book wins over a filtered one). Never on the card; on the Priced
  list only with "show prices with no edge" (verdict 🕶 filtered). Toggles: `.filtchk` under odds settings → `FILT`
  (localStorage `nhlp_filt`), default ON. The 📓 button can still log one by hand.
- 🕶 BACKGROUND LOG (`SHADOW`, localStorage `nhlp_shadow`): `recordShadow()` (end of `buildCard()`) stores one record
  per game + player + stat the filters hid — id `sh|game|key|stat` (deterministic, so two devices record the same
  bet), price when first seen, `evp` (EV), `why`, the card's stake (+ `usd`). `autoSettle()` settles them with the
  real bets (same ESPN fetch; not counted in the note; not in ESPN's box 36 h after the start = void). Close = a pull
  in the last 30 min before the start (`applyBoard`; no extra credits — none are pulled just for these). Rides in the
  ☁ Sync file as `shadow` (`mergeShadow`: more known wins, then the earlier record — so devices converge instead of
  overwriting each other on every sync). In the export. Never in the bankroll or the bet log.
- Log → ⚙ More → 🕶 Background bets: per filter — bets, record, flat ROI (1u), CLV, P/L at the card's stakes, verdict
  (<30 settled "too early", ≤−3% "still losing", ≥+3% on 100+ settled "📈 winning now"). A filter that's ON and "winning
  now" puts a note above the log (`#shadowAlert`). When the user asks how the filters are doing: read `nhlp_shadow` from
  their Chrome (read-only) and re-run the breakdown on it; re-test before suggesting a filter come off.

## ⚡ Automatic closing prices (2026-10-20 — 16 NHL bets went 5-11 with NO Close on any, so the log had no CLV)
- The NFL app's rule, ported (NBA has the same code). `autoCloses()` runs 8 s after opened() (after the first sync), every
  2 min, and on `visibilitychange` (phones pause timers): `autoLiveCloses()` then `autoHistCloses()`.
- LIVE (AUTO.close, on by default): open bets whose start (SLATE tip, else `b.ko`) is ≤15 min away → `pullGame(g, only the
  bets' markets)` → `applyBoard(g, board, true)` (b.cur) → `applyClose()` = `closeView()` (the bet's book at the bet's
  line; a moved line is translated → `closeEst`). 1 credit per market per game. Errors other than key/credits retry next check.
- HISTORY (AUTO.hist, ON by default since 2026-10-24 — user: "automatically add closing prices for nba and nhl same way as nfl"; it was opt-in and per device, so the phone never filled closes for games it wasn't open for. A device that saved hist:false is switched on ONCE (`nhlp_auto.v2`); unticking after that sticks. ~11 credits per market per game, only for bets the live close missed; 69K credits left that day): bets with no Close whose game started <14 days ago (pushes/voids skipped) →
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

## 🤖 Closing-prices bot (2026-11-04, user: "why does only 19 nhl bets have a closing price" → "yes build option 1")
- Why: background bets (paper since 10-27) only got a close when a pull happened in the last 30 min before the start, i.e.
  only if a page was open then — 19 of 178 NHL and 18 of 295 NBA background bets had one (Oct 28: 0 of 37, Oct 30: 0 of 40).
- `closes/closes.mjs` + `.github/workflows/closes.yml` (THIS repo; covers NBA too): every 10 min 16:00–04:59 UTC. Reads
  nhl-sync.json / nba-sync.json from the ☁ Sync gist; every pending prop bet (shadow + real) without a close whose game
  starts within 30 min → ONE pull per game of only its markets at the five books (`bookmakers=` = 1 region, 1 credit per
  market; /events is free) → the bet's book's price at its exact line and side (the apps' background rule) → writes
  nhl-closes.json / nba-closes.json in the gist: {closes: {betId: {o, t, m}}, moved: {betId: {l, o, t, m}} (the book
  changed the line — the nearest line's price, kept for a later estimate; the apps ignore it), pulled: {game|start|market:
  t} (each game+market is pulled once, live or catch-up), spent: {UTC day: credits}} (v2; v1 had tried: {game|start}).
- CATCH-UP (2026-11-04, after the first test): GitHub runs this account's TIMED jobs 3-10 HOURS late (5 weeks of the
  daily refresh crons: 10:37Z fired 13:53-20:29Z) and the */10 timer never fired on the first night, so the live pull
  rarely lands. A game that started 15+ min ago, within CLOSES_HIST_DAYS days, gets The Odds API's price HISTORY
  (/v4/historical/.../events/{id}/odds) at its start - 2 min: 10 credits per market + 1 per day's game list
  (/historical/.../events at the day's first start - 30 min). Settled bets count (not pushes; not ones already `moved`);
  a player traded since matches by the bet's own name (`players()` adds the bets' players to the rosters); at most
  CLOSES_HIST_CAP (800) credits a run, the rest next run. Workflow inputs mode / days / cap. ON since 2026-11-05 (user:
  "build the backfill"): scheduled runs and the Run-workflow default look back 3 days (`|| '3'` in closes.yml; 0 = off).
  The catch-up pauses after CLOSES_TIME_MIN (6) minutes so a long run still saves before the job's 10-min limit (the gist
  is written once, at the end — a killed job would lose the credits it spent), and each Odds API call gives up after 30 s.
  A daily '23 9' cron was added so at least one run a day happens (late).
  Never writes the apps' files (no race). Stops below CLOSES_RESERVE (1000). Matching = the apps' own (snapshot teams via
  abbrByName, gamePlayers + matchPlayer; NHL skips goalies; the NBA snapshot is read from raw.githubusercontent).
- Apps: `syncNow()` reads `<sport>-closes.json` (`gistJson`) and `applyBotCloses()` copies a close into any bet or
  background bet that has none (real bets get closeSrc 'bot' + an mt stamp; the Close box title names the bot). The apps'
  own live / history closes still run; a bot close arrives first, so history spends less.
- SECRETS the USER adds in THIS repo (Settings → Secrets and variables → Actions): ODDS_API_KEY (the 100K-plan key in
  nfl-td-predictor/.odds-key) and SYNC_TOKEN (a GitHub token with the gist scope). Without them a run logs a warning and
  exits 0. Manual run: Actions → Closing prices → Run workflow (mode dry = list only, no credits).
- Cost: live ~30 credits on a full NBA + NHL night (13 NBA + 3 NHL games with open bets), ~1,000/month — IF the timer
  fired on time. Catch-up: ~150/night; dry run 2026-11-04 over 21 days back = 54 NHL + 70 NBA games, ~2,450 credits.
- TESTED 2026-11-04: dry runs on the user's 43 real open background bets; a LIVE pull at a pretend 23:40Z for ATL@WSH +
  PHI@DET (3 credits, 92,154 left) filled 2 of 3 — the third was Maxey pts 22.5 at BetMGM, whose line had moved to 24.5
  (checked, 1 credit) -> why `moved` exists; a mocked Odds API (scratch mockfetch.mjs): exact, moved, "T. Maxey" initial
  match, not on the board, already started, reserve stop, a re-run spends 0, no secrets -> warning. The real gist calls
  were NOT exercised here (no token on this PC) — they are the apps' own endpoints (GET /gists, GET /gists/{id}, PATCH).
- REAL RUN 2026-11-05 01:50Z (= Nov 4, 8:50 PM ET; manual, live): POR@PHX 1/1 closed at -9m (Jalen Green 3PM O1.5 BetMGM -125 -> -160, and
  the NBA app copied it in on its next sync); TOR@DEN 0/1 (Braun pts at Fanatics — Fanatics posts few props to the API).
  Catch-up tested on a mocked history API (scratch mockfetch2.mjs + mockgist3.mjs): live + catch-up in one run, settled /
  push / closed / too old / moved / just started / traded player, re-run spends 0, cap pauses, dry estimates, days 0 = off.
  One real history pull (ATL@WSH pra, 10 credits): snapshot 6.5 min before the real tip, FanDuel/DK/BetMGM/Fanatics all there.
- BACKFILL 2026-11-05 15:21Z (run #7, manual, days 25, cap 3000; took 2.5 min): NHL 54 games, 148/162 closed, 5 moved;
  NBA 75 games, 215/295 closed, 59 moved; 2,569 credits (88,836 left). Every bot close was applied by the apps' sync:
  background bets with a close NHL 21 -> 167 of 194, NBA 24 -> 235 of 318 (in the gist).
- FOUND THEN: the user's PC Chrome localStorage for popcawn.github.io was FULL (5,242,861 of 5,242,880 chars — mostly
  caches: nfltd_boards 1.76M, nbap_boards 0.98M, nfltd_slatepx 0.84M, nhlp_boards 0.81M), so every lsW that grows a key
  fails silently. The apps still apply closes in memory on each sync and the gist keeps them, but the local copies stay old.

## One site, one pot (2026-10-16, user: "combine all into one sim … make them like the nfl sim … one pot")
- 🧹 STORAGE GUARD (2026-11-05, user: "yes add the cleanup"): one site = ONE ~5 MB localStorage for all three apps, and
  the user's PC Chrome was full (4.4 MB of odds caches: nfltd_boards, nbap_boards, nfltd_slatepx, nhlp_boards), so every
  write that grew a key failed silently. The same guard code sits in all three templates (keep it identical): `lsSave()`
  (every lsW, plus the NFL bets / slip / lsSet) on a failed write first drops the odds any app can tell are stale
  (`staleOdds`), then the oldest third of the rest (any app's), and retries up to 4 times. Own trims: NFL boards 6 h after
  kickoff, off this week's schedule a day after the pull, 5+ days (`trimBoards`; 1.5 s after load and on every save); NFL
  slate prices after 20 min (`trimPx` — only pxFresh reads them); NBA/NHL boards 6 h after the start (pulls store `ko`)
  or a day after a pull without one (`keepBoard`; at load and on every pull). Tested in real Chrome at the 5 MiB cap
  (full store -> stale odds dropped first, an upcoming game's board kept, settings saved). Never add bets / bank /
  settings keys to CACHE_KEYS.
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
- GOTCHA (2026-10-21): many functions here are ONE line. Never add a // comment in the middle of a line — everything after it
  is commented out. A note added after logBet's first check hid `const k=unitUsd();` and every 📓 log button threw
  "k is not defined". Put notes on their own line above.
- ↩ UNDO A LOG (2026-10-31, user: "create a button that undo log bets if i accidently click log bets"): every bet a click
  logs calls noteLogged(id) (NFL: logBetFrom, the manual add form, logParlay; NBA/NHL: logBet). One click = one batch
  (gathered with setTimeout 0) -> pop-up #undoBar "📓 Logged N bets · ↩ Undo · ✕" for 30 s, above the phone tab bar.
  undoLog() takes the batch's still-open bets out through saveBets (sync tombstones, like the log's ✕); a newer click
  replaces the pop-up. ANY NEW WAY TO LOG A BET MUST CALL noteLogged.
- 📱 PHONE STATS TABLES (2026-11-01, user screenshot: the Log tab slid sideways on a phone): a stats table with more
  columns than fit 390px gets class "pcards" and labelCells(container) after it is drawn — under 760px each row becomes a
  small card (name on top, 3-column grid of numbers, each with its column name from data-l above it). Used by By
  sportsbook, Background bets and NFL's When you bet. A NEW WIDE TABLE MUST DO THE SAME or sit in a .scroll box, never
  widen the page. WIDE SCREENS TOO (2026-11-01, user screenshot): Background bets ran ~65px past its box on a ~1000px screen (long
  verdicts never wrapped) -> table.bkstat td.l wraps and #shadowStats table.bkstat is width:auto; max-width:100%.
- ⏱ MID-GAME SETTLING (2026-11-01, user: "are you able to settle bets mid game?" → "yes"): a bet is due once its game
  starts (was start + 2.5 h). While ESPN says state 'in', an over already past its line wins and its under loses (shots,
  goals, points only count up — anytime goal wins on the goal); scratches and everything else wait for the final.
  Background (SHADOW) bets too.
  It carries b.mid=1 (log icon ⏱, b.auto "… mid-game") until the game is final; then autoSettle checks it again
  against the final box score (a stat correction flips it — note "N mid-game results changed at the final") and drops mid.
  A result set by hand deletes mid, so it is never touched again. Settle runs on open + every 10 min while the app is
  open (ESPN, free). Tested 2026-11-01 with a mocked ESPN (live -> final, incl. a correction) and once on a real live game.
- Priced list: the ✓ on a logged bet takes it back OUT of the log (user, 2026-10-21: "i cant remove a logged bet") — hover
  reads "✕ remove", a confirm names the bet, then it is deleted like the bet log's ✕ (a sync tombstone, so other devices drop it).
- NO NIGHTLY CAP (user, 2026-10-21: "no cap on nhl or nba either"): NIGHT_CAP removed — each bet is sized on its own (¼ Kelly,
  ≤ BET_CAP 3u), so a big night adds up. Don't re-add a total cap unless the user asks.
- Bet log tables FIT their column — no sideways scroll bar (user, 2026-10-21: "remove the scroll bar"): table.logtbl lets the bet
  and the close / CLV cell wrap (odds, stake, result, P/L stay on one line). Don't put white-space:nowrap back on those cells.
- Bet log tidy (user, 2026-10-21): "52 bets · 52 open" reads "52 open bets" (cnt()); NBA/NHL bet lines drop the game (it is on
  hover); a TO WIN column (profit if it wins, to the cent) and "could win $X" on the week / night / game summaries. Stakes are
  LOGGED AS SHOWN (roundUsd(): whole $ from $20, half-dollars from $1, cents below) — before, the card showed $1.50 but the log
  kept e.g. $1.73, so P/L and To win didn't match the book. Bets logged before this keep their old amounts.
- One-time stake fix (2026-10-21, user: "a 2 bet at +100 wins $2 not 1.97"): bets logged before "logged as shown" are rounded to
  what the card showed (flag *_usdround; NFL only touches app-logged bets — book / legs / mktP / rawP / fun — never a hand-typed
  stake), stamped mt so Sync spreads it. The log's stake shows exactUsd(): the usual format for round amounts, else cents.
- BetMGM STAKES ARE TYPED BY THE USER (2026-10-26, final — user: "i dont want the average. i want each respective ... just
  open all with a click and i fill it in"). Every bet keeps its own stake on the card; BetMGM links carry NO stake (single or
  open-all), one "Open all N on BetMGM" per book group. History: 10-25 a stake in a multi-bet link filled ONE amount on every
  bet (stake=2,3 filled nothing) -> one button per stake amount; 10-26 too many buttons -> a shared average stake; the user
  rejected the average, and BetMGM turned &stake=0.78 into $0.50. Don't bring back link stakes or shared stakes.
- BetMGM links = the bet slip on their SITE (a single bet's &stake= filled in on the user's iPhone
  2026-10-22: bet + stake filled in Safari). The user asked for the APP; nothing opens it from a link on their phone: /en/sportsapp/
  addresses (the only ones Apple's app-site-association lists) opened Safari, betmgm.onelink.me app links opened the App Store, and
  BetMGM publishes no private link type. Don't re-try those; a guessed custom scheme was offered, not tried.

## The user
- Bets FanDuel + DraftKings (+ BetMGM), wants "what do I bet and how much, in dollars", gets overwhelmed — keep the card
  short. Be honest that an edge means "out of line with the other books". Commits end with the Co-Authored-By line from
  the session's instructions.
