// services/goldcoast-api.js - Production API scraper (replaces browserbase.js)
import proj4 from 'proj4';

proj4.defs('EPSG:28356', '+proj=utm +zone=56 +south +datum=GRS80 +units=m +no_defs');

const SERVICES = {
  CADASTRE: 'https://maps1.goldcoast.qld.gov.au/arcgis/rest/services/Isoplan_Cadastre/MapServer/0',
  ZONE: 'https://maps1.goldcoast.qld.gov.au/arcgis/rest/services/CityPlan_V12_Zone/MapServer',
  HEIGHT: 'https://maps1.goldcoast.qld.gov.au/arcgis/rest/services/CityPlan_V12_Buildingheight/MapServer',
  OVERLAYS: 'https://maps1.goldcoast.qld.gov.au/arcgis/rest/services/V8_Overlays/MapServer'
};

/**
 * Detect if query is a lot/plan or address
 */
function detectQueryType(query) {
  // Match lot/plan patterns like: 4GTP446, 123RP12345, 1SP123456
  const lotplanPattern = /^\d+[A-Z]{2,4}\d+$/i;
  if (lotplanPattern.test(query.trim())) {
    return { type: 'lotplan', value: query.trim().toUpperCase() };
  }
  return { type: 'address', value: query };
}

/**
 * Get cadastre by lot/plan number directly
 */
async function getCadastreByLotPlan(lotplan) {
  console.log(`[API] Querying cadastre by lot/plan: ${lotplan}`);
  
  const url = `${SERVICES.CADASTRE}/query`;
  const params = new URLSearchParams({
    f: 'json',
    where: `upper(LOTPLAN) = upper('${lotplan}')`,
    outFields: '*',
    outSR: '3857',
    returnGeometry: 'true'
  });
  
  const resp = await fetch(`${url}?${params}`);
  const data = await resp.json();
  
  if (data.features?.[0]) {
    console.log(`[API] ✓ Found lot/plan: ${lotplan}`);
    return data.features[0];
  }
  
  throw new Error(`Lot/plan ${lotplan} not found in cadastre`);
}

/**
 * Geocode address with smart disambiguation
 * If address is incomplete, returns multiple suggestions
 */
async function geocodeAddress(address) {
  console.log(`[API] Geocoding: ${address}`);
  
  // Check if address looks complete (has suburb)
  const goldCoastSuburbs = [
    'mermaid waters', 'burleigh heads', 'palm beach', 'surfers paradise',
    'broadbeach', 'southport', 'main beach', 'robina', 'varsity lakes',
    'clear island waters', 'benowa', 'bundall', 'ashmore', 'molendinar',
    'nerang', 'mudgeeraba', 'currumbin', 'coolangatta', 'miami', 'nobby beach'
  ];
  
  const hasSuburb = goldCoastSuburbs.some(suburb => 
    address.toLowerCase().includes(suburb)
  );
  
  const hasPostcode = /\b4\d{3}\b/.test(address);
  
  // If incomplete address, search for suggestions
  if (!hasSuburb && !hasPostcode) {
    console.log(`[API] Address incomplete, searching for matches...`);
    
    try {
      const url = `https://nominatim.openstreetmap.org/search`;
      const params = new URLSearchParams({
        q: address + ', Gold Coast, Queensland, Australia',
        format: 'json',
        limit: 5,
        countrycodes: 'au',
        addressdetails: 1
      });
      
      const response = await fetch(`${url}?${params}`, {
        headers: { 'User-Agent': 'GoldCoastPropertyAdvisor/2.0' }
      });
      const data = await response.json();
      
      const goldCoastResults = data.filter(r => 
        r.display_name.toLowerCase().includes('gold coast')
      );
      
      if (goldCoastResults.length > 1) {
        const suggestions = goldCoastResults.slice(0, 3).map(r => ({
          address: r.display_name,
          lat: parseFloat(r.lat),
          lon: parseFloat(r.lon)
        }));
        
        console.log(`[API] Found ${suggestions.length} possible matches`);
        
        const error = new Error('DISAMBIGUATION_NEEDED');
        error.suggestions = suggestions;
        throw error;
      }
      
      if (goldCoastResults.length === 1) {
        console.log(`[API] Single match found, using it`);
        const result = goldCoastResults[0];
        return {
          lat: parseFloat(result.lat),
          lon: parseFloat(result.lon),
          confidence: 80
        };
      }
    } catch (error) {
      if (error.message === 'DISAMBIGUATION_NEEDED') {
        throw error;
      }
      console.log(`[API] Nominatim search failed:`, error.message);
    }
  }
  
  // TRY 1: Queensland Government Geocoder
  try {
    const url = 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Location/QldLocator/GeocodeServer/findAddressCandidates';
    
    const params = new URLSearchParams({
      f: 'json',
      SingleLine: address,
      outFields: '*',
      maxLocations: 1
    });
    
    const response = await fetch(`${url}?${params}`);
    const data = await response.json();
    
    if (data.candidates?.[0]) {
      const candidate = data.candidates[0];
      const xMercator = candidate.location.x;
      const yMercator = candidate.location.y;
      const score = candidate.score;
      
      const [lon, lat] = proj4('EPSG:3857', 'EPSG:4326', [xMercator, yMercator]);
      
      console.log(`[API] QLD Geocoder: ${lat}, ${lon} (confidence: ${score}%)`);
      return { lat, lon, confidence: score };
    }
  } catch (error) {
    console.log(`[API] QLD geocoder failed, trying Nominatim...`);
  }
  
  // TRY 2: Nominatim fallback
  try {
    const url = `https://nominatim.openstreetmap.org/search`;
    const params = new URLSearchParams({
      q: address,
      format: 'json',
      limit: 1,
      countrycodes: 'au'
    });
    
    const response = await fetch(`${url}?${params}`, {
      headers: { 'User-Agent': 'GoldCoastPropertyAdvisor/2.0' }
    });
    const data = await response.json();
    
    if (data[0]) {
      const lat = parseFloat(data[0].lat);
      const lon = parseFloat(data[0].lon);
      
      console.log(`[API] Nominatim: ${lat}, ${lon}`);
      return { lat, lon, confidence: 85 };
    }
 } catch (error) {
    console.log(`[API] Nominatim also failed`);
  }
  
  throw new Error('Address not found by any geocoder');
}

