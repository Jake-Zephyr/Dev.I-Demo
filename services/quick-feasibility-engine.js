/**
 * Quick Feasibility Engine - Complete Rebuild
 *
 * ARCHITECTURE: This module does THREE things:
 * 1. PARSE - Convert raw user strings ("$10M", "45m", "80%") to numbers
 * 2. CALCULATE - All financial calculations (GST, interest, costs, profit, residual)
 * 3. FORMAT - Build the entire response string so Claude just displays it verbatim
 *
 * Claude's ONLY job: collect inputs as strings, pass them here, display the result.
 * Claude NEVER sees raw numbers, NEVER does math, NEVER formats output.
 */

// ============================================================
// SECTION 1: INPUT PARSING
// ============================================================

/**
 * Parse a monetary value from any user format
 * Handles: $10M, $10m, 10m, 10 million, $10,000,000, 10000000, $2.5b, $500k
 */
function parseMoneyValue(input) {
  if (!input) return 0;
  if (typeof input === 'number') return input;

  let str = String(input).toLowerCase().trim();

  // Remove currency symbols, commas, spaces
  str = str.replace(/[$,\s]/g, '');

  // Handle "billion" / "b"
  const billionMatch = str.match(/([\d.]+)\s*(?:b(?:illion)?)/);
  if (billionMatch) return parseFloat(billionMatch[1]) * 1_000_000_000;

  // Handle "million" / "m" / "mil"
  const millionMatch = str.match(/([\d.]+)\s*(?:m(?:illion|il)?)/);
  if (millionMatch) return parseFloat(millionMatch[1]) * 1_000_000;

  // Handle "thousand" / "k"
  const thousandMatch = str.match(/([\d.]+)\s*(?:k|thousand)/);
  if (thousandMatch) return parseFloat(thousandMatch[1]) * 1_000;

  // Plain number (possibly with remaining non-numeric chars)
  const num = parseFloat(str.replace(/[^0-9.]/g, ''));
  return isNaN(num) ? 0 : num;
}

/**
 * Parse percentage from user input
 * Handles: 80%, 80, 6.5%, "six and a half percent"
 */
function parsePercentage(input) {
  if (!input) return 0;
  if (typeof input === 'number') return input;

  let str = String(input).toLowerCase().trim();

  // Handle "fully funded" / "full fund" / "100%" / "no debt"
  if (str.includes('fully funded') || str.includes('full fund') || str.includes('no debt') || str.includes('cash')) {
    return 0; // 0% LVR means fully funded
  }

  str = str.replace(/%|percent/g, '').trim();
  const num = parseFloat(str);
  return isNaN(num) ? 0 : num;
}

/**
 * Parse timeline in months
 * Handles: 18, "18 months", "18mo", "1.5 years", "2 years"
 */
function parseTimeline(input) {
  if (!input) return 0;
  if (typeof input === 'number') return input;

  let str = String(input).toLowerCase().trim();

  // Handle years
  const yearMatch = str.match(/([\d.]+)\s*(?:year|yr)/);
  if (yearMatch) return Math.round(parseFloat(yearMatch[1]) * 12);

  // Remove "months", "mo", "mths" etc
  str = str.replace(/months?|mo|mths?/gi, '').trim();
  const num = parseFloat(str);
  return isNaN(num) ? 0 : Math.round(num);
}

/**
 * Parse construction cost - handles breakdowns
 * "$30m build + $1m professional + $1m council + 5% contingency"
 * or just "$10M" or "$10,000,000"
 */
