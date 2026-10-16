#!/usr/bin/env node
// REAL-PRICE TEST: last season's sportsbook prop prices (The Odds API historical snapshots, ~20 min before the start)
// against this app's leak-free projections (bt_rows_<season>.json, written by `DUMP_BT=1 SKIP_LIVE=1 node build-*.mjs`).
// The same file runs in the NBA and the NHL repo (it picks the sport from the snapshot that's here).
//   node market-backtest.mjs              dry run: games picked, credits it would cost
//   node market-backtest.mjs --go         fetch (paid key in ../nfl-td-predictor/.odds-key; cached in market_hist/, never twice)
//   node market-backtest.mjs analyze      model vs the other books vs blends (Brier per half), ROI per betting rule,
//                                         writes market_anchor.json (the fitted model share the app ships)
// Questions it answers: does the model beat the books' own price? and what would betting your books' best price
// (FanDuel / DraftKings) have returned under each rule — the app's rule included?
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SPORT = fs.existsSync(path.join(DIR, 'nhl-snapshot.json')) ? 'nhl' : 'nba';
const CFG = {
  nba: { key: 'basketball_nba', season: 2026, games: 200, markets: { player_points: 'pts', player_rebounds: 'reb', player_assists: 'ast', player_threes: 'tpm', player_points_rebounds_assists: 'pra' }, calib: ['pts', 'pra'] },
  nhl: { key: 'icehockey_nhl', season: 2026, games: 300, markets: { player_shots_on_goal: 'sog', player_goal_scorer_anytime: 'goal', player_points: 'pts' }, calib: ['pts'] },
}[SPORT];
const MINE = ['fanduel', 'draftkings'];   // "your books": their best price is what gets bet; every other book is the market
const FLOOR = 70000;                       // never let the key drop below this while fetching (the apps need the rest of the month)
const HIST = path.join(DIR, 'market_hist'), API = 'https://api.the-odds-api.com/v4/historical/sports/' + CFG.key;
const log = (...a) => console.log(...a);
const BT = JSON.parse(fs.readFileSync(path.join(DIR, `bt_rows_${CFG.season}.json`), 'utf8'));
const SNAP = JSON.parse(fs.readFileSync(path.join(DIR, `${SPORT}-snapshot.json`), 'utf8'));
const mode = process.argv[2] === 'analyze' ? 'analyze' : process.argv.includes('--go') ? 'go' : 'dry';

// ------------------------------------------------------------------ which games: evenly spread over the season (both halves)
const games = BT.games.slice().sort((a, b) => a.d < b.d ? -1 : 1);
const stride = games.length / CFG.games, pick = [];
for (let i = 0; i < CFG.games && Math.floor(i * stride) < games.length; i++) pick.push(games[Math.floor(i * stride)]);
const nMk = Object.keys(CFG.markets).length, days = [...new Set(pick.map(g => g.d.slice(0, 10)))];

// ------------------------------------------------------------------ fetch
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z]/g, '');
const nick = n => norm(String(n || '').split(' ').pop());
const abbrOf = name => SNAP.teamList.find(a => norm(SNAP.teams[a].name) === norm(name)) || SNAP.teamList.find(a => nick(SNAP.teams[a].name) === nick(name)) || null;
const canon = a => ({ UTAH: 'UTA' })[a] || a;   // ESPN called Utah UTA in 2025-26 and UTAH now
let left = null;
async function api(url) {
  const r = await fetch(url); const rem = r.headers.get('x-requests-remaining'); if (rem != null) left = +rem;
  if (!r.ok) throw new Error(`http ${r.status} ${(await r.text()).slice(0, 160)}`); return r.json(); }
