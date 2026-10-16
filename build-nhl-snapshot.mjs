#!/usr/bin/env node
// NHL player-prop projections + leak-free backtest -> nhl-snapshot.json (+ nhl-prop-predictor.html from the template).
//
//   node build-nhl-snapshot.mjs                 seasons 2025 2026 2027 (ESPN names a season by the year it ends)
//   BT_EXPERIMENTS=1 node build-nhl-snapshot.mjs   flip every model switch and print both halves
//   SKIP_LIVE=1 ...                             backtest only (no rosters, no files written)
//
// Model (one MODEL config drives the backtest AND the live numbers the app ships):
//   expected = expected ice time x his per-minute rate
//     ice time: a fast recency average of his games (last season's average worth toiPriorG games)
//     shots per minute: recency-weighted (last season at wPrior), shrunk toward his position (forward / defense)
//     goals per minute = shots per minute x his shooting % (shrunk hard: shooting % is mostly luck)
//     assists per minute: recency-weighted, shrunk toward his position
//   adjusted for the opponent: how many shots they allow (shots, goals, assists) and how good tonight's goalie is
//   (goals, assists), and for tonight's game total (goals, points)
//   P(over a line) = negative binomial with a dispersion fitted on the train season (Poisson when it fits best)
// Every switch has to beat its "off" setting on BOTH halves of the test season to stay on.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSeason } from './fetch-gamelog.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(...a);
const SEASONS = process.argv.slice(2).map(Number).filter(Boolean);
if (!SEASONS.length) SEASONS.push(2025, 2026, 2027);
const TRAIN = SEASONS[0], TEST = SEASONS[1] || SEASONS[0], CUR = SEASONS[SEASONS.length - 1];

export const MODEL = {
  wPrior: 0.7,        // a game from last season counts this much in the rates
  rateHL: 80,         // games: half-life of the per-minute rates
  toiHL: 5,           // games: half-life of expected ice time
  toiPriorG: 1,       // last season's average ice time is worth this many games
  shrinkMin: 100,     // pseudo-minutes at his position's rate (shots, assists)
  shPseudo: 60,       // pseudo-shots at his position's shooting %
  opp: true,          // opponent's shots allowed (recency, shrunk to the league)
  oppHL: 15, oppPseudo: 8,
  goalie: true,       // tonight's goalie save % for goals / assists (else the opponent team's goals per shot)
  svPseudo: 500,      // pseudo-shots at the league save %
  ctx: [],            // stats scaled by tonight's total — tested: it fits 0 (the opponent + goalie already carry it)
  calib: ['pts'],     // stats whose probabilities get a cross-fitted slope (points ran a little under-confident)
  stats: {
    sog: { label: 'Shots on goal', floor: 1.5 }, goal: { label: 'Anytime goal', floor: 0 }, pts: { label: 'Points', floor: 0.3 },
  },
  minGames: 5,
};
const STATS = Object.keys(MODEL.stats);

