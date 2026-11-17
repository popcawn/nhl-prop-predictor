#!/usr/bin/env node
// 🤖 NBA HOURLY PAPER PULLS (user, 2026-11-17: "create a timer that pulls nba odds every hour" -> "Hourly, last 6 h before tip").
// The NBA app is background-only (paper): a would-be bet is only recorded when a device presses ⚡ Pull. This runs inside
// closes.yml (every 10 min from the user's cron-job.org timer) and, for each NBA game starting within WINDOW_H hours that
// was not pulled in the last EVERY_MIN minutes, opens the LIVE NBA app in a headless Chrome and presses Pull for that game
// (window.__nbaBot.pull = the app's own pullAll(game)), so the background bets come from the app's own rules, then lets the
// app ☁ Sync them like any other device. Markets: points, rebounds, assists (3 credits a game; 3-pointers and PRA are
// filtered out of every bet, so they are left to the manual pulls). No Chrome is started when nothing is due.
// State: nba-paper-bot.json in the ☁ Sync gist {pulled: {game|tip: t}, spent: {day: credits}, last}.
// Env: ODDS_API_KEY + SYNC_TOKEN (repo secrets); PAPER_MODE live | dry (no Chrome, no writes) | off; PAPER_WINDOW_H (6);
// PAPER_EVERY_MIN (55); PAPER_RESERVE (3000: never pull below this many credits — the NFL alerts come first);
// PAPER_URL (the live app); CHROME_PATH; PAPER_GIST_FILE (a local JSON {files: {name: {content}}} instead of GitHub, tests);
// (in a test the browser's GitHub calls are answered from that file too).
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const envNum = (k, d) => { const v = process.env[k]; return v != null && v !== '' && !isNaN(+v) ? +v : d; };
const KEY = process.env.ODDS_API_KEY || '', TOKEN = process.env.SYNC_TOKEN || '', MODE = process.env.PAPER_MODE || 'live';
const WINDOW = envNum('PAPER_WINDOW_H', 6) * 3600e3, EVERY = envNum('PAPER_EVERY_MIN', 55) * 60e3, RESERVE = envNum('PAPER_RESERVE', 3000);
const PAGE = process.env.PAPER_URL || 'https://popcawn.github.io/nba-prop-predictor/nba-prop-predictor.html';
const MOCK = process.env.PAPER_GIST_FILE || '', ODDS = process.env.PAPER_ODDS_BASE || 'https://api.the-odds-api.com', GH = 'https://api.github.com';
const STATE = 'nba-paper-bot.json', NOW = Date.now(), MARKETS = { player_threes: false, player_points_rebounds_assists: false };
const notice = s => { console.log(s); if (process.env.GITHUB_ACTIONS) console.log(`::notice title=NBA paper pulls (${MODE})::${s}`); };
const iso = t => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (MODE === 'off') { console.log('NBA paper pulls: off'); process.exit(0); }
if (!MOCK && !TOKEN) { console.log('::warning::SYNC_TOKEN secret is not set — NBA paper pulls skipped'); process.exit(0); }
if (!KEY) { console.log('::warning::ODDS_API_KEY secret is not set — NBA paper pulls skipped'); process.exit(0); }

async function gh(p, opt = {}) {
  const r = await fetch(GH + p, { method: opt.method || 'GET', body: opt.body, signal: AbortSignal.timeout(30e3), headers: Object.assign({ Authorization: 'Bearer ' + TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'nba-paper-bot' }, opt.body ? { 'Content-Type': 'application/json' } : {}) });
  if (!r.ok) throw new Error('GitHub ' + r.status + ' ' + p); return r.json();
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
  if (f.truncated && f.raw_url) txt = await (await fetch(f.raw_url, { headers: { Authorization: 'Bearer ' + TOKEN } })).text();
  try { return JSON.parse(txt); } catch (e) { return null; }
}
async function saveState(G, St) {
  const content = JSON.stringify(St);
  if (MOCK) { const m = JSON.parse(fs.readFileSync(MOCK, 'utf8')); m.files[STATE] = { content }; fs.writeFileSync(MOCK, JSON.stringify(m)); return; }
  await gh('/gists/' + G.id, { method: 'PATCH', body: JSON.stringify({ files: { [STATE]: { content } } }) });
}

