/* ============================================================
   app.js — Market Radar v5.0 — Phase 3 Active
   EV-based scoring, Varsity multiplier, split display
   Auto-expire, trade journal, cumulative stats
   All 7 strategies × all expiries × both indices
   ============================================================ */

// ── Constants ──
const CAPITAL           = 110000;
const NF_LOT_SIZE       = 65;
const BNF_LOT           = 30;
const NF_MARGIN_PER_LOT = 97000;
const BNF_MARGIN_PER_LOT= 28000;
const MAX_RISK_PCT      = 0.05;
const NF_IC_WIDTH       = 200;
const BNF_IC_WIDTH      = 500;

const r50  = x => Math.round(x / 50) * 50;
const r100 = x => Math.round(x / 100) * 100;
const r5   = x => Math.round(x / 5) * 5;

const NSE_HOLIDAYS_2026 = [
  '2026-01-26','2026-03-03','2026-03-26','2026-03-31',
  '2026-04-03','2026-04-14','2026-05-01','2026-05-28',
  '2026-06-26','2026-09-14','2026-10-02','2026-10-20',
  '2026-11-10','2026-11-24','2026-12-25'
];

// ── State ──
let SCORE = null, DIRECTION = '';
let RADAR_LOCKED = false, BREADTH_LOCKED = false, EVENING_LOCKED = false;
let ANALYSIS_VIX = null;
let _RANKED_SETUPS = [];

const W = {
  india_vix: 0.25, pcr_nf: 0.18, fii: 0.15, gift_gap: 0.15,
  close_char: 0.10, max_pain: 0.08,
  n50adv: 0.04, bnfadv: 0.03, n50dma: 0.02
};

// ── Helpers ──
function gv(id)   { const el = document.getElementById(id); if (!el) return null; const v = parseFloat(el.value); return isNaN(v) ? null : v; }
function gvi(id)  { const el = document.getElementById(id); if (!el) return null; const v = parseInt(el.value); return isNaN(v) ? null : v; }
function gs(id)   { const el = document.getElementById(id); return el ? el.value.trim() : ''; }
function valid(v) { return v !== null && v !== undefined && !isNaN(v) && v !== 0; }

function isTradingDay(d) {
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  return !NSE_HOLIDAYS_2026.includes(d.toISOString().slice(0, 10));
}
function prevTradingDay(d) { const p = new Date(d); do { p.setDate(p.getDate() - 1); } while (!isTradingDay(p)); return p; }
function actualExpiry(raw) { const d = new Date(raw); while (!isTradingDay(d)) d.setDate(d.getDate() - 1); return d; }
function dateFmt(d) { return d.toISOString().slice(0, 10); }
function daysTo(target) {
  const now = new Date(); now.setHours(0,0,0,0);
  const t = new Date(target); t.setHours(0,0,0,0);
  return Math.max(1, Math.round((t - now) / 86400000));
}
function tradingDaysTo(target) {
  const now = new Date(); now.setHours(0,0,0,0);
  const t = new Date(target); t.setHours(0,0,0,0);
  let count = 0; const d = new Date(now); d.setDate(d.getDate() + 1);
  while (d <= t) { if (isTradingDay(d)) count++; d.setDate(d.getDate() + 1); }
  return Math.max(1, count);
}
function directionCategory(score) {
  if (score >= 1.2) return 'STRONG_BULL'; if (score >= 0.4) return 'MILD_BULL';
  if (score > -0.4) return 'NEUTRAL'; if (score > -1.2) return 'MILD_BEAR'; return 'STRONG_BEAR';
}
function directionLabel(score) {
  return { STRONG_BULL:'STRONGLY BULLISH', MILD_BULL:'MILDLY BULLISH', NEUTRAL:'NEUTRAL', MILD_BEAR:'MILDLY BEARISH', STRONG_BEAR:'STRONGLY BEARISH' }[directionCategory(score)];
}
function dteConviction(dte) {
  if (dte >= 11 && dte <= 21) return 'SWEET SPOT'; if (dte >= 6 && dte <= 35) return 'ACCEPTABLE';
  if (dte < 6) return 'SHORT'; return 'LONG';
}

// ── Moneyness Label ──
function moneyLabel(strike, spot, type) {
  const pct = ((strike - spot) / spot) * 100;
  if (type === 'CE') {
    if (pct < -2) return 'Deep ITM'; if (pct < 0) return 'ITM';
    if (Math.abs(pct) <= 0.5) return 'ATM';
    if (pct <= 3) return 'OTM'; if (pct <= 6) return 'Far OTM'; return 'Deep OTM';
  } else {
    // PE: ITM when strike > spot
    if (pct > 2) return 'Deep ITM'; if (pct > 0) return 'ITM';
    if (Math.abs(pct) <= 0.5) return 'ATM';
    if (pct >= -3) return 'OTM'; if (pct >= -6) return 'Far OTM'; return 'Deep OTM';
  }
}

// ── Timestamp / Freshness ──
function getTS() { try { return JSON.parse(localStorage.getItem('mr140-ts') || '{}'); } catch(e) { return {}; } }
function stampField(id) { const ts = getTS(); ts[id] = Date.now(); localStorage.setItem('mr140-ts', JSON.stringify(ts)); renderTS(id, ts[id]); }
function renderTS(id, timestamp) {
  const el = document.getElementById(`ts-${id}`); if (!el) return;
  const age = (Date.now() - timestamp) / 60000;
  const label = age < 15 ? 'fresh' : age < 60 ? 'stale' : 'old';
  el.textContent = label; el.className = `ts-badge ts-${label}`;
}
function restoreAllTS() { const ts = getTS(); for (const id in ts) renderTS(id, ts[id]); }

// ═══════════════════════════════════════════════════
// SCORING ENGINE
// ═══════════════════════════════════════════════════

function calcScore() {
  const signals = {};
  const india_vix = gv('india_vix'), fii = gv('fii'), pcr_nf = gv('pcr_nf');
  const close_char = gv('close_char'), max_pain = gv('max_pain_nf'), nf_spot = gv('nf_price');
  const n50adv = gv('n50adv'), n50dma = gv('n50dma'), bnfadv = gv('bnfadv');
  const nifty_prev = gv('nifty_prev');

  // Auto-calculate gap from spot vs previous close
  if (valid(nf_spot) && valid(nifty_prev) && nifty_prev > 0) {
    const gap = ((nf_spot - nifty_prev) / nifty_prev) * 100;
    signals.gift_gap = Math.max(-1, Math.min(1, gap / 1.5));
  }

  if (valid(india_vix))  { signals.india_vix = Math.max(-1, Math.min(1, -(india_vix - 14) / 6)); ANALYSIS_VIX = india_vix; }
  if (valid(fii))        signals.fii        = Math.max(-1, Math.min(1, fii / 2000));
  if (valid(pcr_nf))     signals.pcr_nf     = Math.max(-1, Math.min(1, (pcr_nf - 1.0) / 0.5));
  if (valid(close_char)) signals.close_char = Math.max(-1, Math.min(1, close_char / 2));
  if (valid(max_pain) && valid(nf_spot) && nf_spot > 0)
    signals.max_pain = Math.max(-1, Math.min(1, (max_pain - nf_spot) / nf_spot * 100));
  if (valid(n50adv)) signals.n50adv = Math.max(-1, Math.min(1, (n50adv - 25) / 15));
  if (valid(n50dma)) signals.n50dma = Math.max(-1, Math.min(1, n50dma / 5));
  if (valid(bnfadv)) signals.bnfadv = Math.max(-1, Math.min(1, (bnfadv - 6) / 4));

  let wSum = 0, wTotal = 0;
  for (const key in W) { if (signals[key] !== undefined) { wSum += signals[key] * W[key]; wTotal += W[key]; } }
  if (wTotal === 0) { SCORE = null; DIRECTION = ''; renderVerdict(); return; }
  SCORE = +(wSum / wTotal).toFixed(4);
  DIRECTION = directionLabel(SCORE);
  renderVerdict(); buildCommand();
}

function renderVerdict() {
  const el = document.getElementById('verdict'); if (!el) return;
  if (SCORE === null) { el.innerHTML = '<div class="verdict-box neutral">Enter signals to see direction</div>'; return; }
  const cls = { STRONG_BULL:'bull', MILD_BULL:'bull-mild', NEUTRAL:'neutral', MILD_BEAR:'bear-mild', STRONG_BEAR:'bear' }[directionCategory(SCORE)];
  el.innerHTML = `<div class="verdict-box ${cls}"><div class="verdict-direction">${DIRECTION}</div><div class="verdict-score">Score: ${SCORE.toFixed(2)}</div></div>`;
}

// ═══════════════════════════════════════════════════
// EXPIRY CALENDAR
// ═══════════════════════════════════════════════════

