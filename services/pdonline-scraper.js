import { chromium } from 'playwright-core';

export async function scrapeGoldCoastDAs(address, monthsBack = 12) {
  console.log('===========================================');
  console.log('[PDONLINE] Starting scraper');
  console.log('[PDONLINE] Address received:', address);
  console.log('[PDONLINE] Months back:', monthsBack);
  console.log('===========================================');

  const browserbaseApiKey = process.env.BROWSERBASE_API_KEY;
  const browserbaseProjectId = process.env.BROWSERBASE_PROJECT_ID;

  if (!browserbaseApiKey || !browserbaseProjectId) {
    console.error('[PDONLINE] Missing BrowserBase credentials');
    throw new Error('BrowserBase credentials not configured');
  }

  console.log('[PDONLINE] BrowserBase API Key:', browserbaseApiKey ? 'SET' : 'MISSING');
  console.log('[PDONLINE] BrowserBase Project ID:', browserbaseProjectId);

  let browser;

  try {
    console.log('[PDONLINE] Parsing address:', address);
    
    // Parse address: "43 Peerless Avenue, MERMAID BEACH, 4218"
    const parts = address.split(',').map(p => p.trim());
    if (parts.length < 2) {
      throw new Error('Invalid address format - need at least street and suburb');
    }
    
    const streetPart = parts[0];
    const tokens = streetPart.split(' ');
    
    if (tokens.length < 3) {
      throw new Error('Invalid street address format - need number, name, and type');
    }
    
    const streetNumber = tokens[0];
    const streetType = tokens[tokens.length - 1];
    const streetName = tokens.slice(1, -1).join(' ');
    
    console.log('[PDONLINE] Parsed:', { streetNumber, streetName, streetType });
    
    // Connect to BrowserBase
    console.log('[PDONLINE] Connecting to BrowserBase...');
    
    try {
      browser = await chromium.connectOverCDP(
        `wss://connect.browserbase.com?apiKey=${browserbaseApiKey}&projectId=${browserbaseProjectId}`,
        { timeout: 30000 }
      );
      console.log('[PDONLINE] ✅ Connected to BrowserBase');
    } catch (error) {
      console.error('[PDONLINE] ❌ BrowserBase connection failed:', error.message);
      throw new Error(`BrowserBase connection failed: ${error.message}`);
    }
    
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();
    
    console.log('[PDONLINE] Navigating to PDOnline...');
    
    // Navigate through PDOnline
    await page.goto('https://cogc.cloud.infor.com/ePathway/epthprod/Web/default.aspx', { timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 });
    console.log('[PDONLINE] ✅ Loaded homepage');
    
    await page.click('a:has-text("All applications")');
    await page.waitForLoadState('networkidle', { timeout: 30000 });
    console.log('[PDONLINE] ✅ Clicked All applications');
    
    await page.click('input#ctl00_MainBodyContent_mDataList_ctl03_mDataGrid_ctl02_ctl00');
    await page.click('input[type="submit"][value="Next"]');
    await page.waitForLoadState('networkidle', { timeout: 30000 });
    console.log('[PDONLINE] ✅ Accepted terms');
    
    await page.click('a:has-text("Address search")');
    await page.waitForSelector('#ctl00_MainBodyContent_mGeneralEnquirySearchControl_mTabControl_ctl09_mStreetNameTextBox', { timeout: 30000 });
    console.log('[PDONLINE] ✅ Opened address search');
    
    // Fill search form
    if (streetNumber) {
      await page.fill('#ctl00_MainBodyContent_mGeneralEnquirySearchControl_mTabControl_ctl09_mStreetNumberTextBox', streetNumber);
    }
    await page.fill('#ctl00_MainBodyContent_mGeneralEnquirySearchControl_mTabControl_ctl09_mStreetNameTextBox', streetName);
    await page.selectOption('#ctl00_MainBodyContent_mGeneralEnquirySearchControl_mTabControl_ctl09_mStreetTypeDropDown', streetType);
    console.log('[PDONLINE] ✅ Filled search form');
    
    await page.click('#ctl00_MainBodyContent_mGeneralEnquirySearchControl_mSearchButton');
    await page.waitForLoadState('networkidle', { timeout: 30000 });
    console.log('[PDONLINE] ✅ Submitted search');
    
    if (!page.url().includes('EnquirySummaryView')) {
      console.log('[PDONLINE] No results found');
      await browser.close();
      return { success: true, count: 0, applications: [] };
    }
    
    // Save the results URL for returning to it
    const resultsUrl = page.url();
    console.log('[PDONLINE] Results URL:', resultsUrl);
    
    try {
      await page.waitForSelector('table#gridResults', { timeout: 10000 });
      console.log('[PDONLINE] ✅ Found results table');
    } catch (error) {
      console.error('[PDONLINE] Results table not found:', error.message);
      await browser.close();
      return { success: true, count: 0, applications: [] };
    }
    
    // FIRST PASS: Collect all basic data from the table WITHOUT clicking into details
    const applications = [];
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - monthsBack);
    
    // Get all rows and extract basic info first
    const rowsData = await page.$$eval(
      'table#gridResults tr.ContentPanel, table#gridResults tr.AlternateContentPanel',
      (rows) => {
        return rows.map(row => {
          const cells = row.querySelectorAll('td');
          if (cells.length < 5) return null;
          
          return {
            appNumber: cells[0]?.innerText?.trim() || '',
            dateStr: cells[1]?.innerText?.trim() || '',
            location: cells[2]?.innerText?.trim() || '',
            appType: cells[3]?.innerText?.trim() || '',
            suburb: cells[4]?.innerText?.trim() || ''
          };
        }).filter(Boolean);
      }
    );
    
    console.log('[PDONLINE] Found', rowsData.length, 'result rows');
    
    // Process each row's basic data
    for (const rowData of rowsData) {
      const [day, month, year] = rowData.dateStr.split('/');
      const appDate = new Date(year, month - 1, day);
      const withinRange = appDate >= cutoffDate;
      
      const app = {
        application_number: rowData.appNumber,
        lodgement_date: rowData.dateStr,
        location: rowData.location,
        application_type: rowData.appType,
        suburb: rowData.suburb,
        within_date_range: withinRange,
        details_fetched: false
      };
      
      console.log('[PDONLINE] Found:', app.application_number, '- Within range:', withinRange);
      applications.push(app);
    }
    
    // SECOND PASS: Fetch details for applications within date range
    // We navigate fresh each time to avoid stale element issues
    for (let i = 0; i < applications.length; i++) {
      const app = applications[i];
      
      if (!app.within_date_range) {
        console.log('[PDONLINE] Skipping details for', app.application_number, '(outside date range)');
        continue;
      }
      
      try {
        console.log('[PDONLINE] Fetching details for', app.application_number);
        
        // Go back to results page fresh
        await page.goto(resultsUrl, { timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 30000 });
        await page.waitForSelector('table#gridResults', { timeout: 10000 });
        
        // Find and click the link for this specific application
        const link = await page.$(`a:has-text("${app.application_number}")`);
        if (!link) {
          console.log('[PDONLINE] Could not find link for', app.application_number);
          continue;
        }
        
        await link.click();
        await page.waitForLoadState('networkidle', { timeout: 30000 });
        
        // Check we're on a detail page
        if (page.url().includes('Error.aspx')) {
          console.log('[PDONLINE] Error page for', app.application_number);
          continue;
        }
        
        // Wait for details to load
        try {
          await page.waitForSelector('fieldset legend:has-text("Details")', { timeout: 10000 });
        } catch (e) {
          console.log('[PDONLINE] Details section not found for', app.application_number);
          continue;
        }
        
        const html = await page.content();
        
        // Extract description
        const descMatch = html.match(/Application description<\/span><div class="AlternateContentText"[^>]*>([^<]+(?:<[^\/][^>]*>[^<]*<\/[^>]+>)*[^<]*)<\/div>/i);
        if (descMatch) {
          app.application_description = descMatch[1].replace(/<[^>]+>/g, '').trim().replace(/\s+/g, ' ');
        }
        
        // Extract status
        const statusMatch = html.match(/Status<\/span><div class="AlternateContentText"[^>]*>([^<]+(?:<[^\/][^>]*>[^<]*<\/[^>]+>)*[^<]*)<\/div>/i);
        if (statusMatch) {
          app.status = statusMatch[1].replace(/<[^>]+>/g, '').trim().replace(/\s+/g, ' ');
        }
        
        app.details_fetched = true;
        console.log('[PDONLINE] ✅ Fetched details for', app.application_number);
        
      } catch (err) {
        console.error('[PDONLINE] Error fetching details for', app.application_number, ':', err.message);
      }
    }
    
    await browser.close();
    console.log('[PDONLINE] ✅ Complete - found', applications.length, 'applications');
    
    return {
      success: true,
      count: applications.length,
      applications
    };
    
  } catch (error) {
    console.error('[PDONLINE ERROR]', error.message);
    console.error('[PDONLINE ERROR STACK]', error.stack);
    
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error('[PDONLINE] Error closing browser:', closeError.message);
      }
    }
    
    throw new Error(`PDOnline scraping failed: ${error.message}`);
  }
}
