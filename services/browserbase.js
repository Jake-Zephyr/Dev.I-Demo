// services/browserbase.js — FAST & ROBUST
// Requires: playwright-core
import { chromium } from 'playwright-core';

const BROWSERBASE_API_KEY = process.env.BROWSERBASE_API_KEY;
const BROWSERBASE_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;
const CITYPLAN_URL = "https://cityplan.goldcoast.qld.gov.au/eplan/";

if (!BROWSERBASE_API_KEY || !BROWSERBASE_PROJECT_ID) {
  console.error('⚠️  Missing BrowserBase credentials in environment variables');
}

/* =========================
 * SMART WAITS & UTILITIES
 * ========================= */

async function retry(fn, { tries = 2, delayMs = 700 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { lastErr = e; }
    if (i < tries - 1) await new Promise(r => setTimeout(r, delayMs));
  }
  throw lastErr;
}

// Wait until #isoplan-property-detail has real content (MutationObserver)
async function waitForPanelPopulated(page, { panel = '#isoplan-property-detail', minChars = 800, timeout = 15000 } = {}) {
  const ok = await page.evaluate(({ panel, minChars, timeout }) => new Promise(resolve => {
    const root = document.querySelector(panel);
    if (!root) return resolve(false);
    const textLen = () => (root.innerText || '').trim().length;
    if (textLen() >= minChars) return resolve(true);

    const mo = new MutationObserver(() => {
      if (textLen() >= minChars) { mo.disconnect(); resolve(true); }
    });
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    setTimeout(() => { mo.disconnect(); resolve(false); }, timeout);
  }), { panel, minChars, timeout });
  return ok;
}

