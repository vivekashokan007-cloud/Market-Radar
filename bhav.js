// ══════════════════════════════════════════════════════════════
// bhav.js — Bhav Copy Engine  |  Market Radar v2.0
// ══════════════════════════════════════════════════════════════
//
// HOW CREDENTIALS WORK
// --------------------
// You place ONE file called login.json in your repo root.
// The app fetches it automatically on every load.
// You never touch bhav.js or enter credentials in the app again.
//
// login.json format (create this file in your repo):
// {
//   "owner": "your-github-username",
//   "repo":  "market-radar",
//   "token": "github_pat_..."
// }
//
// HOW STORAGE WORKS
// -----------------
//   your-repo/
//   ├── index.html
//   ├── style.css
//   ├── app.js
//   ├── bhav.js
//   ├── login.json        ← you create this once, never touch again
//   └── data/             ← bhav files auto-created here
//       ├── index.json
//       ├── 20251125.json
//       └── ...
//
// FIRST TIME SETUP
// ----------------
// 1. Create a GitHub repo (public — needed for GitHub Pages)
// 2. Create login.json with your credentials and push it
// 3. Create a Fine-grained PAT: github.com → Settings → Developer settings
//    → Fine-grained tokens → select repo → Contents: Read & Write
// 4. Open the app — it fetches login.json automatically. Done forever.
//
// If you clear your browser / switch phone:
//   App re-fetches login.json from GitHub. No manual entry needed.
// ══════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// Repo location — already known, no need to enter in UI
// ─────────────────────────────────────────────────────────────
const REPO_OWNER  = 'vivekashokan007-cloud';
const REPO_NAME   = 'Market-Radar';

// ─────────────────────────────────────────────────────────────
// Nothing below needs editing
// ─────────────────────────────────────────────────────────────

const LOGIN_JSON_PATH = 'login.json';
const DATA_DIR        = 'data';

const GH_KEY      = 'mr_gh_config';  // localStorage cache key
const BHAV_IDX    = 'mr_bhav_dates';
const BHAV_PFX    = 'mr_bhav_';
const BHAV_SPREAD = 1000;

let _ghCfg      = null;
let _ghIndexSha = null;

// ── Config resolution ──────────────────────────────────────────
// Priority: 1) in-memory cache  2) localStorage  3) fetch login.json
function getGHConfig() {
  if (_ghCfg) return _ghCfg;
  const saved = localStorage.getItem(GH_KEY);
  if (saved) {
    try { _ghCfg = JSON.parse(saved); return _ghCfg; } catch(e) {}
  }
  return null;  // not cached yet — use fetchLoginJson() for async load
}

// Fetch credentials from /api/config (Vercel serverless function)
// Token lives in Vercel environment variables — never exposed in any file
async function fetchLoginJson(owner, repo, branch) {
  try {
    const res = await fetch('/api/config?_=' + Date.now());  // bust cache
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data.owner || !data.repo || !data.token) throw new Error('api/config missing fields');
    return data;
  } catch(e) {
    console.warn('fetchConfig failed:', e.message);
    return null;
  }
}

// Bootstrap: fetch credentials from Vercel /api/config on every cold start
async function bootstrapConfig() {
  if (_ghCfg) return _ghCfg;

  // Try localStorage cache first (fast path)
  const saved = localStorage.getItem(GH_KEY);
  if (saved) {
    try {
      _ghCfg = JSON.parse(saved);
      // Silently re-fetch in background to pick up token rotations
      _refreshLoginJson();
      return _ghCfg;
    } catch(e) {}
  }

  // Cold start — fetch from /api/config
  const data = await fetchLoginJson();
  if (data) {
    _ghCfg = { owner: data.owner, repo: data.repo, token: data.token };
    localStorage.setItem(GH_KEY, JSON.stringify(_ghCfg));
    return _ghCfg;
  }

  return null;
}

// Background refresh — pick up token changes without user doing anything
async function _refreshLoginJson() {
  const data = await fetchLoginJson();
  if (data && data.token) {
    _ghCfg = { owner: data.owner, repo: data.repo, token: data.token };
    localStorage.setItem(GH_KEY, JSON.stringify(_ghCfg));
  }
}

// ── Smarts tab UI: connect button calls /api/config ───────────
// No manual entry needed — all credentials come from Vercel env vars
function saveGHConfig() {
  _ghCfg = null;  // clear cache so bootstrapConfig re-fetches
  const notice = document.getElementById('fb-config-notice');
  if (notice) notice.style.display = 'none';
  setGHStatus('⏳ Loading credentials from /api/config...', 'var(--am)');
  fetchLoginJson().then(data => {
    if (!data) {
      setGHStatus('❌ Could not load credentials — check Vercel env vars GH_OWNER / GH_REPO / GH_TOKEN', 'var(--rd)');
      return;
    }
    _ghCfg = { owner: data.owner, repo: data.repo, token: data.token };
    localStorage.setItem(GH_KEY, JSON.stringify(_ghCfg));
    setGHStatus('✅ Connected — ' + data.owner + '/' + data.repo + '/data/', 'var(--gn)');
    showToast('✅ Credentials loaded from login.json');
    _ghEnsureIndex().then(() => syncFromCloud());
    updateBhavStatus(); renderBhavCalendar(); checkBhavGaps();
  });
}

function setGHStatus(msg, color) {
  const el = document.getElementById('fb-sync-status');
  if (!el) return;
  el.style.display = 'block';
  el.style.color   = color || 'var(--muted)';
  el.textContent   = msg;
}

