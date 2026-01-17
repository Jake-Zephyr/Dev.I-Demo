from playwright.sync_api import sync_playwright
import time
import os

def download_decision_notice(app_number, output_dir="/tmp", debug=True):
    """
    Download the Signed Decision Notice PDF for a specific DA.

    Args:
        app_number: Application number (e.g., "MIN/2024/216")
        output_dir: Where to save the PDF
        debug: Enable verbose output

    Returns:
        dict with success status and file path
    """

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)  # Set True for production
        context = browser.new_context()
        page = context.new_page()
        page.set_default_timeout(30000)

        try:
            if debug:
                print("="*80)
                print("STEP 1: NAVIGATING TO PDONLINE")
                print("="*80)

            page.goto('https://cogc.cloud.infor.com/ePathway/epthprod/Web/default.aspx')
            page.wait_for_load_state('networkidle')
            time.sleep(1)
            if debug:
                print("  ✓ Loaded homepage")

            page.click('a:has-text("All applications")')
            page.wait_for_load_state('networkidle')
            time.sleep(1)
            if debug:
                print("  ✓ Clicked 'All applications'")

            page.click('input#ctl00_MainBodyContent_mDataList_ctl03_mDataGrid_ctl02_ctl00')
            time.sleep(1)
            if debug:
                print("  ✓ Selected terms radio button")

            page.click('input[type="submit"][value="Next"]')
            page.wait_for_load_state('networkidle')
            time.sleep(1)
            if debug:
                print("  ✓ Clicked Next")

            if debug:
                print("\n" + "="*80)
                print("STEP 2: SEARCHING BY APPLICATION NUMBER")
                print("="*80)
                print(f"  Application number: {app_number}")

            # The "Application number search" tab should be selected by default
            # Find the input field - try common patterns
            selectors_to_try = [
                '#ctl00_MainBodyContent_mGeneralEnquirySearchControl_mTabControl_ctl00_mApplicationNumberTextBox',
                'input[type="text"][id*="ApplicationNumber"]',
                '#ctl00_MainBodyContent_mGeneralEnquirySearchControl_mTabControl_ctl00_mLicenceApplicationNumberTextBox'
            ]

            input_filled = False
            for selector in selectors_to_try:
                try:
                    page.wait_for_selector(selector, timeout=5000)
                    page.fill(selector, app_number)
                    if debug:
                        print(f"  ✓ Filled application number using selector: {selector}")
                    input_filled = True
                    break
                except:
                    continue

            if not input_filled:
                # Fallback: find by placeholder or label
                if debug:
                    print("  - Standard selectors failed, trying fallback...")

                # Find all text inputs on page and log them
                inputs = page.query_selector_all('input[type="text"]')
                if debug:
                    print(f"  - Found {len(inputs)} text input fields")
                    for i, inp in enumerate(inputs):
                        inp_id = inp.get_attribute('id') or 'no-id'
                        inp_name = inp.get_attribute('name') or 'no-name'
                        print(f"    Input {i}: id='{inp_id}', name='{inp_name}'")

                # Fill the first visible text input (usually the app number field)
                page.fill('input[type="text"]', app_number)
                if debug:
                    print("  ✓ Filled using fallback selector")

            # Click search button
            page.click('#ctl00_MainBodyContent_mGeneralEnquirySearchControl_mSearchButton')
            page.wait_for_load_state('networkidle')
            time.sleep(2)
            if debug:
                print("  ✓ Submitted search")

            if debug:
                print("\n" + "="*80)
                print("STEP 3: ANALYZING SEARCH RESULTS PAGE")
                print("="*80)
                print(f"  Current URL: {page.url}")

            # Check if we're on results page or detail page
            if 'EnquirySummaryView' in page.url:
                if debug:
                    print("  ℹ On results/summary page - need to click through to detail")

                # Check for results table
                try:
                    page.wait_for_selector('table#gridResults', timeout=5000)
                    if debug:
                        print("  ✓ Found results table")

                    # Count rows
                    rows = page.query_selector_all('table#gridResults tr.ContentPanel, table#gridResults tr.AlternateContentPanel')
                    if debug:
                        print(f"  ℹ Found {len(rows)} result row(s)")

                    # Log the results
                    for idx, row in enumerate(rows, 1):
                        cells = row.query_selector_all('td')
                        if len(cells) >= 2:
                            app_num = cells[0].inner_text().strip()
                            location = cells[2].inner_text().strip() if len(cells) > 2 else 'N/A'
                            if debug:
                                print(f"    Row {idx}: {app_num} - {location[:50]}")

                    # Click into the first result (should be our DA)
                    if len(rows) > 0:
                        if debug:
                            print(f"\n  → Clicking into application: {app_number}")

                        # Find link in first row
                        link = rows[0].query_selector('td:first-child a')
                        if link:
                            link.click()
                            page.wait_for_load_state('networkidle')
                            time.sleep(2)
                            if debug:
                                print(f"  ✓ Clicked link, now on: {page.url}")
                        else:
                            if debug:
                                print("  ✗ Could not find clickable link in first row")
                            browser.close()
                            return {'success': False, 'error': 'No clickable link found', 'file_path': None}
                    else:
                        if debug:
                            print("  ✗ No results found for this application number")
                        browser.close()
                        return {'success': False, 'error': 'No results found', 'file_path': None}

                except Exception as e:
                    if debug:
                        print(f"  ✗ Error finding results table: {e}")
                        print("  ℹ Page might be empty or in unexpected format")
                    browser.close()
                    return {'success': False, 'error': 'Results table not found', 'file_path': None}

            # Now we should be on the detail page
            if debug:
                print("\n" + "="*80)
                print("STEP 4: VERIFYING DETAIL PAGE")
                print("="*80)
                print(f"  Current URL: {page.url}")

            # Check for detail page markers
            detail_markers = [
                'fieldset legend:has-text("Details")',
                'text=Application number',
                'text=Application description',
                'text=Application documents'
            ]

            found_markers = []
            for marker in detail_markers:
                try:
                    page.wait_for_selector(marker, timeout=3000)
                    found_markers.append(marker)
                    if debug:
                        print(f"  ✓ Found: {marker}")
                except:
                    if debug:
                        print(f"  ✗ Not found: {marker}")

            if len(found_markers) == 0:
                if debug:
                    print("  ⚠ WARNING: No detail page markers found!")
                    print("  ℹ Taking screenshot for debugging...")
                    screenshot_path = f'debug_detail_page_{app_number.replace("/", "_")}.png'
                    page.screenshot(path=screenshot_path, full_page=True)
                    print(f"  ℹ Screenshot saved: {screenshot_path}")

            # Scroll to and find documents section
            if debug:
                print("\n" + "="*80)
                print("STEP 5: LOCATING DOCUMENTS SECTION")
                print("="*80)

            # Try multiple ways to find documents section
            docs_section_found = False

            # Method 1: Look for "Application documents" heading
            try:
                docs_heading = page.wait_for_selector('text=Application documents', timeout=5000)
                docs_heading.scroll_into_view_if_needed()
                time.sleep(1)
                if debug:
                    print("  ✓ Found 'Application documents' heading")
                docs_section_found = True
            except:
                if debug:
                    print("  ✗ 'Application documents' heading not found")

            # Method 2: Look for document table or list
            if not docs_section_found:
                try:
                    # Look for any table with "Link" and "Name" headers (typical document table)
                    tables = page.query_selector_all('table')
                    if debug:
                        print(f"  ℹ Found {len(tables)} tables on page")

                    for idx, table in enumerate(tables):
                        headers = table.query_selector_all('th')
                        header_texts = [h.inner_text().strip() for h in headers]
                        if 'Link' in header_texts and 'Name' in header_texts:
                            if debug:
                                print(f"  ✓ Found documents table (table {idx}): {header_texts}")
                            table.scroll_into_view_if_needed()
                            docs_section_found = True
                            break
                except Exception as e:
                    if debug:
                        print(f"  ✗ Error searching for tables: {e}")

            if not docs_section_found:
                if debug:
                    print("  ⚠ WARNING: Could not locate documents section")
                    print("  ℹ Taking screenshot...")
                    screenshot_path = f'debug_no_docs_{app_number.replace("/", "_")}.png'
                    page.screenshot(path=screenshot_path, full_page=True)
                    print(f"  ℹ Screenshot saved: {screenshot_path}")

            if debug:
                print("\n" + "="*80)
                print("STEP 6: FINDING SIGNED DECISION NOTICE")
                print("="*80)

            # Find all tables and rows
            all_rows = page.query_selector_all('table tr')
            if debug:
                print(f"  ℹ Scanning {len(all_rows)} total table rows on page")

            # List all documents found
            if debug:
                print("  ℹ Documents found on page:")

            documents_found = []
            for row in all_rows:
                try:
                    text = row.inner_text()
                    # Look for rows that have document names
                    if any(keyword in text for keyword in ['Form', 'Plan', 'Report', 'Notice', 'Decision', 'Letter']):
                        cells = row.query_selector_all('td')
                        if len(cells) >= 2:
                            # Typically: Link | Name | Type | Size
                            link_text = cells[0].inner_text().strip() if len(cells) > 0 else ''
                            name_text = cells[1].inner_text().strip() if len(cells) > 1 else ''

                            if name_text:
                                documents_found.append({'link': link_text, 'name': name_text})
                                if debug:
                                    print(f"    - {name_text} (Link: {link_text})")
                except:
                    continue

            if debug:
                print(f"  ℹ Total documents found: {len(documents_found)}")

            # Now find Signed Decision Notice specifically
            decision_notice_link = None
            for row in all_rows:
                try:
                    text = row.inner_text()
                    if 'Signed Decision Notice' in text:
                        # Found the row - get the link from first cell
                        link_cell = row.query_selector('td:first-child a')
                        if link_cell:
                            decision_notice_link = link_cell
                            link_text = link_cell.inner_text().strip()
                            if debug:
                                print(f"\n  ✓✓✓ FOUND 'Signed Decision Notice' (Link: {link_text})")
                            break
                except:
                    continue

            if not decision_notice_link:
                if debug:
                    print("\n  ✗✗✗ ERROR: 'Signed Decision Notice' not found in documents list")

                browser.close()
                return {
                    'success': False,
                    'error': 'Signed Decision Notice not found',
                    'file_path': None,
                    'documents_available': [doc['name'] for doc in documents_found]
                }

            if debug:
                print("\n" + "="*80)
                print("STEP 7: DOWNLOADING PDF")
                print("="*80)

            # Set up download handling
            with page.expect_download() as download_info:
                decision_notice_link.click()
                if debug:
                    print("  ✓ Clicked download link")

            download = download_info.value

            # Save to output directory
            filename = f"DA_{app_number.replace('/', '_')}_Decision_Notice.pdf"
            file_path = os.path.join(output_dir, filename)
            download.save_as(file_path)

            file_size = os.path.getsize(file_path) / 1024  # KB
            if debug:
                print(f"  ✓ Downloaded: {filename}")
                print(f"  ✓ Size: {file_size:.2f} KB")
                print(f"  ✓ Path: {file_path}")

            browser.close()

            if debug:
                print("\n" + "="*80)
                print("✓✓✓ DOWNLOAD COMPLETE ✓✓✓")
                print("="*80)

            return {
                'success': True,
                'file_path': file_path,
                'filename': filename,
                'application_number': app_number,
                'file_size_kb': round(file_size, 2)
            }

        except Exception as e:
            if debug:
                print("\n" + "="*80)
                print("✗✗✗ CRITICAL ERROR ✗✗✗")
                print("="*80)
                print(f"  Error: {str(e)}")
                try:
                    print(f"  Current URL: {page.url}")
                    screenshot_path = f'error_screenshot_{app_number.replace("/", "_")}.png'
                    page.screenshot(path=screenshot_path, full_page=True)
                    print(f"  Screenshot saved: {screenshot_path}")
                except:
                    pass

            browser.close()
            return {
                'success': False,
                'error': str(e),
                'file_path': None
            }

# Test it
if __name__ == "__main__":
    print("="*80)
    print("PDOnline Decision Notice Downloader")
    print("="*80)
    print()

    result = download_decision_notice("MIN/2024/216", debug=True)

    if result['success']:
        print("\n" + "="*80)
        print("✓✓✓ SUCCESS! ✓✓✓")
        print("="*80)
        print(f"File saved to: {result['file_path']}")
        print(f"File size: {result.get('file_size_kb', 'N/A')} KB")
    else:
        print("\n" + "="*80)
        print("✗✗✗ FAILED ✗✗✗")
        print("="*80)
        print(f"Error: {result.get('error', 'Unknown error')}")
        if 'documents_available' in result:
            print("\nDocuments that were available:")
            for doc in result['documents_available']:
                print(f"  - {doc}")