// Robust zoning wait (selectors + regex sweep)
async function waitForZoneText(page, { timeout = 15000 } = {}) {
  const candidates = [
    '[data-test="zone"]',
    '#isoplan-property-detail [data-section="zoning"]',
    'text=/density\\s+residential/i',
    'text=/impact\\s+industry/i',
    'text=/centre/i',
    'text=/rural/i'
  ];
  const deadline = Date.now() + timeout;

  for (const sel of candidates) {
    try { await page.waitForSelector(sel, { timeout: Math.max(500, deadline - Date.now()) }); return true; } catch {}
  }

  const zoneRegex = /\b(?:very\s+)?(?:low|low-medium|medium|high)\s+density\s+residential\b|\b(?:low|medium|high)\s+impact\s+industry\b|centre|rural/i;
  while (Date.now() < deadline) {
    const t = await page.evaluate(() => document.body.innerText || '');
    if (zoneRegex.test(t)) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

// OPTIONAL: gate on the XHR that carries detail (pathPart may be adjusted)
async function waitForPropertyXHR(page, { pathPart = '/eplan/', timeout = 12000 } = {}) {
  try {
    await page.waitForResponse(r => r.url().includes(pathPart) && r.status() === 200, { timeout });
  } catch { /* non-fatal */ }
}

/* =========================
 * QUERY TYPE DETECTION
 * ========================= */

function detectQueryType(query) {
  const q = query.trim();
  const normalized = q.replace(/\bon\b/gi, '/').replace(/\blot\b/gi, '').replace(/\s+/g, ' ').trim();

  // "1/SP123456", "12/RP34567", "5/RP123456" or "12 RP34567"
  const slashPattern = /\b(\d+)\s*\/\s*([A-Z]{1,4}\d{2,7})\b/i;
  const spacePattern = /\b(\d+)\s+([A-Z]{1,4}\d{2,7})\b/i;

  let m = normalized.match(slashPattern) || normalized.match(spacePattern);
  if (m) {
    const lot = m[1];
    const plan = m[2].toUpperCase();
    return { type: 'lotplan', cleaned: `${lot}/${plan}`, lot, plan };
  }
  return { type: 'address', cleaned: q };
}

/* =========================
 * EXTRACTION HELPERS
 * ========================= */

async function extractAreaAndLotplan(page) {
  let area = null;
  let lotplan = null;

  try {
    const container = page.locator("#isoplan-property-detail");
    const divs = container.locator("div");
    const count = await divs.count();

    for (let i = 0; i < count; i++) {
      try {
        const txt = await divs.nth(i).innerText({ timeout: 800 });

        if (!area) {
          const areaMatch = txt.match(/(?:Plan\s*Area|Site\s*Area|Area)\s*[:\-]?\s*([\d.,]+)\s*m[²2]/i);
          if (areaMatch) area = areaMatch[1].replace(/,/g, "");
        }

        if (!lotplan) {
          // Accept "Lot/Plan", "Lot on Plan", and raw "1/SP123456"
          const lp1 = txt.match(/Lot\s*\/\s*Plan\s*[:\-]?\s*([A-Za-z0-9/ ]+)/i);
          const lp2 = txt.match(/Lot\s*on\s*Plan\s*[:\-]?\s*([A-Za-z0-9/ ]+)/i);
          const lp3 = txt.match(/\b(\d+)\s*\/\s*([A-Z]{1,4}\d{2,8})\b/);
          const lp4 = txt.match(/\bLot\s*(\d+)\s*[–-]?\s*([A-Z]{1,4}\d{2,8})\b/i);

          const pick = lp1?.[1] || lp2?.[1] || (lp3 ? `${lp3[1]}/${lp3[2]}` : null) || (lp4 ? `${lp4[1]}/${lp4[2].toUpperCase()}` : null);
          if (pick) lotplan = pick.replace(/\s+/g, '').toUpperCase();
        }

        if (area && lotplan) break;
      } catch {/* keep scanning */}
    }
  } catch (e) {
    console.error('[EXTRACT] Error extracting area/lotplan:', e.message);
  }

  return { area, lotplan };
}

function extractZoneDensityOverlays(panelText) {
  // Zoning (order matters—most specific first)
  const zoneRegexes = [
    /\bhigh\s+density\s+residential\b/i,
    /\blow[-\s]?medium\s+density\s+residential\b/i,
    /\bmedium\s+density\s+residential\b/i,
    /\blow\s+density\s+residential\b/i,
    /\bhigh\s+impact\s+industry\b/i,
    /\bmedium\s+impact\s+industry\b/i,
    /\blow\s+impact\s+industry\b/i,
    /\bmajor\s+centre\b/i,
    /\bdistrict\s+centre\b/i,
    /\bneighbourhood\s+centre\b/i,
    /\bcommunity\s+facilities?\b/i,
    /\brural\s+residential\b/i,
    /\brural\b/i,
    /\benvironmental\s+management\s+and\s+conservation\b/i,
    /\bopen\s+space\b/i,
    /\bspecial\s+purpose\b/i,
    /\bsport\s+and\s+recreation\b/i,
    /\btourist\s+accommodation\b/i
  ];
  const zone = (zoneRegexes.map(r => (panelText.match(r)?.[0] || null)).find(Boolean)) || null;

  // Density code: RDxx or shorthand (ldr/mdr/hdr)
  let density = null;
  const dens = panelText.match(/\b(RD\d{1,3})\b/i) ||
               panelText.match(/\b(?:ldr|mdr|hdr)\b/i);
  if (dens) density = dens[1] ? dens[1].toUpperCase() : dens[0].toUpperCase();

  // Overlays section slicing
  const overlays = [];
  const overlayBlock = panelText.match(/Overlays(.*?)(?:LGIP|Local Government Infrastructure Plan|Plan Zone|Zoning|$)/is);
  if (overlayBlock) {
    const lines = overlayBlock[1].split('\n').map(s => s.trim()).filter(Boolean);
    const exclude = new Set(['view section','show on map','overlays','powered by','map and location','map tools','map layers']);
    for (const ln of lines) {
      const low = ln.toLowerCase();
      if ([...exclude].some(x => low.includes(x))) continue;
      if (ln.length > 4 && !overlays.includes(ln)) overlays.push(ln);
    }
  }

  return { zone, density, overlays };
}

/* =========================
 * MAIN SCRAPER
 * ========================= */

export async function scrapeProperty(query) {
  let browser = null;

  const { type: queryType, cleaned: cleanedQuery } = detectQueryType(query);

  const timings = { t0: Date.now() };
  const result = {
    query,
    query_type: queryType,
    lot_plan: null,
    address: null,
    zone: null,
    residential_density: null,
    area_sqm: null,
    overlays: [],
    success: false,
    error: null
  };

  try {
    console.log(`[BROWSERBASE] Starting scrape for: ${query} (${queryType})`);

    // 1) Create BrowserBase session
    const sessionResponse = await fetch('https://www.browserbase.com/v1/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BB-API-Key': BROWSERBASE_API_KEY
      },
      body: JSON.stringify({
        projectId: BROWSERBASE_PROJECT_ID,
        proxies: true
      })
    });

    if (!sessionResponse.ok) {
      const errorText = await sessionResponse.text();
      throw new Error(`Failed to create session: ${sessionResponse.statusText} - ${errorText}`);
    }

    const session = await sessionResponse.json();
    const sessionId = session.id;
    console.log(`[BROWSERBASE] Session created: ${sessionId}`);

    // 2) Connect Playwright to BrowserBase (CDP)
    const wsUrl = `wss://connect.browserbase.com?apiKey=${BROWSERBASE_API_KEY}&sessionId=${sessionId}`;
    browser = await chromium.connectOverCDP(wsUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();
    console.log(`[BROWSERBASE] Connected to remote browser`);

    // 3) Navigate and app ready
    console.log(`[BROWSERBASE] Navigating to ${CITYPLAN_URL}...`);
    await page.goto(CITYPLAN_URL, { waitUntil: 'networkidle', timeout: 90000 });

    // Wait for loading screen to disappear & search input visible
    console.log(`[BROWSERBASE] Waiting for loading screen to disappear...`);
    await page.waitForSelector('text=Loading City Plan', { state: 'hidden', timeout: 30000 }).catch(() => {
      console.log(`[BROWSERBASE] Loading screen timeout, continuing...`);
    });

    await page.waitForSelector('input[placeholder*="address" i], input[placeholder*="Lot" i]', {
      state: 'visible',
      timeout: 30000
    });

    console.log(`[BROWSERBASE] App fully loaded! Searching for ${cleanedQuery}...`);

    // 4) Search path
    if (queryType === 'lotplan') {
      // Try the Lot on Plan UI first
      try {
        console.log(`[BROWSERBASE] Selecting "Lot on Plan" search...`);
        const dropdown = page.locator("select[name='selectedSearch']").first();
        await dropdown.waitFor({ state: 'visible', timeout: 10000 });
        await dropdown.selectOption({ label: "Lot on Plan" });

        const searchBox = page.locator("input[placeholder*='Lot on Plan' i]").first();
        await searchBox.waitFor({ state: 'visible', timeout: 10000 });
        await searchBox.click();
        await page.waitForTimeout(150);
        await searchBox.fill(cleanedQuery);
        await page.waitForTimeout(300);

        // Select first suggestion (if list appears), else Enter
        const hasOpts = await page.$('[role="option"], [class*="suggestion"], [class*="autocomplete"] li');
        if (hasOpts) {
          await page.waitForSelector('[role="option"], [class*="suggestion"], [class*="autocomplete"] li', { timeout: 8000 });
          await page.keyboard.press('ArrowDown');
          await page.keyboard.press('Enter');
        } else {
          await page.keyboard.press('Enter');
        }
      } catch (e) {
        console.log(`[BROWSERBASE] Lot/Plan path failed: ${e.message}, falling back to address box`);
        await retry(async () => {
          const searchBox = page.locator("input[placeholder*='Search for an address']").first();
          await searchBox.waitFor({ state: 'visible', timeout: 10000 });
          await searchBox.click();
          await page.waitForTimeout(150);
          await searchBox.fill(cleanedQuery, { timeout: 8000 });
          await page.waitForSelector('[role="option"], [class*="suggestion"], [class*="autocomplete"] li', { state: 'visible', timeout: 8000 });
          await page.keyboard.press('ArrowDown');
          await page.keyboard.press('Enter');
        }, { tries: 2, delayMs: 700 });
      }
    } else {
      // Address path with auto-retry
      await retry(async () => {
        console.log(`[BROWSERBASE] Address search path...`);
        const searchBox = page.locator("input[placeholder*='Search for an address']").first();
        await searchBox.waitFor({ state: 'visible', timeout: 10000 });
        await searchBox.click();
        await page.waitForTimeout(150);
        await searchBox.fill(cleanedQuery, { timeout: 8000 });

        console.log(`[BROWSERBASE] Waiting for autocomplete dropdown...`);
        await page.waitForSelector('[role="option"], [class*="suggestion"], [class*="autocomplete"] li', { state: 'visible', timeout: 8000 });

        console.log(`[BROWSERBASE] Selecting first result...`);
        await page.keyboard.press("ArrowDown");
        await page.waitForTimeout(80);
        await page.keyboard.press("Enter");
      }, { tries: 2, delayMs: 700 });
    }

    // 5) Confirm navigation & content ready (content-aware)
    console.log(`[BROWSERBASE] Waiting for property page to load...`);
    await Promise.race([
      page.waitForSelector('#isoplan-property-detail', { state: 'visible', timeout: 20000 }),
      page.waitForFunction(() => document.title && document.title.length > 0, { timeout: 15000 })
    ]);
    timings.panelVisible = Date.now();

    // Prefer to wait for detail XHR (non-fatal if it doesn't match)
    await waitForPropertyXHR(page, { pathPart: '/eplan/', timeout: 12000 }).catch(()=>{});

    const populated = await waitForPanelPopulated(page, { panel: '#isoplan-property-detail', minChars: 800, timeout: 15000 });
    timings.panelPopulated = Date.now();

    if (!populated) {
      console.log('[BROWSERBASE] Panel under-populated, reselecting first result once...');
      const searchBox = page.locator("input[placeholder*='Search for an address']").first();
      if (await searchBox.count()) {
        await searchBox.click();
        await page.keyboard.press('Enter');
        await page.waitForSelector('#isoplan-property-detail', { timeout: 12000 }).catch(()=>{});
        await waitForPanelPopulated(page, { panel: '#isoplan-property-detail', minChars: 800, timeout: 12000 });
      } else {
        // small grace wait
        await page.waitForTimeout(800);
      }
    }

    // Lock in zoning presence (selectors + regex)
    await waitForZoneText(page, { timeout: 15000 }).catch(()=>{});

    // 6) Extract from the PANEL (not body)
    const PANEL = '#isoplan-property-detail';
    let panelText = await page.evaluate(sel => (document.querySelector(sel)?.innerText || '').trim(), PANEL);
    console.log(`[BROWSERBASE] Extracted ${panelText.length} chars from panel`);

    // Quick pulse if still thin
    if (panelText.length < 800) {
      await page.waitForTimeout(700);
      const retryText = await page.evaluate(sel => (document.querySelector(sel)?.innerText || '').trim(), PANEL);
      if (retryText.length > panelText.length) {
        console.log(`[BROWSERBASE] Panel grew from ${panelText.length} to ${retryText.length} chars`);
        panelText = retryText;
      }
    }

    // 7) Parse details
    const { area, lotplan } = await extractAreaAndLotplan(page);
    result.area_sqm = area;
    result.lot_plan = lotplan;

    const extracted = extractZoneDensityOverlays(panelText);
    result.zone = extracted.zone;
    result.residential_density = extracted.density;
    result.overlays = extracted.overlays;

    // 8) Address backfill
    if (queryType === "lotplan") {
      const addressMatch = panelText.match(/(\d+\s+[A-Za-z\s]+(?:Street|Road|Avenue|Court|Lane|Drive|Way|Place|Crescent|Boulevard|Parade|Terrace|Close|Quay)[,\s]+[A-Za-z\s]+)/i);
      if (addressMatch) result.address = addressMatch[1].trim();
    } else {
      result.address = cleanedQuery;
    }

    result.success = true;
    timings.done = Date.now();
    console.log(`[BROWSERBASE] Scraping complete!`);

    // 9) Close
    await browser.close();

    // 10) Format response
    return {
      property: {
        lotplan: result.lot_plan,
        address: result.address,
        zone: result.zone,
        zoneCode: result.residential_density,
        density: result.residential_density,
        height: null,
        area: result.area_sqm ? `${result.area_sqm}sqm` : null,
        overlays: result.overlays
      },
      planningContext: {
        zoneDescription: null,
        lapRequirements: null,
        overlayRestrictions: null
      },
      metrics: {
        panelVisibleMs: timings.panelVisible ? (timings.panelVisible - timings.t0) : null,
        panelPopulatedMs: timings.panelPopulated ? (timings.panelPopulated - timings.t0) : null,
        totalMs: timings.done ? (timings.done - timings.t0) : null
      },
      scrapedAt: new Date().toISOString()
    };

  } catch (error) {
    console.error('[BROWSERBASE ERROR]', error);
    result.error = error.message;

    if (browser) {
      try { await browser.close(); } catch (e) { console.error('[BROWSERBASE] Failed to close browser:', e); }
    }

    throw new Error(`Scraping failed: ${error.message}`);
  }
}

/* =========================
 * DEBUG SCRAPER
 * ========================= */

export async function scrapePropertyDebug(query) {
  let browser = null;
  try {
    const sessionResponse = await fetch('https://www.browserbase.com/v1/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BB-API-Key': BROWSERBASE_API_KEY
      },
      body: JSON.stringify({
        projectId: BROWSERBASE_PROJECT_ID,
        proxies: true
      })
    });

    const session = await sessionResponse.json();
    const wsUrl = `wss://connect.browserbase.com?apiKey=${BROWSERBASE_API_KEY}&sessionId=${session.id}`;

    browser = await chromium.connectOverCDP(wsUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();

    await page.goto(CITYPLAN_URL, { waitUntil: 'networkidle', timeout: 90000 });
    await page.waitForSelector('text=Loading City Plan', { state: 'hidden', timeout: 30000 }).catch(() => {});
    await page.waitForSelector('input[placeholder*="address" i], input[placeholder*="Lot" i]', { state: 'visible', timeout: 30000 }).catch(() => {});

    await page.waitForTimeout(1500);

    const title = await page.title();
    const url = page.url();
    const bodyText = await page.locator("body").innerText();
    const html = await page.content();

    await browser.close();

    return {
      url,
      title,
      bodyTextLength: bodyText.length,
      bodyTextPreview: bodyText.substring(0, 2000),
      htmlLength: html.length,
      htmlPreview: html.substring(0, 1000)
    };
  } catch (error) {
    if (browser) await browser.close();
    throw error;
  }
}
