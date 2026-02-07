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
  const browserbaseApiKey = process.env.BROWSERBASE_API_KEY;
  const browserbaseProjectId = process.env.BROWSERBASE_PROJECT_ID;

  if (!browserbaseApiKey || !browserbaseProjectId) {
    throw new Error('BrowserBase credentials not configured');
  }

  let browser;

  try {
    browser = await chromium.connectOverCDP(
      `wss://connect.browserbase.com?apiKey=${browserbaseApiKey}&projectId=${browserbaseProjectId}`,
      { timeout: 25000 }
    );

    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(8000);

    // Navigate and accept terms
    await page.goto('https://cogc.cloud.infor.com/ePathway/epthprod/Web/default.aspx', { waitUntil: 'domcontentloaded' });
    await page.click('a:has-text("All applications")');
    await page.click('input#ctl00_MainBodyContent_mDataList_ctl03_mDataGrid_ctl02_ctl00');
    await page.click('input[type="submit"][value="Next"]');

    // Search by application number
    await page.fill('#ctl00_MainBodyContent_mGeneralEnquirySearchControl_mTabControl_ctl04_mFormattedNumberTextBox', applicationNumber);
    await page.click('#ctl00_MainBodyContent_mGeneralEnquirySearchControl_mSearchButton');
    await page.waitForSelector('table#gridResults', { timeout: 5000 });

    // Click into first result
    const firstLink = await page.$('table#gridResults tr.ContentPanel td:first-child a, table#gridResults tr.AlternateContentPanel td:first-child a');
    if (!firstLink) {
      await browser.close();
      return { success: false, error: 'No results found for application number', filePath: null };
    }

    await firstLink.click();

    // Access documents iframe
    const iframeElement = await page.waitForSelector('iframe.resp-iframe', { timeout: 12000 });
    const iframe = await iframeElement.contentFrame();
    await iframe.waitForSelector('table.dataTable', { timeout: 15000 });

    // Search all pages for decision notice
    let signedInfo = null;
    let unsignedInfo = null;
    let pageNum = 1;
    let foundPage = null;

    while (true) {
      const docsTable = await iframe.$('table.dataTable');
      if (!docsTable) break;

      const rows = await docsTable.$$('tr');

      for (const row of rows) {
        const cells = await row.$$('td');
        if (cells.length >= 4) {
          const linkText = (await cells[0].innerText()).trim();
          const nameText = (await cells[1].innerText()).trim();

          if (nameText.includes('Signed Decision Notice')) {
            signedInfo = { linkText, name: nameText, isSigned: true, page: pageNum };
            foundPage = pageNum;
            break;
          }

          if (nameText.includes('Decision Notice') && !unsignedInfo && !nameText.toLowerCase().includes('cover letter')) {
            unsignedInfo = { linkText, name: nameText, isSigned: false, page: pageNum };
          }
        }
      }

      if (signedInfo) {
        foundPage = signedInfo.page;
        break;
      }

      if (unsignedInfo && pageNum >= 2) {
        foundPage = unsignedInfo.page;
        break;
      }

      const nextButton = await iframe.$('a:has-text("Next")');
      if (nextButton && !(await nextButton.getAttribute('class') || '').includes('disabled')) {
        await nextButton.click();
        await iframe.waitForLoadState('domcontentloaded');
        pageNum += 1;
        continue;
      }

      break;
    }

    const decisionInfo = signedInfo || unsignedInfo;

    if (!decisionInfo) {
      await browser.close();
      return { success: false, error: 'No Decision Notice found', filePath: null };
    }

    // Navigate back to correct page if needed
    if (foundPage && foundPage !== pageNum) {
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

    // Find the download link on current page
    const docsTable = await iframe.$('table.dataTable');
    let decisionLink = null;

    if (docsTable) {
      const rows = await docsTable.$$('tr');
      for (const row of rows) {
        const cells = await row.$$('td');
        if (cells.length >= 4) {
          const linkText = (await cells[0].innerText()).trim();
          if (linkText === decisionInfo.linkText) {
            decisionLink = await cells[0].$('a');
            break;
          }
        }
      }
    }

    if (!decisionLink) {
      await browser.close();
      return { success: false, error: `Could not find link ${decisionInfo.linkText}`, filePath: null };
    }

    // Intercept PDF download
    let pdfBuffer = null;
    let interceptResolve = null;
    const interceptPromise = new Promise((resolve) => { interceptResolve = resolve; });

    const routeHandler = async (route, request) => {
      const response = await route.fetch();
      const contentType = response.headers()['content-type'] || '';

      if (contentType.includes('application/pdf') || contentType.includes('octet-stream')) {
        pdfBuffer = await response.body();
        interceptResolve();
      }

      await route.fulfill({ response });
    };

    await page.route('**/*', routeHandler);
    await decisionLink.click();

    const timeout = setTimeout(() => {
      if (!pdfBuffer) interceptResolve();
    }, 20000);

    await interceptPromise;
    clearTimeout(timeout);
    await page.unroute('**/*', routeHandler);

    if (!pdfBuffer) {
      throw new Error('Failed to capture PDF');
    }

    // Validate and save PDF
    if (pdfBuffer.toString('utf8', 0, 4) !== '%PDF') {
      throw new Error('Downloaded file is not a valid PDF');
    }

    const signedSuffix = decisionInfo.isSigned ? '' : '_UNSIGNED';
    const filename = `DA_${applicationNumber.replace(/\//g, '_')}_Decision_Notice${signedSuffix}.pdf`;
    const filePath = path.join(outputDir, filename);

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(filePath, pdfBuffer);
    const fileSizeKB = (pdfBuffer.length / 1024).toFixed(2);

    await browser.close();

    return {
      success: true,
      filePath,
      filename,
      applicationNumber,
      fileSizeKB: parseFloat(fileSizeKB),
      isSigned: decisionInfo.isSigned,
      documentName: decisionInfo.name,
      warning: decisionInfo.isSigned ? null : 'Decision Notice is UNSIGNED'
    };

  } catch (error) {
    console.error('[PDONLINE-DOCS ERROR]', error.message);

    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        // Silent fail on close error
      }
    }

    throw new Error(`Decision notice download failed: ${error.message}`);
  }
}
