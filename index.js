// functions/index.js
const functions = require("firebase-functions/v2/https");
const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

// ---------- Config ----------
const REGION = "asia-south1"; // pick closest to you
const RUNTIME_OPTS = {
  region: REGION,
  memory: "1GiB",
  timeoutSeconds: 60, // generous, but we keep our own ~15s budget below
};

// ---------- Helpers ----------
const UA_DESKTOPS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
];
const UA_MOBILE = "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36";

const BASE_OPTS = { timeoutMs: 9000, minWaitMs: 100, maxWaitMs: 250, scrollSteps: 2, scrollPauseMs: 150 };
const HARD_LIMIT_MS = 15000; // ~15s per request

const json = (res, code, body) => res.status(code).json(body);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (a,b) => Math.floor(Math.random()*(b-a+1))+a;
const randWait = (a,b) => sleep(rand(a,b));
const timeLeft = (deadline) => Math.max(0, deadline - Date.now());

const normalizeUrl = (u) => {
  if (!u) return null;
  u = String(u).trim();
  if (!/^https?:\/\//i.test(u)) u = "https://" + u.replace(/^\/+/, "");
  try { new URL(u); return u; } catch { return null; }
};
const ensureAllowed = (u, platform) => {
  if (!u) return null;
  const host = new URL(u).host.toLowerCase();
  if (platform === "amazon" && !host.includes("amazon.")) return null;
  if (platform === "flipkart" && !host.includes("flipkart.com")) return null;
  return u;
};
const pageWithParam = (url, n) => (n <= 1 ? url : `${url}${url.includes("?") ? "&" : "?"}page=${n}`);
const money = (t) => { if (!t) return null; const m = String(t).match(/[₹]?\s*([\d,]+\.?\d*)/); return m ? Number(m[1].replace(/,/g,"")) : null; };
const pctOff = (mrp, price) => (mrp && price && mrp > 0 && price <= mrp) ? Math.round((100*(mrp-price)/mrp)*10)/10 : null;
const brandGuess = (name) => {
  if (!name) return null;
  const map = { iphone:"Apple", mi:"Xiaomi", redmi:"Xiaomi", moto:"Motorola" };
  for (const raw of name.split(/\s+/).slice(0,4)){
    const t = raw.replace(/[^A-Za-z0-9+]/g,"").toLowerCase();
    if (map[t]) return map[t];
    const set = ["samsung","apple","xiaomi","oneplus","realme","vivo","oppo","iqoo","motorola","tecno","infinix","lava","nokia","honor","google","acer","poco"];
    if (set.includes(t)) return t[0].toUpperCase()+t.slice(1);
  }
  return null;
};
const flipToMobile = (urlStr) => {
  try { const u = new URL(urlStr); u.host = "m.flipkart.com"; u.searchParams.delete("otracker"); return u.toString(); }
  catch { return urlStr; }
};

function makeDebugger(enabled) {
  const lines = [];
  const d = (msg, extra) => { const L = `[${new Date().toISOString()}] ${msg}${extra ? " " + JSON.stringify(extra) : ""}`; console.log(L); lines.push(L); };
  return { d, dump: () => (enabled ? lines : undefined) };
}

async function hardenPage(page, { mobile = false } = {}) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "languages", { get: () => ["en-IN","en"] });
    Object.defineProperty(navigator, "platform", { get: () => "Win32" });
    window.chrome = { runtime: {} };
    const orig = navigator.permissions && navigator.permissions.query;
    if (orig) {
      navigator.permissions.query = (params) =>
        params.name === "notifications"
          ? Promise.resolve({ state: Notification.permission })
          : orig(params);
    }
  });
  try { await page.emulateTimezone("Asia/Kolkata"); } catch {}
  if (mobile) {
    await page.setViewportSize({ width: 390, height: 844 });
  } else {
    await page.setViewportSize({ width: 1360, height: 900 });
  }
  await page.route("**/*", route => {
    const t = route.request().resourceType();
    if (t === "image" || t === "media" || t === "font") return route.abort();
    return route.continue();
  });
}