function getExpiries(index) {
  const results = [], today = new Date(); today.setHours(0,0,0,0);
  if (index === 'NF') {
    let d = new Date(today);
    while (results.length < 3) {
      const dow = d.getDay(); const skip = (4 - dow + 7) % 7 || 7;
      if (dow !== 4 || d <= today) d.setDate(d.getDate() + (dow === 4 && d >= today ? 0 : skip));
      const exp = actualExpiry(new Date(d)); const s = dateFmt(exp);
      if (!results.includes(s) && exp >= today) results.push(s); d.setDate(d.getDate() + 1);
    }
  } else {
    let d = new Date(today);
    while (results.length < 3) {
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      const lt = new Date(lastDay); while (lt.getDay() !== 4) lt.setDate(lt.getDate() - 1);
      const exp = actualExpiry(new Date(lt)); const s = dateFmt(exp);
      if (exp >= today && !results.includes(s)) results.push(s);
      d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════
// Q1: DIRECTIONAL BIAS
// ═══════════════════════════════════════════════════

function computeDirectionalBias() {
  let bullCount = 0, bearCount = 0; const signals = [];
  const fii = gv('fii');
  if (valid(fii)) { if (fii > 500) { bullCount++; signals.push({name:'FII Cash',vote:'BULL',val:`₹${fii} Cr`}); } else if (fii < -500) { bearCount++; signals.push({name:'FII Cash',vote:'BEAR',val:`₹${fii} Cr`}); } else signals.push({name:'FII Cash',vote:'NEUTRAL',val:`₹${fii} Cr`}); }
  const fiiFut = gv('fii_fut'), fiiOpt = gv('fii_opt');
  if (valid(fiiFut) || valid(fiiOpt)) { const net = (fiiFut||0)+(fiiOpt||0); if (net > 0) { bullCount++; signals.push({name:'FII Deriv',vote:'BULL',val:`₹${net.toFixed(0)} Cr`}); } else if (net < 0) { bearCount++; signals.push({name:'FII Deriv',vote:'BEAR',val:`₹${net.toFixed(0)} Cr`}); } else signals.push({name:'FII Deriv',vote:'NEUTRAL',val:`₹${net.toFixed(0)} Cr`}); }
  const pcr = gv('pcr_nf');
  if (valid(pcr)) { if (pcr > 1.2) { bullCount++; signals.push({name:'PCR',vote:'BULL',val:pcr.toFixed(2)}); } else if (pcr < 0.9) { bearCount++; signals.push({name:'PCR',vote:'BEAR',val:pcr.toFixed(2)}); } else signals.push({name:'PCR',vote:'NEUTRAL',val:pcr.toFixed(2)}); }
  const spot = gv('nf_price'), mp = gv('max_pain_nf');
  if (valid(spot) && valid(mp)) { const diff = spot - mp; if (diff < -100) { bullCount++; signals.push({name:'Max Pain',vote:'BULL',val:`${diff.toFixed(0)}`}); } else if (diff > 100) { bearCount++; signals.push({name:'Max Pain',vote:'BEAR',val:`+${diff.toFixed(0)}`}); } else signals.push({name:'Max Pain',vote:'NEUTRAL',val:`${diff>0?'+':''}${diff.toFixed(0)}`}); }
  const cc = gv('close_char');
  if (valid(cc)) { if (cc >= 1) { bullCount++; signals.push({name:'Close Char',vote:'BULL',val:`+${cc}`}); } else if (cc <= -1) { bearCount++; signals.push({name:'Close Char',vote:'BEAR',val:`${cc}`}); } else signals.push({name:'Close Char',vote:'NEUTRAL',val:`${cc}`}); }
  const vix = gv('india_vix'), yVix = parseFloat(localStorage.getItem('mr_ev_indiavix') || '0');
  if (valid(vix) && yVix > 0) { const vc = vix - yVix; if (vc < -0.3) { bullCount++; signals.push({name:'VIX Dir',vote:'BULL',val:`${vc.toFixed(2)}`}); } else if (vc > 0.3) { bearCount++; signals.push({name:'VIX Dir',vote:'BEAR',val:`+${vc.toFixed(2)}`}); } else signals.push({name:'VIX Dir',vote:'NEUTRAL',val:`${vc>0?'+':''}${vc.toFixed(2)}`}); }
  const net = bullCount - bearCount; let bias, biasConf;
  if (net >= 3) { bias='BULL'; biasConf='Strong'; } else if (net >= 1) { bias='BULL'; biasConf='Mild'; }
  else if (net <= -3) { bias='BEAR'; biasConf='Strong'; } else if (net <= -1) { bias='BEAR'; biasConf='Mild'; }
  else { bias='NEUTRAL'; biasConf='Neutral'; }
  return { bias, biasConf, bullCount, bearCount, net, signals };
}

// ═══════════════════════════════════════════════════
// STRATEGY EVALUATOR
// ═══════════════════════════════════════════════════

const STRATEGY_TYPES = ['BULL_PUT','BEAR_CALL','IRON_CONDOR','BULL_CALL','BEAR_PUT','LONG_STRADDLE','LONG_STRANGLE'];
const STRAT_LABELS = { BULL_PUT:'Bull Put Spread', BEAR_CALL:'Bear Call Spread', IRON_CONDOR:'Iron Condor', BULL_CALL:'Bull Call Spread', BEAR_PUT:'Bear Put Spread', LONG_STRADDLE:'Long Straddle', LONG_STRANGLE:'Long Strangle' };

function evaluateAllStrategies(bias, vix, biasConf) {
  const setups = [];
  for (const indexKey of ['NF','BNF']) {
    const chains = window._CHAINS[indexKey]; if (!chains || !Object.keys(chains).length) continue;
    const isNF = indexKey === 'NF';
    const lotSize = isNF ? NF_LOT_SIZE : BNF_LOT, width = isNF ? NF_IC_WIDTH : BNF_IC_WIDTH;
    const marginPerLot = isNF ? NF_MARGIN_PER_LOT : BNF_MARGIN_PER_LOT, step = isNF ? 50 : 100;
    for (const expiry in chains) {
      const chain = chains[expiry]; if (!chain.strikes || !chain.spot) continue;
      const spot = chain.spot, dte = chain.dte, tradingDte = chain.tradingDte || dte;
      const strikeKeys = Object.keys(chain.strikes).map(Number).sort((a,b) => a - b);
      if (strikeKeys.length < 4) continue;
      const atm = strikeKeys.reduce((best, s) => Math.abs(s - spot) < Math.abs(best - spot) ? s : best, strikeKeys[0]);
      for (const stratType of STRATEGY_TYPES) {
        if (!isStrategyAllowed(stratType, bias, vix)) continue;
        const candidates = buildCandidates(stratType, chain, atm, spot, width, step, strikeKeys, isNF);
        for (const cand of candidates) {
          const setup = evaluateSetup(cand, stratType, indexKey, expiry, spot, dte, tradingDte, lotSize, marginPerLot, width, chain, vix);
          if (setup) {
            const baseScore = scoreSetup(setup, bias, vix, chain);
            const varsityMult = getVarsityMultiplier(stratType, biasConf || 'Neutral', bias, vix);
            setup.baseScore = baseScore;
            setup.varsityMult = varsityMult;
            setup.varsityTier = getVarsityTierLabel(varsityMult);
            setup.compositeScore = +(baseScore * varsityMult).toFixed(2);
            if (varsityMult > 0) setups.push(setup);
          }
        }
      }
    }
  }
  setups.sort((a, b) => b.compositeScore - a.compositeScore);
  return setups;
}

function isStrategyAllowed(stratType, bias, vix) {
  if (valid(vix) && vix >= 28) return false;
  if (bias === 'BULL') return ['BULL_PUT','BULL_CALL','IRON_CONDOR','LONG_STRADDLE','LONG_STRANGLE'].includes(stratType);
  if (bias === 'BEAR') return ['BEAR_CALL','BEAR_PUT','IRON_CONDOR','LONG_STRADDLE','LONG_STRANGLE'].includes(stratType);
  return true;
}

function buildCandidates(stratType, chain, atm, spot, width, step, strikeKeys, isNF) {
  const s = chain.strikes, candidates = [];
  switch(stratType) {
    case 'BULL_PUT': { const otm = strikeKeys.filter(k => k < spot && k >= spot-(isNF?1000:3000) && s[k]&&s[k].PE&&s[k].PE.ltp>0); for (const sk of otm) { const bk=sk-width; if (s[bk]&&s[bk].PE) candidates.push({legs:[{type:'PE',strike:sk,action:'SELL',data:s[sk].PE},{type:'PE',strike:bk,action:'BUY',data:s[bk].PE}]}); } break; }
    case 'BEAR_CALL': { const otm = strikeKeys.filter(k => k > spot && k <= spot+(isNF?1000:3000) && s[k]&&s[k].CE&&s[k].CE.ltp>0); for (const sk of otm) { const bk=sk+width; if (s[bk]&&s[bk].CE) candidates.push({legs:[{type:'CE',strike:sk,action:'SELL',data:s[sk].CE},{type:'CE',strike:bk,action:'BUY',data:s[bk].CE}]}); } break; }
    case 'IRON_CONDOR': { const ps = strikeKeys.filter(k => k<spot-(isNF?100:300) && k>=spot-(isNF?800:2500) && s[k]&&s[k].PE&&s[k].PE.ltp>0); const cs = strikeKeys.filter(k => k>spot+(isNF?100:300) && k<=spot+(isNF?800:2500) && s[k]&&s[k].CE&&s[k].CE.ltp>0); for (const pk of ps.slice(-3)) { for (const ck of cs.slice(0,3)) { const pb=pk-width, cb=ck+width; if (s[pb]&&s[pb].PE&&s[cb]&&s[cb].CE) candidates.push({legs:[{type:'CE',strike:ck,action:'SELL',data:s[ck].CE},{type:'CE',strike:cb,action:'BUY',data:s[cb].CE},{type:'PE',strike:pk,action:'SELL',data:s[pk].PE},{type:'PE',strike:pb,action:'BUY',data:s[pb].PE}]}); } } break; }
    case 'BULL_CALL': { const bc = strikeKeys.filter(k => Math.abs(k-spot)<=(isNF?200:600) && s[k]&&s[k].CE&&s[k].CE.ltp>0); for (const bk of bc) { const sk=bk+width; if (s[sk]&&s[sk].CE) candidates.push({legs:[{type:'CE',strike:bk,action:'BUY',data:s[bk].CE},{type:'CE',strike:sk,action:'SELL',data:s[sk].CE}]}); } break; }
    case 'BEAR_PUT': { const bp = strikeKeys.filter(k => Math.abs(k-spot)<=(isNF?200:600) && s[k]&&s[k].PE&&s[k].PE.ltp>0); for (const bk of bp) { const sk=bk-width; if (s[sk]&&s[sk].PE) candidates.push({legs:[{type:'PE',strike:bk,action:'BUY',data:s[bk].PE},{type:'PE',strike:sk,action:'SELL',data:s[sk].PE}]}); } break; }
    case 'LONG_STRADDLE': { if (s[atm]&&s[atm].CE&&s[atm].PE&&s[atm].CE.ltp>0&&s[atm].PE.ltp>0) candidates.push({legs:[{type:'CE',strike:atm,action:'BUY',data:s[atm].CE},{type:'PE',strike:atm,action:'BUY',data:s[atm].PE}]}); const au=atm+step; if (s[au]&&s[au].CE&&s[atm]&&s[atm].PE) candidates.push({legs:[{type:'CE',strike:au,action:'BUY',data:s[au].CE},{type:'PE',strike:atm,action:'BUY',data:s[atm].PE}]}); break; }
    case 'LONG_STRANGLE': { const oc = strikeKeys.filter(k => k>spot+(isNF?100:300) && k<=spot+(isNF?500:1500) && s[k]&&s[k].CE&&s[k].CE.ltp>0); const op = strikeKeys.filter(k => k<spot-(isNF?100:300) && k>=spot-(isNF?500:1500) && s[k]&&s[k].PE&&s[k].PE.ltp>0); for (const ck of oc.slice(0,2)) { for (const pk of op.slice(-2)) candidates.push({legs:[{type:'CE',strike:ck,action:'BUY',data:s[ck].CE},{type:'PE',strike:pk,action:'BUY',data:s[pk].PE}]}); } break; }
  }
  return candidates.slice(0, 5);
}

function evaluateSetup(cand, stratType, indexKey, expiry, spot, dte, tradingDte, lotSize, marginPerLot, width, chain, vix) {
  const legs = cand.legs;
  const isCredit = ['BULL_PUT','BEAR_CALL','IRON_CONDOR'].includes(stratType);

  // Reject legs with ₹0 LTP — can't execute at zero
  for (const leg of legs) { if (leg.data.ltp <= 0 && leg.action === 'BUY') return null; }

  let netPremium = 0, netDelta = 0, netTheta = 0, netGamma = 0, netVega = 0;

  for (const leg of legs) {
    // Use bid for SELL (what you'll actually get), ask for BUY (what you'll actually pay)
    const execPrice = leg.action === 'SELL' ? (leg.data.bid || leg.data.ltp) : (leg.data.ask || leg.data.ltp);
    const premMult = leg.action === 'SELL' ? 1 : -1;
    netPremium += premMult * execPrice;
    const gMult = leg.action === 'SELL' ? -1 : 1;
    if (leg.data.delta != null) netDelta += gMult * leg.data.delta;
    if (leg.data.theta != null) netTheta += gMult * leg.data.theta;
    if (leg.data.gamma != null) netGamma += gMult * leg.data.gamma;
    if (leg.data.vega  != null) netVega  += gMult * leg.data.vega;
  }

  if (isCredit && netPremium <= 0) return null;
  if (!isCredit && netPremium >= 0) return null;

  const absPremium = Math.abs(netPremium);
  let maxProfit, maxLoss, breakevens = [];
  const safeLots = 1; // Fixed 1 lot until confidence grows

  if (stratType === 'BULL_PUT') {
    maxProfit = netPremium * lotSize * safeLots;
    maxLoss = (width - netPremium) * lotSize * safeLots;
    breakevens = [legs[0].strike - netPremium];
  } else if (stratType === 'BEAR_CALL') {
    maxProfit = netPremium * lotSize * safeLots;
    maxLoss = (width - netPremium) * lotSize * safeLots;
    breakevens = [legs[0].strike + netPremium];
  } else if (stratType === 'IRON_CONDOR') {
    maxProfit = netPremium * lotSize * safeLots;
    maxLoss = (width - netPremium) * lotSize * safeLots;
    const callSell = legs.find(l => l.type === 'CE' && l.action === 'SELL');
    const putSell = legs.find(l => l.type === 'PE' && l.action === 'SELL');
    breakevens = [putSell.strike - netPremium, callSell.strike + netPremium];
  } else if (stratType === 'BULL_CALL') {
    maxProfit = (width - absPremium) * lotSize * safeLots;
    maxLoss = absPremium * lotSize * safeLots;
    breakevens = [legs[0].strike + absPremium];
  } else if (stratType === 'BEAR_PUT') {
    maxProfit = (width - absPremium) * lotSize * safeLots;
    maxLoss = absPremium * lotSize * safeLots;
    breakevens = [legs[0].strike - absPremium];
  } else if (stratType === 'LONG_STRADDLE' || stratType === 'LONG_STRANGLE') {
    maxLoss = absPremium * lotSize * safeLots;
    const em = bsExpectedMove(spot, vix || 14, tradingDte);
    maxProfit = Math.max(0, (em.two_sigma - absPremium) * lotSize * safeLots);
    if (stratType === 'LONG_STRADDLE') {
      breakevens = [legs[0].strike - absPremium, legs[0].strike + absPremium];
    } else {
      const putK = legs.find(l => l.type === 'PE').strike;
      const callK = legs.find(l => l.type === 'CE').strike;
      breakevens = [putK - absPremium, callK + absPremium];
    }
  }

  // ── REJECT: credit > width (negative max loss = impossible) ──
  if (maxLoss <= 0) return null;

  // ── REJECT: max loss > CAPITAL ──
  if (maxLoss > CAPITAL) return null;

  const rr = maxProfit / Math.max(maxLoss, 1);

  // ── Probability calculation (needed before filter) ──
  let probProfit = 0.50;
  if (isCredit) {
    const soldLeg = legs.find(l => l.action === 'SELL');
    if (soldLeg && soldLeg.data.delta != null) probProfit = 1 - Math.abs(soldLeg.data.delta);
  } else if (stratType === 'LONG_STRADDLE' || stratType === 'LONG_STRANGLE') {
    const em = bsExpectedMove(spot, vix || 14, tradingDte);
    const beDist = Math.abs(breakevens[1] - spot);
    const beRatio = beDist / em.one_sigma;
    probProfit = beRatio < 0.8 ? 0.50 : beRatio < 1.0 ? 0.38 : beRatio < 1.2 ? 0.28 : 0.18;
  } else {
    const buyLeg = legs.find(l => l.action === 'BUY');
    if (buyLeg && buyLeg.data.delta != null) probProfit = Math.abs(buyLeg.data.delta);
  }

  // ── EV calculation (needed before filter) ──
  const ev = (probProfit * maxProfit) - ((1 - probProfit) * maxLoss);

  // ── SPLIT FILTER: credit vs debit ──
  if (isCredit) {
    // Credit spreads: R:R is structurally <1 (small credit, large risk)
    // Filter by: probability of keeping premium + positive expected value
    if (probProfit < 0.35) return null;   // Need >35% win rate
    if (ev <= 0) return null;              // Must be +EV
  } else {
    // Debit spreads/straddles/strangles: R:R must justify the premium spent
    if (rr < 1.5) return null;
  }

  // ── Target / Stop Loss ──
  let targetProfit, stopLoss;
  if (isCredit) {
    // Credit: target = 50% of max profit (exit early, don't hold to expiry)
    // SL = 1× credit received (risk the same as you collected)
    targetProfit = maxProfit * 0.50;
    stopLoss = maxProfit * 1.0;
  } else {
    // Debit: target = 50% of max profit, SL = 50% of max loss
    targetProfit = maxProfit * 0.50;
    stopLoss = maxLoss * 0.50;
  }

  let totalSpread = 0, spreadLegs = 0;
  for (const leg of legs) { if (leg.data.bid && leg.data.ask && leg.data.ask > 0) { totalSpread += (leg.data.ask - leg.data.bid) / leg.data.ask; spreadLegs++; } }
  const avgSpreadPct = spreadLegs > 0 ? totalSpread / spreadLegs : 0.05;
  const creditRatio = isCredit ? netPremium / width : null;
  if (isCredit && creditRatio < 0.05) return null;
  if (!isCredit && stratType !== 'LONG_STRADDLE' && stratType !== 'LONG_STRANGLE' && absPremium > width * 0.85) return null;

  const marginUsed = marginPerLot * safeLots;
  const evPerRupee = ev / Math.max(marginUsed, 1);

  return {
    stratType, stratLabel: STRAT_LABELS[stratType], indexKey, isNF: indexKey === 'NF', expiry, dte, tradingDte, spot, legs,
    netPremium: +netPremium.toFixed(2), isCredit,
    maxProfit: +maxProfit.toFixed(0), maxLoss: +maxLoss.toFixed(0),
    rr: +rr.toFixed(2), probProfit: +(probProfit * 100).toFixed(1),
    breakevens: breakevens.map(b => +b.toFixed(0)),
    netDelta: +netDelta.toFixed(4), netTheta: +netTheta.toFixed(2), netGamma: +netGamma.toFixed(4), netVega: +netVega.toFixed(2),
    lots: safeLots, lotSize, width, creditRatio,
    avgSpreadPct: +(avgSpreadPct * 100).toFixed(1),
    ev: +ev.toFixed(0), evPerRupee: +evPerRupee.toFixed(4), marginUsed,
    targetProfit: +targetProfit.toFixed(0), stopLoss: +stopLoss.toFixed(0),
    viable: true
  };
}

// ═══════════════════════════════════════════════════
// EV-BASED SCORING
// ═══════════════════════════════════════════════════

function scoreSetup(setup, bias, vix, chain) {
  const evScore = Math.max(0, Math.min(40, setup.evPerRupee * 400));
  const probScore = (setup.probProfit / 100) * 20;
  // biasScore REMOVED — Varsity multiplier handles bias alignment post-score
  const capEff = setup.maxProfit / Math.max(setup.marginUsed, 1);
  const capScore = Math.min(10, capEff * 50);
  const liqScore = Math.max(0, 5 - setup.avgSpreadPct);
  const pcr = chain.pcr || 0;
  const dirScore = Math.min(5, Math.abs(pcr - 1.0) * 5);
  const atmIV = chain.atmIV || 0, liveVix = vix || 14;
  let ivScore = 0;
  if (atmIV > 0 && setup.isCredit && atmIV > liveVix * 1.05) ivScore = 3;
  else if (atmIV > 0 && !setup.isCredit && atmIV < liveVix * 0.95) ivScore = 3;
  const dteScore = dteConviction(setup.dte) === 'SWEET SPOT' ? 2 : dteConviction(setup.dte) === 'ACCEPTABLE' ? 1 : 0;
  return +(evScore + probScore + capScore + liqScore + dirScore + ivScore + dteScore).toFixed(2);
}

// ═══════════════════════════════════════════════════
// VARSITY FRAMEWORK — Strategy-Bias Multiplier
// Zerodha Varsity: bias determines which strategies
// are PRIMARY, SECONDARY, or MARGINAL. EV only ranks
// within the appropriate tier.
// ═══════════════════════════════════════════════════

function getVarsityMultiplier(stratType, biasConf, bias, vix) {
  // Build outlook from bias + confidence
  const outlook = bias === 'NEUTRAL' ? 'NEUTRAL' :
    (biasConf === 'Strong' ? 'STRONG_' : 'MILD_') + bias;

  // Tier multipliers: 1.0 = primary, 0.65 = secondary, 0.35 = marginal
  const tiers = {
    STRONG_BULL: { BULL_CALL:1.0, BULL_PUT:0.65, IRON_CONDOR:0.35, LONG_STRADDLE:0.35, LONG_STRANGLE:0.35 },
    MILD_BULL:   { BULL_PUT:1.0,  BULL_CALL:0.65, IRON_CONDOR:0.65, LONG_STRADDLE:0.35, LONG_STRANGLE:0.35 },
    NEUTRAL:     { IRON_CONDOR:1.0, LONG_STRADDLE:0.70, LONG_STRANGLE:0.70, BULL_PUT:0.50, BEAR_CALL:0.50, BULL_CALL:0.45, BEAR_PUT:0.45 },
    MILD_BEAR:   { BEAR_CALL:1.0, BEAR_PUT:0.65, IRON_CONDOR:0.65, LONG_STRADDLE:0.35, LONG_STRANGLE:0.35 },
    STRONG_BEAR: { BEAR_PUT:1.0,  BEAR_CALL:0.65, IRON_CONDOR:0.35, LONG_STRADDLE:0.35, LONG_STRANGLE:0.35 }
  };

  const tierMap = tiers[outlook] || tiers.NEUTRAL;
  let mult = tierMap[stratType] !== undefined ? tierMap[stratType] : 0.35;

  // VIX fine-tuning
  const safeVix = vix || 14;
  const isCredit = ['BULL_PUT','BEAR_CALL','IRON_CONDOR'].includes(stratType);
  const isLong = ['LONG_STRADDLE','LONG_STRANGLE'].includes(stratType);

  // High VIX (≥20): credit premiums are fat → slight boost to credit Tier 1/2
  if (safeVix >= 20 && isCredit && mult >= 0.65) mult = Math.min(1.0, mult + 0.05);
  // Very high VIX (≥24): extra credit boost
  if (safeVix >= 24 && isCredit && mult >= 0.65) mult = Math.min(1.0, mult + 0.05);
  // Low VIX (≤13): long strategies benefit from cheap options
  if (safeVix <= 13 && isLong) mult = Math.min(1.0, mult + 0.10);
  // High VIX penalizes longs (expensive premium, likely to decay)
  if (safeVix >= 20 && isLong) mult = Math.max(0.20, mult - 0.10);

  return mult;
}

function getVarsityTierLabel(mult) {
  if (mult >= 0.95) return '★ Primary';
  if (mult >= 0.60) return '◆ Secondary';
  return '○ Marginal';
}

// ═══════════════════════════════════════════════════
// COMMAND TAB RENDER
// ═══════════════════════════════════════════════════

async function buildCommand() {
  const panel = document.getElementById('command-output'); if (!panel) return;
  const vix = gv('india_vix') || gv('strat_vix');
  const hasChains = (Object.keys(window._CHAINS.NF).length + Object.keys(window._CHAINS.BNF).length) > 0;
  if (!hasChains) { panel.innerHTML = '<div class="cmd-placeholder">Fetch Upstox data to see strategy recommendations</div>'; return; }
  const q1 = computeDirectionalBias();
  const ranked = evaluateAllStrategies(q1.bias, vix, q1.biasConf);
  _RANKED_SETUPS = ranked;
  if (valid(vix) && vix >= 28) { panel.innerHTML = `<div class="gonogo nogo"><div class="gonogo-label">🚫 AVOID ALL</div><div class="gonogo-reason">VIX ≥ 28</div></div>${renderQ1Card(q1)}`; return; }

  // Show loading while checking margins
  panel.innerHTML = '<div class="cmd-placeholder">Checking margins for top strategies...</div>';

  // Split by index: top 10 NF + top 10 BNF for margin checks
  const availMargin = window._AVAILABLE_MARGIN || CAPITAL;
  const nfRanked = ranked.filter(s => s.indexKey === 'NF').slice(0, 10);
  const bnfRanked = ranked.filter(s => s.indexKey === 'BNF').slice(0, 10);
  const toCheck = [...nfRanked, ...bnfRanked];

  for (const setup of toCheck) {
    const marginResult = typeof upstoxCheckMargin === 'function' ? await upstoxCheckMargin(setup.legs, setup.lotSize) : null;
    if (marginResult && marginResult.ok && marginResult.required > 0) {
      setup.requiredMargin = marginResult.required;
      setup.marginOk = marginResult.required <= availMargin;
    } else {
      // Conservative fallback when API fails (SPAN ≈ width × lotSize × multiplier)
      const isIC = setup.stratType === 'IRON_CONDOR';
      const isCredit = setup.isCredit;
      if (isIC) {
        setup.requiredMargin = setup.width * setup.lotSize * 9;
      } else if (isCredit) {
        setup.requiredMargin = setup.width * setup.lotSize * 6;
      } else {
        // Debit strategies: margin = premium paid + buffer
        setup.requiredMargin = setup.maxLoss * 1.5;
      }
      setup.marginOk = setup.requiredMargin <= availMargin;
    }
  }

  // Pick top 5 per index (max 3 same strategy type)
  function pickTop5(arr) {
    const shown = [], typeCounts = {};
    for (const s of arr) {
      if (shown.length >= 5) break;
      typeCounts[s.stratType] = (typeCounts[s.stratType] || 0) + 1;
      if (typeCounts[s.stratType] > 3) continue;
      shown.push(s);
    }
    return shown;
  }

  const nfAffordable = pickTop5(nfRanked.filter(s => s.marginOk));
  const bnfAffordable = pickTop5(bnfRanked.filter(s => s.marginOk));
  const totalAffordable = nfAffordable.length + bnfAffordable.length;

  let html = '';
  const isGo = totalAffordable > 0;
  html += `<div class="gonogo ${isGo?'go':'nogo'}"><div class="gonogo-label">${isGo?'✅ GO':'🚫 NO-GO'}</div><div class="gonogo-strategy">${isGo?`${totalAffordable} executable (of ${ranked.length} viable)`:'No setups fit margin ₹'+availMargin.toLocaleString('en-IN')}</div><div class="gonogo-meta">VIX: ${vix||'—'} | Bias: ${q1.biasConf} ${q1.bias}</div></div>`;
  html += renderQ1Card(q1);

  // Collect all shown setups in order for drawer click binding
  const allShown = [];

  // ── NIFTY 50 section ──
  if (nfAffordable.length > 0) {
    html += '<div class="section-title">NIFTY 50 — Top 5</div>';
    nfAffordable.forEach((s, i) => { html += renderStrategyCard(s, i); allShown.push(s); });
  } else if (Object.keys(window._CHAINS.NF).length > 0) {
    html += '<div class="section-title">NIFTY 50 — Top 5</div>';
    html += '<div class="cmd-placeholder">No NF setups pass margin / R:R filters</div>';
  }

  // ── BANK NIFTY section ──
  if (bnfAffordable.length > 0) {
    html += '<div class="section-title">BANK NIFTY — Top 5</div>';
    bnfAffordable.forEach((s, i) => { html += renderStrategyCard(s, i); allShown.push(s); });
  } else if (Object.keys(window._CHAINS.BNF).length > 0) {
    html += '<div class="section-title">BANK NIFTY — Top 5</div>';
    html += '<div class="cmd-placeholder">No BNF setups pass margin / R:R filters</div>';
  }

  _RANKED_SETUPS = allShown;
  panel.innerHTML = html;
  document.querySelectorAll('.strat-card').forEach((card, i) => { card.addEventListener('click', () => openDrawer(_RANKED_SETUPS[i])); });
}

function renderQ1Card(q1) {
  return `<div class="q-card"><div class="q-title">Q1: Directional Bias → <span class="bias-${q1.bias.toLowerCase()}">${q1.biasConf} ${q1.bias}</span></div><div class="q-signals">${q1.signals.map(s => `<div class="signal-row"><span class="signal-name">${s.name}</span><span class="signal-vote vote-${s.vote.toLowerCase()}">${s.vote}</span><span class="signal-val">${s.val}</span></div>`).join('')}</div><div class="q-summary">Bull: ${q1.bullCount} | Bear: ${q1.bearCount} | Net: ${q1.net>0?'+':''}${q1.net}</div></div>`;
}

function renderStrategyCard(setup, index) {
  const legStr = setup.legs.map(l => {
    const price = l.action === 'SELL' ? (l.data.bid || l.data.ltp) : (l.data.ask || l.data.ltp);
    return `${l.action} ${l.strike} ${l.type} (${moneyLabel(l.strike, setup.spot, l.type)}) @₹${price.toFixed(0)}`;
  }).join(' | ');
  const tierColor = setup.varsityMult >= 0.95 ? '#5cb85c' : setup.varsityMult >= 0.60 ? '#d4a853' : '#8a7d6f';
  return `<div class="strat-card" data-idx="${index}">
    <div class="sc-rank">#${index+1}</div>
    <div class="sc-header"><div class="sc-name">${setup.stratLabel} <span style="font-size:10px;color:${tierColor};margin-left:6px">${setup.varsityTier || ''}</span></div><div class="sc-index">${setup.indexKey} · ${setup.expiry} · DTE ${setup.dte} (${setup.tradingDte}T)</div></div>
    <div class="sc-legs">${legStr}</div>
    <div class="sc-metrics">
      <div class="sc-metric"><span class="sc-label">Max Profit</span><span class="sc-val profit">₹${setup.maxProfit.toLocaleString('en-IN')}</span></div>
      <div class="sc-metric"><span class="sc-label">Max Loss</span><span class="sc-val loss">₹${setup.maxLoss.toLocaleString('en-IN')}</span></div>
      <div class="sc-metric"><span class="sc-label">R:R</span><span class="sc-val">1:${setup.rr}</span></div>
      <div class="sc-metric"><span class="sc-label">P(Profit)</span><span class="sc-val">${setup.probProfit}%</span></div>
    </div>
    <div class="sc-targets">🎯 Target: ₹${setup.targetProfit.toLocaleString('en-IN')} | 🛑 SL: ₹${setup.stopLoss.toLocaleString('en-IN')}</div>
    <div class="sc-greeks">Δ ${setup.netDelta.toFixed(4)} · θ ${setup.netTheta.toFixed(2)} · γ ${setup.netGamma.toFixed(4)} · ν ${setup.netVega.toFixed(2)}</div>
    <div class="sc-score">EV: ₹${setup.ev.toLocaleString('en-IN')} | Score: ${setup.compositeScore}${setup.requiredMargin ? ' | Margin: ₹'+Math.round(setup.requiredMargin).toLocaleString('en-IN') : ''}</div>
    <div class="sc-tap">Tap for payoff chart ▾</div>
  </div>`;
}

// ═══════════════════════════════════════════════════
// BOTTOM DRAWER
// ═══════════════════════════════════════════════════

let _drawerOpen = false;
function openDrawer(setup) {
  if (!setup) return; _drawerOpen = true;
  const drawer = document.getElementById('payoff-drawer'), backdrop = document.getElementById('drawer-backdrop');
  if (!drawer || !backdrop) return;
  document.getElementById('drawer-title').textContent = `${setup.stratLabel} — ${setup.indexKey} ${setup.expiry}`;
  drawPayoffChart(setup);
  document.getElementById('drawer-metrics').innerHTML = `
    <div class="dm-row"><span>Delta</span><span>${setup.netDelta.toFixed(4)}</span></div>
    <div class="dm-row"><span>Theta</span><span>${setup.netTheta.toFixed(2)}</span></div>
    <div class="dm-row"><span>Gamma</span><span>${setup.netGamma.toFixed(4)}</span></div>
    <div class="dm-row"><span>Vega</span><span>${setup.netVega.toFixed(2)}</span></div>
    <div class="dm-divider"></div>
    <div class="dm-row"><span>Max Profit</span><span class="profit">₹${setup.maxProfit.toLocaleString('en-IN')}</span></div>
    <div class="dm-row"><span>Max Loss</span><span class="loss">₹${setup.maxLoss.toLocaleString('en-IN')}</span></div>
    <div class="dm-row"><span>🎯 Target Profit</span><span class="profit">₹${setup.targetProfit.toLocaleString('en-IN')}</span></div>
    <div class="dm-row"><span>🛑 Stop Loss</span><span class="loss">₹${setup.stopLoss.toLocaleString('en-IN')}</span></div>
    <div class="dm-divider"></div>
    <div class="dm-row"><span>P(Profit)</span><span>${setup.probProfit}%</span></div>
    <div class="dm-row"><span>R:R Ratio</span><span>1:${setup.rr}</span></div>
    <div class="dm-row"><span>Expected Value</span><span>${setup.ev>=0?'+':''}₹${setup.ev.toLocaleString('en-IN')}</span></div>
    <div class="dm-row"><span>Breakeven${setup.breakevens.length>1?'s':''}</span><span>${setup.breakevens.join(' / ')}</span></div>
    <div class="dm-row"><span>DTE</span><span>${setup.dte} cal / ${setup.tradingDte} trading (${dteConviction(setup.dte)})</span></div>
    <div class="dm-row"><span>Lots</span><span>${setup.lots}</span></div>
    <div class="dm-row"><span>${setup.isCredit?'Net Credit':'Net Debit'}</span><span>₹${Math.abs(setup.netPremium).toFixed(2)}</span></div>
    <div class="dm-row"><span>Spread %</span><span>${setup.avgSpreadPct}%</span></div>
    <div class="dm-row"><span>Varsity Tier</span><span>${setup.varsityTier || '—'} (×${(setup.varsityMult||0).toFixed(2)})</span></div>
    ${setup.requiredMargin ? `<div class="dm-row"><span>Required Margin</span><span>₹${Math.round(setup.requiredMargin).toLocaleString('en-IN')}</span></div>` : ''}
    <div class="dm-divider"></div>
    <div class="dm-legs-title">Legs (execution prices)</div>
    ${setup.legs.map(l => {
      const price = l.action === 'SELL' ? (l.data.bid || l.data.ltp) : (l.data.ask || l.data.ltp);
      const tag = l.action === 'SELL' ? 'bid' : 'ask';
      return `<div class="dm-leg">${l.action} ${setup.indexKey} ${setup.expiry} ${l.strike} ${l.type} <span style="opacity:0.6">(${moneyLabel(l.strike, setup.spot, l.type)})</span> @ ₹${price.toFixed(2)} <span style="opacity:0.4">${tag}</span></div>`;
    }).join('')}
  `;
  backdrop.classList.add('show'); drawer.classList.add('show');
}
function closeDrawer() { _drawerOpen = false; const d = document.getElementById('payoff-drawer'), b = document.getElementById('drawer-backdrop'); if (d) d.classList.remove('show'); if (b) b.classList.remove('show'); }

// ═══════════════════════════════════════════════════
// PAYOFF CHART
// ═══════════════════════════════════════════════════

function drawPayoffChart(setup) {
  const canvas = document.getElementById('payoff-canvas'); if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * dpr; canvas.height = 280 * dpr;
  canvas.style.width = rect.width + 'px'; canvas.style.height = '280px';
  ctx.scale(dpr, dpr);
  const CW = rect.width, CH = 280, pad = {top:20,right:20,bottom:40,left:60};
  const plotW = CW - pad.left - pad.right, plotH = CH - pad.top - pad.bottom;
  const spot = setup.spot;
  const allPts = [...setup.legs.map(l=>l.strike), ...setup.breakevens, spot];
  const dMin = Math.min(...allPts), dMax = Math.max(...allPts), dRange = dMax - dMin;
  const xPad = Math.max(dRange * 0.3, setup.width * 1.5);
  const xMin = dMin - xPad, xMax = dMax + xPad;
  const points = [], step = (xMax - xMin) / 200;
  let yMin = Infinity, yMax = -Infinity;
  for (let s = xMin; s <= xMax; s += step) {
    let pnl = 0;
    for (const leg of setup.legs) { const m = leg.action==='SELL'?-1:1; pnl += m * (leg.type==='CE'?Math.max(s-leg.strike,0):Math.max(leg.strike-s,0)); }
    pnl += setup.netPremium; pnl *= setup.lotSize * setup.lots;
    points.push({x:s,y:pnl}); if (pnl < yMin) yMin = pnl; if (pnl > yMax) yMax = pnl;
  }
  // Ensure zero line is visible and target/SL lines are within range
  if (yMin > 0) yMin = -Math.abs(yMax)*0.2; if (yMax < 0) yMax = Math.abs(yMin)*0.2;
  // Extend to include target and SL lines
  if (setup.targetProfit && setup.targetProfit > yMax) yMax = setup.targetProfit * 1.15;
  if (setup.stopLoss && -setup.stopLoss < yMin) yMin = -setup.stopLoss * 1.15;
  const yP = Math.max(Math.abs(yMax),Math.abs(yMin))*0.1; yMin -= yP; yMax += yP;
  const tx = x => pad.left + ((x-xMin)/(xMax-xMin))*plotW;
  const ty = y => pad.top + plotH - ((y-yMin)/(yMax-yMin))*plotH;
  ctx.clearRect(0, 0, CW, CH);
  // Grid
  ctx.strokeStyle='#3d352c'; ctx.lineWidth=0.5; ctx.fillStyle='#8a7d6f'; ctx.font='11px Courier New';
  ctx.textAlign='right';
  for (let i=0;i<=5;i++) { const yV=yMin+(yMax-yMin)*i/5, py=ty(yV); ctx.beginPath();ctx.moveTo(pad.left,py);ctx.lineTo(CW-pad.right,py);ctx.stroke(); ctx.fillText(Math.abs(yV)>=1000?(yV/1000).toFixed(1)+'K':yV.toFixed(0),pad.left-5,py+4); }
  ctx.textAlign='center';
  for (let i=0;i<=5;i++) { const xV=xMin+(xMax-xMin)*i/5, px=tx(xV); ctx.beginPath();ctx.moveTo(px,pad.top);ctx.lineTo(px,CH-pad.bottom);ctx.stroke(); ctx.fillText(xV.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g,','),px,CH-pad.bottom+15); }
  // Zero line
  if (yMin<0 && yMax>0) { ctx.strokeStyle='#5a5040';ctx.lineWidth=1;ctx.setLineDash([4,4]);ctx.beginPath();ctx.moveTo(pad.left,ty(0));ctx.lineTo(CW-pad.right,ty(0));ctx.stroke();ctx.setLineDash([]); }
  // Target/SL horizontal lines
  if (setup.targetProfit && yMin < setup.targetProfit && yMax > setup.targetProfit) {
    ctx.strokeStyle='#5cb85c'; ctx.lineWidth=1; ctx.setLineDash([6,3]);
    ctx.beginPath(); ctx.moveTo(pad.left,ty(setup.targetProfit)); ctx.lineTo(CW-pad.right,ty(setup.targetProfit)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle='#5cb85c'; ctx.font='9px Courier New'; ctx.textAlign='right';
    ctx.fillText('TARGET',CW-pad.right-2,ty(setup.targetProfit)-3);
  }
  if (setup.stopLoss && yMin < -setup.stopLoss && yMax > -setup.stopLoss) {
    ctx.strokeStyle='#d9534f'; ctx.lineWidth=1; ctx.setLineDash([6,3]);
    ctx.beginPath(); ctx.moveTo(pad.left,ty(-setup.stopLoss)); ctx.lineTo(CW-pad.right,ty(-setup.stopLoss)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle='#d9534f'; ctx.font='9px Courier New'; ctx.textAlign='right';
    ctx.fillText('STOP LOSS',CW-pad.right-2,ty(-setup.stopLoss)-3);
  }
  // Loss region
  ctx.beginPath(); ctx.moveTo(tx(points[0].x),ty(0)); for (const p of points) ctx.lineTo(tx(p.x),ty(Math.min(p.y,0))); ctx.lineTo(tx(points[points.length-1].x),ty(0)); ctx.closePath(); ctx.fillStyle='rgba(217,83,79,0.20)'; ctx.fill();
  // Profit region
  ctx.beginPath(); ctx.moveTo(tx(points[0].x),ty(0)); for (const p of points) ctx.lineTo(tx(p.x),ty(Math.max(p.y,0))); ctx.lineTo(tx(points[points.length-1].x),ty(0)); ctx.closePath(); ctx.fillStyle='rgba(92,184,92,0.20)'; ctx.fill();
  // Payoff line
  ctx.strokeStyle='#d4a853'; ctx.lineWidth=2; ctx.beginPath(); for (let i=0;i<points.length;i++) { if(i===0) ctx.moveTo(tx(points[i].x),ty(points[i].y)); else ctx.lineTo(tx(points[i].x),ty(points[i].y)); } ctx.stroke();
  // Current P&L curve
  if (setup.dte > 1) {
    const lV = window._LIVE_VIX||14, T=setup.dte/365, r=0.065, cp=[];
    for (let s=xMin;s<=xMax;s+=step) { let pv=0; for (const leg of setup.legs) { const gM=leg.action==='SELL'?-1:1; const iv=(leg.data.iv||lV)/100; pv+=gM*(leg.type==='CE'?bsCall(s,leg.strike,r,iv,T):bsPut(s,leg.strike,r,iv,T)); } cp.push({x:s,y:(setup.netPremium+pv)*setup.lotSize*setup.lots}); }
    ctx.strokeStyle='#f0ad4e';ctx.lineWidth=1.5;ctx.setLineDash([6,3]);ctx.beginPath();for(let i=0;i<cp.length;i++){const py=ty(Math.max(yMin,Math.min(yMax,cp[i].y)));if(i===0)ctx.moveTo(tx(cp[i].x),py);else ctx.lineTo(tx(cp[i].x),py);}ctx.stroke();ctx.setLineDash([]);
  }
  // Spot marker
  ctx.strokeStyle='#5bc0de';ctx.lineWidth=1.5;ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(tx(spot),pad.top);ctx.lineTo(tx(spot),CH-pad.bottom);ctx.stroke();ctx.setLineDash([]);
  const sp=points.reduce((b,p)=>Math.abs(p.x-spot)<Math.abs(b.x-spot)?p:b,points[0]);
  ctx.fillStyle='#5bc0de';ctx.beginPath();ctx.arc(tx(spot),ty(sp.y),5,0,Math.PI*2);ctx.fill();
  // Breakeven markers
  for (const be of setup.breakevens) { const bx=tx(be); if(bx>pad.left&&bx<CW-pad.right){ctx.fillStyle='#f0ad4e';ctx.beginPath();ctx.moveTo(bx,CH-pad.bottom-5);ctx.lineTo(bx-4,CH-pad.bottom+3);ctx.lineTo(bx+4,CH-pad.bottom+3);ctx.closePath();ctx.fill();ctx.fillStyle='#8a7d6f';ctx.font='10px Courier New';ctx.textAlign='center';ctx.fillText(be.toString(),bx,CH-pad.bottom+28);} }
  // Legend
  ctx.font='10px Courier New';ctx.textAlign='left';ctx.fillStyle='#d4a853';ctx.fillText('— At expiry',pad.left+5,pad.top+12);
  if(setup.dte>1){ctx.fillStyle='#f0ad4e';ctx.fillText('--- Current',pad.left+100,pad.top+12);}
  ctx.fillStyle='#5bc0de';ctx.fillText('● Spot',pad.left+190,pad.top+12);
}

// ═══════════════════════════════════════════════════
// DRAWER TOUCH + TABS
// ═══════════════════════════════════════════════════

function initDrawer() {
  const b = document.getElementById('drawer-backdrop'), h = document.getElementById('drawer-handle');
  if (b) b.addEventListener('click', closeDrawer);
  if (h) { let sY=0,dr=false; h.addEventListener('touchstart',e=>{sY=e.touches[0].clientY;dr=true;}); h.addEventListener('touchmove',e=>{if(dr&&e.touches[0].clientY-sY>80){closeDrawer();dr=false;}}); h.addEventListener('touchend',()=>{dr=false;}); h.addEventListener('mousedown',e=>{sY=e.clientY;dr=true;}); document.addEventListener('mousemove',e=>{if(dr&&e.clientY-sY>80){closeDrawer();dr=false;}}); document.addEventListener('mouseup',()=>{dr=false;}); }
}
function go(n) { document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active')); document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active')); const t=document.getElementById(`t${n}`),p=document.getElementById(`p${n}`); if(t)t.classList.add('active'); if(p)p.classList.add('active'); }

// ═══════════════════════════════════════════════════
// SOFT TOGGLE LOCKS
// ═══════════════════════════════════════════════════

function toggleRadar() { if (RADAR_LOCKED) { RADAR_LOCKED = false; } else { const d={}; ['india_vix','fii','close_char','max_pain_nf','nf_price','bn_price','nifty_prev'].forEach(id=>{d[id]=gv(id);}); localStorage.setItem('mr140-radar',JSON.stringify(d)); RADAR_LOCKED=true; } renderLockState(); }
function toggleBreadth() { if (BREADTH_LOCKED) { BREADTH_LOCKED = false; } else { const d={}; ['n50adv','n50dma','bnfadv'].forEach(id=>{d[id]=gv(id);}); localStorage.setItem('mr140-breadth',JSON.stringify(d)); BREADTH_LOCKED=true; } renderLockState(); }
function toggleEvening() { if (EVENING_LOCKED) { EVENING_LOCKED = false; } else { const d={}; ['ev_fii','ev_nf_close','ev_bnf_close','ev_indiavix'].forEach(id=>{d[id]=gv(id);}); localStorage.setItem('mr140-evening',JSON.stringify(d)); const v=gv('ev_indiavix'); if(valid(v)) localStorage.setItem('mr_ev_indiavix',v); EVENING_LOCKED=true; } renderLockState(); }
function renderLockState() { [['btn-lock-radar',RADAR_LOCKED,'🔒 Locked','🔓 Lock Morning Data'],['btn-lock-breadth',BREADTH_LOCKED,'🔒 Locked','🔓 Lock Breadth'],['btn-lock-evening',EVENING_LOCKED,'🔒 Locked','🔓 Lock Evening']].forEach(([id,locked,lt,ut])=>{ const el=document.getElementById(id); if(el) el.textContent=locked?lt:ut; }); }

function restoreSavedState() {
  try { const r=JSON.parse(localStorage.getItem('mr140-radar')||'null'); if(r){RADAR_LOCKED=true;for(const id in r){const el=document.getElementById(id);if(el&&r[id]!==null)el.value=r[id];}} } catch(e){}
  try { const b=JSON.parse(localStorage.getItem('mr140-breadth')||'null'); if(b){BREADTH_LOCKED=true;for(const id in b){if(id.startsWith('_'))continue;const el=document.getElementById(id);if(el&&b[id]!==null)el.value=b[id];}} } catch(e){}
  try { const e=JSON.parse(localStorage.getItem('mr140-evening')||'null'); if(e){EVENING_LOCKED=true;for(const id in e){if(id.startsWith('_'))continue;const el=document.getElementById(id);if(el&&e[id]!==null)el.value=e[id];}} } catch(e){}
  renderLockState(); restoreAllTS();
}

function onInput(e) { if(e.target&&e.target.id) stampField(e.target.id); calcScore(); }
function initInputListeners() { document.querySelectorAll('input[type="number"],select').forEach(el=>{el.addEventListener('input',onInput);el.addEventListener('change',onInput);}); }

async function handleBhavUpload() { const f=document.getElementById('bhav-file'),s=document.getElementById('bhav-spot'),st=document.getElementById('bhav-status'); if(!f||!f.files.length){if(st)st.textContent='Select CSV';return;} if(st)st.textContent='Uploading...'; const r=await bhavHandleUpload(f.files,s?s.value:''); if(st)st.textContent=r.ok?`✅ ${r.contracts} contracts. GH: ${r.github?'✅':'❌ '+r.error}`:`❌ ${r.error}`; }
function renderEveningSection() { try { const e=JSON.parse(localStorage.getItem('mr140-evening')||'null'); if(e){for(const id in e){if(id.startsWith('_'))continue;const el=document.getElementById(id);if(el&&e[id]!==null)el.value=e[id];}} } catch(e){} }

// ═══════════════════════════════════════════════════
// DEBUG
// ═══════════════════════════════════════════════════

function showDebug() {
  const el=document.getElementById('debug-output'); if(!el) return;
  el.style.display=el.style.display==='none'?'block':'none'; if(el.style.display==='none') return;
  let out='=== CHAIN DEBUG ===\n\n';
  for (const idx of ['NF','BNF']) { const chains=window._CHAINS[idx]; out+=`--- ${idx} ---\nExpiries: ${JSON.stringify(Object.keys(chains))}\n`; for (const exp in chains) { const c=chains[exp],sk=Object.keys(c.strikes||{}); out+=`\n[${exp}] DTE=${c.dte} TradingDTE=${c.tradingDte||'?'} Spot=${c.spot}\n  PCR=${c.pcr} MaxPain=${c.maxPain}\n  CallOI=${c.callOI} PutOI=${c.putOI}\n  CallWall=${c.callWall} PutWall=${c.putWall}\n  Strikes loaded: ${sk.length}\n`; const sample=sk.slice(0,3); for(const s of sample){const d=c.strikes[s];if(d.CE)out+=`  ${s} CE: LTP=${d.CE.ltp} OI=${d.CE.oi} Δ=${d.CE.delta} θ=${d.CE.theta} IV=${d.CE.iv}\n`;if(d.PE)out+=`  ${s} PE: LTP=${d.PE.ltp} OI=${d.PE.oi} Δ=${d.PE.delta} θ=${d.PE.theta} IV=${d.PE.iv}\n`;} if(c.spot&&sk.length>0){const atm=sk.reduce((b,s)=>Math.abs(+s-c.spot)<Math.abs(+b-c.spot)?s:b);const ad=c.strikes[atm];out+=`  ATM(${atm}):\n`;if(ad.CE)out+=`    CE: LTP=${ad.CE.ltp} OI=${ad.CE.oi} Δ=${ad.CE.delta}\n`;if(ad.PE)out+=`    PE: LTP=${ad.PE.ltp} OI=${ad.PE.oi} Δ=${ad.PE.delta}\n`;} } out+='\n'; }
  out+='--- HIDDEN FIELDS ---\n'; ['nf_price','bn_price','india_vix','nf_atr','bn_atr','pcr_nf','pcr_bn','max_pain_nf','nf_oi_call','nf_oi_put','nf_maxpain','bn_maxpain'].forEach(id=>{out+=`  ${id} = ${gv(id)}\n`;});
  if(window._RAW_CHAIN_SAMPLE){out+='\n--- RAW API RESPONSE ---\n';for(const key in window._RAW_CHAIN_SAMPLE){const s=window._RAW_CHAIN_SAMPLE[key];out+=`\n[${key}]\n  isArray=${s.isArray} type=${s.type} length=${s.length}\n`;if(s.topKeys)out+=`  topKeys: ${JSON.stringify(s.topKeys)}\n`;out+=`  sampleKeys: ${JSON.stringify(s.sampleKeys)}\n  firstItem: ${JSON.stringify(s.firstItem).substring(0,500)}\n`;}}
  el.textContent=out;
}

// ═══════════════════════════════════════════════════
// PHASE 2: POSITION DETECTION + SUPABASE LOGGING
// ═══════════════════════════════════════════════════

function parseUpstoxSymbol(sym) {
  // Parse tradingsymbol like "NIFTY2630656300CE" or "BANKNIFTY2630355200PE"
  if (!sym) return null;
  const s = sym.toUpperCase();
  let indexKey, rest;
  if (s.startsWith('BANKNIFTY')) { indexKey = 'BNF'; rest = s.slice(9); }
  else if (s.startsWith('NIFTY')) { indexKey = 'NF'; rest = s.slice(5); }
  else return null;
  // rest = "2630656300CE" → year(2)+month(1-2)+day(2)+strike+type
  const type = rest.slice(-2); // CE or PE
  if (type !== 'CE' && type !== 'PE') return null;
  const numPart = rest.slice(0, -2);
  // Extract expiry: first 5-7 chars are YYMDD or YYMMDD
  // Extract strike: remaining digits
  // Upstox format: YYMDD (e.g., 26306 = 2026-03-06)
  let expStr, strikeStr;
  if (numPart.length >= 7) {
    expStr = numPart.slice(0, 5); strikeStr = numPart.slice(5);
  } else {
    return null;
  }
  const strike = parseFloat(strikeStr);
  if (isNaN(strike)) return null;
  // Parse expiry: YY M DD or YY MM DD
  const yy = parseInt(expStr.slice(0, 2));
  const remaining = expStr.slice(2);
  let mm, dd;
  if (remaining.length === 3) { mm = parseInt(remaining.slice(0, 1)); dd = parseInt(remaining.slice(1)); }
  else if (remaining.length === 4) { mm = parseInt(remaining.slice(0, 2)); dd = parseInt(remaining.slice(2)); }
  else return null;
  const expiry = `20${yy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
  return { indexKey, expiry, strike, type };
}

function detectStrategy(legs) {
  if (!legs || legs.length === 0) return null;
  const ceLegs = legs.filter(l => l.type === 'CE');
  const peLegs = legs.filter(l => l.type === 'PE');
  const ceBuy = ceLegs.filter(l => l.action === 'BUY');
  const ceSell = ceLegs.filter(l => l.action === 'SELL');
  const peBuy = peLegs.filter(l => l.action === 'BUY');
  const peSell = peLegs.filter(l => l.action === 'SELL');

  // Iron Condor: 1 CE SELL + 1 CE BUY + 1 PE SELL + 1 PE BUY
  if (ceSell.length === 1 && ceBuy.length === 1 && peSell.length === 1 && peBuy.length === 1)
    return 'IRON_CONDOR';
  // Bull Put Spread: 1 PE SELL (higher) + 1 PE BUY (lower)
  if (peSell.length === 1 && peBuy.length === 1 && ceLegs.length === 0 && peSell[0].strike > peBuy[0].strike)
    return 'BULL_PUT';
  // Bear Call Spread: 1 CE SELL (lower) + 1 CE BUY (higher)
  if (ceSell.length === 1 && ceBuy.length === 1 && peLegs.length === 0 && ceSell[0].strike < ceBuy[0].strike)
    return 'BEAR_CALL';
  // Bull Call Spread: 1 CE BUY (lower) + 1 CE SELL (higher)
  if (ceBuy.length === 1 && ceSell.length === 1 && peLegs.length === 0 && ceBuy[0].strike < ceSell[0].strike)
    return 'BULL_CALL';
  // Bear Put Spread: 1 PE BUY (higher) + 1 PE SELL (lower)
  if (peBuy.length === 1 && peSell.length === 1 && ceLegs.length === 0 && peBuy[0].strike > peSell[0].strike)
    return 'BEAR_PUT';
  // Long Straddle: 1 CE BUY + 1 PE BUY, same strike
  if (ceBuy.length === 1 && peBuy.length === 1 && ceSell.length === 0 && peSell.length === 0 && ceBuy[0].strike === peBuy[0].strike)
    return 'LONG_STRADDLE';
  // Long Strangle: 1 CE BUY + 1 PE BUY, different strikes
  if (ceBuy.length === 1 && peBuy.length === 1 && ceSell.length === 0 && peSell.length === 0)
    return 'LONG_STRANGLE';

  return 'UNKNOWN';
}

async function detectAndLogPositions(rawPositions) {
  if (!rawPositions || !rawPositions.length) {
    // No positions — check if any OPEN trades in Supabase should be auto-closed
    await autoCloseGonePositions([]);
    renderPositionsTab();
    return;
  }

  // Parse and group legs by index + expiry
  const groups = {};
  for (const pos of rawPositions) {
    const qty = pos.quantity || pos.net_quantity || 0;
    if (qty === 0) continue; // Closed position
    const sym = pos.tradingsymbol || pos.trading_symbol || '';
    const parsed = parseUpstoxSymbol(sym);
    if (!parsed) continue;
    const key = `${parsed.indexKey}_${parsed.expiry}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push({
      strike: parsed.strike,
      type: parsed.type,
      action: qty > 0 ? 'BUY' : 'SELL',
      qty: Math.abs(qty),
      entry_ltp: pos.average_price || pos.buy_price || pos.sell_price || 0,
      pnl: pos.pnl || 0,
      symbol: sym
    });
  }

  // Detect strategies and log to Supabase
  const detected = [];
  for (const key in groups) {
    const legs = groups[key];
    const [indexKey, expiry] = key.split('_');
    const stratType = detectStrategy(legs);
    if (!stratType || stratType === 'UNKNOWN') continue;

    // Sort legs: SELL first, then BUY; PE first within same action
    legs.sort((a, b) => {
      if (a.action !== b.action) return a.action === 'SELL' ? -1 : 1;
      return a.strike - b.strike;
    });

    // Check if already in Supabase
    const existing = await dbFindOpenTrade(indexKey, expiry, legs[0].strike, legs[0].type, legs[0].action);

    if (!existing) {
      // New trade — insert to Supabase
      const trade = {
        strategy_type: stratType,
        index_key: indexKey,
        expiry: expiry,
        entry_spot: gv(indexKey === 'NF' ? 'nf_price' : 'bn_price'),
        entry_vix: gv('india_vix'),
        lots: legs[0].qty / (indexKey === 'NF' ? NF_LOT_SIZE : BNF_LOT),
      };
      // Calculate net premium from entry LTPs
      let netPrem = 0;
      for (let i = 0; i < Math.min(legs.length, 4); i++) {
        trade[`leg${i+1}`] = legs[i];
        const mult = legs[i].action === 'SELL' ? 1 : -1;
        netPrem += mult * legs[i].entry_ltp;
      }
      trade.entry_premium = +netPrem.toFixed(2);
      const isCredit = ['BULL_PUT','BEAR_CALL','IRON_CONDOR'].includes(stratType);
      const lotSize = indexKey === 'NF' ? NF_LOT_SIZE : BNF_LOT;
      const width = indexKey === 'NF' ? NF_IC_WIDTH : BNF_IC_WIDTH;
      const safeLots = Math.max(1, trade.lots || 1);
      if (isCredit) {
        trade.max_profit = +(netPrem * lotSize * safeLots).toFixed(0);
        trade.max_loss = +((width - netPrem) * lotSize * safeLots).toFixed(0);
      } else {
        trade.max_profit = +((width - Math.abs(netPrem)) * lotSize * safeLots).toFixed(0);
        trade.max_loss = +(Math.abs(netPrem) * lotSize * safeLots).toFixed(0);
      }
      trade.target_profit = +(trade.max_profit * 0.5).toFixed(0);
      trade.stop_loss = +(trade.max_loss * 0.5).toFixed(0);

      const result = await dbInsertTrade(trade);
      console.log(`[positions] Logged new ${stratType}: ${indexKey} ${expiry}`, result);
      detected.push({ ...trade, id: result.id, legs, status: 'OPEN', recommendation: 'HOLD', current_pnl: 0 });
    } else {
      // Existing trade — update with live P&L + track peak
      const livePnl = legs.reduce((sum, l) => sum + l.pnl, 0);
      const liveSpot = gv(indexKey === 'NF' ? 'nf_price' : 'bn_price');
      const prevPeak = existing.peak_pnl || 0;
      const newPeak = Math.max(prevPeak, livePnl);
      existing.peak_pnl = newPeak; // Pass to computeRecommendation
      const rec = computeRecommendation(existing, livePnl, liveSpot, expiry);
      await dbUpdateTrade(existing.id, {
        current_pnl: +livePnl.toFixed(0),
        current_spot: liveSpot,
        recommendation: rec,
        peak_pnl: +newPeak.toFixed(0)
      });
      detected.push({ ...existing, legs, current_pnl: +livePnl.toFixed(0), peak_pnl: +newPeak.toFixed(0), recommendation: rec });
    }
  }

  // Check for auto-close
  await autoCloseGonePositions(Object.keys(groups));

  // Store and render
  window._DETECTED_POSITIONS = detected;
  renderPositionsTab();
  // Smart alerts + notifications
  checkAndNotify(detected);
  // Phase 3: auto-expire past trades + refresh journal
  await autoExpireOpenTrades();
  renderJournalTab();
}

async function autoCloseGonePositions(activeKeys) {
  const openTrades = await dbGetOpenTrades();
  for (const trade of openTrades) {
    const key = `${trade.index_key}_${trade.expiry}`;
    if (!activeKeys.includes(key)) {
      // This trade is no longer in Upstox positions — auto-close
      await dbCloseTrade(trade.id, {
        status: 'CLOSED',
        exit_reason: 'AUTO_DETECT',
        actual_pnl: trade.current_pnl || 0
      });
      console.log(`[positions] Auto-closed trade #${trade.id}: ${trade.strategy_type} ${trade.index_key} ${trade.expiry}`);
    }
  }
}

// ═══════════════════════════════════════════════════
// TRADE BOOK EXIT MATCHING — Real P&L from fills
// ═══════════════════════════════════════════════════

async function matchTradeBookExits(trades) {
  if (!trades || !trades.length) return;
  if (typeof dbGetOpenTrades !== 'function') return;

  const openTrades = await dbGetOpenTrades();
  if (!openTrades.length) return;

  // Parse trade book fills
  const fills = [];
  for (const t of trades) {
    const sym = t.tradingsymbol || t.trading_symbol || '';
    const parsed = parseUpstoxSymbol(sym);
    if (!parsed) continue;
    fills.push({
      ...parsed,
      txnType: t.transaction_type || '',  // BUY or SELL
      price: t.price || t.average_price || 0,
      qty: Math.abs(t.quantity || 0),
      tradeId: t.trade_id || '',
      tradedAt: t.traded_at || t.fill_timestamp || ''
    });
  }

  if (!fills.length) return;

  // For each OPEN trade, check if trade book has exit fills
  for (const trade of openTrades) {
    const legs = [];
    for (let i = 1; i <= 4; i++) {
      if (trade[`leg${i}_strike`]) {
        legs.push({
          strike: trade[`leg${i}_strike`],
          type: trade[`leg${i}_type`],
          action: trade[`leg${i}_action`],
          entryLtp: trade[`leg${i}_entry_ltp`] || 0
        });
      }
    }
    if (!legs.length) continue;

    // Find exit fills: same strike+type but REVERSED action
    // Entry SELL → Exit BUY, Entry BUY → Exit SELL
    const exitFills = [];
    for (const leg of legs) {
      const reverseAction = leg.action === 'SELL' ? 'BUY' : 'SELL';
      const match = fills.find(f =>
        f.indexKey === trade.index_key &&
        f.expiry === trade.expiry &&
        f.strike === leg.strike &&
        f.type === leg.type &&
        f.txnType === reverseAction
      );
      if (match) exitFills.push({ ...leg, exitPrice: match.price, exitTime: match.tradedAt });
    }

    // All legs must have exit fills (all legs cleared at once)
    if (exitFills.length !== legs.length) continue;

    // Calculate real P&L from actual fill prices
    const lotSize = trade.index_key === 'NF' ? NF_LOT_SIZE : BNF_LOT;
    const lots = trade.lots || 1;
    let exitPremium = 0, entryPremium = 0;

    for (const ef of exitFills) {
      const entryMult = ef.action === 'SELL' ? 1 : -1;  // credit +, debit -
      const exitMult = ef.action === 'SELL' ? -1 : 1;     // closing reverses
      entryPremium += entryMult * ef.entryLtp;
      exitPremium += exitMult * ef.exitPrice;
    }

    // P&L = (entry premium + exit premium) × lotSize × lots
    // For credit: entry +ve (collected), exit -ve (paid to close) → profit if exit < entry
    // For debit: entry -ve (paid), exit +ve (received) → profit if exit > entry
    const actualPnl = +((entryPremium + exitPremium) * lotSize * lots).toFixed(0);

    // Determine exit reason
    const target = trade.target_profit || 0;
    const sl = trade.stop_loss || 0;
    let exitReason = 'MANUAL';
    if (target > 0 && actualPnl >= target * 0.8) exitReason = 'TARGET';
    else if (sl > 0 && actualPnl <= -(sl * 0.8)) exitReason = 'SL';

    // Close trade in Supabase with real P&L
    await dbCloseTrade(trade.id, {
      status: 'CLOSED',
      exit_premium: +exitPremium.toFixed(2),
      actual_pnl: actualPnl,
      exit_reason: exitReason
    });

    console.log(`[tradebook] Matched exit for #${trade.id}: ${trade.strategy_type} ${trade.index_key} ${trade.expiry} → P&L ₹${actualPnl} (${exitReason})`);
  }

  // Refresh journal after processing exits
  if (typeof renderJournalTab === 'function') renderJournalTab();
}

// ═══════════════════════════════════════════════════
// HOLD / EXIT / TRAIL ENGINE
// ═══════════════════════════════════════════════════

function computeRecommendation(trade, currentPnl, currentSpot, expiry) {
  const target = trade.target_profit || 0;
  const sl = trade.stop_loss || 0;
  const dte = daysTo(expiry);
  const isCredit = ['BULL_PUT','BEAR_CALL','IRON_CONDOR'].includes(trade.strategy_type);
  const peakPnl = trade.peak_pnl || 0;

  // ── EXIT NOW: hard limits ──
  if (target > 0 && currentPnl >= target) return 'EXIT_NOW';
  if (sl > 0 && currentPnl <= -sl) return 'EXIT_NOW';
  // Spot breaching sell strike danger zone
  if (currentSpot && trade.leg1_strike) {
    const vix = gv('india_vix') || 14;
    const tdte = tradingDaysTo(expiry);
    const em = bsExpectedMove(currentSpot, vix, tdte);
    const sellStrike = trade.leg1_strike;
    if (Math.abs(currentSpot - sellStrike) < em.one_sigma * 0.5) return 'EXIT_NOW';
  }
  if (isCredit && dte <= 3 && currentPnl < 0) return 'EXIT_NOW';

  // ── BOOK PROFIT: take the money ──
  if (target > 0 && currentPnl >= target * 0.35 && dte <= 5) return 'BOOK_PROFIT';
  if (target > 0 && currentPnl >= target * 0.40) return 'BOOK_PROFIT';

  // ── EXIT EARLY: deterioration from peak ──
  if (peakPnl > 0 && currentPnl > 0 && currentPnl < peakPnl * 0.70) return 'EXIT_EARLY';
  // Was profitable, now losing
  if (peakPnl > target * 0.20 && currentPnl <= 0) return 'EXIT_EARLY';

  // ── TRAIL: protect gains ──
  if (isCredit) {
    if (dte >= 4 && dte <= 10 && trade.max_profit && currentPnl > trade.max_profit * 0.30) return 'TRAIL';
  } else {
    if (dte <= 5 && currentPnl <= 0) return 'EXIT_NOW'; // Debit: no move, theta killing
    if (currentPnl > 0 && trade.max_loss && currentPnl > trade.max_loss * 0.20) return 'TRAIL';
  }

  return 'HOLD';
}

const ALERT_META = {
  EXIT_NOW:    { label: 'EXIT NOW',    css: 'rec-exit',   banner: 'alert-exit',   icon: '🔴', priority: 5 },
  EXIT_EARLY:  { label: 'EXIT EARLY',  css: 'rec-early',  banner: 'alert-early',  icon: '🟠', priority: 4 },
  BOOK_PROFIT: { label: 'BOOK PROFIT', css: 'rec-book',   banner: 'alert-book',   icon: '🟢', priority: 3 },
  TRAIL:       { label: 'TRAIL',       css: 'rec-trail',  banner: 'alert-trail',  icon: '🟡', priority: 2 },
  HOLD:        { label: 'HOLD',        css: 'rec-hold',   banner: '',             icon: '⚪', priority: 0 }
};

// ═══════════════════════════════════════════════════
// NOTIFICATION ENGINE — PWA Android Notifications
// ═══════════════════════════════════════════════════

async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const perm = await Notification.requestPermission();
  return perm === 'granted';
}

