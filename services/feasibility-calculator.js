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
  agentFeesPercent: 2.5,
  marketingPercent: 1.5,
  legalSellingPercent: 0.5,
  interestRate: 7.0,
  loanLVR: 65,
  leadInMonths: 6,
  constructionMonthsPerStorey: 4,
  sellingMonthsPerUnit: 1.5,
  councilRatesYearly: 5000,
  waterRatesYearly: 1400,
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
 * Calculate QLD land tax (Companies/Trusts)
 */
function calculateLandTaxQLD(landValue) {
  if (landValue < 350000) return 0;
  if (landValue < 2100000) return 1450 + (landValue - 350000) * 0.017;
  if (landValue < 5000000) return 31200 + (landValue - 2100000) * 0.015;
  return 74700 + (landValue - 5000000) * 0.020;
}

/**
 * Determine target margin based on GRV
 */
function getTargetMargin(grvTotal) {
  return grvTotal >= 15000000 ? 20 : 15;
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
    saleableArea, // Total unit floor area (NSA)

    // From user (optional with defaults)
    developmentType = 'apartments',
    constructionCost, // Total construction cost
    contingencyPercent,
    professionalFeesPercent,
    statutoryFeesPercent,
    gstScheme = 'margin',
    costBase, // For margin scheme
    interestRate,
    loanLVR,
    leadInMonths,
    constructionMonths,
    sellingMonths,
  } = inputs;

  // Parse inputs
  const site = parseSiteArea(siteArea);
  const density = extractDensityCode(densityCode);
  const height = parseHeightLimit(heightLimit);
  const purchase = parseFloat(purchasePrice) || 0;
  const units = parseInt(numUnits) || 1;
  const salePrice = parseFloat(targetSalePricePerUnit) || 0;
  const totalSaleableArea = parseFloat(saleableArea) || 0;

  // Calculate GRV and determine target margin automatically
  const grvInclGST = units * salePrice;
  const targetMargin = getTargetMargin(grvInclGST);
  
  // Calculate capacity
  const capacity = calculateMaxCapacity(site, density);

  // Estimate storeys based on units and site
  const footprintPerUnit = 80; // Approximate
  const maxFootprint = site * 0.5; // 50% site cover
  const unitsPerFloor = Math.max(1, Math.floor(maxFootprint / footprintPerUnit));
  const estimatedStoreys = Math.min(height.storeys, Math.ceil(units / unitsPerFloor));

  // Construction costs with percentages
  const baseConstructionCost = parseFloat(constructionCost) || 0;
  const contingencyPct = parseFloat(contingencyPercent) || QUICK_DEFAULTS.contingencyPercent;
  const professionalFeesPct = parseFloat(professionalFeesPercent) || QUICK_DEFAULTS.professionalFeesPercent;
  const statutoryFeesPct = parseFloat(statutoryFeesPercent) || QUICK_DEFAULTS.statutoryFeesPercent;

  const contingency = baseConstructionCost * (contingencyPct / 100);
  const professionalFees = baseConstructionCost * (professionalFeesPct / 100);
  const statutoryFees = baseConstructionCost * (statutoryFeesPct / 100);

  const totalConstructionCosts = baseConstructionCost + contingency + professionalFees + statutoryFees;

  // Acquisition costs
  const stampDuty = calculateStampDutyQLD(purchase);
  const legalAcquisition = 5000; // Default legal costs
  const totalAcquisition = purchase + stampDuty + legalAcquisition;

  // Timeline
  const leadIn = parseFloat(leadInMonths) || QUICK_DEFAULTS.leadInMonths;
  const construction = parseFloat(constructionMonths) || (estimatedStoreys * QUICK_DEFAULTS.constructionMonthsPerStorey);
  const selling = parseFloat(sellingMonths) || Math.ceil(units * QUICK_DEFAULTS.sellingMonthsPerUnit);
  const totalMonths = leadIn + construction + selling;

  // Holding costs - QLD land tax + council rates + water rates
  const landTaxYearly = calculateLandTaxQLD(purchase);
  const councilRatesYearly = QUICK_DEFAULTS.councilRatesYearly;
  const waterRatesYearly = QUICK_DEFAULTS.waterRatesYearly;
  const totalHoldingYearly = landTaxYearly + councilRatesYearly + waterRatesYearly;
  const holdingCosts = totalHoldingYearly * (totalMonths / 12);

  // GRV calculations with GST
  let grvExclGST;
  let gstPayable;

  if (gstScheme === 'margin') {
    const base = parseFloat(costBase) || purchase;
    const margin = grvInclGST - base;
    gstPayable = margin / 11;
    grvExclGST = grvInclGST - gstPayable;
  } else {
    grvExclGST = grvInclGST / 1.1;
    gstPayable = grvInclGST - grvExclGST;
  }

  // Selling costs
  const agentFees = grvExclGST * (QUICK_DEFAULTS.agentFeesPercent / 100);
  const marketing = grvExclGST * (QUICK_DEFAULTS.marketingPercent / 100);
  const legalSelling = grvExclGST * (QUICK_DEFAULTS.legalSellingPercent / 100);
  const totalSellingCosts = agentFees + marketing + legalSelling;

  // Finance costs
  const rate = parseFloat(interestRate) || QUICK_DEFAULTS.interestRate;
  const lvr = parseFloat(loanLVR) || QUICK_DEFAULTS.loanLVR;
  const totalDevCosts = totalConstructionCosts + holdingCosts + totalSellingCosts;
  const avgDebt = (totalAcquisition + totalDevCosts) * (lvr / 100) * 0.5; // 50% average draw
  const interestCost = avgDebt * (rate / 100) * (totalMonths / 12);
  const loanFees = avgDebt * 2 * 0.01; // 1% establishment on total debt
  const totalFinanceCosts = interestCost + loanFees;

  // Total project cost
  const totalProjectCost = totalAcquisition + totalDevCosts + totalFinanceCosts;

  // Profit calculations
  const grossProfit = grvExclGST - totalProjectCost;
  const profitMargin = (grossProfit / grvExclGST) * 100;
  const returnOnCost = (grossProfit / totalProjectCost) * 100;

  // Residual land value calculation
  const targetProfitAmount = grvExclGST * (targetMargin / 100);
  const residualLandValue = grvExclGST - totalConstructionCosts - holdingCosts - totalSellingCosts - totalFinanceCosts - targetProfitAmount;
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
      saleableArea: totalSaleableArea,
      targetMarginPercent: targetMargin,
    },

    // Capacity analysis
    capacity: {
      maxUnits: capacity.max,
      maxType: capacity.type,
      proposedUnits: units,
      utilizationPercent: Math.round((units / capacity.max) * 100),
      estimatedStoreys,
      totalSaleableArea,
    },

    // Revenue
    revenue: {
      grvInclGST,
      grvExclGST,
      gstPayable,
      avgPricePerUnit: salePrice,
      pricePerSqm: totalSaleableArea > 0 ? Math.round(grvInclGST / totalSaleableArea) : 0,
    },

    // Costs breakdown
    costs: {
      landValue: purchase,
      stampDuty,
      acquisitionTotal: totalAcquisition,
      constructionCost: baseConstructionCost,
      contingency,
      professionalFees,
      statutoryFees,
      constructionTotal: totalConstructionCosts,
      holdingCosts,
      landTaxYearly,
      councilRatesYearly,
      waterRatesYearly,
      sellingCosts: totalSellingCosts,
      financeCosts: totalFinanceCosts,
      totalProjectCost,
    },

    // Timeline
    timeline: {
      leadInMonths: leadIn,
      constructionMonths: construction,
      sellingMonths: selling,
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
      targetMargin: `${targetMargin}% (auto: ${grvInclGST >= 15000000 ? '≥$15M GRV' : '<$15M GRV'})`,
      contingencyPercent: contingencyPct,
      professionalFeesPercent: professionalFeesPct,
      statutoryFeesPercent: statutoryFeesPct,
      agentFeesPercent: QUICK_DEFAULTS.agentFeesPercent,
      marketingPercent: QUICK_DEFAULTS.marketingPercent,
      legalSellingPercent: QUICK_DEFAULTS.legalSellingPercent,
      interestRate: rate,
      loanLVR: lvr,
      councilRatesYearly,
      waterRatesYearly,
      landTaxYearly,
      note: 'Assumptions based on similar projects - edit if needed.',
    },

    // Complete data for calculator pre-fill
    calculatorPreFill: {
      property: {
        address: address || '',
        siteArea: site,
        densityCode: density,
        heightLimit: height.metres,
      },
      project: {
        numUnits: units,
        saleableArea: totalSaleableArea,
        grvInclGST,
      },
      acquisition: {
        landValue: purchase,
        stampDuty,
        legalFees: legalAcquisition,
        gstScheme,
        costBase: gstScheme === 'margin' ? (parseFloat(costBase) || purchase) : purchase,
      },
      construction: {
        buildCost: baseConstructionCost,
        contingencyPercent: contingencyPct,
        professionalFeesPercent: professionalFeesPct,
        statutoryFeesPercent: statutoryFeesPct,
      },
      holding: {
        landTaxYearly,
        councilRates: councilRatesYearly,
        waterRates: waterRatesYearly,
      },
      selling: {
        agentPercent: QUICK_DEFAULTS.agentFeesPercent,
        marketingPercent: QUICK_DEFAULTS.marketingPercent,
        legalPercent: QUICK_DEFAULTS.legalSellingPercent,
      },
      finance: {
        interestRate: rate,
        lvr: lvr,
      },
      timeline: {
        leadInMonths: leadIn,
        constructionMonths: construction,
        sellingMonths: selling,
      },
      target: {
        marginPercent: targetMargin,
      },
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