async function gotoWithRetries(page, url, readySel, timeoutMs, dbg, { detectCaptchaTitle=false } = {}) {
  for (let attempt=0; attempt<2; attempt++){
    const t0 = Date.now();
    try {
      dbg.d("goto attempt", { attempt: attempt+1, url });
      await page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
      const title = await page.title().catch(()=> "");
      const cur = page.url();
      dbg.d("after goto", { title, cur, dur_ms: Date.now()-t0 });

      if (detectCaptchaTitle && /recaptcha/i.test(title)) {
        dbg.d("captcha detected by title", { title });
        return { ok:false, captcha:true };
      }

      await page.waitForSelector(readySel, { timeout: timeoutMs });
      dbg.d("selector appeared", { readySel });
      return { ok:true, captcha:false };
    } catch (e) {
      dbg.d("goto/wait error", { attempt, err: String(e) });
      if (attempt === 1) return { ok:false, captcha:false };
      await sleep(400);
    }
  }
  return { ok:false, captcha:false };
}

async function autoScroll(page, steps, pause) {
  for (let i=0;i<steps;i++) {
    await page.evaluate(()=> window.scrollBy(0, document.body.scrollHeight));
    await sleep(pause);
  }
}

// ---------- Amazon list ----------
async function extractAmazonList(page, sourceUrl, listOffset, localOpts, limit, dbg) {
  const out = [];
  try { await page.waitForSelector("div.s-main-slot", { timeout: localOpts.timeoutMs }); }
  catch { dbg.d("amazon: s-main-slot not found"); return [out, listOffset]; }

  const cards = await page.$$(`div.s-main-slot div.s-result-item[data-component-type='s-search-result']`);
  dbg.d("amazon: cards", { n: cards.length });
  let pos = listOffset;

  for (const c of cards) {
    try {
      const titleEl = await c.$("h2 a span.a-size-medium") || await c.$("h2 a span") || await c.$("h2");
      let name = titleEl ? (await titleEl.textContent())?.trim() : null;
      const linkEl = await c.$("h2 a");
      const href = linkEl ? await linkEl.getAttribute("href") : null;
      if (!name && linkEl) name = await linkEl.getAttribute("aria-label");

      const asin = await c.getAttribute("data-asin");
      const product_url = href ? new URL(href, "https://www.amazon.in").toString()
                               : (asin ? `https://www.amazon.in/dp/${asin}` : null);

      const imgEl = await c.$("img.s-image");
      const image_url = imgEl ? await imgEl.getAttribute("src") : null;

      const priceEl = await c.$("span.a-price:not(.a-text-price) span.a-offscreen");
      const price = money(priceEl ? await priceEl.textContent() : null);

      const mrpEl = await c.$("span.a-text-price span.a-offscreen");
      const mrp = money(mrpEl ? await mrpEl.textContent() : null);

      if (name || price || product_url) {
        pos++;
        out.push({
          date: new Date().toISOString().slice(0,10),
          timestamp: new Date().toISOString(),
          platform: "amazon",
          list_position: pos,
          product_name: name,
          brand_guess: brandGuess(name),
          price, mrp, discount_percent: pctOff(mrp, price),
          rating: null, review_count: null,
          product_url, image_url, source_url: sourceUrl,
        });
        if (out.length >= limit) break;
      }
    } catch (e) { dbg.d("amazon: card parse error", { err: String(e) }); }
  }
  dbg.d("amazon: extracted", { n: out.length });
  return [out, pos];
}

