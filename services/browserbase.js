// services/browserbase.js - PROPER PLAYWRIGHT INTEGRATION
import { chromium } from 'playwright-core';

const BROWSERBASE_API_KEY = process.env.BROWSERBASE_API_KEY;
const BROWSERBASE_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;

if (!BROWSERBASE_API_KEY || !BROWSERBASE_PROJECT_ID) {
  console.error('⚠️  Missing BrowserBase credentials in environment variables');
}

/**
 * Scrapes Gold Coast City Plan for property information using Playwright on BrowserBase
 * @param {string} query - Lot/plan (e.g., "12RP39932") or address (e.g., "22 Mary Avenue, Broadbeach")
 * @returns {Promise<Object>} Property data with zoning, density, height, overlays, and planning context
 */
export async function scrapeProperty(query) {
  let browser = null;
  
  try {
    console.log(`[BROWSERBASE] Starting scrape for: ${query}`);
    
    // Step 1: Create BrowserBase session and get WebSocket URL
    const sessionResponse = await fetch('https://www.browserbase.com/v1/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BB-API-Key': BROWSERBASE_API_KEY
      },
      body: JSON.stringify({
        projectId: BROWSERBASE_PROJECT_ID
      })
    });

    if (!sessionResponse.ok) {
      const errorText = await sessionResponse.text();
      throw new Error(`Failed to create session: ${sessionResponse.statusText} - ${errorText}`);
    }

    const session = await sessionResponse.json();
    const sessionId = session.id;
    console.log(`[BROWSERBASE] Session created: ${sessionId}`);

    // Step 2: Connect Playwright to BrowserBase's remote browser
    const wsUrl = `wss://connect.browserbase.com?apiKey=${BROWSERBASE_API_KEY}&sessionId=${sessionId}`;
    
    browser = await chromium.connectOverCDP(wsUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();
    
    console.log(`[BROWSERBASE] Connected to remote browser`);

    // Step 3: Navigate to Gold Coast City Plan
    console.log(`[BROWSERBASE] Navigating to Gold Coast City Plan...`);
    await page.goto('https://cityplan.goldcoast.qld.gov.au/eplan/', {
      waitUntil: 'networkidle',
      timeout: 60000
    });

    console.log(`[BROWSERBASE] Page loaded, looking for search box...`);

    // Step 4: Wait for and fill search box
    // Adjust these selectors based on the actual Gold Coast website structure
    await page.waitForSelector('input[type="text"], input[type="search"]', { timeout: 30000 });
    
    const searchBox = await page.locator('input[type="text"], input[type="search"]').first();
    await searchBox.fill(query);
    await searchBox.press('Enter');

    console.log(`[BROWSERBASE] Search submitted, waiting for results...`);

    // Step 5: Wait for results to load
    await page.waitForTimeout(5000); // Wait 5 seconds for results

    // Step 6: Extract property data
    // This is a basic extraction - you'll need to adjust selectors based on actual page structure
    const propertyData = await page.evaluate(() => {
      // Look for common text patterns on the results page
      const bodyText = document.body.innerText;
      
      // Extract zone
      const zoneMatch = bodyText.match(/Zone[:\s]+([A-Za-z\s]+?)(?:\n|$|Zone Code)/i);
      const zone = zoneMatch ? zoneMatch[1].trim() : null;
      
      // Extract zone code
      const zoneCodeMatch = bodyText.match(/Zone Code[:\s]+([A-Z0-9]+)/i);
      const zoneCode = zoneCodeMatch ? zoneCodeMatch[1].trim() : null;
      
      // Extract density
      const densityMatch = bodyText.match(/Residential Density[:\s]+(RD\d+)/i);
      const density = densityMatch ? densityMatch[1].trim() : null;
      
      // Extract height
      const heightMatch = bodyText.match(/Building Height[:\s]+([^\n]+)/i);
      const height = heightMatch ? heightMatch[1].trim() : null;
      
      // Extract area
      const areaMatch = bodyText.match(/Area[:\s]+([0-9.,]+\s*(?:sqm|m²|m2))/i);
      const area = areaMatch ? areaMatch[1].trim() : null;
      
      // Extract overlays
      const overlays = [];
      const overlayMatches = bodyText.matchAll(/Overlay[:\s]+([^\n]+)/gi);
      for (const match of overlayMatches) {
        overlays.push(match[1].trim());
      }
      
      return {
        zone,
        zoneCode,
        density,
        height,
        area,
        overlays,
        rawText: bodyText.substring(0, 1000) // First 1000 chars for debugging
      };
    });

    console.log(`[BROWSERBASE] Data extracted:`, propertyData);

    // Step 7: Format response
    const result = {
      property: {
        lotplan: query,
        address: null,
        zone: propertyData.zone,
        zoneCode: propertyData.zoneCode,
        density: propertyData.density,
        height: propertyData.height,
        area: propertyData.area,
        overlays: propertyData.overlays
      },
      planningContext: {
        zoneDescription: null,
        lapRequirements: null,
        overlayRestrictions: null
      },
      debug: {
        rawText: propertyData.rawText // Include for debugging
      },
      scrapedAt: new Date().toISOString()
    };

    console.log(`[BROWSERBASE] Scraping complete`);

    // Step 8: Close browser
    await browser.close();
    
    return result;

  } catch (error) {
    console.error('[BROWSERBASE ERROR]', error);
    
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
 * Helper function to detect if query is lot/plan or address
 */
function detectQueryType(query) {
  // Lot/plan pattern: 12RP39932
  const lotPlanPattern = /\b(\d+[A-Z]{1,4}\d+)\b/i;
  return lotPlanPattern.test(query) ? 'lotplan' : 'address';
}