async function testGHConnection() {
  setGHStatus('⏳ Testing connection...', 'var(--am)');
  const cfg = getGHConfig();
  if (!cfg) { setGHStatus('❌ Not configured', 'var(--rd)'); return; }
  try {
    const res = await fetch(
      `https://api.github.com/repos/${cfg.owner}/${cfg.repo}`,
      { headers: _ghHeaders(cfg) }
    );
    if (res.ok) {
      setGHStatus(`✅ Connected — ${cfg.owner}/${cfg.repo}/data/`, 'var(--gn)');
      showToast('GitHub connected ✅');
      await _ghEnsureIndex();
      syncFromCloud();
    } else if (res.status === 404) {
      setGHStatus('❌ Repo not found — check username and repo name', 'var(--rd)');
    } else if (res.status === 401) {
      setGHStatus('❌ Token rejected — check PAT has Contents: Read & Write', 'var(--rd)');
    } else {
      setGHStatus('❌ Error ' + res.status, 'var(--rd)');
    }
  } catch(e) {
    setGHStatus('❌ Network error: ' + e.message, 'var(--rd)');
  }
}

function setGHStatus(msg, color) {
  const el = document.getElementById('fb-sync-status');
  if (!el) return;
  el.style.display = 'block';
  el.style.color   = color || 'var(--muted)';
  el.textContent   = msg;
}

// ── GitHub REST API ────────────────────────────────────────────
function _ghHeaders(cfg) {
  return {
    'Authorization': 'token ' + cfg.token,
    'Accept':        'application/vnd.github.v3+json',
    'Content-Type':  'application/json',
  };
}