/**
 * Create polygon geometry for ArcGIS queries
 */
function createPolygon(x, y, buffer = 50) {
  return {
    rings: [[[x-buffer, y-buffer], [x+buffer, y-buffer], [x+buffer, y+buffer], [x-buffer, y+buffer], [x-buffer, y-buffer]]],
    spatialReference: { wkid: 28356 }
  };
}

/**
 * Get cadastre data (Lot/Plan and Area)
 * Handles unit number lookup if provided
 */
async function getCadastre(lat, lon, unitNumber) {
  console.log(`[API] Querying cadastre...`);
  
  // Convert to Web Mercator (EPSG:3857) for cadastre service
  const [x3857, y3857] = proj4('EPSG:4326', 'EPSG:3857', [lon, lat]);
  const url = `${SERVICES.CADASTRE}/query`;
  
  // STEP 1: Query by coordinates to get parent lot
  // Try with small buffer first, then larger if needed
  const buffers = [5, 20, 50]; // Try progressively larger search areas
  let parentLot = null;
  
  for (const buffer of buffers) {
    const geometry = { x: Math.round(x3857), y: Math.round(y3857) };
    const params = new URLSearchParams({
      f: 'json',
      geometry: JSON.stringify({
        x: geometry.x,
        y: geometry.y,
        spatialReference: { wkid: 3857 }
      }),
      geometryType: 'esriGeometryPoint',
      distance: buffer,
      units: 'esriSRUnit_Meter',
      inSR: '3857',
      outSR: '3857',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: '*',
      returnGeometry: 'false'
    });
    
    const resp = await fetch(`${url}?${params}`);
    const data = await resp.json();
    
    if (data.features?.[0]) {
      parentLot = data.features[0].attributes;
      console.log(`[API] ✓ Found parent lot: ${parentLot.LOTPLAN} (buffer: ${buffer}m)`);
      break;
    }
    
    if (buffer < buffers[buffers.length - 1]) {
      console.log(`[API] Not found with ${buffer}m buffer, trying larger...`);
    }
  }
  
  if (!parentLot) {
    throw new Error('Property not found in cadastre');
  }
  
  // STEP 2: If unit number provided, query specific unit
  if (unitNumber && parentLot.NUMBEROFUNITS > 1) {
    const specificLotPlan = parentLot.LOTPLAN.replace(/^\d+/, unitNumber);
    console.log(`[API] Querying unit: ${specificLotPlan}...`);
    
    const params2 = new URLSearchParams({
      f: 'json',
      where: `upper(LOTPLAN) = upper('${specificLotPlan}')`,
      outFields: '*',
      outSR: '3857',
      returnGeometry: 'false'
    });
    
    const resp2 = await fetch(`${url}?${params2}`);
    const data2 = await resp2.json();
    
    if (data2.features?.[0]) {
      const unitLot = data2.features[0].attributes;
      console.log(`[API] ✓ Found unit ${unitNumber}: ${unitLot.AREA_SIZE_SQ_M}sqm`);
      return unitLot;
    }
    
    console.log(`[API] Unit ${unitNumber} not found, using parent lot`);
  }
  
  return parentLot;
}

