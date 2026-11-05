#!/usr/bin/env node
// 🤖 CLOSING PRICES for the NBA + NHL apps (user, 2026-11-04: "yes build option 1" — only 19 of 178 NHL background bets
// had a closing price, because the apps take one only while a page is open in the last minutes before the start).
// Run by .github/workflows/closes.yml. Reads both apps' files in the ☁ Sync gist (nhl-sync.json / nba-sync.json: bets +
// shadow = the background bets) and keeps, for each prop bet without a close, the bet's own book's price at the bet's own
// line and side — the apps' background rule (closeView with an exact line, no estimate). Two ways to get it:
//  • LIVE: a game starting within WINDOW minutes -> one pull of its markets now at your five books (1 credit per market).
//  • CATCH-UP (2026-11-04 test: GitHub ran this account's timed jobs 3-10 HOURS late for 5 weeks, so the live pull
//    almost never lands in time): a game that started 15+ min ago, within DAYS days -> The Odds API's price history at
//    ~2 min before its start (10 credits per market + 1 per day's game list; at most CAP credits a run).
// Each game+market is pulled once (`pulled`). Writes <sport>-closes.json {closes: {betId: {o, t, m, h?}}, moved: {betId:
// {l, o, t, m, h?}}, pulled: {game|start|market: t}, spent: {day: credits}} in the same gist (m = minutes before the start,
// h = from the history; moved = the book changed the line, its nearest line's price, for a later estimate); the apps copy
// `closes` into the bets when they sync (applyBotCloses). The bot never writes the apps' own files, so it can't race them.
// Env: ODDS_API_KEY + SYNC_TOKEN (gist scope) are repo secrets; optional SYNC_GIST_ID, CLOSES_MODE=dry (no pulls, no
// writes), CLOSES_WINDOW_MIN (30), CLOSES_HIST_DAYS (catch-up look-back, 0 = off), CLOSES_HIST_CAP (800 credits a run),
// CLOSES_TIME_MIN (6: the catch-up pauses after this many minutes so the run saves before the job's time limit),
// CLOSES_RESERVE (1000 credits), CLOSES_NOW (ISO time, tests), CLOSES_GIST_FILE (a local JSON {files: {name: {content}}}
// used instead of GitHub, tests).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ODDS = 'https://api.the-odds-api.com/v4/sports', HIST = 'https://api.the-odds-api.com/v4/historical/sports', GH = 'https://api.github.com';
const BOOKS = 'fanduel,draftkings,betmgm,williamhill_us,fanatics';
const envNum = (k, d) => { const v = process.env[k]; return v != null && v !== '' && !isNaN(+v) ? +v : d; };
const KEY = process.env.ODDS_API_KEY || '', TOKEN = process.env.SYNC_TOKEN || '', MODE = process.env.CLOSES_MODE || 'live';
const WINDOW = envNum('CLOSES_WINDOW_MIN', 30) * 60e3, RESERVE = envNum('CLOSES_RESERVE', 1000);
const DAYS = envNum('CLOSES_HIST_DAYS', 0), CAP = envNum('CLOSES_HIST_CAP', 800), LAG = 15 * 60e3, BUDGET = envNum('CLOSES_TIME_MIN', 6) * 60e3, T0 = Date.now();
const NOW = process.env.CLOSES_NOW ? Date.parse(process.env.CLOSES_NOW) : Date.now(), MOCK = process.env.CLOSES_GIST_FILE || '';
const SPORTS = [
  { id: 'nhl', api: 'icehockey_nhl', file: 'nhl-sync.json', out: 'nhl-closes.json', snap: path.join(DIR, '..', 'nhl-snapshot.json'),
    oa: { sog: 'player_shots_on_goal', pts: 'player_points' }, skip: p => p.kind === 2 },
  { id: 'nba', api: 'basketball_nba', file: 'nba-sync.json', out: 'nba-closes.json', snap: 'https://raw.githubusercontent.com/popcawn/nba-prop-predictor/main/nba-snapshot.json',
    oa: { pts: 'player_points', reb: 'player_rebounds', ast: 'player_assists', tpm: 'player_threes', pra: 'player_points_rebounds_assists' }, skip: () => false },
];

