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
const VERIFIED_OVERLAY_LAYERS = [
  1, 2, 7, 9, 13, 15, 17, 19, 21, 24, 25, 26, 28, 31, 32, 33, 34, 36, 39, 41, 42, 43, 44,
  47, 48, 50, 53, 55, 56, 59, 61, 62, 64, 65, 66, 74, 75, 76, 78, 80, 90, 91, 92, 93, 94,
  95, 96, 100, 101, 102, 103, 107, 111, 112, 113, 114, 115, 116, 117, 118, 120, 122, 123,
  124, 126, 127, 129, 130, 131
];

/**
 * Extract street name from an address for comparison
 */
function extractStreetName(address) {
  if (!address) return '';
  
  // Normalize: lowercase, remove extra spaces
  const normalized = address.toLowerCase().trim();
  
  // Remove unit numbers like "1/23" or "Unit 5"
  let cleaned = normalized.replace(/^(\d+\/\d+|\d+[a-z]?\/|unit\s*\d+,?\s*)/i, '');
  
  // Remove suburb and postcode from end
  cleaned = cleaned.replace(/,?\s*(southport|surfers paradise|broadbeach|mermaid waters|palm beach|burleigh|gold coast|qld|queensland|\d{4}).*$/i, '');
  
  // Try to extract just the street name (without number)
  const match = cleaned.match(/^\d+[a-z]?\-?\d*\s+(.+)/i);
  if (match) {
    return match[1].trim();
  }
  
  return cleaned.trim();
}

/**
 * Extract street number from an address
 */
function extractStreetNumber(address) {
  if (!address) return '';
  const match = address.match(/^(\d+[a-z]?)/i);
  return match ? match[1].toLowerCase() : '';
}

/**
 * Check if two addresses likely refer to the same property or nearby
 * Returns: 'exact', 'same_street', 'different', or 'unknown'
 */
function compareAddresses(searchedAddress, returnedAddress) {
  const searchStreet = extractStreetName(searchedAddress);
  const returnStreet = extractStreetName(returnedAddress);
  const searchNum = extractStreetNumber(searchedAddress);
  const returnNum = extractStreetNumber(returnedAddress);
  
  console.log(`[API] Comparing: "${searchStreet}" (#${searchNum}) vs "${returnStreet}" (#${returnNum})`);
  
  if (!searchStreet || !returnStreet) return 'unknown';
  
  // Check if streets match
  const searchWords = searchStreet.split(/\s+/).filter(w => w.length > 2);
  const returnWords = returnStreet.split(/\s+/).filter(w => w.length > 2);
  
  // Get main street name (first word)
  const searchMain = searchWords[0];
  const returnMain = returnWords[0];
  
  // Streets are different
  if (searchMain !== returnMain) {
    // Check for partial match (in case of abbreviations)
    const matchingWords = searchWords.filter(w => returnWords.includes(w));
    if (matchingWords.length === 0) {
      return 'different';
    }
  }
  
  // Same street - check if same number
  if (searchNum && returnNum && searchNum === returnNum) {
    return 'exact';
  }
  
  return 'same_street';
}

/**
 * Check if two addresses likely refer to the same street (legacy function for geocoder)
 */
function addressesMatch(searchedAddress, returnedAddress) {
  const result = compareAddresses(searchedAddress, returnedAddress);
  return result === 'exact' || result === 'same_street';
}

/**
 * Detect if query is a lot/plan or address
 */
