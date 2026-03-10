/* ═══════════════════════════════════════════════════════════════
   upstox.js — Upstox API Integration for Market Radar v4.1
   Phase 1: Spot + VIX + Option Chain + Historical OHLC + Positions
   
   Fetches (all parallel):
   1. NF Spot, BNF Spot, India VIX
   2. NF Option Chain → PCR, OI Walls, Max Pain, IV map, ATM IV
   3. BNF Option Chain → same
   4. NF Historical OHLC (14-day) → ATR, prev close, close_char
   5. BNF Historical OHLC (14-day) → ATR
   6. Open F&O Positions + P&L
   7. Available Margins
═══════════════════════════════════════════════════════════════ */

const UPSTOX_API    = 'https://api.upstox.com/v2';
const UPSTOX_V3     = 'https://api.upstox.com/v3';
const UPSTOX_KEY    = 'ec42e3bc-566b-4438-8edf-861db047dc16';
const LS_TOKEN_KEY  = 'upstox_access_token';
const LS_TOKEN_DATE = 'upstox_token_date';

/* ─────────────────────────────────────────────────────────────
   TOKEN MANAGEMENT
───────────────────────────────────────────────────────────── */
function upstoxSaveToken(token) {
  const today = new Date().toISOString().slice(0, 10);
  localStorage.setItem(LS_TOKEN_KEY,  token.trim());
  localStorage.setItem(LS_TOKEN_DATE, today);
}

function upstoxGetToken() {
  const today = new Date().toISOString().slice(0, 10);
  if (localStorage.getItem(LS_TOKEN_DATE) !== today) return null;
  return localStorage.getItem(LS_TOKEN_KEY) || null;
}

