# 🏒 NHL Prop Simulator

One HTML file (`nhl-prop-predictor.html`) that projects NHL player props — **shots on goal**, **anytime goal** and
**points** — prices them against the sportsbooks, and tells you what (if anything) to bet tonight and how much. Sister
app to the [NFL anytime-TD simulator](https://github.com/popcawn/nfl-td-predictor) and the
[NBA prop simulator](https://github.com/popcawn/nba-prop-predictor); same ideas, same honesty rules.

## Using it
- **Games** — tonight's slate (ESPN, live). Click a game to see both teams. Each team's **goalie** is picked for you
  (ESPN's probable starter) — change it if the news says otherwise; it moves the other team's goal and point numbers.
  Set a scratched skater to **OUT** (injuries from ESPN are pre-filled).
- **Odds** — ⚡ Pull tonight fetches every game still to start (The Odds API key in *odds settings*; it reuses the NFL
  app's key on the same site). Each price shown is the best among **your sportsbooks**; every other book is "the
  market". Nothing is pulled automatically — 8 games × 3 markets is 24 credits a pull.
- **Tonight's card** — the best few bets across every pulled game, with a status line (🆕 NEW BETS / ✅ NO NEW BETS),
  ¼-Kelly stakes, one per player, at most 2 per team and 3 per game, the night capped at 12% of bankroll. Buttons log
  them or open them in your book's bet slip (FanDuel, DraftKings, BetMGM and Caesars — the last two need your state;
  Fanatics gives no link, so its button opens Fanatics and names the player).
- **Bankroll** and **Bet log** work like the NBA app: dollars that grow with settled bets; results settle themselves
  from ESPN's box scores (a scratched player is a void); CLV against the closing price.
- **On a phone** — a tab bar at the bottom: Card · Games · Priced · Bets.

## The model
`expected = expected ice time × per-minute rate`, adjusted for the opponent
- **Ice time** — a fast recency average (half-life 5 games); last season's average worth one game.
- **Shots per minute** — recency-weighted (half-life 80 games; a game from last season counts 70%), lightly shrunk toward
  his position (forward / defense).
- **Goals per minute** = shots per minute × his shooting %, shrunk hard toward his position's (shooting % is mostly luck).
- **Assists per minute** — like shots.
- **Opponent** — how many shots they've allowed lately (shots, goals, assists), and tonight's goalie's save %
  (goals, assists).
- **P(over a line)** — negative binomial for shots (a little wider than Poisson), Poisson for goals and points; points
  probabilities get a small fitted stretch.

## Honesty & calibration
Leak-free backtest: every game of 2025-26 (1,312 games), using only what was known before puck drop (tonight's starting
goalie counts as known — it is announced before the game); settings learned on 2024-25. Each bet is a book-like line —
shots at his season average on the half shot, goals and points at 0.5. Brier score per half of the season (lower is
better):

| Bet | Player-games | Simulator (half 1 / half 2) | Plain season average |
|---|---|---|---|
| Shots on goal | 21,173 | **0.2322 / 0.2387** | 0.2397 / 0.2419 |
| Anytime goal | 46,476 | **0.1197 / 0.1216** | 0.1246 / 0.1234 |
| Points | 30,005 | **0.2255 / 0.2281** | 0.2306 / 0.2304 |

Every switch had to beat its "off" setting on **both** halves to stay (`BT_EXPERIMENTS=1`). Kept: the opponent's shots
allowed, the longer rate memory, light shrinkage, last season at 70%, the points stretch. Dropped: the Vegas game total
(it fitted zero once the opponent and goalie were in). The goalie's save % made no measurable difference over the
opponent's goals per shot; it stays because it's the thing you can set.

### Real prices (2025-26, tested Oct 2026)
`market-backtest.mjs` priced 299 games of 2025-26 with every US book's real lines ~20 minutes before puck drop (The Odds
API history, ~9,000 credits) and scored the same leak-free projections against them (Brier, half 1 / half 2):

| Bet | Lines | The other books | Simulator |
|---|---|---|---|
| Shots on goal | 4,367 | **.2430 / .2460** | .2443 / .2492 |
| Points | 4,809 | **.2406 / .2349** | .2427 / .2377 |
| Anytime goal | 10,353 | .1199 / .1244 | .1199 / .1244 |

The books beat the simulator on shots and points in both halves (closer than in the NBA); on anytime goal they were
exactly as good as each other. At the better of FanDuel / DraftKings: every over lost ~4%, every under ~8%, every anytime
goal ~8% (−2.6% inside +100 to +400). The decisive one: **betting the anytime-goal prices that looked best (your book
longer than the others) lost 38% on 183 bets** — a book that is out of line on a scorer usually knows something
(line changes, power-play units). So:
- shots and points: chance = the other books' price with their cut removed — the simulator gets no say;
- **anytime goal is priced and shown, never put on the card** ("not bet (tested)");
- under a 6% chance is a 🎲 long shot and never bet; an EV over 100% is ⚠ check.

An **edge** means "your book is out of line with the others"; **CLV** in the bet log is how you find out whether it works.

*Not betting advice.*

## Files
| File | What it is |
|---|---|
| `nhl-prop-predictor.html` | The deliverable. Open in any browser. |
| `nhl-prop-predictor.template.html` | UI + live model (the build injects the snapshot into it). |
| `build-nhl-snapshot.mjs` | Node build: game logs → model → backtest → `nhl-snapshot.json` + the HTML. |
| `fetch-gamelog.mjs` | Downloads ESPN box scores into `data/gamelog_<season>.json` (only games not on file). |
| `data/gamelog_*.json` | Compact box scores per season (ESPN names a season by the year it ends: 2026 = 2025-26). |

## Refreshing the data
```bash
node build-nhl-snapshot.mjs                   # seasons 2025 2026 2027: fetches new box scores, rebuilds everything
BT_EXPERIMENTS=1 SKIP_LIVE=1 node build-nhl-snapshot.mjs 2025 2026   # flip every model switch, print both halves
```
`.github/workflows/refresh.yml` runs the build every morning and commits the result.
