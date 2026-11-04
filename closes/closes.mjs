#!/usr/bin/env node
// 🤖 CLOSING PRICES for the NBA + NHL apps (user, 2026-11-04: "yes build option 1" — only 19 of 178 NHL background bets
// had a closing price, because the apps take one only while a page is open in the last minutes before the start).
// Run by .github/workflows/closes.yml every 10 min through the game window. Reads both apps' files in the ☁ Sync gist
// (nhl-sync.json / nba-sync.json: bets + shadow = the background bets) and, for every pending prop bet without a close
// whose game starts within WINDOW minutes, pulls that game's markets ONCE at your five books (1 credit per market) and keeps
// the bet's own book's price at the bet's own line and side — the apps' background rule (closeView with an exact line, no
// estimate). Writes <sport>-closes.json {closes: {betId: {o, t, m}}, moved: {betId: {l, o, t, m}}, tried: {game|start: t}} in
// the same gist (m = minutes before the start; moved = the book changed the line, its nearest line's price, for a later
// estimate); the apps copy `closes` into the bets when they sync (applyBotCloses). The bot never writes the apps' own files,
// so it can't race them.
// Env: ODDS_API_KEY + SYNC_TOKEN (gist scope) are repo secrets; optional SYNC_GIST_ID, CLOSES_MODE=dry (no pulls, no
// writes), CLOSES_WINDOW_MIN (30), CLOSES_RESERVE (1000 credits), CLOSES_NOW (ISO time, tests), CLOSES_GIST_FILE (a local
// JSON {files: {name: {content}}} used instead of GitHub, tests).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ODDS = 'https://api.the-odds-api.com/v4/sports', GH = 'https://api.github.com';
const BOOKS = 'fanduel,draftkings,betmgm,williamhill_us,fanatics';
const KEY = process.env.ODDS_API_KEY || '', TOKEN = process.env.SYNC_TOKEN || '', MODE = process.env.CLOSES_MODE || 'live';
const WINDOW = (+process.env.CLOSES_WINDOW_MIN || 30) * 60e3, RESERVE = +process.env.CLOSES_RESERVE || 1000;
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
const abbrByName = (S, name) => S.teamList.find(a => normName(S.teams[a].name) === normName(name)) || S.teamList.find(a => nick(S.teams[a].name) === nick(name)) || null;
function gamePlayers(S, away, home, skip) {
  const out = [];
  for (const ab of [away, home]) for (const p of (S.rosters[ab] || [])) { if (skip(p)) continue; const t = p.name.replace(/\b(Jr|Sr|II|III|IV)\b\.?/g, '').trim().split(/\s+/);
    out.push({ key: ab + '|' + p.id, nn: normName(p.name), last: normName(t[t.length - 1]), fi: normName(t[0]).slice(0, 1) }); }
  return out;
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

const hide = s => String(s).replace(/apiKey=[^&]+/g, 'apiKey=***');
async function getJson(url) { const r = await fetch(url); if (!r.ok) { const e = new Error(`${r.status} ${hide(url)}`); e.status = r.status; throw e; } return { j: await r.json(), h: r.headers }; }
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
let left = null, spent = 0, stop = false;
const G = await loadGist(), write = {};
for (const sp of SPORTS) {
  const sync = await fileJson(G, sp.file);
  if (!sync) { console.log(`${sp.id}: no ${sp.file} in the gist yet — skipped`); continue; }
  const prev = (await fileJson(G, sp.out)) || {}, C = { app: 'closes-bot', v: 1, closes: prev.closes || {}, moved: prev.moved || {}, tried: prev.tried || {} };
  const before = JSON.stringify([C.closes, C.moved, C.tried]);
  for (const M of [C.closes, C.moved]) for (const [k, v] of Object.entries(M)) if (NOW - (v.t || 0) > 60 * 864e5) delete M[k];
  for (const [k, t] of Object.entries(C.tried)) if (NOW - t > 3 * 864e5) delete C.tried[k];
  const recs = [...(sync.shadow || []), ...(sync.bets || [])].filter(r => r && r.id && r.result === 'pending' && !r.closeOdds && !C.closes[r.id] && r.key && r.game
    && String(r.market || '').startsWith('P|') && sp.oa[String(r.market).split('|')[1]]);
  const due = new Map();
  for (const r of recs) { const k0 = Date.parse(r.ko || ''); if (!(k0 > NOW) || k0 - NOW > WINDOW) continue; const gk = r.game + '|' + new Date(k0).toISOString(); if (C.tried[gk]) continue;
    const x = due.get(gk) || due.set(gk, { gk, game: r.game, k0, L: [], mk: new Set() }).get(gk); x.L.push(r); x.mk.add(sp.oa[r.market.split('|')[1]]); }
  console.log(`${sp.id}: ${recs.length} open bet(s) without a close · ${due.size} game(s) starting within ${WINDOW / 60e3} min`);
  if (due.size && !stop) {
    const S = sp.snap.startsWith('http') ? (await getJson(sp.snap)).j : JSON.parse(fs.readFileSync(sp.snap, 'utf8'));
    const events = MODE === 'dry' ? [] : (await getJson(`${ODDS}/${sp.api}/events?apiKey=${encodeURIComponent(KEY)}`)).j;
    for (const x of due.values()) {
      const [away, home] = x.game.split('@'), M = [...x.mk];
      if (MODE === 'dry') { console.log(`  would pull ${x.game} (${M.join(', ')}) for ${x.L.length} bet(s): ${M.length} credit(s)`); continue; }
      if (left != null && left - M.length < RESERVE) { console.log(`  stopped: ${left} credits left, reserve ${RESERVE}`); stop = true; break; }
      const ev = events.find(e => abbrByName(S, e.away_team) === away && abbrByName(S, e.home_team) === home && Math.abs(Date.parse(e.commence_time) - x.k0) < 12 * 3600e3);
      if (!ev) { console.log(`  ${x.game}: not on The Odds API's board — skipped`); C.tried[x.gk] = NOW; continue; }
      const k1 = Date.parse(ev.commence_time); if (k1 <= NOW) { console.log(`  ${x.game}: already started`); C.tried[x.gk] = NOW; continue; }
      let res;
      try { res = await getJson(`${ODDS}/${sp.api}/events/${ev.id}/odds?apiKey=${encodeURIComponent(KEY)}&bookmakers=${BOOKS}&markets=${M.join(',')}&oddsFormat=american`); }
      catch (e) { console.log(`  ${x.game}: pull failed (${e.message}) — tried again next run`); if (e.status === 401 || e.status === 429) { stop = true; break; } continue; }
      left = +res.h.get('x-requests-remaining'); spent += +res.h.get('x-requests-last') || M.length;
      const mine = boardMine(res.j, gamePlayers(S, away, home, sp.skip), sp.oa), mins = Math.round((k1 - NOW) / 60e3); let n = 0, mv = 0;
      // exact line -> closes (the apps copy it in); the book moved the line -> moved {l, o} (kept for a later estimate; the apps ignore it)
      for (const r of x.L) { const [, s, side, l] = r.market.split('|'), arr = (mine[s + '|' + r.key] || {})[r.book || 'fanduel'] || [], o = arr.find(e => e.line === +l), q = o && (side === 'O' ? o.O : o.U);
        if (q) { C.closes[r.id] = { o: q, t: NOW, m: mins }; n++; continue; }
        const near = arr.slice().sort((a, b) => Math.abs(a.line - l) - Math.abs(b.line - l))[0], nq = near && (side === 'O' ? near.O : near.U);
        if (nq) { C.moved[r.id] = { l: near.line, o: nq, t: NOW, m: mins }; mv++; } }
      C.tried[x.gk] = NOW;
      console.log(`  ${x.game}: ${n} of ${x.L.length} bet(s) got a close${mv ? `, ${mv} line(s) moved` : ''} (${M.length} credit(s), ${mins} min before the start)`);
    }
  }
  if (JSON.stringify([C.closes, C.moved, C.tried]) !== before) write[sp.out] = JSON.stringify(C);
}
if (Object.keys(write).length && MODE !== 'dry') await saveFiles(G, write);
console.log(`credits used ${spent}${left != null ? ` · ${left} left` : ''}${Object.keys(write).length && MODE !== 'dry' ? ` · wrote ${Object.keys(write).join(', ')}` : ''}`);