// the apps' own name / team / player matching (normName, nick, abbrByName, gamePlayers, matchPlayer)
const normName = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z]/g, '');
const nick = n => normName(String(n || '').split(' ').pop());
const fmtAm = v => (v > 0 ? '+' : '') + v;
const iso = t => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const abbrByName = (S, name) => S.teamList.find(a => normName(S.teams[a].name) === normName(name)) || S.teamList.find(a => nick(S.teams[a].name) === nick(name)) || null;
const pl = (key, name) => { const t = String(name).replace(/\b(Jr|Sr|II|III|IV)\b\.?/g, '').trim().split(/\s+/); return { key, nn: normName(name), last: normName(t[t.length - 1]), fi: normName(t[0]).slice(0, 1) }; };
function gamePlayers(S, away, home, skip) {
  const out = [];
  for (const ab of [away, home]) for (const p of (S.rosters[ab] || [])) { if (skip(p)) continue; out.push(pl(ab + '|' + p.id, p.name)); }
  return out;
}
// both teams' roster from today's snapshot + the bets' own players (a player traded since the game is on another roster now)
function players(S, x, sp) {
  const [away, home] = x.game.split('@'), a = gamePlayers(S, away, home, sp.skip), seen = new Set(a.map(p => p.key));
  for (const r of x.L) if (r.player && !seen.has(r.key)) { seen.add(r.key); a.push(pl(r.key, r.player)); }
  return a;
}
function matchPlayer(name, players) {
  const n = normName(name), p = players.find(x => x.nn === n); if (p) return p;
  const t = String(name).replace(/\b(Jr|Sr|II|III|IV)\b\.?/g, '').trim().split(/\s+/), last = normName(t[t.length - 1]), fi = normName(t[0]).slice(0, 1), c = players.filter(x => x.last === last && x.fi === fi);
  return c.length === 1 ? c[0] : null;
}
// an event-odds body -> mine[stat|key][book] = [{line, O, U}] (parseBoard's board.mine: your books' over/under per line)
function boardMine(j, players, oa) {
  const rev = Object.fromEntries(Object.entries(oa).map(([s, m]) => [m, s])), mine = {};
  for (const bk of (j.bookmakers || [])) for (const m of (bk.markets || [])) { const s = rev[m.key]; if (!s) continue; const pairs = {};
    for (const o of (m.outcomes || [])) { if (!o.description || o.point == null || (o.name !== 'Over' && o.name !== 'Under')) continue;
      const k = o.description + '|' + o.point; (pairs[k] = pairs[k] || { name: o.description, line: +o.point })[o.name === 'Over' ? 'O' : 'U'] = o; }
    for (const q of Object.values(pairs)) { if (!q.O) continue; const p = matchPlayer(q.name, players); if (!p) continue; const byBook = mine[s + '|' + p.key] = mine[s + '|' + p.key] || {};
      (byBook[bk.key] = byBook[bk.key] || []).push({ line: q.line, O: fmtAm(q.O.price), U: q.U ? fmtAm(q.U.price) : null }); } }
  return mine;
}
// exact line -> closes (the apps copy it in); the book moved the line -> moved {l, o} (kept for a later estimate; the apps ignore it)
function keep(C, L, mine, mins, h) {
  let n = 0, mv = 0; const tag = h ? { h: 1 } : {};
  for (const r of L) { const [, s, side, l] = r.market.split('|'), arr = (mine[s + '|' + r.key] || {})[r.book || 'fanduel'] || [], o = arr.find(e => e.line === +l), q = o && (side === 'O' ? o.O : o.U);
    if (q) { C.closes[r.id] = Object.assign({ o: q, t: NOW, m: mins }, tag); delete C.moved[r.id]; n++; continue; }
    const near = arr.slice().sort((a, b) => Math.abs(a.line - l) - Math.abs(b.line - l))[0], nq = near && (side === 'O' ? near.O : near.U);
    if (nq) { C.moved[r.id] = Object.assign({ l: near.line, o: nq, t: NOW, m: mins }, tag); mv++; } }
  return { n, mv };
}
const findEv = (events, S, x) => { const [away, home] = x.game.split('@');
  return events.find(e => abbrByName(S, e.away_team) === away && abbrByName(S, e.home_team) === home && Math.abs(Date.parse(e.commence_time) - x.k0) < 12 * 3600e3); };