async function fireNotification(title, body, tag) {
  const hasPermission = await requestNotificationPermission();
  if (!hasPermission) return;

  // Use service worker registration if available
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    const reg = await navigator.serviceWorker.ready;
    reg.showNotification(title, {
      body: body,
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="80" font-size="80">⚡</text></svg>',
      badge: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="80" font-size="80">⚡</text></svg>',
      tag: tag || 'market-radar',
      renotify: true,
      requireInteraction: true,
      vibrate: [200, 100, 200]
    });
  } else {
    // Fallback: basic Notification API
    new Notification(title, { body: body, tag: tag || 'market-radar' });
  }
}

function checkAndNotify(positions) {
  if (!positions || !positions.length) return;

  const alerts = [];
  for (const pos of positions) {
    const rec = pos.recommendation || 'HOLD';
    const meta = ALERT_META[rec];
    if (!meta || meta.priority < 3) continue; // Only BOOK_PROFIT, EXIT_EARLY, EXIT_NOW

    const stratName = STRAT_LABELS[pos.strategy_type] || pos.strategy_type;
    const pnl = pos.current_pnl || 0;
    const pnlStr = (pnl >= 0 ? '+' : '') + '₹' + pnl.toLocaleString('en-IN');
    const target = pos.target_profit || 0;
    const pct = target > 0 ? Math.round((pnl / target) * 100) : 0;

    alerts.push({
      title: `${meta.icon} ${meta.label} — ${stratName} ${pos.index_key}`,
      body: `P&L ${pnlStr} (${pct}% of target) · DTE ${daysTo(pos.expiry)}`,
      priority: meta.priority,
      rec: rec
    });
  }

  // Fire notification for highest priority alert
  if (alerts.length > 0) {
    alerts.sort((a, b) => b.priority - a.priority);
    const top = alerts[0];
    fireNotification(top.title, top.body, `mr-${top.rec}`);
  }

  // Render banner on all tabs
  renderAlertBanner(alerts);
}

