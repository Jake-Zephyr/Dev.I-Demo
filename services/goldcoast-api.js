// services/goldcoast-api.js - Production API scraper (replaces browserbase.js)
import proj4 from 'proj4';

proj4.defs('EPSG:28356', '+proj=utm +zone=56 +south +datum=GRS80 +units=m +no_defs');

const SERVICES = {
  CADASTRE: 'https://maps1.goldcoast.qld.gov.au/arcgis/rest/services/Isoplan_Cadastre/MapServer/0',
  ZONE: 'https://maps1.goldcoast.qld.gov.au/arcgis/rest/services/CityPlan_V12_Zone/MapServer',
  HEIGHT: 'https://maps1.goldcoast.qld.gov.au/arcgis/rest/services/CityPlan_V12_Buildingheight/MapServer',
  OVERLAYS: 'https://maps1.goldcoast.qld.gov.au/arcgis/rest/services/V8_Overlays/MapServer'
};

// WHITELIST: Only query layers verified to return accurate data
// Based on cross-reference with official Gold Coast City Plan interactive mapping
const VERIFIED_OVERLAY_LAYERS = [
  // Acid sulfate soils
  1,    // Land at or below 5m AHD
  2,    // Land at or below 20m AHD
  
  // Airport environs
  7,    // 2047 Australian Noise Exposure Forecast (ANEF) contour
  9,    // Lighting area buffer zones
  13,   // Obstacle Limitation Surface (OLS) - polyline
  15,   // Obstacle Limitation Surface (OLS) - polygon
  17,   // PANS-OPS contour - polyline
  19,   // PANS-OPS contour - polygon
  21,   // Public safety area
  24,   // Wildlife hazard buffer zones - polyline
  25,   // Wildlife hazard buffer zones - polygon
  
  // Building height
  26,   // Building height
  
  // Bushfire
  28,   // Bushfire hazard area
  
  // Coastal erosion hazard
  31,   // Foreshore seawall line
  32,   // Foreshore seawall setback
  33,   // Foreshore seawall site
  34,   // Waterfront development control area
  
  // Dwelling house
  36,   // Dwelling house overlay area
  
  // Environmental significance - biodiversity
  39,   // Protected areas
  41,   // Coastal wetlands and islands core habitat system
  42,   // Hinterland core habitat system
  43,   // Substantial remnants
  44,   // Hinterland to coast critical corridors
  
  // Environmental significance - priority species
  47,   // State significant species
  48,   // Koala habitat areas
  50,   // Local significant species
  
  // Environmental significance - vegetation management
  53,   // Regulated vegetation
  55,   // Vegetation protection order
  56,   // Vegetation management
  
  // Environmental significance - wetlands and waterways
  59,   // State significant wetlands and aquatic systems
  61,   // Local significant wetlands
  62,   // Waterways
  64,   // Canal
  65,   // Lake
  66,   // Buffer area
  
  // Extractive resources
  74,   // Special management area
  75,   // Resource area / processing area
  76,   // Separation area
  78,   // 100m transport route separation area
  
  // Flood
  80,   // Flood assessment required
  
  // Industry, community infrastructure, agriculture
  90,   // Community infrastructure
  91,   // Industry interface area
  92,   // Community infrastructure interface area
  93,   // Agriculture land interface area
  94,   // Agriculture land
  95,   // Airport noise exposure area
  
  // Landslide
  96,   // Landslide hazard
  
  // Light rail
  100,  // Light rail urban renewal area boundary
  101,  // Light rail urban renewal area
  
  // Minimum lot size
  102,  // Minimum lot size
  
  // Mudgeeraba village
  103,  // Mudgeeraba village character
  
  // Party house
  107,  // Party house area
  
  // Regional infrastructure
  111,  // Water supply pipeline 20m buffer
  112,  // Water storage
  113,  // Water supply properties
  114,  // Ferry Road high voltage corridor (Energex)
  115,  // Major electricity infrastructure (Powerlink)
  116,  // Major electricity infrastructure (Energex)
  
  // Residential density
  117,  // Residential density
  
  // Ridges
  118,  // Ridges and significant hills protection
  
  // State controlled roads and transport noise
  120,  // Railway corridor 100m buffer
  122,  // Transport noise corridor - State-controlled road
  123,  // Transport noise corridor - railway
  124,  // Property adjacent to State controlled road
  
  // The Spit
  126,  // Overlay area
  127,  // Focus areas
  
  // Water catchments
  129,  // Dual reticulation
  130,  // Water supply buffer area
  131,  // Woongoolba flood mitigation catchment area
];

// EXCLUDED layers that return inaccurate/irrelevant data:
// 14 - Outer horizontal surface 15km (covers entire city, not property-specific)
// 18 - Horizontal plane labels (annotation layer, not useful)
// 83 - Local heritage place (returns false positives)
// 84 - Heritage place polygon (returns false positives)
// 85 - Heritage protection boundary (returns false positives)
// 86 - Heritage adjoining lot (returns false positives)
// 121 - State controlled road (line geometry, not property-specific)

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
 * Get cadastre by lot/plan number directly - returns geometry
 */