/**
 * Get zone information
 */
async function getZone(coords) {
  console.log(`[API] Querying zone...`);
  
  const url = `${SERVICES.ZONE}/identify`;
  const params = new URLSearchParams({
    f: 'json',
    geometry: JSON.stringify(createPolygon(coords.x, coords.y)),
    geometryType: 'esriGeometryPolygon',
    sr: '28356',
    mapExtent: `${coords.x-50},${coords.y-50},${coords.x+50},${coords.y+50}`,
    imageDisplay: '400,400,96',
    tolerance: '50',
    layers: 'all:0',
    returnGeometry: 'false'
  });
  
  const resp = await fetch(`${url}?${params}`);
  const data = await resp.json();
  
  if (data.results?.[0]) {
    console.log(`[API] ✓ Zone: ${data.results[0].attributes.Zone}`);
    return data.results[0].attributes;
  }
  
  console.log(`[API] ⚠️ No zone data found`);
  return null;
}

/**
 * Get building height information
 */
async function getHeight(coords) {
  console.log(`[API] Querying height...`);
  
  const url = `${SERVICES.HEIGHT}/identify`;
  const params = new URLSearchParams({
    f: 'json',
    geometry: JSON.stringify(createPolygon(coords.x, coords.y)),
    geometryType: 'esriGeometryPolygon',
    sr: '28356',
    mapExtent: `${coords.x-50},${coords.y-50},${coords.x+50},${coords.y+50}`,
    imageDisplay: '400,400,96',
    tolerance: '50',
    layers: 'all:0',
    returnGeometry: 'false'
  });
  
  const resp = await fetch(`${url}?${params}`);
  const data = await resp.json();
  
  if (data.results?.[0]) {
    const height = data.results[0].attributes['Height (m)'];
    console.log(`[API] ✓ Height: ${height || 'No restriction'}`);
    return data.results[0].attributes;
  }
  
  console.log(`[API] ⚠️ No height data found`);
  return null;
}

/**
 * Get overlays (including density)
 */
async function getOverlays(coords) {
  console.log(`[API] Querying overlays...`);
  
  // Query ALL overlay layers (0-131) - City Plan website checks every single one
  // Only layers with actual data will be returned
  const layerNumbers = Array.from({length: 132}, (_, i) => i); // [0,1,2,...,131]
  const layers = layerNumbers.join(',');
  const url = `${SERVICES.OVERLAYS}/identify`;
  const params = new URLSearchParams({
    f: 'json',
    geometry: JSON.stringify(createPolygon(coords.x, coords.y)),
    geometryType: 'esriGeometryPolygon',
    sr: '28356',
    mapExtent: `${coords.x-50},${coords.y-50},${coords.x+50},${coords.y+50}`,
    imageDisplay: '400,400,96',
    tolerance: '50',
    layers: `visible:${layers}`,
    returnGeometry: 'false'
  });
  
  const resp = await fetch(`${url}?${params}`);
  const data = await resp.json();
  
  if (data.results?.length > 0) {
    console.log(`[API] ✓ Found ${data.results.length} overlays`);
    // Debug: Show which layer IDs returned data
    const layerIds = data.results.map(r => r.layerId).join(', ');
    console.log(`[API] Layer IDs with data: ${layerIds}`);
    return data.results;
  }
  
  console.log(`[API] ⚠️ No overlays found`);
  return [];
}

/**
 * Main scraper function - matches browserbase.js API
 * @param {string} query - Address to search
 * @param {function} sendProgress - Optional progress callback
 * @returns {Promise<object>} Property data in browserbase format
 */
