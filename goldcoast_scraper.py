import os, re, sys
from dataclasses import dataclass, asdict
from typing import List, Optional
from playwright.sync_api import sync_playwright

CITYPLAN_URL = "https://cityplan.goldcoast.qld.gov.au/eplan/"

@dataclass
class PropertyData:
    address: str
    lot_plan: Optional[str] = None
    zone: Optional[str] = None
    residential_density: Optional[str] = None
    area_sqm: Optional[str] = None
    building_height: Optional[str] = None
    overlays: List[str] = None

def extract_area_and_lotplan(page):
    """Extract area and lot/plan from property detail card"""
    area, lotplan = None, None
    try:
        container = page.locator("#isoplan-property-detail")
        divs = container.locator("div")
        count = divs.count()

        for i in range(count):
            try:
                txt = divs.nth(i).inner_text(timeout=1000).strip()
            except:
                continue

            # Look for "Plan Area 200 m2"
            area_match = re.search(r"Plan\s*Area\s*([\d.,]+)\s*m[²2]", txt, re.I)
            if area_match and not area:
                area = area_match.group(1).replace(",", "")
                print(f"   ✓ Found area: {area} m²")

            # Look for "Lot/Plan 4GTP446"
            lotplan_match = re.search(r"Lot/Plan\s+(\w+)", txt, re.I)
            if lotplan_match and not lotplan:
                lotplan = lotplan_match.group(1)
                print(f"   ✓ Found lot/plan: {lotplan}")

    except Exception as e:
        print(f"   ✗ Area/LotPlan extraction error: {e}")
    
    return area, lotplan

def scrape_left_panel_text(page):
    """Get all text from the left info panel - WITH BETTER WAITING"""
    try:
        # Wait for zone text to appear (means panel is loaded)
        print("   Waiting for zone information to load...")
        page.wait_for_selector("text=/Medium density residential|Low density residential|High density residential/i", timeout=10000)
        page.wait_for_timeout(2000)  # Extra wait for full content
        
        # Try multiple selectors
        panel = None
        selectors = [
            ".esri-feature__content-node",
            ".esri-feature",
            ".esri-widget",
            "[class*='property-info']",
            "[class*='panel']"
        ]
        
        for selector in selectors:
            try:
                panel = page.locator(selector).first
                text = panel.inner_text(timeout=2000)
                if "zone" in text.lower() or "overlay" in text.lower():
                    print(f"   ✓ Found panel with selector: {selector}")
                    return text
            except:
                continue
        
        # Fallback to body
        print("   ⚠ Using body text as fallback")
        return page.locator("body").inner_text()
        
    except Exception as e:
        print(f"   ✗ Panel text extraction error: {e}")
        return page.locator("body").inner_text()

def extract_zone_density_overlays(panel_text):
    """Extract zone, density, and overlays from panel text"""
    
    # Debug: print first 1000 chars
    print(f"\n   [DEBUG] Panel text (first 1000 chars):")
    print("   " + "-"*50)
    print("   " + panel_text[:1000].replace("\n", "\n   "))
    print("   " + "-"*50 + "\n")
    
    # Extract Zone
    zone_match = re.search(
        r"(Low density residential|Low-medium density residential|"
        r"Medium density residential|High density residential)", 
        panel_text, re.I
    )
    zone = zone_match.group(1) if zone_match else None
    if zone:
        print(f"   ✓ Found zone: {zone}")
    
    # Extract Residential Density
    density_match = re.search(r"Residential\s+density[:\s]+(RD\d+)", panel_text, re.I)
    density = density_match.group(1) if density_match else None
    if density:
        print(f"   ✓ Found density: {density}")
    
    # Extract Overlays
    overlays = []
    overlay_section = re.search(
        r"Overlays(.*?)(?:LGIP|Local Government|Plan Zone|$)", 
        panel_text, re.DOTALL | re.I
    )
    if overlay_section:
        overlay_text = overlay_section.group(1)
        lines = [ln.strip() for ln in overlay_text.splitlines() if ln.strip()]
        exclude = ("view section", "show on map", "overlays")
        for ln in lines:
            if any(ex in ln.lower() for ex in exclude):
                continue
            if len(ln) > 5 and ln not in overlays:
                overlays.append(ln)
        print(f"   ✓ Found {len(overlays)} overlays")
    
    return zone, density, overlays