async function _ghGet(path) {
  const cfg = getGHConfig(); if (!cfg) return null;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}`,
      { headers: _ghHeaders(cfg) }
    );
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) {
      setGHStatus('❌ Token error (' + res.status + ') — re-check PAT has Contents: Read & Write', 'var(--rd)');
      return null;
    }
    if (!res.ok) { console.warn('ghGet HTTP ' + res.status + ':', path); return null; }
    const d = await res.json();
    if (!d.content) { console.warn('ghGet: no content field for', path); return null; }
    return {
      data: JSON.parse(atob(d.content.replace(/\n/g, ''))),
      sha:  d.sha,
    };
  } catch(e) { console.warn('ghGet:', path, e.message); return null; }
}

async function _ghPut(path, content, sha) {
  const cfg = getGHConfig(); if (!cfg) return false;
  try {
    const body = {
      message: 'bhav: ' + path,
      content: btoa(unescape(encodeURIComponent(JSON.stringify(content)))),
    };
    if (sha) body.sha = sha;
    const res = await fetch(
      `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}`,
      { method: 'PUT', headers: _ghHeaders(cfg), body: JSON.stringify(body) }
    );
    return res.ok;
  } catch(e) { console.warn('ghPut:', path, e.message); return false; }
}

// ── data/index.json — master list of uploaded dates ───────────
async function _ghGetIndex() {
  const r = await _ghGet(DATA_DIR + '/index.json');
  if (!r) return [];
  _ghIndexSha = r.sha;
  return r.data.dates || [];
}

async function _ghEnsureIndex() {
  const r = await _ghGet(DATA_DIR + '/index.json');
  if (!r) {
    await _ghPut(DATA_DIR + '/index.json', { dates: [], updated: Date.now() }, null);
  } else {
    _ghIndexSha = r.sha;
  }
}

async function _ghUpdateIndex(dates) {
  const sorted = [...new Set(dates)].sort();
  const ok = await _ghPut(
    DATA_DIR + '/index.json',
    { dates: sorted, updated: Date.now() },
    _ghIndexSha || undefined
  );
  if (ok) {
    const r = await _ghGet(DATA_DIR + '/index.json');
    if (r) _ghIndexSha = r.sha;
  }
  return sorted;
}

// ── Storage: GitHub primary, localStorage cache ────────────────
async function bhavSave(dk, data) {
  // Cache locally first for fast reads
  try { localStorage.setItem(BHAV_PFX + dk, JSON.stringify(data)); } catch(e) { _bhavEvict(); }
  const idx = new Set(JSON.parse(localStorage.getItem(BHAV_IDX) || '[]'));
  idx.add(dk);
  localStorage.setItem(BHAV_IDX, JSON.stringify([...idx].sort()));

  const cfg = getGHConfig();
  if (!cfg) return false;  // no GitHub config — local only

  const existing = await _ghGet(DATA_DIR + '/' + dk + '.json');
  const isNew = !existing;  // true = brand new day, false = update
  const ok = await _ghPut(DATA_DIR + '/' + dk + '.json', data, existing ? existing.sha : null);
  if (ok) {
    await _ghUpdateIndex(JSON.parse(localStorage.getItem(BHAV_IDX) || '[]'));
    if (isNew) {
      const MONTH = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const d = _dkToDate(dk);
      const label = d.getDate() + '-' + MONTH[d.getMonth()] + '-' + d.getFullYear();
      showToast('☁️ New day saved to GitHub — data/' + dk + '.json (' + label + ')');
    }
  }
  return ok;
}

async function bhavAllDates() {
  const cfg = getGHConfig();
  if (cfg) {
    try {
      const ghDates = await _ghGetIndex();
      if (ghDates.length) {
        const local  = JSON.parse(localStorage.getItem(BHAV_IDX) || '[]');
        const merged = [...new Set([...ghDates, ...local])].sort();
        localStorage.setItem(BHAV_IDX, JSON.stringify(merged));
        return merged;
      }
    } catch(e) { console.warn('bhavAllDates fallback', e); }
  }
  return JSON.parse(localStorage.getItem(BHAV_IDX) || '[]');
}

function _bhavEvict() {
  const d = JSON.parse(localStorage.getItem(BHAV_IDX) || '[]');
  d.slice(0, 10).forEach(dk => localStorage.removeItem(BHAV_PFX + dk));
  localStorage.setItem(BHAV_IDX, JSON.stringify(d.slice(10)));
}

function _bhavLatestDK() {
  return JSON.parse(localStorage.getItem(BHAV_IDX) || '[]').slice(-1)[0] || null;
}

function _bhavLatestData() {
  const dk = _bhavLatestDK(); if (!dk) return null;
  try { return JSON.parse(localStorage.getItem(BHAV_PFX + dk) || 'null'); } catch(e) { return null; }
}

// ── Sync GitHub → localStorage ─────────────────────────────────
async function syncFromCloud() {
  const cfg = getGHConfig();
  if (!cfg) { showToast('GitHub not configured'); return; }
  setGHStatus('⏳ Fetching index...', 'var(--am)');
  const log = document.getElementById('bhav-log');
  if (log) log.textContent = 'Syncing from GitHub...';

  const ghDates = await _ghGetIndex();
  if (!ghDates.length) {
    setGHStatus('✅ Connected — no data yet. Upload bhav files to start.', 'var(--gn)');
    if (log) log.textContent = 'No data in GitHub yet';
    return;
  }

  const localSet = new Set(JSON.parse(localStorage.getItem(BHAV_IDX) || '[]'));
  const missing  = ghDates.filter(dk => !localSet.has(dk) || !localStorage.getItem(BHAV_PFX + dk));

  setGHStatus('⏳ Downloading ' + missing.length + ' missing days...', 'var(--am)');
  let done = 0;
  for (let i = 0; i < missing.length; i += 5) {
    await Promise.all(missing.slice(i, i + 5).map(async dk => {
      const r = await _ghGet(DATA_DIR + '/' + dk + '.json');
      if (r) try { localStorage.setItem(BHAV_PFX + dk, JSON.stringify(r.data)); } catch(e) {}
      done++;
    }));
    if (log) log.textContent = 'Downloaded ' + done + '/' + missing.length + ' days...';
  }

  localStorage.setItem(BHAV_IDX, JSON.stringify(ghDates));
  setGHStatus('✅ Synced — ' + ghDates.length + ' days from GitHub', 'var(--gn)');
  if (log) log.textContent = '✅ ' + ghDates.length + ' days synced';
  updateBhavStatus(); renderBhavCalendar(); checkBhavGaps();
  bhavGapBanner(); bhavAutoFill(); buildCommand();
}

// ── NSE trading days helper (uses isTradingDay from app.js) ────
function nseTradingDays(from, to) {
  const days = [];
  const d = new Date(from); d.setHours(0, 0, 0, 0);
  const end = new Date(to); end.setHours(0, 0, 0, 0);
  while (d <= end) {
    if (isTradingDay(new Date(d))) days.push(_dk(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

// ── Date helpers ───────────────────────────────────────────────
// BUG FIX (v2.0.2): Always use local date parts (getFullYear/Month/Date)
// not UTC methods. JS Date at midnight IST = previous day UTC (+5:30 offset),
// so getUTCDate() would return wrong day on any IST device. getDate() is safe.
function _dk(d) {
  return d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0');
}

function _dkToDate(dk) {
  return new Date(+dk.slice(0, 4), +dk.slice(4, 6) - 1, +dk.slice(6, 8));
}

function _parseBhavDate(s) {
  const M = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
  const p = (s || '').trim().split('-');
  if (p.length !== 3 || M[p[1]] === undefined) return null;
  return new Date(+p[2], M[p[1]], +p[0]);
}

// ── Gap detection ──────────────────────────────────────────────
async function checkBhavGaps() {
  const el = document.getElementById('bhav-gap-alert'); if (!el) return;
  const uploaded = new Set(await bhavAllDates());
  const from     = new Date(2025, 10, 25);
  const today    = new Date(); today.setHours(0, 0, 0, 0);
  const yest     = new Date(today); yest.setDate(yest.getDate() - 1);
  const expected = nseTradingDays(from, yest);
  const missing  = expected.filter(dk => !uploaded.has(dk));

  if (!missing.length) { el.style.display = 'none'; return; }

  const MONTH = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fmt   = dk => { const d = _dkToDate(dk); return d.getDate() + '-' + MONTH[d.getMonth()]; };
  const recent = missing.slice(-5).map(fmt).join(', ');

  el.style.display = 'block';
  el.innerHTML =
    `<div style="font-weight:700;margin-bottom:3px">⚠️ ${missing.length} trading day(s) missing</div>` +
    `<div style="color:var(--muted);font-size:7.5px">Recent: <strong style="color:var(--rd)">${recent}` +
    `${missing.length > 5 ? ' + ' + (missing.length - 5) + ' more' : ''}</strong></div>` +
    `<div style="font-size:7.5px;margin-top:3px">Download from nseindia.com → F&amp;O Bhavcopy → upload below</div>`;
}

// ── Calendar ───────────────────────────────────────────────────
async function renderBhavCalendar() {
  const el = document.getElementById('bhav-calendar'); if (!el) return;
  const uploaded = new Set(await bhavAllDates());
  const from     = new Date(2025, 10, 25);
  const today    = new Date(); today.setHours(0, 0, 0, 0);
  const expected = nseTradingDays(from, today);
  if (!expected.length) { el.innerHTML = ''; return; }

  const MONTH = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const DAY   = ['Su','Mo','Tu','We','Th','Fr','Sa'];

  const byMonth = {};
  expected.forEach(dk => {
    const d  = _dkToDate(dk);
    const mk = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    if (!byMonth[mk]) byMonth[mk] = [];
    byMonth[mk].push(dk);
  });

  const total = expected.length;
  const done  = expected.filter(dk => uploaded.has(dk)).length;
  const pct   = total ? Math.round(done / total * 100) : 0;
  const barC  = pct >= 90 ? 'var(--gn)' : pct >= 70 ? 'var(--am)' : 'var(--rd)';

  let html =
    `<div style="background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin:4px 0">` +
    `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">` +
    `<div style="font-size:7.5px;font-weight:700;letter-spacing:1px;color:var(--muted);text-transform:uppercase">NSE Calendar — Nov 25 onwards</div>` +
    `<div style="font-size:9px;font-weight:700;color:${barC}">${done}/${total} (${pct}%)</div></div>` +
    `<div style="height:3px;background:var(--bg3);border-radius:2px;margin-bottom:8px;overflow:hidden">` +
    `<div style="height:100%;width:${pct}%;background:${barC};border-radius:2px"></div></div>`;

  Object.keys(byMonth).sort().slice(-4).forEach(mk => {
    const [yr, mo] = mk.split('-');
    const days  = byMonth[mk];
    const mDone = days.filter(dk => uploaded.has(dk)).length;
    html +=
      `<div style="margin-bottom:7px">` +
      `<div style="font-size:7px;color:var(--muted);margin-bottom:3px;display:flex;justify-content:space-between">` +
      `<span style="font-weight:600">${MONTH[+mo - 1]} ${yr}</span>` +
      `<span>${mDone}/${days.length}</span></div>` +
      `<div style="display:flex;flex-wrap:wrap;gap:2px">`;

    days.forEach(dk => {
      const d    = _dkToDate(dk);
      const isUp = uploaded.has(dk), isTd = _dk(today) === dk;
      const bg   = isUp ? 'rgba(0,200,100,0.13)'  : isTd ? 'rgba(255,165,0,0.13)'  : 'rgba(200,33,62,0.08)';
      const bc   = isUp ? 'rgba(0,200,100,0.3)'   : isTd ? 'rgba(255,165,0,0.45)'  : 'rgba(200,33,62,0.22)';
      const col  = isUp ? 'var(--gn)' : isTd ? 'var(--am)' : 'var(--rd)';
      const ic   = isUp ? '✓' : isTd ? '·' : '✗';
      html +=
        `<div style="background:${bg};border:1px solid ${bc};border-radius:3px;` +
        `padding:2px 4px;text-align:center;min-width:26px;cursor:${isUp ? 'default' : 'pointer'}" ` +
        `title="${DAY[d.getDay()]} ${d.getDate()}-${MONTH[+mo-1]} ${isUp ? '✅ Uploaded' : '❌ Missing — tap to upload'}" ` +
        `onclick="${isUp ? '' : 'triggerBhavUpload()'}">` +
        `<div style="font-size:5.5px;color:${col}">${DAY[d.getDay()]}</div>` +
        `<div style="font-family:var(--font-mono);font-size:7.5px;font-weight:700;color:${col}">${d.getDate()}</div>` +
        `<div style="font-size:5.5px;color:${col}">${ic}</div></div>`;
    });
    html += `</div></div>`;
  });

  html +=
    `<div style="display:flex;gap:10px;margin-top:4px;font-size:7px;color:var(--muted)">` +
    `<span><span style="color:var(--gn)">✓</span> Uploaded</span>` +
    `<span><span style="color:var(--rd)">✗</span> Missing (tap)</span>` +
    `<span><span style="color:var(--am)">·</span> Today</span></div></div>`;

  el.innerHTML = html;
}

