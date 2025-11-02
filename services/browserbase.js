// services/browserbase.js - FIXED VERSION with address search
import { chromium } from 'playwright-core';

const BROWSERBASE_API_KEY = process.env.BROWSERBASE_API_KEY;
const BROWSERBASE_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;
const CITYPLAN_URL = "https://cityplan.goldcoast.qld.gov.au/eplan/";

if (!BROWSERBASE_API_KEY || !BROWSERBASE_PROJECT_ID) {
  console.error('⚠️  Missing BrowserBase credentials in environment variables');
}

/**
 * Detect if query is an address or lot/plan
 */
function detectQueryType(query) {
  const lotplanPattern = /\b(\d+[A-Z]{1,4}\d+)\b/i;
  const match = query.match(lotplanPattern);
  if (match) {
    return { type: "lotplan", cleaned: match[1].toUpperCase() };
  }
  return { type: "address", cleaned: query.trim() };
}

/**
 * Extract area and lot/plan from property detail card
 */
async function extractAreaAndLotplan(page) {
  let area = null;
  let lotplan = null;
  
  try {
    const container = page.locator("#isoplan-property-detail");
    const divs = container.locator("div");
    const count = await divs.count();

    for (let i = 0; i < count; i++) {
      try {
        const txt = await divs.nth(i).innerText({ timeout: 1000 });
        
        if (!area) {
          const areaMatch = txt.match(/Plan\s*Area\s*([\d.,]+)\s*m[²2]/i);
          if (areaMatch) {
            area = areaMatch[1].replace(/,/g, "");
          }
        }
        
        if (!lotplan) {
          const lotplanMatch = txt.match(/Lot\/Plan\s+(\w+)/i);
          if (lotplanMatch) {
            lotplan = lotplanMatch[1];
          }
        }
      } catch (e) {
        // Continue to next div
      }
    }
  } catch (e) {
    console.error('[EXTRACT] Error extracting area/lotplan:', e.message);
  }
  
  return { area, lotplan };
}

/**
 * Extract zone, density, and overlays from panel text
 */
function extractZoneDensityOverlays(panelText) {
  // Extract zone - expanded to cover more zone types
  const zoneMatch = panelText.match(
    /(Low density residential|Low-medium density residential|Medium density residential|High density residential|High impact industry|Low impact industry|Medium impact industry|Community facilities|Major centre|District centre|Neighbourhood centre|Rural|Rural residential|Environmental management and conservation|Open space|Special purpose|Sport and recreation|Tourist accommodation)/i
  );
  const zone = zoneMatch ? zoneMatch[1] : null;
  
  // Extract density - try multiple patterns
  let density = null;
  const densityMatch1 = panelText.match(/Residential\s+density[:\s]+(RD\d+)/i);
  const densityMatch2 = panelText.match(/\b(RD\d+)\b/); // Just find RD followed by numbers anywhere
  
  if (densityMatch1) {
    density = densityMatch1[1];
  } else if (densityMatch2) {
    density = densityMatch2[1];
  }
  
  // Extract overlays
  const overlays = [];
  const overlayMatch = panelText.match(/Overlays(.*?)(?:LGIP|Local Government Infrastructure Plan|Plan Zone|$)/is);
  if (overlayMatch) {
    const overlayText = overlayMatch[1];
    const lines = overlayText.split('\n').map(ln => ln.trim()).filter(ln => ln);
    const exclude = ["view section", "show on map", "overlays", "powered by", "map and location", "map tools", "map layers"];
    
    for (const ln of lines) {
      if (exclude.some(ex => ln.toLowerCase().includes(ex))) continue;
      if (ln.length > 5 && !overlays.includes(ln)) {
        overlays.push(ln);
      }
    }
  }
  
  return { zone, density, overlays };
}

/**
 * Main scraper function
 */
