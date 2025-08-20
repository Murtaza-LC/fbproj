/* ---------- Tiny DOM helpers ---------- */
const $ = (s, r=document)=>r.querySelector(s);
const $$ = (s, r=document)=>Array.from(r.querySelectorAll(s));

/* ---------- App state ---------- */
let rows = [];      // unified rows from backend
let filtered = [];  // after search/sort
let matches = [];   // matched pairs

/* ---------- URL normalization ---------- */
function normalizeInputUrl(raw, platform) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  try {
    const u = new URL(s);
    const host = u.host.toLowerCase();
    if (platform === 'amazon' && !host.includes('amazon.')) return null;
    if (platform === 'flipkart' && !host.includes('flipkart.com')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/* ---------- Fuzzy matching for pairs ---------- */
function normName(s){
  if(!s) return "";
  return s.toLowerCase()
    .replace(/[^a-z0-9\s\+]/g," ")
    .replace(/\b(5g|4g|smartphone|phone|android|mobile|gb|ram|rom)\b/g," ")
    .replace(/\s+/g," ")
    .trim();
}
function scoreMatch(a,b){
  const A = new Set(normName(a).split(" ").filter(Boolean));
  const B = new Set(normName(b).split(" ").filter(Boolean));
  if(!A.size || !B.size) return 0;
  let inter = 0;
  for(const t of A) if(B.has(t)) inter++;
  return inter / Math.min(A.size, B.size);
}

/* ---------- Rendering ---------- */
function priceView(p){ return p!=null ? `₹${Number(p).toLocaleString('en-IN')}` : "—"; }

function viewItem(r){
  const img = r.image_url ? `<img src="${r.image_url}" alt="">` : `<img alt="">`;
  const disc = r.discount_percent!=null ? `<span class="tag">${r.discount_percent}% off</span>` : ``;
  const rev  = r.review_count!=null ? `<span class="tag">${r.review_count} reviews</span>` : ``;
  return `
  <a class="item" href="${r.product_url}" target="_blank" rel="noopener">
    ${img}
    <div>
      <div class="name">${r.product_name || '(No title)'}</div>
      <div class="muted">${r.brand_guess || ''}</div>
      <div class="muted">${r.platform}</div>
      <div class="row" style="gap:8px; margin-top:6px">${disc}${rev}</div>
    </div>
    <div style="text-align:right">
      <div class="price">${priceView(r.price)}</div>
      <div class="muted" style="text-decoration:line-through">${r.mrp?priceView(r.mrp):''}</div>
    </div>
  </a>`;
}

function renderLists(){
  const amz = filtered.filter(r=>r.platform==="amazon");
  const flk = filtered.filter(r=>r.platform==="flipkart");
  $('#countAmazon').textContent = `${amz.length} items`;
  $('#countFlipkart').textContent = `${flk.length} items`;
  $('#listAmazon').innerHTML = amz.map(viewItem).join("");
  $('#listFlipkart').innerHTML = flk.map(viewItem).join("");
}

function viewMatch(pair){
  const a = pair.amazon, f = pair.flipkart;
  const delta = (a.price!=null && f.price!=null) ? (f.price - a.price) : null;
  const deltaTxt = delta==null ? '' :
    `<span class="${delta<0?'ok':'warn'}">${delta<0?'↓':'↑'} ₹${Math.abs(delta).toLocaleString('en-IN')}</span>`;
  return `
  <div class="compare card">
    <div>
      <div class="row" style="justify-content:space-between"><strong>Amazon</strong><a class="tag" href="${a.product_url}" target="_blank">Open</a></div>
      <div class="name">${a.product_name}</div>
      <div class="muted">${a.brand_guess||''}</div>
      <div class="price">${priceView(a.price)} <span class="muted" style="text-decoration:line-through">${a.mrp?priceView(a.mrp):''}</span></div>
      <div class="muted">${a.discount_percent!=null? a.discount_percent + '% off' : ''}</div>
    </div>
    <div>
      <div class="row" style="justify-content:space-between"><strong>Flipkart</strong><a class="tag" href="${f.product_url}" target="_blank">Open</a></div>
      <div class="name">${f.product_name}</div>
      <div class="muted">${f.brand_guess||''}</div>
      <div class="price">${priceView(f.price)} <span class="muted" style="text-decoration:line-through">${f.mrp?priceView(f.mrp):''}</span></div>
      <div class="muted">${f.discount_percent!=null? f.discount_percent + '% off' : ''}</div>
    </div>
    <div class="row" style="grid-column:1/-1; justify-content:flex-end; gap:8px">
      ${deltaTxt}
    </div>
  </div>`;
}

function computeMatches(){
  const A = filtered.filter(r=>r.platform==="amazon");
  const F = filtered.filter(r=>r.platform==="flipkart");
  const out = [];
  const byBrand = new Map();
  for(const f of F){
    const key = (f.brand_guess||'').toLowerCase();
    if(!byBrand.has(key)) byBrand.set(key, []);
    byBrand.get(key).push(f);
  }
  for(const a of A){
    const candidates = (byBrand.get((a.brand_guess||'').toLowerCase())||F);
    let best=null, bestScore=0;
    for(const f of candidates){
      const s = scoreMatch(a.product_name||'', f.product_name||'');
      if(s>bestScore){ bestScore=s; best={amazon:a, flipkart:f}; }
    }
    if(best && bestScore>=0.55){
      out.push(best);
    }
  }
  const seenF = new Set(); const dedup=[];
  for(const m of out){
    if(seenF.has(m.flipkart.product_url)) continue;
    seenF.add(m.flipkart.product_url); dedup.push(m);
  }
  matches = dedup;
  $('#matchCount').textContent = `${matches.length} pairs`;
  $('#matches').innerHTML = matches.map(viewMatch).join("");
}

/* ---------- Search + Sort ---------- */
function applySearchAndSort(){
  const term = ($('#search').value||'').toLowerCase();
  filtered = rows.filter(r=> !term || (r.product_name||'').toLowerCase().includes(term));
  renderLists();
  computeMatches();
}

function sortBy(mode){
  const key = {
    discount: (r)=> (r.discount_percent==null ? -Infinity : r.discount_percent),
    lowest:   (r)=> (r.price==null ? Infinity : r.price) * -1, // reverse later
    highest:  (r)=> (r.price==null ? -Infinity : r.price),
    reviews:  (r)=> (r.review_count==null ? -Infinity : r.review_count),
  }[mode];

  function sortPlatform(p){
    const arr = filtered.filter(r=>r.platform===p);
    arr.sort((a,b)=> (key(b)-key(a))); // desc
    if(mode==='lowest'){ arr.reverse(); } // asc
    return arr;
  }
  const amz = sortPlatform('amazon');
  const flk = sortPlatform('flipkart');
  filtered = amz.concat(flk);
  renderLists();
  computeMatches();
}

/* ---------- Debug panel ---------- */
function showDebug(lines, shot) {
  const box = $('#debugOut');
  if (!lines && !shot) { box.style.display='none'; box.textContent=''; return; }
  let text = '';
  if (Array.isArray(lines)) text += lines.join('\n');
  box.textContent = text || '(no debug lines)';
  box.style.display = 'block';
  if (shot) {
    const img = new Image();
    img.src = shot;
    img.alt = 'debug screenshot';
    img.style.display = 'block';
    img.style.maxWidth = '100%';
    img.style.marginTop = '8px';
    box.appendChild(img);
  }
}

/* ---------- Scrape trigger ---------- */
async function run() {
  const amazon = normalizeInputUrl(document.querySelector('#amazonUrl')?.value, 'amazon');
  const flip   = normalizeInputUrl(document.querySelector('#flipkartUrl')?.value, 'flipkart');
  if (!amazon && !flip) { alert('Enter at least one valid listing URL (Amazon or Flipkart).'); return; }

  const btn = document.querySelector('#run');
  btn.disabled = true; btn.textContent = 'Scraping...';
  showDebug();

  try {
    const fnUrl = new URL('/api/scrape', window.location.origin);
    if (amazon) fnUrl.searchParams.set('amazon_url', amazon);
    if (flip)   fnUrl.searchParams.set('flipkart_url', flip);
    fnUrl.searchParams.set('debug', document.getElementById('dbg')?.checked ? '1' : '0');
    fnUrl.searchParams.set('debug_shot', document.getElementById('dbgshot')?.checked ? '1' : '0');

    const res = await fetch(fnUrl.toString());
    const data = await res.json();

    if (data && (data.debug || data.debug_screenshot)) {
      showDebug(data.debug, data.debug_screenshot);
    }
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);

    window.rows = data.rows || [];
    window.filtered = window.rows.slice();
    applySearchAndSort();

    if (data.captcha && data.captcha.flipkart) {
      const warn = document.createElement('div');
      warn.textContent = 'Flipkart may have shown a CAPTCHA. We tried a mobile fallback.';
      warn.style.cssText = 'margin:8px 0;padding:8px;border:1px solid rgba(255,255,255,.2);border-radius:8px;background:#332b00;color:#ffe08a';
      document.querySelector('main')?.prepend(warn);
    }
  } catch (err) {
    alert('Scrape failed: ' + (err?.message || err));
  } finally {
    btn.disabled = false; btn.textContent = 'Scrape';
  }
}

/* ---------- Event wiring ---------- */
document.addEventListener('DOMContentLoaded', () => {
  $('#run').addEventListener('click', run);
  $('#search').addEventListener('input', applySearchAndSort);
  $$('.pill').forEach(p => p.addEventListener('click', ()=> sortBy(p.dataset.sort)));
});