function triggerBhavUpload() {
  const i = document.getElementById('bhav-file-input');
  if (i) i.click();
}

// ── CSV parse + save ───────────────────────────────────────────
function loadBhavFiles(evt) {
  const files = Array.from(evt.target.files); if (!files.length) return;
  const log = document.getElementById('bhav-log');
  if (log) log.textContent = 'Reading ' + files.length + ' file(s)...';
  let done = 0, totalRec = 0;
  files.forEach(file => {
    const r = new FileReader();
    r.onload = async e => {
      const rec = await parseBhavCSV(e.target.result, file.name);
      totalRec += rec; done++;
      if (done === files.length) {
        if (log) log.textContent = '✅ ' + totalRec.toLocaleString() + ' records stored';
        updateBhavStatus(); renderBhavCalendar(); checkBhavGaps(); buildCommand();
        showToast('Bhav updated — ' + totalRec.toLocaleString() + ' records');
      }
    };
    r.onerror = () => { if (log) log.textContent = '❌ Failed: ' + file.name; };
    r.readAsText(file);
  });
  evt.target.value = '';
}

async function parseBhavCSV(text, fname) {
  const lines = text.split('\n'); if (lines.length < 2) return 0;
  const hdr = lines[0].split(',').map(h => h.trim());
  const col = name => hdr.findIndex(h => h.toLowerCase() === name.toLowerCase());

  // ── Detect format by header ────────────────────────────────
  // New unified NSE format: BhavCopy_NSE_FO_*.csv
  //   TradDt, XpryDt, TckrSymb, StrkPric, OptnTp, ClsPric, SttlmPric, OpnIntrst, UndrlygPric
  // Old per-symbol format: OPTIDX_NIFTY_CE_*.csv
  //   Date, Expiry, Option type, Strike Price, Close, Settle Price, Open Int, Underlying Value
  const isNewFormat = hdr.includes('TradDt') || hdr.includes('TckrSymb');

  let iDate, iExpiry, iSymbol, iType, iStrike, iClose, iSettle, iOI, iSpot;

  if (isNewFormat) {
    iDate   = col('TradDt');
    iExpiry = col('XpryDt');
    iSymbol = col('TckrSymb');
    iType   = col('OptnTp');
    iStrike = col('StrkPric');
    iClose  = col('ClsPric');
    iSettle = col('SttlmPric');
    iOI     = col('OpnIntrst');
    iSpot   = col('UndrlygPric');
  } else {
    iDate   = hdr.findIndex(h => h.toLowerCase().includes('date'));
    iExpiry = hdr.findIndex(h => h.toLowerCase().includes('expiry'));
    iSymbol = -1;  // old format is NIFTY-only, no symbol column needed
    iType   = hdr.findIndex(h => h.toLowerCase().includes('option type'));
    iStrike = hdr.findIndex(h => h.toLowerCase().includes('strike'));
    iClose  = hdr.findIndex(h => h.toLowerCase().includes('close'));
    iSettle = hdr.findIndex(h => h.toLowerCase().includes('settle'));
    iOI     = hdr.findIndex(h => h.toLowerCase().includes('open int'));
    iSpot   = hdr.findIndex(h => h.toLowerCase().includes('underlying'));
  }

  if (iDate < 0 || iStrike < 0 || iSpot < 0) {
    console.warn('Unrecognised bhav format:', fname, hdr.slice(0,5));
    return 0;
  }

  // ── Date parsing ──────────────────────────────────────────
  // New format: YYYY-MM-DD   Old format: DD-Mon-YYYY
  const parseDate = s => {
    s = (s || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      // ISO: 2026-02-27
      const [yr, mo, dy] = s.split('-');
      return new Date(+yr, +mo - 1, +dy);
    }
    return _parseBhavDate(s);  // old DD-Mon-YYYY
  };

  const byDate = {}; let count = 0;

  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',').map(v => v.trim());
    if (c.length < 6) continue;

    // New format: filter to NIFTY only (file contains all symbols)
    if (isNewFormat && iSymbol >= 0 && c[iSymbol] !== 'NIFTY') continue;

    const dateObj   = parseDate(c[iDate]);
    const expiryObj = iExpiry >= 0 ? parseDate(c[iExpiry]) : null;
    if (!dateObj || !expiryObj || isNaN(dateObj.getTime())) continue;

    const optType = c[iType]?.trim();
    if (optType !== 'CE' && optType !== 'PE') continue;

    const strike = parseFloat(c[iStrike]);
    const spot   = parseFloat(c[iSpot]);
    if (isNaN(strike) || isNaN(spot) || Math.abs(strike - spot) > BHAV_SPREAD) continue;

    const closeP = parseFloat(c[iClose]);
    const settle = iSettle >= 0 ? parseFloat(c[iSettle]) : NaN;
    const price  = (!isNaN(closeP) && closeP > 0) ? closeP
                 : (!isNaN(settle) && settle > 0)  ? settle
                 : null;
    if (price === null) continue;

    const oi = iOI >= 0 ? parseFloat(c[iOI]) : NaN;
    const dk = _dk(dateObj), ek = _dk(expiryObj);

    if (!byDate[dk]) byDate[dk] = { spot, opts: {}, pe_oi: {}, ce_oi: {}, oi_max_pe: {}, oi_max_ce: {}, uploaded_at: Date.now() };
    byDate[dk].spot = spot;
    byDate[dk].opts[optType + '_' + Math.round(strike) + '_' + ek] = price;
    if (!isNaN(oi) && oi > 0) {
      if (optType === 'PE') {
        byDate[dk].pe_oi[ek] = (byDate[dk].pe_oi[ek] || 0) + oi;
        if (oi > (byDate[dk].oi_max_pe[ek]?.oi || 0))
          byDate[dk].oi_max_pe[ek] = { strike: Math.round(strike), oi };
      }
      if (optType === 'CE') {
        byDate[dk].ce_oi[ek] = (byDate[dk].ce_oi[ek] || 0) + oi;
        if (oi > (byDate[dk].oi_max_ce[ek]?.oi || 0))
          byDate[dk].oi_max_ce[ek] = { strike: Math.round(strike), oi };
      }
    }
    count++;
  }

  const log = document.getElementById('bhav-log');
  for (const [dk, data] of Object.entries(byDate)) {
    // Compute PCR per expiry
    data.pcr = {};
    const eks = new Set([...Object.keys(data.pe_oi), ...Object.keys(data.ce_oi)]);
    eks.forEach(ek => {
      const pe = data.pe_oi[ek] || 0, ce = data.ce_oi[ek] || 0;
      if (ce > 0) data.pcr[ek] = +(pe / ce).toFixed(3);
    });
    // Compute OI walls per expiry: { [ek]: { ce: strike, pe: strike } }
    data.oi_walls = {};
    eks.forEach(ek => {
      data.oi_walls[ek] = {
        ce: data.oi_max_ce[ek]?.strike || null,
        pe: data.oi_max_pe[ek]?.strike || null
      };
    });
    delete data.pe_oi; delete data.ce_oi;
    delete data.oi_max_pe; delete data.oi_max_ce;
    if (log) log.textContent = 'Saving ' + dk + ' → data/' + dk + '.json...';
    await bhavSave(dk, data);
  }
  // After upload: refresh UI, auto-fill Strategy tab, update gap banner
  updateBhavStatus(); renderBhavCalendar(); checkBhavGaps();
  bhavGapBanner(); bhavAutoFill();
  return count;
}

