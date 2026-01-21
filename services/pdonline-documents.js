import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';

/**
 * Download the Decision Notice PDF for a specific DA from PDOnline.
 * Handles pagination and falls back to unsigned decision notice if signed not available.
 *
 * @param {string} applicationNumber - Application number (e.g., "MIN/2024/216")
 * @param {string} outputDir - Directory to save PDF (default: /tmp)
 * @returns {Promise<Object>} Result object with success status, file path, and metadata
 */
export async function getDecisionNotice(applicationNumber, outputDir = '/tmp') {
  console.log('===========================================');
  console.log('[PDONLINE-DOCS] Starting document downloader');
  console.log('[PDONLINE-DOCS] Application number:', applicationNumber);
  console.log('===========================================');

  const browserbaseApiKey = process.env.BROWSERBASE_API_KEY;
  const browserbaseProjectId = process.env.BROWSERBASE_PROJECT_ID;

  if (!browserbaseApiKey || !browserbaseProjectId) {
    console.error('[PDONLINE-DOCS] Missing BrowserBase credentials');
    throw new Error('BrowserBase credentials not configured');
  }

  let browser;

  try {
    // Connect to BrowserBase
    console.log('[PDONLINE-DOCS] Connecting to BrowserBase...');

    browser = await chromium.connectOverCDP(
      `wss://connect.browserbase.com?apiKey=${browserbaseApiKey}&projectId=${browserbaseProjectId}`,
      { timeout: 30000 }
    );
    console.log('[PDONLINE-DOCS] ✅ Connected to BrowserBase');

    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(10000);

    // STEP 1: Navigate to PDOnline
    console.log('[PDONLINE-DOCS] Navigating to PDOnline...');
    await page.goto('https://cogc.cloud.infor.com/ePathway/epthprod/Web/default.aspx', { waitUntil: 'domcontentloaded' });
    console.log('[PDONLINE-DOCS] ✅ Loaded homepage');

    await page.click('a:has-text("All applications")');
    console.log('[PDONLINE-DOCS] ✅ Clicked All applications');

    await page.click('input#ctl00_MainBodyContent_mDataList_ctl03_mDataGrid_ctl02_ctl00');
    await page.click('input[type="submit"][value="Next"]');
    console.log('[PDONLINE-DOCS] ✅ Accepted terms');

    // STEP 2: Search by application number
    console.log('[PDONLINE-DOCS] Searching for:', applicationNumber);
    await page.fill('#ctl00_MainBodyContent_mGeneralEnquirySearchControl_mTabControl_ctl04_mFormattedNumberTextBox', applicationNumber);
    await page.click('#ctl00_MainBodyContent_mGeneralEnquirySearchControl_mSearchButton');
    await page.waitForSelector('table#gridResults', { timeout: 5000 });
    console.log('[PDONLINE-DOCS] ✅ Search complete');

    // STEP 3: Click into first result
    const firstLink = await page.$('table#gridResults tr.ContentPanel td:first-child a, table#gridResults tr.AlternateContentPanel td:first-child a');
    if (!firstLink) {
      await browser.close();
      return {
        success: false,
        error: 'No results found for application number',
        filePath: null
      };
    }

    await firstLink.click();
    console.log('[PDONLINE-DOCS] ✅ Opened application detail');

    // STEP 4: Access documents iframe
    const iframeElement = await page.waitForSelector('iframe.resp-iframe', { timeout: 15000 });
    const iframe = await iframeElement.contentFrame();

    // Wait longer for documents table - iframe loads external URL which can be slow
    console.log('[PDONLINE-DOCS] Waiting for documents table to load...');
    await iframe.waitForSelector('table.dataTable', { timeout: 20000 });
    console.log('[PDONLINE-DOCS] ✅ Documents loaded');

    // STEP 5: Search all pages for decision notice
    console.log('[PDONLINE-DOCS] Searching for decision notice...');

    let signedInfo = null;
    let unsignedInfo = null;
    let pageNum = 1;
    let foundPage = null;

    while (true) {
      console.log(`[PDONLINE-DOCS] → Scanning page ${pageNum}...`);

      const docsTable = await iframe.$('table.dataTable');
      if (!docsTable) break;

      const rows = await docsTable.$$('tr');

      for (const row of rows) {
        const cells = await row.$$('td');
        if (cells.length >= 4) {
          const linkText = await cells[0].innerText();
          const nameText = await cells[1].innerText();

          const linkTextClean = linkText.trim();
          const nameTextClean = nameText.trim();

          // Check for SIGNED Decision Notice (preferred)
          if (nameTextClean.includes('Signed Decision Notice')) {
            signedInfo = {
              linkText: linkTextClean,
              name: nameTextClean,
              isSigned: true,
              page: pageNum
            };
            console.log('[PDONLINE-DOCS] ✅ Found SIGNED:', nameTextClean, `(${linkTextClean})`);
            foundPage = pageNum;
            break;
          }

          // Check for unsigned Decision Notice (fallback)
          if (nameTextClean.includes('Decision Notice') && !unsignedInfo) {
            // Exclude cover letters
            if (!nameTextClean.toLowerCase().includes('cover letter')) {
              unsignedInfo = {
                linkText: linkTextClean,
                name: nameTextClean,
                isSigned: false,
                page: pageNum
              };
              console.log('[PDONLINE-DOCS] ⚠ Found UNSIGNED:', nameTextClean, `(${linkTextClean})`);
            }
          }
        }
      }

      // If we found signed, stop searching
      if (signedInfo) {
        foundPage = signedInfo.page;
        break;
      }

      // If we found unsigned and we're on page 2+, stop
      if (unsignedInfo && pageNum >= 2) {
        foundPage = unsignedInfo.page;
        console.log(`[PDONLINE-DOCS] ✅ Stopping search (found unsigned, scanned ${pageNum} pages)`);
        break;
      }

      // Check for Next button
      const nextButton = await iframe.$('a:has-text("Next")');
      if (nextButton) {
        const buttonClass = await nextButton.getAttribute('class') || '';
        if (!buttonClass.includes('disabled')) {
          console.log(`[PDONLINE-DOCS] → Going to page ${pageNum + 1}...`);
          await nextButton.click();
          await iframe.waitForLoadState('domcontentloaded');
          pageNum += 1;
          continue;
        }
      }

      // No more pages
      console.log(`[PDONLINE-DOCS] ✅ Scanned all ${pageNum} page(s)`);
      break;
    }

    // Decide which document to use
    const decisionInfo = signedInfo || unsignedInfo;

    if (!decisionInfo) {
      await browser.close();
      return {
        success: false,
        error: 'No Decision Notice found (signed or unsigned)',
        filePath: null
      };
    }

    // Navigate back to correct page if needed
    if (foundPage && foundPage !== pageNum) {
      console.log(`[PDONLINE-DOCS] → Navigating back to page ${foundPage}...`);

      // Go back to page 1
      while (pageNum > 1) {
        const prevButton = await iframe.$('a:has-text("Previous")');
        if (prevButton) {
          await prevButton.click();
          await iframe.waitForLoadState('domcontentloaded');
          pageNum -= 1;
        } else {
          break;
        }
      }

      // Forward to target page
      while (pageNum < foundPage) {
        const nextButton = await iframe.$('a:has-text("Next")');
        if (nextButton) {
          await nextButton.click();
          await iframe.waitForLoadState('domcontentloaded');
          pageNum += 1;
        } else {
          break;
        }
      }
    }

    // STEP 6: Download PDF
    console.log('[PDONLINE-DOCS] Downloading PDF...');
    if (!decisionInfo.isSigned) {
      console.log('[PDONLINE-DOCS] ⚠ WARNING: Decision Notice is UNSIGNED');
    }

    // Find the link on current page
    const docsTable = await iframe.$('table.dataTable');
    let decisionLink = null;

    if (docsTable) {
      const rows = await docsTable.$$('tr');
      for (const row of rows) {
        const cells = await row.$$('td');
        if (cells.length >= 4) {
          const linkText = await cells[0].innerText();
          const linkTextClean = linkText.trim();

          if (linkTextClean === decisionInfo.linkText) {
            decisionLink = await cells[0].$('a');
            break;
          }
        }
      }
    }

    if (!decisionLink) {
      await browser.close();
      return {
        success: false,
        error: `Could not find link ${decisionInfo.linkText} on page ${foundPage}`,
        filePath: null
      };
    }

    // Get the download URL from the link
    console.log('[PDONLINE-DOCS] Getting download URL...');
    const downloadUrl = await decisionLink.getAttribute('href');
    console.log('[PDONLINE-DOCS] Download URL:', downloadUrl);

    // Build full URL if it's relative
    const baseUrl = page.url();
    const fullUrl = downloadUrl.startsWith('http') ? downloadUrl : new URL(downloadUrl, baseUrl).toString();
    console.log('[PDONLINE-DOCS] Full URL:', fullUrl);

    // Use page.evaluate with fetch to download the file as base64
    console.log('[PDONLINE-DOCS] Fetching file content from remote browser...');
    const downloadResult = await page.evaluate(async (url) => {
      const response = await fetch(url);
      console.log('Fetch status:', response.status);
      console.log('Fetch content-type:', response.headers.get('content-type'));

      const blob = await response.blob();
      console.log('Blob size:', blob.size);
      console.log('Blob type:', blob.type);

      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          // Remove the data:application/pdf;base64, prefix
          const base64 = reader.result.split(',')[1];
          resolve({
            base64: base64,
            size: blob.size,
            type: blob.type,
            status: response.status
          });
        };
        reader.readAsDataURL(blob);
      });
    }, fullUrl);

    console.log('[PDONLINE-DOCS] Response status:', downloadResult.status);
    console.log('[PDONLINE-DOCS] Blob size:', downloadResult.size);
    console.log('[PDONLINE-DOCS] Blob type:', downloadResult.type);
    console.log('[PDONLINE-DOCS] Base64 length:', downloadResult.base64.length);

    // Save to output directory
    const signedSuffix = decisionInfo.isSigned ? '' : '_UNSIGNED';
    const filename = `DA_${applicationNumber.replace(/\//g, '_')}_Decision_Notice${signedSuffix}.pdf`;
    const filePath = path.join(outputDir, filename);

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      console.log(`[PDONLINE-DOCS] Creating output directory: ${outputDir}`);
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Convert base64 to buffer and write to file
    console.log('[PDONLINE-DOCS] Converting base64 to buffer...');
    const pdfBuffer = Buffer.from(downloadResult.base64, 'base64');
    console.log('[PDONLINE-DOCS] Buffer size:', pdfBuffer.length);
    console.log('[PDONLINE-DOCS] Buffer starts with:', pdfBuffer.slice(0, 20).toString());
    console.log('[PDONLINE-DOCS] Is valid PDF header?', pdfBuffer.toString('utf8', 0, 4) === '%PDF');

    console.log('[PDONLINE-DOCS] Writing file to disk...');
    fs.writeFileSync(filePath, pdfBuffer);

    const stats = fs.statSync(filePath);
    const fileSizeKB = (stats.size / 1024).toFixed(2);
    console.log('[PDONLINE-DOCS] File size on disk:', fileSizeKB, 'KB');

    console.log('[PDONLINE-DOCS] ✅ Downloaded:', filename);
    console.log('[PDONLINE-DOCS] ✅ Size:', fileSizeKB, 'KB');
    console.log('[PDONLINE-DOCS] ✅ Signed:', decisionInfo.isSigned);

    await browser.close();
    console.log('[PDONLINE-DOCS] ✅ Complete');

    return {
      success: true,
      filePath: filePath,
      filename: filename,
      applicationNumber: applicationNumber,
      fileSizeKB: parseFloat(fileSizeKB),
      isSigned: decisionInfo.isSigned,
      documentName: decisionInfo.name,
      warning: decisionInfo.isSigned ? null : 'Decision Notice is UNSIGNED'
    };

  } catch (error) {
    console.error('[PDONLINE-DOCS ERROR]', error.message);
    console.error('[PDONLINE-DOCS ERROR STACK]', error.stack);

    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error('[PDONLINE-DOCS] Error closing browser:', closeError.message);
      }
    }

    throw new Error(`Decision notice download failed: ${error.message}`);
  }
}