// ------------------------------------------------------------------ data
const GL = {};
for (const S of SEASONS) GL[S] = await ensureSeason(S, log);
const names = {}; for (const S of SEASONS) Object.assign(names, GL[S].players);
const hist = new Map(), gHist = new Map(), teamGames = new Map(), LG = {};
for (const S of SEASONS) { let tsa = 0, tga = 0, n = 0, gsa = 0, gga = 0;
  for (const g of GL[S].games) { const t = Date.parse(g.d), sk = g.p.filter(r => r[2] !== 2), gk = g.p.filter(r => r[2] === 2);
    const sog = tm => sk.filter(r => r[1] === tm).reduce((a, r) => a + r[6], 0);
    for (const [tm, opp, gf, ga] of [[g.h, g.a, g.hs, g.as], [g.a, g.h, g.as, g.hs]]) { const k = S + '|' + tm; if (!teamGames.has(k)) teamGames.set(k, []);
      const st = gk.filter(r => r[1] === tm).sort((x, y) => y[3] - x[3])[0];   // starter = the team's goalie with the most ice time
      teamGames.get(k).push({ t, sa: sog(opp), ga, sf: sog(tm), gf, goalie: st ? st[0] : null }); tsa += sog(opp); tga += ga; n++; }
    for (const r of sk) { if (!hist.has(r[0])) hist.set(r[0], []); hist.get(r[0]).push({ S, t, team: r[1], kind: r[2], toi: r[3], g: r[4], a: r[5], sog: r[6], pp: r[7] }); }
    for (const r of gk) { if (!(r[3] >= 30)) continue; if (!gHist.has(r[0])) gHist.set(r[0], []); gHist.get(r[0]).push({ S, t, team: r[1], ga: r[4], sa: r[5] }); gsa += r[5]; gga += r[4]; } }
  LG[S] = { sa: tsa / n, ga: tga / n, sv: gsa ? (gsa - gga) / gsa : 0.9 }; }
const lgOf = S => LG[S - 1] || LG[S];   // last season's league averages (leak-free); the first season uses its own
const avgOU = {}; for (const S of SEASONS) { const xs = GL[S].games.map(g => g.ou).filter(x => x >= 4.5 && x <= 8.5); avgOU[S] = xs.length >= 100 ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }
// position priors (train season): shots + assists per minute, shooting %
const prior = {}; { const acc = {};
  for (const [, H] of hist) for (const h of H) if (h.S === TRAIN) { const a = acc[h.kind] || (acc[h.kind] = { toi: 0, g: 0, a: 0, sog: 0 }); a.toi += h.toi; a.g += h.g; a.a += h.a; a.sog += h.sog; }
  for (const [k, a] of Object.entries(acc)) prior[k] = { sog: a.sog / a.toi, a: a.a / a.toi, sh: a.g / a.sog }; }

// ------------------------------------------------------------------ model
function feat(pid, S, t, M = MODEL) {
  const all = hist.get(pid) || [], H = []; for (const h of all) if ((h.S === S && h.t < t) || h.S === S - 1) H.push(h);
  if (!H.length) return null;
  const cur = H.filter(h => h.S === S), nCur = cur.length, prev = H.length - nCur, kind = H[H.length - 1].kind, pr = prior[kind] || prior[0];
  let wt = 0, st = 0, smin = 0; const ss = { g: 0, a: 0, sog: 0 };
  for (let k = 0; k < H.length; k++) { const h = H[H.length - 1 - k], base = h.S === S ? 1 : M.wPrior;
    const a = h.S === S ? Math.pow(0.5, k / M.toiHL) : Math.pow(0.5, nCur / M.toiHL) * M.toiPriorG / prev; wt += a; st += a * h.toi;
    const b = base * Math.pow(0.5, k / M.rateHL); smin += b * h.toi; ss.g += b * h.g; ss.a += b * h.a; ss.sog += b * h.sog; }
  const sog = (ss.sog + M.shrinkMin * pr.sog) / (smin + M.shrinkMin), sh = (ss.g + M.shPseudo * pr.sh) / (ss.sog + M.shPseudo), a = (ss.a + M.shrinkMin * pr.a) / (smin + M.shrinkMin);
  const src = nCur >= 5 ? cur : H, avg = {}; for (const s of ['g', 'a', 'sog']) avg[s] = src.reduce((x, h) => x + h[s], 0) / src.length; avg.pts = avg.g + avg.a;
  return { g: H.length, gc: nCur, kind, toi: st / wt, r: { sog, g: sog * sh, a }, sh, avg, toiAvg: src.reduce((x, h) => x + h.toi, 0) / src.length };
}
// what the opponent allows, before time t (this season, recency-weighted, shrunk to the league)
function teamDef(team, S, t, M = MODEL) { const G = teamGames.get(S + '|' + team) || [], L = lgOf(S); let w = 0, sa = 0, ga = 0, k = 0;
  for (let i = G.length - 1; i >= 0; i--) { if (G[i].t >= t) continue; const b = Math.pow(0.5, k++ / M.oppHL); w += b; sa += b * G[i].sa; ga += b * G[i].ga; }
  return { sa: (sa + M.oppPseudo * L.sa) / (w + M.oppPseudo), ga: (ga + M.oppPseudo * L.ga) / (w + M.oppPseudo) }; }