// ── Lookup helpers — used by app.js buildCommand ───────────────
function bhavPrice(type, strike, expiryDate) {
  const d = _bhavLatestData(); if (!d) return null;
  const v = d.opts[type + '_' + Math.round(strike) + '_' + _dk(expiryDate)];
  return v !== undefined ? v : null;
}

function bhavIC(callSell, callBuy, putSell, putBuy, expiryDate) {
  const cs = bhavPrice('CE', callSell, expiryDate), cb = bhavPrice('CE', callBuy, expiryDate);
  const ps = bhavPrice('PE', putSell,  expiryDate), pb = bhavPrice('PE', putBuy,  expiryDate);
  if (cs === null || cb === null || ps === null || pb === null) return null;
  return { cs, cb, ps, pb,
    callNet: +(cs - cb).toFixed(2),
    putNet:  +(ps - pb).toFixed(2),
    total:   +(cs - cb + ps - pb).toFixed(2) };
}

function bhavATR() {
  const dates = JSON.parse(localStorage.getItem(BHAV_IDX) || '[]');
  if (dates.length < 5) return null;
  const spots = dates.slice(-14)
    .map(dk => { try { const d = JSON.parse(localStorage.getItem(BHAV_PFX + dk) || 'null'); return d ? d.spot : null; } catch(e) { return null; } })
    .filter(v => v !== null);
  if (spots.length < 5) return null;
  const mean = spots.reduce((a, b) => a + b, 0) / spots.length;
  return Math.round(Math.sqrt(spots.reduce((a, b) => a + (b - mean) ** 2, 0) / spots.length) * 1.5);
}