def enable_building_height_layer(page):
    """Enable the building height overlay on the map"""
    try:
        page.get_by_text("Overlays", exact=False).first.scroll_into_view_if_needed()
        page.wait_for_timeout(800)
        
        height_element = page.get_by_text("Building height", exact=False).first
        if height_element.count() > 0:
            height_element.scroll_into_view_if_needed()
            height_element.click()
            page.wait_for_timeout(2000)
            print("   ✓ Building height layer enabled")
            return True
    except Exception as e:
        print(f"   ✗ Could not enable building height: {e}")
    return False

def screenshot_map(page):
    """Take screenshot of the map with height overlay"""
    screenshot_path = "map_height.png"
    try:
        map_element = page.locator(".esri-view, #mapView").first
        map_element.screenshot(path=screenshot_path, timeout=5000)
        print(f"   ✓ Screenshot saved: {screenshot_path}")
        return screenshot_path
    except Exception as e:
        print(f"   ✗ Screenshot failed: {e}")
        return None

def scrape_goldcoast_property(query: str):
    """Main scraper function"""
    result = PropertyData(address=query, overlays=[])
    
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=500)
        page = browser.new_page()
        
        try:
            print("\n→ Loading Gold Coast City Plan...")
            page.goto(CITYPLAN_URL, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(2000)
            
            print("→ Searching for property...")
            search_box = page.locator("input[placeholder*='Search for an address']").first
            search_box.click()
            search_box.fill(query)
            page.wait_for_timeout(1500)
            
            print("→ Selecting first result...")
            page.keyboard.press("ArrowDown")
            page.wait_for_timeout(800)
            page.keyboard.press("Enter")
            page.wait_for_timeout(5000)  # Longer wait for panel to load
            
            print("→ Extracting area and lot/plan...")
            result.area_sqm, result.lot_plan = extract_area_and_lotplan(page)
            
            print("→ Extracting zone, density, and overlays...")
            panel_text = scrape_left_panel_text(page)
            result.zone, result.residential_density, result.overlays = \
                extract_zone_density_overlays(panel_text)
            
            print("→ Capturing building height overlay...")
            if enable_building_height_layer(page):
                screenshot_path = screenshot_map(page)
                if screenshot_path:
                    result.building_height = "(see screenshot)"
            
            print("\n" + "="*70)
            print("=== EXTRACTION RESULTS ===")
            print("="*70)
            print(f"{'Address:':<25} {result.address}")
            print(f"{'Lot/Plan:':<25} {result.lot_plan or 'N/A'}")
            print(f"{'Zone:':<25} {result.zone or 'N/A'}")
            print(f"{'Residential Density:':<25} {result.residential_density or 'N/A'}")
            print(f"{'Area:':<25} {result.area_sqm or 'N/A'} m²")
            print(f"{'Building Height:':<25} {result.building_height or 'N/A'}")
            
            if result.overlays:
                print(f"\nOverlays ({len(result.overlays)}):")
                for overlay in result.overlays:
                    print(f"  • {overlay}")
            else:
                print(f"\n{'Overlays:':<25} None found")
            
            print("="*70)
            
            print("\nKeeping browser open for 10 seconds for inspection...")
            page.wait_for_timeout(10000)
            
            return result
            
        except Exception as e:
            print(f"\n❌ ERROR: {e}")
            page.screenshot(path="error_screenshot.png")
            print("Error screenshot saved to: error_screenshot.png")
            raise
            
        finally:
            browser.close()

if __name__ == "__main__":
    print("\n" + "="*70)
    print("Gold Coast Property Scraper v7 - Fixed Panel Loading")
    print("="*70)
    
    if len(sys.argv) > 1:
        query = " ".join(sys.argv[1:])
    else:
        query = input("\nEnter address or lot/plan: ").strip()
    
    if not query:
        print("❌ No query provided!")
        sys.exit(1)
    
    try:
        scrape_goldcoast_property(query)
        print("\n✅ Scraping complete!\n")
    except Exception as e:
        print(f"\n❌ Scraping failed: {e}\n")
        sys.exit(1)