if (mode !== 'analyze') {
  fs.mkdirSync(HIST, { recursive: true });
  const cached = pick.filter(g => fs.existsSync(path.join(HIST, g.id + '.json'))).length;
  log(`${SPORT.toUpperCase()} ${CFG.season - 1}-${String(CFG.season).slice(2)}: ${pick.length} of ${games.length} games picked (${days.length} game days), ${cached} already fetched.`);
  log(`cost: ~${(pick.length - cached) * nMk * 10} credits for the props (${nMk} markets x 10) + up to ${days.length} for the event lists.`);
  if (mode === 'dry') { log('dry run — add --go to fetch.'); process.exit(0); }
  const KEY = fs.readFileSync(path.join(DIR, '..', 'nfl-td-predictor', '.odds-key'), 'utf8').trim();
  const evCache = path.join(HIST, '_events.json'), EV = fs.existsSync(evCache) ? JSON.parse(fs.readFileSync(evCache, 'utf8')) : {};
  let n = 0, miss = 0; const LIMIT = +process.env.LIMIT || Infinity;   // LIMIT=2: a cheap first look
  for (const g of pick) {
    const file = path.join(HIST, g.id + '.json'); if (fs.existsSync(file)) continue; if (n >= LIMIT) break;
    if (left != null && left < FLOOR) { log(`stopping: ${left} credits left (floor ${FLOOR})`); break; }
    const day = g.d.slice(0, 10);
    if (!EV[day]) { const first = pick.filter(x => x.d.slice(0, 10) === day).map(x => Date.parse(x.d)).sort((a, b) => a - b)[0];   // the day's first start - 1 h: every game that day is still upcoming
      const j = await api(`${API}/events?apiKey=${KEY}&date=${new Date(first - 3600e3).toISOString().replace('.000', '')}`);
      EV[day] = (j.data || []).map(e => ({ id: e.id, t: e.commence_time, h: abbrOf(e.home_team), a: abbrOf(e.away_team) })); fs.writeFileSync(evCache, JSON.stringify(EV)); }
    const ev = EV[day].find(e => canon(e.h) === canon(g.h) && canon(e.a) === canon(g.a) && Math.abs(Date.parse(e.t) - Date.parse(g.d)) < 6 * 3600e3);
    if (!ev) { miss++; log(`  no event for ${g.a}@${g.h} ${g.d}`); continue; }
    const at = new Date(Date.parse(ev.t) - 20 * 60e3).toISOString().replace('.000', '');
    try { const j = await api(`${API}/events/${ev.id}/odds?apiKey=${KEY}&date=${at}&regions=us&markets=${Object.keys(CFG.markets).join(',')}&oddsFormat=american`);
      fs.writeFileSync(file, JSON.stringify({ espn: g.id, ev: ev.id, at, ts: j.timestamp, data: j.data })); n++;
      if (n % 25 === 0) log(`  ${n} fetched · ${left} credits left`); }
    catch (e) { log(`  ${g.a}@${g.h}: ${e.message}`); if (/401|429|quota/i.test(e.message)) break; }
  }
  log(`done: ${n} fetched, ${miss} without an event · ${left} credits left`); process.exit(0);
}

// ------------------------------------------------------------------ analyze
const clamp = (x, a, b) => Math.max(a, Math.min(b, x)), logit = p => Math.log(p / (1 - p)), expit = x => 1 / (1 + Math.exp(-x));
const ip = a => a > 0 ? 100 / (a + 100) : -a / (-a + 100), dec = a => a > 0 ? 1 + a / 100 : 1 + 100 / -a;
const median = a => { const s = a.slice().sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const squeeze = (p, b) => b === 1 ? p : expit(b * logit(clamp(p, 0.005, 0.995)));
// the app's model probability (copies of the build's functions)
function propPOverTab(tab, mu, L) { if (!(mu > 0)) return 0; let bk = tab.edges.findIndex(e => mu <= e); if (bk < 0) bk = tab.q.length - 1;
  const q = tab.q[bk], n = q.length, x = L / mu; if (x < q[0]) return 1; if (x >= q[n - 1]) return 0;
  let lo = 0, hi = n - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (q[m] <= x) lo = m; else hi = m - 1; }
  return 1 - (lo + (q[lo + 1] > q[lo] ? (x - q[lo]) / (q[lo + 1] - q[lo]) : 0)) / (n - 1); }
function pOverNB(mu, r, L) { if (!(mu > 0)) return 0; const k = Math.floor(L); if (k < 0) return 1; const pois = !(r < 1e6);
  let p = pois ? Math.exp(-mu) : Math.pow(r / (r + mu), r), c = p; for (let i = 0; i < k; i++) { p *= pois ? mu / (i + 1) : (i + r) / (i + 1) * mu / (r + mu); c += p; } return clamp(1 - c, 0, 1); }