function bhavPCR(expiryDate) {
  const d = _bhavLatestData();
  return (d && d.pcr) ? (d.pcr[_dk(expiryDate)] ?? null) : null;
}

// ── OI wall lookup — nearest expiry matching the trade window ─────
function bhavOIWalls(expiryDate) {
  const d = _bhavLatestData(); if (!d || !d.oi_walls) return null;
  const ek = _dk(expiryDate);
  return d.oi_walls[ek] || null;
}

// ── bhavAutoFill v2.3.0: ATR-only fill + baseline card + hints ────────────────
// Spot/PCR/OI walls = user enters LIVE values. ATR = computed from bhav only.
// Bhav values shown as reference hints in Strategy tab for comparison.
function bhavAutoFill() {
  const dates = JSON.parse(localStorage.getItem(BHAV_IDX) || '[]');
  if (!dates.length) return;
  const d = _bhavLatestData();
  if (!d) return;

  // Auto-fill ATR only (no live equivalent — derived from rolling bhav spots)
  const atr = bhavATR();
  if (atr) {
    const el = document.getElementById('nf_atr');
    if (el && !el.value) {
      el.value = atr;
      const ts = document.getElementById('ts-nf_atr');
      if (ts) { ts.textContent = 'AUTO · bhav ' + bhavLatestLabel(); ts.className = 'igrid-ts'; }
    }
  }

  // Render baseline reference card in Breadth tab
  renderBhavBaseline();

  // Render hint values below Strategy tab inputs
  renderBhavHints();

  // Trigger strategy recalculation
  if (typeof buildCommand === 'function') buildCommand();
}

// ── Baseline reference card — rendered in Breadth tab ─────────────────────────
function renderBhavBaseline() {
  const el = document.getElementById('bhav-baseline');
  if (!el) return;

  const d = _bhavLatestData();
  if (!d) { el.style.display = 'none'; return; }

  const label = bhavLatestLabel();
  const spot  = Math.round(d.spot);
  const atr   = bhavATR() || '—';

  let nearestExpiry = null;
  try { nearestExpiry = getExpiries('NF')[0]?.date; } catch(e) {}
  const ek = nearestExpiry ? _dk(nearestExpiry) : null;

  const pcr      = (ek && d.pcr && d.pcr[ek] != null) ? d.pcr[ek].toFixed(2) : '—';
  const callWall = (ek && d.oi_walls && d.oi_walls[ek] && d.oi_walls[ek].ce) ? d.oi_walls[ek].ce.toLocaleString('en-IN') : '—';
  const putWall  = (ek && d.oi_walls && d.oi_walls[ek] && d.oi_walls[ek].pe) ? d.oi_walls[ek].pe.toLocaleString('en-IN') : '—';

  el.style.display = 'block';
  el.innerHTML =
    `<div style="margin:0 0 4px;font-size:9px;font-weight:700;color:var(--tl);letter-spacing:0.5px">` +
    `📊 YESTERDAY'S CLOSE <span style="font-weight:400;color:var(--muted);font-size:8px">${label}</span></div>` +
    `<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;font-size:9px;line-height:1.8">` +
    `<div><span style="color:var(--muted)">Spot</span> <span style="font-family:var(--font-mono);font-weight:700">${spot.toLocaleString('en-IN')}</span></div>` +
    `<div><span style="color:var(--muted)">Vol Proxy</span> <span style="font-family:var(--font-mono);font-weight:700">${atr}</span></div>` +
    `<div><span style="color:var(--muted)">PCR</span> <span style="font-family:var(--font-mono);font-weight:700">${pcr}</span></div>` +
    `<div><span style="color:var(--muted)">Call Wall</span> <span style="font-family:var(--font-mono);font-weight:700">${callWall}</span></div>` +
    `<div style="grid-column:1/-1"><span style="color:var(--muted)">Put Wall</span> <span style="font-family:var(--font-mono);font-weight:700">${putWall}</span>` +
    `</div></div>`;
}

// ── Hint values below Strategy tab inputs ─────────────────────────────────────
function renderBhavHints() {
  const d = _bhavLatestData();
  if (!d) return;

  const label = bhavLatestLabel();
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dk = _bhavLatestDK();
  const dayName = dk ? (() => {
    const dt = _dkToDate(dk);
    return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dt.getDay()];
  })() : '';

  let nearestExpiry = null;
  try { nearestExpiry = getExpiries('NF')[0]?.date; } catch(e) {}
  const ek = nearestExpiry ? _dk(nearestExpiry) : null;

  const hints = {
    'nf_price':   Math.round(d.spot).toLocaleString('en-IN'),
    'pcr_nf':     (ek && d.pcr && d.pcr[ek] != null) ? d.pcr[ek].toFixed(2) : null,
    'nf_oi_call': (ek && d.oi_walls && d.oi_walls[ek] && d.oi_walls[ek].ce) ? d.oi_walls[ek].ce.toLocaleString('en-IN') : null,
    'nf_oi_put':  (ek && d.oi_walls && d.oi_walls[ek] && d.oi_walls[ek].pe) ? d.oi_walls[ek].pe.toLocaleString('en-IN') : null,
  };

  Object.entries(hints).forEach(([id, val]) => {
    const hint = document.getElementById('bhav-hint-' + id);
    if (hint && val) {
      hint.textContent = `ref: ${val} (${dayName} close)`;
      hint.style.display = 'block';
    }
  });
}

