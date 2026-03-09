'use strict';
// ══════════════════════════════════════════════════════════════
// app.js — Market Radar v2.0 main application
// Strategy engine, scoring, UI, entry signals
// ══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// MARKET RADAR v2.2.0
// v2.1.0: 7-strategy engine, moneyness labels, NSE calendar fix.
// v2.2.0: Panel 3 restructured — inputs on top, ANALYSE button,
//         output below. VIX live override field (strat_vix) fixes
//         silent Radar dependency bug. VIX comparison strip shows
//         morning vs live VIX, warns on ≥1.5pt shift. BNF inputs
//         collapsed by default. No auto-render on tab switch.
// ═══════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────
let SCORE = null, DIRECTION = '', STRAT_AUTO = '';
let DRIFT = null; // bhav overnight shift signal — set in buildCommand()
let RADAR_LOCKED = false, BREADTH_LOCKED = false, EVENING_LOCKED = false;
let ANALYSIS_VIX = null;  // v2.2.0: VIX at time of last Analyse tap
// ── Weights (sum = 1.0000) ─────────────────────────────────────
// v1.5.0: PCR removed from score (38% directional accuracy — worse than random).
// Its 4.76% weight redistributed: +2.38% to FII (most predictive), +2.38% to GIFT gap.
// PCR is KEPT for strike placement only (pcrPutAdj / pcrCallAdj / pcrPremAdj).
const W = {
  gift_gap:   0.2143,  // was 0.1905 (+0.0238 from PCR)
  gift_trend: 0.0572,
  sp500:      0.1619,
  dow:        0.0571,
  usvix:      0.0476,
  nk:         0.0571,
  hsi:        0.0286,
  crude:      0.0667,
  gold:       0.0286,
  inr:        0.0286,
  yld:        0.0381,
  fii:        0.1000,  // was 0.0762 (+0.0238 from PCR)
  close_char: 0.0381,
  max_pain:   0.0286,
  n50adv:     0.0190,
  n50dma:     0.0095,
  bnfadv:     0.0190,
};

// ── NSE Holiday Calendar 2026 ──────────────────────────────────
// Source: Official NSE circular NSE/CMTR/71775 dated Dec 12, 2025
// Fixed v2.1.0: Removed Jan-01 (not NSE holiday), Nov-09 (not in circular)
// Fixed Jun-16 → Jun-26 (Muharram). Added: Mar-26 (Ram Navami),
// May-28 (Bakri Id), Sep-14 (Ganesh Chaturthi), Oct-02 (Gandhi Jayanti),
// Oct-20 (Dussehra). Total: 15 weekday holidays (matches official list).
const NSE_HOLIDAYS_2026 = [
  '2026-01-26',  // Republic Day
  '2026-03-03',  // Holi
  '2026-03-26',  // Shri Ram Navami
  '2026-03-31',  // Shri Mahavir Jayanti
  '2026-04-03',  // Good Friday
  '2026-04-14',  // Dr. Baba Saheb Ambedkar Jayanti
  '2026-05-01',  // Maharashtra Day
  '2026-05-28',  // Bakri Id
  '2026-06-26',  // Muharram
  '2026-09-14',  // Ganesh Chaturthi
  '2026-10-02',  // Mahatma Gandhi Jayanti
  '2026-10-20',  // Dussehra
  '2026-11-10',  // Diwali-Balipratipada
  '2026-11-24',  // Prakash Gurpurb Sri Guru Nanak Dev
  '2026-12-25',  // Christmas
].map(s => new Date(s+'T00:00:00'));

function isTradingDay(d) {
  const day = d.getDay();
  if (day === 0 || day === 6) return false; // weekend
  return !NSE_HOLIDAYS_2026.some(h =>
    h.getFullYear()===d.getFullYear() &&
    h.getMonth()===d.getMonth() &&
    h.getDate()===d.getDate()
  );
}

function prevTradingDay(d) {
  const p = new Date(d);
  p.setDate(p.getDate() - 1);
  while (!isTradingDay(p)) p.setDate(p.getDate() - 1);
  return p;
}

function actualExpiry(raw) {
  if (isTradingDay(raw)) return { d: new Date(raw), shifted: false };
  return { d: prevTradingDay(raw), shifted: true };
}

// ── Helpers ────────────────────────────────────────────────────
const gv  = id => { const e=document.getElementById(id); if(!e) return null; const v=parseFloat(e.value); return isNaN(v)?null:v; };
const gvi = id => { const e=document.getElementById(id); if(!e) return null; const v=parseInt(e.value); return isNaN(v)?null:v; };
const gs  = id => { const e=document.getElementById(id); if(!e) return null; return e.value||null; };
const r5   = x  => Math.round(x/5)*5;      // credit rounding to nearest ₹5
const r50  = x  => Math.round(x/50)*50;   // NF strike snapping — NSE NF strikes in multiples of 50
const r100 = x  => Math.round(x/100)*100; // BNF strike snapping — NSE BNF strikes in multiples of 100
const fi  = n  => Math.abs(Math.round(n)).toLocaleString('en-IN');
const fr  = n  => '₹'+fi(n);
const pct = (c,p)=> p>0?(c-p)/p*100:null;
function valid(v){ return v!==null && v!==0 && !isNaN(v); }

// ── Timestamp system ───────────────────────────────────────────
const TS_KEY = 'mr140-ts';
function getTSStore(){ try{ return JSON.parse(localStorage.getItem(TS_KEY)||'{}'); }catch{ return {}; } }
function saveTSStore(s){ try{ localStorage.setItem(TS_KEY,JSON.stringify(s)); }catch{} }

// v1.6.1: FII F&O signal handler
function onFIIFO() {
  const futEl = document.getElementById('fii_fut');
  const optEl = document.getElementById('fii_opt');
  if (futEl && futEl.value !== '') stampField('fii_fut');
  if (optEl && optEl.value !== '') stampField('fii_opt');
  const fut = futEl && futEl.value !== '' ? parseFloat(futEl.value) : null;
  const opt = optEl && optEl.value !== '' ? parseFloat(optEl.value) : null;
  const sig = document.getElementById('fii-fo-signal');
  const hdr = document.getElementById('fii-fo-hdr');
  const txt = document.getElementById('fii-fo-txt');
  if (!sig) return;
  if (fut === null && opt === null) { sig.style.display = 'none'; return; }
  const net = (fut || 0) + (opt || 0);
  let color = 'var(--am)', icon = '⚡', summary = '', detail = '';
  if (opt !== null) {
    if (opt <= -15000) {
      color='var(--rd)'; icon='🔴'; summary='MASSIVE PUT BUYING — extreme bearish hedge';
      detail='FII Idx Opt '+Math.round(opt).toLocaleString('en-IN')+'Cr: FII loading puts aggressively. Widen call strikes or avoid new IC entries.';
    } else if (opt <= -5000) {
      color='var(--am)'; icon='⚠️'; summary='Heavy put buying — bearish derivative positioning';
      detail='FII Idx Opt '+Math.round(opt).toLocaleString('en-IN')+'Cr: Elevated put buying. Favour puts over calls on IC.';
    } else if (opt >= 5000) {
      color='var(--gn)'; icon='🟢'; summary='FII net call buying / put selling — bullish derivatives';
      detail='FII Idx Opt +'+Math.round(opt).toLocaleString('en-IN')+'Cr: FII selling puts or buying calls. IC call side safer.';
    } else {
      color='var(--am)'; icon='💡'; summary='FII option flow moderate — no strong signal';
      detail='FII Idx Opt '+(opt>=0?'+':'')+Math.round(opt).toLocaleString('en-IN')+'Cr: No strong directional derivatives signal.';
    }
  }
  const futStr = fut!==null ? '  Fut: '+(fut>=0?'+':'')+Math.round(fut).toLocaleString('en-IN')+'Cr' : '';
  const optStr = opt!==null ? '  Opt: '+(opt>=0?'+':'')+Math.round(opt).toLocaleString('en-IN')+'Cr' : '';
  const netStr = '  F&O Net: '+(net>=0?'+':'')+Math.round(net).toLocaleString('en-IN')+'Cr';
  sig.style.display = 'block';
  sig.style.borderLeftColor = color;
  hdr.style.color = color;
  hdr.innerHTML = icon+' FII F&O SIGNAL — '+summary;
  txt.innerHTML = '<span style="color:var(--muted)">'+futStr+optStr+netStr+'</span><br>'+detail;
}

function stampField(id){
  const e=document.getElementById(id);
  if(!e||!e.value) return;
  const s=getTSStore();
  s[id]={ts:Date.now(),val:e.value};
  saveTSStore(s);
  renderTS(id,s[id].ts);
}

function renderTS(id, ts){
  const el=document.getElementById('ts-'+id);
  if(!el||!ts) return;
  const d=new Date(ts), now=new Date();
  const sameDay=d.toDateString()===now.toDateString();
  const hm=String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
  const diffDays=Math.floor((now-d)/86400000);
  if(sameDay){ el.textContent=hm; el.className='ts fresh igrid-ts'; }
  else if(diffDays===1){ el.textContent='yesterday ⚠'; el.className='ts stale igrid-ts'; }
  else{ el.textContent=diffDays+'d ago'; el.className='ts old igrid-ts'; }
}

function restoreTS(){
  const s=getTSStore();
  Object.keys(s).forEach(id=>renderTS(id,s[id]?.ts));
}

// ── Time lock ───────────────────────────────────────────────────
function getIST(){
  const now=new Date();
  const ist=new Date(now.getTime()+now.getTimezoneOffset()*60000+19800000);
  return { h: ist.getHours(), m: ist.getMinutes(), total: ist.getHours()*60+ist.getMinutes() };
}

function checkLocks(){
  const { total: t } = getIST();
  const MORNING=8*60+30;
  const EVENING=15*60+45;
  const isWeekend = isWeekendOrHoliday();

  // Radar (morning lock): only open on trading days after 8:30am
  const mornOk = !isWeekend && t>=MORNING;
  // Breadth: hard unlock at 9:30, soft advisory shown until 10:15 (data still settling)
  const BREADTH_OPEN = 9*60+30;
  // Smarts (evening lock): open on trading days after 3:45pm
  //   AND stays open all weekend (Sat + Sun) so Friday data can be entered anytime
  const eveOk  = isWeekend || t>=EVENING;

  const mBanner=document.getElementById('morning-lock');
  if(!mornOk && !RADAR_LOCKED){
    // Weekend: show "Monday 8:30 AM" instead of countdown
    if(isWeekend){
      const ist = new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Kolkata'}));
      const next = new Date(ist);
      // Find next Monday
      const daysUntilMon = (1 - ist.getDay() + 7) % 7 || 7;
      next.setDate(ist.getDate() + daysUntilMon);
      const mon = next.toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'short'});
      document.getElementById('morning-msg').textContent=`Weekend — opens ${mon} at 8:30 AM IST`;
      document.getElementById('morning-lock').querySelector('.lock-sub').textContent='Market data entry unlocks Monday morning';
      document.getElementById('breadth-msg').textContent=`Weekend — enter breadth data on ${mon}`;
    } else {
      const ml=MORNING-t;
      document.getElementById('morning-msg').textContent=`Opens in ${Math.floor(ml/60)}h ${ml%60}m (8:30 AM IST)`;
      document.getElementById('breadth-msg').textContent=`Opens in ${Math.floor(ml/60)}h ${ml%60}m (8:30 AM IST)`;
    }
    mBanner.classList.add('show');
    setDisabled(['sp500','dow','usvix','nk','hsi','crude','gold','inr','yld',
      'gift_now','nifty_prev','gift_6am','india_vix','fii','fii_fut','fii_opt','dii',
      'max_pain_nf','max_pain_bn','close_char'], true);
    setDisabled(['n50adv','n50dma','bnfadv'],true);
    document.getElementById('breadth-lock').classList.add('show');
  } else if(!isWeekend && t < BREADTH_OPEN && !BREADTH_LOCKED){
    // Before 9:30 — hard lock
    mBanner.classList.remove('show');
    document.getElementById('breadth-lock').classList.add('show');
    const bl = BREADTH_OPEN - t;
    document.getElementById('breadth-msg').textContent=`Opens at 9:30 AM (${Math.floor(bl/60)}h ${bl%60}m)`;
    setDisabled(['n50adv','n50dma','bnfadv'],true);
  } else {
    mBanner.classList.remove('show');
    if(!BREADTH_LOCKED) document.getElementById('breadth-lock').classList.remove('show');
    // Soft timing advisory after 9:30 (replaces hard lock)
    updateBreadthTimingTip(t);
  }

  const eBanner=document.getElementById('evening-lock');
  const eContent=document.getElementById('evening-content');
  if(!eveOk){
    const el=EVENING-t;
    document.getElementById('evening-msg').textContent=`Opens in ${Math.floor(el/60)}h ${el%60}m (3:45 PM IST)`;
    eBanner.classList.add('show');
    eContent.style.display='none';
  } else {
    eBanner.classList.remove('show');
    eContent.style.display='block';
  }

  const mktOpen = !isWeekendOrHoliday() && t>=9*60+15 && t<=15*60+30;
  document.getElementById('mkt-dot').style.background=mktOpen?'var(--gn)':'var(--rd)';
  document.getElementById('mkt-label').textContent=mktOpen?'OPEN':(isWeekendOrHoliday()?'WEEKEND':'CLOSED');

  // Update entry time signal
  updateEntrySignal();
}

function updateBreadthTimingTip(t) {
  const el = document.getElementById('breadth-timing-tip');
  if (!el) return;
  const OPTIMAL_START = 9*60+30;
  const OPTIMAL_PEAK  = 9*60+45;
  const OPTIMAL_END   = 10*60+15;
  if (t < OPTIMAL_START) { el.style.display='none'; return; }
  if (t < OPTIMAL_PEAK) {
    el.style.display='block';
    el.innerHTML = `<div style="font-size:8.5px;color:var(--am);padding:6px 14px;border-bottom:1px solid var(--border)">` +
      `⏳ <strong>Market just opened</strong> — you can enter now but values may still be settling. ` +
      `Optimal window is <strong>9:45–10:15 AM</strong> for stable OI and breadth data.</div>`;
  } else if (t <= OPTIMAL_END) {
    el.style.display='block';
    el.innerHTML = `<div style="font-size:8.5px;color:var(--gn);padding:6px 14px;border-bottom:1px solid var(--border)">` +
      `✅ <strong>Optimal entry window</strong> — 9:45–10:15 AM. OI settled, breadth reliable. Good time to enter.</div>`;
  } else {
    el.style.display='none';
  }
}

function setDisabled(ids, val){
  ids.forEach(id=>{ const e=document.getElementById(id); if(e){ e.disabled=val; e.style.opacity=val?'0.4':'1'; }});
}