function renderAlertBanner(alerts) {
  const el = document.getElementById('alert-banner');
  if (!el) return;

  if (!alerts || !alerts.length) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }

  alerts.sort((a, b) => b.priority - a.priority);
  const top = alerts[0];
  const bannerClass = ALERT_META[top.rec] ? ALERT_META[top.rec].banner : '';

  el.className = `alert-banner ${bannerClass}`;
  el.style.display = 'block';
  el.innerHTML = alerts.map(a => `<div class="alert-banner-row">${a.title}<br><span class="alert-banner-detail">${a.body}</span></div>`).join('');
  el.onclick = () => go(2); // Tap → POSITIONS tab
}

// ═══════════════════════════════════════════════════
// POSITIONS TAB RENDER
// ═══════════════════════════════════════════════════

async function renderPositionsTab() {
  const openEl = document.getElementById('positions-open');
  const histEl = document.getElementById('positions-history');
  if (!openEl) return;

  // Render open positions
  const detected = window._DETECTED_POSITIONS || [];
  if (detected.length === 0) {
    openEl.innerHTML = '<div class="cmd-placeholder">No open positions detected</div>';
  } else {
    openEl.innerHTML = detected.map(pos => {
      const meta = ALERT_META[pos.recommendation] || ALERT_META.HOLD;
      const pnlClass = (pos.current_pnl || 0) >= 0 ? 'profit' : 'loss';
      const legStr = (pos.legs || []).map(l => `${l.action} ${l.strike} ${l.type}`).join(' | ');
      const peakStr = pos.peak_pnl ? ` · Peak: ₹${pos.peak_pnl.toLocaleString('en-IN')}` : '';
      return `<div class="pos-card">
        <div class="pos-card-header">
          <span class="pos-strat-name">${STRAT_LABELS[pos.strategy_type] || pos.strategy_type}</span>
          <span class="pos-rec ${meta.css}">${meta.label}</span>
        </div>
        <div class="pos-card-index">${pos.index_key} · ${pos.expiry} · DTE ${daysTo(pos.expiry)}</div>
        <div class="pos-card-legs">${legStr}</div>
        <div class="pos-card-pnl">
          <span>P&L: <span class="${pnlClass}">₹${(pos.current_pnl||0).toLocaleString('en-IN')}</span>${peakStr}</span>
          <span>Target: ₹${(pos.target_profit||0).toLocaleString('en-IN')} | SL: ₹${(pos.stop_loss||0).toLocaleString('en-IN')}</span>
        </div>
      </div>`;
    }).join('');
  }

  // Render recent trade history from Supabase
  if (!histEl) return;
  try {
    const allTrades = await dbGetAllTrades(10);
    if (!allTrades.length) { histEl.innerHTML = '<div class="cmd-placeholder">No trade history yet</div>'; return; }
    histEl.innerHTML = allTrades.map(t => {
      const statusClass = t.status === 'OPEN' ? 'status-open' : t.status === 'CLOSED' ? 'status-closed' : 'status-expired';
      const pnl = t.actual_pnl || t.current_pnl || 0;
      const pnlClass = pnl >= 0 ? 'profit' : 'loss';
      return `<div class="hist-row">
        <span class="hist-strat">${t.strategy_type}</span>
        <span class="hist-index">${t.index_key}</span>
        <span class="hist-expiry">${t.expiry}</span>
        <span class="${statusClass}">${t.status}</span>
        <span class="${pnlClass}">₹${pnl.toLocaleString('en-IN')}</span>
      </div>`;
    }).join('');
  } catch(e) {
    histEl.innerHTML = '<div class="cmd-placeholder">Could not load trade history</div>';
  }
}