// ---------- Flipkart list ----------
async function closeFlipkartPopups(page, dbg) {
  try { const btn = await page.$("button._2KpZ6l._2doB4z, button:has-text('✕')"); if (btn) { await btn.click(); dbg.d("flipkart: closed dismiss"); } } catch {}
  try { await page.keyboard.press("Escape"); } catch {}
}
function flipkartRupees(t) {
  const vals = [...String(t||"").matchAll(/₹\s*([\d,]+\.?\d*)/g)].map(m => Number(m[1].replace(/,/g,"")));
  return [...new Set(vals)].sort((a,b)=> b-a);
}
async function extractFlipkartList(page, sourceUrl, listOffset, localOpts, limit, dbg) {
  const out = [];
  await closeFlipkartPopups(page, dbg);
  await sleep(200);
  await autoScroll(page, localOpts.scrollSteps, localOpts.scrollPauseMs);

  let anchors = await page.$$("a[href*='/p/'], a[href*='/product/']");
  dbg.d("flipkart: anchors", { n: anchors.length });

  const seen = new Set(); let pos = listOffset;
  for (const a of anchors) {
    try {
      const href = await a.getAttribute("href");
      if (!href) continue;
      const product_url = new URL(href, "https://www.flipkart.com").toString();
      if (seen.has(product_url)) continue;

      const containerHandle = await a.evaluateHandle(el =>
        el.closest("div._2kHMtA, div._4ddWXP, div._1AtVbE, div.gUuXy-, div.y0S0Pe") || el.parentElement
      );
      const container = containerHandle.asElement();

      let name = null;
      for (const sel of ["div._4rR01T","a.s1Q9rs","div.KzDlHZ","a.IRpwTa"]) {
        const node = await container.$(sel);
        if (node) { name = (await node.textContent())?.trim(); if (name) break; }
      }
      if (!name) {
        const img = await container.$("img");
        if (img) name = await img.getAttribute("alt");
      }

      const priceEl = await container.$("div._30jeq3._1_WHN1") || await container.$("div._30jeq3");
      const mrpEl   = await container.$("div._3I9_wc._27UcVY")  || await container.$("div._3I9_wc");
      let price = money(priceEl ? await priceEl.textContent() : null);
      let mrp   = money(mrpEl ? await mrpEl.textContent() : null);

      if (price == null || mrp == null) {
        const ct = (await container.textContent()) || "";
        const nums = flipkartRupees(ct);
        const pool = (nums.filter(n => n >= 3000).length ? nums.filter(n => n >= 3000) : nums);
        if (pool.length >= 2) { mrp = mrp ?? Math.max(pool[0], pool[1]); price = price ?? Math.min(pool[0], pool[1]); }
        else if (pool.length === 1) { price = price ?? pool[0]; }
      }

      seen.add(product_url);
      pos++;
      if ((name || price) && product_url) {
        out.push({
          date: new Date().toISOString().slice(0,10),
          timestamp: new Date().toISOString(),
          platform: "flipkart",
          list_position: pos,
          product_name: name,
          brand_guess: brandGuess(name),
          price, mrp, discount_percent: pctOff(mrp, price),
          rating: null, review_count: null,
          product_url, image_url: null, source_url: sourceUrl,
        });
        if (out.length >= limit) break;
      }
    } catch (e) { dbg.d("flipkart: anchor parse error", { err: String(e) }); }
  }
  dbg.d("flipkart: extracted", { n: out.length });
  return [out, pos];
}

// ---------- Express app ----------
const app = express();
app.use(cors({ origin: true }));