function modelOver(row, s, L) {
  const mu = row.mu[s], h = row.half, cl = v => clamp(v, 0.01, 0.99);
  const raw = SPORT === 'nba' ? (Ln => propPOverTab(BT.stats[s].tabs[h], mu, Ln)) : (Ln => pOverNB(mu, BT.r[s], Ln));
  const b = SPORT === 'nba' ? BT.stats[s].slopeH[h] : ((BT.calib || []).includes(s) ? BT.slopeH[s][h] : 1);
  if (Number.isInteger(L)) { const o = raw(L + 0.5 - (SPORT === 'nhl' ? 0.5 : 0)), u = 1 - raw(L - 0.5), t = o + u; return t > 0 ? squeeze(cl(o / t), b) : null; }
  return squeeze(cl(raw(L)), b);
}
// rows by ESPN game id -> players (name match on that game only)
const rowsByGame = new Map(); for (const r of BT.rows) (rowsByGame.get(r.g) || rowsByGame.set(r.g, []).get(r.g)).push(r);
function matcher(rows) { const P = rows.map(r => { const nm = (BT.names[r.pid] || [''])[0], t = nm.replace(/\b(Jr|Sr|II|III|IV)\b\.?/g, '').trim().split(/\s+/); return { r, nn: norm(nm), last: norm(t[t.length - 1]), fi: norm(t[0]).slice(0, 1) }; });
  return name => { const n = norm(name); let p = P.find(x => x.nn === n); if (p) return p.r; const t = String(name).replace(/\b(Jr|Sr|II|III|IV)\b\.?/g, '').trim().split(/\s+/), last = norm(t[t.length - 1]), fi = norm(t[0]).slice(0, 1), c = P.filter(x => x.last === last && x.fi === fi); return c.length === 1 ? c[0].r : null; }; }
const actOf = (row, s) => row.act[s];
const X = [], Y = [];   // X: two-way lines; Y: yes-only anytime prices (NHL)
let files = 0, unmatched = 0;
for (const f of fs.readdirSync(HIST).filter(f => /^\d+\.json$/.test(f))) {
  const H = JSON.parse(fs.readFileSync(path.join(HIST, f), 'utf8')), rows = rowsByGame.get(H.espn) || [], match = matcher(rows), g = games.find(x => x.id === H.espn); if (!H.data || !g) continue; files++;
  const two = new Map(), yes = new Map();   // key -> {mine:{book:{O,U}}, oth:[pOver]} ; yes key -> {mine:{book:price}, oth:[ip]}
  for (const bk of (H.data.bookmakers || [])) for (const m of (bk.markets || [])) { const s = CFG.markets[m.key]; if (!s) continue; const isMine = MINE.includes(bk.key);
    if (m.key === 'player_goal_scorer_anytime') { for (const o of m.outcomes) { if (o.name !== 'Yes') continue; const row = match(o.description); if (!row) { unmatched++; continue; } const k = row.pid;
        const t = yes.get(k) || { row, mine: {}, oth: [] }; yes.set(k, t); if (isMine) t.mine[bk.key] = o.price; else t.oth.push(ip(o.price)); } continue; }
    const pairs = {}; for (const o of m.outcomes) { if (o.point == null || (o.name !== 'Over' && o.name !== 'Under')) continue; const k = o.description + '|' + o.point; (pairs[k] = pairs[k] || { name: o.description, line: +o.point })[o.name === 'Over' ? 'O' : 'U'] = o.price; }
    for (const q of Object.values(pairs)) { if (q.O == null || q.U == null) continue; const row = match(q.name); if (!row) { unmatched++; continue; } const k = s + '|' + row.pid + '|' + q.line;
      const t = two.get(k) || { row, s, line: q.line, mine: {}, oth: [] }; two.set(k, t); if (isMine) t.mine[bk.key] = { O: q.O, U: q.U }; else t.oth.push(ip(q.O) / (ip(q.O) + ip(q.U))); } }
  for (const t of two.values()) { if (!t.oth.length || !Object.keys(t.mine).length) continue; const y = actOf(t.row, t.s); if (y === t.line) continue;
    const pm = modelOver(t.row, t.s, t.line); if (pm == null) continue; const bestO = Math.max(...Object.values(t.mine).map(x => x.O)), bestU = Math.max(...Object.values(t.mine).map(x => x.U));
    X.push({ g: H.espn, half: t.row.half, s: t.s, line: t.line, pm, pk: median(t.oth), nb: t.oth.length, o: y > t.line ? 1 : 0, bestO, bestU }); }
  // anytime goal: the other books' yes prices scaled to the model's expected scorer count in this game (the app's yesScale)
  const Ys = [...yes.values()].filter(t => t.oth.length && Object.keys(t.mine).length); let sm = 0, si = 0; for (const t of Ys) { sm += 1 - Math.exp(-t.row.mu.goal); si += median(t.oth); }
  const kS = Ys.length >= 6 && si > 0 ? sm / si : null;
  for (const t of Ys) { if (!kS) continue; const pm = 1 - Math.exp(-t.row.mu.goal), raw = median(t.oth); Y.push({ g: H.espn, half: t.row.half, s: 'goal', pm, pk: clamp(raw * kS, 0.005, 0.95), raw, o: t.row.act.goal > 0 ? 1 : 0, best: Math.max(...Object.values(t.mine)) }); }
}
log(`\n== ${SPORT.toUpperCase()} real-price test: ${files} games priced ~20 min before the start · ${X.length} two-way lines${Y.length ? ` · ${Y.length} anytime-goal prices` : ''} (${unmatched} book names not matched)`);
const blend = (pk, pm, w) => w === 0 ? pk : w === 1 ? pm : expit((1 - w) * logit(clamp(pk, 0.003, 0.997)) + w * logit(clamp(pm, 0.003, 0.997)));
const appP = (pk, pm, w) => clamp(blend(pk, pm, w), pk - 0.03, pk + 0.03);   // the app's rule: w, capped at 3 points
const brier = (R, f) => { let e = 0; for (const x of R) e += (f(x) - x.o) ** 2; return R.length ? e / R.length : NaN; };
const f4 = v => v.toFixed(4), pc = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
// ROI of flat 1-unit bets, with a 95% range from resampling whole games
function roi(B) { if (!B.length) return { n: 0 }; const r = B.map(b => b.win ? b.d - 1 : -1), m = r.reduce((a, b) => a + b, 0) / r.length;
  const byG = new Map(); B.forEach((b, i) => (byG.get(b.g) || byG.set(b.g, []).get(b.g)).push(r[i])); const G = [...byG.values()]; const sims = [];
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 400; k++) { let s = 0, n = 0; for (let j = 0; j < G.length; j++) { const gg = G[Math.floor(rnd() * G.length)]; for (const v of gg) { s += v; n++; } } sims.push(s / n); }
  sims.sort((a, b) => a - b); return { n: B.length, m, lo: sims[10], hi: sims[389] }; }