// ── Next trading day helper ────────────────────────────────────
function nextTradingDay() {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const next = new Date(ist);
  next.setDate(next.getDate() + 1);
  while (!isTradingDay(next)) next.setDate(next.getDate() + 1);
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${days[next.getDay()]} ${next.getDate()} ${months[next.getMonth()]}`;
}

function isWeekendOrHoliday() {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  return !isTradingDay(ist);
}

// ── Entry Time Signal — calibrated for 8:45am prep, 10am execution ──
// v1.9.1: weekend-aware — shows next Monday when entered Friday night
function getEntrySignal(idx) {
  if (isWeekendOrHoliday()) {
    const next = nextTradingDay();
    return { label:'📅 WEEKEND', color:'var(--muted)', dot:'var(--muted)',
             note:`Market closed. Data saved for ${next} opening. Enter Radar at 8:45am ${next}.` };
  }

  const { h, m, total: mins } = getIST();
  const OPEN  = 9*60+15;
  const CLOSE = 15*60+30;

  if (mins < OPEN || mins >= CLOSE) {
    return { label:'MARKET CLOSED', color:'var(--muted)', dot:'var(--muted)', note:'Market hours: 09:15–15:30 IST' };
  }
  if (mins < 9*60+30) {
    return { label:'🔴 AVOID', color:'var(--rd)', dot:'var(--rd)', note:'Opening volatility — IV spike 40–80%. Radar entered, execution waits.' };
  }
  if (mins < 10*60) {
    return { label:'⏳ WAIT', color:'var(--am)', dot:'var(--am)', note:'Premium settling — wait until 10:00am for accurate IV and stable spreads.' };
  }
  if (mins < 11*60) {
    return { label:'✅ YOUR WINDOW', color:'var(--gn)', dot:'var(--gn)', note:'10–11am: IV normalised, ATR established, OI reliable. Best time to execute.' };
  }
  if (mins <= 13*60) {
    return { label:'✅ ACCEPTABLE', color:'var(--gn)', dot:'var(--gn)', note:'Premium slightly lower than 10am entry. Still good. Check SL level before entry.' };
  }
  if (mins <= 14*60) {
    return { label:'⚠️ CAUTION', color:'var(--am)', dot:'var(--am)', note:'Lunch drift — low volume, wider spreads. Reduce size if entering now.' };
  }
  if (mins <= 14*60+45) {
    return { label:'⚠️ LATE', color:'var(--am)', dot:'var(--am)', note:'Power hour building. If entering, use tighter SL — intraday move risk high.' };
  }
  return { label:'🔴 AVOID', color:'var(--rd)', dot:'var(--rd)', note:'Closing gamma explosion — exit only, no new IC positions.' };
}

function getBannerPhase() {
  if (isWeekendOrHoliday()) {
    const next = nextTradingDay();
    return { phase:`WEEKEND · Next open: ${next}`, color:'var(--muted)' };
  }
  const { total: mins } = getIST();
  if (mins < 8*60+45)   return { phase:'PRE-MARKET · RADAR ENTRY OPENS 8:45am', color:'var(--muted)' };
  if (mins < 9*60+15)   return { phase:'ENTER RADAR NOW (8:45–9:15)', color:'var(--tl)' };
  if (mins < 9*60+30)   return { phase:'OPENING VOLATILITY — WAIT', color:'var(--rd)' };
  if (mins < 10*60)     return { phase:'SETTLING — WAIT FOR 10am', color:'var(--am)' };
  if (mins < 11*60)     return { phase:'✅ YOUR EXECUTION WINDOW', color:'var(--gn)' };
  if (mins <= 13*60)    return { phase:'ACCEPTABLE ENTRY', color:'var(--gn)' };
  if (mins <= 14*60)    return { phase:'LUNCH DRIFT — REDUCE SIZE', color:'var(--am)' };
  if (mins <= 14*60+45) return { phase:'LATE — USE TIGHTER SL', color:'var(--am)' };
  if (mins <= 15*60+30) return { phase:'CLOSING — EXIT ONLY', color:'var(--rd)' };
  return { phase:'MARKET CLOSED', color:'var(--muted)' };
}

function updateEntrySignal() {
  const { h, m } = getIST();
  const hh = String(h).padStart(2,'0'), mm = String(m).padStart(2,'0');
  const banner = getBannerPhase();
  const nfSig  = getEntrySignal('NF');
  const bnSig  = getEntrySignal('BNF');

  const timeEl  = document.getElementById('entry-time');
  const phaseEl = document.getElementById('entry-phase');
  const dotEl   = document.getElementById('entry-dot');
  const msgEl   = document.getElementById('entry-msg');
  const bannerEl= document.getElementById('entry-banner');

  if (timeEl)  timeEl.textContent = `${hh}:${mm}`;
  if (phaseEl) { phaseEl.textContent = `IST · ${banner.phase}`; phaseEl.style.color = banner.color; }
  if (dotEl)   dotEl.style.background = banner.color;
  if (bannerEl)bannerEl.style.borderColor = banner.color + '66';

  const nfSigEl   = document.getElementById('nf-entry-sig');
  const nfNoteEl  = document.getElementById('nf-entry-note');
  const bnSigEl   = document.getElementById('bn-entry-sig');
  const bnNoteEl  = document.getElementById('bn-entry-note');

  if (nfSigEl)  { nfSigEl.textContent = nfSig.label; nfSigEl.style.color = nfSig.color; }
  if (nfNoteEl) nfNoteEl.textContent = nfSig.note;
  if (bnSigEl)  { bnSigEl.textContent = bnSig.label; bnSigEl.style.color = bnSig.color; }
  if (bnNoteEl) bnNoteEl.textContent = bnSig.note;
}

// ── onInput — called on every field change ─────────────────────
function onInput(id){
  stampField(id);
  calcScore();
  buildStrategy('NF');
  buildStrategy('BN');
}

// ── Scoring engine ─────────────────────────────────────────────
function scoreParam(key, val, extra){
  switch(key){
    case 'gift_gap':
      return val>=0.5?2:val>=0.2?1:val>=-0.2?0:val>=-0.5?-1:-2;
    case 'gift_trend':
      return val>=100?2:val>=30?1:val>=-30?0:val>=-100?-1:-2;
    case 'sp500': case 'dow':
      return val>=1.0?2:val>=0.3?1:val>=-0.3?0:val>=-1.0?-1:-2;
    case 'nk': case 'hsi':
      return val>=1.5?2:val>=0.5?1:val>=-0.5?0:val>=-1.5?-1:-2;
    case 'usvix':
      return val<13?2:val<15?1:val<18?0:val<22?-1:-2;
    case 'crude':
      return val<=-1.0?2:val<=-0.3?1:val<=0.3?0:val<=1.0?-1:-2;
    case 'gold': case 'inr': case 'yld':
      return val<=-0.5?2:val<=0?1:val<=0.5?0:val<=1?-1:-2;
    case 'fii':
      return val>=2000?2:val>=200?1:val>=-200?0:val>=-2000?-1:-2;
    case 'pcr':
      return val>=1.5?2:val>=1.2?1:val>=1.0?0:val>=0.8?-1:-2;
    case 'max_pain': {
      const d=extra-val; return d>=300?2:d>=100?1:Math.abs(d)<100?0:d<=-100?-1:-2;
    }
    case 'close_char':
      return val;
    case 'n50adv':
      return val>=40?2:val>=30?1:val>=20?0:val>=12?-1:-2;
    case 'n50dma':
      return val>=70?2:val>=55?1:val>=40?0:val>=25?-1:-2;
    case 'bnfadv':
      return val>=12?2:val>=8?1:val>=6?0:val>=4?-1:-2;
    default: return 0;
  }
}

function calcScore(){
  const ev = {
    sp500_c:gv('sp500'), dow_c:gv('dow'), usvix_c:gv('usvix'), nk_c:gv('nk'), hsi_c:gv('hsi'),
    crude_c:gv('crude'), gold_c:gv('gold'), inr_c:gv('inr'), yld_c:gv('yld'),
    gift_now:gv('gift_now'), nifty_prev:gv('nifty_prev'), gift_6am:gv('gift_6am'),
    india_vix:gv('india_vix'), fii:gv('fii'),
    // PCR kept for strike placement only — NOT used in score (v1.5.0 backtest finding)
    pcr_nf:gv('pcr_nf'), pcr_bn:gv('pcr_bn'),
    max_pain_nf:gv('max_pain_nf'), n50adv:gv('n50adv'), n50dma:gv('n50dma'), bnfadv:gv('bnfadv'),
    close_char:gvi('close_char')||0,
  };

  function getEvening(key){ try{ const d=JSON.parse(localStorage.getItem('mr140-evening')||'{}'); return d[key]||null; }catch{ return null; } }
  const sp500_p=getEvening('ev_sp500'), dow_p=getEvening('ev_dow'), usvix_p=getEvening('ev_usvix'),
        nk_p=getEvening('ev_nk'), hsi_p=getEvening('ev_hsi'), crude_p=getEvening('ev_crude'),
        gold_p=getEvening('ev_gold'), inr_p=getEvening('ev_inr');

  const contributions = [];
  let sc=0, usedW=0, bull=0, bear=0, neut=0;

  function addParam(key, rawScore, sigLabel, wt){
    if(rawScore===null){ contributions.push({key, s:null, sig:sigLabel, wt, skipped:true}); return; }
    const contrib=rawScore*(wt/2);
    sc+=contrib; usedW+=wt;
    if(rawScore>0) bull++; else if(rawScore<0) bear++; else neut++;
    contributions.push({key, s:rawScore, contrib, sig:sigLabel, wt});
  }

  const gapPct = (valid(ev.gift_now)&&valid(ev.nifty_prev)) ? pct(ev.gift_now,ev.nifty_prev) : null;
  const trendPts= (valid(ev.gift_now)&&valid(ev.gift_6am)) ? ev.gift_now-ev.gift_6am : null;
  addParam('gift_gap',   gapPct!==null?scoreParam('gift_gap',gapPct):null,
           gapPct!==null?`${gapPct>=0?'+':''}${gapPct.toFixed(2)}%`:'—', W.gift_gap);
  addParam('gift_trend', trendPts!==null?scoreParam('gift_trend',trendPts):null,
           trendPts!==null?`${trendPts>=0?'+':''}${trendPts.toFixed(0)}pts`:'—', W.gift_trend);

  const mkts=[
    {key:'sp500',c:ev.sp500_c,p:sp500_p,fn:'sp500'},
    {key:'dow',  c:ev.dow_c,  p:dow_p,  fn:'dow'},
    {key:'nk',   c:ev.nk_c,  p:nk_p,   fn:'nk'},
    {key:'hsi',  c:ev.hsi_c, p:hsi_p,  fn:'hsi'},
    {key:'crude',c:ev.crude_c,p:crude_p,fn:'crude'},
    {key:'gold', c:ev.gold_c, p:gold_p, fn:'gold'},
    {key:'inr',  c:ev.inr_c, p:inr_p,  fn:'inr'},
  ];
  mkts.forEach(({key,c,p,fn})=>{
    if(!valid(c)){ addParam(key,null,'—',W[key]); return; }
    const changePct=valid(p)?pct(c,p):null;
    if(changePct===null){ addParam(key,0,`${c} (no prev)`,W[key]); return; }
    addParam(key,scoreParam(fn,changePct),`${changePct>=0?'+':''}${changePct.toFixed(2)}%`,W[key]);
  });

  if(valid(ev.usvix_c)){ addParam('usvix',scoreParam('usvix',ev.usvix_c),`VIX ${ev.usvix_c}`,W.usvix); }
  else addParam('usvix',null,'—',W.usvix);

  const yld_p=getEvening('ev_yld');
  if(valid(ev.yld_c)){
    const yPct=valid(yld_p)?pct(ev.yld_c,yld_p):null;
    addParam('yld',yPct!==null?scoreParam('yld',yPct):0,
             yPct!==null?`${yPct>=0?'+':''}${yPct.toFixed(2)}%`:`${ev.yld_c}%`,W.yld);
  } else addParam('yld',null,'—',W.yld);

  if(ev.fii!==null) addParam('fii',scoreParam('fii',ev.fii),`₹${ev.fii>=0?'+':''}${Math.round(ev.fii)}Cr`,W.fii);
  else addParam('fii',null,'—',W.fii);

  // v1.5.0: PCR removed from score — 38% directional accuracy in backtest (worse than coin flip).
  // PCR is KEPT for strike adjustment in the strategy engine only.

  const nfSpot=ev.nifty_prev||ev.gift_now;
  if(valid(ev.max_pain_nf)&&valid(nfSpot))
    addParam('max_pain',scoreParam('max_pain',ev.max_pain_nf,nfSpot),`Pain ${ev.max_pain_nf.toLocaleString('en-IN')}`,W.max_pain);
  else addParam('max_pain',null,'—',W.max_pain);

  addParam('close_char',ev.close_char,['Str↓↓','Mild↓','Neutral','Mild↑','Str↑↑'][ev.close_char+2],W.close_char);

  if(valid(ev.n50adv)) addParam('n50adv',scoreParam('n50adv',ev.n50adv),`${ev.n50adv}/50`,W.n50adv);
  else addParam('n50adv',null,'—',W.n50adv);
  if(valid(ev.n50dma))  addParam('n50dma',scoreParam('n50dma',ev.n50dma),`${ev.n50dma}%`,W.n50dma);
  else addParam('n50dma',null,'—',W.n50dma);
  if(valid(ev.bnfadv)) addParam('bnfadv',scoreParam('bnfadv',ev.bnfadv),`${ev.bnfadv}/14`,W.bnfadv);
  else addParam('bnfadv',null,'—',W.bnfadv);

  const totalUsableW = contributions.filter(c=>c.s!==null).reduce((a,c)=>a+c.wt,0);
  const finalScore = totalUsableW > 0 ? sc / totalUsableW : 0;
  SCORE = Math.round(finalScore*1000)/1000;

  const rbi=document.querySelector('input[name="rbi"]:checked')?.value||'neutral';
  const liq=document.querySelector('input[name="liq"]:checked')?.value||'neutral';
  const news=document.querySelector('input[name="news"]:checked')?.value||'none';
  let bnfAdj=0;
  if(rbi==='hawkish') bnfAdj-=0.2; else if(rbi==='dovish') bnfAdj+=0.15;
  if(liq==='deficit') bnfAdj-=0.15; else if(liq==='surplus') bnfAdj+=0.1;
  if(news==='hdfc'||news==='icici') bnfAdj-=0.3; else if(news==='both') bnfAdj-=0.5;

  if(SCORE>=1.2)      { DIRECTION='STRONGLY BULLISH'; }
  else if(SCORE>=0.4) { DIRECTION='MILDLY BULLISH'; }
  else if(SCORE>-0.4) { DIRECTION='NEUTRAL'; }
  else if(SCORE>-1.2) { DIRECTION='MILDLY BEARISH'; }
  else                { DIRECTION='STRONGLY BEARISH'; }

  const vix=ev.india_vix||14;
  if(SCORE>=0.4)      STRAT_AUTO='BULL PUT SPREAD';
  else if(SCORE<=-0.4)STRAT_AUTO='BEAR CALL SPREAD';
  else if(vix<16)     STRAT_AUTO='LONG STRADDLE';
  else                STRAT_AUTO='IRON CONDOR';

  renderVerdict(SCORE, DIRECTION, bull, bear, neut, contributions, totalUsableW, bnfAdj, ev, vix);
  renderBreadth();
  buildCommand();
}

// ── Drift row in Verdict tab — shows overnight shift from bhav ────────────────
function renderDriftRow() {
  const el = document.getElementById('drift-row');
  if (!el) return;
  if (!DRIFT) {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  const d = DRIFT;
  const col = d.score > 0.05 ? 'var(--gn)' : d.score < -0.05 ? 'var(--rd)' : 'var(--muted)';
  const tag = d.score > 0.05
    ? '<span class="tag up">↑</span>'
    : d.score < -0.05
    ? '<span class="tag dn">↓</span>'
    : '<span class="tag fl">→</span>';
  const spotTxt = `${d.spotPts >= 0 ? '+' : ''}${d.spotPts}pts vs ${d.label}`;
  const driftTxt = `${d.score >= 0 ? '+' : ''}${d.score.toFixed(2)} drift adj`;
  el.innerHTML =
    `<div style="padding:7px 14px;border-bottom:1px solid var(--border);border-top:2px solid var(--border);background:var(--bg3)">` +
    `<div style="font-size:8px;font-weight:700;letter-spacing:1px;color:var(--muted);margin-bottom:4px">OVERNIGHT SHIFT (bhav → live)</div>` +
    `<div style="display:flex;align-items:center;gap:8px">` +
    `<div style="flex:1;font-size:9px;color:var(--muted)">${spotTxt}</div>` +
    `<div style="font-size:10px;font-family:var(--font-mono);font-weight:700;color:${col}">${driftTxt}</div>` +
    `<div style="width:8px">${tag}</div>` +
    `</div>` +
    `</div>`;
}

// ── Verdict renderer ───────────────────────────────────────────
function renderVerdict(score, dir, bull, bear, neut, contribs, usedW, bnfAdj, ev, vix){
  const col=score>=0.4?'var(--gn)':score<=-0.4?'var(--rd)':'var(--am)';
  const scoreEl=document.getElementById('v-score');
  scoreEl.textContent=(score>=0?'+':'')+score.toFixed(3);
  scoreEl.style.color=col;
  document.getElementById('v-dir').textContent=dir;
  document.getElementById('v-dir').style.color=col;
  const pct_used=Math.round(usedW*100);
  document.getElementById('v-conf').textContent=`${bull} bull · ${bear} bear · ${neut} neutral · ${pct_used}% data entered`;

  try{
    const prev=JSON.parse(localStorage.getItem('mr140-prevscore')||'null');
    if(prev&&score!==null){
      const delta=score-prev.score;
      let dlbl;
      if(Math.abs(delta)<0.15) dlbl='→ STABLE';
      else if(delta>=0.4) dlbl='↑↑ STRENGTHENING';
      else if(delta>0) dlbl='↑ IMPROVING';
      else if(delta<=-0.4) dlbl='↓↓ WEAKENING';
      else dlbl='↓ SOFTENING';
      if(prev.score*score<0) dlbl='↻ REVERSING';
      document.getElementById('delta-row').style.display='flex';
      document.getElementById('delta-prev').textContent=(prev.score>=0?'+':'')+prev.score.toFixed(3)+' ('+prev.dir+')';
      document.getElementById('delta-val').textContent=(delta>=0?'+':'')+delta.toFixed(3)+' '+dlbl;
      document.getElementById('delta-val').style.color=delta>0?'var(--gn)':delta<0?'var(--rd)':'var(--muted)';
    }
  }catch{}

  renderRecCard(score, dir, ev, vix, bnfAdj);

  const container=document.getElementById('param-rows');
  container.innerHTML='';
  contribs.forEach(c=>{
    const row=document.createElement('div');
    row.className='vrow';
    const NAMES={gift_gap:'GIFT Gap',gift_trend:'GIFT Trend',sp500:'S&P 500',dow:'DOW',
      usvix:'US VIX',nk:'Nikkei',hsi:'Hang Seng',crude:'Brent Crude',gold:'Gold',
      inr:'USD/INR',yld:'10Y Yield',fii:'FII Flow',close_char:'Prev Close',
      max_pain:'Max Pain NF',n50adv:'Nifty A/D',n50dma:'200-DMA',bnfadv:'BNF A/D'};
    const s=c.s;
    const tag=c.skipped?'<span class="tag fl">SKIP</span>':
      s>0?'<span class="tag up">↑</span>':s<0?'<span class="tag dn">↓</span>':'<span class="tag fl">—</span>';
    const wPct=Math.round(c.wt*100);
    row.innerHTML=`<div class="vrow-name">${NAMES[c.key]||c.key} <span style="color:var(--dim)">${wPct}%</span></div>
      <div class="vrow-sig">${c.sig}</div>
      <div style="width:8px">${tag}</div>`;
    container.appendChild(row);
  });
}

function renderRecCard(score, dir, ev, vix, bnfAdj){
  const el=document.getElementById('rec-card');
  const n50adv=ev.n50adv||25; const bnfadv=ev.bnfadv||7;
  const nfBreadth=n50adv/50*100; const bnfBreadth=bnfadv/14*100;
  const fii=ev.fii||0;
  const bnfScore=bnfBreadth+bnfAdj*100-(fii<0?5:0);
  const nfScore=nfBreadth;
  const idx=bnfScore>nfScore?'BANK NIFTY':'NIFTY 50';
  const idxCol=idx==='BANK NIFTY'?'var(--tl)':'var(--gn)';
  const strategy=STRAT_AUTO;
  const news=document.querySelector('input[name="news"]:checked')?.value||'none';
  const warning=news==='both'?'⚠️ Both HDFC+ICICI event — consider SKIP on BNF':
                news!=='none'?`⚠️ ${news.toUpperCase()} event today — BNF volatile`:'';
  const reasons=[];
  if(bnfScore>nfScore) reasons.push(`BNF breadth ${bnfadv}/14 (${bnfBreadth.toFixed(0)}%) > NF ${n50adv}/50 (${nfBreadth.toFixed(0)}%)`);
  else reasons.push(`NF breadth ${n50adv}/50 (${nfBreadth.toFixed(0)}%) selected`);
  if(fii<0) reasons.push(`FII selling ₹${Math.abs(fii)}Cr — cautious`);
  // v1.5.0: PCR shown as strike guide only — not a direction signal
  const pcrNF=ev.pcr_nf, pcrBN=ev.pcr_bn;
  if(pcrNF||pcrBN) reasons.push(`PCR (strike guide only) — NF: ${pcrNF?pcrNF.toFixed(2):'—'} · BNF: ${pcrBN?pcrBN.toFixed(2):'—'}`);
  reasons.push(`Strategy: ${strategy} (score ${score>=0?'+':''}${score.toFixed(2)}, VIX ${vix})`);
  el.style.background='var(--bg2)';
  el.style.border=`1px solid ${idxCol}33`;
  el.innerHTML=`
    <div class="rec-badge" style="color:${idxCol}">TRADE TODAY</div>
    <div class="rec-index" style="color:${idxCol}">${idx}</div>
    <div class="rec-strat">${strategy}</div>
    ${warning?`<div style="font-size:9px;color:var(--am);margin-bottom:6px">${warning}</div>`:''}
    <div class="rec-reasons">${reasons.join('<br>')}</div>`;
}

// ── Breadth renderer ───────────────────────────────────────────
function renderBreadth(){
  const n50=gv('n50adv'), dma=gv('n50dma'), bnf=gv('bnfadv');
  if(valid(n50)){
    const p=n50/50*100;
    document.getElementById('nf-adv-bar').style.width=p+'%';
    document.getElementById('nf-adv-bar').style.background=p>=60?'var(--gn)':p>=40?'var(--am)':'var(--rd)';
    document.getElementById('nf-adv-num').textContent=Math.round(n50);
    document.getElementById('nf-dec-num').textContent=Math.round(50-n50);
    const lbl=n50>=40?'VERY BROAD':n50>=30?'BROAD':n50>=20?'MIXED':n50>=12?'NARROW':'HOLLOW';
    const col=n50>=30?'var(--gn)':n50>=20?'var(--am)':'var(--rd)';
    document.getElementById('nf-adv-tag').textContent=lbl;
    document.getElementById('nf-adv-tag').style.color=col;
  }
  if(valid(dma)) document.getElementById('nf-dma-pct').textContent=Math.round(dma);
  if(valid(bnf)){
    const p=bnf/14*100;
    document.getElementById('bnf-adv-bar').style.width=p+'%';
    document.getElementById('bnf-adv-bar').style.background=p>=60?'var(--gn)':p>=40?'var(--am)':'var(--rd)';
    document.getElementById('bnf-adv-num').textContent=Math.round(bnf);
    document.getElementById('bnf-dec-num').textContent=Math.round(14-bnf);
    const lbl=bnf>=12?'VERY BROAD':bnf>=8?'BROAD':bnf>=6?'SPLIT':bnf>=4?'NARROW':'HOLLOW';
    const col=bnf>=8?'var(--gn)':bnf>=6?'var(--am)':'var(--rd)';
    document.getElementById('bnf-adv-tag').textContent=lbl;
    document.getElementById('bnf-adv-tag').style.color=col;
  }
  const n50s=valid(n50)?n50>=30?2:n50>=20?1:n50>=12?0:-1:-99;
  const bnfs=valid(bnf)?bnf>=8?2:bnf>=6?1:bnf>=4?0:-1:-99;
  const avg=(n50s!==-99&&bnfs!==-99)?(n50s+bnfs)/2:n50s!==-99?n50s:bnfs;
  let msg='',col='var(--muted)';
  if(avg>=-99){
    if(avg>=1.5){msg='✅ FULL SIZE — broad breadth, max confidence';col='var(--gn)';}
    else if(avg>=0.5){msg='✅ FULL SIZE — healthy breadth';col='var(--gn)';}
    else if(avg>=-0.5){msg='⚠️ 50% SIZE — narrow breadth, reduce exposure';col='var(--am)';}
    else{msg='🚨 25% MAX — hollow rally, consider SKIP';col='var(--rd)';}
  }
  const pb=document.getElementById('pos-size-box');
  if(pb){pb.textContent=msg||'Enter breadth data above';pb.style.color=col;}
}

// ═══════════════════════════════════════════════════════════════
// v1.5.0 STRATEGY ENGINE
// Backtest-validated multipliers · VIX guard · ATR lag detector
// Dual PCR strike adjustment · NSE Holiday calendar
// ═══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// v1.9.1 CAPITAL MODULE — ₹1,10,000 (confirmed via Upstox live data)
// Real SPAN margins sourced from Upstox, 27 Feb 2026
// ══════════════════════════════════════════════════════════════
const CAPITAL          = 110000;  // ₹1,10,000
const NF_LOT_SIZE      = 65;      // NSE lot size (confirmed)
const BNF_LOT          = 30;      // BNF lot size (confirmed)
const NF_MARGIN_PER_LOT= 97000;   // Real SPAN for full NF IC, 1 lot (Upstox: ₹97,243)
const BNF_MARGIN_PER_LOT= 28000;  // BNF spread approx margin
const MAX_RISK_PCT     = 0.05;

// Calculates lot count and risk metrics
// IC is defined-risk — safe lots = floor(capital / margin), not 45% rule
function capitalMetrics(midPerUnit, widthPts, lotSize, marginPerLot) {
  const safeLots      = Math.max(1, Math.floor(CAPITAL / marginPerLot));
  const marginUsed    = safeLots * marginPerLot;
  const buffer        = CAPITAL - marginUsed;
  const credit        = midPerUnit * lotSize * safeLots;
  const maxLoss       = (widthPts - midPerUnit) * lotSize * safeLots;  // defined risk
  const slAmount      = maxLoss * 0.80;
  const slPct         = slAmount / CAPITAL * 100;
  const canAbsorbLoss = buffer >= maxLoss;
  const riskFlag      = !canAbsorbLoss;
  return { safeLots, marginUsed, buffer, credit, maxLoss, slAmount, slPct,
           riskFlag, canAbsorbLoss, bufferLeft: buffer };
}


// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════

// ── (bhav.js loaded separately) ──────────────────────────────



// Source: 274 real NSE IC observations Nov 2025–Feb 2026
// Backtest error ≤ ±7% across all DTE buckets
// ══════════════════════════════════════════════════════════════

// ── NF PUT DTE multipliers — back-calculated from n=274 real trades ──
// Formula: credit = WIDTH × 0.38 × mult × vixMult × distFactor
// K = 200 × 0.38 × 0.78 = 59.28 (at VIX 13.5)
// mult = real_median_put / K
// ── NF PUT DTE multipliers — recalibrated v2.4.0 ──────────────
// Calibrated on 32 IC-viable days (Jan–Mar 2026) using NSE EWMA ATR strikes
// NSE EWMA ATR ≈ 280 pts → CE sell ≈ +370 pts from spot (vs +505 pts old)
// Fallback (no FOVOLT): old stddev ATR → old multipliers still in use via bhavATR()
function getDteMult(dte) {
  if (dte <= 2)  return 0.14;   // extrapolated — DTE<3 rare for weekly entry
  if (dte <= 4)  return 0.176;  // calibrated n=9 (DTE 3+4 cluster)
  if (dte <= 5)  return 0.256;  // calibrated n=6
  if (dte <= 7)  return 0.332;  // calibrated n=12 (DTE 6+7)
  if (dte <= 10) return 0.480;  // calibrated n=5 (DTE 8, scaled for 9-10)
  if (dte <= 14) return 0.560;  // extrapolated
  if (dte <= 21) return 0.680;  // extrapolated
  if (dte <= 35) return 0.820;
  if (dte <= 45) return 1.000;
  return 1.200;
}

// ── NF CALL DTE multipliers — recalibrated v2.4.0 ─────────────
// Calls slightly more expensive than puts at NSE ATR strikes (reduced skew vs old)
function getDteMultCall(dte) {
  if (dte <= 2)  return 0.18;   // extrapolated
  if (dte <= 4)  return 0.231;  // calibrated n=9
  if (dte <= 5)  return 0.306;  // calibrated n=6
  if (dte <= 7)  return 0.403;  // calibrated n=12
  if (dte <= 10) return 0.580;  // calibrated n=5 (scaled for 9-10)
  if (dte <= 14) return 0.680;  // extrapolated
  if (dte <= 21) return 0.820;  // extrapolated
  if (dte <= 35) return 1.000;
  if (dte <= 45) return 1.250;
  return 1.500;
}

// v1.6.3: BNF separate DTE multipliers — reverse-engineered from 3-month real premiums.
// BNF ATR% is 0.58–0.92% of spot (vs NF 0.33–0.55%), yielding richer premiums per ATR unit.
// NF-calibrated multipliers systematically underestimate BNF at DTE 15+.
// Source: 134 BNF records against real NSE bhavcopy Nov 2025–Feb 2026.
// v1.6.3: Short DTE recalibrated — DTE≤5: 0.85→0.52 (was +60% over), DTE 6-7: 0.95→0.71 (was +33%), DTE 8-14: 1.46→1.14 (was +28%)
// DTE 15-21+ unchanged (within ±7%). DTE 22+ handled by strike placement (2.8×ATR)
function getDteMultBNF(dte) {
  if (dte <= 5)  return 0.52;   // v1.6.3: was 0.85 → recalibrated (backtest +60% over)
  if (dte <= 7)  return 0.71;   // v1.6.3: was 0.95 → recalibrated (backtest +33% over)
  if (dte <= 14) return 1.14;   // v1.6.3: was 1.46 → recalibrated (backtest +28% over)
  if (dte <= 21) return 2.00;   // ✅ unchanged — backtest +7%
  if (dte <= 30) return 3.28;   // ✅ unchanged
  if (dte <= 45) return 4.00;
  if (dte <= 65) return 4.15;
  return 5.00;
}

// v1.6.3: Short DTE recalibrated — DTE≤5: 0.80→0.50 (was +50% over), DTE 6-7: 0.95→0.71 (was +26%), DTE 8-14: 1.94→1.47 (was +25%)
// DTE 15-21+ unchanged (within ±14%)
function getDteMultBNFCall(dte) {
  if (dte <= 5)  return 0.50;   // v1.6.3: was 0.80 → recalibrated (backtest +50% over)
  if (dte <= 7)  return 0.71;   // v1.6.3: was 0.95 → recalibrated (backtest +26% over)
  if (dte <= 14) return 1.47;   // v1.6.3: was 1.94 → recalibrated (backtest +25% over)
  if (dte <= 21) return 3.44;   // ✅ unchanged — backtest −14%
  if (dte <= 30) return 5.09;   // ✅ unchanged
  if (dte <= 45) return 6.00;
  if (dte <= 65) return 7.56;
  return 8.50;
}

function getVixMult(vix) {
  if (vix < 12) return 0.55;
  if (vix < 14) return 0.78;
  if (vix < 16) return 1.00;
  if (vix < 18) return 1.22;
  if (vix < 22) return 1.55;  // high-VIX zone — premiums richly priced
  if (vix < 26) return 1.85;  // panic zone
  return 2.20;                 // extreme panic
}

// FIX 1: Cap credit at 68% of width — prevents negative R:R
// v1.6.0: separate put/call base credits using their respective DTE multipliers
// v1.7.0: BNF uses its own multiplier set (getDteMultBNF/getDteMultBNFCall)
//         calibrated from 3-month NSE bhavcopy (134 BNF records)
// v2.3.0: NF_PUT_SKEW — puts trade richer than calls in bear/uncertain markets
//         Calibrated from 65 days Dec 2025–Mar 2026 (actual PE/CE ratio 1.61×)
//         Conservative 1.35× — revisit after 3 months bull-market data
const NF_PUT_SKEW = 1.35;
function estimateCredit(width, dte, vix, isNF) {
  const vm   = getVixMult(vix);
  const putM = isNF ? getDteMult(dte)     : getDteMultBNF(dte);
  const calM = isNF ? getDteMultCall(dte) : getDteMultBNFCall(dte);
  const rawP = r5(width * 0.38 * putM * vm * (isNF ? NF_PUT_SKEW : 1.0));
  const rawC = r5(width * 0.38 * calM * vm);
  const maxAllowed = r5(width * 0.68);
  const midP = Math.min(rawP, maxAllowed);
  const midC = Math.min(rawC, maxAllowed);
  return {
    mid: midP, midCall: midC,
    min: r5(midP * 0.80), max: r5(midP * 1.22),
    capped: rawP > maxAllowed || rawC > maxAllowed
  };
}

function distFactor(distAtr) {
  if (distAtr <= 1.0) return 1.15;
  if (distAtr <= 1.5) return 1.00;
  if (distAtr <= 2.0) return 0.82;
  return 0.65;
}

// v1.5.0: call side uses relaxed dist penalty at 1.4-2.0×ATR
// v1.6.0: made DTE-aware — DTE≤7 uses tighter factor because near-expiry call decays faster
// v1.7.0: DTE≤7 factor tightened 0.72→0.62 (backtest: DTE 6-7 CALL still +13.9% over)
function distFactorCall(distAtr, dte) {
  if (distAtr <= 1.0) return 1.15;
  if (distAtr <= 1.5) return 1.00;
  if (distAtr <= 2.0) return (dte <= 7) ? 0.62 : 0.90;  // v1.7.0: was 0.72 at DTE≤7
  return 0.65;
}

// FIX 2: PCR adjustment scoped to DTE ≤ 30 only
function pcrPutAdj(pcr, dte) {
  if (!pcr || dte > 30) return 0.0;   // far expiry — no PCR adjustment
  if (pcr >= 1.5) return -0.15;
  if (pcr >= 1.2) return -0.10;
  if (pcr >= 1.0) return  0.00;
  if (pcr >= 0.8) return +0.10;
  return +0.20;
}

function pcrCallAdj(pcr, dte) {
  if (!pcr || dte > 30) return 0.0;
  if (pcr >= 1.5) return +0.10;
  if (pcr >= 1.2) return +0.05;
  if (pcr >= 1.0) return  0.00;
  if (pcr >= 0.8) return -0.10;
  return -0.20;
}

function pcrPremAdj(pcr, dte) {
  if (!pcr || dte > 30) return 1.0;   // no premium adjustment for far expiry
  if (pcr >= 1.5) return 1.12;
  if (pcr >= 1.2) return 1.06;
  if (pcr >= 1.0) return 1.00;
  if (pcr >= 0.8) return 0.94;
  return 0.88;
}

// FIX 3: Win probability scales with actual ATR distance
function winProb(dte, distAtr) {
  const dm = dte<=3?1.05 : dte<=7?1.0 : dte<=14?0.95 : dte<=21?0.92 : 0.88;
  const fm = distAtr>=2.5?1.15 : distAtr>=2.0?1.10 : distAtr>=1.5?1.02 : distAtr>=1.0?0.88 : 0.72;
  return Math.min(92, Math.max(48, Math.round(72 * dm * fm)));
}

function starRating(rr, wp) {
  if (rr <= 1.5 && wp >= 72) return 5;
  if (rr <= 2.0 && wp >= 65) return 4;
  if (rr <= 3.0)              return 3;
  if (rr <= 4.0)              return 2;
  return 1;
}

function estimateStraddle(price, dte, vix){
  const vm=vix<12?0.6:vix<14?0.8:vix<16?1.0:vix<18?1.3:1.6;
  const unit=r5(price*(vix/100)*Math.sqrt(dte/365)*0.4*2);
  return {unit, min:r5(unit*0.82), max:r5(unit*1.18)};
}

// ── Expiry calendar with NSE holiday fallback ──────────────────
// BUG FIX (v2.0.2): NSE NIFTY weekly expiry is Tuesday, but monthly
// expiry (last contract of month) sometimes falls on Monday when the
// last Tuesday of the month is a holiday and rolls back to Monday.
// Confirmed from bhav: 2026-03-02 (Mon) and 2026-03-30 (Mon) are real expiries.
// Fix: accept Monday OR Tuesday as valid NF expiry days.
function getExpiries(idx){
  const isNF = idx==='NF';
  const today = new Date();
  today.setHours(0,0,0,0);
  const expiries = [];
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function fmt(d){ return String(d.getDate()).padStart(2,'0')+' '+months[d.getMonth()]; }

  if(isNF){
    // NF: weekly — Tuesday normally, Monday when Tuesday is holiday
    // Accept day===1 (Monday) OR day===2 (Tuesday)
    const d = new Date(today);
    d.setDate(d.getDate()+1);
    while(expiries.length < 3){
      if(d.getDay()===1 || d.getDay()===2){
        const { d: actD, shifted } = actualExpiry(new Date(d));
        if(actD > today){
          const dte = Math.round((actD-today)/86400000);
          expiries.push({ label:fmt(actD), dte, type:'Weekly', shifted, d:new Date(actD) });
        }
      }
      d.setDate(d.getDate()+1);
      if(d - today > 90*86400000) break; // safety — max 90 days ahead
    }
  } else {
    // BNF: last Tuesday of each month — MAX 2 monthlies only
    let year=today.getFullYear(), month=today.getMonth();
    let found=0;
    while(found<2){
      const last = new Date(year, month+1, 0);
      while(last.getDay()!==2) last.setDate(last.getDate()-1);
      const { d: actD, shifted } = actualExpiry(new Date(last));
      if(actD > today){
        const dte = Math.round((actD-today)/86400000);
        expiries.push({ label:fmt(actD), dte, type:'Monthly', shifted, d:new Date(actD) });
        found++;
      }
      month++;
      if(month>11){month=0; year++;}
      if(year>2027) break; // safety
    }
  }
  return expiries;
}

// ── DTE conviction label ───────────────────────────────────────
function dteConviction(dte){
  if(dte<=5)  return {label:'🚫 Expiry Week', note:'Premiums ₹5–₹30 — too low for meaningful credit. EXIT existing positions only. No new entries.', cls:'near'};
  if(dte<=7)  return {label:'⚡ Near-term', note:'Max theta decay. Enter only if direction is very clear. Plan exit by day 2.', cls:'near'};
  if(dte<=21) return {label:'⭐ Optimal',   note:'Best balance of credit and time buffer. Recommended entry window.', cls:'opt'};
  if(dte<=45) return {label:'📅 Mid-term',  note:'Rich premium. Good for Iron Condor. More time to manage.', cls:'mid'};
  return      {label:'🗓️ Far-term',         note:'Strikes placed 4×ATR from spot. Very rich premium. Wide buffer. Ideal for monthly IC. Low daily theta — plan exit at 25–30 DTE.', cls:'far'};
}

// v1.5.0: Best strike with VIX guard — when VIX > 15 force ≥2.0× ATR buffer
// v1.7.0: Separate call baseMult — calls at DTE 22-45 use 1.60 (was 1.30).
// Backtest: call strikes at 1.2×ATR placed too close to spot → premium ₹280-400
// vs ₹135 cap. Moving to 1.6×ATR yields premium ₹130-190 — within model range.
function bestStrike(price, atr, dte, vix, isBearSide, oiWall, pcr, isNF){
  const round = isNF ? r50 : r100;  // NF→nearest 50, BNF→nearest 100 (NSE strike grid)
  // Put base multipliers (unchanged)
  // v1.6.3: DTE 22-35→2.8×ATR, DTE 36+→4.0×ATR so real premium at those distances ≈ cap
  // At 2.8×ATR: distFactor=0.65 → estimate ~₹110-130 (vs real ₹130-180 ✅)
  // NF strikes snap to nearest 50 (r50), BNF to nearest 100 (r100)
  const putBase  = dte<=7?2.0 : dte<=21?1.5 : dte<=35?2.8 : 4.0;
  const callBase = dte<=7?2.0 : dte<=21?1.5 : dte<=35?2.8 : 4.0;
  const baseMult = isBearSide ? callBase : putBase;
  const pcrAdj   = isBearSide ? pcrCallAdj(pcr, dte) : pcrPutAdj(pcr, dte);
  let mult       = baseMult + pcrAdj;

  // VIX guard: if India VIX > 15, force minimum 2.0× ATR — overrides PCR and OI
  if (vix > 15 && mult < 2.0) mult = 2.0;

  const stdStrike = round(isBearSide ? price+atr*mult : price-atr*mult);

  if(!oiWall) return {strike:stdStrike, reason:`${mult.toFixed(2)}×ATR${vix>15?' (VIX guard)':dte>30?' (std, no PCR adj)':' (PCR adj)'}`, isOI:false, mult};

  const oiDist = Math.abs(oiWall-price)/atr;
  if(isBearSide){
    if(oiWall>stdStrike && oiDist>=1.0)
      return {strike:round(oiWall), reason:`OI call wall at ${round(oiWall).toLocaleString('en-IN')} (${oiDist.toFixed(1)}×ATR)`, isOI:true, mult:oiDist};
    return {strike:stdStrike, reason:`ATR ${mult.toFixed(2)}× safer than OI wall${vix>15?' · VIX guard active':''}`, isOI:false, mult};
  } else {
    if(oiWall<stdStrike && oiDist>=1.0)
      return {strike:round(oiWall), reason:`OI put wall at ${round(oiWall).toLocaleString('en-IN')} (${oiDist.toFixed(1)}×ATR)`, isOI:true, mult:oiDist};
    return {strike:stdStrike, reason:`ATR ${mult.toFixed(2)}× buffer${vix>15?' · VIX guard active':''}`, isOI:false, mult};
  }
}

// ══════════════════════════════════════════════════════════════
// v1.8.0 COMMAND ENGINE — ONE SCREEN, ONE DECISION
// ══════════════════════════════════════════════════════════════

// Strike narration based on distance from spot
function strikeNarration(distAtr) {
  if (distAtr < 0.5)  return { label:'ATM',             color:'var(--rd)' };
  if (distAtr < 0.9)  return { label:'Near ATM',        color:'var(--am)' };
  if (distAtr < 1.3)  return { label:'Slightly OTM',    color:'var(--am)' };
  if (distAtr < 1.8)  return { label:'Moderately OTM',  color:'var(--gn)' };
  if (distAtr < 2.5)  return { label:'Far OTM',         color:'var(--tl)' };
  return                     { label:'Deep OTM',        color:'var(--tl)' };
}

// ── v2.1.0: Moneyness label for any strike ─────────────────────
// Returns { label, color } based on distance from spot
// isCall=true: OTM when strike > spot | isCall=false: OTM when strike < spot
function moneyness(strike, spot, isCall) {
  const d = isCall ? (strike - spot) : (spot - strike);
  if (Math.abs(d) <= 75)  return { label:'ATM',      color:'var(--am)' };
  if (d < 0)               return { label:'ITM',      color:'var(--rd)' };
  if (d <= 200)            return { label:'OTM',      color:'var(--muted)' };
  if (d <= 400)            return { label:'Far OTM',  color:'var(--gn)' };
  return                          { label:'Deep OTM', color:'var(--tl)' };
}

// ── v2.1.0: Direction category from score ─────────────────────
function directionCategory(score) {
  const s = score || 0;
  if (s >  0.60) return 'STRONG_BULL';
  if (s >  0.25) return 'MILD_BULL';
  if (s > -0.25) return 'NEUTRAL';
  if (s > -0.60) return 'MILD_BEAR';
  return 'STRONG_BEAR';
}

// ── v2.1.0: Credit vs Debit selector ──────────────────────────
// VIX vote (weight 2) + PCR vote (weight 1). Tie → credit wins.
// isBull=true for bullish direction, false for bearish.
function preferCreditStrategy(vix, pcr, isBull) {
  let cv = 0, dv = 0;
  // VIX: high VIX = premiums swollen = sell (credit)
  if (vix >= 14) cv += 2; else dv += 2;
  // PCR: for bull, high PCR means put premiums elevated → sell puts (credit)
  //      for bear, low PCR means call premiums elevated → sell calls (credit)
  const p = pcr || 1.0;
  if (isBull)  { if (p >= 1.2) cv += 1; else if (p <= 0.9)  dv += 1; }
  else         { if (p <= 0.85) cv += 1; else if (p >= 1.3) dv += 1; }
  return cv >= dv; // tie → credit
}

// ── v2.1.0: Net debit estimator for Bull Call / Bear Put Spread ─
// Calibrated for 200pt NF spread. DTE and VIX aware.
// Returns per-unit figures (multiply by lot × lots for total).
function estimateDebitSpread(width, dte, vix) {
  const dtF = dte <= 5  ? 0.15
            : dte <= 7  ? 0.22
            : dte <= 14 ? 0.36
            : dte <= 21 ? 0.44
            : 0.50;
  const vxF = vix < 12 ? 0.72 : vix < 14 ? 0.86 : vix < 16 ? 1.00 : 1.18;
  const raw = r5(width * dtF * vxF);
  const nd  = Math.min(raw, r5(width * 0.68)); // cap at 68% of width
  const mp  = width - nd;
  return {
    netDebit: nd,
    ndMin: r5(nd * 0.80), ndMax: r5(nd * 1.25),
    maxProfit: mp,
    mpMin: r5(mp * 0.80), mpMax: r5(mp * 1.10)
  };
}

// BNF viability: 3-state
function bnfViability(score, vix, bnfAtr, bnfSpot, bnfPcr) {
  const absScore = Math.abs(score||0);
  const atrPct = bnfSpot > 0 ? (bnfAtr / bnfSpot * 100) : 0;
  const pcr = bnfPcr || 1.0;
  const reasons = [];

  // AVOID conditions
  if (absScore >= 0.5) {
    reasons.push(`Market directional (score ${score>=0?'+':''}${(score||0).toFixed(2)}) — IC likely to fail one leg`);
    return { state:'avoid', icon:'🔴', label:'AVOID BNF — Stay with Nifty 50', reasons, cls:'avoid' };
  }
  if (vix >= 16) {
    reasons.push(`VIX ${vix} ≥ 16 — elevated volatility makes BNF IC risky`);
    return { state:'avoid', icon:'🔴', label:'AVOID BNF — VIX Too High', reasons, cls:'avoid' };
  }
  if (atrPct > 1.2 && bnfSpot > 0) {
    reasons.push(`BNF ATR ${bnfAtr} = ${atrPct.toFixed(2)}% of spot — unusually volatile`);
    return { state:'avoid', icon:'🔴', label:'AVOID BNF — ATR Spike', reasons, cls:'avoid' };
  }

  // CAUTION conditions
  if (absScore >= 0.25) {
    reasons.push(`Mild directional bias (${score>=0?'+':''}${(score||0).toFixed(2)}) — reduce to 50% size`);
    return { state:'caution', icon:'🟡', label:'CAUTION — Reduce BNF Size (50%)', reasons, cls:'caution' };
  }
  if (vix >= 14) {
    reasons.push(`VIX ${vix} in caution zone (14–15.9) — watch for expansion`);
    return { state:'caution', icon:'🟡', label:'CAUTION — Monitor VIX Closely', reasons, cls:'caution' };
  }
  if (pcr < 0.85 || pcr > 1.5) {
    reasons.push(`BNF PCR ${pcr.toFixed(2)} outside neutral zone (0.85–1.5)`);
    return { state:'caution', icon:'🟡', label:'CAUTION — PCR Imbalance', reasons, cls:'caution' };
  }

  // GO
  reasons.push(`Score ${score>=0?'+':''}${(score||0).toFixed(2)} (neutral), VIX ${vix}, ATR ${atrPct.toFixed(2)}% — range-bound conditions`);
  return { state:'go', icon:'🟢', label:'RANGE-BOUND — BNF IC Viable', reasons, cls:'go' };
}

// Select optimal expiry — prefer 15-21 DTE sweet spot
function pickBestExpiry(expiries) {
  // First try sweet spot 11-21 DTE
  let best = expiries.find(e => e.dte >= 11 && e.dte <= 21);
  if (best) return best;
  // Then 22-35 DTE
  best = expiries.find(e => e.dte >= 6 && e.dte <= 35);
  if (best) return best;
  // Fallback to first available
  return expiries[0] || null;
}

// Main command builder — v2.1.0: 7-strategy engine
function buildCommand() {
  const out = document.getElementById('cmd-output');
  if (!out) return;

  const price  = gv('nf_price');
  const atr    = gv('nf_atr');
  // v2.2.0: strat_vix (Panel 3 live field) takes priority over Radar india_vix
  // This fixes the bug where buildCommand() silently used stale locked Radar VIX
  const vix    = gv('strat_vix') || gv('india_vix') || 14;
  const score  = SCORE || 0;
  const pcr    = gv('pcr_nf');
  const oiCall = gv('nf_oi_call');
  const oiPut  = gv('nf_oi_put');
  const maxPain = gv('nf_maxpain');
  const eventFlag = document.getElementById('event_flag')?.value || 'none';
  const hasEvent  = eventFlag !== 'none';

  // BNF inputs
  const bnfPrice = gv('bn_price');
  const bnfAtr   = gv('bn_atr');
  const bnfPcr   = gv('pcr_bn');

  const f  = n => Math.round(n).toLocaleString('en-IN');
  const fv = n => '₹' + f(n);

  if (!price || !atr) {
    out.innerHTML = `
      <div style="margin:20px 14px;text-align:center;color:var(--muted)">
        <div style="font-size:32px;margin-bottom:12px">📥</div>
        <div style="font-size:12px;font-weight:700">Enter Nifty 50 inputs below</div>
        <div style="font-size:9px;margin-top:4px">Spot Price · ATR · PCR — your recommendation appears instantly</div>
      </div>`;
    return;
  }

  // ── Overnight drift from bhav vs live values ──────────────
  DRIFT = (typeof bhavDriftScore === 'function')
    ? bhavDriftScore(price, oiCall, oiPut)
    : null;
  const effectiveScore = DRIFT
    ? Math.max(-2, Math.min(2, score + DRIFT.score))
    : score;

  // Refresh drift row in Verdict tab if visible
  renderDriftRow();

  // ── Expiry ─────────────────────────────────────────────────
  const expiries = getExpiries('NF');
  const bestExp  = pickBestExpiry(expiries);

  // ── Direction & strategy selection ─────────────────────────
  const dirCat  = directionCategory(effectiveScore);
  const isBull  = dirCat === 'STRONG_BULL' || dirCat === 'MILD_BULL';
  const isBear  = dirCat === 'STRONG_BEAR' || dirCat === 'MILD_BEAR';
  const isNeut  = dirCat === 'NEUTRAL';
  const useCredit = (dirCat === 'MILD_BULL' || dirCat === 'MILD_BEAR')
                  ? preferCreditStrategy(vix, pcr, isBull)
                  : true;

  // ── GO/NO-GO & primary strategy selection ──────────────────
  let goState, goIcon, goLabel, goReason, primaryStrat, altStrat;

  if (!bestExp) {
    goState='avoid'; goIcon='⚠️'; goLabel='NO VALID EXPIRY';
    goReason='Could not find a suitable expiry. Check dates.';
    primaryStrat='AVOID';
  } else if (bestExp.dte <= 5) {
    goState='avoid'; goIcon='🚫'; goLabel='EXPIRY WEEK — DO NOT OPEN';
    goReason=`${bestExp.dte} DTE is too close. Real premiums ₹5–₹30 — not worth the risk. CLOSE existing positions only.`;
    primaryStrat='AVOID';
  } else if (vix >= 28) {
    goState='avoid'; goIcon='🔴'; goLabel='AVOID — EXTREME VOLATILITY';
    goReason=`India VIX ${vix} ≥ 28 — systemic panic. No strategy has edge. Stay fully out.`;
    primaryStrat='AVOID';
  } else if (vix >= 20) {
    // High-VIX directional credit zone — OI-wall anchored spreads only
    const richness = Math.round((vix/14 - 1) * 100);
    if (score > 0.05) {
      goState='caution'; goIcon='🟠'; goLabel=`HIGH VIX BULL — BULL PUT SPREAD`;
      goReason=`VIX ${vix} — puts ${richness}% above normal. Sell inflated put premium anchored at OI wall (${oiPut ? f(oiPut) : 'key support'}). 1 lot, defined risk.`;
      primaryStrat='HVIX_BULL_PUT'; altStrat=null;
    } else if (score < -0.05) {
      goState='caution'; goIcon='🟠'; goLabel=`HIGH VIX BEAR — BEAR CALL SPREAD`;
      goReason=`VIX ${vix} — calls ${richness}% above normal. Sell inflated call premium anchored at OI wall (${oiCall ? f(oiCall) : 'key resistance'}). 1 lot, defined risk.`;
      primaryStrat='HVIX_BEAR_CALL'; altStrat=null;
    } else {
      goState='avoid'; goIcon='🚫'; goLabel='HIGH VIX + NEUTRAL — SIT OUT';
      goReason=`VIX ${vix} with no directional edge (score ${score>=0?'+':''}${score.toFixed(2)}). IC win rate collapses above VIX 20. Wait for clearer direction or VIX < 20.`;
      primaryStrat='AVOID';
    }
  } else {
    // Route by direction
    if (dirCat === 'STRONG_BULL') {
      goState='go'; goIcon='📈'; goLabel='STRONG BULL — BULL CALL SPREAD';
      goReason=`Score +${score.toFixed(2)} — strong upside bias. Buy ATM CE, sell OTM CE. Defined risk, participates in the move.`;
      primaryStrat='BULL_CALL'; altStrat='BULL_PUT';
    } else if (dirCat === 'MILD_BULL') {
      goState = vix >= 15 ? 'caution' : 'go';
      goIcon  = goState==='go' ? '🟢' : '🟡';
      if (useCredit) {
        primaryStrat='BULL_PUT'; altStrat='BULL_CALL';
        goLabel = `${goState==='caution'?'⚠️ CAUTION':'MILD BULL'} — BULL PUT SPREAD`;
        goReason= `Score +${score.toFixed(2)}, VIX ${vix}${vix>=14?' (elevated — premiums rich, selling preferred)':''}.`;
      } else {
        primaryStrat='BULL_CALL'; altStrat='BULL_PUT';
        goLabel = `${goState==='caution'?'⚠️ CAUTION':'MILD BULL'} — BULL CALL SPREAD`;
        goReason= `Score +${score.toFixed(2)}, VIX ${vix} < 14 — premiums compressed. Debit spread better value today.`;
      }
    } else if (dirCat === 'NEUTRAL') {
      if (hasEvent && vix < 12) {
        goState='go'; goIcon='⚡'; goLabel='EVENT PLAY — LONG STRADDLE + STRANGLE';
        goReason=`Neutral score + ${eventFlag.toUpperCase()} event + VIX ${vix} (very low IV). Buying volatility before event is optimal.`;
        primaryStrat='STRADDLE'; altStrat='IC';
      } else if (vix < 11 && Math.abs(score) <= 0.20) {
        // Iron Butterfly: VIX < 11 + dead neutral — max premium from ATM body
        goState='go'; goIcon='🦋'; goLabel='TRADE TODAY — IRON BUTTERFLY';
        goReason=`Score ${score>=0?'+':''}${score.toFixed(2)} (dead neutral), VIX ${vix} (very low) — ATM body gives 2–3× IC credit. Nifty must pin near ${Math.round(price/50)*50}.`;
        primaryStrat='IRON_BUTTERFLY'; altStrat='IC';
      } else if (vix >= 15) {
        goState='caution'; goIcon='🟡'; goLabel='CAUTION — IC WITH WIDER STRIKES';
        goReason=`Neutral score but VIX ${vix} elevated. Widen strike buffer by 50–100pts. Consider 50% position size.`;
        primaryStrat='IC'; altStrat = hasEvent ? 'STRADDLE' : null;
      } else {
        goState='go'; goIcon='🟢'; goLabel='TRADE TODAY — IRON CONDOR';
        goReason=`Score ${score>=0?'+':''}${score.toFixed(2)} (neutral), VIX ${vix}, ${bestExp.dte} DTE — ideal IC conditions.`;
        primaryStrat='IC'; altStrat = (hasEvent && vix < 14) ? 'STRADDLE' : null;
      }
    } else if (dirCat === 'MILD_BEAR') {
      goState = vix >= 15 ? 'caution' : 'go';
      goIcon  = goState==='go' ? '🟢' : '🟡';
      if (useCredit) {
        primaryStrat='BEAR_CALL'; altStrat='BEAR_PUT';
        goLabel = `${goState==='caution'?'⚠️ CAUTION':'MILD BEAR'} — BEAR CALL SPREAD`;
        goReason= `Score ${score.toFixed(2)}, VIX ${vix}${vix>=14?' — call premiums elevated. Selling preferred.':''}.`;
      } else {
        primaryStrat='BEAR_PUT'; altStrat='BEAR_CALL';
        goLabel = `${goState==='caution'?'⚠️ CAUTION':'MILD BEAR'} — BEAR PUT SPREAD`;
        goReason= `Score ${score.toFixed(2)}, VIX ${vix} < 14 — premiums compressed. Debit spread better value today.`;
      }
    } else { // STRONG_BEAR
      goState='go'; goIcon='📉'; goLabel='STRONG BEAR — BEAR PUT SPREAD';
      goReason=`Score ${score.toFixed(2)} — strong downside bias. Buy ATM PE, sell OTM PE. Defined risk, participates in the fall.`;
      primaryStrat='BEAR_PUT'; altStrat='BEAR_CALL';
    }
  }

  // ── IC calculations (always — used for IC path + alternatives) ─
  const width    = 200;
  const callBest = bestStrike(price, atr, bestExp?.dte||14, vix, true,  oiCall, pcr, true);
  const putBest  = bestStrike(price, atr, bestExp?.dte||14, vix, false, oiPut,  pcr, true);
  const callBuy  = r50(callBest.strike + width);
  const putBuy   = r50(putBest.strike  - width);
  const callDist = (callBest.strike - price) / atr;
  const putDist  = (price - putBest.strike) / atr;
  const callNarr = strikeNarration(callDist);
  const putNarr  = strikeNarration(putDist);
  const pa       = pcrPremAdj(pcr, bestExp?.dte||14);
  const crBase   = estimateCredit(width, bestExp?.dte||14, vix, true);
  const callMid  = Math.min(r5(crBase.midCall * distFactorCall(callDist, bestExp?.dte||14) / Math.max(pa,1)), r5(width*0.68));
  const putMid   = Math.min(r5(crBase.mid     * distFactor(putDist) * pa), r5(width*0.68));
  const callMin  = r5(callMid*0.80), callMax = r5(callMid*1.22);
  const putMin   = r5(putMid*0.80),  putMax  = r5(putMid*1.22);
  const icMidUnit = callMid + putMid;
  const cm        = capitalMetrics(icMidUnit, width, NF_LOT_SIZE, NF_MARGIN_PER_LOT);
  const icCredit  = icMidUnit * NF_LOT_SIZE * cm.safeLots;
  const icMaxL    = (width - icMidUnit) * NF_LOT_SIZE * cm.safeLots;
  const bhav      = bestExp ? bhavIC(callBest.strike, callBuy, putBest.strike, putBuy, bestExp.d) : null;
  const bhavAtr   = bhavATR();
  const bhavPcr   = bestExp ? bhavPCR(bestExp.d) : null;
  const exitBase  = bhav ? bhav.total : icMidUnit;
  const exitCredit = exitBase * NF_LOT_SIZE * cm.safeLots;
  const callRR    = callMid>0 ? r5((width-callMid)/callMid) : 99;
  const putRR     = putMid>0  ? r5((width-putMid)/putMid)   : 99;
  const callWP    = bestExp ? winProb(bestExp.dte, callDist) : 0;
  const putWP     = bestExp ? winProb(bestExp.dte, putDist)  : 0;
  // ── FIX v2.1.0: down5/up5 were undefined — bug causes NaN in stress test
  const down5     = price * 0.95;
  const up5       = price * 1.05;
  const putBreach  = down5 < putBest.strike;
  const callBreach = up5   > callBest.strike;

  // ── Debit spread calculations (Bull Call / Bear Put) ──────
  const dte = bestExp?.dte || 14;
  const ds  = estimateDebitSpread(width, dte, vix);
  const atmStrike  = r50(price);  // ATM = spot rounded to nearest 50
  // Bull Call Spread: Buy ATM CE, Sell ATM+200 CE
  const bcsSellStrike = atmStrike;
  const bcsBuyStrike  = r50(atmStrike + width);  // protective leg
  // Bear Put Spread: Buy ATM PE, Sell ATM-200 PE
  const bpsSellStrike = atmStrike;
  const bpsBuyStrike  = r50(atmStrike - width);  // protective leg
  // Debit spread capital: just net debit × lots (no margin needed)
  const dsLots    = cm.safeLots; // use same lot sizing for consistency
  const dsDebit   = ds.netDebit * NF_LOT_SIZE * dsLots;
  const dsProfit  = ds.maxProfit * NF_LOT_SIZE * dsLots;
  const dsBEPbull = atmStrike + ds.netDebit;  // Bull Call BEP
  const dsBEPbear = atmStrike - ds.netDebit;  // Bear Put BEP

  // ── High-VIX directional credit spread (VIX 20–28) ───────
  // Strike anchored on OI wall — not ATR — to join smart money
  const hvixCallSell = oiCall ? r50(oiCall)          : r50(price + 225);
  const hvixCallBuy  = hvixCallSell + 200;
  const hvixPutSell  = oiPut  ? r50(oiPut)           : r50(price - 225);
  const hvixPutBuy   = hvixPutSell - 200;
  const hvixCallDist = atr > 0 ? (hvixCallSell - price) / atr : 1.0;
  const hvixPutDist  = atr > 0 ? (price - hvixPutSell)  / atr : 1.0;
  const hvixCrBase   = estimateCredit(200, dte, vix, true);
  const hvixCallMid  = Math.min(r5(hvixCrBase.midCall * distFactorCall(hvixCallDist, dte) / Math.max(pcrPremAdj(pcr,dte),1)), r5(200*0.68));
  const hvixPutMid   = Math.min(r5(hvixCrBase.mid     * distFactor(hvixPutDist)            * pcrPremAdj(pcr,dte)),              r5(200*0.68));
  const hvixLots     = 1;  // conservative — 1 lot only in high-VIX
  const hvixCallNet  = hvixCallMid * NF_LOT_SIZE * hvixLots;
  const hvixCallMaxL = (200 - hvixCallMid) * NF_LOT_SIZE * hvixLots;
  const hvixCallBEP  = hvixCallSell + hvixCallMid;
  const hvixPutNet   = hvixPutMid  * NF_LOT_SIZE * hvixLots;
  const hvixPutMaxL  = (200 - hvixPutMid) * NF_LOT_SIZE * hvixLots;
  const hvixPutBEP   = hvixPutSell - hvixPutMid;
  const hvixCallMn   = moneyness(hvixCallSell, price, true);
  const hvixCallBuyMn= moneyness(hvixCallBuy,  price, true);
  const hvixPutMn    = moneyness(hvixPutSell,  price, false);
  const hvixPutBuyMn = moneyness(hvixPutBuy,   price, false);

  // ── Straddle / Strangle ────────────────────────────────────
  const sd      = estimateStraddle(price, dte, vix);
  const sdTotal = sd.unit * NF_LOT_SIZE * cm.safeLots;
  const stgCE   = r50(atmStrike + width);   // Strangle OTM CE
  const stgPE   = r50(atmStrike - width);   // Strangle OTM PE
  const stgUnit = r5(sd.unit * 0.54);       // Strangle ≈ 54% of straddle cost
  const stgTotal = stgUnit * NF_LOT_SIZE * cm.safeLots;

  // ── Moneyness labels (v2.1.0) ─────────────────────────────
  const callSellMn = moneyness(callBest.strike, price, true);
  const callBuyMn  = moneyness(callBuy,         price, true);
  const putSellMn  = moneyness(putBest.strike,  price, false);
  const putBuyMn   = moneyness(putBuy,          price, false);
  const atmMn      = moneyness(atmStrike, price, true); // should always be ATM
  const bcsOTMmn   = moneyness(bcsBuyStrike, price, true);
  const bpsOTMmn   = moneyness(bpsBuyStrike, price, false);
  const stgCEmn    = moneyness(stgCE, price, true);
  const stgPEmn    = moneyness(stgPE, price, false);

  // ── BNF viability ─────────────────────────────────────────
  const bnfViz = bnfViability(score, vix, bnfAtr||0, bnfPrice||0, bnfPcr);

  // ── Max Pain context ───────────────────────────────────────
  let maxPainNote = '';
  if (maxPain && price) {
    const mpDiff = maxPain - price;
    if (Math.abs(mpDiff) > 200)
      maxPainNote = `Max Pain ${f(maxPain)} — spot is ${mpDiff>0?'₹'+f(mpDiff)+' below':'₹'+f(Math.abs(mpDiff))+' above'} pain level`;
  }

  // ── VIX context ────────────────────────────────────────────
  const vixPct   = Math.min(100, (vix / 30) * 100);
  const vixColor = vix < 14 ? 'var(--gn)' : vix < 20 ? 'var(--am)' : 'var(--rd)';
  const dteSweetSpot = bestExp && bestExp.dte >= 11 && bestExp.dte <= 21;
  const dteColor     = dteSweetSpot ? 'var(--gn)' : bestExp && bestExp.dte <= 5 ? 'var(--rd)' : 'var(--am)';

  // ══════════════════════════════════════════════════════════
  // RENDER HELPERS (inline — keep closure access to all vars)
  // ══════════════════════════════════════════════════════════

  // ── Moneyness badge ────────────────────────────────────────
  const mnBadge = (mn) =>
    `<span style="font-size:7.5px;font-weight:700;padding:1px 5px;border-radius:3px;background:${mn.color}22;color:${mn.color};border:1px solid ${mn.color}44;margin-left:4px">${mn.label}</span>`;

  // ── IC primary card ────────────────────────────────────────
  const renderIC = () => `
  <div class="cmd-card">
    <div class="cmd-hdr">
      <div>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="cmd-expiry">${bestExp.label}</div>
          ${bestExp.shifted ? '<span class="tag am">⚠️ Holiday adj.</span>' : ''}
          ${dteSweetSpot ? '<span class="tag up" style="font-size:7px">⭐ SWEET SPOT</span>' : ''}
        </div>
        <div class="cmd-dte">${bestExp.dte} DTE · ${bestExp.type} · <span style="color:${dteColor}">${bestExp.dte<=5?'EXPIRY WEEK':bestExp.dte<=21?'Optimal window':'Mid-term'}</span></div>
        ${maxPainNote ? `<div style="font-size:8px;color:var(--am);margin-top:2px">📍 ${maxPainNote}</div>` : ''}
      </div>
      <div class="cmd-credit-box">
        <div class="cmd-credit-lbl">IC CREDIT</div>
        <div class="cmd-credit-val">${fv(icCredit)}</div>
        <div class="cmd-credit-range" style="color:var(--muted)">unit ₹${callMin+putMin}–${callMax+putMax}</div>
      </div>
    </div>
    <div class="cmd-legs">
      <div class="cmd-leg call">
        <div class="cmd-leg-type">🔴 Bear Call Spread</div>
        <div class="cmd-leg-sell">Sell ${f(callBest.strike)} CE ${mnBadge(callSellMn)}</div>
        <div class="cmd-leg-buy">Buy&nbsp; ${f(callBuy)} CE ${mnBadge(callBuyMn)}</div>
        <div class="cmd-leg-narration" style="color:${callNarr.color}">${callNarr.label} · ${callDist.toFixed(1)}×ATR</div>
        <div class="cmd-leg-credit">₹${callMin}–${callMax}/unit</div>
      </div>
      <div class="cmd-leg put">
        <div class="cmd-leg-type">🟢 Bull Put Spread</div>
        <div class="cmd-leg-sell">Sell ${f(putBest.strike)} PE ${mnBadge(putSellMn)}</div>
        <div class="cmd-leg-buy">Buy&nbsp; ${f(putBuy)} PE ${mnBadge(putBuyMn)}</div>
        <div class="cmd-leg-narration" style="color:${putNarr.color}">${putNarr.label} · ${putDist.toFixed(1)}×ATR</div>
        <div class="cmd-leg-credit">₹${putMin}–${putMax}/unit</div>
      </div>
    </div>
    ${bhav ? `
    <div style="background:rgba(0,180,255,0.05);border:1px solid rgba(0,180,255,0.2);border-radius:5px;padding:8px 10px;margin:6px 0 2px">
      <div style="font-size:7px;font-weight:700;letter-spacing:1px;color:var(--tl);text-transform:uppercase;margin-bottom:5px">📊 ACTUAL FROM BHAV COPY · ${bhavLatestLabel()}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:8px">
        <div><div style="color:var(--muted);margin-bottom:2px">🔴 Call spread</div>
          <div style="font-family:var(--font-mono);font-weight:700;font-size:11px;color:var(--rd)">₹${bhav.callNet}/unit</div>
          <div style="color:var(--muted);font-size:7px;margin-top:1px">${f(callBest.strike)}CE ₹${bhav.cs} − ${f(callBuy)}CE ₹${bhav.cb}</div></div>
        <div><div style="color:var(--muted);margin-bottom:2px">🟢 Put spread</div>
          <div style="font-family:var(--font-mono);font-weight:700;font-size:11px;color:var(--gn)">₹${bhav.putNet}/unit</div>
          <div style="color:var(--muted);font-size:7px;margin-top:1px">${f(putBest.strike)}PE ₹${bhav.ps} − ${f(putBuy)}PE ₹${bhav.pb}</div></div>
      </div>
      <div style="border-top:1px solid rgba(0,180,255,0.15);margin-top:6px;padding-top:6px;display:flex;justify-content:space-between;align-items:center">
        <div style="font-size:8px;color:var(--muted)">Actual IC total</div>
        <div style="font-family:var(--font-mono);font-weight:800;font-size:13px;color:var(--tl)">₹${bhav.total}/unit = ${fv(exitCredit)}</div>
      </div>
      ${bhav.total < icMidUnit*0.6 ? `<div style="font-size:7.5px;color:var(--am);margin-top:4px">⚠️ Actual lower than model — market compressed. Use bhav figure for exits.</div>` : ''}
      ${bhav.total > icMidUnit*1.4 ? `<div style="font-size:7.5px;color:var(--gn);margin-top:4px">✅ Actual higher than model — elevated IV. Favourable entry.</div>` : ''}
    </div>` : `
    <div style="font-size:7.5px;color:var(--muted);text-align:center;padding:5px 0 2px;border-top:1px solid var(--border);margin-top:4px">
      📊 Upload bhav copy in Smarts tab for actual market premiums · Using model estimate
    </div>`}
    <div class="cmd-stats">
      <div class="cmd-stat"><div class="cmd-stat-lbl">Lots · Lot sz</div><div class="cmd-stat-val" style="color:var(--tl)">${cm.safeLots} × ${NF_LOT_SIZE}</div></div>
      <div class="cmd-stat"><div class="cmd-stat-lbl">R:R · Win%</div><div class="cmd-stat-val" style="color:var(--am)">${Math.min(callRR,putRR).toFixed(1)} · ${Math.round((callWP+putWP)/2)}%</div></div>
      <div class="cmd-stat"><div class="cmd-stat-lbl">Max Loss</div><div class="cmd-stat-val" style="color:var(--rd)">${fv(icMaxL)}</div></div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--border)">
      <div style="background:var(--bg3);padding:7px 8px;text-align:center"><div style="font-size:6.5px;letter-spacing:0.8px;color:var(--muted);text-transform:uppercase;margin-bottom:2px">Capital</div><div style="font-family:var(--font-mono);font-size:10px;font-weight:700">₹1.1L</div></div>
      <div style="background:var(--bg3);padding:7px 8px;text-align:center"><div style="font-size:6.5px;letter-spacing:0.8px;color:var(--muted);text-transform:uppercase;margin-bottom:2px">Margin</div><div style="font-family:var(--font-mono);font-size:10px;font-weight:700;color:var(--tl)">${fv(cm.marginUsed)}</div></div>
      <div style="background:var(--bg3);padding:7px 8px;text-align:center"><div style="font-size:6.5px;letter-spacing:0.8px;color:var(--muted);text-transform:uppercase;margin-bottom:2px">Buffer</div><div style="font-family:var(--font-mono);font-size:10px;font-weight:700;color:var(--gn)">${fv(cm.bufferLeft)}</div></div>
      <div style="background:${cm.riskFlag?'rgba(200,33,62,0.1)':'var(--bg3)'};padding:7px 8px;text-align:center"><div style="font-size:6.5px;letter-spacing:0.8px;color:${cm.riskFlag?'var(--rd)':'var(--muted)'};text-transform:uppercase;margin-bottom:2px">SL Risk</div><div style="font-family:var(--font-mono);font-size:10px;font-weight:700;color:${cm.riskFlag?'var(--rd)':'var(--am)'}">${cm.slPct.toFixed(1)}%${cm.riskFlag?' ⚠️':''}</div></div>
    </div>
    <div class="cmd-exits">
      <div class="cmd-exit profit"><div class="cmd-exit-lbl">✅ Take Profit</div><div class="cmd-exit-val" style="color:var(--gn)">${fv(exitCredit*0.40)}</div><div style="font-size:7.5px;color:var(--muted);margin-top:2px">40% of ${bhav?'actual':'est.'} credit</div></div>
      <div class="cmd-exit loss"><div class="cmd-exit-lbl">🛑 Stop Loss</div><div class="cmd-exit-val" style="color:var(--rd)">${fv(exitCredit*0.80)}</div><div style="font-size:7.5px;color:var(--muted);margin-top:2px">80% of credit — hard exit</div></div>
    </div>
    <div class="stress-strip">
      <div class="stress-side"><div class="stress-scenario">Spot −5% → ${f(Math.round(down5))}</div><div class="stress-result ${putBreach?'breach':'safe'}">${putBreach?'⚠️ PUT BREACHED':'✅ Safe'}</div><div style="font-size:7.5px;color:var(--muted);margin-top:2px">${putBreach?'Put side at risk of max loss':'Buffer: '+f(price-putBest.strike)+'pts'}</div></div>
      <div class="stress-side"><div class="stress-scenario">Spot +5% → ${f(Math.round(up5))}</div><div class="stress-result ${callBreach?'breach':'safe'}">${callBreach?'⚠️ CALL BREACHED':'✅ Safe'}</div><div style="font-size:7.5px;color:var(--muted);margin-top:2px">${callBreach?'Call side at risk of max loss':'Buffer: '+f(callBest.strike-price)+'pts'}</div></div>
    </div>
  </div>`;

  // ── Iron Butterfly card (credit, dead neutral, VIX < 11) ───────
  const renderIronButterfly = (isAlt) => {
    const ibWidth   = 200;
    const bodyStr   = Math.round(price / 50) * 50;  // nearest 50 = ATM
    const wingCall  = bodyStr + ibWidth;             // 24,850
    const wingPut   = bodyStr - ibWidth;             // 24,450

    // Credit: use straddle estimate for ATM body, subtract wing cost
    const sd       = estimateStraddle(price, bestExp.dte, vix);
    const wingCost = estimateCredit(ibWidth, bestExp.dte, vix, true);  // wing debit
    const netUnit  = Math.max(r5(sd.unit - wingCost.mid * 2), 10);    // net credit/unit
    const netMin   = r5(netUnit * 0.80);
    const netMax   = r5(netUnit * 1.22);
    const lots_    = 1;
    const netTotal = netUnit * NF_LOT * lots_;
    const maxLoss  = (ibWidth - netUnit) * NF_LOT * lots_;
    const bepUp    = bodyStr + netUnit;
    const bepDn    = bodyStr - netUnit;

    const bodyMn   = moneyness(bodyStr, price, true);  // ATM always
    const wCallMn  = moneyness(wingCall, price, true);
    const wPutMn   = moneyness(wingPut,  price, false);

    const fv = n => '₹' + Math.round(n).toLocaleString('en-IN');
    const f  = n => Math.round(n).toLocaleString('en-IN');

    return `
  <div class="cmd-card" style="${isAlt?'opacity:0.85':''}">
    <div class="cmd-hdr">
      <div>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="cmd-expiry" style="font-size:15px">${bestExp.label}</div>
          ${isAlt ? '<span class="tag fl" style="font-size:7px">ALTERNATIVE</span>' : '<span class="tag" style="background:rgba(94,61,179,0.12);color:var(--pu);border:1px solid rgba(94,61,179,0.3);font-size:7px">🦋 PRIMARY</span>'}
        </div>
        <div class="cmd-dte">${bestExp.dte} DTE · IRON BUTTERFLY · Net Credit</div>
      </div>
      <div class="cmd-credit-box">
        <div class="cmd-credit-lbl">CREDIT</div>
        <div class="cmd-credit-val">${fv(netTotal)}</div>
        <div class="cmd-credit-range">₹${netMin}–${netMax}/unit</div>
      </div>
    </div>

    <!-- 4 legs -->
    <div style="padding:12px 14px;display:grid;grid-template-columns:1fr 1fr;gap:8px;">
      <!-- Body Call -->
      <div class="cmd-leg call">
        <div class="cmd-leg-type">SELL · CALL BODY</div>
        <div class="cmd-leg-sell">${f(bodyStr)} CE ${mnBadge(bodyMn)}</div>
        <div class="cmd-leg-narration" style="color:var(--rd);font-size:8px;">ATM — maximum premium</div>
      </div>
      <!-- Body Put -->
      <div class="cmd-leg put">
        <div class="cmd-leg-type">SELL · PUT BODY</div>
        <div class="cmd-leg-sell">${f(bodyStr)} PE ${mnBadge(bodyMn)}</div>
        <div class="cmd-leg-narration" style="color:var(--gn);font-size:8px;">ATM — maximum premium</div>
      </div>
      <!-- Wing Call -->
      <div style="background:rgba(200,33,62,0.03);border:1px solid rgba(200,33,62,0.15);border-radius:8px;padding:10px 12px;">
        <div class="cmd-leg-type" style="color:var(--muted);">BUY · CALL WING</div>
        <div class="cmd-leg-sell" style="font-size:13px;color:var(--muted)">${f(wingCall)} CE ${mnBadge(wCallMn)}</div>
        <div style="font-size:8px;color:var(--muted);margin-top:3px">+${ibWidth}pt hedge</div>
      </div>
      <!-- Wing Put -->
      <div style="background:rgba(0,127,95,0.03);border:1px solid rgba(0,127,95,0.15);border-radius:8px;padding:10px 12px;">
        <div class="cmd-leg-type" style="color:var(--muted);">BUY · PUT WING</div>
        <div class="cmd-leg-sell" style="font-size:13px;color:var(--muted)">${f(wingPut)} PE ${mnBadge(wPutMn)}</div>
        <div style="font-size:8px;color:var(--muted);margin-top:3px">−${ibWidth}pt hedge</div>
      </div>
    </div>

    <!-- Key metrics -->
    <div class="cmd-stats">
      <div class="cmd-stat"><div class="cmd-stat-lbl">MAX PROFIT</div><div class="cmd-stat-val" style="color:var(--gn)">${fv(netTotal)}</div></div>
      <div class="cmd-stat"><div class="cmd-stat-lbl">MAX LOSS</div><div class="cmd-stat-val" style="color:var(--rd)">${fv(maxLoss)}</div></div>
      <div class="cmd-stat"><div class="cmd-stat-lbl">PROFIT ZONE</div><div class="cmd-stat-val" style="color:var(--am);font-size:10px">${f(bepDn)}–${f(bepUp)}</div></div>
    </div>

    <!-- Breakevens callout -->
    <div style="padding:8px 14px;background:rgba(94,61,179,0.05);border-top:1px solid var(--border);">
      <div style="font-size:7.5px;color:var(--muted);margin-bottom:4px;letter-spacing:1px;text-transform:uppercase;">Breakeven Points</div>
      <div style="display:flex;justify-content:space-between;">
        <div style="text-align:center;">
          <div style="font-family:var(--font-mono);font-size:13px;font-weight:700;color:var(--rd)">${f(bepDn)}</div>
          <div style="font-size:7.5px;color:var(--muted)">Lower BEP</div>
        </div>
        <div style="text-align:center;">
          <div style="font-family:var(--font-mono);font-size:13px;font-weight:700;color:var(--pu)">${f(bodyStr)}</div>
          <div style="font-size:7.5px;color:var(--muted)">Max Profit PIN</div>
        </div>
        <div style="text-align:center;">
          <div style="font-family:var(--font-mono);font-size:13px;font-weight:700;color:var(--gn)">${f(bepUp)}</div>
          <div style="font-size:7.5px;color:var(--muted)">Upper BEP</div>
        </div>
      </div>
    </div>

    <!-- Exit rules -->
    <div class="cmd-exits">
      <div class="cmd-exit profit"><div class="cmd-exit-lbl">✅ Take Profit</div><div class="cmd-exit-val" style="color:var(--gn)">${fv(netTotal*0.40)}</div><div style="font-size:7.5px;color:var(--muted);margin-top:2px">40% of credit</div></div>
      <div class="cmd-exit loss"><div class="cmd-exit-lbl">🛑 Stop Loss</div><div class="cmd-exit-val" style="color:var(--rd)">${fv(netTotal*0.80)}</div><div style="font-size:7.5px;color:var(--muted);margin-top:2px">80% of credit — hard exit</div></div>
    </div>

    <!-- Warning note -->
    <div style="padding:8px 14px;font-size:8.5px;color:var(--am);border-top:1px solid var(--border);line-height:1.6;">
      ⚠️ <strong>Profit zone is tight</strong> — Nifty must stay between ${f(bepDn)}–${f(bepUp)} (±${netUnit}pts from body). If Nifty moves more than ${netUnit}pts from ${f(bodyStr)}, exit immediately. Do not let this become max loss.
    </div>
  </div>`;
  };

  // ── Bull Put Spread card (credit, bullish) ─────────────────
  const renderBullPut = (isAlt) => {
    const cn = isAlt ? 'var(--border)' : 'var(--gn-br)';
    return `
  <div class="cmd-card" style="${isAlt?'opacity:0.85':''}">
    <div class="cmd-hdr">
      <div>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="cmd-expiry" style="font-size:15px">${bestExp.label}</div>
          ${isAlt ? '<span class="tag fl" style="font-size:7px">ALTERNATIVE</span>' : '<span class="tag up" style="font-size:7px">✅ PRIMARY</span>'}
        </div>
        <div class="cmd-dte">${bestExp.dte} DTE · BULL PUT SPREAD · Net Credit</div>
      </div>
      <div class="cmd-credit-box">
        <div class="cmd-credit-lbl">CREDIT</div>
        <div class="cmd-credit-val" style="font-size:18px">${fv(putMid*NF_LOT_SIZE*cm.safeLots)}</div>
        <div class="cmd-credit-range">₹${putMin}–${putMax}/unit</div>
      </div>
    </div>
    <div style="padding:12px 14px">
      <div style="margin-bottom:10px">
        <div style="font-size:8px;font-weight:700;letter-spacing:1px;color:var(--muted);text-transform:uppercase;margin-bottom:5px">LEGS</div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
          <span style="font-size:9px;font-weight:700;color:var(--gn);width:40px">SELL</span>
          <span style="font-family:var(--font-mono);font-size:14px;font-weight:800">${f(putBest.strike)} PE</span>
          ${mnBadge(putSellMn)}
          <span style="font-size:8px;color:var(--gn);margin-left:auto">+₹${putMin}–${putMax}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:9px;font-weight:700;color:var(--muted);width:40px">BUY</span>
          <span style="font-family:var(--font-mono);font-size:14px;font-weight:800">${f(putBuy)} PE</span>
          ${mnBadge(putBuyMn)}
          <span style="font-size:8px;color:var(--muted);margin-left:auto">hedge</span>
        </div>
      </div>
      <div style="font-size:8px;color:${putBest.isOI?'var(--am)':'var(--muted)'};margin-bottom:8px">${putBest.isOI?'🎯 ':''}${putBest.reason} · ${putDist.toFixed(2)}×ATR</div>
    </div>
    <div class="cmd-stats">
      <div class="cmd-stat"><div class="cmd-stat-lbl">Max Profit</div><div class="cmd-stat-val" style="color:var(--gn)">${fv(putMid*NF_LOT_SIZE*cm.safeLots)}</div></div>
      <div class="cmd-stat"><div class="cmd-stat-lbl">Max Loss</div><div class="cmd-stat-val" style="color:var(--rd)">${fv((width-putMid)*NF_LOT_SIZE*cm.safeLots)}</div></div>
      <div class="cmd-stat"><div class="cmd-stat-lbl">BEP</div><div class="cmd-stat-val" style="color:var(--am)">${f(putBest.strike - putMid)}</div></div>
    </div>
    <div class="cmd-exits">
      <div class="cmd-exit profit"><div class="cmd-exit-lbl">✅ Take Profit</div><div class="cmd-exit-val" style="color:var(--gn)">${fv(putMid*NF_LOT_SIZE*cm.safeLots*0.40)}</div><div style="font-size:7.5px;color:var(--muted);margin-top:2px">40% of credit</div></div>
      <div class="cmd-exit loss"><div class="cmd-exit-lbl">🛑 Stop Loss</div><div class="cmd-exit-val" style="color:var(--rd)">${fv(putMid*NF_LOT_SIZE*cm.safeLots*0.80)}</div><div style="font-size:7.5px;color:var(--muted);margin-top:2px">80% of credit</div></div>
    </div>
    <div style="padding:8px 14px;background:var(--bg3);font-size:8.5px;color:var(--muted)">💡 Win if Nifty stays above <strong style="color:var(--gn)">${f(putBest.strike - putMid)}</strong> by expiry · Profit intact below ${f(putBest.strike)}</div>
  </div>`;};

  // ── Bear Call Spread card (credit, bearish) ─────────────────
  const renderBearCall = (isAlt) => `
  <div class="cmd-card" style="${isAlt?'opacity:0.85':''}">
    <div class="cmd-hdr">
      <div>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="cmd-expiry" style="font-size:15px">${bestExp.label}</div>
          ${isAlt ? '<span class="tag fl" style="font-size:7px">ALTERNATIVE</span>' : '<span class="tag dn" style="font-size:7px">✅ PRIMARY</span>'}
        </div>
        <div class="cmd-dte">${bestExp.dte} DTE · BEAR CALL SPREAD · Net Credit</div>
      </div>
      <div class="cmd-credit-box">
        <div class="cmd-credit-lbl">CREDIT</div>
        <div class="cmd-credit-val" style="font-size:18px">${fv(callMid*NF_LOT_SIZE*cm.safeLots)}</div>
        <div class="cmd-credit-range">₹${callMin}–${callMax}/unit</div>
      </div>
    </div>
    <div style="padding:12px 14px">
      <div style="margin-bottom:10px">
        <div style="font-size:8px;font-weight:700;letter-spacing:1px;color:var(--muted);text-transform:uppercase;margin-bottom:5px">LEGS</div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
          <span style="font-size:9px;font-weight:700;color:var(--rd);width:40px">SELL</span>
          <span style="font-family:var(--font-mono);font-size:14px;font-weight:800">${f(callBest.strike)} CE</span>
          ${mnBadge(callSellMn)}
          <span style="font-size:8px;color:var(--gn);margin-left:auto">+₹${callMin}–${callMax}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:9px;font-weight:700;color:var(--muted);width:40px">BUY</span>
          <span style="font-family:var(--font-mono);font-size:14px;font-weight:800">${f(callBuy)} CE</span>
          ${mnBadge(callBuyMn)}
          <span style="font-size:8px;color:var(--muted);margin-left:auto">hedge</span>
        </div>
      </div>
      <div style="font-size:8px;color:${callBest.isOI?'var(--am)':'var(--muted)'};margin-bottom:8px">${callBest.isOI?'🎯 ':''}${callBest.reason} · ${callDist.toFixed(2)}×ATR</div>
    </div>
    <div class="cmd-stats">
      <div class="cmd-stat"><div class="cmd-stat-lbl">Max Profit</div><div class="cmd-stat-val" style="color:var(--gn)">${fv(callMid*NF_LOT_SIZE*cm.safeLots)}</div></div>
      <div class="cmd-stat"><div class="cmd-stat-lbl">Max Loss</div><div class="cmd-stat-val" style="color:var(--rd)">${fv((width-callMid)*NF_LOT_SIZE*cm.safeLots)}</div></div>
      <div class="cmd-stat"><div class="cmd-stat-lbl">BEP</div><div class="cmd-stat-val" style="color:var(--am)">${f(callBest.strike + callMid)}</div></div>
    </div>
    <div class="cmd-exits">
      <div class="cmd-exit profit"><div class="cmd-exit-lbl">✅ Take Profit</div><div class="cmd-exit-val" style="color:var(--gn)">${fv(callMid*NF_LOT_SIZE*cm.safeLots*0.40)}</div><div style="font-size:7.5px;color:var(--muted);margin-top:2px">40% of credit</div></div>
      <div class="cmd-exit loss"><div class="cmd-exit-lbl">🛑 Stop Loss</div><div class="cmd-exit-val" style="color:var(--rd)">${fv(callMid*NF_LOT_SIZE*cm.safeLots*0.80)}</div><div style="font-size:7.5px;color:var(--muted);margin-top:2px">80% of credit</div></div>
    </div>
    <div style="padding:8px 14px;background:var(--bg3);font-size:8.5px;color:var(--muted)">💡 Win if Nifty stays below <strong style="color:var(--rd)">${f(callBest.strike + callMid)}</strong> by expiry · Profit intact above ${f(callBest.strike)}</div>
  </div>`;

  // ── Bull Call Spread card (debit, bullish) ──────────────────
  const renderBullCall = (isAlt) => `
  <div class="cmd-card" style="${isAlt?'opacity:0.85':''}">
    <div class="cmd-hdr">
      <div>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="cmd-expiry" style="font-size:15px">${bestExp.label}</div>
          ${isAlt ? '<span class="tag fl" style="font-size:7px">ALTERNATIVE</span>' : '<span class="tag up" style="font-size:7px">✅ PRIMARY</span>'}
        </div>
        <div class="cmd-dte">${bestExp.dte} DTE · BULL CALL SPREAD · Net Debit</div>
      </div>
      <div class="cmd-credit-box">
        <div class="cmd-credit-lbl">MAX PROFIT</div>
        <div class="cmd-credit-val" style="font-size:18px;color:var(--am)">${fv(dsProfit)}</div>
        <div class="cmd-credit-range" style="color:var(--muted)">debit ₹${ds.ndMin}–${ds.ndMax}/unit</div>
      </div>
    </div>
    <div style="padding:12px 14px">
      <div style="margin-bottom:10px">
        <div style="font-size:8px;font-weight:700;letter-spacing:1px;color:var(--muted);text-transform:uppercase;margin-bottom:5px">LEGS</div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
          <span style="font-size:9px;font-weight:700;color:var(--tl);width:40px">BUY</span>
          <span style="font-family:var(--font-mono);font-size:14px;font-weight:800">${f(bcsSellStrike)} CE</span>
          ${mnBadge(atmMn)}
          <span style="font-size:8px;color:var(--muted);margin-left:auto">pay premium</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:9px;font-weight:700;color:var(--muted);width:40px">SELL</span>
          <span style="font-family:var(--font-mono);font-size:14px;font-weight:800">${f(bcsBuyStrike)} CE</span>
          ${mnBadge(bcsOTMmn)}
          <span style="font-size:8px;color:var(--gn);margin-left:auto">offset cost</span>
        </div>
      </div>
      <div style="background:rgba(176,110,0,0.08);border:1px solid var(--am-br);border-radius:6px;padding:7px 10px;font-size:8.5px">
        <span style="color:var(--am);font-weight:700">Net Debit: ₹${ds.netDebit}/unit</span>
        <span style="color:var(--muted);margin-left:8px">Capital at risk: ${fv(dsDebit)}</span>
      </div>
    </div>
    <div class="cmd-stats">
      <div class="cmd-stat"><div class="cmd-stat-lbl">Max Profit</div><div class="cmd-stat-val" style="color:var(--gn)">${fv(dsProfit)}</div></div>
      <div class="cmd-stat"><div class="cmd-stat-lbl">Max Loss</div><div class="cmd-stat-val" style="color:var(--rd)">${fv(dsDebit)}</div></div>
      <div class="cmd-stat"><div class="cmd-stat-lbl">BEP</div><div class="cmd-stat-val" style="color:var(--am)">${f(dsBEPbull)}</div></div>
    </div>
    <div class="cmd-exits">
      <div class="cmd-exit profit"><div class="cmd-exit-lbl">✅ Take Profit</div><div class="cmd-exit-val" style="color:var(--gn)">${fv(dsProfit*0.60)}</div><div style="font-size:7.5px;color:var(--muted);margin-top:2px">60% of max profit</div></div>
      <div class="cmd-exit loss"><div class="cmd-exit-lbl">🛑 Stop Loss</div><div class="cmd-exit-val" style="color:var(--rd)">${fv(dsDebit*0.50)}</div><div style="font-size:7.5px;color:var(--muted);margin-top:2px">50% of debit paid</div></div>
    </div>
    <div style="padding:8px 14px;background:var(--bg3);font-size:8.5px;color:var(--muted)">💡 Profit if Nifty closes above <strong style="color:var(--gn)">${f(dsBEPbull)}</strong> · Max profit at ${f(bcsBuyStrike)} or above · Capital needed: ${fv(dsDebit)} only</div>
  </div>`;

  // ── Bear Put Spread card (debit, bearish) ───────────────────
  const renderBearPut = (isAlt) => `
  <div class="cmd-card" style="${isAlt?'opacity:0.85':''}">
    <div class="cmd-hdr">
      <div>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="cmd-expiry" style="font-size:15px">${bestExp.label}</div>
          ${isAlt ? '<span class="tag fl" style="font-size:7px">ALTERNATIVE</span>' : '<span class="tag dn" style="font-size:7px">✅ PRIMARY</span>'}
        </div>
        <div class="cmd-dte">${bestExp.dte} DTE · BEAR PUT SPREAD · Net Debit</div>
      </div>
      <div class="cmd-credit-box">
        <div class="cmd-credit-lbl">MAX PROFIT</div>
        <div class="cmd-credit-val" style="font-size:18px;color:var(--am)">${fv(dsProfit)}</div>
        <div class="cmd-credit-range" style="color:var(--muted)">debit ₹${ds.ndMin}–${ds.ndMax}/unit</div>
      </div>
    </div>
    <div style="padding:12px 14px">
      <div style="margin-bottom:10px">
        <div style="font-size:8px;font-weight:700;letter-spacing:1px;color:var(--muted);text-transform:uppercase;margin-bottom:5px">LEGS</div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
          <span style="font-size:9px;font-weight:700;color:var(--tl);width:40px">BUY</span>
          <span style="font-family:var(--font-mono);font-size:14px;font-weight:800">${f(bpsSellStrike)} PE</span>
          ${mnBadge(atmMn)}
          <span style="font-size:8px;color:var(--muted);margin-left:auto">pay premium</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:9px;font-weight:700;color:var(--muted);width:40px">SELL</span>
          <span style="font-family:var(--font-mono);font-size:14px;font-weight:800">${f(bpsBuyStrike)} PE</span>
          ${mnBadge(bpsOTMmn)}
          <span style="font-size:8px;color:var(--gn);margin-left:auto">offset cost</span>
        </div>
      </div>
      <div style="background:rgba(176,110,0,0.08);border:1px solid var(--am-br);border-radius:6px;padding:7px 10px;font-size:8.5px">
        <span style="color:var(--am);font-weight:700">Net Debit: ₹${ds.netDebit}/unit</span>
        <span style="color:var(--muted);margin-left:8px">Capital at risk: ${fv(dsDebit)}</span>
      </div>
    </div>
    <div class="cmd-stats">
      <div class="cmd-stat"><div class="cmd-stat-lbl">Max Profit</div><div class="cmd-stat-val" style="color:var(--gn)">${fv(dsProfit)}</div></div>
      <div class="cmd-stat"><div class="cmd-stat-lbl">Max Loss</div><div class="cmd-stat-val" style="color:var(--rd)">${fv(dsDebit)}</div></div>
      <div class="cmd-stat"><div class="cmd-stat-lbl">BEP</div><div class="cmd-stat-val" style="color:var(--am)">${f(dsBEPbear)}</div></div>
    </div>
    <div class="cmd-exits">
      <div class="cmd-exit profit"><div class="cmd-exit-lbl">✅ Take Profit</div><div class="cmd-exit-val" style="color:var(--gn)">${fv(dsProfit*0.60)}</div><div style="font-size:7.5px;color:var(--muted);margin-top:2px">60% of max profit</div></div>
      <div class="cmd-exit loss"><div class="cmd-exit-lbl">🛑 Stop Loss</div><div class="cmd-exit-val" style="color:var(--rd)">${fv(dsDebit*0.50)}</div><div style="font-size:7.5px;color:var(--muted);margin-top:2px">50% of debit paid</div></div>
    </div>
    <div style="padding:8px 14px;background:var(--bg3);font-size:8.5px;color:var(--muted)">💡 Profit if Nifty closes below <strong style="color:var(--rd)">${f(dsBEPbear)}</strong> · Max profit at ${f(bpsBuyStrike)} or below · Capital needed: ${fv(dsDebit)} only</div>
  </div>`;

  // ── Long Straddle + Strangle card (event play) ──────────────
  const renderStraddle = () => `
  <div class="cmd-card">
    <div class="cmd-hdr">
      <div>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="cmd-expiry" style="font-size:15px">${bestExp.label}</div>
          <span class="tag pu" style="font-size:7px">⚡ EVENT</span>
        </div>
        <div class="cmd-dte">${bestExp.dte} DTE · ${eventFlag.toUpperCase()} · VIX ${vix} (very low IV)</div>
      </div>
      <div class="cmd-credit-box">
        <div class="cmd-credit-lbl">STRADDLE COST</div>
        <div class="cmd-credit-val" style="font-size:18px;color:var(--pu)">${fv(sdTotal)}</div>
        <div class="cmd-credit-range" style="color:var(--muted)">₹${sd.min}–${sd.max}/unit</div>
      </div>
    </div>

    <div style="margin:8px 14px 0;border-radius:6px;background:rgba(94,61,179,0.06);border:1px solid rgba(94,61,179,0.25);padding:10px 12px">
      <div style="font-size:8px;font-weight:700;letter-spacing:1px;color:var(--pu);text-transform:uppercase;margin-bottom:6px">OPTION 1 — LONG STRADDLE (higher cost, closer BEP)</div>
      <div style="display:flex;gap:8px;margin-bottom:6px">
        <div style="flex:1;background:rgba(200,33,62,0.06);border:1px solid rgba(200,33,62,0.2);border-radius:6px;padding:8px 10px">
          <div style="font-size:8px;font-weight:700;color:var(--rd);margin-bottom:3px">BUY CE</div>
          <div style="font-family:var(--font-mono);font-size:14px;font-weight:800">${f(atmStrike)} CE</div>
          ${mnBadge(atmMn)}
        </div>
        <div style="flex:1;background:rgba(0,127,95,0.06);border:1px solid rgba(0,127,95,0.2);border-radius:6px;padding:8px 10px">
          <div style="font-size:8px;font-weight:700;color:var(--gn);margin-bottom:3px">BUY PE</div>
          <div style="font-family:var(--font-mono);font-size:14px;font-weight:800">${f(atmStrike)} PE</div>
          ${mnBadge(atmMn)}
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;font-size:9px">
        <div style="background:var(--bg3);border-radius:5px;padding:5px 8px;text-align:center">
          <div style="font-size:7px;color:var(--muted)">TOTAL COST</div>
          <div style="font-family:var(--font-mono);font-weight:700;color:var(--pu)">${fv(sdTotal)}</div>
        </div>
        <div style="background:var(--bg3);border-radius:5px;padding:5px 8px;text-align:center">
          <div style="font-size:7px;color:var(--muted)">BEP ↑</div>
          <div style="font-family:var(--font-mono);font-weight:700;color:var(--gn)">${f(atmStrike + sd.unit)}</div>
        </div>
        <div style="background:var(--bg3);border-radius:5px;padding:5px 8px;text-align:center">
          <div style="font-size:7px;color:var(--muted)">BEP ↓</div>
          <div style="font-family:var(--font-mono);font-weight:700;color:var(--rd)">${f(atmStrike - sd.unit)}</div>
        </div>
      </div>
    </div>

    <div style="margin:8px 14px 0;border-radius:6px;background:rgba(0,110,150,0.06);border:1px solid rgba(0,110,150,0.25);padding:10px 12px">
      <div style="font-size:8px;font-weight:700;letter-spacing:1px;color:var(--tl);text-transform:uppercase;margin-bottom:6px">OPTION 2 — LONG STRANGLE (cheaper, wider BEP)</div>
      <div style="display:flex;gap:8px;margin-bottom:6px">
        <div style="flex:1;background:rgba(200,33,62,0.06);border:1px solid rgba(200,33,62,0.2);border-radius:6px;padding:8px 10px">
          <div style="font-size:8px;font-weight:700;color:var(--rd);margin-bottom:3px">BUY OTM CE</div>
          <div style="font-family:var(--font-mono);font-size:14px;font-weight:800">${f(stgCE)} CE</div>
          ${mnBadge(stgCEmn)}
        </div>
        <div style="flex:1;background:rgba(0,127,95,0.06);border:1px solid rgba(0,127,95,0.2);border-radius:6px;padding:8px 10px">
          <div style="font-size:8px;font-weight:700;color:var(--gn);margin-bottom:3px">BUY OTM PE</div>
          <div style="font-family:var(--font-mono);font-size:14px;font-weight:800">${f(stgPE)} PE</div>
          ${mnBadge(stgPEmn)}
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;font-size:9px">
        <div style="background:var(--bg3);border-radius:5px;padding:5px 8px;text-align:center">
          <div style="font-size:7px;color:var(--muted)">TOTAL COST</div>
          <div style="font-family:var(--font-mono);font-weight:700;color:var(--tl)">${fv(stgTotal)}</div>
        </div>
        <div style="background:var(--bg3);border-radius:5px;padding:5px 8px;text-align:center">
          <div style="font-size:7px;color:var(--muted)">BEP ↑</div>
          <div style="font-family:var(--font-mono);font-weight:700;color:var(--gn)">${f(stgCE + stgUnit)}</div>
        </div>
        <div style="background:var(--bg3);border-radius:5px;padding:5px 8px;text-align:center">
          <div style="font-size:7px;color:var(--muted)">BEP ↓</div>
          <div style="font-family:var(--font-mono);font-weight:700;color:var(--rd)">${f(stgPE - stgUnit)}</div>
        </div>
      </div>
    </div>

    <div style="margin:8px 14px;background:rgba(94,61,179,0.06);border-radius:6px;padding:8px 12px">
      <div style="font-size:7.5px;font-weight:700;letter-spacing:1px;color:var(--pu);margin-bottom:4px">CHOOSE BASED ON COST</div>
      <div style="font-size:8.5px;color:var(--muted);line-height:1.7">
        📊 Straddle ${fv(sdTotal)} saves ${f(stgCE+stgUnit)}–${f(atmStrike+sd.unit)} gap on upper BEP but costs more.<br>
        📊 Strangle ${fv(stgTotal)} cheaper by ${fv(sdTotal-stgTotal)} but needs bigger move to profit.<br>
        ⚡ Event must cause a move bigger than BEP distance to profit. Both lose max if market flat.
      </div>
    </div>
    <div style="padding:8px 14px;background:rgba(94,61,179,0.06);border-top:1px solid var(--border);font-size:8.5px;color:var(--am);font-weight:600">
      ⚠️ Enter only if major event today/tomorrow. Exit same day if possible — theta kills debit plays on weekly options.
    </div>
  </div>`;

  // ── High-VIX Bear Call Spread (OI-wall anchored) ──────────
  const renderHVixBearCall = () => `
  <div class="cmd-card">
    <div class="cmd-hdr">
      <div>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="cmd-expiry" style="font-size:15px">${bestExp.label}</div>
          <span style="font-size:7.5px;font-weight:700;padding:2px 7px;border-radius:4px;background:rgba(200,33,62,0.12);color:var(--rd);border:1px solid rgba(200,33,62,0.35)">🔴 HIGH VIX</span>
        </div>
        <div class="cmd-dte">${bestExp.dte} DTE · BEAR CALL SPREAD · VIX ${vix} — OI Wall Anchor</div>
      </div>
      <div class="cmd-credit-box">
        <div class="cmd-credit-lbl">CREDIT</div>
        <div class="cmd-credit-val" style="font-size:18px">${fv(hvixCallNet)}</div>
        <div class="cmd-credit-range">~₹${hvixCallMid}/unit est.</div>
      </div>
    </div>
    <div style="margin:0 14px;background:rgba(200,33,62,0.06);border:1px solid rgba(200,33,62,0.2);border-radius:6px;padding:8px 12px;font-size:8.5px;color:var(--rd);line-height:1.6">
      ⚠️ <strong>High-VIX regime</strong> — premiums ~${Math.round((vix/14-1)*100)}% above normal. Selling inflated call premium at OI resistance wall.
      <strong style="color:var(--text)"> 1 lot only.</strong> Do not scale up in panic conditions.
    </div>
    <div style="padding:12px 14px">
      <div style="font-size:8px;font-weight:700;letter-spacing:1px;color:var(--muted);text-transform:uppercase;margin-bottom:8px">LEGS</div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">
        <span style="font-size:9px;font-weight:700;color:var(--rd);width:40px">SELL</span>
        <span style="font-family:var(--font-mono);font-size:15px;font-weight:800">${f(hvixCallSell)} CE</span>
        ${mnBadge(hvixCallMn)}
        <span style="font-size:8px;color:var(--gn);margin-left:auto">collect premium</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span style="font-size:9px;font-weight:700;color:var(--muted);width:40px">BUY</span>
        <span style="font-family:var(--font-mono);font-size:15px;font-weight:800">${f(hvixCallBuy)} CE</span>
        ${mnBadge(hvixCallBuyMn)}
        <span style="font-size:8px;color:var(--muted);margin-left:auto">+200pt hedge</span>
      </div>
      <div style="font-size:8px;color:var(--am)">🎯 Short strike = Call OI wall — smart money stacked here as resistance</div>
    </div>
    <div class="cmd-stats">
      <div class="cmd-stat"><div class="cmd-stat-lbl">Max Profit</div><div class="cmd-stat-val" style="color:var(--gn)">${fv(hvixCallNet)}</div></div>
      <div class="cmd-stat"><div class="cmd-stat-lbl">Max Loss</div><div class="cmd-stat-val" style="color:var(--rd)">${fv(hvixCallMaxL)}</div></div>
      <div class="cmd-stat"><div class="cmd-stat-lbl">BEP</div><div class="cmd-stat-val" style="color:var(--am)">${f(Math.round(hvixCallBEP))}</div></div>
    </div>
    <div class="cmd-exits">
      <div class="cmd-exit profit"><div class="cmd-exit-lbl">✅ Take Profit</div><div class="cmd-exit-val" style="color:var(--gn)">${fv(hvixCallNet*0.50)}</div><div style="font-size:7.5px;color:var(--muted);margin-top:2px">50% of credit — exit early</div></div>
      <div class="cmd-exit loss"><div class="cmd-exit-lbl">🛑 Stop Loss</div><div class="cmd-exit-val" style="color:var(--rd)">${fv(hvixCallMaxL*0.50)}</div><div style="font-size:7.5px;color:var(--muted);margin-top:2px">Spot closes above BEP</div></div>
    </div>
    <div style="padding:8px 14px;background:var(--bg3);font-size:8.5px;color:var(--muted);line-height:1.6">
      💡 Win if Nifty stays below <strong style="color:var(--rd)">${f(Math.round(hvixCallBEP))}</strong> by expiry · OI wall at ${f(hvixCallSell)} is resistance
      <br>⚠️ If spot breaks above ${f(hvixCallSell)} with volume — exit immediately. Don't fight the move.
    </div>
  </div>`;

  // ── High-VIX Bull Put Spread (OI-wall anchored) ────────────
  const renderHVixBullPut = () => `
  <div class="cmd-card">
    <div class="cmd-hdr">
      <div>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="cmd-expiry" style="font-size:15px">${bestExp.label}</div>
          <span style="font-size:7.5px;font-weight:700;padding:2px 7px;border-radius:4px;background:rgba(0,127,95,0.12);color:var(--gn);border:1px solid rgba(0,127,95,0.35)">🟢 HIGH VIX</span>
        </div>
        <div class="cmd-dte">${bestExp.dte} DTE · BULL PUT SPREAD · VIX ${vix} — OI Wall Anchor</div>
      </div>
      <div class="cmd-credit-box">
        <div class="cmd-credit-lbl">CREDIT</div>
        <div class="cmd-credit-val" style="font-size:18px">${fv(hvixPutNet)}</div>
        <div class="cmd-credit-range">~₹${hvixPutMid}/unit est.</div>
      </div>
    </div>
    <div style="margin:0 14px;background:rgba(0,127,95,0.06);border:1px solid rgba(0,127,95,0.2);border-radius:6px;padding:8px 12px;font-size:8.5px;color:var(--gn);line-height:1.6">
      ⚠️ <strong>High-VIX regime</strong> — puts priced ~${Math.round((vix/14-1)*100)}% above normal. Selling inflated put premium at OI support wall.
      <strong style="color:var(--text)"> 1 lot only.</strong> Do not scale up in panic conditions.
    </div>
    <div style="padding:12px 14px">
      <div style="font-size:8px;font-weight:700;letter-spacing:1px;color:var(--muted);text-transform:uppercase;margin-bottom:8px">LEGS</div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">
        <span style="font-size:9px;font-weight:700;color:var(--gn);width:40px">SELL</span>
        <span style="font-family:var(--font-mono);font-size:15px;font-weight:800">${f(hvixPutSell)} PE</span>
        ${mnBadge(hvixPutMn)}
        <span style="font-size:8px;color:var(--gn);margin-left:auto">collect premium</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span style="font-size:9px;font-weight:700;color:var(--muted);width:40px">BUY</span>
        <span style="font-family:var(--font-mono);font-size:15px;font-weight:800">${f(hvixPutBuy)} PE</span>
        ${mnBadge(hvixPutBuyMn)}
        <span style="font-size:8px;color:var(--muted);margin-left:auto">−200pt hedge</span>
      </div>
      <div style="font-size:8px;color:var(--am)">🎯 Short strike = Put OI wall — smart money stacked here as support</div>
    </div>
    <div class="cmd-stats">
      <div class="cmd-stat"><div class="cmd-stat-lbl">Max Profit</div><div class="cmd-stat-val" style="color:var(--gn)">${fv(hvixPutNet)}</div></div>
      <div class="cmd-stat"><div class="cmd-stat-lbl">Max Loss</div><div class="cmd-stat-val" style="color:var(--rd)">${fv(hvixPutMaxL)}</div></div>
      <div class="cmd-stat"><div class="cmd-stat-lbl">BEP</div><div class="cmd-stat-val" style="color:var(--am)">${f(Math.round(hvixPutBEP))}</div></div>
    </div>
    <div class="cmd-exits">
      <div class="cmd-exit profit"><div class="cmd-exit-lbl">✅ Take Profit</div><div class="cmd-exit-val" style="color:var(--gn)">${fv(hvixPutNet*0.50)}</div><div style="font-size:7.5px;color:var(--muted);margin-top:2px">50% of credit — exit early</div></div>
      <div class="cmd-exit loss"><div class="cmd-exit-lbl">🛑 Stop Loss</div><div class="cmd-exit-val" style="color:var(--rd)">${fv(hvixPutMaxL*0.50)}</div><div style="font-size:7.5px;color:var(--muted);margin-top:2px">Spot breaks below BEP</div></div>
    </div>
    <div style="padding:8px 14px;background:var(--bg3);font-size:8.5px;color:var(--muted);line-height:1.6">
      💡 Win if Nifty stays above <strong style="color:var(--gn)">${f(Math.round(hvixPutBEP))}</strong> by expiry · OI wall at ${f(hvixPutSell)} is support
      <br>⚠️ If spot breaks below ${f(hvixPutSell)} with volume — exit immediately. Don't fight the fall.
    </div>
  </div>`;

  // ══════════════════════════════════════════════════════════
  // MAIN RENDER
  // ══════════════════════════════════════════════════════════

  // Select primary card renderer
  const primaryCard = () => {
    switch(primaryStrat) {
      case 'IC':               return renderIC();
      case 'IRON_BUTTERFLY':   return renderIronButterfly(false);
      case 'BULL_PUT':         return renderBullPut(false);
      case 'BULL_CALL':        return renderBullCall(false);
      case 'BEAR_CALL':        return renderBearCall(false);
      case 'BEAR_PUT':         return renderBearPut(false);
      case 'STRADDLE':         return renderStraddle();
      case 'HVIX_BEAR_CALL':   return renderHVixBearCall();
      case 'HVIX_BULL_PUT':    return renderHVixBullPut();
      default: return '';
    }
  };

  // Select alternative card renderer (collapsed)
  const altCard = () => {
    if (!altStrat) return '';
    switch(altStrat) {
      case 'IC':               return renderIC();
      case 'IRON_BUTTERFLY':   return renderIronButterfly(true);
      case 'BULL_PUT':         return renderBullPut(true);
      case 'BULL_CALL':        return renderBullCall(true);
      case 'BEAR_CALL':        return renderBearCall(true);
      case 'BEAR_PUT':         return renderBearPut(true);
      case 'STRADDLE':         return renderStraddle();
      default: return '';
    }
  };

  const altLabel = () => {
    if (!altStrat) return '';
    const names = {IC:'Iron Condor', IRON_BUTTERFLY:'Iron Butterfly', BULL_PUT:'Bull Put Spread', BULL_CALL:'Bull Call Spread', BEAR_CALL:'Bear Call Spread', BEAR_PUT:'Bear Put Spread', STRADDLE:'Straddle/Strangle'};
    return names[altStrat] || altStrat;
  };

  // ── VIX comparison strip (v2.2.0) ─────────────────────────
  const radarVix  = gv('india_vix') || null;
  const stratVix  = gv('strat_vix') || null;
  const usingOverride = !!(stratVix && radarVix && stratVix !== radarVix);
  const vixGap    = (radarVix && stratVix) ? parseFloat((stratVix - radarVix).toFixed(2)) : null;
  const vixGapAbs = vixGap !== null ? Math.abs(vixGap) : 0;
  const vixShifted = vixGapAbs >= 1.5;
  const vixCompHtml = usingOverride ? `
  <div style="margin:8px 14px 0;background:${vixShifted?'rgba(200,33,62,0.06)':'rgba(0,110,150,0.06)'};border:1px solid ${vixShifted?'rgba(200,33,62,0.3)':'rgba(0,110,150,0.2)'};border-radius:var(--r);padding:10px 14px;">
    <div style="font-size:7px;font-weight:700;letter-spacing:1.5px;color:var(--muted);text-transform:uppercase;margin-bottom:8px;">VIX — MORNING VS NOW</div>
    <div style="display:flex;align-items:center;gap:6px;">
      <div style="text-align:center;flex:1;background:var(--bg3);border-radius:6px;padding:7px 0;">
        <div style="font-size:7px;color:var(--muted);margin-bottom:2px;">RADAR</div>
        <div style="font-family:var(--font-mono);font-size:17px;font-weight:700;color:var(--muted);">${radarVix}</div>
      </div>
      <div style="font-size:14px;color:var(--muted);">→</div>
      <div style="text-align:center;flex:1;background:var(--bg3);border-radius:6px;padding:7px 0;">
        <div style="font-size:7px;color:var(--tl);margin-bottom:2px;">LIVE</div>
        <div style="font-family:var(--font-mono);font-size:17px;font-weight:700;color:${vixShifted?'var(--rd)':'var(--tl)'};">${stratVix}</div>
      </div>
      <div style="text-align:center;flex:1;background:var(--bg3);border-radius:6px;padding:7px 0;">
        <div style="font-size:7px;color:var(--muted);margin-bottom:2px;">CHANGE</div>
        <div style="font-family:var(--font-mono);font-size:17px;font-weight:700;color:${vixShifted?(vixGap>0?'var(--rd)':'var(--gn)'):'var(--muted)'};">${vixGap>0?'+':''}${vixGap}</div>
      </div>
    </div>
    <div style="margin-top:7px;font-size:8.5px;color:${vixShifted?(vixGap>0?'var(--rd)':'var(--gn)'):'var(--muted)'};">
      ${vixShifted
        ? (vixGap>0
            ? '⚠️ VIX expanded +'+vixGapAbs.toFixed(1)+' pts — strike buffer widened. Credit may be lower than morning estimate.'
            : '✅ VIX compressed '+vixGapAbs.toFixed(1)+' pts — premiums cheaper. Debit spreads now better value.')
        : 'Change < 1.5 pts — conditions stable since morning.'}
    </div>
  </div>` : '';

  out.innerHTML = vixCompHtml + `

  <!-- GO/NO-GO Banner -->
  <div class="go-banner ${goState}">
    <div class="go-icon">${goIcon}</div>
    <div>
      <div class="go-status" style="color:${goState==='go'?'var(--gn)':goState==='caution'?'var(--am)':'var(--rd)'}">${goLabel}</div>
      <div class="go-reason">${goReason}</div>
    </div>
  </div>

  ${primaryStrat === 'AVOID' ? `
  <div style="margin:10px 14px 0;background:var(--bg2);border-radius:var(--r);padding:14px;border:1px solid var(--border)">
    <div style="font-size:10px;color:var(--muted);line-height:1.8">
      ${bestExp ? `📅 Next tradeable expiry: <strong style="color:var(--text)">${bestExp.label} (${bestExp.dte} DTE)</strong>` : ''}
      <br>⏰ Come back when conditions improve — check VERDICT tab for score trend.
      ${maxPainNote ? `<br>📍 ${maxPainNote}` : ''}
    </div>
  </div>
  ` : `
  ${primaryCard()}

  ${altStrat ? `
  <div class="alt-section" id="alt-strat-section" style="margin:8px 14px 0">
    <div class="alt-toggle" onclick="this.closest('.alt-section').classList.toggle('open')">
      <div class="alt-toggle-lbl">📋 Alternative: ${altLabel()}</div>
      <div class="alt-toggle-chevron">▼</div>
    </div>
    <div class="alt-body" style="padding-top:4px">${altCard()}</div>
  </div>
  ` : ''}
  `}

  <!-- VIX + Market Context strip -->
  <div style="margin:10px 14px 0;background:var(--bg2);border-radius:var(--r);padding:10px 14px;border:1px solid var(--border)">
    <div style="font-size:7.5px;font-weight:700;letter-spacing:1.5px;color:var(--muted);text-transform:uppercase;margin-bottom:8px">Market Context</div>
    <div class="vix-bar-row">
      <div class="vix-label" style="font-size:8.5px;font-weight:600;color:var(--text)">India VIX</div>
      <div class="vix-track"><div class="vix-fill" style="width:${vixPct}%;background:${vixColor}"></div></div>
      <div class="vix-val" style="color:${vixColor}">${vix}</div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:6px">
      <div style="background:var(--bg3);border-radius:5px;padding:6px 8px;text-align:center">
        <div style="font-size:7px;color:var(--muted);letter-spacing:0.5px">SCORE</div>
        <div style="font-family:var(--font-mono);font-size:13px;font-weight:700;color:${score>=0.25?'var(--gn)':score<=-0.25?'var(--rd)':'var(--am)'}">${score>=0?'+':''}${score.toFixed(2)}</div>
      </div>
      <div style="background:var(--bg3);border-radius:5px;padding:6px 8px;text-align:center">
        <div style="font-size:7px;color:var(--muted);letter-spacing:0.5px">DIRECTION</div>
        <div style="font-family:var(--font-mono);font-size:8px;font-weight:700;color:${isBull?'var(--gn)':isBear?'var(--rd)':'var(--am)'}">${dirCat.replace('_',' ')}</div>
      </div>
      <div style="background:var(--bg3);border-radius:5px;padding:6px 8px;text-align:center">
        <div style="font-size:7px;color:var(--muted);letter-spacing:0.5px">BEST DTE</div>
        <div style="font-family:var(--font-mono);font-size:13px;font-weight:700;color:${dteColor}">${bestExp ? bestExp.dte : '—'}</div>
      </div>
      <div style="background:var(--bg3);border-radius:5px;padding:6px 8px;text-align:center">
        <div style="font-size:7px;color:var(--muted);letter-spacing:0.5px">PCR</div>
        <div style="font-family:var(--font-mono);font-size:13px;font-weight:700;color:${pcr?pcr>=1.2?'var(--gn)':pcr>=0.85?'var(--am)':'var(--rd)':'var(--muted)'}">${pcr ? pcr.toFixed(2) : '—'}</div>
      </div>
    </div>
    ${maxPainNote ? `<div style="font-size:8.5px;color:var(--am);margin-top:6px">📍 ${maxPainNote}</div>` : ''}
  </div>

  <!-- BNF Viability -->
  <div class="bnf-viability ${bnfViz.cls}" style="margin-bottom:6px">
    <div class="bnf-v-hdr">
      <div class="bnf-v-icon">${bnfViz.icon}</div>
      <div>
        <div style="font-size:8px;font-weight:700;letter-spacing:1px;color:var(--muted);text-transform:uppercase;margin-bottom:1px">BNF VIABILITY</div>
        <div class="bnf-v-label">${bnfViz.label}</div>
      </div>
    </div>
    <div class="bnf-v-reason">${bnfViz.reasons.join('<br>')}</div>
    ${bnfViz.state !== 'avoid' && bnfPrice && bnfAtr ? buildBNFCommandCard(bnfViz.state, bnfPrice, bnfAtr, vix, score, bnfPcr, gv('bn_oi_call'), gv('bn_oi_put')) : ''}
  </div>

  <!-- Other expiries — collapsed -->
  <div class="alt-section" id="alt-section">
    <div class="alt-toggle" onclick="toggleAlt()">
      <div class="alt-toggle-lbl">📋 Other expiries & details</div>
      <div class="alt-toggle-chevron">▼</div>
    </div>
    <div class="alt-body">
      ${expiries.map((exp) => {
        if (exp.dte === (bestExp?.dte)) return '';
        const cB2  = bestStrike(price, atr, exp.dte, vix, true,  oiCall, pcr, true);
        const pB2  = bestStrike(price, atr, exp.dte, vix, false, oiPut,  pcr, true);
        const cBuy2 = r50(cB2.strike+width), pBuy2 = r50(pB2.strike-width);
        const pa2   = pcrPremAdj(pcr,exp.dte);
        const cr2   = estimateCredit(width,exp.dte,vix,true);
        const cD2   = (cB2.strike-price)/atr, pD2 = (price-pB2.strike)/atr;
        const cM2   = Math.min(r5(cr2.midCall*distFactorCall(cD2,exp.dte)/Math.max(pa2,1)),r5(width*0.68));
        const pM2   = Math.min(r5(cr2.mid*distFactor(pD2)*pa2),r5(width*0.68));
        const ic2   = (cM2+pM2)*NF_LOT_SIZE*cm.safeLots;
        const conv2 = dteConviction(exp.dte);
        const dteOk = exp.dte>=6 && exp.dte<=21;
        const cM2mn = moneyness(cB2.strike, price, true);
        const pM2mn = moneyness(pB2.strike, price, false);
        return `<div style="margin:4px 0;background:var(--bg2);border-radius:6px;border:1px solid var(--border);padding:10px 14px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <div><div style="font-family:var(--font-mono);font-size:14px;font-weight:700">${exp.label}</div>
              <div style="font-size:8px;color:var(--muted)">${exp.dte} DTE · ${exp.type}</div></div>
            <div style="text-align:right"><div style="font-size:8px;color:var(--muted)">Est IC</div>
              <div style="font-family:var(--font-mono);font-size:14px;font-weight:700;color:${dteOk?'var(--gn)':'var(--muted)'}">${fv(ic2)}</div></div>
          </div>
          <div style="font-size:8.5px;color:var(--muted)">
            Sell ${f(cB2.strike)} CE ${mnBadge(cM2mn)} / ${f(pB2.strike)} PE ${mnBadge(pM2mn)}<br>
            Buy  ${f(cBuy2)} CE / ${f(pBuy2)} PE
          </div>
          <div style="font-size:8px;margin-top:3px;color:${conv2.cls==='opt'?'var(--gn)':conv2.cls==='near'?'var(--rd)':'var(--am)'}">${conv2.label} — ${conv2.note}</div>
        </div>`;
      }).join('')}
    </div>
  </div>

  `;

  const oldNF = document.getElementById('nf-multi-output');
  if (oldNF) oldNF.innerHTML = '';
}

// v2.2.0: runAnalysis — called by ANALYSE button in Panel 3
// Stamps the analysis time, updates saveState, then renders
function runAnalysis() {
  ANALYSIS_VIX = gv('strat_vix') || gv('india_vix') || 14;
  // Timestamp the analysis
  const now = new Date();
  const ts  = now.toLocaleTimeString('en-IN', {hour:'2-digit', minute:'2-digit', hour12:true, timeZone:'Asia/Kolkata'});
  const el  = document.getElementById('strat-analysed-ts');
  if (el) el.textContent = 'Last analysed: ' + ts + ' IST';
  saveState();
  buildCommand();
  // Scroll to output
  const out = document.getElementById('cmd-output');
  if (out) setTimeout(() => out.scrollIntoView({behavior:'smooth', block:'start'}), 100);
}


function toggleAlt() {
  const sec = document.getElementById('alt-section');
  if (sec) sec.classList.toggle('open');
}

// BNF command card — compact version shown inside BNF viability block
function buildBNFCommandCard(state, price, atr, vix, score, pcr, oiCall, oiPut) {
  const width = 400;
  const BNF_LOT = 30;
  const bestExp  = pickBestExpiry(expiries);
  if (!bestExp) return '';

  const callBest = bestStrike(price, atr, bestExp.dte, vix, true,  oiCall, pcr, false);
  const putBest  = bestStrike(price, atr, bestExp.dte, vix, false, oiPut,  pcr, false);
  const callBuy  = r100(callBest.strike + width);
  const putBuy   = r100(putBest.strike  - width);

  const callDist = (callBest.strike - price) / atr;
  const putDist  = (price - putBest.strike) / atr;
  const pa       = pcrPremAdj(pcr, bestExp.dte);
  const crBase   = estimateCredit(width, bestExp.dte, vix, false);
  const callMid  = Math.min(r5(crBase.midCall * distFactorCall(callDist, bestExp.dte) / Math.max(pa,1)), r5(width*0.68));
  const putMid   = Math.min(r5(crBase.mid     * distFactor(putDist) * pa),                               r5(width*0.68));
  const icUnit   = callMid + putMid;
  const bnfCm    = capitalMetrics(icUnit, width, BNF_LOT, BNF_MARGIN_PER_LOT);

  const f  = n => Math.round(n).toLocaleString('en-IN');
  const fv = n => '₹' + f(n);

  return `
  <div style="margin-top:10px;background:var(--bg1);border-radius:6px;padding:10px 12px;border:1px solid var(--border)">
    <div style="font-size:8px;font-weight:700;letter-spacing:1px;color:var(--muted);margin-bottom:6px">BNF IRON CONDOR · ${bestExp.label} (${bestExp.dte} DTE) · ${bnfCm.safeLots} lot × ${BNF_LOT}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:9px">
      <div>
        <div style="color:var(--rd);font-weight:700">🔴 ${f(callBest.strike)}/${f(callBuy)} CE</div>
        <div style="color:var(--gn);font-weight:700">🟢 ${f(putBest.strike)}/${f(putBuy)} PE</div>
        <div style="font-size:8px;color:var(--muted);margin-top:4px">Margin ₹${f(bnfCm.marginUsed)} · SL risk ${bnfCm.slPct.toFixed(1)}%${bnfCm.riskFlag?' ⚠️':''}</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:8px;color:var(--muted)">Est IC</div>
        <div style="font-family:var(--font-mono);font-size:16px;font-weight:800;color:var(--gn)">${fv(icUnit * BNF_LOT * bnfCm.safeLots)}</div>
        <div style="font-size:7.5px;color:var(--am)">Lower confidence</div>
      </div>
    </div>
    <div style="font-size:7.5px;color:var(--am);margin-top:6px">⚠️ BNF has 13 stocks — higher event risk. Trade only on confirmed range-bound days.</div>
  </div>`;
}

// ── Keep legacy wrapper so old code paths don't break ──────────
function buildMultiExpiry(idx) { buildCommand(); }
function buildStrategy(idx)    { buildCommand(); }


function buildExpiryCard(expiry, price, atr, lot, lots, vix, width, score, oiCall, oiPut, idx, pcr){
  const {label, dte, type, shifted} = expiry;
  const conv  = dteConviction(dte);
  const isNF  = idx==='NF';
  const isBull=score>=0.4, isBear=score<=-0.4, isNeutral=!isBull&&!isBear;

  const callBest = bestStrike(price, atr, dte, vix, true,  oiCall, pcr, isNF);
  const putBest  = bestStrike(price, atr, dte, vix, false, oiPut,  pcr, isNF);
  const callBuy  = isNF ? r50(callBest.strike + width) : r100(callBest.strike + width);
  const putBuy   = isNF ? r50(putBest.strike  - width) : r100(putBest.strike  - width);

  const callDist = (callBest.strike-price)/atr;
  const putDist  = (price-putBest.strike)/atr;
  const pa       = pcrPremAdj(pcr, dte);

  // v2.2.1: moneyness labels for all four strikes
  const callSellMn = moneyness(callBest.strike, price, true);
  const callBuyMn  = moneyness(callBuy,         price, true);
  const putSellMn  = moneyness(putBest.strike,  price, false);
  const putBuyMn   = moneyness(putBuy,          price, false);

  const crBase  = estimateCredit(width, dte, vix, isNF);
  // v1.7.0: call uses crBase.midCall (BNF-specific or NF-specific mults) + DTE-aware distFactorCall
  const callMid = Math.min(r5(crBase.midCall * distFactorCall(callDist, dte) / Math.max(pa,1)), r5(width*0.68));
  const putMid  = Math.min(r5(crBase.mid     * distFactor(putDist)           * pa),             r5(width*0.68));
  const callMin = r5(callMid*0.80), callMax = r5(callMid*1.22);
  const putMin  = r5(putMid*0.80),  putMax  = r5(putMid*1.22);

  const callMaxP = callMid*lot*lots, callMaxL = (width-callMid)*lot*lots;
  const putMaxP  = putMid*lot*lots,  putMaxL  = (width-putMid)*lot*lots;

  // FIX 1: R:R always valid since credit ≤ 68% of width
  const callRR = callMid>0 ? (width-callMid)/callMid : 99;
  const putRR  = putMid>0  ? (width-putMid)/putMid   : 99;

  // FIX 3: Win prob uses actual distance
  const callWP = winProb(dte, callDist);
  const putWP  = winProb(dte, putDist);
  const callSt = starRating(callRR, callWP);
  const putSt  = starRating(putRR,  putWP);

  const icTotal = (callMid+putMid)*lot*lots;
  const icMaxL  = Math.max(callMaxL, putMaxL);
  const sd      = estimateStraddle(price, dte, vix);
  const sdTotal = sd.unit*lot*lots;

  const callPrimary = isBear||isNeutral;
  const putPrimary  = isBull||isNeutral;
  const convColor   = conv.cls==='near'?'var(--rd)':conv.cls==='opt'?'var(--gn)':conv.cls==='mid'?'var(--am)':'var(--tl)';
  const f  = n => Math.round(n).toLocaleString('en-IN');
  const fv = n => '₹'+f(n);
  const shiftNote = shifted ? ` <span style="color:var(--am);font-size:7.5px">⚠️ Holiday shifted</span>` : '';

  return `
  <div class="expiry-card" id="ec-${idx}-${dte}">
    <div class="ec-hdr" onclick="toggleExpiry('ec-${idx}-${dte}')">
      <div style="display:flex;align-items:center;gap:10px">
        <div>
          <div style="font-size:14px;font-weight:800;color:var(--text);font-family:var(--font-mono)">${label}${shiftNote}</div>
          <div style="font-size:8px;color:var(--muted);margin-top:1px">${type} · ${dte} DTE${pcr?` · PCR ${pcr.toFixed(2)}`:''}${dte>30?' · Std ATR (no PCR adj)':''}</div>
        </div>
        <span class="tag" style="background:${convColor}22;color:${convColor};border:1px solid ${convColor}44">${conv.label}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <div style="text-align:right">
          <div style="font-size:8px;color:var(--muted)">IC CREDIT</div>
          <div style="font-family:var(--font-mono);font-size:11px;font-weight:700;color:var(--gn)">${fv(icTotal)}</div>
        </div>
        <div class="ec-chevron">▼</div>
      </div>
    </div>

    <div class="ec-body">
      <div class="ec-note">${conv.note}</div>
      ${dte<=5?`<div style="background:#ff3b3022;border:1px solid var(--rd);border-radius:6px;margin:0 14px 10px;padding:10px 12px;font-size:9px;color:var(--rd);font-weight:700;letter-spacing:0.5px">🚫 EXPIRY WEEK — DO NOT OPEN NEW POSITIONS<br><span style="font-weight:400;color:var(--muted)">Real premiums ₹5–₹30 at DTE ≤5. Estimates shown below are illustrative only. Use this card to CLOSE or ADJUST existing spreads.</span></div>`:''}
      ${!isNF?`<div style="background:#8b5cf622;border:1px solid #8b5cf6;border-radius:6px;margin:0 14px 10px;padding:8px 12px;font-size:8px;color:#a78bfa;font-weight:600;letter-spacing:0.3px">📊 BANK NIFTY — CALIBRATED FROM 3-MONTH DATA (n=3 expiries)<br><span style="font-weight:400;color:var(--muted)">BNF multipliers use real NSE premiums Nov 2025–Feb 2026. Win rate statistics need 6+ months for statistical validity. Use IC win% as directional guide only.</span></div>`:''}

      <!-- CALL SIDE -->
      <div class="ec-section-hdr">
        <div style="display:flex;align-items:center;gap:6px">
          <div style="width:3px;height:14px;background:var(--rd);border-radius:2px"></div>
          <div>
            <div style="font-size:9px;font-weight:700;color:var(--rd)">BEAR CALL SPREAD</div>
            <div style="font-size:8px;color:var(--muted)">Sell ${f(callBest.strike)} CE ${mnBadge(callSellMn)} / Buy ${f(callBuy)} CE ${mnBadge(callBuyMn)}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          ${callPrimary?'<span class="tag dn">✅ PRIMARY</span>':'<span class="tag fl">REFERENCE</span>'}
          <span style="font-size:11px">${'⭐'.repeat(callSt)}${'☆'.repeat(5-callSt)}</span>
        </div>
      </div>
      <div style="font-size:8px;color:${callBest.isOI?'var(--am)':'var(--muted)'};padding:2px 14px 6px">
        ${callBest.isOI?'🎯 ':''}${callBest.reason} · dist ${callDist.toFixed(2)}×ATR
      </div>
      <div class="mini-grid">
        <div class="mg-item"><div class="mg-lbl">CREDIT/UNIT</div><div class="mg-val gn">₹${callMin}–${callMax}</div></div>
        <div class="mg-item"><div class="mg-lbl">MAX PROFIT</div><div class="mg-val gn">${fv(callMaxP)}</div></div>
        <div class="mg-item"><div class="mg-lbl">MAX LOSS</div><div class="mg-val rd">${fv(callMaxL)}</div></div>
        <div class="mg-item"><div class="mg-lbl">R:R · WIN%</div><div class="mg-val am">${callRR.toFixed(1)} · ${callWP}%</div></div>
      </div>
      <div class="exit-row">
        <div class="exit-item"><span style="color:var(--gn)">✅ Exit</span> ${fv(callMaxP*0.4)}</div>
        <div class="exit-item"><span style="color:var(--rd)">🛑 SL</span> ${fv(callMaxP*0.8)}</div>
      </div>

      <!-- PUT SIDE -->
      <div class="ec-section-hdr" style="margin-top:10px">
        <div style="display:flex;align-items:center;gap:6px">
          <div style="width:3px;height:14px;background:var(--gn);border-radius:2px"></div>
          <div>
            <div style="font-size:9px;font-weight:700;color:var(--gn)">BULL PUT SPREAD</div>
            <div style="font-size:8px;color:var(--muted)">Sell ${f(putBest.strike)} PE ${mnBadge(putSellMn)} / Buy ${f(putBuy)} PE ${mnBadge(putBuyMn)}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          ${putPrimary?'<span class="tag up">✅ PRIMARY</span>':'<span class="tag fl">REFERENCE</span>'}
          <span style="font-size:11px">${'⭐'.repeat(putSt)}${'☆'.repeat(5-putSt)}</span>
        </div>
      </div>
      <div style="font-size:8px;color:${putBest.isOI?'var(--am)':'var(--muted)'};padding:2px 14px 6px">
        ${putBest.isOI?'🎯 ':''}${putBest.reason} · dist ${putDist.toFixed(2)}×ATR
      </div>
      <div class="mini-grid">
        <div class="mg-item"><div class="mg-lbl">CREDIT/UNIT</div><div class="mg-val gn">₹${putMin}–${putMax}</div></div>
        <div class="mg-item"><div class="mg-lbl">MAX PROFIT</div><div class="mg-val gn">${fv(putMaxP)}</div></div>
        <div class="mg-item"><div class="mg-lbl">MAX LOSS</div><div class="mg-val rd">${fv(putMaxL)}</div></div>
        <div class="mg-item"><div class="mg-lbl">R:R · WIN%</div><div class="mg-val am">${putRR.toFixed(1)} · ${putWP}%</div></div>
      </div>
      <div class="exit-row">
        <div class="exit-item"><span style="color:var(--gn)">✅ Exit</span> ${fv(putMaxP*0.4)}</div>
        <div class="exit-item"><span style="color:var(--rd)">🛑 SL</span> ${fv(putMaxP*0.8)}</div>
      </div>

      <!-- IRON CONDOR -->
      <div class="ec-section-hdr" style="margin-top:10px">
        <div style="display:flex;align-items:center;gap:6px">
          <div style="width:3px;height:14px;background:var(--am);border-radius:2px"></div>
          <div>
            <div style="font-size:9px;font-weight:700;color:var(--am)">IRON CONDOR (BOTH LEGS)</div>
            <div style="font-size:8px;color:var(--muted)">${f(putBest.strike)}/${f(putBuy)} PE + ${f(callBest.strike)}/${f(callBuy)} CE</div>
          </div>
        </div>
        ${isNeutral?'<span class="tag am">✅ IDEAL</span>':''}
      </div>
      <div class="mini-grid">
        <div class="mg-item"><div class="mg-lbl">TOTAL CREDIT</div><div class="mg-val gn">${fv(icTotal)}</div></div>
        <div class="mg-item"><div class="mg-lbl">MAX LOSS</div><div class="mg-val rd">${fv(icMaxL)}</div></div>
        <div class="mg-item"><div class="mg-lbl">EXIT PROFIT</div><div class="mg-val am">${fv(icTotal*0.40)}</div></div>
        <div class="mg-item"><div class="mg-lbl">STOP LOSS</div><div class="mg-val am">${fv(icTotal*0.80)}</div></div>
      </div>
      ${(()=>{
        // v1.5.0: ±5% stress test — shows outcome if spot makes a 5% move by expiry
        const spotDown5 = price * 0.95;
        const spotUp5   = price * 1.05;
        const putBreached  = spotDown5 < putBest.strike;
        const callBreached = spotUp5   > callBest.strike;
        const putStressLoss  = putBreached  ? fv(putMaxL)  : '✅ Safe';
        const callStressLoss = callBreached ? fv(callMaxL) : '✅ Safe';
        const putStressCol   = putBreached  ? 'var(--rd)'  : 'var(--gn)';
        const callStressCol  = callBreached ? 'var(--rd)'  : 'var(--gn)';
        return `<div style="margin:8px 14px 0;background:var(--bg3);border-radius:6px;padding:8px 10px">
          <div style="font-size:7.5px;letter-spacing:1px;color:var(--muted);margin-bottom:5px">±5% STRESS TEST — IF SPOT MAKES BIG MOVE BY EXPIRY</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
            <div><div style="font-size:7.5px;color:var(--muted)">Spot −5% → ${Math.round(spotDown5).toLocaleString('en-IN')}</div><div style="font-size:10px;font-weight:700;color:${putStressCol}">${putStressLoss}</div><div style="font-size:7.5px;color:var(--muted)">${putBreached?'Put side breached':'Put side intact'}</div></div>
            <div><div style="font-size:7.5px;color:var(--muted)">Spot +5% → ${Math.round(spotUp5).toLocaleString('en-IN')}</div><div style="font-size:10px;font-weight:700;color:${callStressCol}">${callStressLoss}</div><div style="font-size:7.5px;color:var(--muted)">${callBreached?'Call side breached':'Call side intact'}</div></div>
          </div>
        </div>`;
      })()}
      ${isBull?'<div class="ec-bias-note gn">📊 Bullish bias — put leg safer. Widen call side for extra buffer.</div>':isBear?'<div class="ec-bias-note rd">📊 Bearish bias — call leg safer. Widen put side for extra buffer.</div>':'<div class="ec-bias-note am">📊 Neutral — both legs equally valid for Iron Condor.</div>'}

      ${(isNeutral && vix<16)?`
      <!-- STRADDLE (neutral + low VIX) -->
      <div class="ec-section-hdr" style="margin-top:10px">
        <div style="display:flex;align-items:center;gap:6px">
          <div style="width:3px;height:14px;background:var(--pu);border-radius:2px"></div>
          <div>
            <div style="font-size:9px;font-weight:700;color:var(--pu)">LONG STRADDLE (LOW VIX)</div>
            <div style="font-size:8px;color:var(--muted)">Buy ${r5(price).toLocaleString('en-IN')} CE + ${r5(price).toLocaleString('en-IN')} PE</div>
          </div>
        </div>
        <span class="tag pu">VIX ${vix}</span>
      </div>
      <div class="mini-grid">
        <div class="mg-item"><div class="mg-lbl">COST/UNIT</div><div class="mg-val am">₹${sd.min}–${sd.max}</div></div>
        <div class="mg-item"><div class="mg-lbl">TOTAL COST</div><div class="mg-val am">${fv(sdTotal)}</div></div>
        <div class="mg-item"><div class="mg-lbl">BEP UP</div><div class="mg-val gn">${(r5(price)+sd.unit).toLocaleString('en-IN')}</div></div>
        <div class="mg-item"><div class="mg-lbl">BEP DOWN</div><div class="mg-val gn">${(r5(price)-sd.unit).toLocaleString('en-IN')}</div></div>
      </div>`:''}

    </div>
  </div>`;
}

// ── Legacy expiry card still available for alt-section use ────

function toggleExpiry(id){
  document.getElementById(id)?.classList.toggle('open');
}

// ── Tab navigation ─────────────────────────────────────────────
function go(n){
  document.querySelectorAll('.tab').forEach((t,i)=>t.classList.toggle('on',i===n));
  document.querySelectorAll('.panel').forEach((p,i)=>p.classList.toggle('on',i===n));
  if(n===2) calcScore();
  if(n===3) updateEntrySignal();
  if(n===4) checkLocks();
  if(n===5){ dbShowStatus(); loadTradeHistory(); }
}

function switchStrat(n){
  document.querySelectorAll('.strat-tab').forEach((t,i)=>t.classList.toggle('on',i===n));
  document.querySelectorAll('.strat-page').forEach((p,i)=>p.classList.toggle('on',i===n));
}

// ── Save / Lock / Edit ─────────────────────────────────────────
function saveRadar(){
  const radarFlds=['sp500','dow','usvix','nk','hsi','crude','gold','inr','yld',
    'gift_now','nifty_prev','gift_6am','india_vix','fii','fii_fut','fii_opt','dii',
    'max_pain_nf','max_pain_bn','close_char'];
  const data={};
  radarFlds.forEach(f=>{ const e=document.getElementById(f); if(e&&e.value!=='') data[f]=e.value; stampField(f); });
  try{
    data._savedDate = new Date().toDateString();
    localStorage.setItem('mr140-radar',JSON.stringify(data));
    localStorage.setItem('mr140-prevscore',JSON.stringify({score:SCORE,dir:DIRECTION,ts:Date.now()}));
    RADAR_LOCKED=true;
    setDisabled(radarFlds,true);
    document.getElementById('btn-save-radar').style.display='none';
    document.getElementById('btn-edit-radar').style.display='inline-flex';
    document.getElementById('radar-status').textContent='Saved ✅';
    toast('💾 Radar saved & locked');
    // ── v3.0: also persist to Supabase ──
    if(typeof dbSaveRadar === 'function'){
      dbSaveRadar({
        ...data,
        score: SCORE,
        direction: DIRECTION,
        strat_auto: STRAT_AUTO,
        rbi:  document.querySelector('input[name="rbi"]:checked')?.value||'neutral',
        liq:  document.querySelector('input[name="liq"]:checked')?.value||'neutral',
        news: document.querySelector('input[name="news"]:checked')?.value||'none',
      }).then(r=>{ if(!r.ok) console.warn('[db] saveRadar error:', r.error); });
    }
  }catch{ toast('❌ Save failed'); }
}

function editRadar(){
  RADAR_LOCKED=false;
  const radarFlds=['sp500','dow','usvix','nk','hsi','crude','gold','inr','yld',
    'gift_now','nifty_prev','gift_6am','india_vix','fii','fii_fut','fii_opt','dii',
    'max_pain_nf','max_pain_bn','close_char'];
  setDisabled(radarFlds,false);
  document.getElementById('btn-save-radar').style.display='inline-flex';
  document.getElementById('btn-edit-radar').style.display='none';
  document.getElementById('radar-status').textContent='Edit mode — re-save when done';
  toast('✏️ Edit mode');
}

function saveBreadth(){
  const flds=['n50adv','n50dma','bnfadv'];
  const data={};
  flds.forEach(f=>{ const e=document.getElementById(f); if(e) data[f]=e.value; stampField(f); });
  try{
    localStorage.setItem('mr140-breadth',JSON.stringify(data));
    BREADTH_LOCKED=true;
    setDisabled(flds,true);
    document.getElementById('btn-save-breadth').style.display='none';
    document.getElementById('btn-edit-breadth').style.display='inline-flex';
    toast('💾 Breadth saved');
  }catch{ toast('❌ Save failed'); }
}

function editBreadth(){
  BREADTH_LOCKED=false;
  const flds=['n50adv','n50dma','bnfadv'];
  setDisabled(flds,false);
  document.getElementById('btn-save-breadth').style.display='inline-flex';
  document.getElementById('btn-edit-breadth').style.display='none';
  toast('✏️ Edit mode');
}

function saveEvening(){
  const flds=['ev_sp500','ev_dow','ev_usvix','ev_nk','ev_hsi','ev_crude','ev_gold','ev_inr',
    'ev_indiavix','ev_fii','ev_fii_opt','ev_pcr_nf','ev_pcr_bn','ev_nifty','ev_bnf','ev_n50adv','ev_bnfadv','ev_mpnf','ev_mpbn'];
  const data={};
  flds.forEach(f=>{ const e=document.getElementById(f); if(e) data[f]=e.value; stampField(f); });
  try{
    localStorage.setItem('mr140-evening',JSON.stringify(data));
    EVENING_LOCKED=true;
    setDisabled(flds,true);
    document.getElementById('btn-save-evening').style.display='none';
    document.getElementById('btn-edit-evening').style.display='inline-flex';
    if(document.getElementById('btn-lock-bottom')) document.getElementById('btn-lock-bottom').style.display='none';

    // ── v2.2.1: Auto-compute close character from evening data ──
    // Uses advances (primary) + FII cash (adjustment) → stored for
    // tomorrow's Radar tab pre-fill. Never overwrites if Radar already locked.
    const adv = parseFloat(document.getElementById('ev_n50adv')?.value);
    const fii = parseFloat(document.getElementById('ev_fii')?.value) || 0;
    if (!isNaN(adv)) {
      // Advances score: 50-stock index breadth
      const advScore = adv >= 38 ? 2 : adv >= 28 ? 1 : adv >= 20 ? 0 : adv >= 12 ? -1 : -2;
      // FII adjustment: large institutional flow shifts by 0.5
      const fiiAdj   = fii >= 1000 ? 0.5 : fii >= 200 ? 0.25 : fii <= -1000 ? -0.5 : fii <= -200 ? -0.25 : 0;
      const autoCC   = Math.round(Math.max(-2, Math.min(2, advScore + fiiAdj)));
      localStorage.setItem('mr140-autoclosechar', JSON.stringify({
        val: autoCC,
        adv, fii,
        lockedAt: Date.now()
      }));
    }

    toast('🔒 Evening data locked — delta ready for tomorrow');
  }catch{ toast('❌ Save failed'); }
}

function editEvening(){
  EVENING_LOCKED=false;
  const flds=['ev_sp500','ev_dow','ev_usvix','ev_nk','ev_hsi','ev_crude','ev_gold','ev_inr',
    'ev_indiavix','ev_fii','ev_fii_opt','ev_pcr_nf','ev_pcr_bn','ev_nifty','ev_bnf','ev_n50adv','ev_bnfadv','ev_mpnf','ev_mpbn'];
  setDisabled(flds,false);
  document.getElementById('btn-save-evening').style.display='inline-flex';
  document.getElementById('btn-edit-evening').style.display='none';
  if(document.getElementById('btn-lock-bottom')) document.getElementById('btn-lock-bottom').style.display='flex';
  toast('✏️ Edit mode');
}

function saveChecklist(){
  const rbi=document.querySelector('input[name="rbi"]:checked')?.value||'neutral';
  const liq=document.querySelector('input[name="liq"]:checked')?.value||'neutral';
  const news=document.querySelector('input[name="news"]:checked')?.value||'none';
  try{ localStorage.setItem('mr140-checklist',JSON.stringify({rbi,liq,news})); }catch{}
  ['hawkish','neutral','dovish'].forEach(v=>document.getElementById('rbi-'+v)?.classList.toggle('checked',v===rbi));
  ['deficit','neutral','surplus'].forEach(v=>document.getElementById('liq-'+v)?.classList.toggle('checked',v===liq));
  ['none','hdfc','icici','both'].forEach(v=>document.getElementById('news-'+v)?.classList.toggle('checked',v===news));
}

function loadChecklist(){
  try{
    const d=JSON.parse(localStorage.getItem('mr140-checklist')||'null');
    if(!d) return;
    const r=document.querySelector(`input[name="rbi"][value="${d.rbi}"]`);
    const l=document.querySelector(`input[name="liq"][value="${d.liq}"]`);
    const n=document.querySelector(`input[name="news"][value="${d.news}"]`);
    if(r) r.checked=true; if(l) l.checked=true; if(n) n.checked=true;
    saveChecklist();
  }catch{}
}

// ── State persistence ──────────────────────────────────────────
function saveState(){
  // v2.2.1: close_char intentionally excluded — it is managed exclusively
  // by saveRadar() (when locked) and auto-fill from evening data (fresh morning).
  // Including it here caused the auto-fill to be overwritten on every keystroke.
  const allFlds=['sp500','dow','usvix','nk','hsi','crude','gold','inr','yld',
    'gift_now','nifty_prev','gift_6am','india_vix','fii','fii_fut','fii_opt','dii',
    'max_pain_nf','max_pain_bn','n50adv','n50dma','bnfadv',
    'nf_price','nf_atr','pcr_nf','nf_lot','nf_lots','nf_oi_call','nf_oi_put','nf_maxpain','event_flag','strat_vix',
    'bn_price','bn_atr','pcr_bn','bn_lot','bn_lots','bn_oi_call','bn_oi_put','bn_maxpain'];
  const s={};
  allFlds.forEach(f=>{ const e=document.getElementById(f); if(e) s[f]=e.value; });
  try{ localStorage.setItem('mr140-state',JSON.stringify(s)); }catch{}
}

function loadState(){
  try{
    const s=JSON.parse(localStorage.getItem('mr140-state')||'{}');
    Object.keys(s).forEach(f=>{ const e=document.getElementById(f); if(e&&s[f]!=='undefined') e.value=s[f]; });
  }catch{}

  const radarFlds=['sp500','dow','usvix','nk','hsi','crude','gold','inr','yld',
    'gift_now','nifty_prev','gift_6am','india_vix','fii','fii_fut','fii_opt','dii','max_pain_nf','max_pain_bn','close_char'];

  const radarRaw = localStorage.getItem('mr140-radar');
  const radarData = radarRaw ? JSON.parse(radarRaw) : null;

  // v2.2.1: Check if radar save is from TODAY or a previous day
  const savedDate   = radarData?._savedDate || null;
  const todayDate   = new Date().toDateString();
  const isSameDay   = savedDate === todayDate;

  if(radarData && isSameDay){
    // Same day — restore locked state as normal
    // Populate fields from radar save (authoritative source)
    radarFlds.forEach(f=>{ const e=document.getElementById(f); if(e&&radarData[f]!=null) e.value=radarData[f]; });
    RADAR_LOCKED=true;
    setDisabled(radarFlds,true);
    document.getElementById('btn-save-radar').style.display='none';
    document.getElementById('btn-edit-radar').style.display='inline-flex';
    document.getElementById('radar-status').textContent='Saved ✅ (from this morning)';

  } else {
    // Different day OR no radar save — fresh morning session
    // Clear stale radar lock so user enters today's data fresh
    if(radarData && !isSameDay){
      localStorage.removeItem('mr140-radar');
      // Also clear stale breadth lock — it's a new day
      localStorage.removeItem('mr140-breadth');
    }

    // v2.2.1: Auto-fill close_char from last evening lock
    // This is the ONLY place close_char gets set on a fresh morning.
    // It is excluded from saveState() so nothing can overwrite it.
    try{
      const acc = JSON.parse(localStorage.getItem('mr140-autoclosechar')||'null');
      if(acc && typeof acc.val === 'number'){
        const el = document.getElementById('close_char');
        if(el){
          el.value = String(acc.val);
          const labels = {'2':'Strong ↑↑','1':'Mild ↑','0':'Neutral','-1':'Mild ↓','-2':'Weak ↓↓'};
          const note = document.getElementById('ts-close_char');
          if(note){
            note.textContent = `Auto: ${labels[String(acc.val)]||acc.val} · ${acc.adv} adv, FII ${acc.fii>=0?'+':''}${acc.fii}Cr`;
            note.className='ts fresh';
          }
        }
      }
    }catch{}
  }

  const breadth=localStorage.getItem('mr140-breadth');
  if(breadth){
    BREADTH_LOCKED=true;
    setDisabled(['n50adv','n50dma','bnfadv'],true);
    document.getElementById('btn-save-breadth').style.display='none';
    document.getElementById('btn-edit-breadth').style.display='inline-flex';
  }
}

// ── Trade Journal — v3.0 Supabase-backed ───────────────────────
async function logTradeNow(){
  const strat   = document.getElementById('tj-strat')?.value;
  const expiryRaw = document.getElementById('tj-expiry')?.value?.trim();
  const l1s     = parseFloat(document.getElementById('tj-l1-strike')?.value);
  const l1e     = parseFloat(document.getElementById('tj-l1-entry')?.value);
  const l2s     = parseFloat(document.getElementById('tj-l2-strike')?.value);
  const l2e     = parseFloat(document.getElementById('tj-l2-entry')?.value);
  const lots    = parseInt(document.getElementById('tj-lots')?.value)||1;
  const spot    = parseFloat(document.getElementById('tj-spot')?.value)||null;
  const notes   = document.getElementById('tj-notes')?.value?.trim()||null;
  const res     = document.getElementById('tj-result');

  if(!strat||!expiryRaw||isNaN(l1s)||isNaN(l1e)){
    if(res) res.innerHTML='<span style="color:var(--rd)">⚠️ Strategy, Expiry, Leg 1 Strike & Entry are required</span>';
    return;
  }

  // Parse expiry to YYYY-MM-DD
  const months={'Jan':1,'Feb':2,'Mar':3,'Apr':4,'May':5,'Jun':6,'Jul':7,'Aug':8,'Sep':9,'Oct':10,'Nov':11,'Dec':12};
  let expiry_date = null;
  const m = expiryRaw.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if(m) expiry_date = `${m[3]}-${String(months[m[2]]||1).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
  if(!expiry_date){ if(res) res.innerHTML='<span style="color:var(--rd)">⚠️ Expiry format: 17 Mar 2026</span>'; return; }

  // Determine leg types based on strategy
  const legTypes = {
    BEAR_PUT:  [{t:'PE',a:'BUY'},{t:'PE',a:'SELL'}],
    BEAR_CALL: [{t:'CE',a:'SELL'},{t:'CE',a:'BUY'}],
    BULL_PUT:  [{t:'PE',a:'SELL'},{t:'PE',a:'BUY'}],
    BULL_CALL: [{t:'CE',a:'BUY'},{t:'CE',a:'SELL'}],
    IC:        [{t:'CE',a:'SELL'},{t:'CE',a:'BUY'},{t:'PE',a:'SELL'},{t:'PE',a:'BUY'}],
    STRADDLE:  [{t:'CE',a:'BUY'},{t:'PE',a:'BUY'}],
    STRANGLE:  [{t:'CE',a:'BUY'},{t:'PE',a:'BUY'}],
  };
  const legs = legTypes[strat]||[{t:'CE',a:'BUY'}];

  const tradeData = {
    strategy:      strat,
    expiry_date:   expiry_date,
    leg1_type:     legs[0]?.t||null,
    leg1_action:   legs[0]?.a||null,
    leg1_strike:   l1s,
    leg1_entry:    l1e,
    leg2_type:     !isNaN(l2s)?(legs[1]?.t||null):null,
    leg2_action:   !isNaN(l2s)?(legs[1]?.a||null):null,
    leg2_strike:   !isNaN(l2s)?l2s:null,
    leg2_entry:    !isNaN(l2e)?l2e:null,
    lots:          lots,
    lot_size:      65,
    net_credit:    (!isNaN(l1e)&&!isNaN(l2e)) ? (l2e - l1e) : null,
    spot_at_entry: spot,
    vix_at_entry:  gv('india_vix')||gv('strat_vix')||null,
    score_at_entry: SCORE||null,
    notes:         notes,
  };

  if(res) res.innerHTML='<span style="color:var(--am)">⏳ Saving...</span>';

  if(typeof dbLogTrade === 'function'){
    const r = await dbLogTrade(tradeData);
    if(r.ok){
      if(res) res.innerHTML=`<span style="color:var(--gn)">✅ Trade #${r.id} logged to database</span>`;
      toast('📝 Trade logged!');
      // Clear form
      ['tj-l1-strike','tj-l1-entry','tj-l2-strike','tj-l2-entry','tj-spot','tj-notes'].forEach(id=>{
        const e=document.getElementById(id); if(e) e.value='';
      });
      setTimeout(loadTradeHistory, 800);
    } else {
      if(res) res.innerHTML=`<span style="color:var(--rd)">❌ ${r.error}</span>`;
    }
  } else {
    if(res) res.innerHTML='<span style="color:var(--rd)">❌ DB not loaded</span>';
  }
}

