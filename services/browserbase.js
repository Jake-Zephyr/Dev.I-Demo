// services/browserbase.js - EXACT REPLICATION OF PYTHON SCRIPT
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
  // Extract zone
  const zoneMatch = panelText.match(
    /(Low density residential|Low-medium density residential|Medium density residential|High density residential)/i
  );
  const zone = zoneMatch ? zoneMatch[1] : null;
  
  // Extract density
  const densityMatch = panelText.match(/Residential\s+density[:\s]+(RD\d+)/i);
  const density = densityMatch ? densityMatch[1] : null;
  
  // Extract overlays
  const overlays = [];
  const overlayMatch = panelText.match(/Overlays(.*?)(?:LGIP|Local Government|Plan Zone|$)/is);
  if (overlayMatch) {
    const overlayText = overlayMatch[1];
    const lines = overlayText.split('\n').map(ln => ln.trim()).filter(ln => ln);
    const exclude = ["view section", "show on map", "overlays"];
    
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
 * Main scraper function - replicates Python script exactly
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
    
    // Step 1: Create BrowserBase session with proxy to avoid blocking
    const sessionResponse = await fetch('https://www.browserbase.com/v1/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BB-API-Key': BROWSERBASE_API_KEY
      },
      body: JSON.stringify({
        projectId: BROWSERBASE_PROJECT_ID,
        proxies: true // Enable BrowserBase's residential proxies
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

    // Step 3: Navigate and wait for React app to fully load
    console.log(`[BROWSERBASE] Navigating to ${CITYPLAN_URL}...`);
    await page.goto(CITYPLAN_URL, { 
      waitUntil: 'networkidle', // Wait for ALL network requests to finish
      timeout: 90000
    });
    
    // Wait for the loading screen to disappear
    console.log(`[BROWSERBASE] Waiting for loading screen to disappear...`);
    try {
      await page.waitForSelector('text=Loading City Plan', { state: 'hidden', timeout: 30000 });
      console.log(`[BROWSERBASE] Loading screen gone!`);
    } catch (e) {
      console.log(`[BROWSERBASE] Loading screen timeout, proceeding anyway...`);
    }
    
    // Wait for search box to appear (proves app loaded)
    console.log(`[BROWSERBASE] Waiting for search box...`);
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
        await page.waitForTimeout(2000); // Wait for dropdown change
        
        console.log(`[BROWSERBASE] Looking for Lot on Plan search box...`);
        const searchBox = page.locator("input[placeholder*='Lot on Plan' i]").first();
        await searchBox.waitFor({ state: 'visible', timeout: 10000 });
        await searchBox.click();
        await page.waitForTimeout(500);
        await searchBox.fill(cleanedQuery);
        await page.waitForTimeout(3000); // Wait for autocomplete
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
      console.log(`[BROWSERBASE] Looking for address search box...`);
      const searchBox = page.locator("input[placeholder*='Search for an address']").first();
      await searchBox.waitFor({ state: 'visible', timeout: 10000 });
      await searchBox.click();
      await page.waitForTimeout(500);
      await searchBox.fill(cleanedQuery);
      await page.waitForTimeout(3000); // Wait for autocomplete
    }
    
    // Step 5: Select first result with more explicit waiting
    console.log(`[BROWSERBASE] Selecting first result...`);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(1500); // Longer wait
    await page.keyboard.press("Enter");
    
    console.log(`[BROWSERBASE] Waiting for results to load...`);
    await page.waitForTimeout(8000); // Longer wait for results
    
    // Step 6: Extract area and lot/plan
    console.log(`[BROWSERBASE] Extracting property details...`);
    const { area, lotplan } = await extractAreaAndLotplan(page);
    result.area_sqm = area;
    result.lot_plan = lotplan;
    
    // Step 7: Wait for zone info to appear (increased timeout)
    console.log(`[BROWSERBASE] Waiting for zone information...`);
    let zoneFound = false;
    try {
      await page.waitForSelector(
        "text=/Medium density residential|Low density residential|High density residential/i",
        { timeout: 30000 } // Increased to 30 seconds
      );
      zoneFound = true;
      console.log(`[BROWSERBASE] Zone information found!`);
    } catch (e) {
      console.log(`[BROWSERBASE] Zone selector timeout, trying to extract from current page...`);
      // Continue anyway - we might still get data from text extraction
    }
    
    // Give it a bit more time if zone was found
    if (zoneFound) {
      await page.waitForTimeout(2000);
    } else {
      await page.waitForTimeout(5000); // Wait longer if zone didn't appear
    }
    
    // Step 8: Extract all text from page
    console.log(`[BROWSERBASE] Extracting page text...`);
    const panelText = await page.locator("body").innerText();
    console.log(`[BROWSERBASE] Extracted ${panelText.length} characters of text`);
    console.log(`[BROWSERBASE] First 500 chars: ${panelText.substring(0, 500)}`);
    
    // Step 9: Extract zone, density, overlays
    const extracted = extractZoneDensityOverlays(panelText);
    console.log(`[BROWSERBASE] Parsed data:`, {
      zone: extracted.zone,
      density: extracted.density,
      overlays: extracted.overlays.length
    });
    result.zone = extracted.zone;
    result.residential_density = extracted.density;
    result.overlays = extracted.overlays;
    
    // Step 10: Extract address if lotplan search
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
    
    // Format response to match API structure
    return {
      property: {
        lotplan: result.lot_plan,
        address: result.address,
        zone: result.zone,
        zoneCode: result.residential_density, // Use density as zone code for now
        density: result.residential_density,
        height: null, // Not extracted in Python script
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
    
    // Make sure to close browser on error
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
 * Debug version - returns raw text for troubleshooting
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
    
    console.log(`[DEBUG] Waiting for loading screen to disappear...`);
    await page.waitForSelector('text=Loading City Plan', { state: 'hidden', timeout: 30000 }).catch(() => {
      console.log(`[DEBUG] Loading screen timeout`);
    });
    
    console.log(`[DEBUG] Waiting for search box...`);
    await page.waitForSelector('input[placeholder*="address" i], input[placeholder*="Lot" i]', { 
      state: 'visible', 
      timeout: 30000 
    }).catch(() => {
      console.log(`[DEBUG] Search box not found`);
    });
    
    await page.waitForTimeout(5000);
    
    console.log(`[DEBUG] Extracting page data...`);
    
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
