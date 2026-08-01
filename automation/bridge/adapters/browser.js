// Browser automation for Facebook Marketplace, Karrot and Xiaohongshu (小红书).
//
// Uses Playwright with the USER's installed Chrome (channel 'chrome') and a
// PERSISTENT profile so login sessions survive between runs. headless:false so
// you can watch it and so the platforms are less likely to flag the traffic.
//
// SELECTORS below are written from the known page layouts but are the most
// fragile part. Each poster is wrapped in try/catch and on failure saves a
// screenshot to logs/err-<platform>-<ts>.png for debugging. First-run
// validation on your account is expected — paste errors back and we tune.

const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

let _ctx = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(a, b) { return a + Math.floor(Math.random() * (b - a)); }

// IMPORTANT: we use launchPersistentContext (NOT launch) because a persistent
// userDataDir is the only way login sessions survive between runs. chromium.launch()
// silently ignores userDataDir, which would force a re-login on every publish.
async function ensureBrowser(cfg) {
  if (_ctx) return _ctx;
  const profileDir = cfg.chromeProfileDir
    || path.join(os.homedir(), 'AppData', 'Local', 'ResellBridge', 'chrome-profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const opts = {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
  };
  if (cfg.chromeExecutable && fs.existsSync(cfg.chromeExecutable)) opts.executablePath = cfg.chromeExecutable;
  else opts.channel = 'chrome';

  _ctx = await chromium.launchPersistentContext(profileDir, opts);
  return _ctx;
}
async function closeBrowser() {
  if (_ctx) { try { await _ctx.close(); } catch (e) {} }
  _ctx = null;
}

async function errShot(page, platform, logDir) {
  try {
    const p = path.join(logDir || '.', `err-${platform}-${Date.now()}.png`);
    await page.screenshot({ path: p, fullPage: false });
    if (logDir) console.log('[bridge] error screenshot ->', p);
  } catch (e) {}
}

