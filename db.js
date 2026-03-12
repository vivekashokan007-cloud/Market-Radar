/* ============================================================
   db.js — Market Radar v5.0 — Phase 2
   Supabase layer: trade_log CRUD
   ============================================================ */

const SUPABASE_URL = 'https://fdynxkfxohbnlvayouje.supabase.co';
const SUPABASE_KEY = 'sb_publishable-ZQNND9OdKGrdBt55hmdmOQ_sKp6p2C6';

let _db = null;

function getDB() {
  if (!_db) {
    try {
      _db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    } catch(e) {
      console.warn('[db] Supabase not ready:', e.message);
    }
  }
  return _db;
}

// ── IST date helper ──
function todayIST() {
  const now = new Date();
  const ist = new Date(now.getTime() + (now.getTimezoneOffset() * 60000 + 19800000));
  return `${ist.getFullYear()}-${String(ist.getMonth()+1).padStart(2,'0')}-${String(ist.getDate()).padStart(2,'0')}`;
}

// ═══════════════════════════════════════════════════
// INSERT — Log a new trade
// ═══════════════════════════════════════════════════

async function dbInsertTrade(trade) {
  const db = getDB();
  if (!db) return { ok: false, error: 'DB not ready' };

  const row = {
    strategy_type: trade.strategy_type,
    index_key: trade.index_key,
    expiry: trade.expiry,
    entry_date: trade.entry_date || todayIST(),
    entry_spot: trade.entry_spot || null,
    entry_vix: trade.entry_vix || null,
    entry_premium: trade.entry_premium || null,
    max_profit: trade.max_profit || null,
    max_loss: trade.max_loss || null,
    target_profit: trade.target_profit || null,
    stop_loss: trade.stop_loss || null,
    lots: trade.lots || 1,
    status: 'OPEN'
  };

  // Flatten legs 1-4
  for (let i = 1; i <= 4; i++) {
    const leg = trade[`leg${i}`];
    if (leg) {
      row[`leg${i}_strike`] = leg.strike;
      row[`leg${i}_type`] = leg.type;
      row[`leg${i}_action`] = leg.action;
      row[`leg${i}_entry_ltp`] = leg.entry_ltp;
      row[`leg${i}_qty`] = leg.qty || null;
    }
  }

  const { data, error } = await db.from('trade_log').insert(row).select('id').single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: data.id };
}

// ═══════════════════════════════════════════════════
// UPDATE — Daily P&L refresh for open trade
// ═══════════════════════════════════════════════════

async function dbUpdateTrade(id, updates) {
  const db = getDB();
  if (!db) return { ok: false };

  const row = {
    current_premium: updates.current_premium,
    current_pnl: updates.current_pnl,
    current_spot: updates.current_spot,
    recommendation: updates.recommendation || 'HOLD',
    updated_at: new Date().toISOString()
  };

  // Allow updating target/SL if recalculated
  if (updates.target_profit != null) row.target_profit = updates.target_profit;
  if (updates.stop_loss != null) row.stop_loss = updates.stop_loss;
  if (updates.peak_pnl != null) row.peak_pnl = updates.peak_pnl;

  const { error } = await db.from('trade_log').update(row).eq('id', id);
  return error ? { ok: false, error: error.message } : { ok: true };
}

// ═══════════════════════════════════════════════════
// CLOSE — Mark trade as closed
// ═══════════════════════════════════════════════════

async function dbCloseTrade(id, exitData) {
  const db = getDB();
  if (!db) return { ok: false };

  const row = {
    status: exitData.status || 'CLOSED',
    exit_date: exitData.exit_date || todayIST(),
    exit_premium: exitData.exit_premium || null,
    actual_pnl: exitData.actual_pnl || null,
    exit_reason: exitData.exit_reason || 'MANUAL',
    current_pnl: exitData.actual_pnl || null,
    recommendation: 'CLOSED',
    updated_at: new Date().toISOString()
  };

  const { error } = await db.from('trade_log').update(row).eq('id', id);
  return error ? { ok: false, error: error.message } : { ok: true };
}

// ═══════════════════════════════════════════════════
// READ — Get trades by status
// ═══════════════════════════════════════════════════

async function dbGetOpenTrades() {
  const db = getDB();
  if (!db) return [];

  const { data, error } = await db.from('trade_log')
    .select('*')
    .eq('status', 'OPEN')
    .order('created_at', { ascending: false });

  if (error) { console.warn('[db] getOpenTrades error:', error.message); return []; }
  return data || [];
}

