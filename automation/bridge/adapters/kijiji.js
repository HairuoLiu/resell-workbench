// Kijiji non-official posting via pure HTTP (no browser).
//
// Kijiji has no public API. This mirrors the community `kijijiapi` flow:
//   1) log in with email/password to obtain a session cookie
//   2) fetch the "post ad" form, extract the real action URL + hidden fields
//   3) upload images, then submit the form
//
// Credentials come from config.json -> kijiji.email / kijiji.password.
//
// NOTE: Kijiji's form fields change over time. This is a real attempt but
// WILL likely need first-run tuning. Every step logs to bridge.log and
// errors return a message you can paste back so we can fix selectors.

const BASE = 'https://www.kijiji.ca';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Best-effort category mapping. Kijiji uses numeric category IDs; these are
// common guesses. Adjust if posting lands in the wrong category.
const KIJIJI_CAT = {
  '家具': '1700008',        // Furniture
  '电子产品': '1100004',    // Electronics
  '家电': '1100006',        // Appliances
  '厨房用品': '1300008',    // Kitchen & dining
  '服饰鞋包': '退还',        // placeholder, set below
  '图书教材': '1100007',    // Books
  '运动户外': '1200005',    // Sports & outdoors
  '母婴': '1100012',        // Baby & kids
  '其他': '1100000'         // Misc
};
KIJIJI_CAT['服饰鞋包'] = '1100010';

function cookieJar() {
  const m = new Map();
  return {
    set(res) {
      const sc = res.headers.get('set-cookie');
      if (!sc) return;
      sc.split(',').forEach(c => {
        const i = c.indexOf('=');
        const k = c.slice(0, i).trim();
        const v = c.slice(i + 1).split(';')[0].trim();
        if (k) m.set(k, v);
      });
    },
    header() { return [...m.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  };
}

function dataUrlToBuffer(dataUrl) {
  const b64 = dataUrl.split(',')[1] || '';
  return Buffer.from(b64, 'base64');
}

async function login(cfg, jar, log) {
  log('[kijiji] logging in as', cfg.email || '(empty)');
  if (!cfg.email || !cfg.password) throw new Error('Kijiji email/password 没填（config.json -> kijiji）');
  const r = await fetch(`${BASE}/t-login.html`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, 'Cookie': jar.header() },
    body: new URLSearchParams({ emailOrLogin: cfg.email, password: cfg.password, loginType: 'existing', rememberMe: 'true' }).toString()
  });
  jar.set(r);
  log('[kijiji] login status', r.status);
  if (r.status !== 302 && r.status !== 200) throw new Error('Kijiji 登录返回 ' + r.status);
  const loc = r.headers.get('location');
  if (loc) {
    const abs = loc.startsWith('http') ? loc : BASE + loc;
    const fr = await fetch(abs, { headers: { 'User-Agent': UA, 'Cookie': jar.header() }, redirect: 'manual' });
    jar.set(fr);
  }
}

async function post(cfg, payload, log) {
  const { item, copy, images } = payload;
  const jar = cookieJar();

  await login(cfg, jar, log);

  // 1) fetch the post form
  const formRes = await fetch(`${BASE}/p-post-ad.html`, {
    headers: { 'User-Agent': UA, 'Cookie': jar.header(), 'Accept': 'text/html' }
  });
  jar.set(formRes);
  const html = await formRes.text();
  log('[kijiji] form page length', html.length);

  const actionMatch = html.match(/<form[^>]+action="([^"]*p-post-ad[^"]*)"/i);
  const action = actionMatch
    ? (actionMatch[1].startsWith('http') ? actionMatch[1] : BASE + actionMatch[1])
    : `${BASE}/p-post-ad.html`;
  log('[kijiji] form action', action);

  const fields = new URLSearchParams();
  const re = /<input[^>]+name="([^"]+)"[^>]*value="([^"]*)"/gi;
  let m;
  while ((m = re.exec(html))) fields.append(m[1], m[2]);

  fields.set('title', copy.title || item.nameEn || item.nameZh || '');
  fields.set('description', copy.text || '');
  fields.set('price', String(item.price || 0));
  fields.set('currency', (cfg.cur || 'CAD').toUpperCase());
  fields.set('adType', 'OFFER');
  fields.set('categoryId', KIJIJI_CAT[item.cat] || KIJIJI_CAT['其他']);
  const pc = (item.loc || '').split(',').pop().trim();
  if (pc) fields.set('postalCode', pc);

  // 2) upload images
  const imgIds = [];
  for (const dataUrl of (images || []).slice(0, cfg.maxImages || 8)) {
    try {
      const buf = dataUrlToBuffer(dataUrl);
      const fd = new FormData();
      fd.append('file', new Blob([buf], { type: 'image/jpeg' }), 'img.jpg');
      const ur = await fetch(`${BASE}/p-upload-image.html`, {
        method: 'POST', headers: { 'Cookie': jar.header(), 'User-Agent': UA }, body: fd
      });
      jar.set(ur);
      const j = await ur.json().catch(() => ({}));
      if (j && (j.imageId || j.id)) imgIds.push(j.imageId || j.id);
      log('[kijiji] image upload', ur.status, JSON.stringify(j).slice(0, 120));
    } catch (e) { log('[kijiji] image upload failed', e.message); }
  }
  if (imgIds.length) fields.set('images', imgIds.join(','));

  // 3) submit
  const sub = await fetch(action, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': jar.header(), 'User-Agent': UA },
    body: fields.toString()
  });
  jar.set(sub);
  log('[kijiji] submit status', sub.status);
  if (sub.status >= 300 && sub.status < 400) {
    return { ok: true, status: 'posted', url: `${BASE}/my/ads`, message: '已提交（重定向 ' + sub.status + '）' };
  }
  const txt = await sub.text();
  if (/thank|success|your ad|发布成功/i.test(txt)) {
    return { ok: true, status: 'posted', url: `${BASE}/my/ads`, message: '看起来发布成功了' };
  }
  return { ok: false, status: 'failed', message: '提交返回 ' + sub.status + '，正文片段：' + txt.slice(0, 200) };
}

module.exports = { post };