function parseConstructionCost(input) {
  if (!input) return { total: 0, contingencyPercent: 0 };
  if (typeof input === 'number') return { total: input, contingencyPercent: 0 };

  const str = String(input).toLowerCase();

  // Look for contingency percentage
  const contingencyMatch = str.match(/([\d.]+)\s*%\s*contingenc/);
  const contingencyPercent = contingencyMatch ? parseFloat(contingencyMatch[1]) : 0;

  // Look for component breakdown
  const buildMatch = str.match(/([\d.$]+[kmb]?)\s*(?:build|construction)/i);
  const profMatch = str.match(/([\d.$]+[kmb]?)\s*(?:prof|professional)/i);
  const statMatch = str.match(/([\d.$]+[kmb]?)\s*(?:council|statutory|stat)/i);

  if (buildMatch) {
    // Has breakdown
    const buildCost = parseMoneyValue(buildMatch[1]);
    const profFees = profMatch ? parseMoneyValue(profMatch[1]) : 0;
    const statFees = statMatch ? parseMoneyValue(statMatch[1]) : 0;
    let subtotal = buildCost + profFees + statFees;
    const contingencyAmount = subtotal * (contingencyPercent / 100);
    return {
      total: subtotal + contingencyAmount,
      buildCost,
      profFees,
      statFees,
      contingencyPercent,
      contingencyAmount
    };
  }

  // No breakdown - just a total
  const total = parseMoneyValue(input);
  if (contingencyPercent > 0) {
    // Contingency mentioned but no breakdown - apply to total
    const contingencyAmount = total * (contingencyPercent / 100);
    return { total: total + contingencyAmount, contingencyPercent, contingencyAmount };
  }

  return { total, contingencyPercent: 0 };
}

/**
 * Parse GST scheme from user input
 */
function parseGSTScheme(input) {
  if (!input) return 'margin';
  const str = String(input).toLowerCase();
  if (str.includes('fully') || str.includes('full tax') || str.includes('standard')) {
    return 'fully_taxed';
  }
  return 'margin'; // Default to margin scheme
}

/**
 * Parse GST cost base
 */
function parseGSTCostBase(input, landValue) {
  if (!input) return landValue;
  const str = String(input).toLowerCase();
  if (str.includes('same') || str.includes('acquisition') || str.includes('purchase')) {
    return landValue;
  }
  const parsed = parseMoneyValue(input);
  return parsed > 0 ? parsed : landValue;
}

/**
 * Parse LVR - special handling for "fully funded"
 */
function parseLVR(input) {
  if (!input) return 0;
  const str = String(input).toLowerCase().trim();
  if (str.includes('fully funded') || str.includes('full fund') || str.includes('no debt') || str.includes('cash') || str === '0' || str === '0%') {
    return 0;
  }
  return parsePercentage(input);
}

/**
 * Master parser - takes all raw inputs, returns clean numbers
 */
export function parseAllInputs(rawInputs) {
  const landValue = parseMoneyValue(rawInputs.purchasePriceRaw);
  const grvTotal = parseMoneyValue(rawInputs.grvRaw);
  const construction = parseConstructionCost(rawInputs.constructionCostRaw);
  const lvr = parseLVR(rawInputs.lvrRaw);
  const interestRate = parsePercentage(rawInputs.interestRateRaw);
  const timelineMonths = parseTimeline(rawInputs.timelineRaw);
  const sellingCostsPercent = parsePercentage(rawInputs.sellingCostsRaw);
  const gstScheme = parseGSTScheme(rawInputs.gstSchemeRaw);
  const gstCostBase = parseGSTCostBase(rawInputs.gstCostBaseRaw, landValue);

  return {
    landValue,
    grvTotal,
    constructionCost: construction.total,
    constructionBreakdown: construction,
    lvr,
    interestRate,
    timelineMonths,
    sellingCostsPercent,
    gstScheme,
    gstCostBase
  };
}


// ============================================================
// SECTION 2: CALCULATIONS
// ============================================================

/**
 * QLD Stamp Duty calculation (commercial/investment property)
 * Based on QLD transfer duty rates for property purchases
 */
function calculateStampDutyQLD(value) {
  if (value <= 5000) return 0;
  if (value <= 75000) return value * 0.015;
  if (value <= 540000) return 1050 + (value - 75000) * 0.035;
  if (value <= 1000000) return 17325 + (value - 540000) * 0.045;
  return 38025 + (value - 1000000) * 0.0575;
}

/**
 * QLD Land Tax calculation (company/trust rate)
 */