async function loadTradeHistory(){
  const el = document.getElementById('trade-history');
  if(!el) return;
  el.innerHTML='<div style="font-size:9px;color:var(--muted);padding:8px 0">⏳ Loading...</div>';
  if(typeof dbGetTrades !== 'function'){
    el.innerHTML='<div style="font-size:9px;color:var(--muted)">DB not available</div>'; return;
  }
  const { ok, trades, error } = await dbGetTrades(30);
  if(!ok){
    el.innerHTML=`<div style="font-size:9px;color:var(--rd)">${error||'Load failed'}</div>`; return;
  }
  if(!trades.length){
    el.innerHTML='<div style="font-size:9px;color:var(--muted);padding:8px 0">No trades yet. Log your first trade above.</div>'; return;
  }
  const stratColors={IC:'var(--tl)',BEAR_PUT:'var(--rd)',BEAR_CALL:'var(--rd)',BULL_PUT:'var(--gn)',BULL_CALL:'var(--gn)',STRADDLE:'var(--pu)',STRANGLE:'var(--pu)'};
  const rows = trades.map(t=>{
    const col = stratColors[t.strategy]||'var(--muted)';
    const status = t.status==='OPEN'
      ? '<span style="font-size:7px;font-weight:700;color:var(--am);background:var(--am-bg);border:1px solid var(--am-br);padding:1px 5px;border-radius:3px">OPEN</span>'
      : t.pnl_rs>=0
      ? `<span style="font-size:7px;font-weight:700;color:var(--gn);background:var(--gn-bg);border:1px solid var(--gn-br);padding:1px 5px;border-radius:3px">+₹${Math.round(t.pnl_rs).toLocaleString('en-IN')}</span>`
      : `<span style="font-size:7px;font-weight:700;color:var(--rd);background:var(--rd-bg);border:1px solid var(--rd-br);padding:1px 5px;border-radius:3px">-₹${Math.abs(Math.round(t.pnl_rs)).toLocaleString('en-IN')}</span>`;
    const leg1 = t.leg1_action&&t.leg1_strike ? `${t.leg1_action} ${t.leg1_strike}${t.leg1_type}` : '';
    const leg2 = t.leg2_action&&t.leg2_strike ? ` / ${t.leg2_action} ${t.leg2_strike}${t.leg2_type}` : '';
    return `<div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);padding:10px 12px;margin-bottom:6px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
        <div style="font-size:10px;font-weight:700;color:${col}">${t.strategy.replace('_',' ')}</div>
        ${status}
      </div>
      <div style="font-family:var(--font-mono);font-size:11px;font-weight:700;margin-bottom:2px">${leg1}${leg2}</div>
      <div style="font-size:8px;color:var(--muted)">${t.trade_date} · Exp: ${t.expiry_date} · ${t.lots} lot · VIX ${t.vix_at_entry||'—'}</div>
      ${t.notes?`<div style="font-size:8px;color:var(--muted);margin-top:3px;font-style:italic">${t.notes}</div>`:''}
    </div>`;
  });
  el.innerHTML = rows.join('');
}


let _tt;
function toast(m){
  const e=document.getElementById('toast'); e.textContent=m; e.classList.add('show');
  clearTimeout(_tt); _tt=setTimeout(()=>e.classList.remove('show'),2500);
}

document.addEventListener('input',()=>{ setTimeout(saveState,500); });

if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});

// ── Init ──────────────────────────────────────────────────────
loadState();
onFIIFO();
loadChecklist();
restoreTS();
checkLocks();
setInterval(checkLocks, 60000);
setInterval(updateEntrySignal, 60000);
calcScore();
renderBreadth();
updateEntrySignal();
updateBhavStatus();
loadFBConfig();
setTimeout(()=>{ renderBhavCalendar(); checkBhavGaps(); }, 500);
// v3.0: Supabase connection check on load
setTimeout(()=>{ if(typeof dbShowStatus==='function') dbShowStatus(); }, 1000);