// ── Drift score — spot + OI wall shift vs yesterday's bhav ────────────────────
// Returns { score: ±0.25 max, spotDrift, wallDrift, refSpot, refCallWall, refPutWall }
// Called from app.js buildCommand() with live Strategy tab values
function bhavDriftScore(liveSpot, liveCallWall, livePutWall) {
  const d   = _bhavLatestData();
  const atr = bhavATR();
  if (!d || !atr || !liveSpot) return null;

  let nearestExpiry = null;
  try { nearestExpiry = getExpiries('NF')[0]?.date; } catch(e) {}
  const ek = nearestExpiry ? _dk(nearestExpiry) : null;

  const refSpot     = d.spot;
  const refCallWall = (ek && d.oi_walls && d.oi_walls[ek]) ? d.oi_walls[ek].ce : null;
  const refPutWall  = (ek && d.oi_walls && d.oi_walls[ek]) ? d.oi_walls[ek].pe : null;

  // Spot drift: how many ATRs has spot moved from yesterday's close
  const spotDrift = Math.max(-1, Math.min(1, (liveSpot - refSpot) / atr));

  // OI wall shift: average movement of both walls in ATR units
  let wallDrift = 0;
  let wallCount = 0;
  if (refCallWall && liveCallWall) { wallDrift += (liveCallWall - refCallWall) / atr; wallCount++; }
  if (refPutWall  && livePutWall)  { wallDrift += (livePutWall  - refPutWall)  / atr; wallCount++; }
  if (wallCount > 0) wallDrift = Math.max(-1, Math.min(1, wallDrift / wallCount));

  // Combined drift: spot (60%) + wall shift (40%), max ±0.25
  const raw   = spotDrift * 0.60 + (wallCount > 0 ? wallDrift * 0.40 : 0);
  const score = Math.max(-0.25, Math.min(0.25, raw));

  const spotPts = Math.round(liveSpot - refSpot);
  const dir     = score > 0.05 ? '↑' : score < -0.05 ? '↓' : '→';

  return {
    score,
    spotDrift,
    wallDrift: wallCount > 0 ? wallDrift : null,
    refSpot,
    refCallWall,
    refPutWall,
    spotPts,
    dir,
    label: bhavLatestLabel(),
  };
}

function _bhavFillIfEmpty(id, val) {
  const el = document.getElementById(id);
  if (el && (el.value === '' || el.value === null)) el.value = val;
}

// ── Gap banner — shown in Strategy tab (Panel 3) ──────────────────
// 0 days missing  → hidden
// 1 day missing   → amber soft warning
// 2+ days missing → red warning (ATR accuracy affected)
async function bhavGapBanner() {
  const el = document.getElementById('bhav-gap-strategy'); if (!el) return;
  const uploaded = new Set(await bhavAllDates());
  if (!uploaded.size) { el.style.display = 'none'; return; }

  const today    = new Date(); today.setHours(0,0,0,0);
  const yest     = new Date(today); yest.setDate(yest.getDate() - 1);
  // Only look at last 14 trading days — older gaps don't affect ATR
  const from14   = new Date(today); from14.setDate(from14.getDate() - 20);
  const expected = nseTradingDays(from14, yest);
  const missing  = expected.filter(dk => !uploaded.has(dk));

  if (!missing.length) { el.style.display = 'none'; return; }

  const MONTH = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fmt   = dk => { const d = _dkToDate(dk); return d.getDate() + '-' + MONTH[d.getMonth()]; };
  const gap   = missing.length;
  const isRed = gap >= 2;
  const bc    = isRed ? 'rgba(200,33,62,0.25)' : 'rgba(176,110,0,0.25)';
  const bg    = isRed ? 'rgba(200,33,62,0.07)' : 'rgba(176,110,0,0.07)';
  const col   = isRed ? 'var(--rd)' : 'var(--am)';
  const icon  = isRed ? '⚠️' : '📅';
  const msg   = isRed
    ? `${gap} bhav days missing — ATR may be inaccurate. Upload in Smarts tab before trading.`
    : `Yesterday's bhav not uploaded yet. Auto-fill will update once you upload.`;
  const dates = missing.slice(-3).map(fmt).join(', ');

  el.style.display = 'block';
  el.innerHTML =
    `<div style="display:flex;align-items:flex-start;gap:10px;padding:10px 14px;` +
    `background:${bg};border-bottom:1px solid ${bc}">` +
    `<div style="font-size:18px;flex-shrink:0">${icon}</div>` +
    `<div>` +
    `<div style="font-size:10px;font-weight:700;color:${col};margin-bottom:2px">` +
    `BHAV GAP · ${gap} DAY${gap>1?'S':''} MISSING</div>` +
    `<div style="font-size:8.5px;color:var(--muted);line-height:1.5">${msg}</div>` +
    `<div style="font-size:8px;color:${col};margin-top:3px;font-family:var(--font-mono)">${dates}${gap>3?' + '+(gap-3)+' more':''}</div>` +
    `</div></div>`;
}

