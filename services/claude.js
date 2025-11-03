// services/browserbase.js - FIXED VERSION with address search
import { chromium } from 'playwright-core';

const BROWSERBASE_API_KEY = process.env.BROWSERBASE_API_KEY;
const BROWSERBASE_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;
const CITYPLAN_URL = "https://cityplan.goldcoast.qld.gov.au/eplan/";

if (!BROWSERBASE_API_KEY || !BROWSERBASE_PROJECT_ID) {
  console.error('⚠️  Missing BrowserBase credentials in environment variables');
}

/**
 * Format address to ensure proper comma placement
 * Examples:
 * "7 sixth avenue miami" → "7 sixth avenue, miami"
 * "7 Sixth Avenue Miami" → "7 Sixth Avenue, Miami"
 * "7 sixth avenue, miami" → "7 sixth avenue, miami" (already correct)
 */
function formatAddress(address) {
  const cleaned = address.trim();
  
  // List of Gold Coast suburbs (add more as needed)
  const suburbs = [
    'miami', 'mermaid beach', 'mermaid waters', 'broadbeach', 'surfers paradise',
    'southport', 'main beach', 'burleigh heads', 'palm beach', 'currumbin',
    'coolangatta', 'robina', 'varsity lakes', 'ashmore', 'benowa', 'bundall',
    'clear island waters', 'helensvale', 'hope island', 'labrador', 'merrimac',
    'molendinar', 'parkwood', 'runaway bay', 'biggera waters', 'coombabah',
    'arundel', 'nerang', 'highland park', 'gaven', 'oxenford', 'pacific pines',
    'coomera', 'upper coomera', 'pimpama', 'ormeau', 'jacobs well'
  ];
  
  // Check if address already has a comma
  if (cleaned.includes(',')) {
    return cleaned;
  }
  
  // Try to find suburb in the address and add comma before it
  const lowerAddress = cleaned.toLowerCase();
  
  for (const suburb of suburbs) {
    const suburbIndex = lowerAddress.lastIndexOf(suburb);
    if (suburbIndex > 0) {
      // Found suburb, add comma before it
      const beforeSuburb = cleaned.substring(0, suburbIndex).trim();
      const suburbPart = cleaned.substring(suburbIndex).trim();
      return `${beforeSuburb}, ${suburbPart}`;
    }
  }
  
  // If no suburb found, return as-is
  return cleaned;
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
  
  // Format address to ensure proper comma placement
  const formatted = formatAddress(query);
  return { type: "address", cleaned: formatted };
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
export async function scrapeProperty(query, sendProgress = null) {
  let browser = null;
  
  const { type: queryType, cleaned: cleanedQuery } = detectQueryType(query);
  
  // Log address formatting
  if (queryType === "address" && cleanedQuery !== query) {
    console.log(`[BROWSERBASE] Address formatted: "${query}" → "${cleanedQuery}"`);
    if (sendProgress) sendProgress(`Formatted address: ${cleanedQuery}`);
  }
  
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
    if (sendProgress) sendProgress(`🔍 Searching for: ${cleanedQuery}...`);
    
    // Step 1: Create BrowserBase session with proxy and stealth
    if (sendProgress) sendProgress('🌐 Connecting to browser...');
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
    if (sendProgress) sendProgress('📄 Loading Gold Coast City Plan...');
    await page.goto(CITYPLAN_URL, { 
      waitUntil: 'networkidle', 
      timeout: 90000
    });
    
    // Wait for loading screen to disappear
    console.log(`[BROWSERBASE] Waiting for loading screen to disappear...`);
    if (sendProgress) sendProgress('⏳ Waiting for page to load...');
    await page.waitForSelector('text=Loading City Plan', { state: 'hidden', timeout: 30000 }).catch(() => {
      console.log(`[BROWSERBASE] Loading screen timeout, continuing...`);
    });
    
    // Additional wait for page to settle
    await page.waitForTimeout(3000);
    
    // Check page state before waiting for search box
    const pageUrl = page.url();
    const pageTitle = await page.title();
    console.log(`[BROWSERBASE] Current URL: ${pageUrl}`);
    console.log(`[BROWSERBASE] Page title: ${pageTitle}`);
    
    // Wait for search box with better error handling
    try {
      await page.waitForSelector('input[placeholder*="address" i], input[placeholder*="Lot" i]', { 
        state: 'visible', 
        timeout: 60000  // Increased to 60 seconds
      });
      console.log(`[BROWSERBASE] Search box found!`);
    } catch (e) {
      // Debug: Check what's actually on the page
      console.log(`[BROWSERBASE] Search box not found, checking page content...`);
      const bodyText = await page.locator("body").innerText();
      console.log(`[BROWSERBASE] Page text (first 500 chars): ${bodyText.substring(0, 500)}`);
      
      // Try waiting a bit more
      console.log(`[BROWSERBASE] Waiting additional 10 seconds...`);
      await page.waitForTimeout(10000);
      
      // Try one more time
      await page.waitForSelector('input[placeholder*="address" i], input[placeholder*="Lot" i]', { 
        state: 'visible', 
        timeout: 30000 
      });
    }
    
    console.log(`[BROWSERBASE] App fully loaded! Searching for ${cleanedQuery}...`);
    if (sendProgress) sendProgress(`🔎 Searching for property: ${cleanedQuery}...`);

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
        
        // DEBUG: Log what autocomplete options are available
        const options = await page.locator('[role="option"], [class*="suggestion"] div, [class*="autocomplete"] li').allTextContents();
        console.log(`[BROWSERBASE] Autocomplete options found: ${options.length}`);
        if (options.length > 0) {
          console.log(`[BROWSERBASE] First 3 options: ${options.slice(0, 3).join(' | ')}`);
        }
        
        await page.waitForTimeout(1000); // Wait for all options to load
      } catch (e) {
        console.log(`[BROWSERBASE] No autocomplete found, continuing anyway...`);
      }
      await page.waitForTimeout(500); // Small buffer for stability
    }
    
    // Step 5: Select first result
    console.log(`[BROWSERBASE] Selecting first result...`);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(1000);
    
    console.log(`[BROWSERBASE] Pressing Enter to select...`);
    await page.keyboard.press("Enter");
    
    // CRITICAL: Wait longer for property page to fully load
    // Addresses with multiple units can take 10+ seconds
    console.log(`[BROWSERBASE] Waiting for property data to load...`);
    await page.waitForTimeout(10000); // Wait a full 10 seconds
    
    // Wait for navigation to complete
    console.log(`[BROWSERBASE] Waiting for property panel...`);
    try {
      await page.waitForSelector('#isoplan-property-detail', { 
        state: 'visible', 
        timeout: 20000 
      });
      
      // DEBUG: Log current URL and page title
      const currentUrl = page.url();
      const pageTitle = await page.title();
      console.log(`[BROWSERBASE] Current URL: ${currentUrl}`);
      console.log(`[BROWSERBASE] Page title: ${pageTitle}`);
      console.log(`[BROWSERBASE] Property panel visible!`);
      
      // SMART POLLING: Check every second if content loaded (max 15 seconds)
      console.log(`[BROWSERBASE] Smart polling for content to load...`);
      let contentLoaded = false;
      const maxPolls = 15; // Max 15 seconds
      
      for (let i = 0; i < maxPolls; i++) {
        // Check if we have substantial content
        const bodyText = await page.locator("body").innerText();
        const hasLotPlan = /Lot\/Plan/i.test(bodyText);
        const hasZone = /density|zone|overlay/i.test(bodyText);
        const hasSubstantialContent = bodyText.length > 800; // At least 800 chars
        
        if ((hasLotPlan || hasZone) && hasSubstantialContent) {
          console.log(`[BROWSERBASE] Content detected after ${i + 1} seconds! (${bodyText.length} chars)`);
          contentLoaded = true;
          await page.waitForTimeout(2000); // Small buffer for final bits
          break;
        }
        
        console.log(`[BROWSERBASE] Poll ${i + 1}/${maxPolls}: ${bodyText.length} chars, waiting...`);
        await page.waitForTimeout(1000); // Wait 1 second before next check
      }
      
      if (!contentLoaded) {
        console.log(`[BROWSERBASE] Content polling timed out, proceeding anyway...`);
      }
      
    } catch (e) {
      console.log(`[BROWSERBASE] Property panel timeout, using fallback...`);
      await page.waitForTimeout(10000);
    }
    
    // Step 6: Extract area and lot/plan
    console.log(`[BROWSERBASE] Extracting property details...`);
    if (sendProgress) sendProgress('📊 Extracting property details...');
    const { area, lotplan } = await extractAreaAndLotplan(page);
    result.area_sqm = area;
    result.lot_plan = lotplan;
    
    // Step 7: Smart polling for zone and overlay information
    console.log(`[BROWSERBASE] Smart polling for zone/overlay data...`);
    if (sendProgress) sendProgress('🏗️ Analyzing zoning and overlays...');
    let zoneLoaded = false;
    const maxZonePolls = 12; // Max 12 seconds
    let lastOverlayCount = 0;
    let stableCount = 0;
    
    for (let i = 0; i < maxZonePolls; i++) {
      const bodyText = await page.locator("body").innerText();
      const hasZone = /density residential|residential zone|industry|centre|rural/i.test(bodyText);
      const hasOverlays = /Overlays/i.test(bodyText);
      
      // Count how many overlay lines we have
      const overlayMatch = bodyText.match(/Overlays(.*?)(?:LGIP|Local Government|$)/is);
      let currentOverlayCount = 0;
      if (overlayMatch) {
        const lines = overlayMatch[1].split('\n').filter(ln => ln.trim().length > 10);
        currentOverlayCount = lines.length;
      }
      
      if (hasZone && hasOverlays) {
        // Check if overlay count is stable (not increasing anymore)
        if (currentOverlayCount === lastOverlayCount && currentOverlayCount > 0) {
          stableCount++;
          if (stableCount >= 2) { // Stable for 2 checks = done loading
            console.log(`[BROWSERBASE] Zone and overlays fully loaded after ${i + 1} seconds! (${currentOverlayCount} overlays)`);
            zoneLoaded = true;
            await page.waitForTimeout(1000); // Small final buffer
            break;
          }
        } else {
          stableCount = 0; // Reset if still changing
        }
        
        console.log(`[BROWSERBASE] Poll ${i + 1}: Zone found, ${currentOverlayCount} overlays (stable: ${stableCount}/2)`);
        lastOverlayCount = currentOverlayCount;
      } else if (hasZone) {
        console.log(`[BROWSERBASE] Poll ${i + 1}: Zone found, waiting for overlays...`);
      } else {
        console.log(`[BROWSERBASE] Poll ${i + 1}: Waiting for zone...`);
      }
      
      await page.waitForTimeout(1000);
    }
    
    if (!zoneLoaded) {
      console.log(`[BROWSERBASE] Zone/overlay polling timed out, proceeding anyway...`);
      await page.waitForTimeout(1000);
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