function upstoxHeaders() {
  const token = upstoxGetToken();
  if (!token) return null;
  return { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' };
}

/* ─────────────────────────────────────────────────────────────
   CORE FETCH
───────────────────────────────────────────────────────────── */
async function upstoxFetch(path, base) {
  const headers = upstoxHeaders();
  if (!headers) throw new Error('NO_TOKEN');
  const url = (base || UPSTOX_API) + path;
  const res = await fetch(url, { headers });
  if (res.status === 401) throw new Error('TOKEN_EXPIRED');
  if (!res.ok) throw new Error('HTTP_' + res.status);
  return res.json();
}

/* ─────────────────────────────────────────────────────────────
   EXPIRY HELPERS
   Nifty: Thursday expiry; BNF: Wednesday expiry
   Holiday-aware using app.js NSE_HOLIDAYS_2026
───────────────────────────────────────────────────────────── */
function _isHoliday(d) {
  if (typeof NSE_HOLIDAYS_2026 === 'undefined') return false;
  return NSE_HOLIDAYS_2026.some(h =>
    h.getDate()===d.getDate() && h.getMonth()===d.getMonth() && h.getFullYear()===d.getFullYear()
  );
}

function _nextExpiry(targetDay) {
  // targetDay: 4=Thursday (NF), 3=Wednesday (BNF)
  const now  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  let d = new Date(now);
  const diff = (targetDay - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + diff);
  // Skip if holiday
  while (_isHoliday(d) || d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

function nfExpiry()  { return _nextExpiry(4); }
function bnfExpiry() { return _nextExpiry(3); }

/* ─────────────────────────────────────────────────────────────
   HISTORICAL DATE HELPERS
───────────────────────────────────────────────────────────── */
function _toDate(dStr) {
  const [y,m,d] = dStr.split('-').map(Number);
  return new Date(y, m-1, d);
}

function _fmtDate(d) {
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function _histDateRange(days) {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const to  = _fmtDate(ist);
  const from = new Date(ist);
  from.setDate(from.getDate() - (days * 2)); // extra buffer for weekends/holidays
  return { from: _fmtDate(from), to };
}

/* ─────────────────────────────────────────────────────────────
   1. SPOT + VIX
───────────────────────────────────────────────────────────── */
async function upstoxFetchSpots() {
  const keys = [
    'NSE_INDEX|Nifty 50',
    'NSE_INDEX|Nifty Bank',
    'NSE_INDEX|India VIX'
  ].join(',');
  const data = await upstoxFetch(`/market-quote/ltp?instrument_key=${encodeURIComponent(keys)}`);
  const d = data.data || {};
  return {
    nfSpot  : d['NSE_INDEX:Nifty 50']?.ltp   || null,
    bnfSpot : d['NSE_INDEX:Nifty Bank']?.ltp  || null,
    vix     : d['NSE_INDEX:India VIX']?.ltp   || null,
  };
}

/* ─────────────────────────────────────────────────────────────
   2. OPTION CHAIN → PCR, OI Walls, Max Pain, IV map, POP
───────────────────────────────────────────────────────────── */
async function upstoxFetchChain(indexKey, expiry) {
  const enc  = encodeURIComponent(indexKey);
  const data = await upstoxFetch(`/option/chain?instrument_key=${enc}&expiry_date=${expiry}`);
  const rows = data.data || [];
  if (!rows.length) return null;

  const pcr = rows[0]?.pcr || null;

  let totalCallOI = 0, totalPutOI = 0;
  let maxCallOI = 0, maxPutOI = 0;
  let callWall = null, putWall = null;
  const painMap = {};
  const ivMap   = {};

  rows.forEach(row => {
    const K       = row.strike_price;
    const callOI  = row.call_options?.market_data?.oi        || 0;
    const putOI   = row.put_options?.market_data?.oi         || 0;
    const callIV  = row.call_options?.option_greeks?.iv      || null;
    const putIV   = row.put_options?.option_greeks?.iv       || null;
    const callD   = row.call_options?.option_greeks?.delta   || null;
    const putD    = row.put_options?.option_greeks?.delta    || null;
    const callT   = row.call_options?.option_greeks?.theta   || null;
    const putT    = row.put_options?.option_greeks?.theta    || null;
    const callLTP = row.call_options?.market_data?.ltp       || null;
    const putLTP  = row.put_options?.market_data?.ltp        || null;
    const callPOP = row.call_options?.option_greeks?.pop     || null;
    const putPOP  = row.put_options?.option_greeks?.pop      || null;

    totalCallOI += callOI;
    totalPutOI  += putOI;
    if (callOI > maxCallOI) { maxCallOI = callOI; callWall = K; }
    if (putOI  > maxPutOI)  { maxPutOI  = putOI;  putWall  = K; }

    painMap[K] = { callOI, putOI };
    if (callIV || putIV) {
      ivMap[K] = { callIV, putIV, callDelta: callD, putDelta: putD,
                   callTheta: callT, putTheta: putT,
                   callLTP, putLTP, callPOP, putPOP };
    }
  });

  // Computed PCR
  const computedPCR = totalCallOI > 0
    ? Math.round((totalPutOI / totalCallOI) * 100) / 100
    : null;

  // Max Pain
  const strikes = Object.keys(painMap).map(Number).sort((a,b) => a-b);
  let minPain = Infinity, maxPainStrike = null;
  strikes.forEach(spot => {
    let pain = 0;
    strikes.forEach(K => {
      const { callOI, putOI } = painMap[K];
      if (spot > K) pain += (spot - K) * callOI;
      if (spot < K) pain += (K - spot) * putOI;
    });
    if (pain < minPain) { minPain = pain; maxPainStrike = spot; }
  });

  // ATM IV
  const spotApprox = rows[0]?.underlying_spot_price || null;
  let atmIV = null;
  if (spotApprox && Object.keys(ivMap).length) {
    const atmStrike = strikes.reduce((prev, K) =>
      Math.abs(K - spotApprox) < Math.abs(prev - spotApprox) ? K : prev, strikes[0]);
    const atm = ivMap[atmStrike];
    if (atm) atmIV = atm.callIV || atm.putIV;
  }

  return {
    pcr        : pcr || computedPCR,
    callWall,
    putWall,
    maxPain    : maxPainStrike,
    atmIV,
    ivMap,
    totalCallOI,
    totalPutOI,
    spotApprox,
    strikeCount: strikes.length
  };
}

/* ─────────────────────────────────────────────────────────────
   3. HISTORICAL OHLC → ATR14, prev close, close_char
   Uses v2 daily candles (1 year history available)
───────────────────────────────────────────────────────────── */
async function upstoxFetchHistorical(instrumentKey) {
  const { from, to } = _histDateRange(30);
  const enc  = encodeURIComponent(instrumentKey);
  const data = await upstoxFetch(`/historical-candle/${enc}/day/${to}/${from}`);
  const candles = data?.data?.candles || [];
  // Format: [timestamp, open, high, low, close, volume, oi]
  // Sorted newest first from API
  if (candles.length < 3) return null;

  // Sort oldest first for ATR calculation
  const sorted = [...candles].sort((a,b) => new Date(a[0]) - new Date(b[0]));

  // ATR14 — true range based
  const closes = sorted.map(c => c[4]);
  const highs  = sorted.map(c => c[2]);
  const lows   = sorted.map(c => c[3]);

  const trueRanges = [];
  for (let i = 1; i < sorted.length; i++) {
    const hl = highs[i]  - lows[i];
    const hc = Math.abs(highs[i]  - closes[i-1]);
    const lc = Math.abs(lows[i]   - closes[i-1]);
    trueRanges.push(Math.max(hl, hc, lc));
  }

  const period = Math.min(14, trueRanges.length);
  let atr;
  if (trueRanges.length >= period) {
    // Wilder's smoothing
    let atrVal = trueRanges.slice(0, period).reduce((s,v) => s+v, 0) / period;
    for (let i = period; i < trueRanges.length; i++) {
      atrVal = (atrVal * (period-1) + trueRanges[i]) / period;
    }
    atr = Math.round(atrVal);
  } else {
    atr = Math.round(trueRanges.reduce((s,v) => s+v, 0) / trueRanges.length);
  }

  // Previous close (most recent completed session)
  const prevClose     = closes[closes.length - 1];
  const prevPrevClose = closes.length >= 2 ? closes[closes.length - 2] : null;

  // Auto close_char
  let closeChar = 0;
  if (prevClose && prevPrevClose) {
    const changePct = (prevClose - prevPrevClose) / prevPrevClose * 100;
    closeChar = changePct >= 0.8 ? 2
              : changePct >= 0.3 ? 1
              : changePct >= -0.3 ? 0
              : changePct >= -0.8 ? -1 : -2;
  }

  return { atr, prevClose: Math.round(prevClose), closeChar, candles: sorted };
}

/* ─────────────────────────────────────────────────────────────
   4. OPEN POSITIONS
───────────────────────────────────────────────────────────── */
async function upstoxFetchPositions() {
  const data = await upstoxFetch('/portfolio/short-term-positions');
  const rows = (data.data || []).filter(p =>
    p.instrument_token?.includes('NSE_FO') ||
    p.instrument_token?.includes('NFO')   ||
    (p.trading_symbol && (p.trading_symbol.includes('NIFTY') || p.trading_symbol.includes('BANKNIFTY')))
  );
  return rows.map(p => ({
    symbol   : p.trading_symbol || p.instrument_token,
    qty      : p.quantity,
    avgPrice : p.average_price,
    ltp      : p.last_price,
    pnl      : p.pnl,
    product  : p.product,
    buyQty   : p.buy_quantity,
    sellQty  : p.sell_quantity,
    type     : _parsePositionType(p.trading_symbol || ''),
  }));
}

function _parsePositionType(sym) {
  if (sym.includes('CE')) return 'CE';
  if (sym.includes('PE')) return 'PE';
  return 'FUT';
}

/* ─────────────────────────────────────────────────────────────
   5. AVAILABLE MARGINS
───────────────────────────────────────────────────────────── */
async function upstoxFetchMargins() {
  const data = await upstoxFetch('/user/get-funds-and-margin?segment=SEC');
  const eq = data?.data?.equity || {};
  return {
    available: eq.available_margin || eq.net || null,
    used     : eq.used_margin      || null,
    total    : eq.net              || null,
  };
}

/* ─────────────────────────────────────────────────────────────
   MASTER AUTO-FILL — all fetches in parallel
───────────────────────────────────────────────────────────── */
async function upstoxAutoFill() {
  const btn    = document.getElementById('upstox-fetch-btn');
  const status = document.getElementById('upstox-status');

  if (!upstoxGetToken()) { upstoxShowTokenModal(); return; }

  if (btn) { btn.disabled = true; btn.textContent = '⏳ Fetching...'; }
  if (status) { status.style.color = 'var(--muted)'; status.textContent = 'Fetching live data...'; }

  try {
    const nfExp  = nfExpiry();
    const bnfExp = bnfExpiry();

    // 7 parallel fetches
    const [spots, nfChain, bnfChain, nfHist, bnfHist, positions, margins] =
      await Promise.allSettled([
        upstoxFetchSpots(),
        upstoxFetchChain('NSE_INDEX|Nifty 50',  nfExp),
        upstoxFetchChain('NSE_INDEX|Nifty Bank', bnfExp),
        upstoxFetchHistorical('NSE_INDEX|Nifty 50'),
        upstoxFetchHistorical('NSE_INDEX|Nifty Bank'),
        upstoxFetchPositions(),
        upstoxFetchMargins(),
      ]);

    const filled = [];
    const ts = new Date().toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' });

    // ── 1. Spots + VIX ──────────────────────────────────────
    if (spots.status === 'fulfilled' && spots.value) {
      const sv = spots.value;
      if (sv.nfSpot) {
        _set('nf_price', Math.round(sv.nfSpot));
        filled.push('NF Spot');
      }
      if (sv.bnfSpot) {
        _set('bn_price', Math.round(sv.bnfSpot));
        filled.push('BNF Spot');
      }
      if (sv.vix) {
        _set('india_vix', sv.vix.toFixed(2));
        _set('strat_vix',  sv.vix.toFixed(2));
        window._LIVE_VIX = sv.vix;
        filled.push('India VIX');
      }
    }

    // ── 2. NF Option Chain ───────────────────────────────────
    if (nfChain.status === 'fulfilled' && nfChain.value) {
      const c = nfChain.value;
      if (c.pcr)     { _set('pcr_nf',     c.pcr.toFixed(2)); filled.push('NF PCR'); }
      if (c.callWall){ _set('nf_oi_call', c.callWall);       filled.push('NF Call Wall'); }
      if (c.putWall) { _set('nf_oi_put',  c.putWall);        filled.push('NF Put Wall'); }
      if (c.maxPain) {
        _set('nf_maxpain',  c.maxPain);
        _set('max_pain_nf', c.maxPain);
        filled.push('NF Max Pain');
      }
      if (c.ivMap)  { window._NF_IV_MAP  = c.ivMap; }
      if (c.atmIV)  { window._NF_ATM_IV  = c.atmIV; }
    }

    // ── 3. BNF Option Chain ──────────────────────────────────
    if (bnfChain.status === 'fulfilled' && bnfChain.value) {
      const c = bnfChain.value;
      if (c.pcr)     { _set('pcr_bn',     c.pcr.toFixed(2)); filled.push('BNF PCR'); }
      if (c.callWall){ _set('bn_oi_call', c.callWall);       filled.push('BNF Call Wall'); }
      if (c.putWall) { _set('bn_oi_put',  c.putWall);        filled.push('BNF Put Wall'); }
      if (c.maxPain) { _set('bn_maxpain', c.maxPain);         filled.push('BNF Max Pain'); }
      if (c.ivMap)   { window._BNF_IV_MAP = c.ivMap; }
      if (c.atmIV)   { window._BNF_ATM_IV = c.atmIV; }
    }

    // ── 4. NF Historical → ATR + prev close + close_char ────
    if (nfHist.status === 'fulfilled' && nfHist.value) {
      const h = nfHist.value;
      if (h.atr)       { _set('nf_atr',     h.atr);          filled.push(`NF ATR ${h.atr}`); }
      if (h.prevClose) { _set('nifty_prev', h.prevClose);     filled.push('NF Prev Close'); }
      if (h.closeChar !== undefined) {
        // Auto-set close_char — only update if not manually overridden today
        const el = document.getElementById('close_char');
        if (el) {
          el.value = String(h.closeChar);
          const labels = {'2':'Strong ↑↑','1':'Mild ↑','0':'Neutral','-1':'Mild ↓','-2':'Weak ↓↓'};
          const note = document.getElementById('ts-close_char');
          if (note) {
            note.textContent = `Auto: ${labels[String(h.closeChar)]} (from prev close)`;
            note.className = 'ts fresh';
          }
          filled.push(`Close Char Auto`);
        }
      }
      window._NF_HIST = h;
    }

    // ── 5. BNF Historical → ATR ──────────────────────────────
    if (bnfHist.status === 'fulfilled' && bnfHist.value) {
      const h = bnfHist.value;
      if (h.atr) { _set('bn_atr', h.atr); filled.push(`BNF ATR ${h.atr}`); }
      window._BNF_HIST = h;
    }

    // ── 6. Positions ─────────────────────────────────────────
    if (positions.status === 'fulfilled') {
      const pos = positions.value || [];
      upstoxRenderPositions(pos);
      window._LIVE_POSITIONS = pos;
      if (pos.length) filled.push(`${pos.length} Position(s)`);
    } else {
      upstoxRenderPositions([]);
    }

    // ── 7. Margins ───────────────────────────────────────────
    if (margins.status === 'fulfilled' && margins.value) {
      upstoxRenderMargins(margins.value);
      filled.push('Margins');
    }

    // ── Trigger recalculation ─────────────────────────────────
    if (typeof calcScore    === 'function') calcScore();
    if (typeof buildCommand === 'function') buildCommand();

    // ── Update UI ─────────────────────────────────────────────
    if (btn)    { btn.disabled = false; btn.textContent = '✅ Live'; }
    if (status) {
      status.style.color = 'var(--gn)';
      status.textContent = `✅ ${filled.length} items · ${ts}`;
    }
    if (typeof toast === 'function') {
      toast(`✅ Live data: ${filled.slice(0,4).join(', ')}`);
    }

    localStorage.setItem('upstox_last_fetch',  ts);
    localStorage.setItem('upstox_last_expiry', nfExp);

  } catch(err) {
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Fetch Live'; }
    _handleFetchError(err, status);
  }
}

/* ─────────────────────────────────────────────────────────────
   POSITIONS RENDERER — PANEL 2
───────────────────────────────────────────────────────────── */
function upstoxRenderPositions(positions) {
  const box   = document.getElementById('upstox-positions');
  const empty = document.getElementById('positions-empty');
  if (!box) return;

  if (!positions || !positions.length) {
    box.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  const totalPnl = positions.reduce((s, p) => s + (p.pnl || 0), 0);
  const pnlColor = totalPnl >= 0 ? 'var(--gn)' : 'var(--rd)';
  const pnlSign  = totalPnl >= 0 ? '+' : '';

  box.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border);
      border-radius:8px;overflow:hidden;">
      <div style="background:var(--bg3);padding:10px 14px;
        display:flex;align-items:center;justify-content:space-between;">
        <div style="font-size:9px;font-weight:700;letter-spacing:1px;color:var(--muted);">
          OPEN POSITIONS (${positions.length})
        </div>
        <div style="font-family:var(--font-mono);font-size:14px;font-weight:700;color:${pnlColor};">
          ${pnlSign}₹${Math.round(totalPnl).toLocaleString('en-IN')}
        </div>
      </div>
      ${positions.map(p => {
        const pnlC  = (p.pnl||0) >= 0 ? 'var(--gn)' : 'var(--rd)';
        const qty   = Math.abs(p.qty || 0);
        const side  = (p.sellQty > p.buyQty) ? 'SELL' : 'BUY';
        const sideC = side === 'SELL' ? 'var(--rd)' : 'var(--gn)';
        const pSign = (p.pnl||0) >= 0 ? '+' : '';
        const typeTag = p.type === 'CE' ? '🔴 CE' : p.type === 'PE' ? '🟢 PE' : '📈 FUT';
        return `
        <div style="padding:10px 14px;border-top:1px solid var(--border);
          display:flex;align-items:center;gap:10px;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:9.5px;font-weight:700;color:var(--text);
              white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
              ${p.symbol}
            </div>
            <div style="font-size:8px;color:var(--muted);margin-top:2px;">
              <span style="color:${sideC};font-weight:700;">${side}</span>
              · ${qty} qty · Avg ₹${(p.avgPrice||0).toFixed(1)}
              · <span style="color:var(--tl)">${typeTag}</span>
            </div>
          </div>
          <div style="text-align:right;flex-shrink:0;">
            <div style="font-family:var(--font-mono);font-size:12px;font-weight:700;
              color:${pnlC};">${pSign}₹${Math.round(p.pnl||0).toLocaleString('en-IN')}</div>
            <div style="font-size:8px;color:var(--muted);">LTP ₹${(p.ltp||0).toFixed(1)}</div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
}

/* ─────────────────────────────────────────────────────────────
   MARGINS RENDERER — PANEL 2
───────────────────────────────────────────────────────────── */
function upstoxRenderMargins(m) {
  const card = document.getElementById('margins-card');
  if (!card) return;
  if (!m.available && !m.total) { card.style.display = 'none'; return; }

  card.style.display = 'block';
  const avail = m.available ? `₹${Math.round(m.available).toLocaleString('en-IN')}` : '—';
  const used  = m.used      ? `₹${Math.round(m.used).toLocaleString('en-IN')}` : '—';
  const total = m.total     ? `₹${Math.round(m.total).toLocaleString('en-IN')}` : '—';

  card.innerHTML = `
    <div style="font-size:8px;font-weight:700;letter-spacing:1.5px;color:var(--muted);
      text-transform:uppercase;margin-bottom:8px;">AVAILABLE MARGIN</div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
      <div>
        <div style="font-size:7.5px;color:var(--muted);">AVAILABLE</div>
        <div style="font-family:var(--font-mono);font-size:13px;font-weight:700;
          color:var(--gn);">${avail}</div>
      </div>
      <div>
        <div style="font-size:7.5px;color:var(--muted);">USED</div>
        <div style="font-family:var(--font-mono);font-size:13px;font-weight:700;
          color:var(--rd);">${used}</div>
      </div>
      <div>
        <div style="font-size:7.5px;color:var(--muted);">NET</div>
        <div style="font-family:var(--font-mono);font-size:13px;font-weight:700;">
          ${total}</div>
      </div>
    </div>`;
}

/* ─────────────────────────────────────────────────────────────
   REFRESH POSITIONS (called when switching to POSITIONS tab)
───────────────────────────────────────────────────────────── */
async function upstoxRefreshPositions() {
  if (!upstoxGetToken()) {
    document.getElementById('positions-empty').innerHTML = `
      <div style="font-size:28px;margin-bottom:10px;">🔑</div>
      <div style="font-size:12px;font-weight:700;">Token required</div>
      <div style="font-size:9px;margin-top:4px;">
        <button onclick="upstoxShowTokenModal()" style="background:var(--tl);color:#fff;
          border:none;border-radius:6px;padding:8px 16px;font-size:10px;cursor:pointer;">
          🔑 Paste Token
        </button>
      </div>`;
    return;
  }
  try {
    const [pos, marg] = await Promise.allSettled([
      upstoxFetchPositions(),
      upstoxFetchMargins(),
    ]);
    if (pos.status === 'fulfilled') upstoxRenderPositions(pos.value || []);
    if (marg.status === 'fulfilled') upstoxRenderMargins(marg.value);
  } catch(e) { console.error('Positions refresh error:', e); }
}

/* ─────────────────────────────────────────────────────────────
   FIELD SETTER — green flash on auto-fill
───────────────────────────────────────────────────────────── */
function _set(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.style.transition = 'border-color 0.3s';
  el.style.borderColor = 'var(--gn)';
  setTimeout(() => { el.style.borderColor = ''; }, 2500);
}

/* ─────────────────────────────────────────────────────────────
   ERROR HANDLER
───────────────────────────────────────────────────────────── */
function _handleFetchError(err, status) {
  console.error('Upstox error:', err.message);
  if (err.message === 'NO_TOKEN' || err.message === 'TOKEN_EXPIRED') {
    localStorage.removeItem(LS_TOKEN_KEY);
    localStorage.removeItem(LS_TOKEN_DATE);
    if (status) { status.style.color='var(--rd)'; status.textContent='⚠️ Token expired — tap 🔑'; }
    upstoxShowTokenModal();
  } else if (err.message?.includes('fetch') || err.message?.includes('Failed')) {
    if (status) { status.style.color='var(--am)'; status.textContent='⚠️ Network error — check connection'; }
  } else {
    if (status) { status.style.color='var(--rd)'; status.textContent='❌ ' + err.message; }
  }
}

/* ─────────────────────────────────────────────────────────────
   TOKEN MODAL
───────────────────────────────────────────────────────────── */
function upstoxShowTokenModal() {
  document.getElementById('upstox-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'upstox-modal';
  modal.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;
    background:rgba(0,0,0,0.75);z-index:9999;
    display:flex;align-items:center;justify-content:center;padding:20px;`;
  modal.innerHTML = `
    <div style="background:var(--bg1);border:1px solid var(--border);border-radius:12px;
      padding:20px;width:100%;max-width:380px;">
      <div style="font-family:var(--font-mono);font-size:13px;font-weight:700;
        color:var(--tl);margin-bottom:4px;">🔑 PASTE TODAY'S TOKEN</div>
      <div style="font-size:9px;color:var(--muted);margin-bottom:12px;line-height:1.8;">
        1. Go to <strong style="color:var(--text)">account.upstox.com/developer/apps</strong><br>
        2. Click <strong>⌄</strong> on Market Radar → <strong>Generate</strong><br>
        3. Complete Upstox login<br>
        4. Click the copy icon next to Access Token → paste below
      </div>
      <textarea id="upstox-token-input" autocomplete="off" autocorrect="off"
        style="width:100%;height:80px;background:var(--bg3);border:1px solid var(--border);
        border-radius:6px;padding:8px;font-size:9px;color:var(--text);
        font-family:var(--font-mono);resize:none;outline:none;"
        placeholder="eyJ0eXAiOiJKV1Qi..."></textarea>
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button onclick="upstoxSaveAndFetch()"
          style="flex:1;background:var(--tl);color:#fff;border:none;border-radius:6px;
          padding:10px;font-size:11px;font-weight:700;cursor:pointer;">
          ✅ Save &amp; Fetch Live Data
        </button>
        <button onclick="document.getElementById('upstox-modal').remove()"
          style="background:var(--bg3);color:var(--muted);border:1px solid var(--border);
          border-radius:6px;padding:10px 14px;font-size:11px;cursor:pointer;">✕</button>
      </div>
      <div style="font-size:8px;color:var(--dim);margin-top:8px;line-height:1.5;">
        ⏰ Token valid today only · Stored in your browser · Never sent anywhere
      </div>
    </div>`;
  document.body.appendChild(modal);
  setTimeout(() => document.getElementById('upstox-token-input')?.focus(), 150);
}

function upstoxSaveAndFetch() {
  const input = document.getElementById('upstox-token-input');
  if (!input?.value?.trim()) return;
  upstoxSaveToken(input.value.trim());
  document.getElementById('upstox-modal')?.remove();
  upstoxAutoFill();
}

/* ─────────────────────────────────────────────────────────────
   INIT — show last fetch status; auto-fetch if token present
───────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  // Update status bar with last fetch info
  const status = document.getElementById('upstox-status');
  const tok    = upstoxGetToken();
  const last   = localStorage.getItem('upstox_last_fetch');
  if (status) {
    if (tok && last) {
      status.style.color = 'var(--gn)';
      status.textContent = `Last fetch: ${last} · Tap 🔄 to refresh`;
    } else if (!tok) {
      status.style.color = 'var(--am)';
      status.textContent = 'Tap 🔑 to paste today\'s token · then 🔄 Fetch';
    }
  }

  // Auto-fetch if valid token exists (after a short delay for app.js to init)
  if (tok) {
    setTimeout(() => {
      upstoxAutoFill();
    }, 1200);
  } else {
    // No token — show modal after a moment
    setTimeout(() => {
      upstoxShowTokenModal();
    }, 2000);
  }
});