function detectQueryType(query) {
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
    outSR: '28356',
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
 */
export async function geocodeAddress(address) {
  console.log(`[API] Geocoding: ${address}`);
  
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
          confidence: 80,
          matchedAddress: result.display_name
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
      maxLocations: 5
    });
    
    const response = await fetch(`${url}?${params}`);
    const data = await response.json();
    
    if (data.candidates?.length > 0) {
      // Find the best matching candidate
      for (const candidate of data.candidates) {
        const candidateAddress = candidate.attributes?.Match_addr || candidate.address || '';
        
        console.log(`[API] Checking candidate: ${candidateAddress} (score: ${candidate.score})`);
        
        if (addressesMatch(address, candidateAddress)) {
          const xMercator = candidate.location.x;
          const yMercator = candidate.location.y;
          const [lon, lat] = proj4('EPSG:3857', 'EPSG:4326', [xMercator, yMercator]);
          
          console.log(`[API] ✓ QLD Geocoder matched: ${candidateAddress}`);
          return { 
            lat, 
            lon, 
            confidence: candidate.score,
            matchedAddress: candidateAddress
          };
        }
      }
      
      // No matching street found
      console.log(`[API] ⚠️ Geocoder returned results but none match the searched street`);
      
      const suggestions = data.candidates.slice(0, 3).map(c => {
        const [lon, lat] = proj4('EPSG:3857', 'EPSG:4326', [c.location.x, c.location.y]);
        return {
          address: c.attributes?.Match_addr || c.address,
          lat,
          lon
        };
      });
      
      const error = new Error('ADDRESS_NOT_FOUND');
      error.searchedAddress = address;
      error.suggestions = suggestions;
      throw error;
    }
  } catch (error) {
    if (error.message === 'ADDRESS_NOT_FOUND' || error.message === 'DISAMBIGUATION_NEEDED') {
      throw error;
    }
    console.log(`[API] QLD geocoder failed, trying Nominatim...`);
  }
  
  // TRY 2: Nominatim fallback
  try {
    const url = `https://nominatim.openstreetmap.org/search`;
    const params = new URLSearchParams({
      q: address,
      format: 'json',
      limit: 5,
      countrycodes: 'au',
      addressdetails: 1
    });
    
    const response = await fetch(`${url}?${params}`, {
      headers: { 'User-Agent': 'GoldCoastPropertyAdvisor/2.0' }
    });
    const data = await response.json();
    
    if (data.length > 0) {
      for (const result of data) {
        if (addressesMatch(address, result.display_name)) {
          const lat = parseFloat(result.lat);
          const lon = parseFloat(result.lon);
          
          console.log(`[API] ✓ Nominatim matched: ${result.display_name}`);
          return { 
            lat, 
            lon, 
            confidence: 85,
            matchedAddress: result.display_name
          };
        }
      }
      
      console.log(`[API] ⚠️ Nominatim returned results but none match the searched street`);
      
      const suggestions = data.slice(0, 3).map(r => ({
        address: r.display_name,
        lat: parseFloat(r.lat),
        lon: parseFloat(r.lon)
      }));
      
      const error = new Error('ADDRESS_NOT_FOUND');
      error.searchedAddress = address;
      error.suggestions = suggestions;
      throw error;
    }
  } catch (error) {
    if (error.message === 'ADDRESS_NOT_FOUND' || error.message === 'DISAMBIGUATION_NEEDED') {
      throw error;
    }
    console.log(`[API] Nominatim also failed`);
  }
  
  // Nothing found at all
  const error = new Error('ADDRESS_NOT_FOUND');
  error.searchedAddress = address;
  error.suggestions = [];
  throw error;
}

/**
 * Search cadastre by address string directly - more accurate than geocoding
 * Returns all matching properties at that address
 */
async function searchCadastreByAddress(address) {
  console.log(`[API] Searching cadastre by address: ${address}`);

  // Extract street number and name for search
  const streetNum = extractStreetNumber(address);
  const streetName = extractStreetName(address);

  if (!streetName) {
    return null;
  }

  const url = `${SERVICES.CADASTRE}/query`;

  // Build WHERE clause - search for properties matching street name and number
  // Must match street number at start of address AND contain street name
  // Using UPPER() for case-insensitive matching
  const streetNumUpper = streetNum.toUpperCase();
  const streetNameUpper = streetName.toUpperCase();

  let whereClause = `(UPPER(HOUSE_ADDRESS) LIKE '${streetNumUpper} %' OR UPPER(HOUSE_ADDRESS) LIKE '% ${streetNumUpper} %' OR UPPER(LONG_ADDRESS) LIKE '${streetNumUpper} %' OR UPPER(LONG_ADDRESS) LIKE '% ${streetNumUpper} %') AND (UPPER(HOUSE_ADDRESS) LIKE '%${streetNameUpper}%' OR UPPER(LONG_ADDRESS) LIKE '%${streetNameUpper}%')`;

  const params = new URLSearchParams({
    f: 'json',
    where: whereClause,
    outFields: '*',
    outSR: '28356',
    returnGeometry: 'true'
  });

  const resp = await fetch(`${url}?${params}`);
  const data = await resp.json();

  if (data.features && data.features.length > 0) {
    console.log(`[API] ✓ Found ${data.features.length} cadastre match(es) for address search`);

    // Sort by area (largest first) to prioritize parent lots
    const sorted = data.features.sort((a, b) => {
      const areaA = a.attributes.AREA_SIZE_SQ_M || 0;
      const areaB = b.attributes.AREA_SIZE_SQ_M || 0;
      return areaB - areaA;
    });

    return sorted;
  }

  console.log(`[API] No cadastre matches found by address search`);
  return null;
}

