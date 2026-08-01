// Local bridge service for the secondhand resale workbench.
//
// Runs on your PC. The HTML workbench (opened in a browser on the same
// machine) calls this service to do REAL one-click publishing:
//   - Kijiji  -> pure HTTP API adapter
//   - FB / Karrot / 小红书 -> Playwright controlling your installed Chrome
//
// Endpoints:
//   GET  /health                  -> {ok, status, platforms, profileDir}
//   GET  /login-status            -> {results:[{platform,loggedIn,cookieCount}]}
//   POST /login/:platform         -> opens that platform's login page in Chrome
//   POST /publish                 -> body {item, platforms[], copy{}, images[]}
//                                    -> {results:{fb:{ok,status,url,message},...}}
//
// All responses are JSON. CORS is open (localhost only by design).

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CFG_PATH = path.join(ROOT, 'config.json');
let cfg = { port: 8891, platforms: ['fb', 'kijiji', 'xhs', 'karrot'], pacing: { minDelayMs: 5000, maxDelayMs: 12000 }, logDir: 'logs', maxImages: 8 };
try { cfg = Object.assign(cfg, JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'))); } catch (e) {}
const LOG_DIR = path.join(ROOT, cfg.logDir || 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

function log(...a) {
  const s = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  const line = `[${new Date().toISOString()}] ${s}`;
  console.log(line);
  try { fs.appendFileSync(path.join(LOG_DIR, 'bridge.log'), line + '\n'); } catch (e) {}
}

let kijijiMod = null, browserMod = null;
function loadAdapters() {
  try { kijijiMod = require('./adapters/kijiji.js'); } catch (e) { log('kijiji adapter load failed:', e.message); }
  try { browserMod = require('./adapters/browser.js'); } catch (e) { log('browser adapter load failed:', e.message); }
}
loadAdapters();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(a, b) { return a + Math.floor(Math.random() * (b - a)); }

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}
function readJSON(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 64 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function handleHealth(res) {
  return send(res, 200, { ok: true, status: 'online', platforms: cfg.platforms, profileDir: cfg.chromeProfileDir || null, kijiji: !!kijijiMod, browser: !!browserMod });
}

async function handleLoginStatus(res) {
  const out = [];
  if (!browserMod) return send(res, 200, { ok: true, results: cfg.platforms.map(p => ({ platform: p, loggedIn: false, cookieCount: 0, note: 'browser adapter not loaded' })) });
  for (const p of ['fb', 'karrot', 'xhs']) {
    try { out.push(await browserMod.checkLogin(p, cfg)); }
    catch (e) { out.push({ platform: p, loggedIn: false, cookieCount: 0, note: e.message }); }
  }
  if (cfg.kijiji && cfg.kijiji.email) out.push({ platform: 'kijiji', loggedIn: true, cookieCount: 0, note: 'uses email/password from config' });
  else out.push({ platform: 'kijiji', loggedIn: false, note: 'no kijiji credentials in config' });
  return send(res, 200, { ok: true, results: out });
}

async function handleLogin(platform, res) {
  if (!browserMod) return send(res, 500, { ok: false, message: 'browser adapter not loaded (playwright installed?)' });
  try { const r = await browserMod.openLogin(platform, cfg); return send(res, 200, { ok: true, ...r }); }
  catch (e) { return send(res, 500, { ok: false, message: e.message }); }
}

async function handlePublish(req, res) {
  let body;
  try { body = await readJSON(req); } catch (e) { return send(res, 400, { ok: false, message: 'bad JSON' }); }
  const { item, platforms, copy, images } = body || {};
  if (!item || !platforms || !Array.isArray(platforms)) return send(res, 400, { ok: false, message: 'need {item, platforms[], copy{}, images[]}' });

  log('[publish] item=', item.nameEn || item.nameZh, 'platforms=', platforms.join(','));

  const results = {};
  let browserUsed = false;
  try {
    for (const pk of platforms) {
      try {
        if (pk === 'kijiji') {
          if (!kijijiMod) { results[pk] = { ok: false, status: 'failed', message: 'kijiji adapter 未加载' }; }
          else results[pk] = await kijijiMod.post(cfg.kijiji || {}, { item, copy: (copy || {})[pk], images }, log);
        } else {
          if (!browserMod) { results[pk] = { ok: false, status: 'failed', message: 'browser adapter 未加载（playwright?）' }; }
          else {
            browserUsed = true;
            const fn = { fb: browserMod.postFB, karrot: browserMod.postKarrot, xhs: browserMod.postXhs }[pk];
            results[pk] = await fn({ item, copy: (copy || {})[pk], images }, cfg);
          }
        }
      } catch (e) {
        results[pk] = { ok: false, status: 'failed', message: String(e.message || e) };
      }
      // human-like pacing between platforms
      const d = rand(cfg.pacing.minDelayMs || 5000, cfg.pacing.maxDelayMs || 12000);
      if (platforms.indexOf(pk) < platforms.length - 1) { log('[publish] pacing', d, 'ms'); await sleep(d); }
    }
  } finally {
    if (browserUsed && browserMod) { try { await browserMod.closeBrowser(); } catch (e) {} }
  }
  const okN = Object.values(results).filter(r => r && r.status === 'posted').length;
  const fN = Object.values(results).filter(r => r && r.status === 'failed').length;
  log('[publish] done ok=', okN, 'failed=', fN);
  return send(res, 200, { ok: true, results });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${cfg.port}`);
  const p = url.pathname;
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    if (p === '/health' && req.method === 'GET') return await handleHealth(res);
    if (p === '/login-status' && req.method === 'GET') return await handleLoginStatus(res);
    const lm = p.match(/^\/login\/(\w+)$/);
    if (lm && req.method === 'POST') return await handleLogin(lm[1], res);
    if (p === '/publish' && req.method === 'POST') return await handlePublish(req, res);
    return send(res, 404, { ok: false, message: 'not found' });
  } catch (e) {
    log('[server] error', e.message);
    return send(res, 500, { ok: false, message: e.message });
  }
});

server.listen(cfg.port, '127.0.0.1', () => {
  log('Resell bridge listening on http://127.0.0.1:' + cfg.port);
  log('Kijiji adapter:', kijijiMod ? 'loaded' : 'MISSING', '| Browser adapter:', browserMod ? 'loaded' : 'MISSING');
  log('Chrome profile:', cfg.chromeProfileDir || '(default)');
});