function calculateLandTaxQLD(landValue) {
  if (landValue <= 350000) return 0;
  if (landValue <= 2100000) return 1450 + (landValue - 350000) * 0.017;
  if (landValue <= 5000000) return 31200 + (landValue - 2100000) * 0.015;
  return 74700 + (landValue - 5000000) * 0.02;
}

/**
 * Target margin based on GRV
 * < $15M GRV = 15% target
 * >= $15M GRV = 20% target
 */
function calculateTargetMargin(grvExclGST) {
  return grvExclGST < 15_000_000 ? 15 : 20;
}

/**
 * Split timeline into phases
 */
function splitTimeline(totalMonths) {
  const leadIn = Math.round(totalMonths * 0.17);
  const construction = Math.round(totalMonths * 0.67);
  const selling = totalMonths - leadIn - construction;
  return { leadIn, construction, selling, total: totalMonths };
}

/**
 * Main calculation engine
 * Takes parsed numeric inputs, returns complete calculation results
 */
export function calculateFeasibility(inputs) {
  const {
    landValue,
    grvTotal,
    constructionCost,
    constructionBreakdown,
    lvr,
    interestRate,
    timelineMonths,
    sellingCostsPercent,
    gstScheme,
    gstCostBase
  } = inputs;

  // --- CONTINGENCY ---
  // If user's construction cost didn't explicitly include contingency, add 5%
  const userContingency = constructionBreakdown?.contingencyPercent || 0;
  const constructionWithContingency = userContingency > 0
    ? constructionCost  // Already includes it
    : Math.round(constructionCost * 1.05); // Add 5%
  const appliedContingency = userContingency > 0 ? userContingency : 5;

  // --- GST ---
  let gstPayable, grvExclGST;
  if (gstScheme === 'margin' && gstCostBase > 0) {
    const margin = grvTotal - gstCostBase;
    gstPayable = Math.max(0, margin / 11);
    grvExclGST = grvTotal - gstPayable;
  } else if (gstScheme === 'fully_taxed') {
    gstPayable = grvTotal / 11;
    grvExclGST = grvTotal - gstPayable;
  } else {
    gstPayable = grvTotal / 11;
    grvExclGST = grvTotal - gstPayable;
  }

  // --- STAMP DUTY ---
  const stampDuty = calculateStampDutyQLD(landValue);

  // --- LEGAL/ACQUISITION ---
  const legalCosts = Math.round(landValue * 0.005); // 0.5% for legal/due diligence

  // --- SELLING COSTS ---
  const sellingDecimal = sellingCostsPercent / 100;
  const sellingCosts = Math.round(grvExclGST * sellingDecimal);

  // --- HOLDING COSTS ---
  const landTaxYearly = calculateLandTaxQLD(landValue);
  const councilRatesAnnual = 5000;
  const waterRatesAnnual = 1400;
  const insuranceAnnual = Math.round(constructionWithContingency * 0.003); // ~0.3% of construction
  const totalHoldingYearly = landTaxYearly + councilRatesAnnual + waterRatesAnnual + insuranceAnnual;
  const holdingCosts = Math.round(totalHoldingYearly * (timelineMonths / 12));

  // --- FINANCE COSTS ---
  const lvrDecimal = lvr / 100;
  const interestDecimal = interestRate / 100;
  // S-curve draw: land drawn at settlement, construction drawn progressively
  const landDebt = landValue * lvrDecimal;
  const constructionDebt = constructionWithContingency * lvrDecimal;
  // Average outstanding = land full period + construction ~50% average
  const avgDebt = landDebt + (constructionDebt * 0.5);
  const financeCosts = Math.round(avgDebt * interestDecimal * (timelineMonths / 12));
  // Loan establishment fee
  const loanFee = Math.round((landDebt + constructionDebt) * 0.005); // 0.5% establishment

  // --- TOTALS ---
  const totalAcquisition = landValue + stampDuty + legalCosts;
  const totalProjectCost = totalAcquisition + constructionWithContingency + sellingCosts + financeCosts + loanFee + holdingCosts;
  const grossProfit = Math.round(grvExclGST - totalProjectCost);
  const profitMargin = grvExclGST > 0 ? (grossProfit / grvExclGST) * 100 : 0;
  const profitOnCost = totalProjectCost > 0 ? (grossProfit / totalProjectCost) * 100 : 0;

  // --- TARGET MARGIN ---
  const targetMarginPercent = calculateTargetMargin(grvExclGST);

  // --- VIABILITY ---
  let viability, viabilityLabel;
  if (profitMargin >= targetMarginPercent + 10) {
    viability = 'highly_viable';
    viabilityLabel = 'HIGHLY VIABLE';
  } else if (profitMargin >= targetMarginPercent) {
    viability = 'viable';
    viabilityLabel = 'VIABLE';
  } else if (profitMargin >= targetMarginPercent - 5) {
    viability = 'marginal';
    viabilityLabel = 'MARGINAL';
  } else if (profitMargin >= 0) {
    viability = 'challenging';
    viabilityLabel = 'CHALLENGING';
  } else {
    viability = 'not_viable';
    viabilityLabel = 'NOT VIABLE';
  }

  // --- RESIDUAL LAND VALUE ---
  // What could you pay for the land and still hit target margin?
  const targetProfit = grvExclGST * (targetMarginPercent / 100);
  let residualLandValue = grvExclGST - constructionWithContingency - sellingCosts - targetProfit;
  // Iterate to converge (finance and holding costs depend on land value)
  for (let i = 0; i < 8; i++) {
    const resStampDuty = calculateStampDutyQLD(residualLandValue);
    const resLegal = Math.round(residualLandValue * 0.005);
    const resLandDebt = residualLandValue * lvrDecimal;
    const resAvgDebt = resLandDebt + (constructionDebt * 0.5);
    const resFinance = Math.round(resAvgDebt * interestDecimal * (timelineMonths / 12));
    const resLoanFee = Math.round((resLandDebt + constructionDebt) * 0.005);
    const resLandTax = calculateLandTaxQLD(residualLandValue);
    const resHolding = Math.round((resLandTax + councilRatesAnnual + waterRatesAnnual + insuranceAnnual) * (timelineMonths / 12));
    residualLandValue = grvExclGST - constructionWithContingency - sellingCosts - resFinance - resLoanFee - resHolding - resStampDuty - resLegal - targetProfit;
  }
  residualLandValue = Math.round(Math.max(0, residualLandValue));

  // --- TIMELINE ---
  const timeline = splitTimeline(timelineMonths);

  return {
    // Inputs echo (for display)
    inputs: {
      landValue,
      grvTotal,
      constructionCost,
      constructionWithContingency,
      appliedContingency,
      lvr,
      interestRate,
      timelineMonths,
      sellingCostsPercent,
      gstScheme,
      gstCostBase
    },

    // Revenue
    revenue: {
      grvInclGST: Math.round(grvTotal),
      grvExclGST: Math.round(grvExclGST),
      gstPayable: Math.round(gstPayable)
    },

    // Costs breakdown
    costs: {
      land: Math.round(landValue),
      stampDuty: Math.round(stampDuty),
      legalCosts: Math.round(legalCosts),
      totalAcquisition: Math.round(totalAcquisition),
      construction: Math.round(constructionWithContingency),
      selling: Math.round(sellingCosts),
      finance: Math.round(financeCosts),
      loanFee: Math.round(loanFee),
      holding: Math.round(holdingCosts),
      totalProjectCost: Math.round(totalProjectCost)
    },

    // Holding breakdown
    holdingBreakdown: {
      landTaxYearly: Math.round(landTaxYearly),
      councilRatesAnnual,
      waterRatesAnnual,
      insuranceAnnual: Math.round(insuranceAnnual),
      totalYearly: Math.round(totalHoldingYearly)
    },

    // Profitability
    profitability: {
      grossProfit: Math.round(grossProfit),
      profitMargin: Math.round(profitMargin * 10) / 10,
      profitOnCost: Math.round(profitOnCost * 10) / 10,
      targetMargin: targetMarginPercent,
      meetsTarget: profitMargin >= targetMarginPercent,
      viability,
      viabilityLabel
    },

    // Residual land value
    residual: {
      residualLandValue,
      vsActualLand: landValue > 0 ? residualLandValue - landValue : null,
      targetMarginUsed: targetMarginPercent
    },

    // Timeline
    timeline
  };
}


