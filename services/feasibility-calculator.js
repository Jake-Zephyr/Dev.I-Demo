// services/feasibility-calculator.js
// Feasibility calculation engine for Dev.i

/**
 * Density code configurations
 */
const DENSITY_CODES = {
  'RD1': { type: 'dwelling', per: 400, label: '1 dwelling per 400m²' },
  'RD2': { type: 'dwelling', per: 300, label: '1 dwelling per 300m²' },
  'RD3': { type: 'dwelling', per: 250, label: '1 dwelling per 250m²' },
  'RD4': { type: 'dwelling', per: 200, label: '1 dwelling per 200m²' },
  'RD5': { type: 'bedroom', per: 50, label: '1 bedroom per 50m²' },
  'RD6': { type: 'bedroom', per: 33, label: '1 bedroom per 33m²' },
  'RD7': { type: 'bedroom', per: 25, label: '1 bedroom per 25m²' },
  'RD8': { type: 'bedroom', per: 13, label: '1 bedroom per 13m²' },
};

/**
 * Default values for quick feaso
 */
const QUICK_DEFAULTS = {
  contingencyPercent: 5,
  professionalFeesPercent: 8,
  statutoryFeesPercent: 2,
  projectManagementPercent: 3,
  agentFeesPercent: 1.5,
  marketingPercent: 1.2,
  legalSellingPercent: 0.3,
  interestRate: 6.75,
  loanLVR: 65,
  leadInMonths: 6,
  constructionMonthsPerStorey: 4,
  sellingMonthsPerUnit: 1.5,
  stampDutyRate: 0.055, // Approximate QLD rate for investment
  councilRatesAnnual: 5000,
  waterRatesAnnual: 1400,
};

/**
 * Calculate stamp duty for QLD
 */
function calculateStampDutyQLD(price) {
  if (price <= 5000) return 0;
  if (price <= 75000) return price * 0.015;
  if (price <= 540000) return 1125 + (price - 75000) * 0.035;
  if (price <= 1000000) return 17400 + (price - 540000) * 0.045;
  return 38100 + (price - 1000000) * 0.0575;
}

/**
 * Calculate land tax for QLD (Companies/Trusts)
 * Based on QLD land tax rates:
 * - Under $350k: $0
 * - $350k - $2.1M: $1,450 + 1.7% of amount over $350k
 * - $2.1M - $5M: $31,200 + 1.5% of amount over $2.1M
 * - Over $5M: $74,700 + 2.0% of amount over $5M
 */
export function calculateLandTaxQLD(landValue) {
  if (landValue < 350000) return 0;
  if (landValue <= 2100000) return 1450 + (landValue - 350000) * 0.017;
  if (landValue <= 5000000) return 31200 + (landValue - 2100000) * 0.015;
  return 74700 + (landValue - 5000000) * 0.02;
}

/**
 * Calculate target margin based on GRV
 * - GRV under $15M → assume 15%
 * - GRV $15M or above → assume 20%
 */
export function calculateTargetMargin(grvExclGST) {
  return grvExclGST < 15000000 ? 15 : 20;
}

/**
 * Split total timeline into phases
 * - Lead-in: ~17% of total
 * - Construction: ~67% of total
 * - Selling: ~16% of total
 */
export function splitTimeline(totalMonths) {
  const leadInMonths = Math.round(totalMonths * 0.17);
  const constructionMonths = Math.round(totalMonths * 0.67);
  const sellingMonths = totalMonths - leadInMonths - constructionMonths;

  return {
    leadInMonths,
    constructionMonths,
    sellingMonths,
    totalMonths
  };
}

/**
 * Get default selling costs breakdown (total 3%)
 */
export function getDefaultSellingCosts() {
  return {
    agentFeesPercent: 1.5,
    marketingPercent: 1.2,
    legalSellingPercent: 0.3,
    totalPercent: 3.0
  };
}

/**
 * Extract density code from zone/density string
 */
function extractDensityCode(zoneInfo) {
  if (!zoneInfo) return 'RD3'; // Default
  
  const match = zoneInfo.match(/RD[1-8]/i);
  if (match) return match[0].toUpperCase();
  
  // Try to infer from zone name
  const zoneLower = zoneInfo.toLowerCase();
  if (zoneLower.includes('high density')) return 'RD5';
  if (zoneLower.includes('medium density')) return 'RD3';
  if (zoneLower.includes('low density')) return 'RD2';
  
  return 'RD3'; // Default to medium
}

/**
 * Parse height limit from string
 */
function parseHeightLimit(heightStr) {
  if (!heightStr) return { metres: 9, storeys: 2 };
  
  const metresMatch = heightStr.match(/(\d+)\s*m/i);
  if (metresMatch) {
    const metres = parseInt(metresMatch[1]);
    return { metres, storeys: Math.floor(metres / 3.5) };
  }
  
  const storeysMatch = heightStr.match(/(\d+)\s*stor/i);
  if (storeysMatch) {
    const storeys = parseInt(storeysMatch[1]);
    return { metres: storeys * 3.5, storeys };
  }
  
  if (heightStr.toLowerCase().includes('unlim') || heightStr.toLowerCase().includes('no limit')) {
    return { metres: 100, storeys: 25, unlimited: true };
  }
  
  return { metres: 9, storeys: 2 };
}