export async function scrapeProperty(query, sendProgress = null) {
  const startTime = Date.now();
  console.log(`[API] Starting property lookup: ${query}`);
  
  try {
    // Detect if query is lot/plan or address
    const { type, value } = detectQueryType(query);
    console.log(`[API] Detected query type: ${type}`);
    
    let cadastre, coords;
    
    if (type === 'lotplan') {
      // Direct lot/plan lookup
      if (sendProgress) sendProgress('📋 Looking up lot/plan...');
      const feature = await getCadastreByLotPlan(value);
      cadastre = feature.attributes;
      
      // Get centroid coordinates from geometry for zone/overlay queries
      const geom = feature.geometry;
      if (geom && geom.rings) {
        // Calculate centroid of polygon
        const ring = geom.rings[0];
        const xSum = ring.reduce((sum, pt) => sum + pt[0], 0);
        const ySum = ring.reduce((sum, pt) => sum + pt[1], 0);
        const xCentroid = xSum / ring.length;
        const yCentroid = ySum / ring.length;
        
        // Convert from Web Mercator to MGA56
        const [lon, lat] = proj4('EPSG:3857', 'EPSG:4326', [xCentroid, yCentroid]);
        const [x, y] = proj4('EPSG:4326', 'EPSG:28356', [lon, lat]);
        coords = { x: Math.round(x), y: Math.round(y) };
      } else {
        throw new Error('No geometry returned for lot/plan');
      }
      
    } else {
      // Address lookup with unit parsing
      const unitMatch = value.match(/^(\d+)[\/\-]|^Unit\s+(\d+)/i);
      const unitNumber = unitMatch ? (unitMatch[1] || unitMatch[2]) : null;
      const cleanAddress = unitNumber ? value.replace(/^\d+[\/\-]\s*|^Unit\s+\d+,?\s*/i, '').trim() : value;
      
      if (unitNumber) {
        console.log(`[API] Detected unit ${unitNumber}, base address: ${cleanAddress}`);
        if (sendProgress) sendProgress(`🏢 Searching for Unit ${unitNumber}...`);
      }
      
      // Geocode address
      if (sendProgress) sendProgress('🌍 Locating property...');
      const { lat, lon } = await geocodeAddress(cleanAddress);
      
      // Convert to MGA56 for spatial queries
      const [x, y] = proj4('EPSG:4326', 'EPSG:28356', [lon, lat]);
      coords = { x: Math.round(x), y: Math.round(y) };
      
      // Get cadastre data (handles unit lookup)
      if (sendProgress) sendProgress('📋 Retrieving lot information...');
      cadastre = await getCadastre(lat, lon, unitNumber);
    }
    
    // Get zone, height, overlays IN PARALLEL for speed
    if (sendProgress) sendProgress('🏗️ Analyzing zoning and overlays...');
    const [zone, height, overlays] = await Promise.all([
      getZone(coords),
      getHeight(coords),
      getOverlays(coords)
    ]);
    
    // Extract density from overlays (layer 117)
    const densityOverlay = overlays.find(o => o.layerId === 117);
    const density = densityOverlay?.attributes?.Residential_Density || null;
    
    // Extract overlay names and DEDUPLICATE (multiple layers can have same name)
    const overlayNames = [...new Set(overlays.map(o => o.layerName))];
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[API] ✓ Complete in ${elapsed}s`);
    
    if (sendProgress) sendProgress(`✅ Property data retrieved in ${elapsed}s`);
    
    // Return in browserbase.js format
    return {
      property: {
        lotplan: cadastre.LOTPLAN,
        address: cadastre.LONG_ADDRESS || cadastre.HOUSE_ADDRESS || query,
        zone: zone?.Zone || null,
        zoneCode: density,
        density: density,
        height: height?.['Height (m)'] || null,
        area: cadastre.AREA_SIZE_SQ_M ? `${Math.round(cadastre.AREA_SIZE_SQ_M)}sqm` : null,
        overlays: overlayNames
      },
      planningContext: {
        zoneDescription: null,
        lapRequirements: null,
        overlayRestrictions: null
      },
      scrapedAt: new Date().toISOString(),
      apiVersion: '2.0',
      timeTaken: elapsed
    };
    
  } catch (error) {
    // Handle disambiguation requests
    if (error.message === 'DISAMBIGUATION_NEEDED') {
      console.log(`[API] Disambiguation needed, returning suggestions`);
      return {
        needsDisambiguation: true,
        suggestions: error.suggestions,
        originalQuery: query
      };
    }
    
    console.error('[API ERROR]', error.message);
    throw new Error(`Property lookup failed: ${error.message}`);
  }
}

/**
 * Handle overlay-only requests (for follow-up queries)
 * This is faster as it skips cadastre and zone lookups
 */
export async function scrapePropertyOverlaysOnly(address, sendProgress = null) {
  console.log(`[API] Overlays-only lookup for: ${address}`);
  
  try {
    if (sendProgress) sendProgress('🌍 Locating property...');
    const { lat, lon } = await geocodeAddress(address);
    
    const [x, y] = proj4('EPSG:4326', 'EPSG:28356', [lon, lat]);
    const coords = { x: Math.round(x), y: Math.round(y) };
    
    if (sendProgress) sendProgress('🗺️ Retrieving overlays...');
    const overlays = await getOverlays(coords);
    
    const overlayNames = overlays.map(o => o.layerName);
    
    return {
      property: {
        overlays: overlayNames
      }
    };
    
  } catch (error) {
    console.error('[API ERROR]', error.message);
    throw new Error(`Overlay lookup failed: ${error.message}`);
  }
}

export default { scrapeProperty, scrapePropertyOverlaysOnly };