async function getCadastreByLotPlan(lotplan) {
  console.log(`[API] Querying cadastre by lot/plan: ${lotplan}`);
  
  const url = `${SERVICES.CADASTRE}/query`;
  const params = new URLSearchParams({
    f: 'json',
    where: `upper(LOTPLAN) = upper('${lotplan}')`,
    outFields: '*',
    outSR: '28356',  // Return in MGA56 for direct use
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
    'nerang', 'mudgeeraba', 'currumbin', 'coolangatta', 'miami', 'nobby beach',
    'runaway bay', 'paradise point', 'biggera waters', 'labrador', 'arundel',
    'pacific pines', 'gaven', 'highland park', 'carrara', 'merrimac',
    'worongary', 'tallai', 'bonogin', 'reedy creek', 'elanora', 'tugun',
    'bilinga', 'kirra', 'tweed heads', 'banora point', 'terranora',
    'hope island', 'sanctuary cove', 'oxenford', 'coomera', 'upper coomera',
    'helensvale', 'maudsland', 'jacobs well', 'ormeau', 'pimpama'
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
 * Get cadastre data by coordinates - returns geometry for overlay queries
 * Handles unit number lookup if provided
 */
async function getCadastreWithGeometry(lat, lon, unitNumber) {
  console.log(`[API] Querying cadastre with geometry...`);
  
  // Convert to Web Mercator (EPSG:3857) for cadastre service
  const [x3857, y3857] = proj4('EPSG:4326', 'EPSG:3857', [lon, lat]);
  const url = `${SERVICES.CADASTRE}/query`;
  
  // Try with small buffer first, then larger if needed
  const buffers = [5, 20, 50];
  let feature = null;
  
  for (const buffer of buffers) {
    const params = new URLSearchParams({
      f: 'json',
      geometry: JSON.stringify({
        x: Math.round(x3857),
        y: Math.round(y3857),
        spatialReference: { wkid: 3857 }
      }),
      geometryType: 'esriGeometryPoint',
      distance: buffer,
      units: 'esriSRUnit_Meter',
      inSR: '3857',
      outSR: '28356',  // Return in MGA56 for direct use
      spatialRel: 'esriSpatialRelIntersects',
      outFields: '*',
      returnGeometry: 'true'  // GET THE GEOMETRY
    });
    
    const resp = await fetch(`${url}?${params}`);
    const data = await resp.json();
    
    if (data.features?.[0]) {
      feature = data.features[0];
      console.log(`[API] ✓ Found lot: ${feature.attributes.LOTPLAN} (buffer: ${buffer}m)`);
      break;
    }
    
    if (buffer < buffers[buffers.length - 1]) {
      console.log(`[API] Not found with ${buffer}m buffer, trying larger...`);
    }
  }
  
  if (!feature) {
    throw new Error('Property not found in cadastre');
  }
  
  // Handle unit lookup if needed
  if (unitNumber && feature.attributes.NUMBEROFUNITS > 1) {
    const specificLotPlan = feature.attributes.LOTPLAN.replace(/^\d+/, unitNumber);
    console.log(`[API] Querying unit: ${specificLotPlan}...`);
    
    const params2 = new URLSearchParams({
      f: 'json',
      where: `upper(LOTPLAN) = upper('${specificLotPlan}')`,
      outFields: '*',
      outSR: '28356',
      returnGeometry: 'true'
    });
    
    const resp2 = await fetch(`${url}?${params2}`);
    const data2 = await resp2.json();
    
    if (data2.features?.[0]) {
      feature = data2.features[0];
      console.log(`[API] ✓ Found unit ${unitNumber}: ${feature.attributes.AREA_SIZE_SQ_M}sqm`);
    } else {
      console.log(`[API] Unit ${unitNumber} not found, using parent lot`);
    }
  }
  
  return feature;
}

/**
 * Calculate bounding box from polygon rings
 */
function getBoundingBox(rings) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  
  return { minX, minY, maxX, maxY };
}

/**
 * Get zone information using lot geometry
 */
async function getZone(lotGeometry) {
  console.log(`[API] Querying zone...`);
  
  const bbox = getBoundingBox(lotGeometry.rings);
  
  const url = `${SERVICES.ZONE}/identify`;
  const params = new URLSearchParams({
    f: 'json',
    geometry: JSON.stringify(lotGeometry),
    geometryType: 'esriGeometryPolygon',
    sr: '28356',
    mapExtent: `${bbox.minX},${bbox.minY},${bbox.maxX},${bbox.maxY}`,
    imageDisplay: '400,400,96',
    tolerance: '0',  // Use exact geometry, no tolerance
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
 * Get building height information using lot geometry
 */
async function getHeight(lotGeometry) {
  console.log(`[API] Querying height...`);
  
  const bbox = getBoundingBox(lotGeometry.rings);
  
  const url = `${SERVICES.HEIGHT}/identify`;
  const params = new URLSearchParams({
    f: 'json',
    geometry: JSON.stringify(lotGeometry),
    geometryType: 'esriGeometryPolygon',
    sr: '28356',
    mapExtent: `${bbox.minX},${bbox.minY},${bbox.maxX},${bbox.maxY}`,
    imageDisplay: '400,400,96',
    tolerance: '0',
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
 * Get overlays using ACTUAL LOT GEOMETRY (not buffered centroid)
 * This ensures we only get overlays that genuinely intersect the property
 */
async function getOverlays(lotGeometry) {
  console.log(`[API] Querying overlays using actual lot geometry (${VERIFIED_OVERLAY_LAYERS.length} layers)...`);
  
  const bbox = getBoundingBox(lotGeometry.rings);
  const layers = VERIFIED_OVERLAY_LAYERS.join(',');
  
  const url = `${SERVICES.OVERLAYS}/identify`;
  const params = new URLSearchParams({
    f: 'json',
    geometry: JSON.stringify(lotGeometry),
    geometryType: 'esriGeometryPolygon',
    sr: '28356',
    mapExtent: `${bbox.minX},${bbox.minY},${bbox.maxX},${bbox.maxY}`,
    imageDisplay: '400,400,96',
    tolerance: '0',  // ZERO tolerance - exact intersection only
    layers: `visible:${layers}`,
    returnGeometry: 'false'
  });
  
  const resp = await fetch(`${url}?${params}`);
  const data = await resp.json();
  
  if (data.results?.length > 0) {
    console.log(`[API] ✓ Found ${data.results.length} overlays`);
    const layerIds = data.results.map(r => r.layerId).join(', ');
    console.log(`[API] Layer IDs with data: ${layerIds}`);
    return data.results;
  }
  
  console.log(`[API] ⚠️ No overlays found`);
  return [];
}

/**
 * Main scraper function - uses actual lot geometry for accurate overlay detection
 * @param {string} query - Address or lot/plan to search
 * @param {function} sendProgress - Optional progress callback
 * @returns {Promise<object>} Property data
 */
export async function scrapeProperty(query, sendProgress = null) {
  const startTime = Date.now();
  console.log(`[API] Starting property lookup: ${query}`);
  
  try {
    // Detect if query is lot/plan or address
    const { type, value } = detectQueryType(query);
    console.log(`[API] Detected query type: ${type}`);
    
    let feature;  // Will contain both attributes AND geometry
    
    if (type === 'lotplan') {
      // Direct lot/plan lookup - returns geometry in MGA56
      if (sendProgress) sendProgress('📋 Looking up lot/plan...');
      feature = await getCadastreByLotPlan(value);
      
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
      
      // Get cadastre with geometry
      if (sendProgress) sendProgress('📋 Retrieving lot information...');
      feature = await getCadastreWithGeometry(lat, lon, unitNumber);
    }
    
    // Verify we have geometry
    if (!feature.geometry || !feature.geometry.rings) {
      throw new Error('No geometry returned for property');
    }
    
    const cadastre = feature.attributes;
    const lotGeometry = {
      rings: feature.geometry.rings,
      spatialReference: { wkid: 28356 }
    };
    
    console.log(`[API] Using lot geometry with ${lotGeometry.rings[0].length} vertices`);
    
    // Get zone, height, overlays IN PARALLEL using actual lot geometry
    if (sendProgress) sendProgress('🏗️ Analyzing zoning and overlays...');
    const [zone, height, overlays] = await Promise.all([
      getZone(lotGeometry),
      getHeight(lotGeometry),
      getOverlays(lotGeometry)
    ]);
    
    // Extract density from overlays (layer 117)
    const densityOverlay = overlays.find(o => o.layerId === 117);
    const density = densityOverlay?.attributes?.Residential_Density || null;
    
    // Extract overlay names and DEDUPLICATE
    const overlayNames = [...new Set(overlays.map(o => o.layerName))];
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[API] ✓ Complete in ${elapsed}s`);
    
    if (sendProgress) sendProgress(`✅ Property data retrieved in ${elapsed}s`);
    
    return {
      success: true,
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
      apiVersion: '2.1-geometry',
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
 * Handle overlay-only requests using actual lot geometry
 */
export async function scrapePropertyOverlaysOnly(address, sendProgress = null) {
  console.log(`[API] Overlays-only lookup for: ${address}`);
  
  try {
    if (sendProgress) sendProgress('🌍 Locating property...');
    const { lat, lon } = await geocodeAddress(address);
    
    if (sendProgress) sendProgress('📋 Retrieving lot geometry...');
    const feature = await getCadastreWithGeometry(lat, lon, null);
    
    if (!feature.geometry || !feature.geometry.rings) {
      throw new Error('No geometry returned for property');
    }
    
    const lotGeometry = {
      rings: feature.geometry.rings,
      spatialReference: { wkid: 28356 }
    };
    
    if (sendProgress) sendProgress('🗺️ Retrieving overlays...');
    const overlays = await getOverlays(lotGeometry);
    
    const overlayNames = [...new Set(overlays.map(o => o.layerName))];
    
    return {
      success: true,
      property: {
        overlays: overlayNames
      }
    };
    
  } catch (error) {
    console.error('[API ERROR]', error.message);
    throw new Error(`Overlay lookup failed: ${error.message}`);
  }
}

export default { scrapeProperty, scrapePropertyOverlaysOnly, geocodeAddress };