app.get("/scrape", async (req, res) => {
  const dbgEnabled = String(req.query.debug || "0") === "1";
  const shotEnabled = String(req.query.debug_shot || "0") === "1";
  const DBG = makeDebugger(dbgEnabled);
  const captcha = { flipkart: false };
  let shotBase64 = null;

  try {
    const amazonUrl   = ensureAllowed(normalizeUrl(req.query.amazon_url), "amazon");
    const flipkartUrl = ensureAllowed(normalizeUrl(req.query.flipkart_url), "flipkart");
    const perSiteLimit = 12;
    const maxPages = 1;

    DBG.d("params", { amazonUrl, flipkartUrl, raw: req.query });
    if (!amazonUrl && !flipkartUrl) {
      return json(res, 400, { ok:false, error:"Provide a valid Amazon and/or Flipkart listing URL (https://…)", debug: DBG.dump() });
    }

    const deadline = Date.now() + HARD_LIMIT_MS;

    // Launch Playwright Chromium
    const browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });

    const page = await browser.newPage();
    await hardenPage(page, { mobile:false });
    await page.setUserAgent(UA_DESKTOPS[0]);
    await page.setExtraHTTPHeaders({
      "accept-language": "en-IN,en;q=0.9",
      "upgrade-insecure-requests": "1",
      "referer": "https://www.google.com/"
    });

    const out = [];

    // Try Flipkart first (to know quickly if blocked), then Amazon
    const order = (amazonUrl && flipkartUrl) ? ["flipkart","amazon"] : (flipkartUrl ? ["flipkart"] : ["amazon"]);

    for (const site of order) {
      if (timeLeft(deadline) < 1500) { DBG.d(`${site}: skipped due to deadline`); continue; }

      if (site === "flipkart") {
        if (!flipkartUrl) continue;

        let gotFlipkart = false;
        let pos = 0;

        // Desktop attempt
        for (let p=1; p<=maxPages; p++) {
          if (timeLeft(deadline) < 1500) { DBG.d("deadline near, stop flipkart"); break; }
          const url = pageWithParam(flipkartUrl, p);
          const nav = await gotoWithRetries(page, url, "a[href*='/p/'], a[href*='/product/']", BASE_OPTS.timeoutMs, DBG, { detectCaptchaTitle: true });
          if (nav.captcha) { captcha.flipkart = true; DBG.d("flipkart: captcha on desktop"); break; }
          if (!nav.ok) {
            const nav2 = await gotoWithRetries(page, url, "div._1YokD2, div._2kHMtA, div.gUuXy-, div.y0S0Pe", BASE_OPTS.timeoutMs, DBG, { detectCaptchaTitle: true });
            if (nav2.captcha) { captcha.flipkart = true; DBG.d("flipkart: captcha (grid fallback)"); break; }
            if (!nav2.ok) break;
          }
          if (shotEnabled && !shotBase64) {
            shotBase64 = await page.screenshot({ type:"jpeg", quality:40, encoding:"base64" }).catch(()=>null);
          }
          await randWait(BASE_OPTS.minWaitMs, BASE_OPTS.maxWaitMs);
          await autoScroll(page, BASE_OPTS.scrollSteps, BASE_OPTS.scrollPauseMs);
          const [chunk, newPos] = await extractFlipkartList(page, flipkartUrl, pos, BASE_OPTS, perSiteLimit, DBG);
          pos = newPos; out.push(...chunk);
          if (chunk.length) gotFlipkart = true;
        }

        // Mobile fallback if needed and time remains
        if (!gotFlipkart && timeLeft(deadline) > 2500) {
          DBG.d("flipkart: trying mobile fallback");
          const mob = await browser.newPage();
          await mob.setUserAgent(UA_MOBILE);
          await hardenPage(mob, { mobile: true });
          await mob.setExtraHTTPHeaders({ "accept-language":"en-IN,en;q=0.9", "referer":"https://www.google.com/" });

          const murl = flipToMobile(flipkartUrl);
          let rv = await gotoWithRetries(mob, murl, "a[href*='/p/'], a[href*='/product/']", 6500, DBG, { detectCaptchaTitle: true });
          if (!rv.ok && !rv.captcha) {
            rv = await gotoWithRetries(mob, murl, "div._1YokD2, div._2kHMtA, div.gUuXy-, div.y0S0Pe", 6500, DBG, { detectCaptchaTitle: true });
          }
          if (rv.captcha) {
            captcha.flipkart = true;
            DBG.d("flipkart: captcha on mobile");
          } else if (rv.ok) {
            await randWait(80,160);
            await autoScroll(mob, 2, 120);
            const [chunkM] = await extractFlipkartList(mob, murl, 0, { ...BASE_OPTS, timeoutMs: 6500 }, 10, DBG);
            out.push(...chunkM);
          }
          await mob.close();
        }
      }

      if (site === "amazon") {
        if (!amazonUrl) continue;
        let pos = 0;
        for (let p=1; p<=maxPages; p++) {
          if (timeLeft(deadline) < 1500) { DBG.d("deadline near, stop amazon"); break; }
          const url = pageWithParam(amazonUrl, p);
          const nav = await gotoWithRetries(page, url, "div.s-main-slot", BASE_OPTS.timeoutMs, DBG);
          if (!nav.ok) break;
          if (shotEnabled && !shotBase64) {
            shotBase64 = await page.screenshot({ type:"jpeg", quality:40, encoding:"base64" }).catch(()=>null);
          }
          await randWait(BASE_OPTS.minWaitMs, BASE_OPTS.maxWaitMs);
          await autoScroll(page, BASE_OPTS.scrollSteps, BASE_OPTS.scrollPauseMs);
          const [chunk, newPos] = await extractAmazonList(page, amazonUrl, pos, BASE_OPTS, 12, DBG);
          pos = newPos; out.push(...chunk);
        }
      }
    }

    await browser.close();

    // de-dup
    const seen = new Set(), rows = [];
    for (const r of out) {
      const k = `${r.platform}|${r.product_url}`;
      if (seen.has(k)) continue;
      seen.add(k); rows.push(r);
    }

    const result = { ok:true, count: rows.length, rows, captcha };
    const dbg = DBG.dump();
    if (dbg) result.debug = dbg;
    if (shotEnabled && shotBase64) result.debug_screenshot = `data:image/jpeg;base64,${shotBase64}`;
    return json(res, 200, result);
  } catch (err) {
    console.error("Function error:", err);
    return json(res, 500, { ok:false, error:String(err && err.message || err) });
  }
});

// Export HTTPS function at /api/*
exports.api = functions.onRequest(RUNTIME_OPTS, app);