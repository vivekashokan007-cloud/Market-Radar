// ═══════════════════════════════════════════════════════════
// MARKET RADAR v3.0 — db.js
// Supabase client — all read/write operations
// Sits between app.js and Supabase. bhav.js calls dbSaveBhav().
// ═══════════════════════════════════════════════════════════

// ── Client init ─────────────────────────────────────────────
const SUPABASE_URL = 'https://fdynxkfxohbnlvayouje.supabase.co';
const SUPABASE_KEY = 'sb_publishable_ZQNND9OdKGrdBt55hmdm0Q_sKp6p2C6';

// supabase-js loaded via CDN script tag in index.html (before db.js)
let _db = null;
function getDB() {
  if (!_db) {
    try {
      const { createClient } = window.supabase;
      _db = createClient(SUPABASE_URL, SUPABASE_KEY);
    } catch(e) {
      console.warn('[db] Supabase not loaded yet:', e.message);
    }
  }
  return _db;
}

// ── Connection test ─────────────────────────────────────────
async function dbPing() {
  const db = getDB();
  if (!db) return { ok: false, error: 'Client not initialised' };
  try {
    const { data, error } = await db.from('radar_inputs').select('id').limit(1);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

// ── BHAV OPTIONS — batch upsert ─────────────────────────────
// Called by bhav.js after parsing a CSV upload
// rows: array of { trade_date, option_type, strike, expiry_date,
//                  close_price, spot, dte, otm_pct, ann_vol }
async function dbSaveBhav(rows) {
  const db = getDB();
  if (!db || !rows || rows.length === 0) return { ok: false, error: 'No data' };

  // Add symbol column, compute missing fields
  const enriched = rows.map(r => ({
    symbol:      'NIFTY',
    trade_date:  r.trade_date,
    option_type: r.option_type,
    strike:      r.strike,
    expiry_date: r.expiry_date,
    close_price: r.close_price,
    spot:        r.spot,
    dte:         r.dte,
    otm_pct:     r.otm_pct !== undefined ? r.otm_pct
                   : (r.strike && r.spot ? (r.strike - r.spot) / r.spot : null),
    ann_vol:     r.ann_vol || null,
  }));

  // Batch in chunks of 500 (Supabase row limit per request)
  const CHUNK = 500;
  let inserted = 0, errors = [];
  for (let i = 0; i < enriched.length; i += CHUNK) {
    const chunk = enriched.slice(i, i + CHUNK);
    const { error } = await db
      .from('bhav_options')
      .upsert(chunk, { onConflict: 'trade_date,symbol,option_type,strike,expiry_date' });
    if (error) errors.push(error.message);
    else inserted += chunk.length;
  }

  if (errors.length) return { ok: false, error: errors[0], inserted };
  return { ok: true, inserted };
}

// ── RADAR INPUTS — save today's morning entry ───────────────
async function dbSaveRadar(data) {
  const db = getDB();
  if (!db) return { ok: false, error: 'DB not ready' };

  const row = {
    trade_date:      data.trade_date || todayIST(),
    sp500:           data.sp500       || null,
    dow:             data.dow         || null,
    us_vix:          data.usvix       || null,
    nikkei:          data.nk          || null,
    hang_seng:       data.hsi         || null,
    crude:           data.crude       || null,
    gold:            data.gold        || null,
    usd_inr:         data.inr         || null,
    us_10y_yield:    data.yld         || null,
    gift_now:        data.gift_now    || null,
    gift_6am:        data.gift_6am    || null,
    nifty_prev:      data.nifty_prev  || null,
    india_vix:       data.india_vix   || null,
    fii_cash:        data.fii         || null,
    fii_fut:         data.fii_fut     || null,
    fii_opt:         data.fii_opt     || null,
    dii_cash:        data.dii         || null,
    max_pain_nf:     data.max_pain_nf || null,
    max_pain_bn:     data.max_pain_bn || null,
    close_char:      data.close_char  !== undefined ? parseInt(data.close_char) : null,
    direction_score: data.score       || null,
    direction_label: data.direction   || null,
    strategy_auto:   data.strat_auto  || null,
    rbi_stance:      data.rbi         || null,
    liquidity:       data.liq         || null,
    news_event:      data.news        || null,
  };

  const { error } = await db
    .from('radar_inputs')
    .upsert(row, { onConflict: 'trade_date' });

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ── TRADES — log a new trade entry ─────────────────────────
async function dbLogTrade(t) {
  const db = getDB();
  if (!db) return { ok: false, error: 'DB not ready' };

  const row = {
    trade_date:    t.trade_date || todayIST(),
    symbol:        t.symbol || 'NIFTY',
    strategy:      t.strategy,          // 'BEAR_PUT','BEAR_CALL','IC','STRADDLE', etc.
    expiry_date:   t.expiry_date,
    leg1_type:     t.leg1_type   || null,
    leg1_action:   t.leg1_action || null,
    leg1_strike:   t.leg1_strike || null,
    leg1_entry:    t.leg1_entry  || null,
    leg2_type:     t.leg2_type   || null,
    leg2_action:   t.leg2_action || null,
    leg2_strike:   t.leg2_strike || null,
    leg2_entry:    t.leg2_entry  || null,
    leg3_type:     t.leg3_type   || null,
    leg3_action:   t.leg3_action || null,
    leg3_strike:   t.leg3_strike || null,
    leg3_entry:    t.leg3_entry  || null,
    leg4_type:     t.leg4_type   || null,
    leg4_action:   t.leg4_action || null,
    leg4_strike:   t.leg4_strike || null,
    leg4_entry:    t.leg4_entry  || null,
    lots:          t.lots || 1,
    lot_size:      t.lot_size || 65,
    net_credit:    t.net_credit  || null,
    status:        'OPEN',
    spot_at_entry: t.spot_at_entry || null,
    vix_at_entry:  t.vix_at_entry  || null,
    score_at_entry:t.score_at_entry || null,
    notes:         t.notes || null,
  };

  const { data, error } = await db
    .from('trades')
    .insert(row)
    .select('id')
    .single();

  if (error) return { ok: false, error: error.message };
  return { ok: true, id: data.id };
}

// ── TRADES — close/update a trade ──────────────────────────
async function dbCloseTrade(id, closeData) {
  const db = getDB();
  if (!db) return { ok: false, error: 'DB not ready' };

  const { error } = await db
    .from('trades')
    .update({
      exit_date:    closeData.exit_date || todayIST(),
      leg1_exit:    closeData.leg1_exit || null,
      leg2_exit:    closeData.leg2_exit || null,
      leg3_exit:    closeData.leg3_exit || null,
      leg4_exit:    closeData.leg4_exit || null,
      pnl_pts:      closeData.pnl_pts   || null,
      pnl_rs:       closeData.pnl_rs    || null,
      status:       closeData.status || 'CLOSED',
      exit_reason:  closeData.exit_reason || 'MANUAL',
      notes:        closeData.notes || null,
      updated_at:   new Date().toISOString(),
    })
    .eq('id', id);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ── TRADES — fetch recent trades ───────────────────────────
async function dbGetTrades(limit = 20) {
  const db = getDB();
  if (!db) return { ok: false, trades: [] };

  const { data, error } = await db
    .from('trades')
    .select('*')
    .order('trade_date', { ascending: false })
    .limit(limit);

  if (error) return { ok: false, error: error.message, trades: [] };
  return { ok: true, trades: data || [] };
}

// ── BHAV LOOKUP — straddle ratio lookup for credit estimate ─
// Returns ratio for (type, dte_bucket, otm_bucket, ann_vol)
// Used by estimates.js to replace the formula
async function dbGetStraddleRatio(optType, dteBucket, otmBucket, annVol) {
  const db = getDB();
  if (!db) return null;

  // Find 5 nearest rows by ann_vol
  const { data, error } = await db
    .from('straddle_ratios')
    .select('ratio, ann_vol, atm_straddle')
    .eq('option_type', optType)
    .eq('dte_bucket', dteBucket)
    .eq('otm_bucket', otmBucket)
    .order('ann_vol', { ascending: true })
    .limit(20);

  if (error || !data || data.length === 0) return null;

  // Inverse-distance weighted average by ann_vol proximity
  const target = annVol || 15;
  let wSum = 0, rSum = 0;
  for (const row of data) {
    const dist = Math.abs(row.ann_vol - target) + 0.1; // avoid /0
    const w = 1 / (dist * dist);
    wSum += w;
    rSum += w * row.ratio;
  }
  return wSum > 0 ? rSum / wSum : null;
}

// ── BHAV STATS — count of days uploaded ────────────────────
async function dbBhavStats() {
  const db = getDB();
  if (!db) return { days: 0, rows: 0 };

  const { data, error } = await db
    .from('bhav_options')
    .select('trade_date')
    .limit(10000);

  if (error || !data) return { days: 0, rows: 0 };
  const uniqueDays = new Set(data.map(r => r.trade_date));
  return { days: uniqueDays.size, rows: data.length };
}

// ── Helpers ─────────────────────────────────────────────────
function todayIST() {
  const now = new Date();
  const ist = new Date(now.getTime() + now.getTimezoneOffset()*60000 + 19800000);
  return `${ist.getFullYear()}-${String(ist.getMonth()+1).padStart(2,'0')}-${String(ist.getDate()).padStart(2,'0')}`;
}

// DTE bucket mapper (matches schema)
function dteBucket(dte) {
  if (dte <= 4)  return '1-4';
  if (dte <= 8)  return '5-8';
  if (dte <= 12) return '9-12';
  if (dte <= 21) return '13-21';
  return '22+';
}

// OTM bucket mapper (matches schema)
function otmBucket(otmPct, optType) {
  const d = Math.abs(otmPct || 0) * 100; // convert to %
  if (d <= 0.2) return 'ATM';
  if (d <= 0.8) return 'OTM1';
  if (d <= 1.5) return 'OTM2';
  if (d <= 2.5) return 'OTM3';
  return 'OTM4';
}

// Status badge for UI
function dbStatusBadge() {
  return document.getElementById('db-status-badge');
}

// Show connection status in UI
async function dbShowStatus() {
  const badge = dbStatusBadge();
  if (!badge) return;
  badge.textContent = '⏳ Connecting...';
  badge.style.color = 'var(--am)';
  const res = await dbPing();
  if (res.ok) {
    badge.textContent = '✅ Supabase connected';
    badge.style.color = 'var(--gn)';
    // Also show bhav stats
    const stats = await dbBhavStats();
    badge.textContent = `✅ DB connected · ${stats.days} days · ${stats.rows.toLocaleString('en-IN')} rows`;
  } else {
    badge.textContent = `⚠️ DB offline: ${res.error}`;
    badge.style.color = 'var(--am)';
  }
}