// ============================================================
// SECTION 3: RESPONSE FORMATTING
// ============================================================

/**
 * Format a number as currency string
 * 1234567 -> "$1.23M"
 * 123456 -> "$123.5k"
 * 1234 -> "$1,234"
 */
function fmtCurrency(value) {
  if (value === null || value === undefined) return '$0';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';

  if (abs >= 1_000_000) {
    const m = abs / 1_000_000;
    // Show 2 decimal places for values like $1.23M, but drop trailing zeros
    if (m >= 100) return `${sign}$${m.toFixed(1)}M`;
    if (m >= 10) return `${sign}$${m.toFixed(2)}M`;
    return `${sign}$${m.toFixed(2)}M`;
  }
  if (abs >= 1000) {
    return `${sign}$${(abs / 1000).toFixed(1)}k`;
  }
  return `${sign}$${abs.toLocaleString('en-AU', { maximumFractionDigits: 0 })}`;
}

/**
 * Format number with full precision (for exact display)
 * 10000000 -> "$10,000,000"
 */
function fmtFull(value) {
  if (value === null || value === undefined) return '$0';
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(Math.round(value)).toLocaleString('en-AU')}`;
}

/**
 * Build the complete formatted response
 * This is what Claude displays VERBATIM - no thinking, no modification
 */
export function formatFeasibilityResponse(calc, address) {
  const { inputs, revenue, costs, profitability, residual, holdingBreakdown, timeline } = calc;

  const gstLabel = inputs.gstScheme === 'margin'
    ? `Margin Scheme (cost base: ${fmtCurrency(inputs.gstCostBase)})`
    : 'Fully Taxed';

  // Viability emoji
  let viabilityEmoji;
  switch (profitability.viability) {
    case 'highly_viable': viabilityEmoji = '✅'; break;
    case 'viable': viabilityEmoji = '✅'; break;
    case 'marginal': viabilityEmoji = '⚠️'; break;
    case 'challenging': viabilityEmoji = '⚠️'; break;
    case 'not_viable': viabilityEmoji = '❌'; break;
    default: viabilityEmoji = '';
  }

  // Residual analysis
  let residualSection = '';
  if (residual.vsActualLand !== null) {
    const diff = residual.vsActualLand;
    if (diff > 0) {
      residualSection = `Residual Land Value (at ${residual.targetMarginUsed}% target margin):