/**
 * Parse site area from string or number
 */
function parseSiteArea(area) {
  if (typeof area === 'number') return area;
  if (!area) return 0;
  
  const match = area.toString().match(/(\d+(?:,\d+)?(?:\.\d+)?)/);
  if (match) {
    return parseFloat(match[1].replace(',', ''));
  }
  return 0;
}

/**
 * Calculate maximum development capacity
 */
function calculateMaxCapacity(siteArea, densityCode) {
  const density = DENSITY_CODES[densityCode] || DENSITY_CODES['RD3'];
  const maxCapacity = Math.floor(siteArea / density.per);
  return {
    max: maxCapacity,
    type: density.type,
    label: density.label
  };
}

/**
 * Quick feasibility calculation
 * Uses sensible defaults for most values, only requires key inputs
 */
export function calculateQuickFeasibility(inputs) {
  const {
    // From property data (pre-filled)
    siteArea,
    densityCode,
    heightLimit,
    address,
    
    // From user (required)
    purchasePrice,
    numUnits,
    targetSalePricePerUnit,
    
    // From user (optional with defaults)
    developmentType = 'apartments',
    constructionCostPerSqm = 4000,
    avgUnitSize = 85,
    targetMarginPercent = 20,
  } = inputs;
  
  // Parse inputs
  const site = parseSiteArea(siteArea);
  const density = extractDensityCode(densityCode);
  const height = parseHeightLimit(heightLimit);
  const purchase = parseFloat(purchasePrice) || 0;
  const units = parseInt(numUnits) || 1;
  const salePrice = parseFloat(targetSalePricePerUnit) || 0;
  const buildCostSqm = parseFloat(constructionCostPerSqm) || 4000;
  const unitSize = parseFloat(avgUnitSize) || 85;
  const targetMargin = parseFloat(targetMarginPercent) || 20;
  
  // Calculate capacity
  const capacity = calculateMaxCapacity(site, density);
  
  // Estimate storeys based on units and site
  const footprintPerUnit = 80; // Approximate
  const maxFootprint = site * 0.5; // 50% site cover
  const unitsPerFloor = Math.max(1, Math.floor(maxFootprint / footprintPerUnit));
  const estimatedStoreys = Math.min(height.storeys, Math.ceil(units / unitsPerFloor));
  
  // Calculate GFA and construction cost
  const totalGFA = units * unitSize;
  const constructionCost = totalGFA * buildCostSqm;
  
  // Apply default percentages
  const contingency = constructionCost * (QUICK_DEFAULTS.contingencyPercent / 100);
  const professionalFees = constructionCost * (QUICK_DEFAULTS.professionalFeesPercent / 100);
  const statutoryFees = constructionCost * (QUICK_DEFAULTS.statutoryFeesPercent / 100);
  const pmFees = constructionCost * (QUICK_DEFAULTS.projectManagementPercent / 100);
  
  const totalConstructionCosts = constructionCost + contingency + professionalFees + statutoryFees + pmFees;
  
  // Acquisition costs
  const stampDuty = calculateStampDutyQLD(purchase);
  const legalAcquisition = 5000; // Default legal costs
  const totalAcquisition = stampDuty + legalAcquisition;
  
  // Timeline estimates
  const leadInMonths = QUICK_DEFAULTS.leadInMonths;
  const constructionMonths = estimatedStoreys * QUICK_DEFAULTS.constructionMonthsPerStorey;
  const sellingMonths = Math.ceil(units * QUICK_DEFAULTS.sellingMonthsPerUnit);
  const totalMonths = leadInMonths + constructionMonths + sellingMonths;
  
  // Holding costs (estimated)
  const annualHoldingRate = 0.02; // 2% of land value per year
  const holdingCosts = purchase * annualHoldingRate * (totalMonths / 12);
  
  // GRV calculations
  const grvInclGST = units * salePrice;
  const grvExclGST = grvInclGST / 1.1;
  const gstPayable = grvInclGST - grvExclGST;
  
  // Selling costs
  const agentFees = grvExclGST * (QUICK_DEFAULTS.agentFeesPercent / 100);
  const marketing = grvExclGST * (QUICK_DEFAULTS.marketingPercent / 100);
  const legalSelling = grvExclGST * (QUICK_DEFAULTS.legalSellingPercent / 100);
  const totalSellingCosts = agentFees + marketing + legalSelling;
  
  // Finance costs
  const totalDevCosts = totalConstructionCosts + totalAcquisition + holdingCosts + totalSellingCosts;
  const avgDebt = (purchase + totalDevCosts) * (QUICK_DEFAULTS.loanLVR / 100);
  const interestCost = avgDebt * (QUICK_DEFAULTS.interestRate / 100) * (totalMonths / 12);
  const loanFees = avgDebt * 0.01; // 1% establishment
  const totalFinanceCosts = interestCost + loanFees;
  
  // Total project cost
  const totalProjectCost = purchase + totalDevCosts + totalFinanceCosts;
  
  // Profit calculations
  const grossProfit = grvExclGST - totalProjectCost;
  const profitMargin = (grossProfit / grvExclGST) * 100;
  const returnOnCost = (grossProfit / totalProjectCost) * 100;
  
  // Residual land value calculation
  const targetProfitAmount = grvExclGST * (targetMargin / 100);
  const residualLandValue = grvExclGST - totalDevCosts - totalFinanceCosts - targetProfitAmount;
  const residualPerSqm = residualLandValue / site;
  
  // Viability assessment
  let viability = 'marginal';
  if (profitMargin >= targetMargin) viability = 'viable';
  else if (profitMargin >= targetMargin * 0.75) viability = 'marginal';
  else if (profitMargin > 0) viability = 'challenging';
  else viability = 'not_viable';
  
  return {
    success: true,
    type: 'quick',
    
    // Input summary
    inputs: {
      address,
      siteArea: site,
      densityCode: density,
      heightLimit: height,
      developmentType,
      numUnits: units,
      purchasePrice: purchase,
      targetSalePricePerUnit: salePrice,
      constructionCostPerSqm: buildCostSqm,
      avgUnitSize: unitSize,
      targetMarginPercent: targetMargin,
    },
    
    // Capacity analysis
    capacity: {
      maxUnits: capacity.max,
      maxType: capacity.type,
      proposedUnits: units,
      utilizationPercent: Math.round((units / capacity.max) * 100),
      estimatedStoreys,
      totalGFA,
    },
    
    // Revenue
    revenue: {
      grvInclGST,
      grvExclGST,
      gstPayable,
      avgPricePerUnit: salePrice,
      pricePerSqm: Math.round(salePrice / unitSize),
    },
    
    // Costs breakdown
    costs: {
      landValue: purchase,
      stampDuty,
      acquisitionTotal: totalAcquisition,
      constructionCost,
      contingency,
      professionalFees,
      statutoryFees,
      pmFees,
      constructionTotal: totalConstructionCosts,
      holdingCosts,
      sellingCosts: totalSellingCosts,
      financeCosts: totalFinanceCosts,
      totalProjectCost,
    },
    
    // Timeline
    timeline: {
      leadInMonths,
      constructionMonths,
      sellingMonths,
      totalMonths,
    },
    
    // Profitability
    profitability: {
      grossProfit,
      profitMargin: Math.round(profitMargin * 100) / 100,
      returnOnCost: Math.round(returnOnCost * 100) / 100,
      targetMargin,
      meetsTarget: profitMargin >= targetMargin,
      viability,
    },
    
    // Residual analysis
    residual: {
      residualLandValue: Math.round(residualLandValue),
      residualPerSqm: Math.round(residualPerSqm),
      residualPerUnit: Math.round(residualLandValue / units),
      vsActualLand: Math.round(residualLandValue - purchase),
      landIsFairValue: residualLandValue >= purchase,
    },
    
    // Assumptions used
    assumptions: {
      ...QUICK_DEFAULTS,
      note: 'Quick feasibility uses industry-standard assumptions. Use detailed analysis for accurate project-specific calculations.',
    },
  };
}