// a goalie's save %, before time t (this season + last at wPrior), shrunk to the league
function goalieSv(gid, S, t, M = MODEL) { if (!gid) return null; const L = lgOf(S); let sa = 0, sv = 0;
  for (const h of (gHist.get(gid) || [])) { if (!((h.S === S && h.t < t) || h.S === S - 1)) continue; const w = h.S === S ? 1 : M.wPrior; sa += w * h.sa; sv += w * (h.sa - h.ga); }
  return (sv + M.svPseudo * L.sv) / (sa + M.svPseudo); }
// the projection for one game. P = fitted {gs, gv, a:{stat}, ouAvg, lg}; the app's projection is a copy of this
export function project(F, D, sv, ou, P, M = MODEL) {
  const L = P.lg; let fS = 1, fG = 1;
  if (M.opp && D) fS = Math.pow(D.sa / L.sa, P.gs);
  if (M.goalie && sv != null) fG = Math.pow((1 - sv) / (1 - L.sv), P.gv);
  else if (D) fG = Math.pow((D.ga / D.sa) / (L.ga / L.sa), P.gv);
  const cx = s => (M.ctx.includes(s) && ou >= 4.5 && P.ouAvg) ? Math.exp(P.a[s] * (ou - P.ouAvg) / P.ouAvg) : 1;
  const g = F.toi * F.r.g * fS * fG, a = F.toi * F.r.a * fS * fG;
  return { sog: F.toi * F.r.sog * fS * cx('sog'), goal: g * cx('goal'), pts: (g + a) * cx('pts') };
}
// negative binomial (size r; Poisson when r is huge): P(X > L). The app's pOver() is a copy — keep them identical.
export function pOver(mu, r, L) {
  if (!(mu > 0)) return 0; const k = Math.floor(L); if (k < 0) return 1;
  const pois = !(r < 1e6); let p = pois ? Math.exp(-mu) : Math.pow(r / (r + mu), r), c = p;
  for (let i = 0; i < k; i++) { p *= pois ? mu / (i + 1) : (i + r) / (i + 1) * mu / (r + mu); c += p; }
  return Math.min(1, Math.max(0, 1 - c));
}
const squeeze = (p, b) => b === 1 ? p : 1 / (1 + Math.exp(-b * Math.log(p / (1 - p))));
const actOf = (h, s) => s === 'sog' ? h.sog : s === 'goal' ? h.g : h.g + h.a;
const lineOf = (s, F) => s === 'sog' ? Math.floor(F.avg.sog) + 0.5 : 0.5;   // a book-like line: his season average on the half shot; 0.5 for goals / points