export async function scrapeProperty(query) {
  let browser = null;
  
  const { type: queryType, cleaned: cleanedQuery } = detectQueryType(query);
  
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
    
    // Step 1: Create BrowserBase session with proxy and stealth
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

    // Step 2: Connect Playwright to BrowserBase
    const wsUrl = `wss://connect.browserbase.com?apiKey=${BROWSERBASE_API_KEY}&sessionId=${sessionId}`;
    
    browser = await chromium.connectOverCDP(wsUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();
    
    console.log(`[BROWSERBASE] Connected to remote browser`);

    // Step 3: Navigate and wait for page to load
    console.log(`[BROWSERBASE] Navigating to ${CITYPLAN_URL}...`);
    await page.goto(CITYPLAN_URL, { 
      waitUntil: 'networkidle', 
      timeout: 90000
    });
    
    // Wait for loading screen to disappear
    console.log(`[BROWSERBASE] Waiting for loading screen to disappear...`);
    await page.waitForSelector('text=Loading City Plan', { state: 'hidden', timeout: 30000 }).catch(() => {
      console.log(`[BROWSERBASE] Loading screen timeout, continuing...`);
    });
    
    // Wait for search box
    await page.waitForSelector('input[placeholder*="address" i], input[placeholder*="Lot" i]', { 
      state: 'visible', 
      timeout: 30000 
    });
    
    console.log(`[BROWSERBASE] App fully loaded! Searching for ${cleanedQuery}...`);

    // Step 4: Handle search based on query type
    if (queryType === "lotplan") {
      try {
        console.log(`[BROWSERBASE] Looking for Lot on Plan dropdown...`);
        const dropdown = page.locator("select[name='selectedSearch']").first();
        await dropdown.waitFor({ state: 'visible', timeout: 10000 });
        await dropdown.selectOption({ label: "Lot on Plan" });
        await page.waitForTimeout(2000);
        
        console.log(`[BROWSERBASE] Looking for Lot on Plan search box...`);
        const searchBox = page.locator("input[placeholder*='Lot on Plan' i]").first();
        await searchBox.waitFor({ state: 'visible', timeout: 10000 });
        await searchBox.click();
        await page.waitForTimeout(500);
        await searchBox.fill(cleanedQuery);
        await page.waitForTimeout(3000);
      } catch (e) {
        console.log(`[BROWSERBASE] Dropdown approach failed: ${e.message}, trying default search`);
        const searchBox = page.locator("input[placeholder*='Search for an address']").first();
        await searchBox.waitFor({ state: 'visible', timeout: 10000 });
        await searchBox.click();
        await page.waitForTimeout(500);
        await searchBox.fill(cleanedQuery);
        await page.waitForTimeout(3000);
      }
    } else {
      // Address search
      console.log(`[BROWSERBASE] Looking for address search box...`);
      const searchBox = page.locator("input[placeholder*='Search for an address']").first();
      await searchBox.waitFor({ state: 'visible', timeout: 10000 });
      await searchBox.click();
      await page.waitForTimeout(500);
      
      console.log(`[BROWSERBASE] Typing address: ${cleanedQuery}`);
      await searchBox.fill(cleanedQuery);
      
      // Wait for autocomplete to appear (smart wait!)
      console.log(`[BROWSERBASE] Waiting for autocomplete dropdown...`);
      try {
        await page.waitForSelector('[role="option"], [class*="suggestion"], [class*="autocomplete"] li', { 
          state: 'visible', 
          timeout: 8000 
        });
        console.log(`[BROWSERBASE] Autocomplete appeared!`);
      } catch (e) {
        console.log(`[BROWSERBASE] No autocomplete found, continuing anyway...`);
      }
      await page.waitForTimeout(500); // Small buffer for stability
    }
    
    // Step 5: Select first result
    console.log(`[BROWSERBASE] Selecting first result...`);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(500);
    await page.keyboard.press("Enter");
    
    // Wait for navigation to complete (smart wait!)
    console.log(`[BROWSERBASE] Waiting for property page to load...`);
    try {
      // Wait for URL to change or property panel to appear
      await Promise.race([
        page.waitForURL(/.*/, { waitUntil: 'domcontentloaded', timeout: 15000 }),
        page.waitForSelector('#isoplan-property-detail', { state: 'visible', timeout: 15000 })
      ]);
      console.log(`[BROWSERBASE] Property page loaded!`);
      
      // CRITICAL: Wait for actual content to populate
      console.log(`[BROWSERBASE] Waiting for property content to populate...`);
      try {
        // Wait for either zone text or lot/plan text to appear (proves content loaded)
        await Promise.race([
          page.waitForSelector('text=/Lot\\/Plan/i', { timeout: 15000 }),
          page.waitForSelector('text=/density|zone|overlay/i', { timeout: 15000 })
        ]);
        console.log(`[BROWSERBASE] Property content detected!`);
        await page.waitForTimeout(3000); // Buffer for rest of content
      } catch (e) {
        console.log(`[BROWSERBASE] Content timeout, using longer fallback...`);
        // Wait longer for address searches since they're slower
        await page.waitForTimeout(8000);
      }
    } catch (e) {
      console.log(`[BROWSERBASE] Navigation timeout, using fallback wait...`);
      await page.waitForTimeout(12000);
    }
    
    // Step 6: Extract area and lot/plan
    console.log(`[BROWSERBASE] Extracting property details...`);
    const { area, lotplan } = await extractAreaAndLotplan(page);
    result.area_sqm = area;
    result.lot_plan = lotplan;
    
    // Step 7: Wait for zone info to appear (smart wait!)
    console.log(`[BROWSERBASE] Waiting for zone information...`);
    try {
      await page.waitForSelector(
        "text=/density residential|residential zone|industry|centre|rural/i",
        { timeout: 20000 }
      );
      console.log(`[BROWSERBASE] Zone info detected!`);
      
      // Wait specifically for overlays section (it loads last)
      console.log(`[BROWSERBASE] Waiting for overlays section...`);
      try {
        await page.waitForSelector('text=/Overlays/i', { timeout: 10000 });
        console.log(`[BROWSERBASE] Overlays section detected!`);
        await page.waitForTimeout(2000); // Buffer for overlay list to populate
      } catch (e) {
        console.log(`[BROWSERBASE] Overlays section not found, continuing...`);
        await page.waitForTimeout(2000);
      }
    } catch (e) {
      console.log(`[BROWSERBASE] Zone not found, waiting anyway...`);
      await page.waitForTimeout(5000);
    }
    
    // Step 8: Extract all text
    console.log(`[BROWSERBASE] Extracting page text...`);
    const panelText = await page.locator("body").innerText();
    console.log(`[BROWSERBASE] Extracted ${panelText.length} characters of text`);
    
    // Step 9: Extract zone, density, overlays
    const extracted = extractZoneDensityOverlays(panelText);
    result.zone = extracted.zone;
    result.residential_density = extracted.density;
    result.overlays = extracted.overlays;
    
    // Step 10: Extract address
    if (queryType === "lotplan") {
      const addressMatch = panelText.match(
        /(\d+\s+[A-Za-z\s]+(?:Street|Road|Avenue|Court|Lane|Drive|Way|Place|Crescent)[,\s]+[A-Za-z\s]+)/i
      );
      if (addressMatch) {
        result.address = addressMatch[1].trim();
      }
    } else {
      result.address = cleanedQuery;
    }
    
    result.success = true;
    console.log(`[BROWSERBASE] Scraping complete!`);
    
    // Step 11: Close browser
    await browser.close();
    
    // Format response
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
      scrapedAt: new Date().toISOString()
    };

  } catch (error) {
    console.error('[BROWSERBASE ERROR]', error);
    result.error = error.message;
    
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error('[BROWSERBASE] Failed to close browser:', e);
      }
    }
    
    throw new Error(`Scraping failed: ${error.message}`);
  }
}

/**
 * Debug version
 */
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
    
    console.log(`[DEBUG] Navigating to ${CITYPLAN_URL}...`);
    await page.goto(CITYPLAN_URL, { waitUntil: 'networkidle', timeout: 90000 });
    
    console.log(`[DEBUG] Waiting for loading screen...`);
    await page.waitForSelector('text=Loading City Plan', { state: 'hidden', timeout: 30000 }).catch(() => {});
    
    await page.waitForSelector('input[placeholder*="address" i], input[placeholder*="Lot" i]', { 
      state: 'visible', 
      timeout: 30000 
    }).catch(() => {});
    
    await page.waitForTimeout(5000);
    
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