async function main() {
// 1) anything due? The Odds API's game list is free (0 credits) and says how many credits are left
const r0 = await fetch(`${ODDS}/v4/sports/basketball_nba/events?apiKey=${encodeURIComponent(KEY)}`, { signal: AbortSignal.timeout(30e3) });
if (!r0.ok) { notice(`the Odds API game list failed (${r0.status}) — tried again next run`); return; }
const events = await r0.json(), left0 = +r0.headers.get('x-requests-remaining');
const G = await loadGist(), prev = (await fileJson(G, STATE)) || {};
const St = { app: 'nba-paper-bot', v: 1, pulled: prev.pulled || {}, spent: prev.spent || {}, last: prev.last || null };
for (const [k, t] of Object.entries(St.pulled)) if (NOW - t > 3 * 864e5) delete St.pulled[k];
for (const d of Object.keys(St.spent)) if (NOW - Date.parse(d) > 60 * 864e5) delete St.spent[d];
const soon = events.filter(e => { const k = Date.parse(e.commence_time); return k - NOW > 5 * 60e3 && k - NOW <= WINDOW; });
const dueEv = soon.filter(e => !(NOW - (St.pulled['ev|' + e.id] || 0) < EVERY));
console.log(`NBA paper pulls: ${soon.length} game(s) start within ${WINDOW / 3600e3} h · ${dueEv.length} due (not pulled in ${EVERY / 60e3} min) · ${left0} credits left (reserve ${RESERVE})`);
if (!dueEv.length) return;
if (left0 - 3 * dueEv.length < RESERVE) { notice(`skipped: ${left0} credits left, reserve ${RESERVE}`); return; }
if (MODE === 'dry') { notice(`would pull ${dueEv.map(e => `${e.away_team} @ ${e.home_team}`).join(', ')} (~${3 * dueEv.length} credits)`); return; }

// 2) the whole pot from the gist, so the app sizes the paper bets in dollars like your devices: the newest bank and every
// sport's bets (the NBA app only READS nfltd_bets / nhlp_bets — they are never written back)
const nfl = (await fileJson(G, 'nfl-td-sync.json')) || {}, nhl = (await fileJson(G, 'nhl-sync.json')) || {}, nba = (await fileJson(G, 'nba-sync.json')) || {};
const bank = [nfl.bank, nhl.bank, nba.bank].filter(b => b && b.amt).sort((a, b) => (b.mt || 0) - (a.mt || 0))[0] || null;
const seed = {
  nfltd_sync: JSON.stringify(MOCK ? { token: 'mock', gistId: 'mock' } : { token: TOKEN, gistId: G.id }),
  nbap_oddskey: KEY,
  nbap_oddscfg: JSON.stringify({ books: ['fanduel', 'draftkings', 'betmgm', 'williamhill_us', 'fanatics'], booksV2: 1, mk: MARKETS, reserve: RESERVE, state: '' }),
  nbap_auto: JSON.stringify({ close: false, hist: false, v2: 1 }),   // closing prices are closes.mjs's job
  nbap_paper: 'true', nbap_usdround: 'true',
  nfltd_bets: JSON.stringify(nfl.bets || []), nhlp_bets: JSON.stringify(nhl.bets || []), ...(bank ? { nfltd_bank: JSON.stringify(bank) } : {}),
};

// 3) the live app in a headless Chrome
let puppeteer;
try { puppeteer = (await import('puppeteer-core')).default; }
catch (e) { execSync('npm i --no-save --no-audit --no-fund puppeteer-core@24.43.1', { cwd: path.join(DIR, '..'), stdio: 'ignore' }); puppeteer = (await import('puppeteer-core')).default; }
const chrome = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => fs.existsSync(p));
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const out = { pulled: [], skipped: [], credits: 0, newPaper: 0, newShadow: 0 };
try {
  const page = await browser.newPage();
  // ESPN doesn't answer a "HeadlessChrome" user agent (NBA repo notes)
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36');
  page.on('dialog', d => d.dismiss().catch(() => {}));   // a "go below your reserve?" confirm = no
  page.on('pageerror', e => console.log('  page error:', e.message));
  if (MOCK) {   // tests: the browser's GitHub calls are answered from the local gist file (never the real gist)
    await page.setRequestInterception(true);
    page.on('request', q => { const u = new URL(q.url()); if (u.host !== 'api.github.com') return q.continue();
      const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept', 'Access-Control-Allow-Methods': 'GET, PATCH, OPTIONS' };
      if (q.method() === 'OPTIONS') return q.respond({ status: 204, headers: cors });
      const m = JSON.parse(fs.readFileSync(MOCK, 'utf8')), files = () => Object.fromEntries(Object.entries(m.files).map(([k, v]) => [k, { filename: k, content: v.content }]));
      if (q.method() === 'PATCH') { const b = JSON.parse(q.postData() || '{}'); for (const [k, v] of Object.entries(b.files || {})) m.files[k] = { content: v.content }; fs.writeFileSync(MOCK, JSON.stringify(m)); (globalThis.__ghLog = globalThis.__ghLog || []).push('PATCH ' + Object.keys(b.files || {}).join(',')); }
      else (globalThis.__ghLog = globalThis.__ghLog || []).push('GET ' + u.pathname);
      const body = u.pathname === '/gists' ? [{ id: 'mock', files: files() }] : { id: 'mock', files: files() };
      q.respond({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(body) }); });
  }
  const origin = new URL(PAGE).origin;
  await page.evaluateOnNewDocument((seed, origin) => { if (location.origin !== origin || sessionStorage.getItem('__seeded')) return; sessionStorage.setItem('__seeded', '1');
    for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v); }, seed, origin);
  await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 60e3 });
  const st = () => page.evaluate(() => window.__nbaBot ? window.__nbaBot.state() : null);
  const waitFor = async (f, ms, what) => { const t = Date.now(); for (;;) { const s = await st(); if (s && f(s)) return s; if (Date.now() - t > ms) throw new Error('timed out waiting for ' + what); await sleep(500); } };
  await waitFor(() => true, 30e3, 'the app (window.__nbaBot — is the new version live?)');
  let s = await waitFor(x => x.syncOk > 0 || x.syncErr, 60e3, 'the first ☁ Sync');
  if (!s.syncOk) throw new Error('☁ Sync failed: ' + s.syncErr);
  s = await waitFor(x => x.slate.length > 0, 60e3, "ESPN's slate");
  const base = { shadow: s.shadow, paper: s.paper };
  console.log(`  app ready: ${s.slate.length} game(s) on the slate · markets ${s.mk.join(', ')} · 1 unit = ${s.bank != null ? '$' + s.bank.toFixed(2) : 'no bankroll'} · ${s.shadow} background bets`);
  // the app's games that match a due Odds API game (same tip within 15 min, still before the start)
  for (const g of s.slate) {
    const ev = dueEv.find(e => Math.abs(Date.parse(e.commence_time) - Date.parse(g.tip)) < 15 * 60e3 && !out.pulled.some(x => x.ev === e.id) && g.state === 'pre');
    if (!ev) continue;
    const before = await st();
    await page.evaluate(game => window.__nbaBot.pull(game), g.game);
    const after = await st(), b0 = before.left != null ? before.left : left0, c = after.left != null ? b0 - after.left : null;
    if (c === 0 || /skipped|no games|tick at least|add your/.test(after.msg)) { out.skipped.push(`${g.game}: ${after.msg}`); console.log(`  ${g.game}: not pulled — ${after.msg}`); continue; }
    out.credits += c || 0; out.pulled.push({ ev: ev.id, game: g.game }); St.pulled['ev|' + ev.id] = NOW;
    console.log(`  ${g.game} (tips ${g.tip}): pulled · ${c ?? '?'} credit(s) · ${after.left} left · ${after.paper - before.paper} new paper bet(s)`);
  }
  // let the app's own sync finish (recordShadow asks for one 2.5 s later), then one more to be sure it is saved
  await sleep(4000); await waitFor(x => !x.syncBusy, 60e3, 'the app\'s sync');
  const t1 = (await st()).syncOk; await page.evaluate(() => window.__nbaBot.sync());
  s = await waitFor(x => !x.syncBusy && (x.syncOk > t1 || x.syncErr), 60e3, 'the last ☁ Sync');
  if (s.syncErr) throw new Error('the last ☁ Sync failed: ' + s.syncErr);
  out.newPaper = s.paper - base.paper; out.newShadow = s.shadow - base.shadow;
} finally { await browser.close(); }
if (out.credits) { const d = iso(NOW).slice(0, 10); St.spent[d] = (St.spent[d] || 0) + out.credits; }
St.last = { t: NOW, games: out.pulled.map(x => x.game), credits: out.credits, newPaper: out.newPaper, newShadow: out.newShadow };
await saveState(G, St);
if (globalThis.__ghLog) console.log('  mock GitHub calls:', globalThis.__ghLog.join(' · '));
notice(`pulled ${out.pulled.length} game(s)${out.pulled.length ? ` (${out.pulled.map(x => x.game).join(', ')})` : ''} · ${out.credits} credit(s) · ${out.newPaper} new paper bet(s), ${out.newShadow - out.newPaper} filtered` + (out.skipped.length ? ` · ${out.skipped.length} not pulled` : ''));
}
await main();