const hide = s => String(s).replace(/apiKey=[^&]+/g, 'apiKey=***');
async function getJson(url) { const r = await fetch(url, { signal: AbortSignal.timeout(30e3) }); if (!r.ok) { const e = new Error(`${r.status} ${hide(url)}`); e.status = r.status; throw e; } return { j: await r.json(), h: r.headers }; }
async function gh(p, opt = {}) {
  const r = await fetch(GH + p, { method: opt.method || 'GET', body: opt.body, headers: Object.assign({ Authorization: 'Bearer ' + TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'closes-bot' }, opt.body ? { 'Content-Type': 'application/json' } : {}) });
  if (!r.ok) { const e = new Error('GitHub ' + r.status + ' ' + p); e.status = r.status; throw e; } return r.json();
}
async function loadGist() {
  if (MOCK) return { id: 'mock', files: JSON.parse(fs.readFileSync(MOCK, 'utf8')).files };
  let id = process.env.SYNC_GIST_ID || '';
  for (let page = 1; page <= 5 && !id; page++) { const list = await gh(`/gists?per_page=100&page=${page}`); const hit = list.find(x => x.files && x.files['nfl-td-sync.json']); if (hit) id = hit.id; if (list.length < 100) break; }
  if (!id) throw new Error('no ☁ Sync gist (nfl-td-sync.json) on this token\'s account');
  return { id, files: (await gh('/gists/' + id)).files };
}
async function fileJson(G, name) {
  const f = G.files && G.files[name]; if (!f) return null; let txt = f.content;
  if (f.truncated && f.raw_url) txt = await (await fetch(f.raw_url)).text();
  try { return JSON.parse(txt); } catch (e) { return null; }
}
async function saveFiles(G, files) {
  if (MOCK) { const m = JSON.parse(fs.readFileSync(MOCK, 'utf8')); for (const [k, v] of Object.entries(files)) m.files[k] = { content: v }; fs.writeFileSync(MOCK, JSON.stringify(m)); return; }
  await gh('/gists/' + G.id, { method: 'PATCH', body: JSON.stringify({ files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { content: v }])) }) });
}