• Maximum affordable land price: ${fmtFull(residual.residualLandValue)}
• Your acquisition price: ${fmtFull(inputs.landValue)}
• Upside: +${fmtCurrency(diff)} — you're buying below the residual`;
    } else if (diff < 0) {
      residualSection = `Residual Land Value (at ${residual.targetMarginUsed}% target margin):
• Maximum affordable land price: ${fmtFull(residual.residualLandValue)}
• Your acquisition price: ${fmtFull(inputs.landValue)}
• Gap: ${fmtCurrency(diff)} — land cost exceeds residual by ${fmtCurrency(Math.abs(diff))}`;
    } else {
      residualSection = `Residual Land Value (at ${residual.targetMarginUsed}% target margin):
• Maximum affordable land price: ${fmtFull(residual.residualLandValue)}
• Your acquisition price: ${fmtFull(inputs.landValue)}
• Result: Land price equals residual — right on the margin`;
    }
  }

  // Commentary
  let commentary = '';
  if (profitability.viability === 'highly_viable' || profitability.viability === 'viable') {
    commentary = `This project shows a ${profitability.profitMargin.toFixed(1)}% profit margin, ${profitability.meetsTarget ? 'exceeding' : 'meeting'} the ${profitability.targetMargin}% target for projects in this GRV range. The numbers stack up well.`;
  } else if (profitability.viability === 'marginal') {
    commentary = `At ${profitability.profitMargin.toFixed(1)}%, this project is close to the ${profitability.targetMargin}% target margin. It could work but there's limited buffer for cost overruns or market softening. Worth reviewing assumptions and looking for ways to improve the margin.`;
  } else if (profitability.viability === 'challenging') {
    commentary = `At ${profitability.profitMargin.toFixed(1)}%, this project falls short of the ${profitability.targetMargin}% target margin. You'd need to either increase revenue, reduce costs, or negotiate a lower land price to make this viable.`;
  } else {
    commentary = `This project shows a negative return at ${profitability.profitMargin.toFixed(1)}%. The numbers don't work at these inputs. Consider whether the land price, construction costs, or revenue assumptions can be adjusted.`;
  }

  const response = `QUICK FEASIBILITY ANALYSIS${address ? `: ${address}` : ''}

Inputs Received:
• Land Acquisition: ${fmtFull(inputs.landValue)}
• Target GRV (inc GST): ${fmtFull(inputs.grvTotal)}
• Construction Cost: ${fmtFull(inputs.constructionWithContingency)} (inc ${inputs.appliedContingency}% contingency)
• LVR: ${inputs.lvr}% | Interest: ${inputs.interestRate}% p.a. | Timeline: ${inputs.timelineMonths} months
• Selling Costs: ${inputs.sellingCostsPercent}%
• GST: ${gstLabel}

Revenue (Including GST):
• Gross Revenue (inc GST): ${fmtFull(revenue.grvInclGST)}
• GST Payable: ${fmtFull(revenue.gstPayable)}
• Net Revenue (exc GST): ${fmtFull(revenue.grvExclGST)}

Total Project Costs (Excluding GST):
• Land Acquisition: ${fmtFull(costs.land)}
• Stamp Duty (QLD): ${fmtFull(costs.stampDuty)}
• Legal/Due Diligence: ${fmtFull(costs.legalCosts)}
• Construction (inc contingency): ${fmtFull(costs.construction)}
• Selling Costs (${inputs.sellingCostsPercent}%): ${fmtFull(costs.selling)}
• Finance Costs: ${fmtFull(costs.finance)}
• Loan Establishment: ${fmtFull(costs.loanFee)}
• Holding Costs: ${fmtFull(costs.holding)}
• Total Project Cost: ${fmtFull(costs.totalProjectCost)}

Profitability:
• Gross Profit: ${fmtFull(profitability.grossProfit)}
• Profit Margin (on revenue): ${profitability.profitMargin.toFixed(1)}%
• Profit on Cost: ${profitability.profitOnCost.toFixed(1)}%
• Target Margin: ${profitability.targetMargin}% (${revenue.grvExclGST < 15_000_000 ? 'GRV under $15M' : 'GRV $15M+'})
• Status: ${profitability.viabilityLabel} ${viabilityEmoji}

${residualSection}

Assumptions:
• Contingency: ${inputs.appliedContingency}% ${inputs.appliedContingency === 5 && !inputs.constructionBreakdown?.contingencyPercent ? '(added — not specified by user)' : '(as specified)'}
• Finance Draw: Land at settlement + construction drawn progressively (~50% avg)
• Holding Costs: Land tax ${fmtFull(holdingBreakdown.landTaxYearly)}/yr + council rates $${holdingBreakdown.councilRatesAnnual.toLocaleString()}/yr + water $${holdingBreakdown.waterRatesAnnual.toLocaleString()}/yr
• Stamp Duty: QLD rates for investment/commercial property
• Statutory and council fees are GST-free

${commentary}

[Adjust Inputs] [Download PDF]`;

  return response;
}