/**
 * Get cadastre data by coordinates - returns geometry for overlay queries
 * Now includes validation against original search address
 * Also detects strata lots and tries to find parent parcel
 */
async function getCadastreWithGeometry(lat, lon, unitNumber, originalAddress) {
  console.log(`[API] Querying cadastre with geometry...`);
  
  const [x3857, y3857] = proj4('EPSG:4326', 'EPSG:3857', [lon, lat]);
  const url = `${SERVICES.CADASTRE}/query`;
  
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
      outSR: '28356',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: '*',
      returnGeometry: 'true'
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
  
  // *** CHECK IF THIS IS A STRATA/UNIT LOT AND FIND PARENT PARCEL ***
  // Only do this if:
  // 1. User didn't specifically ask for a unit (no unitNumber)
  // 2. The lot is part of a BUP (Building Unit Plan) or GTP (Group Titles Plan) - these are strata
  // 3. Or it's an SP with suspiciously small area (<150sqm)
  
  const lotplan = feature.attributes.LOTPLAN || '';
  const lotArea = feature.attributes.AREA_SIZE_SQ_M || 0;
  const isBUP = lotplan.includes('BUP');  // Building Unit Plan = strata
  const isGTP = lotplan.includes('GTP');  // Group Titles Plan = strata  
  const isSP = lotplan.includes('SP');    // Survey Plan - could be strata or normal
  
  if (!unitNumber && (isBUP || isGTP || (isSP && lotArea < 150))) {
    const lotMatch = lotplan.match(/^(\d+)([A-Z]{2,4}\d+)$/i);
    
    if (lotMatch) {
      const lotNum = parseInt(lotMatch[1]);
      const planPart = lotMatch[2];
      
      // Only look for parent if this lot number > 0
      // Lot 0 is typically the common property/parent in strata schemes
      if (lotNum > 0) {
        console.log(`[API] Detected strata unit lot ${lotplan} (${lotArea}sqm), checking for parent parcel...`);
        
        const parentLotPlan = `0${planPart}`;
        
        const parentParams = new URLSearchParams({
          f: 'json',
          where: `upper(LOTPLAN) = upper('${parentLotPlan}')`,
          outFields: '*',
          outSR: '28356',
          returnGeometry: 'true'
        });
        
        try {
          const parentResp = await fetch(`${url}?${parentParams}`);
          const parentData = await parentResp.json();
          
          if (parentData.features?.[0]) {
            const parentFeature = parentData.features[0];
            const parentArea = parentFeature.attributes.AREA_SIZE_SQ_M || 0;
            
            console.log(`[API] Found parent ${parentLotPlan}: ${parentArea}sqm vs unit ${lotArea}sqm`);
            
            // For BUP/GTP: ALWAYS use parent lot 0 as it represents the whole site
            // This is important because lot 0 has the correct overlays/zoning for the entire complex
            if (isBUP || isGTP) {
              console.log(`[API] ✓ Using parent parcel ${parentLotPlan} (strata lot 0 = whole site)`);
              feature = parentFeature;
            }
            // For small SP lots: only use parent if significantly larger
            else if (parentArea > lotArea * 3) {
              console.log(`[API] ✓ Using parent parcel (${parentArea}sqm) instead of unit (${lotArea}sqm)`);
              feature = parentFeature;
            } else {
              console.log(`[API] Parent not significantly larger, keeping original lot`);
            }
          } else {
            console.log(`[API] No parent parcel found at ${parentLotPlan}`);
          }
        } catch (e) {
          console.log(`[API] Parent parcel lookup failed: ${e.message}`);
        }
      }
    }
  }
  
  // *** CRITICAL VALIDATION ***
  // Check if the cadastre result matches the original search
  const cadastreAddress = feature.attributes.LONG_ADDRESS || feature.attributes.HOUSE_ADDRESS || '';
  
  if (originalAddress && cadastreAddress) {
    const comparison = compareAddresses(originalAddress, cadastreAddress);
    console.log(`[API] Address validation: ${comparison}`);
    
    if (comparison === 'different') {
      console.log(`[API] ⚠️ MISMATCH: Searched "${originalAddress}" but found "${cadastreAddress}"`);
      
      // Throw ADDRESS_NOT_FOUND with the wrong result as a "suggestion"
      const error = new Error('ADDRESS_NOT_FOUND');
      error.searchedAddress = originalAddress;
      error.suggestions = [{
        address: cadastreAddress,
        lotplan: feature.attributes.LOTPLAN,
        note: 'Nearby property found'
      }];
      throw error;
    }
  }
  
  // Handle EXPLICIT unit lookup (when user asks for "Unit 5" or "5/21 North St")
  if (unitNumber) {
    const currentLotplan = feature.attributes.LOTPLAN || '';
    const planMatch = currentLotplan.match(/^\d+([A-Z]{2,4}\d+)$/i);
    
    if (planMatch) {
      const specificLotPlan = `${unitNumber}${planMatch[1]}`;
      console.log(`[API] User requested unit ${unitNumber}, querying: ${specificLotPlan}...`);
      
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
        console.log(`[API] Unit ${unitNumber} not found, using current lot`);
      }
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
    tolerance: '0',
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
 * Get overlays using ACTUAL LOT GEOMETRY
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
    tolerance: '0',
    layers: `visible:${layers}`,
    returnGeometry: 'false'
  });
  
  const resp = await fetch(`${url}?${params}`);
  const data = await resp.json();
  
  if (data.results?.length > 0) {
    console.log(`[API] ✓ Found ${data.results.length} overlays`);
    return data.results;
  }
  
  console.log(`[API] ⚠️ No overlays found`);
  return [];
}