/**
 * Get pre-filled data for detailed feasibility form
 */
export function getDetailedFeasibilityPreFill(propertyData) {
  if (!propertyData || !propertyData.property) {
    return { success: false, error: 'No property data available' };
  }
  
  const prop = propertyData.property;
  
  const siteArea = parseSiteArea(prop.area);
  const densityCode = extractDensityCode(prop.density || prop.zoneCode);
  const heightLimit = parseHeightLimit(prop.height);
  const capacity = calculateMaxCapacity(siteArea, densityCode);
  
  return {
    success: true,
    type: 'detailed',
    
    preFill: {
      property: prop.address || '',
      siteArea: siteArea.toString(),
      densityCode: densityCode,
      heightLimit: prop.height || '',
      
      // Suggested values based on capacity
      suggestedUnits: Math.min(capacity.max, 10),
      maxCapacity: capacity.max,
      capacityType: capacity.type,
    },
    
    // Pass through full property data for reference
    propertyData: prop,
    
    // Planning constraints to display
    constraints: {
      zone: prop.zone,
      density: densityCode,
      height: heightLimit,
      overlays: prop.overlays || [],
    },
  };
}

export default {
  calculateQuickFeasibility,
  getDetailedFeasibilityPreFill,
  DENSITY_CODES,
  QUICK_DEFAULTS,
};