// ============================================================
// SECTION 4: RESIDUAL LAND VALUE MODE
// ============================================================

/**
 * Format response for residual land value analysis
 * User doesn't know/have a land price - wants to know max they can pay
 */
export function formatResidualResponse(calc, address, targetMarginOverride) {
  const { inputs, revenue, costs, profitability, residual, holdingBreakdown } = calc;
  const targetMargin = targetMarginOverride || profitability.targetMargin;

  const gstLabel = inputs.gstScheme === 'margin'
    ? `Margin Scheme (cost base: ${fmtCurrency(inputs.gstCostBase)})`
    : 'Fully Taxed';

  const response = `RESIDUAL LAND VALUE ANALYSIS${address ? `: ${address}` : ''}

This analysis calculates the maximum you can pay for the land while achieving your target developer's margin.

Inputs:
• Target GRV (inc GST): ${fmtFull(inputs.grvTotal)}
• Construction Cost: ${fmtFull(inputs.constructionWithContingency)} (inc ${inputs.appliedContingency}% contingency)
• LVR: ${inputs.lvr}% | Interest: ${inputs.interestRate}% p.a. | Timeline: ${inputs.timelineMonths} months
• Selling Costs: ${inputs.sellingCostsPercent}%
• GST: ${gstLabel}
• Target Developer's Margin: ${targetMargin}%

Revenue:
• Gross Revenue (inc GST): ${fmtFull(revenue.grvInclGST)}
• GST Payable: ${fmtFull(revenue.gstPayable)}
• Net Revenue (exc GST): ${fmtFull(revenue.grvExclGST)}

Project Costs (exc land):
• Construction (inc contingency): ${fmtFull(costs.construction)}
• Selling Costs (${inputs.sellingCostsPercent}%): ${fmtFull(costs.selling)}
• Finance & Holding: Calculated iteratively based on residual

RESULT:
• Maximum Land Price: ${fmtFull(residual.residualLandValue)}
• At this price, your profit margin would be: ${targetMargin}%
• Target Profit: ${fmtFull(Math.round(revenue.grvExclGST * (targetMargin / 100)))}

This means if you can acquire the site for less than ${fmtCurrency(residual.residualLandValue)}, you'll exceed your ${targetMargin}% target margin.

[Adjust Inputs] [Download PDF]`;

  return response;
}