async function saveTempImages(images, tag, max) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rb-${tag}-`));
  const out = [];
  for (const d of (images || []).slice(0, max || 8)) {
    try {
      const b64 = d.split(',')[1] || '';
      const f = path.join(dir, `img${out.length}.jpg`);
      fs.writeFileSync(f, Buffer.from(b64, 'base64'));
      out.push(f);
    } catch (e) {}
  }
  return out;
}

// ---------------- Facebook Marketplace ----------------
async function postFB(payload, cfg) {
  const ctx = await ensureBrowser(cfg);
  const page = await ctx.newPage();
  try {
    await page.goto('https://www.facebook.com/marketplace/create/item', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByPlaceholder('What are you selling?').first().fill(payload.copy.title || payload.item.nameEn || '');
    await page.getByPlaceholder('Add a price').first().fill(String(payload.item.price || 0));
    await page.getByPlaceholder('Product details').first().fill(payload.copy.text || '');
    const paths = await saveTempImages(payload.images, 'fb', cfg.maxImages || 8);
    const fi = await page.$('input[type="file"]');
    if (fi && paths.length) { await fi.setInputFiles(paths); await sleep(rand(2000, 4000)); }
    await sleep(rand(1000, 2500));
    await page.getByRole('button', { name: /Next/i }).first().click();
    await sleep(rand(2000, 4000));
    await page.getByRole('button', { name: /Publish|发布/i }).first().click();
    await sleep(rand(3000, 6000));
    return { ok: true, status: 'posted', url: 'https://www.facebook.com/marketplace/you', message: 'FB 已发布' };
  } catch (e) {
    await errShot(page, 'fb', cfg.logDir);
    return { ok: false, status: 'failed', message: e.message };
  } finally { await page.close().catch(() => {}); }
}

// ---------------- Karrot (ca.karrotmarket.com) ----------------
async function postKarrot(payload, cfg) {
  const ctx = await ensureBrowser(cfg);
  const page = await ctx.newPage();
  try {
    await page.goto('https://ca.karrotmarket.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    // "Sell" / "판매하기" entry
    await page.getByText(/sell|판매|出售|发布闲置/i).first().click();
    await sleep(rand(1500, 3000));
    await page.getByPlaceholder(/title|标题|商品名/i).first().fill(payload.copy.title || payload.item.nameEn || '');
    const desc = page.getByPlaceholder(/description|描述|详情|说点什么/i).first();
    if (await desc.count()) await desc.fill(payload.copy.text || '');
    const price = page.getByPlaceholder(/price|价格|￥|\$/i).first();
    if (await price.count()) await price.fill(String(payload.item.price || 0));
    const paths = await saveTempImages(payload.images, 'karrot', cfg.maxImages || 8);
    const fi = await page.$('input[type="file"]');
    if (fi && paths.length) { await fi.setInputFiles(paths); await sleep(rand(2000, 4000)); }
    await sleep(rand(1000, 2500));
    await page.getByRole('button', { name: /post|publish|upload|发布|上传/i }).first().click();
    await sleep(rand(3000, 6000));
    return { ok: true, status: 'posted', url: 'https://ca.karrotmarket.com/', message: 'Karrot 已发布' };
  } catch (e) {
    await errShot(page, 'karrot', cfg.logDir);
    return { ok: false, status: 'failed', message: e.message };
  } finally { await page.close().catch(() => {}); }
}

// ---------------- Xiaohongshu (小红书) ----------------
async function postXhs(payload, cfg) {
  const ctx = await ensureBrowser(cfg);
  const page = await ctx.newPage();
  try {
    await page.goto('https://creator.xiaohongshu.com/publish/publish?source=official', { waitUntil: 'domcontentloaded', timeout: 60000 });
    // image upload first
    const paths = await saveTempImages(payload.images, 'xhs', cfg.maxImages || 8);
    const fi = await page.$('input[type="file"]');
    if (fi && paths.length) { await fi.setInputFiles(paths); await sleep(rand(3000, 5000)); }
    await page.getByPlaceholder(/填写标题|title/i).first().fill(payload.copy.title || payload.item.nameZh || '');
    await page.getByPlaceholder(/填写正文|说点什么|分享你的故事/i).first().fill(payload.copy.text || '');
    await sleep(rand(1000, 2500));
    await page.getByRole('button', { name: /发布|publish/i }).first().click();
    await sleep(rand(3000, 6000));
    return { ok: true, status: 'posted', url: 'https://www.xiaohongshu.com/', message: '小红书 已发布' };
  } catch (e) {
    await errShot(page, 'xhs', cfg.logDir);
    return { ok: false, status: 'failed', message: e.message };
  } finally { await page.close().catch(() => {}); }
}

// ---------------- login helper ----------------
async function openLogin(platform, cfg) {
  const ctx = await ensureBrowser(cfg);
  const page = await ctx.newPage();
  const urls = {
    fb: 'https://www.facebook.com/marketplace/create/item',
    karrot: 'https://ca.karrotmarket.com/',
    xhs: 'https://creator.xiaohongshu.com/publish/publish?source=official'
  };
  await page.goto(urls[platform] || 'https://www.google.com', { waitUntil: 'domcontentloaded' });
  return { ok: true, status: 'pending', message: `已打开 ${platform} 登录页，请在浏览器里手动登录，会话会自动保存。` };
}

async function checkLogin(platform, cfg) {
  const ctx = await ensureBrowser(cfg);
  const page = await ctx.newPage();
  const dom = { fb: 'facebook.com', karrot: 'karrotmarket.com', xhs: 'xiaohongshu.com' }[platform] || 'example.com';
  try {
    await page.goto('https://www.' + dom + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {}
  const cookies = await ctx.cookies();
  const rel = cookies.filter(c => c.domain.endsWith('.' + dom) || c.domain === dom);
  const loggedIn = platform === 'fb'
    ? rel.some(c => c.name === 'c_user' && c.value)
    : rel.length > 0;
  await page.close().catch(() => {});
  return { platform, loggedIn, cookieCount: rel.length };
}

module.exports = { ensureBrowser, closeBrowser, postFB, postKarrot, postXhs, openLogin, checkLogin };