// one row per skater who PLAYED in each game of a season, with everything the model may know beforehand
function rowsOf(S, M = MODEL) {
  const out = [], games = GL[S].games;
  games.forEach((g, gi) => { const t = Date.parse(g.d);
    for (const [tm, opp] of [[g.h, g.a], [g.a, g.h]]) {
      const oppGames = teamGames.get(S + '|' + opp) || [], og = (oppGames.find(x => x.t === t) || {}).goalie;   // tonight's starter is public before puck drop
      const D = teamDef(opp, S, t, M), sv = goalieSv(og, S, t, M);
      for (const r of g.p) { if (r[1] !== tm || r[2] === 2) continue; const F = feat(r[0], S, t, M); if (!F || F.g < M.minGames) continue;
        out.push({ gi, half: gi < games.length / 2 ? 1 : 2, pid: r[0], F, D, sv, ou: g.ou, act: { sog: r[6], goal: r[4], pts: r[4] + r[5] } }); } } });
  return out;
}
const R0 = { sog: 1e9, goal: 1e9, pts: 1e9 };
const PH = (P, x) => P.aH ? { ...P, a: P.aH[x.half] } : P;   // the test season's total sensitivity, learned on its OTHER half
const brierAt = (rows, s, P, M, half) => { let e = 0, n = 0; for (const x of rows) { if (half && x.half !== half) continue; if (x.F.avg[s === 'goal' ? 'g' : s] < M.stats[s].floor) continue;
  const mu = project(x.F, x.D, x.sv, x.ou, PH(P, x), M)[s], L = lineOf(s, x.F), p = Math.min(0.995, Math.max(0.005, pOver(mu, P.r[s], L))), o = x.act[s] > L ? 1 : 0; e += (p - o) ** 2; n++; } return n ? e / n : 1; };
// fit on a season's rows: dispersion per stat, opponent shots exponent, goalie exponent, total sensitivity
function fit(rows, S, M = MODEL, ctxRows) {
  const P = { gs: 0, gv: 0, a: { sog: 0, goal: 0, pts: 0 }, r: { ...R0 }, ouAvg: avgOU[S] || avgOU[TRAIN], lg: lgOf(S) };
  const pick = (vals, set, obj) => { let best = null; for (const v of vals) { set(v); const e = obj(); if (!best || e < best.e) best = { v, e }; } set(best.v); };
  for (let pass = 0; pass < 2; pass++) {
    for (const s of STATS) pick([1, 2, 3, 5, 8, 15, 30, 1e9], v => { P.r[s] = v; }, () => brierAt(rows, s, P, M));
    if (M.opp) pick([0, 0.5, 1, 1.5], v => { P.gs = v; }, () => brierAt(rows, 'sog', P, M) + brierAt(rows, 'goal', P, M));
    pick([0, 0.5, 1, 1.5, 2], v => { P.gv = v; }, () => brierAt(rows, 'goal', P, M) + brierAt(rows, 'pts', P, M));
    const CR = (ctxRows || rows).filter(x => x.ou >= 4.5);
    if (CR.length > 2000) for (const s of M.ctx) pick([0, 0.5, 1, 1.5, 2, 3], v => { P.a[s] = v; }, () => brierAt(CR, s, P, M));
  }
  return P;
}
// score one configuration on the test season: Brier at the book-like line per half, vs a plain season average (Poisson)
function score(M, P, rows) {
  const out = {};
  for (const s of STATS) {
    const pop = rows.filter(x => x.F.avg[s === 'goal' ? 'g' : s] >= M.stats[s].floor).map(x => { const L = lineOf(s, x.F), mu = project(x.F, x.D, x.sv, x.ou, PH(P, x), M)[s];
      return { x, mu, L, p0: Math.min(0.995, Math.max(0.005, pOver(mu, P.r[s], L))), pn: Math.min(0.995, Math.max(0.005, pOver(x.F.avg[s === 'goal' ? 'g' : s], 1e9, L))), o: x.act[s] > L ? 1 : 0, y: x.act[s] }; });
    const slopeOf = X => { let best = null; for (let b = 0.5; b <= 1.501; b += 0.05) { let e = 0; for (const z of X) e += (squeeze(z.p0, b) - z.o) ** 2; if (!best || e < best.e) best = { b: +b.toFixed(2), e }; } return best.b; };
    const slope = M.calib.includes(s) ? { 1: slopeOf(pop.filter(z => z.x.half === 2)), 2: slopeOf(pop.filter(z => z.x.half === 1)), all: slopeOf(pop) } : { 1: 1, 2: 1, all: 1 };
    const H = { 1: { b: 0, bn: 0, n: 0, ae: 0, aen: 0 }, 2: { b: 0, bn: 0, n: 0, ae: 0, aen: 0 } }, cal = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
    for (const z of pop) { const h = H[z.x.half], p = squeeze(z.p0, slope[z.x.half]); h.b += (p - z.o) ** 2; h.bn += (z.pn - z.o) ** 2; h.n++; h.ae += Math.abs(z.mu - z.y); h.aen += Math.abs(z.x.F.avg[s === 'goal' ? 'g' : s] - z.y);
      const c = cal[Math.min(9, Math.floor(p * 10))]; c.n++; c.p += p; c.y += z.o; }
    out[s] = { n: pop.length, b1: H[1].b / H[1].n, b2: H[2].b / H[2].n, nb1: H[1].bn / H[1].n, nb2: H[2].bn / H[2].n, mae1: H[1].ae / H[1].n, mae2: H[2].ae / H[2].n, nmae1: H[1].aen / H[1].n,
      slope: slope.all, cal: cal.filter(c => c.n >= 150).map(c => ({ pred: +(c.p / c.n).toFixed(3), actual: +(c.y / c.n).toFixed(3), n: c.n })) };
  }
  return out;
}

