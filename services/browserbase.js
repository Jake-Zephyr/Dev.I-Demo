// services/browserbase.js
import Anthropic from '@anthropic-ai/sdk';

const BROWSERBASE_API_KEY = process.env.BROWSERBASE_API_KEY;
const BROWSERBASE_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;

if (!BROWSERBASE_API_KEY || !BROWSERBASE_PROJECT_ID) {
  console.error('⚠️  Missing BrowserBase credentials in environment variables');
}

/**
 * Scrapes Gold Coast City Plan for property information
 * @param {string} query - Lot/plan (e.g., "12RP39932") or address (e.g., "22 Mary Avenue, Broadbeach")
 * @returns {Promise<Object>} Property data with zoning, density, height, overlays, and planning context
 */
export async function scrapeProperty(query) {
  try {
    console.log(`[BROWSERBASE] Starting scrape for: ${query}`);
    
    // Step 1: Create a browser session
    const sessionResponse = await fetch('https://www.browserbase.com/v1/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bb-api-key': BROWSERBASE_API_KEY
      },
      body: JSON.stringify({
        projectId: BROWSERBASE_PROJECT_ID,
        browserSettings: {
          timeout: 120000 // 2 minutes
        }
      })
    });

    if (!sessionResponse.ok) {
      throw new Error(`Failed to create session: ${sessionResponse.statusText}`);
    }

    const session = await sessionResponse.json();
    const sessionId = session.id;
    console.log(`[BROWSERBASE] Session created: ${sessionId}`);

    // Step 2: Use Claude to control the browser via Anthropic SDK
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });

    const scrapingPrompt = `You are a web scraping assistant. Navigate to https://cityplan.goldcoast.qld.gov.au/eplan/ and extract property planning information.

Query: ${query}

Steps:
1. Go to https://cityplan.goldcoast.qld.gov.au/eplan/
2. Find the search box and enter: ${query}
3. Wait for results to load
4. Extract the following information:
   - Zone (e.g., "High Density Residential")
   - Zone Code (e.g., "HDR")
   - Residential Density (e.g., "RD5")
   - Building Height limit (e.g., "8 storeys", "No limit", "16m")
   - Area (site area in sqm)
   - Overlays (any applicable overlays like "Broadbeach LAP", "Character Overlay CO1", etc.)
   - Lot/Plan number
5. If available, click into the Zone Code page and extract key planning requirements
6. If a Local Area Plan (LAP) is mentioned, try to extract key requirements

Return the data as a JSON object with this structure:
{
  "property": {
    "lotplan": "string",
    "address": "string or null",
    "zone": "string",
    "zoneCode": "string",
    "density": "string",
    "height": "string",
    "area": "string",
    "overlays": ["array of strings"]
  },
  "planningContext": {
    "zoneDescription": "string or null",
    "lapRequirements": "string or null",
    "overlayRestrictions": "string or null"
  },
  "scrapedAt": "ISO timestamp"
}

If you cannot find certain information, use null. Be thorough but efficient.`;

    // Use Claude with computer use to scrape
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: scrapingPrompt
      }],
      // Note: BrowserBase integration with Claude's computer use
      // This is a simplified version - in production you'd use their full API
    });

    console.log(`[BROWSERBASE] Scraping complete`);

    // Step 3: Parse Claude's response
    const resultText = response.content.find(c => c.type === 'text')?.text || '{}';
    
    // Try to extract JSON from the response
    let data;
    try {
      // Look for JSON in the response
      const jsonMatch = resultText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        data = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('[BROWSERBASE] Failed to parse JSON, using fallback');
      // Fallback: Create basic structure from text
      data = {
        property: {
          lotplan: query,
          address: null,
          zone: extractFromText(resultText, 'zone'),
          zoneCode: null,
          density: extractFromText(resultText, 'density'),
          height: extractFromText(resultText, 'height'),
          area: null,
          overlays: []
        },
        planningContext: {
          zoneDescription: null,
          lapRequirements: null,
          overlayRestrictions: null
        },
        scrapedAt: new Date().toISOString()
      };
    }

    // Step 4: Close the session
    await fetch(`https://www.browserbase.com/v1/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: {
        'x-bb-api-key': BROWSERBASE_API_KEY
      }
    });

    console.log(`[BROWSERBASE] Session closed`);

    return data;

  } catch (error) {
    console.error('[BROWSERBASE ERROR]', error);
    throw new Error(`Scraping failed: ${error.message}`);
  }
}

/**
 * Helper function to extract information from text
 */
function extractFromText(text, field) {
  const patterns = {
    zone: /zone[:\s]+([A-Za-z\s]+)/i,
    density: /density[:\s]+(RD\d+)/i,
    height: /height[:\s]+([0-9]+[a-z\s]*)/i
  };

  const pattern = patterns[field];
  if (!pattern) return null;

  const match = text.match(pattern);
  return match ? match[1].trim() : null;
}

/**
 * Alternative: Direct Playwright script approach via BrowserBase
 * This uploads your Python script to run on their infrastructure
 */
export async function scrapePropertyWithScript(query) {
  // This would upload your goldcoast_scraper.py to BrowserBase
  // and run it on their infrastructure
  // More reliable but requires script upload API
  
  // For now, we use the Claude-based approach above
  throw new Error('Script-based scraping not yet implemented');
}