async function dbGetAllTrades(limit) {
  const db = getDB();
  if (!db) return [];

  const { data, error } = await db.from('trade_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit || 50);

  if (error) { console.warn('[db] getAllTrades error:', error.message); return []; }
  return data || [];
}

// ═══════════════════════════════════════════════════
// CHECK — Does this trade already exist in DB?
// Match by: index_key + expiry + leg1_strike + leg1_type + leg1_action + status=OPEN
// ═══════════════════════════════════════════════════

async function dbFindOpenTrade(indexKey, expiry, leg1Strike, leg1Type, leg1Action) {
  const db = getDB();
  if (!db) return null;

  const { data, error } = await db.from('trade_log')
    .select('*')
    .eq('status', 'OPEN')
    .eq('index_key', indexKey)
    .eq('expiry', expiry)
    .eq('leg1_strike', leg1Strike)
    .eq('leg1_type', leg1Type)
    .eq('leg1_action', leg1Action)
    .limit(1)
    .single();

  if (error || !data) return null;
  return data;
}

// ═══════════════════════════════════════════════════
// JOURNAL — Closed trades + stats
// ═══════════════════════════════════════════════════

async function dbGetClosedTrades(limit) {
  const db = getDB();
  if (!db) return [];

  const { data, error } = await db.from('trade_log')
    .select('*')
    .in('status', ['CLOSED', 'EXPIRED'])
    .order('exit_date', { ascending: false })
    .limit(limit || 20);

  if (error) { console.warn('[db] getClosedTrades error:', error.message); return []; }
  return data || [];
}

async function dbGetTradeStats() {
  const db = getDB();
  if (!db) return null;

  const { data, error } = await db.from('trade_log')
    .select('*')
    .in('status', ['CLOSED', 'EXPIRED']);

  if (error) { console.warn('[db] getTradeStats error:', error.message); return null; }
  if (!data || !data.length) return null;

  const total = data.length;
  const wins = data.filter(t => (t.actual_pnl || 0) > 0).length;
  const losses = data.filter(t => (t.actual_pnl || 0) <= 0).length;
  const totalPnl = data.reduce((s, t) => s + (t.actual_pnl || 0), 0);
  const avgPnl = totalPnl / total;
  const best = data.reduce((b, t) => (t.actual_pnl || 0) > (b.actual_pnl || 0) ? t : b, data[0]);
  const worst = data.reduce((w, t) => (t.actual_pnl || 0) < (w.actual_pnl || 0) ? t : w, data[0]);

  // Stats by strategy type
  const byStrat = {};
  for (const t of data) {
    const st = t.strategy_type || 'UNKNOWN';
    if (!byStrat[st]) byStrat[st] = { total: 0, wins: 0, pnl: 0 };
    byStrat[st].total++;
    if ((t.actual_pnl || 0) > 0) byStrat[st].wins++;
    byStrat[st].pnl += (t.actual_pnl || 0);
  }

  // Stats by Varsity tier (if stored)
  const byTier = {};
  for (const t of data) {
    const tier = t.varsity_tier || 'Unknown';
    if (!byTier[tier]) byTier[tier] = { total: 0, wins: 0, pnl: 0 };
    byTier[tier].total++;
    if ((t.actual_pnl || 0) > 0) byTier[tier].wins++;
    byTier[tier].pnl += (t.actual_pnl || 0);
  }

  return {
    total, wins, losses,
    winRate: total > 0 ? +((wins / total) * 100).toFixed(1) : 0,
    totalPnl: +totalPnl.toFixed(0),
    avgPnl: +avgPnl.toFixed(0),
    bestTrade: { pnl: best.actual_pnl || 0, type: best.strategy_type, index: best.index_key },
    worstTrade: { pnl: worst.actual_pnl || 0, type: worst.strategy_type, index: worst.index_key },
    byStrat, byTier
  };
}

// ═══════════════════════════════════════════════════
// EXPIRE — Mark expired OPEN trades
// ═══════════════════════════════════════════════════

async function dbExpireTrade(id, finalPnl) {
  const db = getDB();
  if (!db) return { ok: false };

  const row = {
    status: 'EXPIRED',
    exit_date: todayIST(),
    actual_pnl: finalPnl || 0,
    exit_reason: 'EXPIRY',
    recommendation: 'EXPIRED',
    updated_at: new Date().toISOString()
  };

  const { error } = await db.from('trade_log').update(row).eq('id', id);
  return error ? { ok: false, error: error.message } : { ok: true };
}

console.log('[db.js] v5.0 Phase 3 — trade_log + journal ready');