const fmtR = R => R.n ? `${pc(R.m)} on ${R.n} bets [${pc(R.lo)}..${pc(R.hi)}]` : '—';
const W = [0, 0.1, 0.2, 0.3, 0.5, 0.7, 1], anchor = {};
for (const s of [...new Set(X.map(x => x.s))]) {
  const R = X.filter(x => x.s === s), H1 = R.filter(x => x.half === 1), H2 = R.filter(x => x.half === 2);
  log(`\n-- ${s}: ${R.length} lines (half 1 ${H1.length}, half 2 ${H2.length}); over rate ${(R.reduce((a, x) => a + x.o, 0) / R.length * 100).toFixed(1)}%`);
  log(`   Brier  market ${f4(brier(H1, x => x.pk))}/${f4(brier(H2, x => x.pk))}   model ${f4(brier(H1, x => x.pm))}/${f4(brier(H2, x => x.pm))}   app (10%, capped) ${f4(brier(H1, x => appP(x.pk, x.pm, 0.1)))}/${f4(brier(H2, x => appP(x.pk, x.pm, 0.1)))}`);
  const bw = W.map(w => [w, brier(H1, x => blend(x.pk, x.pm, w)), brier(H2, x => blend(x.pk, x.pm, w))]);
  log('   blends (model share w, half1/half2): ' + bw.map(([w, a, b]) => `${w}: ${f4(a)}/${f4(b)}`).join('  '));
  const best = (i) => bw.slice().sort((a, b) => a[i] - b[i])[0][0], both = bw.slice().sort((a, b) => (a[1] + a[2]) - (b[1] + b[2]))[0][0];
  log(`   best model share: half 1 ${best(1)}, half 2 ${best(2)} -> ships ${best(1) === best(2) ? best(1) : 0}`);
  anchor[s] = { w: best(1) === best(2) ? best(1) : 0, wBothSum: both, wHalves: { h1: best(1), h2: best(2) }, n: R.length };   // a model share must win BOTH halves, else 0
  const bets = (rule) => { const B = []; for (const x of R) for (const [sd, am] of [['O', x.bestO], ['U', x.bestU]]) { const d = dec(am), pk = sd === 'O' ? x.pk : 1 - x.pk, pm = sd === 'O' ? x.pm : 1 - x.pm;
      if (rule(pk, pm, d, sd)) B.push({ g: x.g, half: x.half, d, win: (sd === 'O') === (x.o === 1) }); } return B; };
  const rules = { 'every over': (pk, pm, d, sd) => sd === 'O', 'every under': (pk, pm, d, sd) => sd === 'U',
    'model EV>3%': (pk, pm, d) => pm * d - 1 > 0.03, 'market EV>3%': (pk, pm, d) => pk * d - 1 > 0.03,
    "app's rule": (pk, pm, d) => { const p = appP(pk, pm, 0.1), ev = p * d - 1, e = p - 1 / d; return p >= 0.06 && ev >= 0.03 && e >= 0.015 && e <= 0.12 && ev <= 1; } };
  for (const [name, rule] of Object.entries(rules)) { const B = bets(rule); log(`   ROI ${name.padEnd(13)} ${fmtR(roi(B))}   halves ${fmtR(roi(B.filter(b => b.half === 1)))} | ${fmtR(roi(B.filter(b => b.half === 2)))}`); }
}
if (Y.length) {
  const H1 = Y.filter(x => x.half === 1), H2 = Y.filter(x => x.half === 2);
  log(`\n-- anytime goal (yes-only): ${Y.length} prices; scored ${(Y.reduce((a, x) => a + x.o, 0) / Y.length * 100).toFixed(1)}%`);
  log(`   Brier  market (scaled) ${f4(brier(H1, x => x.pk))}/${f4(brier(H2, x => x.pk))}   market raw ${f4(brier(H1, x => x.raw))}/${f4(brier(H2, x => x.raw))}   model ${f4(brier(H1, x => x.pm))}/${f4(brier(H2, x => x.pm))}`);
  const bw = W.map(w => [w, brier(H1, x => blend(x.pk, x.pm, w)), brier(H2, x => blend(x.pk, x.pm, w))]);
  log('   blends: ' + bw.map(([w, a, b]) => `${w}: ${f4(a)}/${f4(b)}`).join('  '));
  const g1 = bw.slice().sort((a, b) => a[1] - b[1])[0][0], g2 = bw.slice().sort((a, b) => a[2] - b[2])[0][0]; anchor.goal = { w: g1 === g2 ? g1 : 0, wHalves: { h1: g1, h2: g2 }, n: Y.length };
  const B = rule => Y.filter(x => rule(x)).map(x => ({ g: x.g, half: x.half, d: dec(x.best), win: x.o === 1 }));
  const rules = { 'every yes': () => true, 'every yes +100..+400': x => x.best >= 100 && x.best < 400, 'model EV>3%': x => x.pm * dec(x.best) - 1 > 0.03,
    "app's rule (market)": x => { const d = dec(x.best), ev = x.pk * d - 1, e = x.pk - 1 / d; return x.pk >= 0.06 && ev >= 0.03 && e >= 0.015 && e <= 0.12 && ev <= 1; } };
  for (const [name, rule] of Object.entries(rules)) { const b = B(rule); log(`   ROI ${name.padEnd(21)} ${fmtR(roi(b))}   halves ${fmtR(roi(b.filter(x => x.half === 1)))} | ${fmtR(roi(b.filter(x => x.half === 2)))}`); }
}
const two = Object.entries(anchor).filter(([s]) => s !== 'goal'), wAll = two.length ? two.map(([, a]) => a.w * a.n).reduce((p, c) => p + c, 0) / two.map(([, a]) => a.n).reduce((p, c) => p + c, 0) : 0.1;
const out = { builtAt: new Date().toISOString(), sport: SPORT, season: CFG.season, snap: '20 min before the start', stats: anchor,
  app: { props: { w: Math.round(wAll * 100) / 100, fitted: true, season: CFG.season, n: X.length, byStat: Object.fromEntries(two.map(([s, a]) => [s, a.w])) }, ...(anchor.goal ? { goal: { w: anchor.goal.w, fitted: true } } : {}) } };
fs.writeFileSync(path.join(DIR, 'market_anchor.json'), JSON.stringify(out, null, 1));
log(`\nwrote market_anchor.json: props model share ${out.app.props.w} (per stat ${JSON.stringify(out.app.props.byStat)})${out.app.goal ? `, anytime goal ${out.app.goal.w}` : ''}`);