// ═══════════════════════════════════════════════════
// PHASE 3: AUTO-EXPIRE + TRADE JOURNAL
// ═══════════════════════════════════════════════════

async function autoExpireOpenTrades() {
  if (typeof dbGetOpenTrades !== 'function') return;
  const openTrades = await dbGetOpenTrades();
  if (!openTrades.length) return;

  const today = new Date(); today.setHours(0,0,0,0);

  for (const trade of openTrades) {
    if (!trade.expiry) continue;
    const expDate = new Date(trade.expiry); expDate.setHours(0,0,0,0);
    if (expDate >= today) continue; // Not yet expired

    // Trade has expired — calculate final P&L
    let finalPnl = trade.current_pnl || 0;

    // If we have last known spot + legs, calculate intrinsic value at expiry
    const lastSpot = trade.current_spot || trade.entry_spot || 0;
    if (lastSpot > 0 && trade.leg1_strike) {
      const isCredit = ['BULL_PUT','BEAR_CALL','IRON_CONDOR'].includes(trade.strategy_type);
      const lotSize = trade.index_key === 'NF' ? NF_LOT_SIZE : BNF_LOT;
      const lots = trade.lots || 1;

      // Calculate intrinsic at expiry for each leg
      let intrinsic = 0;
      for (let i = 1; i <= 4; i++) {
        const strike = trade[`leg${i}_strike`];
        const type = trade[`leg${i}_type`];
        const action = trade[`leg${i}_action`];
        const entryLtp = trade[`leg${i}_entry_ltp`] || 0;
        if (!strike || !type || !action) continue;

        const expiryVal = type === 'CE' ? Math.max(lastSpot - strike, 0) : Math.max(strike - lastSpot, 0);
        const mult = action === 'SELL' ? -1 : 1;
        intrinsic += mult * (expiryVal - entryLtp);
      }
      finalPnl = +(intrinsic * lotSize * lots).toFixed(0);
    }

    if (typeof dbExpireTrade === 'function') {
      await dbExpireTrade(trade.id, finalPnl);
      console.log(`[journal] Auto-expired trade #${trade.id}: ${trade.strategy_type} ${trade.index_key} ${trade.expiry} → P&L ₹${finalPnl}`);
    }
  }
}