// ------------------------------------------------------------------ backtest
log(`\n== backtest: train ${TRAIN} (${GL[TRAIN].games.length} games) -> test ${TEST} (${GL[TEST].games.length} games); totals on file ${GL[TRAIN].games.filter(g => g.ou).length}/${GL[TEST].games.filter(g => g.ou).length}; league shots ${LG[TRAIN].sa.toFixed(1)} / goals ${LG[TRAIN].ga.toFixed(2)} / sv ${LG[TRAIN].sv.toFixed(3)}`);
const trainRows = rowsOf(TRAIN), testRows = rowsOf(TEST);
// the train season (2024-25) has no Vegas totals on ESPN, so the total sensitivity is cross-fitted inside the test season
// (each half scored with what the other half learned) and shipped from the whole test season — the NBA app's approach
const fitCtx = (rows, P, M) => { const a = { sog: 0, goal: 0, pts: 0 }, R = rows.filter(x => x.ou >= 4.5); if (R.length < 2000) return a;
  for (const s of M.ctx) { let best = null; for (const v of [0, 0.5, 1, 1.5, 2, 3]) { const e = brierAt(R, s, { ...P, aH: null, a: { ...a, [s]: v } }, M); if (!best || e < best.e) best = { v, e }; } a[s] = best.v; } return a; };
const fitFor = (M, tr, te) => { const P = fit(tr || trainRows, TRAIN, M, null); P.ouAvg = avgOU[TEST] || P.ouAvg; P.lg = lgOf(TEST);
  if (!(avgOU[TRAIN]) && M.ctx.length) { const T = te || testRows; P.aH = { 1: fitCtx(T.filter(x => x.half === 2), P, M), 2: fitCtx(T.filter(x => x.half === 1), P, M) }; P.a = fitCtx(T, P, M); }
  return P; };
