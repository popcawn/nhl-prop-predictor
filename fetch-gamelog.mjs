#!/usr/bin/env node
// Download every regular-season box score of an NHL season from ESPN into data/gamelog_<season>.json (compact).
//   node fetch-gamelog.mjs 2026          one season (ESPN names a season by the year it ENDS: 2026 = 2025-26)
//   node fetch-gamelog.mjs 2025 2026     several
// Re-running only fetches games that aren't in the file yet (finished games never change), so the daily refresh is cheap.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SB = 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard';
const SUM = 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/summary?event=';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJson(url, tries = 5) {   // 20 s timeout: a hung request retries instead of stalling the run
  for (let t = 1; ; t++) {
    try { const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) }); if (r.status === 404) return null; if (!r.ok) throw new Error('http ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());   // ESPN sometimes sends a body gzipped twice
      return JSON.parse((buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString('utf8')); }
    catch (e) { if (t >= tries) throw e; await sleep(600 * t); }
  }
}
async function pool(items, n, fn) { let i = 0; const out = new Array(items.length);
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const num = v => { const x = parseFloat(v); return isNaN(x) ? 0 : x; };
const mins = v => { const [m, s] = String(v || '0:00').split(':'); return num(m) + num(s) / 60; };   // "20:24" -> 20.4

export function gamelogPath(season) { return path.join(DIR, 'data', `gamelog_${season}.json`); }
export function loadGamelog(season) { try { return JSON.parse(fs.readFileSync(gamelogPath(season), 'utf8')); } catch { return { season, games: [], players: {} }; } }

// one game -> compact record.
//   skater row: [espnId, team, 0 forward | 1 defense, toi, goals, assists, shots on goal, pp toi, blocked shots]
//   goalie row: [espnId, team, 2, toi, goals against, shots against]
//   ou / ml = DraftKings' closing total and home moneyline from ESPN's pickcenter (null when missing)
function compact(ev, sum) {
  const c = sum.header.competitions[0], side = h => c.competitors.find(x => x.homeAway === h);
  const pc = (sum.pickcenter || [])[0] || {}, g = { id: String(ev.id), d: c.date, h: side('home').team.abbreviation, a: side('away').team.abbreviation,
    hs: num(side('home').score), as: num(side('away').score), ou: pc.overUnder != null ? +pc.overUnder : null,
    ml: pc.homeTeamOdds && pc.homeTeamOdds.moneyLine != null ? +pc.homeTeamOdds.moneyLine : null, p: [] };
  const names = {};
  for (const tb of ((sum.boxscore && sum.boxscore.players) || [])) for (const st of (tb.statistics || [])) {
    const K = st.keys || [], ix = n => K.indexOf(n), grp = String(st.name || '').toLowerCase();
    const kind = /goal/.test(grp) ? 2 : /def/.test(grp) ? 1 : /forw/.test(grp) ? 0 : null; if (kind == null) continue;
    for (const a of (st.athletes || [])) { const id = String(a.athlete.id), s = a.stats || []; if (!s.length) continue;
      names[id] = [a.athlete.displayName, (a.athlete.position && a.athlete.position.abbreviation) || (kind === 2 ? 'G' : kind === 1 ? 'D' : 'F')];
      const toi = mins(s[ix('timeOnIce')]); if (!(toi > 0)) continue;
      if (kind === 2) g.p.push([id, tb.team.abbreviation, 2, +toi.toFixed(2), num(s[ix('goalsAgainst')]), num(s[ix('shotsAgainst')])]);
      else g.p.push([id, tb.team.abbreviation, kind, +toi.toFixed(2), num(s[ix('goals')]), num(s[ix('assists')]), num(s[ix('shotsTotal')]), +mins(s[ix('powerPlayTimeOnIce')]).toFixed(2), num(s[ix('blockedShots')])]); } }
  return { g, names };
}

export async function ensureSeason(season, log = console.log) {
  const GL = loadGamelog(season), have = new Set(GL.games.map(g => g.id));
  // the regular season runs early October -> mid-April; ask ESPN day by day (it refuses date ranges) and keep type-2 finals
  const start = new Date(Date.UTC(season - 1, 9, 1)), end = new Date(Math.min(Date.UTC(season, 3, 25), Date.now() + 864e5)), days = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) days.push(ymd(d));
  const lastHave = GL.games.length ? ymd(new Date(Date.parse(GL.games[GL.games.length - 1].d) - 2 * 864e5)) : '0';
  const todo = days.filter(d => d >= lastHave);   // finished days already on file don't need a second look
  const evs = [];
  await pool(todo, 8, async day => { const sb = await getJson(`${SB}?dates=${day}`);
    for (const e of ((sb && sb.events) || [])) if (e.season && e.season.type === 2 && e.status && e.status.type && e.status.type.completed && !have.has(String(e.id))) { have.add(String(e.id)); evs.push(e); } });
  log(`  gamelog ${season}: ${GL.games.length} games on file, ${evs.length} new to fetch (${todo.length} days checked)`);
  let done = 0;
  const recs = await pool(evs, 8, async ev => { let sum = null; try { sum = await getJson(SUM + ev.id); } catch (e) { log('    skipped ' + ev.id + ': ' + e.message + ' (retried on the next run)'); } if (++done % 200 === 0) log(`    ${done}/${evs.length}`); return sum && sum.boxscore ? compact(ev, sum) : null; });
  for (const r of recs) if (r && r.g.p.length) { GL.games.push(r.g); Object.assign(GL.players, r.names); }
  GL.games.sort((x, y) => x.d < y.d ? -1 : x.d > y.d ? 1 : 0);
  if (evs.length) { fs.mkdirSync(path.dirname(gamelogPath(season)), { recursive: true }); fs.writeFileSync(gamelogPath(season), JSON.stringify(GL)); }
  return GL;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const seasons = process.argv.slice(2).map(Number).filter(Boolean);
  if (!seasons.length) { console.log('usage: node fetch-gamelog.mjs <season> [season…]   (2026 = the 2025-26 season)'); process.exit(1); }
  for (const s of seasons) { const GL = await ensureSeason(s); console.log(`season ${s}: ${GL.games.length} games, ${Object.keys(GL.players).length} players -> ${path.basename(gamelogPath(s))} (${(fs.statSync(gamelogPath(s)).size / 1e6).toFixed(2)} MB)`); }
}