async function renderJournalTab() {
  const statsEl = document.getElementById('journal-stats');
  const tradesEl = document.getElementById('journal-trades');
  if (!statsEl) return;

  // Fetch stats
  const stats = typeof dbGetTradeStats === 'function' ? await dbGetTradeStats() : null;

  if (!stats) {
    statsEl.innerHTML = '<div class="cmd-placeholder">No closed trades yet — complete a trade to see journal</div>';
    if (tradesEl) tradesEl.innerHTML = '';
    return;
  }

  // Render stats summary
  const pnlClass = stats.totalPnl >= 0 ? 'profit' : 'loss';
  let stratRows = '';
  for (const st in stats.byStrat) {
    const s = stats.byStrat[st];
    const wr = s.total > 0 ? ((s.wins / s.total) * 100).toFixed(0) : 0;
    const spnl = s.pnl >= 0 ? 'profit' : 'loss';
    stratRows += `<div class="journal-strat-row"><span>${STRAT_LABELS[st] || st}</span><span>${s.wins}/${s.total} (${wr}%)</span><span class="${spnl}">₹${s.pnl.toLocaleString('en-IN')}</span></div>`;
  }

  statsEl.innerHTML = `
    <div class="journal-stats-grid">
      <div class="journal-stat"><div class="journal-stat-val ${pnlClass}">₹${stats.totalPnl.toLocaleString('en-IN')}</div><div class="journal-stat-label">Total P&L</div></div>
      <div class="journal-stat"><div class="journal-stat-val">${stats.winRate}%</div><div class="journal-stat-label">Win Rate (${stats.wins}/${stats.total})</div></div>
      <div class="journal-stat"><div class="journal-stat-val">₹${stats.avgPnl.toLocaleString('en-IN')}</div><div class="journal-stat-label">Avg P&L / Trade</div></div>
      <div class="journal-stat"><div class="journal-stat-val">${stats.total}</div><div class="journal-stat-label">Total Trades</div></div>
      <div class="journal-stat"><div class="journal-stat-val profit">₹${stats.bestTrade.pnl.toLocaleString('en-IN')}</div><div class="journal-stat-label">Best (${stats.bestTrade.type} ${stats.bestTrade.index})</div></div>
      <div class="journal-stat"><div class="journal-stat-val loss">₹${stats.worstTrade.pnl.toLocaleString('en-IN')}</div><div class="journal-stat-label">Worst (${stats.worstTrade.type} ${stats.worstTrade.index})</div></div>
    </div>
    ${stratRows ? '<div class="section-title" style="margin-top:8px;font-size:11px">By Strategy</div>' + stratRows : ''}
  `;

  // Render recent closed trades
  if (!tradesEl) return;
  const closed = typeof dbGetClosedTrades === 'function' ? await dbGetClosedTrades(15) : [];
  if (!closed.length) {
    tradesEl.innerHTML = '<div class="cmd-placeholder">No closed trades</div>';
    return;
  }

  tradesEl.innerHTML = closed.map(t => {
    const pnl = t.actual_pnl || 0;
    const pClass = pnl >= 0 ? 'profit' : 'loss';
    const reason = t.exit_reason || 'MANUAL';
    const reasonClass = reason === 'EXPIRY' ? 'reason-expiry' : reason === 'TARGET' ? 'reason-target' : reason.includes('SL') ? 'reason-sl' : 'reason-manual';
    const legs = [];
    for (let i = 1; i <= 4; i++) {
      if (t[`leg${i}_strike`]) legs.push(`${t[`leg${i}_action`]} ${t[`leg${i}_strike`]} ${t[`leg${i}_type`]}`);
    }
    return `<div class="journal-trade">
      <div class="journal-trade-header">
        <span class="journal-trade-strat">${STRAT_LABELS[t.strategy_type] || t.strategy_type}</span>
        <span class="journal-trade-pnl ${pClass}">${pnl >= 0 ? '+' : ''}₹${pnl.toLocaleString('en-IN')}</span>
      </div>
      <div class="journal-trade-meta">${t.index_key} · ${t.expiry} · ${t.entry_date || '—'} → ${t.exit_date || '—'}</div>
      <div class="journal-trade-meta">${legs.join(' | ')}</div>
      <span class="journal-trade-reason ${reasonClass}">${reason}</span>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.tab').forEach(tab=>{
    tab.addEventListener('click',()=>{
      const n = parseInt(tab.id.replace('t',''));
      go(n);
      // Render journal when switching to CLOSE tab
      if (n === 3) renderJournalTab();
    });
  });
  const lr=document.getElementById('btn-lock-radar'); if(lr) lr.addEventListener('click',toggleRadar);
  const lb=document.getElementById('btn-lock-breadth'); if(lb) lb.addEventListener('click',toggleBreadth);
  const le=document.getElementById('btn-lock-evening'); if(le) le.addEventListener('click',toggleEvening);
  const bh=document.getElementById('btn-bhav-upload'); if(bh) bh.addEventListener('click',handleBhavUpload);
  const dbg=document.getElementById('btn-debug'); if(dbg) dbg.addEventListener('click',showDebug);
  initInputListeners(); initDrawer(); restoreSavedState(); renderEveningSection(); calcScore(); go(0);
  // Load positions + auto-expire + journal on startup
  renderPositionsTab();
  autoExpireOpenTrades();
  console.log('[app.js] Market Radar v5.0 — Phase 3 Active');
});