function bhavLatestLabel() {
  const dk = _bhavLatestDK(); if (!dk) return null;
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return dk.slice(6) + '-' + M[+dk.slice(4, 6) - 1] + '-' + dk.slice(0, 4);
}

// Clear local cache (GitHub data untouched — sync to restore)
function clearBhavData() {
  const dates = JSON.parse(localStorage.getItem(BHAV_IDX) || '[]');
  dates.forEach(dk => localStorage.removeItem(BHAV_PFX + dk));
  localStorage.removeItem(BHAV_IDX);
  updateBhavStatus(); renderBhavCalendar(); checkBhavGaps(); buildCommand();
  showToast('Local cache cleared — tap Sync Cloud to restore from GitHub');
}

// ── Debug sync — shows exact failure reason ──────────────────
async function bhavDebugSync() {
  const cfg = getGHConfig();
  const log = document.getElementById('bhav-log');
  const setLog = m => { if (log) log.textContent = m; };

  if (!cfg) { setLog('❌ No config — login.json not loaded'); return; }
  setLog('Config: ' + cfg.owner + '/' + cfg.repo + ' token=' + cfg.token.slice(0,8) + '...');

  // Test 1: repo access
  try {
    const r1 = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}`,
      { headers: _ghHeaders(cfg) });
    setLog('Repo access: HTTP ' + r1.status + (r1.ok ? ' ✅' : ' ❌'));
    if (!r1.ok) return;
  } catch(e) { setLog('Repo access: network error — ' + e.message); return; }

  // Test 2: read index.json
  try {
    const r2 = await fetch(
      `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/data/index.json`,
      { headers: _ghHeaders(cfg) });
    setLog('data/index.json: HTTP ' + r2.status + (r2.ok ? ' ✅' : ' ❌'));
    if (r2.ok) {
      const d = await r2.json();
      const parsed = JSON.parse(atob(d.content.replace(/\n/g,'')));
      setLog('index.json: ' + parsed.dates.length + ' dates ✅ — tap Sync Cloud now');
    } else if (r2.status === 404) {
      setLog('data/index.json: 404 — data folder not found in repo');
    } else if (r2.status === 401) {
      setLog('Token expired or wrong permissions — regenerate PAT with Contents: Read & Write');
    } else if (r2.status === 403) {
      setLog('Token forbidden — check PAT scope includes this private repo');
    }
  } catch(e) { setLog('index.json read error: ' + e.message); }
}

// ── Status summary ─────────────────────────────────────────────
async function updateBhavStatus() {
  const el = document.getElementById('bhav-status'); if (!el) return;
  const dates = await bhavAllDates();
  if (!dates.length) {
    el.innerHTML = `<div style="font-size:9px;color:var(--muted);padding:4px 0">
      No bhav data yet. Upload CE + PE files below — strategy uses model estimates until loaded.</div>`;
    return;
  }
  const atr = bhavATR(), label = bhavLatestLabel(), d = _bhavLatestData();
  const opts = d ? Object.keys(d.opts).length : 0;
  const cfg  = getGHConfig();
  el.innerHTML =
    `<div style="background:var(--bg2);border:1px solid rgba(0,200,100,0.2);border-radius:6px;padding:8px 12px;margin:4px 0">` +
    `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-bottom:6px">` +
    `<div style="text-align:center"><div style="font-size:6.5px;color:var(--muted);text-transform:uppercase">Days</div>` +
    `<div style="font-family:var(--font-mono);font-size:15px;font-weight:800;color:var(--tl)">${dates.length}</div></div>` +
    `<div style="text-align:center"><div style="font-size:6.5px;color:var(--muted);text-transform:uppercase">Latest</div>` +
    `<div style="font-size:8px;font-weight:700;color:var(--gn);margin-top:3px">${label}</div></div>` +
    `<div style="text-align:center"><div style="font-size:6.5px;color:var(--muted);text-transform:uppercase">Vol Proxy</div>` +
    `<div style="font-family:var(--font-mono);font-size:15px;font-weight:800;color:${atr ? 'var(--am)' : 'var(--muted)'}">` + (atr || '—') + `</div></div>` +
    `<div style="text-align:center"><div style="font-size:6.5px;color:var(--muted);text-transform:uppercase">Storage</div>` +
    `<div style="font-size:8px;font-weight:700;color:${cfg ? 'var(--gn)' : 'var(--am)'};margin-top:3px">${cfg ? '☁️ GitHub' : '💾 Local'}</div></div></div>` +
    `<div style="font-size:7.5px;color:var(--gn);text-align:center;padding-top:4px;border-top:1px solid var(--border)">` +
    `✅ ${opts.toLocaleString()} prices · Strategy uses actual market premiums</div></div>`;
}

// ── Startup — called from app.js ───────────────────────────────
async function loadFBConfig() {
  setGHStatus('⏳ Loading credentials...', 'var(--am)');
  const st = document.getElementById('fb-sync-status');
  if (st) st.style.display = 'block';

  const cfg = await bootstrapConfig();

  if (cfg) {
    setGHStatus('✅ ' + cfg.owner + '/' + cfg.repo + '/data/ · credentials from login.json', 'var(--gn)');
    document.getElementById('fb-config-notice').style.display = 'none';
    // Kick off a background sync
    updateBhavStatus();
    renderBhavCalendar();
    checkBhavGaps();
    bhavGapBanner();   // populate Strategy tab gap banner on load
    bhavAutoFill();    // pre-fill Strategy tab if data exists
  } else {
    // No credentials anywhere — show setup panel
    const el = document.getElementById('fb-config-notice');
    if (el) el.style.display = 'block';
    setGHStatus('💾 Local only — enter repo location to load login.json', 'var(--am)');
  }
}
