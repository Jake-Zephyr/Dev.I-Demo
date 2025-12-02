import { chromium } from 'playwright-core';

export async function scrapeGoldCoastDAs(address, monthsBack = 12) {
  const browserbaseApiKey = "bb_live_7rCC5sTgp3EC5SdyiTONogg323Y";
  const browserbaseProjectId = process.env.BROWSERBASE_PROJECT_ID;

  try {
    console.log('[PDONLINE] Parsing address:', address);
    
    // Parse address: "43 Peerless Avenue, MERMAID BEACH, 4218"
    const parts = address.split(',').map(p => p.trim());
    if (parts.length < 2) {
      throw new Error('Invalid address format');
    }
    
    const streetPart = parts[0];
    const tokens = streetPart.split(' ');
    
    if (tokens.length < 3) {
      throw new Error('Invalid street address format');
    }
    
    const streetNumber = tokens[0];
    const streetType = tokens[tokens.length - 1];
    const streetName = tokens.slice(1, -1).join(' ');
    
    console.log('[PDONLINE] Parsed:', { streetNumber, streetName, streetType });
    
    // Connect to BrowserBase
    const browser = await chromium.connectOverCDP(
      `wss://connect.browserbase.com?apiKey=${browserbaseApiKey}&projectId=${browserbaseProjectId}`
    );
    
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();
    
    // Navigate through PDOnline
    await page.goto('https://cogc.cloud.infor.com/ePathway/epthprod/Web/default.aspx');
    await page.waitForLoadState('networkidle');
    
    await page.click('a:has-text("All applications")');
    await page.waitForLoadState('networkidle');
    
    await page.click('input#ctl00_MainBodyContent_mDataList_ctl03_mDataGrid_ctl02_ctl00');
    await page.click('input[type="submit"][value="Next"]');
    await page.waitForLoadState('networkidle');
    
    await page.click('a:has-text("Address search")');
    await page.waitForSelector('#ctl00_MainBodyContent_mGeneralEnquirySearchControl_mTabControl_ctl09_mStreetNameTextBox');
    
    // Fill search form
    if (streetNumber) {
      await page.fill('#ctl00_MainBodyContent_mGeneralEnquirySearchControl_mTabControl_ctl09_mStreetNumberTextBox', streetNumber);
    }
    await page.fill('#ctl00_MainBodyContent_mGeneralEnquirySearchControl_mTabControl_ctl09_mStreetNameTextBox', streetName);
    await page.selectOption('#ctl00_MainBodyContent_mGeneralEnquirySearchControl_mTabControl_ctl09_mStreetTypeDropDown', streetType);
    
    await page.click('#ctl00_MainBodyContent_mGeneralEnquirySearchControl_mSearchButton');
    await page.waitForLoadState('networkidle');
    
    if (!page.url().includes('EnquirySummaryView')) {
      await browser.close();
      return { success: true, count: 0, applications: [] };
    }
    
    // Parse results
    const resultsUrl = page.url();
    await page.waitForSelector('table#gridResults');
    
    const rows = await page.$$('table#gridResults tr.ContentPanel, table#gridResults tr.AlternateContentPanel');
    
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - monthsBack);
    
    const applications = [];
    
    for (const row of rows) {
      const cells = await row.$$('td');
      if (cells.length < 5) continue;
      
      const appNumber = await cells[0].innerText();
      const dateStr = await cells[1].innerText();
      const location = await cells[2].innerText();
      const appType = await cells[3].innerText();
      const suburb = await cells[4].innerText();
      
      const [day, month, year] = dateStr.trim().split('/');
      const appDate = new Date(year, month - 1, day);
      const withinRange = appDate >= cutoffDate;
      
      const app = {
        application_number: appNumber.trim(),
        lodgement_date: dateStr.trim(),
        location: location.trim(),
        application_type: appType.trim(),
        suburb: suburb.trim(),
        details_fetched: false
      };
      
      // Fetch details for recent apps
      if (withinRange) {
        try {
          if (page.url() !== resultsUrl) {
            await page.goto(resultsUrl);
            await page.waitForLoadState('networkidle');
          }
          
          const link = await page.$(`a:has-text("${appNumber.trim()}")`);
          if (link) {
            await link.click();
            await page.waitForLoadState('networkidle');
            
            if (!page.url().includes('Error.aspx')) {
              await page.waitForSelector('fieldset legend:has-text("Details")');
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
            }
            
            await page.goBack();
            await page.waitForLoadState('networkidle');
          }
        } catch (err) {
          console.error('[PDONLINE] Error fetching details:', err.message);
        }
      }
      
      applications.push(app);
    }
    
    await browser.close();
    
    return {
      success: true,
      count: applications.length,
      applications
    };
    
  } catch (error) {
    console.error('[PDONLINE ERROR]', error);
    throw error;
  }
}