// ============================================================
// SECTION 5: MAIN ENTRY POINT
// ============================================================

/**
 * Complete quick feasibility pipeline
 * 1. Parse raw inputs
 * 2. Calculate everything
 * 3. Format response
 *
 * Returns: { formattedResponse, calculationData, parsedInputs }
 */
export function runQuickFeasibility(rawInputs, address) {
  // Step 1: Parse
  const parsed = parseAllInputs(rawInputs);

  console.log('[FEASO-ENGINE] Parsed inputs:', JSON.stringify(parsed, null, 2));

  // Step 2: Calculate
  const calc = calculateFeasibility(parsed);

  console.log('[FEASO-ENGINE] Calculation results:');
  console.log('  Revenue (inc GST):', calc.revenue.grvInclGST);
  console.log('  Total Cost:', calc.costs.totalProjectCost);
  console.log('  Gross Profit:', calc.profitability.grossProfit);
  console.log('  Profit Margin:', calc.profitability.profitMargin + '%');
  console.log('  Viability:', calc.profitability.viabilityLabel);
  console.log('  Residual Land:', calc.residual.residualLandValue);

  // Step 3: Format
  const formattedResponse = formatFeasibilityResponse(calc, address);

  // Also return structured data for PDF/calculator
  return {
    formattedResponse,
    calculationData: calc,
    parsedInputs: parsed
  };
}

/**
 * Residual land value pipeline
 * Same as above but formats for "I don't know the land price" scenario
 */
export function runResidualAnalysis(rawInputs, address, targetMarginOverride) {
  // For residual mode, set land to 0 for initial calc, then use residual result
  const parsed = parseAllInputs({ ...rawInputs, purchasePriceRaw: '0' });
  const calc = calculateFeasibility(parsed);
  const formattedResponse = formatResidualResponse(calc, address, targetMarginOverride);

  return {
    formattedResponse,
    calculationData: calc,
    parsedInputs: parsed
  };
}