if (!MOCK && !TOKEN) { console.log('::warning::SYNC_TOKEN secret is not set (repo Settings → Secrets and variables → Actions) — nothing to do'); process.exit(0); }
if (MODE !== 'dry' && !KEY) { console.log('::warning::ODDS_API_KEY secret is not set (repo Settings → Secrets and variables → Actions) — nothing to do'); process.exit(0); }
const K = encodeURIComponent(KEY);
let left = null, spent = 0, histSpent = 0, stop = false, capped = false;
const credits = h => { left = +h.get('x-requests-remaining'); return +h.get('x-requests-last') || 0; };
// one-line run summary as a GitHub notice: annotations of a public repo can be read without a login (the logs can't)
const notes = [];
const G = await loadGist(), write = {};
for (const sp of SPORTS) {
  const sync = await fileJson(G, sp.file);
  if (!sync) { console.log(`${sp.id}: no ${sp.file} in the gist yet — skipped`); continue; }
  const prev = (await fileJson(G, sp.out)) || {};
  const C = { app: 'closes-bot', v: 2, closes: prev.closes || {}, moved: prev.moved || {}, pulled: prev.pulled || {}, spent: prev.spent || {} };
  const before = JSON.stringify([C.closes, C.moved, C.pulled]), spent0 = spent;
  for (const M of [C.closes, C.moved]) for (const [k, v] of Object.entries(M)) if (NOW - (v.t || 0) > 60 * 864e5) delete M[k];
  for (const [k, t] of Object.entries(C.pulled)) if (NOW - t > 45 * 864e5) delete C.pulled[k];
  for (const d of Object.keys(C.spent)) if (NOW - Date.parse(d) > 60 * 864e5) delete C.spent[d];
  const mk = r => sp.oa[r.market.split('|')[1]];
  const all = [...(sync.shadow || []), ...(sync.bets || [])].filter(r => r && r.id && !r.closeOdds && !C.closes[r.id] && r.key && r.game
    && String(r.market || '').startsWith('P|') && mk(r) && Date.parse(r.ko || '') > 0);
  // game+start -> its bets whose market hasn't been pulled yet, and those markets
  const group = list => { const due = new Map();
    for (const r of list) { const k0 = Date.parse(r.ko), gk = r.game + '|' + iso(k0), m = mk(r); if (C.pulled[gk + '|' + m]) continue;
      const x = due.get(gk) || due.set(gk, { gk, game: r.game, k0, L: [], mk: new Set() }).get(gk); x.L.push(r); x.mk.add(m); }
    return due; };
  const live = group(all.filter(r => { const k0 = Date.parse(r.ko); return r.result === 'pending' && k0 > NOW && k0 - NOW <= WINDOW; }));
  const hist = group(DAYS > 0 ? all.filter(r => { const k0 = Date.parse(r.ko); return r.result !== 'push' && !C.moved[r.id] && k0 <= NOW - LAG && NOW - k0 <= DAYS * 864e5; }) : []);
  console.log(`${sp.id}: ${all.length} bet(s) without a close · ${live.size} game(s) starting within ${WINDOW / 60e3} min · ${hist.size} started game(s) to catch up (last ${DAYS} day(s))`);
  notes.push(`${sp.id} ${live.size} due` + (DAYS > 0 ? `, ${hist.size} to catch up` : ''));
  const S = (live.size || hist.size) ? (sp.snap.startsWith('http') ? (await getJson(sp.snap)).j : JSON.parse(fs.readFileSync(sp.snap, 'utf8'))) : null;

  // LIVE: the game starts within the window -> today's price, 1 credit per market
  if (live.size && !stop) {
    const events = MODE === 'dry' ? [] : (await getJson(`${ODDS}/${sp.api}/events?apiKey=${K}`)).j;
    for (const x of live.values()) {
      const M = [...x.mk];
      if (MODE === 'dry') { console.log(`  would pull ${x.game} now (${M.join(', ')}) for ${x.L.length} bet(s): ${M.length} credit(s)`); continue; }
      if (left != null && left - M.length < RESERVE) { console.log(`  stopped: ${left} credits left, reserve ${RESERVE}`); stop = true; break; }
      const ev = findEv(events, S, x);
      if (!ev) { console.log(`  ${x.game}: not on The Odds API's board yet`); continue; }
      const k1 = Date.parse(ev.commence_time); if (k1 <= NOW) { console.log(`  ${x.game}: already started — the catch-up takes it from the price history`); continue; }
      let res;
      try { res = await getJson(`${ODDS}/${sp.api}/events/${ev.id}/odds?apiKey=${K}&bookmakers=${BOOKS}&markets=${M.join(',')}&oddsFormat=american`); }
      catch (e) { console.log(`  ${x.game}: pull failed (${e.message}) — tried again next run`); if (e.status === 401 || e.status === 429) { stop = true; break; } continue; }
      spent += credits(res.h) || M.length;
      const mins = Math.round((k1 - NOW) / 60e3), { n, mv } = keep(C, x.L, boardMine(res.j, players(S, x, sp), sp.oa), mins, false);
      for (const m of M) C.pulled[x.gk + '|' + m] = NOW;
      console.log(`  ${x.game}: ${n} of ${x.L.length} bet(s) got a close${mv ? `, ${mv} line(s) moved` : ''} (${M.length} credit(s), ${mins} min before the start)`);
      notes.push(`${x.game} ${n}/${x.L.length} closed${mv ? ` ${mv} moved` : ''} at -${mins}m`);
    }
  }

  // CATCH-UP: the game started -> the price history ~2 min before its start, 10 credits per market + 1 per day's game list
  if (hist.size && !stop && !capped) {
    const byDay = new Map(); let hg = 0, hn = 0, hb = 0, hmv = 0, est = 0;
    for (const x of hist.values()) { const d = iso(x.k0 - 5 * 3600e3).slice(0, 10); (byDay.get(d) || byDay.set(d, []).get(d)).push(x); }
    for (const [d, xs] of [...byDay].sort()) {
      if (stop || capped) break;
      if (MODE === 'dry') { est += 1; for (const x of xs) { est += 10 * x.mk.size; console.log(`  would catch up ${x.game} (${d}: ${[...x.mk].join(', ')}) for ${x.L.length} bet(s): ${10 * x.mk.size} credits`); } continue; }
      if (histSpent + 11 > CAP) { console.log(`  catch-up paused at the ${CAP}-credit cap for one run — the rest next run`); capped = 'credit cap'; break; }
      if (Date.now() - T0 > BUDGET) { console.log(`  catch-up paused after ${BUDGET / 60e3} min (the job's time limit) — the rest next run`); capped = 'time limit'; break; }
      let evs;
      try { const r = await getJson(`${HIST}/${sp.api}/events?apiKey=${K}&date=${iso(Math.min(...xs.map(x => x.k0)) - 30 * 60e3)}`); evs = (r.j && r.j.data) || []; const c = credits(r.h); spent += c; histSpent += c; }
      catch (e) { console.log(`  ${d}: the history's game list failed (${e.message}) — tried again next run`); if (e.status === 401 || e.status === 429) stop = true; continue; }
      for (const x of xs) {
        const M = [...x.mk], cost = 10 * M.length;
        if (histSpent + cost > CAP) { console.log(`  catch-up paused at the ${CAP}-credit cap for one run — the rest next run`); capped = 'credit cap'; break; }
        if (Date.now() - T0 > BUDGET) { console.log(`  catch-up paused after ${BUDGET / 60e3} min (the job's time limit) — the rest next run`); capped = 'time limit'; break; }
        if (left != null && left - cost < RESERVE) { console.log(`  stopped: ${left} credits left, reserve ${RESERVE}`); stop = true; break; }
        const ev = findEv(evs, S, x);
        if (!ev) { console.log(`  ${x.game} (${d}): not in the price history — skipped`); for (const m of M) C.pulled[x.gk + '|' + m] = NOW; continue; }
        const k1 = Date.parse(ev.commence_time);
        let res;
        try { res = await getJson(`${HIST}/${sp.api}/events/${ev.id}/odds?apiKey=${K}&date=${iso(k1 - 2 * 60e3)}&bookmakers=${BOOKS}&markets=${M.join(',')}&oddsFormat=american`); }
        catch (e) { console.log(`  ${x.game} (${d}): history pull failed (${e.message})`); if (e.status === 401 || e.status === 429) { stop = true; break; }
          if (e.status >= 400 && e.status < 500) for (const m of M) C.pulled[x.gk + '|' + m] = NOW; continue; }
        const c = credits(res.h) || cost; spent += c; histSpent += c;
        const snapT = Date.parse((res.j && res.j.timestamp) || '') || k1 - 2 * 60e3, mins = Math.max(0, Math.round((k1 - snapT) / 60e3));
        const { n, mv } = keep(C, x.L, boardMine((res.j && res.j.data) || {}, players(S, x, sp), sp.oa), mins, true);
        for (const m of M) C.pulled[x.gk + '|' + m] = NOW;
        hg++; hn += n; hb += x.L.length; hmv += mv;
        console.log(`  ${x.game} (${d}): ${n} of ${x.L.length} bet(s) got a close${mv ? `, ${mv} line(s) moved` : ''} from the price ${mins} min before the start (${c} credits)`);
      }
    }
    if (MODE === 'dry') notes.push(`${sp.id} catch-up would cost ~${est} credits`);
    else if (hg || capped) notes.push(`${sp.id} caught up ${hg} game(s): ${hn}/${hb} closed${hmv ? `, ${hmv} moved` : ''}${capped ? ` (paused at the ${capped}, the rest next run)` : ''}`);
  }
  if (spent > spent0) { const d = iso(NOW).slice(0, 10); C.spent[d] = (C.spent[d] || 0) + spent - spent0; }
  if (JSON.stringify([C.closes, C.moved, C.pulled]) !== before || spent > spent0) write[sp.out] = JSON.stringify(C);
}
if (Object.keys(write).length && MODE !== 'dry') await saveFiles(G, write);
const wrote = Object.keys(write).length && MODE !== 'dry' ? Object.keys(write).join(', ') : '';
console.log(`credits used ${spent}${left != null ? ` · ${left} left` : ''}${wrote ? ` · wrote ${wrote}` : ''}`);
if (process.env.GITHUB_ACTIONS) console.log(`::notice title=Closing prices (${MODE})::${notes.join(' · ')} · credits ${spent}${left != null ? ` (${left} left)` : ''}${wrote ? ` · wrote ${wrote}` : ''}`);