/**
 * Main scraper function - uses actual lot geometry for accurate overlay detection
 */
export async function scrapeProperty(query, sendProgress = null) {
  const startTime = Date.now();
  console.log(`[API] Starting property lookup: ${query}`);

  try {
    const { type, value } = detectQueryType(query);
    console.log(`[API] Detected query type: ${type}`);

    let feature;
    let matchedAddress = null;
    let multipleMatches = null;

    if (type === 'lotplan') {
      if (sendProgress) sendProgress(`📋 Accessing planning data for ${value}...`);
      feature = await getCadastreByLotPlan(value);

    } else {
      const unitMatch = value.match(/^(\d+)[\/\-]|^Unit\s+(\d+)/i);
      const unitNumber = unitMatch ? (unitMatch[1] || unitMatch[2]) : null;
      const cleanAddress = unitNumber ? value.replace(/^\d+[\/\-]\s*|^Unit\s+\d+,?\s*/i, '').trim() : value;

      if (unitNumber) {
        console.log(`[API] Detected unit ${unitNumber}, base address: ${cleanAddress}`);
        if (sendProgress) sendProgress(`🏢 Searching for Unit ${unitNumber}...`);
      }

      // PHASE 1: Try searching cadastre by address directly (more accurate)
      if (sendProgress) sendProgress(`🔍 Accessing planning data for ${cleanAddress}...`);
      const addressMatches = await searchCadastreByAddress(cleanAddress);

      if (addressMatches && addressMatches.length > 0) {
        console.log(`[API] Found ${addressMatches.length} properties at this address`);

        // If multiple distinct properties found (different lot/plans), return for disambiguation
        // Filter to unique lot/plan combinations (exclude duplicates)
        const uniqueLotPlans = new Map();
        for (const match of addressMatches) {
          const lotplan = match.attributes.LOTPLAN;
          if (!uniqueLotPlans.has(lotplan)) {
            uniqueLotPlans.set(lotplan, match);
          }
        }

        // Separate parent lots (lot 0) from individual strata units (lot 1+)
        const parentLots = [];
        const individualUnits = [];

        for (const [lotplan, feature] of uniqueLotPlans.entries()) {
          const lotMatch = lotplan.match(/^(\d+)/);
          const lotNum = lotMatch ? parseInt(lotMatch[1]) : null;

          if (lotNum === 0) {
            parentLots.push(feature);
          } else {
            individualUnits.push(feature);
          }
        }

        // Prioritize parent lots - only show individual units if no parent exists
        const lotsToShow = parentLots.length > 0 ? parentLots : individualUnits;

        if (lotsToShow.length > 1) {
          console.log(`[API] Multiple distinct properties found, need disambiguation (${parentLots.length} parent lots, ${individualUnits.length} units)`);

          // Build disambiguation data
          const properties = lotsToShow.map(f => {
            const attrs = f.attributes;
            const area = attrs.AREA_SIZE_SQ_M ? Math.round(attrs.AREA_SIZE_SQ_M) : 0;
            const units = attrs.NUMBEROFUNITS || null;

            return {
              lotplan: attrs.LOTPLAN,
              address: attrs.LONG_ADDRESS || attrs.HOUSE_ADDRESS || cleanAddress,
              area: area,
              areaDisplay: `${area} sqm`,
              units: units,
              description: units > 1 ? `${units}-unit complex` : 'Single property'
            };
          });

          // Return disambiguation response
          return {
            needsDisambiguation: true,
            disambiguationType: 'multiple_properties',
            properties: properties,
            originalQuery: query,
            message: `Found ${properties.length} properties at ${cleanAddress}. Which one are you interested in?`
          };
        }

        // Single match - use it (either single parent lot or single unit)
        if (lotsToShow.length === 1) {
          feature = lotsToShow[0];
        } else {
          // Fallback to first match if no filtering worked
          feature = addressMatches[0];
        }

        matchedAddress = cleanAddress;
        console.log(`[API] Using property: ${feature.attributes.LOTPLAN} (${Math.round(feature.attributes.AREA_SIZE_SQ_M)}sqm)`);

      } else {
        // PHASE 2: Fall back to geocoding if address search didn't work
        console.log(`[API] Address search failed, falling back to geocoding...`);
        if (sendProgress) sendProgress(`🌍 Locating ${cleanAddress}...`);
        const geocodeResult = await geocodeAddress(cleanAddress);
        matchedAddress = geocodeResult.matchedAddress;

        if (sendProgress) sendProgress('📋 Retrieving zoning controls...');
        // Pass the original search address for validation
        feature = await getCadastreWithGeometry(geocodeResult.lat, geocodeResult.lon, unitNumber, cleanAddress);
      }
    }
    
    if (!feature.geometry || !feature.geometry.rings) {
      throw new Error('No geometry returned for property');
    }
    
    const cadastre = feature.attributes;
    const lotGeometry = {
      rings: feature.geometry.rings,
      spatialReference: { wkid: 28356 }
    };
    
    console.log(`[API] Using lot geometry with ${lotGeometry.rings[0].length} vertices`);

    if (sendProgress) sendProgress('🏗️ Retrieving zoning controls and overlays...');
    const [zone, height, overlays] = await Promise.all([
      getZone(lotGeometry),
      getHeight(lotGeometry),
      getOverlays(lotGeometry)
    ]);
    
    const densityOverlay = overlays.find(o => o.layerId === 117);
    const density = densityOverlay?.attributes?.Residential_Density || null;
    
    const overlayNames = [...new Set(overlays.map(o => o.layerName))];
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[API] ✓ Complete in ${elapsed}s`);
    
    if (sendProgress) sendProgress(`✅ Property data retrieved in ${elapsed}s`);
    
    const returnedAddress = cadastre.LONG_ADDRESS || cadastre.HOUSE_ADDRESS || query;
    
    // Check if this is a strata title with units
    const numberOfUnits = cadastre.NUMBEROFUNITS || null;
    const returnedLotplan = cadastre.LOTPLAN || '';
    const isStrata = returnedLotplan.includes('BUP') || returnedLotplan.includes('GTP');
    
    // Determine if this is the parent/common property or an individual unit
    const lotNumMatch = returnedLotplan.match(/^(\d+)/);
    const lotNumber = lotNumMatch ? parseInt(lotNumMatch[1]) : null;
    const isParentLot = isStrata && lotNumber === 0;  // Lot 0 = parent/common property
    const isUnitLot = isStrata && lotNumber > 0;      // Lot 1+ = individual units
    
    if (isStrata) {
      if (isParentLot && numberOfUnits > 1) {
        console.log(`[API] This is the PARENT SITE (lot 0) of a ${numberOfUnits}-unit strata scheme`);
      } else if (isUnitLot) {
        console.log(`[API] This is UNIT ${lotNumber} within a strata scheme`);
      }
    }
    
    if (numberOfUnits > 1) {
      console.log(`[API] Strata title with ${numberOfUnits} units registered`);
    }
    
    return {
      success: true,
      property: {
        lotplan: cadastre.LOTPLAN,
        address: returnedAddress,
        searchedAddress: query,
        matchedAddress: matchedAddress,
        zone: zone?.Zone || null,
        zoneCode: density,
        density: density,
        height: height?.['Height (m)'] || null,
        area: cadastre.AREA_SIZE_SQ_M ? `${Math.round(cadastre.AREA_SIZE_SQ_M)}sqm` : null,
        overlays: overlayNames,
        // Strata information
        isStrata: isStrata,                    // Is this a strata scheme (BUP/GTP)?
        isParentLot: isParentLot,              // Is this the parent site (lot 0)?
        isUnitLot: isUnitLot,                  // Is this an individual unit?
        numberOfUnits: numberOfUnits,          // How many units in this scheme
        unitNumber: isUnitLot ? lotNumber : null,  // Which unit number (if unit lot)
        strataNote: isParentLot && numberOfUnits > 1 
          ? `This is the parent site containing ${numberOfUnits} strata units`
          : isUnitLot 
          ? `This is unit ${lotNumber} within a strata complex`
          : null
      },
      planningContext: {
        zoneDescription: null,
        lapRequirements: null,
        overlayRestrictions: null
      },
      scrapedAt: new Date().toISOString(),
      apiVersion: '2.5-strata-clarity',
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
    
    // Handle address not found
    if (error.message === 'ADDRESS_NOT_FOUND') {
      console.log(`[API] Address not found: ${error.searchedAddress}`);
      return {
        success: false,
        addressNotFound: true,
        searchedAddress: error.searchedAddress,
        suggestions: error.suggestions || [],
        message: error.suggestions?.length > 0 
          ? `Could not find "${error.searchedAddress}". Did you mean one of these?`
          : `Could not find "${error.searchedAddress}". Please check the address and try again.`
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
    if (sendProgress) sendProgress(`🌍 Locating ${address}...`);
    const geocodeResult = await geocodeAddress(address);

    if (sendProgress) sendProgress('📋 Accessing property data...');
    const feature = await getCadastreWithGeometry(geocodeResult.lat, geocodeResult.lon, null, address);

    if (!feature.geometry || !feature.geometry.rings) {
      throw new Error('No geometry returned for property');
    }

    const lotGeometry = {
      rings: feature.geometry.rings,
      spatialReference: { wkid: 28356 }
    };

    if (sendProgress) sendProgress('🗺️ Checking overlays...');
    const overlays = await getOverlays(lotGeometry);
    
    const overlayNames = [...new Set(overlays.map(o => o.layerName))];
    
    return {
      success: true,
      property: {
        overlays: overlayNames
      }
    };
    
  } catch (error) {
    if (error.message === 'ADDRESS_NOT_FOUND') {
      return {
        success: false,
        addressNotFound: true,
        searchedAddress: error.searchedAddress,
        suggestions: error.suggestions || [],
        message: `Could not find "${error.searchedAddress}".`
      };
    }
    
    console.error('[API ERROR]', error.message);
    throw new Error(`Overlay lookup failed: ${error.message}`);
  }
}

export default { scrapeProperty, scrapePropertyOverlaysOnly, geocodeAddress };