const P = fitFor(MODEL);
log(`   fitted on ${TRAIN}${P.aH ? ' (total sensitivity cross-fitted on ' + TEST + ': halves ' + JSON.stringify(P.aH) + ')' : ''}: dispersion ${STATS.map(s => s + ' ' + (P.r[s] >= 1e6 ? 'Poisson' : P.r[s])).join(', ')} · opponent shots ^${P.gs} · goalie ^${P.gv} · total ${STATS.map(s => s + ' ' + P.a[s]).join(', ')}`);
const Rs = score(MODEL, P, testRows), f4 = x => x.toFixed(4), f2 = x => x.toFixed(2);
for (const s of STATS) log(`   ${s.padEnd(4)} n=${Rs[s].n}  Brier ${f4(Rs[s].b1)}/${f4(Rs[s].b2)} vs season-average ${f4(Rs[s].nb1)}/${f4(Rs[s].nb2)}   MAE ${f2(Rs[s].mae1)} vs ${f2(Rs[s].nmae1)}   cal ${Rs[s].cal.map(c => `${(c.pred * 100).toFixed(0)}->${(c.actual * 100).toFixed(0)}%`).join(' ')}`);
if (process.env.BT_EXPERIMENTS) {
  log('\n== switches (Brier half1/half2, lower is better; a switch stays only if it wins BOTH halves) ==');
  const run = (name, M) => { const tr = rowsOf(TRAIN, M), te = rowsOf(TEST, M), P2 = fitFor(M, tr, te), r = score(M, P2, te);
    log(`   ${name.padEnd(26)} ` + STATS.map(s => `${s} ${f4(r[s].b1)}/${f4(r[s].b2)}`).join('  ') + `  [gs ${P2.gs} gv ${P2.gv}]`); };
  run('shipped', MODEL);
  run('opponent OFF', { ...MODEL, opp: false }); run('goalie OFF (team ga/sa)', { ...MODEL, goalie: false });
  run('total context: goal+pts', { ...MODEL, ctx: ['goal', 'pts'] });
  run('calibration: none', { ...MODEL, calib: [] }); run('calibration: all', { ...MODEL, calib: STATS });
  for (const hl of [40, 120, 200]) run(`rate half-life ${hl}`, { ...MODEL, rateHL: hl });
  for (const hl of [3, 10]) run(`toi half-life ${hl}`, { ...MODEL, toiHL: hl });
  for (const k of [0, 50, 200, 300]) run(`shrink ${k} min`, { ...MODEL, shrinkMin: k });
  for (const k of [20, 150, 300]) run(`shooting% pseudo ${k}`, { ...MODEL, shPseudo: k });
  for (const w of [0.4, 1]) run(`last season x${w}`, { ...MODEL, wPrior: w }); for (const g of [3, 6]) run(`toi prior worth ${g} g`, { ...MODEL, toiPriorG: g });
  for (const k of [3, 20]) run(`opponent pseudo ${k}`, { ...MODEL, oppPseudo: k });
  for (const k of [200, 1500]) run(`goalie pseudo ${k}`, { ...MODEL, svPseudo: k });
}
export const BACKTEST = { train: TRAIN, test: TEST, stats: Object.fromEntries(STATS.map(s => [s, { n: Rs[s].n, brier: [+f4(Rs[s].b1), +f4(Rs[s].b2)], naive: [+f4(Rs[s].nb1), +f4(Rs[s].nb2)],
  mae: +f2(Rs[s].mae1), naiveMae: +f2(Rs[s].nmae1), cal: Rs[s].cal, beatsNaive: Rs[s].b1 < Rs[s].nb1 && Rs[s].b2 < Rs[s].nb2 }])) };
if (process.env.SKIP_LIVE) process.exit(0);

