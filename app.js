'use strict';
// ══════════════════════════════════════════════════════════════
// app.js — Market Radar v2.0 main application
// Strategy engine, scoring, UI, entry signals
// ══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// MARKET RADAR v1.7.0
// v1.5.0: PCR from score, DTE 6-7 mult, distFactorCall,
//         DTE≤5 AVOID, VIX guard, ±5% stress test
// v1.6.0: ATR detector index-aware, distFactorCall DTE-aware,
//         getDteMultCall() DTE 22-30=3.00
// v1.7.0: getDteMultBNF/getDteMultBNFCall — BNF-specific mults
//         calibrated from 3-month NSE bhavcopy (134 records).
//         bestStrike callBase 1.30→1.60 at DTE 22-45.
//         distFactorCall DTE≤7: 0.72→0.62.
//         BNF limited-data disclaimer on all expiry cards.
// ═══════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────
let SCORE = null, DIRECTION = '', STRAT_AUTO = '';
let RADAR_LOCKED = false, BREADTH_LOCKED = false, EVENING_LOCKED = false;

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
const NSE_HOLIDAYS_2026 = [
  '2026-01-01','2026-01-26','2026-03-03','2026-03-31',
  '2026-04-03','2026-04-14','2026-05-01','2026-06-16',
  '2026-11-09','2026-11-10','2026-11-24','2026-12-25'
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
  // Smarts (evening lock): open on trading days after 3:45pm
  //   AND stays open all weekend (Sat + Sun) so Friday data can be entered anytime
  const eveOk  = isWeekend || t>=EVENING;

  const mBanner=document.getElementById('morning-lock');
  if(!mornOk && !RADAR_LOCKED){
    const ml=MORNING-t;
    document.getElementById('morning-msg').textContent=`Opens in ${Math.floor(ml/60)}h ${ml%60}m (8:30 AM IST)`;
    mBanner.classList.add('show');
    setDisabled(['sp500','dow','usvix','nk','hsi','crude','gold','inr','yld',
      'gift_now','nifty_prev','gift_6am','india_vix','fii','fii_fut','fii_opt','dii',
      'max_pain_nf','max_pain_bn','close_char'], true);
    setDisabled(['n50adv','n50dma','bnfadv'],true);
    document.getElementById('breadth-lock').classList.add('show');
    document.getElementById('breadth-msg').textContent=`Opens in ${Math.floor(ml/60)}h ${ml%60}m`;
  } else {
    mBanner.classList.remove('show');
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
function getDteMult(dte) {
  if (dte <= 5)  return 0.10;   // Real ₹6  → est ₹6   ✅ (was 0.44, +240% over)
  if (dte <= 7)  return 0.20;   // Real ₹12 → est ₹12  ✅ (was 0.82, +180% over)
  if (dte <= 10) return 0.30;   // Real ₹18 → est ₹18  ✅ (was 1.47, +186% over)
  if (dte <= 14) return 0.39;   // Real ₹23 → est ₹23  ✅ (was 1.47, +186% over)
  if (dte <= 21) return 0.54;   // Real ₹32 → est ₹32  ✅ (was 1.94, +160% over)
  if (dte <= 35) return 0.69;   // Real ₹41 → est ₹41  ✅ (was 3.09, +139% over)
  if (dte <= 45) return 0.90;
  return 1.10;
}

// ── NF CALL DTE multipliers — calls are structurally more expensive in NF ──
// Call mult always > put mult (structural put/call skew in NF)
function getDteMultCall(dte) {
  if (dte <= 5)  return 0.13;   // Real ₹8  → est ₹8   ✅
  if (dte <= 7)  return 0.27;   // Real ₹16 → est ₹16  ✅
  if (dte <= 10) return 0.37;   // Real ₹22 → est ₹22  ✅
  if (dte <= 14) return 0.61;   // Real ₹36 → est ₹36  ✅ (largest asymmetry bucket)
  if (dte <= 21) return 0.89;   // Real ₹53 → est ₹53  ✅
  if (dte <= 35) return 1.20;   // Real ₹71 → est ₹71  ✅
  if (dte <= 45) return 1.45;
  return 1.75;
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
  return 1.45;
}

// FIX 1: Cap credit at 68% of width — prevents negative R:R
// v1.6.0: separate put/call base credits using their respective DTE multipliers
// v1.7.0: BNF uses its own multiplier set (getDteMultBNF/getDteMultBNFCall)
//         calibrated from 3-month NSE bhavcopy (134 BNF records)
function estimateCredit(width, dte, vix, isNF) {
  const vm   = getVixMult(vix);
  const putM = isNF ? getDteMult(dte)     : getDteMultBNF(dte);
  const calM = isNF ? getDteMultCall(dte) : getDteMultBNFCall(dte);
  const rawP = r5(width * 0.38 * putM * vm);
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

// Main command builder — replaces buildMultiExpiry
function buildCommand() {
  const out = document.getElementById('cmd-output');
  if (!out) return;

  const price = gv('nf_price');
  const atr   = gv('nf_atr');
  const vix   = gv('india_vix') || 14;
  const score = SCORE || 0;
  const pcr   = gv('pcr_nf');
  const oiCall= gv('nf_oi_call');
  const oiPut = gv('nf_oi_put');
  const maxPain = gv('nf_maxpain');

  // BNF data
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
        <div style="font-size:9px;margin-top:4px">Spot Price · ATR · Lot Size — your recommendation appears instantly</div>
      </div>`;
    return;
  }

  // ── GO/NO-GO Decision ─────────────────────────────────────
  const absScore = Math.abs(score);
  let goState, goIcon, goLabel, goReason;

  // DTE check — get today's expiries
  const expiries = getExpiries('NF');
  const bestExp  = pickBestExpiry(expiries);

  if (!bestExp) {
    goState='avoid'; goIcon='⚠️'; goLabel='NO VALID EXPIRY';
    goReason='Could not find a suitable expiry. Check dates.';
  } else if (bestExp.dte <= 5) {
    goState='avoid'; goIcon='🚫'; goLabel='EXPIRY WEEK — DO NOT OPEN';
    goReason=`${bestExp.dte} DTE is too close. Real premiums ₹5–₹30 — not worth the risk. CLOSE existing positions only.`;
  } else if (absScore >= 0.8) {
    goState='avoid'; goIcon='🔴'; goLabel='SKIP TODAY — STRONG TREND';
    goReason=`Score ${score>=0?'+':''}${score.toFixed(2)} — market strongly ${score>0?'bullish':'bearish'}. IC will lose one leg almost certainly.`;
  } else if (vix >= 18) {
    goState='avoid'; goIcon='🔴'; goLabel='SKIP TODAY — HIGH VIX';
    goReason=`India VIX ${vix} ≥ 18. Panic mode — IC win rate drops to ~25%. Stay out.`;
  } else if (absScore >= 0.4 || vix >= 15) {
    goState='caution'; goIcon='🟡'; goLabel='TRADE WITH CAUTION';
    goReason = absScore >= 0.4
      ? `Mild ${score>0?'bullish':'bearish'} bias (${score>=0?'+':''}${score.toFixed(2)}). Widen ${score>0?'call':'put'} side by 50pts. Reduce to 50% position size.`
      : `VIX ${vix} in elevated zone. Use wider strikes. Consider only the safer leg.`;
  } else {
    goState='go'; goIcon='🟢'; goLabel='TRADE TODAY — NIFTY 50';
    goReason=`Score ${score>=0?'+':''}${score.toFixed(2)} (neutral), VIX ${vix}, ${bestExp.dte} DTE — ideal IC conditions.`;
  }

  // ── Strike calculation ─────────────────────────────────────
  const width = 200;
  const callBest = bestStrike(price, atr, bestExp.dte, vix, true,  oiCall, pcr, true);
  const putBest  = bestStrike(price, atr, bestExp.dte, vix, false, oiPut,  pcr, true);
  const callBuy  = r50(callBest.strike + width);
  const putBuy   = r50(putBest.strike  - width);

  const callDist = (callBest.strike - price) / atr;
  const putDist  = (price - putBest.strike) / atr;

  const callNarr = strikeNarration(callDist);
  const putNarr  = strikeNarration(putDist);

  // ── Premium estimation ─────────────────────────────────────
  const pa       = pcrPremAdj(pcr, bestExp.dte);
  const crBase   = estimateCredit(width, bestExp.dte, vix, true);
  const callMid  = Math.min(r5(crBase.midCall * distFactorCall(callDist, bestExp.dte) / Math.max(pa,1)), r5(width*0.68));
  const putMid   = Math.min(r5(crBase.mid     * distFactor(putDist)    * pa),                           r5(width*0.68));
  const callMin  = r5(callMid*0.80), callMax = r5(callMid*1.22);
  const putMin   = r5(putMid*0.80),  putMax  = r5(putMid*1.22);
  const icMidUnit = callMid + putMid;

  // ── Capital metrics (₹1L fixed) ────────────────────────────
  const cm       = capitalMetrics(icMidUnit, width, NF_LOT_SIZE, NF_MARGIN_PER_LOT);
  const icCredit = icMidUnit * NF_LOT_SIZE * cm.safeLots;
  // BUG FIX (v2.0.2): max loss of IC = (width - total credit) per spread, not max of one leg.
  // Previous: max(width-callMid, width-putMid) overstated by ~35%
  const icMaxL   = (width - icMidUnit) * NF_LOT_SIZE * cm.safeLots;

  // ── Bhav actual lookup ─────────────────────────────────────
  const bhav     = bhavIC(callBest.strike, callBuy, putBest.strike, putBuy, bestExp.d);
  const bhavAtr  = bhavATR();
  const bhavPcr  = bhavPCR(bestExp.d);
  // If bhav has PCR for this expiry, use it — more accurate than user-entered total PCR
  const effectivePcr = bhavPcr || pcr;
  // Credit to use for exits: bhav actual if available, else model estimate
  const exitBase = bhav ? bhav.total : icMidUnit;
  const exitCredit = exitBase * NF_LOT_SIZE * cm.safeLots;
  const callRR   = callMid>0 ? r5((width-callMid)/callMid) : 99;
  const putRR    = putMid>0  ? r5((width-putMid)/putMid)   : 99;
  const callWP   = winProb(bestExp.dte, callDist);
  const putWP    = winProb(bestExp.dte, putDist);
  const putBreach  = down5 < putBest.strike;
  const callBreach = up5   > callBest.strike;

  // ── BNF viability ─────────────────────────────────────────
  const bnfViz = bnfViability(score, vix, bnfAtr||0, bnfPrice||0, bnfPcr);

  // ── Max Pain context ───────────────────────────────────────
  let maxPainNote = '';
  if (maxPain && price) {
    const mpDiff = maxPain - price;
    if (Math.abs(mpDiff) > 200)
      maxPainNote = `Max Pain ${f(maxPain)} — spot is ${mpDiff>0?'₹'+f(mpDiff)+' below':'₹'+f(Math.abs(mpDiff))+' above'} pain level`;
  }

  // ── VIX context bar ───────────────────────────────────────
  const vixPct = Math.min(100, (vix / 25) * 100);
  const vixColor = vix < 14 ? 'var(--gn)' : vix < 16 ? 'var(--am)' : 'var(--rd)';

  // ── DTE sweet spot indicator ───────────────────────────────
  const dteSweetSpot = bestExp.dte >= 11 && bestExp.dte <= 21;
  const dteColor = dteSweetSpot ? 'var(--gn)' : bestExp.dte <= 5 ? 'var(--rd)' : 'var(--am)';

  // ── Render ─────────────────────────────────────────────────
  out.innerHTML = `

  <!-- GO/NO-GO Banner -->
  <div class="go-banner ${goState}">
    <div class="go-icon">${goIcon}</div>
    <div>
      <div class="go-status" style="color:${goState==='go'?'var(--gn)':goState==='caution'?'var(--am)':'var(--rd)'}">${goLabel}</div>
      <div class="go-reason">${goReason}</div>
    </div>
  </div>

  ${goState === 'avoid' ? `
  <!-- AVOID details -->
  <div style="margin:10px 14px 0;background:var(--bg2);border-radius:var(--r);padding:14px;border:1px solid var(--border)">
    <div style="font-size:10px;color:var(--muted);line-height:1.8">
      ${bestExp ? `📅 Next tradeable expiry: <strong style="color:var(--text)">${bestExp.label} (${bestExp.dte} DTE)</strong>` : ''}
      <br>⏰ Come back when conditions improve — check VERDICT tab for score trend.
      ${maxPainNote ? `<br>📍 ${maxPainNote}` : ''}
    </div>
  </div>
  ` : `

  <!-- Command Card — The ONE Trade -->
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

    <!-- Two legs side by side -->
    <div class="cmd-legs">
      <div class="cmd-leg call">
        <div class="cmd-leg-type">🔴 Bear Call Spread</div>
        <div class="cmd-leg-sell">Sell ${f(callBest.strike)} CE</div>
        <div class="cmd-leg-buy">Buy  ${f(callBuy)} CE</div>
        <div class="cmd-leg-narration" style="color:${callNarr.color}">${callNarr.label} · ${callDist.toFixed(1)}×ATR</div>
        <div class="cmd-leg-credit">₹${callMin}–${callMax}/unit</div>
      </div>
      <div class="cmd-leg put">
        <div class="cmd-leg-type">🟢 Bull Put Spread</div>
        <div class="cmd-leg-sell">Sell ${f(putBest.strike)} PE</div>
        <div class="cmd-leg-buy">Buy  ${f(putBuy)} PE</div>
        <div class="cmd-leg-narration" style="color:${putNarr.color}">${putNarr.label} · ${putDist.toFixed(1)}×ATR</div>
        <div class="cmd-leg-credit">₹${putMin}–${putMax}/unit</div>
      </div>
    </div>

    <!-- Bhav Actual or Model note -->
    ${bhav ? `
    <div style="background:rgba(0,180,255,0.05);border:1px solid rgba(0,180,255,0.2);border-radius:5px;padding:8px 10px;margin:6px 0 2px">
      <div style="font-size:7px;font-weight:700;letter-spacing:1px;color:var(--tl);text-transform:uppercase;margin-bottom:5px">📊 ACTUAL FROM BHAV COPY · ${bhavLatestLabel()}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:8px">
        <div>
          <div style="color:var(--muted);margin-bottom:2px">🔴 Call spread</div>
          <div style="font-family:var(--font-mono);font-weight:700;font-size:11px;color:var(--rd)">₹${bhav.callNet}/unit</div>
          <div style="color:var(--muted);font-size:7px;margin-top:1px">${f(callBest.strike)}CE ₹${bhav.cs} − ${f(callBuy)}CE ₹${bhav.cb}</div>
        </div>
        <div>
          <div style="color:var(--muted);margin-bottom:2px">🟢 Put spread</div>
          <div style="font-family:var(--font-mono);font-weight:700;font-size:11px;color:var(--gn)">₹${bhav.putNet}/unit</div>
          <div style="color:var(--muted);font-size:7px;margin-top:1px">${f(putBest.strike)}PE ₹${bhav.ps} − ${f(putBuy)}PE ₹${bhav.pb}</div>
        </div>
      </div>
      <div style="border-top:1px solid rgba(0,180,255,0.15);margin-top:6px;padding-top:6px;display:flex;justify-content:space-between;align-items:center">
        <div style="font-size:8px;color:var(--muted)">Actual IC total</div>
        <div style="font-family:var(--font-mono);font-weight:800;font-size:13px;color:var(--tl)">₹${bhav.total}/unit = ${fv(exitCredit)}</div>
      </div>
      ${bhav.total < icMidUnit * 0.6 ? `<div style="font-size:7.5px;color:var(--am);margin-top:4px">⚠️ Actual lower than model — market compressed. Use bhav figure for exits.</div>` : ''}
      ${bhav.total > icMidUnit * 1.4 ? `<div style="font-size:7.5px;color:var(--gn);margin-top:4px">✅ Actual higher than model — elevated IV. Favourable entry.</div>` : ''}
    </div>
    ` : `
    <div style="font-size:7.5px;color:var(--muted);text-align:center;padding:5px 0 2px;border-top:1px solid var(--border);margin-top:4px">
      📊 Upload bhav copy in Smarts tab for actual market premiums · Using model estimate
    </div>
    `}

    <!-- Key numbers strip -->
    <div class="cmd-stats">
      <div class="cmd-stat">
        <div class="cmd-stat-lbl">Lots · Lot sz</div>
        <div class="cmd-stat-val" style="color:var(--tl)">${cm.safeLots} × ${NF_LOT_SIZE}</div>
      </div>
      <div class="cmd-stat">
        <div class="cmd-stat-lbl">R:R · Win%</div>
        <div class="cmd-stat-val" style="color:var(--am)">${Math.min(callRR,putRR).toFixed(1)} · ${Math.round((callWP+putWP)/2)}%</div>
      </div>
      <div class="cmd-stat">
        <div class="cmd-stat-lbl">Max Loss</div>
        <div class="cmd-stat-val" style="color:var(--rd)">${fv(icMaxL)}</div>
      </div>
    </div>

    <!-- Capital strip -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--border)">
      <div style="background:var(--bg3);padding:7px 8px;text-align:center">
        <div style="font-size:6.5px;letter-spacing:0.8px;color:var(--muted);text-transform:uppercase;margin-bottom:2px">Capital</div>
        <div style="font-family:var(--font-mono);font-size:10px;font-weight:700">₹1L</div>
      </div>
      <div style="background:var(--bg3);padding:7px 8px;text-align:center">
        <div style="font-size:6.5px;letter-spacing:0.8px;color:var(--muted);text-transform:uppercase;margin-bottom:2px">Margin</div>
        <div style="font-family:var(--font-mono);font-size:10px;font-weight:700;color:var(--tl)">${fv(cm.marginUsed)}</div>
      </div>
      <div style="background:var(--bg3);padding:7px 8px;text-align:center">
        <div style="font-size:6.5px;letter-spacing:0.8px;color:var(--muted);text-transform:uppercase;margin-bottom:2px">Buffer</div>
        <div style="font-family:var(--font-mono);font-size:10px;font-weight:700;color:var(--gn)">${fv(cm.bufferLeft)}</div>
      </div>
      <div style="background:${cm.riskFlag?'rgba(200,33,62,0.1)':'var(--bg3)'};padding:7px 8px;text-align:center;border:${cm.riskFlag?'1px solid rgba(200,33,62,0.4)':'none'}">
        <div style="font-size:6.5px;letter-spacing:0.8px;color:${cm.riskFlag?'var(--rd)':'var(--muted)'};text-transform:uppercase;margin-bottom:2px">SL Risk</div>
        <div style="font-family:var(--font-mono);font-size:10px;font-weight:700;color:${cm.riskFlag?'var(--rd)':'var(--am)'}">${cm.slPct.toFixed(1)}%${cm.riskFlag?' ⚠️':''}</div>
      </div>
    </div>

    <!-- EXIT RULES — bold and clear -->
    <div class="cmd-exits">
      <div class="cmd-exit profit">
        <div class="cmd-exit-lbl">✅ Take Profit</div>
        <div class="cmd-exit-val" style="color:var(--gn)">${fv(exitCredit*0.40)}</div>
        <div style="font-size:7.5px;color:var(--muted);margin-top:2px">40% of ${bhav?'actual':'est.'} credit${bhav?' (bhav)':''}</div>
      </div>
      <div class="cmd-exit loss">
        <div class="cmd-exit-lbl">🛑 Stop Loss</div>
        <div class="cmd-exit-val" style="color:var(--rd)">${fv(exitCredit*0.80)}</div>
        <div style="font-size:7.5px;color:var(--muted);margin-top:2px">80% of ${bhav?'actual':'est.'} credit — hard exit</div>
      </div>
    </div>

    <!-- Stress test -->
    <div class="stress-strip">
      <div class="stress-side">
        <div class="stress-scenario">Spot −5% → ${f(Math.round(down5))}</div>
        <div class="stress-result ${putBreach?'breach':'safe'}">${putBreach ? '⚠️ PUT BREACHED' : '✅ Safe'}</div>
        <div style="font-size:7.5px;color:var(--muted);margin-top:2px">${putBreach ? 'Put side at risk of max loss' : `Buffer: ${f(price - putBest.strike)}pts`}</div>
      </div>
      <div class="stress-side">
        <div class="stress-scenario">Spot +5% → ${f(Math.round(up5))}</div>
        <div class="stress-result ${callBreach?'breach':'safe'}">${callBreach ? '⚠️ CALL BREACHED' : '✅ Safe'}</div>
        <div style="font-size:7.5px;color:var(--muted);margin-top:2px">${callBreach ? 'Call side at risk of max loss' : `Buffer: ${f(callBest.strike - price)}pts`}</div>
      </div>
    </div>
  </div>

  `}

  <!-- VIX + Market Context strip -->
  <div style="margin:10px 14px 0;background:var(--bg2);border-radius:var(--r);padding:10px 14px;border:1px solid var(--border)">
    <div style="font-size:7.5px;font-weight:700;letter-spacing:1.5px;color:var(--muted);text-transform:uppercase;margin-bottom:8px">Market Context</div>
    <div class="vix-bar-row">
      <div class="vix-label" style="font-size:8.5px;font-weight:600;color:var(--text)">India VIX</div>
      <div class="vix-track"><div class="vix-fill" style="width:${vixPct}%;background:${vixColor}"></div></div>
      <div class="vix-val" style="color:${vixColor}">${vix}</div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:6px">
      <div style="background:var(--bg3);border-radius:5px;padding:6px 8px;text-align:center">
        <div style="font-size:7px;color:var(--muted);letter-spacing:0.5px">SCORE</div>
        <div style="font-family:var(--font-mono);font-size:13px;font-weight:700;color:${score>=0.4?'var(--gn)':score<=-0.4?'var(--rd)':'var(--am)'}">${score>=0?'+':''}${score.toFixed(2)}</div>
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

  <!-- Alternatives — collapsed -->
  <div class="alt-section" id="alt-section">
    <div class="alt-toggle" onclick="toggleAlt()">
      <div class="alt-toggle-lbl">📋 Other expiries & details</div>
      <div class="alt-toggle-chevron">▼</div>
    </div>
    <div class="alt-body">
      ${expiries.map((exp, i) => {
        if (exp.dte === (bestExp?.dte)) return '';  // skip the one already shown
        const cB2 = bestStrike(price, atr, exp.dte, vix, true,  oiCall, pcr, true);
        const pB2 = bestStrike(price, atr, exp.dte, vix, false, oiPut,  pcr, true);
        const cBuy2 = r50(cB2.strike+width), pBuy2 = r50(pB2.strike-width);
        const pa2 = pcrPremAdj(pcr,exp.dte);
        const cr2 = estimateCredit(width,exp.dte,vix,true);
        const cD2 = (cB2.strike-price)/atr, pD2 = (price-pB2.strike)/atr;
        const cM2 = Math.min(r5(cr2.midCall*distFactorCall(cD2,exp.dte)/Math.max(pa2,1)),r5(width*0.68));
        const pM2 = Math.min(r5(cr2.mid*distFactor(pD2)*pa2),r5(width*0.68));
        const ic2 = (cM2+pM2)*NF_LOT_SIZE*cm.safeLots;
        const conv2 = dteConviction(exp.dte);
        const dteOk = exp.dte>=6 && exp.dte<=21;
        return `<div style="margin:4px 0;background:var(--bg2);border-radius:6px;border:1px solid var(--border);padding:10px 14px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <div>
              <div style="font-family:var(--font-mono);font-size:14px;font-weight:700">${exp.label}</div>
              <div style="font-size:8px;color:var(--muted)">${exp.dte} DTE · ${exp.type}</div>
            </div>
            <div style="text-align:right">
              <div style="font-size:8px;color:var(--muted)">Est IC</div>
              <div style="font-family:var(--font-mono);font-size:14px;font-weight:700;color:${dteOk?'var(--gn)':'var(--muted)'}">${fv(ic2)}</div>
            </div>
          </div>
          <div style="font-size:8.5px;color:var(--muted)">
            Sell ${f(cB2.strike)} CE / ${f(pB2.strike)} PE · Buy ${f(cBuy2)} CE / ${f(pBuy2)} PE
          </div>
          <div style="font-size:8px;margin-top:3px;color:${conv2.cls==='opt'?'var(--gn)':conv2.cls==='near'?'var(--rd)':'var(--am)'}">${conv2.label} — ${conv2.note}</div>
        </div>`;
      }).join('')}
    </div>
  </div>

  `;

  // Also update old output areas for compat
  const oldNF = document.getElementById('nf-multi-output');
  if (oldNF) oldNF.innerHTML = '';
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
            <div style="font-size:8px;color:var(--muted)">Sell ${f(callBest.strike)} CE / Buy ${f(callBuy)} CE</div>
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
            <div style="font-size:8px;color:var(--muted)">Sell ${f(putBest.strike)} PE / Buy ${f(putBuy)} PE</div>
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
  if(n===3){ buildCommand(); updateEntrySignal(); }
  if(n===4) checkLocks();
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
    localStorage.setItem('mr140-radar',JSON.stringify(data));
    localStorage.setItem('mr140-prevscore',JSON.stringify({score:SCORE,dir:DIRECTION,ts:Date.now()}));
    RADAR_LOCKED=true;
    setDisabled(radarFlds,true);
    document.getElementById('btn-save-radar').style.display='none';
    document.getElementById('btn-edit-radar').style.display='inline-flex';
    document.getElementById('radar-status').textContent='Saved ✅';
    toast('💾 Radar saved & locked');
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
  const allFlds=['sp500','dow','usvix','nk','hsi','crude','gold','inr','yld',
    'gift_now','nifty_prev','gift_6am','india_vix','fii','fii_fut','fii_opt','dii',
    'max_pain_nf','max_pain_bn','close_char','n50adv','n50dma','bnfadv',
    'nf_price','nf_atr','pcr_nf','nf_lot','nf_lots','nf_oi_call','nf_oi_put','nf_maxpain',
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
  const radar=localStorage.getItem('mr140-radar');
  if(radar){
    RADAR_LOCKED=true;
    const radarFlds=['sp500','dow','usvix','nk','hsi','crude','gold','inr','yld',
      'gift_now','nifty_prev','gift_6am','india_vix','fii','fii_fut','fii_opt','dii','max_pain_nf','max_pain_bn','close_char'];
    setDisabled(radarFlds,true);
    document.getElementById('btn-save-radar').style.display='none';
    document.getElementById('btn-edit-radar').style.display='inline-flex';
    document.getElementById('radar-status').textContent='Saved ✅ (from last session)';
  }
  const breadth=localStorage.getItem('mr140-breadth');
  if(breadth){
    BREADTH_LOCKED=true;
    setDisabled(['n50adv','n50dma','bnfadv'],true);
    document.getElementById('btn-save-breadth').style.display='none';
    document.getElementById('btn-edit-breadth').style.display='inline-flex';
  }
}

// ── Toast ──────────────────────────────────────────────────────
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
buildCommand();
updateEntrySignal();
updateBhavStatus();
loadFBConfig();
setTimeout(()=>{ renderBhavCalendar(); checkBhavGaps(); }, 500);