// ------------------------------------------------------------------ live snapshot: teams, rosters, each player's inputs
const getJson = async url => { for (let t = 1; ; t++) { try { const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (!r.ok) throw new Error('http ' + r.status); return await r.json(); } catch (e) { if (t >= 4) throw e; await new Promise(r => setTimeout(r, 700 * t)); } } };
const tj = await getJson('https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/teams?limit=40');
const espnTeams = tj.sports[0].leagues[0].teams.map(x => x.team);
const teams = {}, rosters = {}, defense = {}, now = Date.now() + 864e5; const missing = [];
for (const t of espnTeams) {
  const ab = t.abbreviation;
  teams[ab] = { id: String(t.id), abbr: ab, name: t.displayName, short: t.shortDisplayName || t.name, color: '#' + (t.color || '444444'), alt: '#' + (t.alternateColor || '888888'), logo: (t.logos && t.logos[0] && t.logos[0].href) || '' };
  let rj; try { rj = await getJson(`https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/teams/${t.id}/roster`); } catch (e) { missing.push(ab); continue; }
  const athletes = (rj.athletes || []).flatMap(x => x.items ? x.items : [x]), list = [];
  const G = teamGames.get(CUR + '|' + ab) || [], recent = G.slice(-10).map(x => x.goalie);
  for (const a of athletes) { const id = String(a.id), pos = (a.position && a.position.abbreviation) || ''; if (!names[id]) names[id] = [a.displayName || a.fullName, pos];
    const nm = a.displayName || a.fullName;
    if (pos === 'G') { const sv = goalieSv(id, CUR, now), H = (gHist.get(id) || []).filter(h => h.S === CUR);
      list.push({ id, name: nm, pos, kind: 2, sv: +sv.toFixed(4), gs: H.length, rs: recent.filter(x => x === id).length }); continue; }
    const F = feat(id, CUR, now);
    if (!F) { list.push({ id, name: nm, pos, kind: pos === 'D' ? 1 : 0, g: 0 }); continue; }
    list.push({ id, name: nm, pos, kind: F.kind, g: F.g, gc: F.gc, toi: +F.toi.toFixed(2), r: { sog: +F.r.sog.toFixed(5), g: +F.r.g.toFixed(5), a: +F.r.a.toFixed(5) },
      avg: { sog: +F.avg.sog.toFixed(2), g: +F.avg.g.toFixed(3), a: +F.avg.a.toFixed(3), pts: +F.avg.pts.toFixed(3) } }); }
  rosters[ab] = list.sort((x, y) => (x.kind === 2) - (y.kind === 2) || (y.toi || 0) - (x.toi || 0));
  const D = teamDef(ab, CUR, now); defense[ab] = { sa: +D.sa.toFixed(2), ga: +D.ga.toFixed(3) };
}
if (missing.length) throw new Error('rosters missing for ' + missing.join(', ') + ' — nothing written');
const PL = { ...P, lg: lgOf(CUR), ouAvg: avgOU[CUR] || avgOU[TEST] || P.ouAvg };
const snapshot = { builtAt: new Date().toISOString(), seasons: SEASONS, season: CUR, teams, teamList: Object.keys(teams).sort(), rosters, defense,
  model: { opp: MODEL.opp, goalie: MODEL.goalie, ctx: MODEL.ctx, calib: MODEL.calib, minGames: MODEL.minGames, stats: MODEL.stats,
    gs: PL.gs, gv: PL.gv, a: PL.a, r: PL.r, ouAvg: +(PL.ouAvg || 6).toFixed(2), lg: { sa: +PL.lg.sa.toFixed(2), ga: +PL.lg.ga.toFixed(3), sv: +PL.lg.sv.toFixed(4) },
    slope: Object.fromEntries(STATS.map(s => [s, Rs[s].slope])), backtest: BACKTEST.stats, train: TRAIN, test: TEST },
  marketAnchor: (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'market_anchor.json'), 'utf8')).app || null; } catch { return null; } })() };
const snapFile = path.join(__dirname, 'nhl-snapshot.json'); fs.writeFileSync(snapFile, JSON.stringify(snapshot));
log(`\n  wrote ${path.basename(snapFile)} (${(fs.statSync(snapFile).size / 1e6).toFixed(2)} MB): ${Object.keys(teams).length} teams, ${Object.values(rosters).reduce((a, r) => a + r.length, 0)} players`);
const tplFile = path.join(__dirname, 'nhl-prop-predictor.template.html');
if (fs.existsSync(tplFile)) { const html = fs.readFileSync(tplFile, 'utf8').replace('/*__SNAPSHOT__*/', () => 'window.__SNAPSHOT__ = ' + JSON.stringify(snapshot) + ';');
  fs.writeFileSync(path.join(__dirname, 'nhl-prop-predictor.html'), html); log(`  wrote nhl-prop-predictor.html (${(html.length / 1e6).toFixed(2)} MB)`); }
log('=== done ===');
