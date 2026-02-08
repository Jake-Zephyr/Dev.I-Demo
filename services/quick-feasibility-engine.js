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
 * Parse LVR - handles both equity and debt funding interpretations.
 *
 * PRIORITY ORDER:
 *   1. Explicit "100% debt" / "100% equity" / "no debt" → unambiguous
 *   2. Explicit percentage number (e.g., "100%", "80%") → treat as LVR (debt %)
 *   3. "Fully funded" alone (no number) → 0% LVR (equity funded, no debt)
 *
 * This order means "fully funded. 100%" → 100% LVR (the explicit number wins),
 * while "fully funded" alone → 0% LVR (no debt).
 *
 * NOTE FOR LOVABLE TEAM: Button options should be:
 *   "60% debt | 70% debt | 80% debt | 100% debt | No debt (100% equity) | Custom"
 * This eliminates ALL ambiguity — user picks exactly what they mean.
 */
function parseLVR(input) {
  if (!input) return 0;
  const str = String(input).toLowerCase().trim();

  // 1. Explicit "no debt" / "equity" / "cash" keywords → always 0% LVR
  if (str.includes('no debt') || str.includes('equity') || str.includes('cash')) {
    console.log('[FEASO-PARSE] LVR: "' + input + '" → 0% (no debt / equity funded)');
    return 0;
  }

  // 2. Explicit "100% debt" or "full debt" → always 100% LVR
  if ((str.includes('100') && str.includes('debt')) || str.includes('full debt')) {
    console.log('[FEASO-PARSE] LVR: "' + input + '" → 100% (fully debt funded)');
    return 100;
  }

  // 3. If there's an explicit number, parse it as LVR percentage
  //    This catches "100%", "80%", "fully funded. 100%", "70" etc.
  const numMatch = str.match(/(\d+(?:\.\d+)?)\s*%?/);
  if (numMatch) {
    const num = parseFloat(numMatch[1]);
    if (num >= 0 && num <= 100) {
      console.log('[FEASO-PARSE] LVR: "' + input + '" → ' + num + '% (explicit number)');
      return num;
    }
  }

  // 4. "Fully funded" with NO number → interpret as 0% LVR (equity funded)
  if (str.includes('fully funded') || str.includes('full fund')) {
    console.log('[FEASO-PARSE] LVR: "' + input + '" → 0% (fully funded = equity, no number provided)');
    return 0;
  }

  // 5. Fallback
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
 * Based on current QLD Revenue Office transfer duty rates (2025-26)
 * Source: https://www.qld.gov.au/housing/buying-owning-home/transfer-duty
 */
function calculateStampDutyQLD(value) {
  if (value <= 5000) return 0;
  if (value <= 75000) return value * 0.015;
  if (value <= 540000) return 1125 + (value - 75000) * 0.035;
  if (value <= 1000000) return 17400 + (value - 540000) * 0.045;
  return 38100 + (value - 1000000) * 0.0575;
}

/**
 * QLD Land Tax calculation (company/trust rate)
 * Updated to current QRO rates (2025-26)
 * Source: https://www.qld.gov.au/environment/land/tax/calculation
 */
function calculateLandTaxQLD(landValue) {
  if (landValue <= 350000) return 0;
  if (landValue <= 2250000) return 1450 + (landValue - 350000) * 0.017;
  if (landValue <= 5000000) return 33750 + (landValue - 2250000) * 0.015;
  return 75000 + (landValue - 5000000) * 0.02;
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
// SECTION 5: CONVERSATION HISTORY EXTRACTOR
// ============================================================

/**
 * Extract feasibility inputs directly from conversation history.
 *
 * This is the NUCLEAR OPTION - we don't trust Claude to pass values correctly.
 * Instead, we scan the actual conversation to find what the user typed.
 *
 * The conversation follows this pattern:
 *   Assistant: "What's the purchase price?"
 *   User: "$10M"
 *   Assistant: "What's the GRV?"
 *   User: "$45M"
 *   ...etc
 *
 * We match the assistant's question to determine what the user's next message means.
 */
export function extractInputsFromConversation(conversationHistory) {
  if (!conversationHistory || conversationHistory.length === 0) {
    return null;
  }

  const extracted = {};

  // Walk through conversation in pairs: look at assistant message, then user response
  for (let i = 0; i < conversationHistory.length - 1; i++) {
    const msg = conversationHistory[i];
    const nextMsg = conversationHistory[i + 1];

    // We only care about assistant question → user answer pairs
    if (msg.role !== 'assistant' || nextMsg.role !== 'user') continue;

    const question = String(msg.content || '').toLowerCase();
    const answer = String(nextMsg.content || '').trim();

    // Skip empty answers
    if (!answer) continue;

    // GST COST BASE — check BEFORE purchase price to avoid false match
    // "What is the project cost base for Margin Scheme purposes? [Same as acquisition cost]"
    // contains "acquisition cost" which would falsely match the purchase price pattern
    if (extracted.gstSchemeRaw && (
      question.includes('cost base') ||
      (question.includes('margin scheme') && question.includes('purpose'))
    )) {
      extracted.gstCostBaseRaw = answer;
      console.log('[CONV-EXTRACT] GST cost base:', answer);
      continue; // Skip to next pair — don't let this match anything else
    }

    // PURCHASE PRICE / LAND VALUE
    // NOTE: No !extracted.X guard — if question is re-asked, LAST answer wins
    // Exclude questions about cost base or margin scheme (they contain "acquisition cost" in buttons)
    if ((
      question.includes('purchase price') ||
      question.includes('acquisition cost') ||
      question.includes('site acquisition') ||
      question.includes('buying') ||
      question.includes('land value') ||
      question.includes('land cost')
    ) && !question.includes('cost base') && !question.includes('margin scheme')) {
      extracted.purchasePriceRaw = answer;
      console.log('[CONV-EXTRACT] Purchase price:', answer);
    }

    // GRV / GROSS REVENUE
    else if (
      question.includes('gross revenue') ||
      question.includes('grv') ||
      question.includes('gross realisation') ||
      question.includes('target revenue') ||
      question.includes('total revenue')
    ) {
      extracted.grvRaw = answer;
      console.log('[CONV-EXTRACT] GRV:', answer);
    }

    // CONSTRUCTION COST
    else if (
      question.includes('construction cost') ||
      question.includes('construction budget') ||
      question.includes('build cost') ||
      question.includes('total construction') ||
      (question.includes('construction') && question.includes('cost'))
    ) {
      extracted.constructionCostRaw = answer;
      console.log('[CONV-EXTRACT] Construction cost:', answer);
    }

    // LVR
    else if (
      question.includes('lvr') ||
      question.includes('loan to value') ||
      question.includes('loan-to-value')
    ) {
      extracted.lvrRaw = answer;
      console.log('[CONV-EXTRACT] LVR:', answer);
    }

    // INTEREST RATE
    // Note: User might say "Custom" to the button question, then give the rate next
    // Also handle "What's your custom interest rate?" follow-up
    else if (
      question.includes('interest rate') ||
      question.includes('custom interest') ||
      question.includes('custom rate') ||
      (question.includes('interest') && question.includes('rate'))
    ) {
      // If answer is "Custom" or "custom", the actual rate is in the NEXT user message
      // Pattern: assistant asks → user says "Custom" → assistant asks "What rate?" → user gives "8.5"
      if (answer.toLowerCase() === 'custom') {
        // Look for next user message after the follow-up assistant question
        // i = assistant question, i+1 = user "Custom", i+2 = assistant follow-up, i+3 = user actual answer
        if (i + 3 < conversationHistory.length && conversationHistory[i + 3].role === 'user') {
          extracted.interestRateRaw = String(conversationHistory[i + 3].content).trim();
          console.log('[CONV-EXTRACT] Interest rate (from custom follow-up):', extracted.interestRateRaw);
        } else if (i + 2 < conversationHistory.length && conversationHistory[i + 2].role === 'user') {
          // Fallback: maybe no assistant follow-up, user just typed the rate directly
          extracted.interestRateRaw = String(conversationHistory[i + 2].content).trim();
          console.log('[CONV-EXTRACT] Interest rate (from direct follow-up):', extracted.interestRateRaw);
        } else {
          // Last resort: don't set - let Claude's value be used as fallback
          console.log('[CONV-EXTRACT] Interest rate: Custom selected but no follow-up found, will use Claude fallback');
        }
      } else {
        extracted.interestRateRaw = answer;
        console.log('[CONV-EXTRACT] Interest rate:', answer);
      }
    }

    // TIMELINE — no guard, last answer wins (handles re-asked questions)
    else if (
      question.includes('timeline') ||
      question.includes('project duration') ||
      question.includes('how many months') ||
      question.includes('in months')
    ) {
      extracted.timelineRaw = answer;
      console.log('[CONV-EXTRACT] Timeline:', answer);
    }

    // SELLING COSTS
    else if (
      question.includes('selling cost') ||
      question.includes('agent') ||
      question.includes('marketing') ||
      (question.includes('selling') && (question.includes('%') || question.includes('cost')))
    ) {
      if (answer.toLowerCase() === 'custom') {
        // Same pattern: i+3 = user answer after follow-up question
        if (i + 3 < conversationHistory.length && conversationHistory[i + 3].role === 'user') {
          extracted.sellingCostsRaw = String(conversationHistory[i + 3].content).trim();
          console.log('[CONV-EXTRACT] Selling costs (from custom follow-up):', extracted.sellingCostsRaw);
        } else if (i + 2 < conversationHistory.length && conversationHistory[i + 2].role === 'user') {
          extracted.sellingCostsRaw = String(conversationHistory[i + 2].content).trim();
          console.log('[CONV-EXTRACT] Selling costs (from direct follow-up):', extracted.sellingCostsRaw);
        }
      } else {
        extracted.sellingCostsRaw = answer;
        console.log('[CONV-EXTRACT] Selling costs:', answer);
      }
    }

    // GST SCHEME
    else if (
      question.includes('gst') ||
      question.includes('goods and services tax')
    ) {
      extracted.gstSchemeRaw = answer;
      console.log('[CONV-EXTRACT] GST scheme:', answer);
    }

    // GST COST BASE is handled at the top of the loop (before purchase price)
    // to avoid false matches with "acquisition cost" in button text
  }

  // ============================================================
  // PHASE 2: Scan ALL user messages for inline values
  // Catches cases like: "buying 70 nobby parade for $2m... GR 10m... cost $3.5m to build"
  // This handles when user provides values in their first message, not in Q&A format
  // ============================================================
  for (const msg of conversationHistory) {
    if (msg.role !== 'user') continue;
    const text = String(msg.content || '');
    if (!text || text.length < 10) continue; // Skip short answers like "80%" or "yes"
    const lower = text.toLowerCase();

    // Only scan messages that look like they contain feasibility request + values
    // Skip messages that are just answering a question (short, single value like "$10M", "80%", "18 months")
    const hasMultipleValues = (lower.match(/\$[\d.,]+[mkb]?/gi) || []).length >= 2 ||
      (lower.includes('buy') && lower.match(/\$/)) ||
      (lower.includes('feaso') && lower.match(/\$/)) ||
      (lower.includes('feasibility') && lower.match(/\$/));
    if (!hasMultipleValues) continue;

    console.log('[CONV-EXTRACT] Scanning user message for inline values:', text.substring(0, 80) + '...');

    // PURCHASE PRICE: "buying X for $2m", "purchase for $2m", "acquiring for $2m", "$2m to buy"
    if (!extracted.purchasePriceRaw) {
      const purchasePatterns = [
        /(?:buying|purchase|acquiring|buy)\s+(?:[\w\s]+?\s+)?for\s+(\$[\d.,]+\s*[mkb](?:illion|il)?)/i,
        /(?:buying|purchase|acquiring|buy)\s+(?:[\w\s]+?\s+)?(?:at|for)\s+(\$[\d.,]+(?:,\d{3})*)/i,
        /(\$[\d.,]+\s*[mkb](?:illion|il)?)\s+(?:to\s+)?(?:buy|purchase|acqui)/i,
        /(?:land|site|property)\s+(?:is|at|for|cost)\s+(\$[\d.,]+\s*[mkb]?)/i,
        /(?:purchase\s+price|land\s+(?:cost|value|price))\s+(?:is|of|:)?\s*(\$[\d.,]+\s*[mkb]?)/i,
      ];
      for (const pat of purchasePatterns) {
        const m = text.match(pat);
        if (m) {
          extracted.purchasePriceRaw = m[1].trim();
          console.log('[CONV-EXTRACT] Purchase price (inline):', extracted.purchasePriceRaw);
          break;
        }
      }
    }

    // GRV: "GR 10m", "GRV $10m", "gross revenue $10m", "worth $5m each (GR 10m)", "revenue of $10m"
    if (!extracted.grvRaw) {
      const grvPatterns = [
        /(?:gr|grv|gross\s*(?:revenue|realisation|realization))\s*(?:of|is|:)?\s*\$?([\d.,]+\s*[mkb](?:illion|il)?)/i,
        /\(\s*(?:gr|grv)\s*\$?([\d.,]+\s*[mkb]?)\s*\)/i,
        /(?:total\s+)?(?:revenue|grv|gr)\s+(?:of\s+)?\$?([\d.,]+\s*[mkb]?)/i,
        /(?:sell|selling|worth)\s+(?:for\s+)?\$?([\d.,]+\s*[mkb]?)\s*(?:total|all\s*up|gross|grv)/i,
      ];
      for (const pat of grvPatterns) {
        const m = text.match(pat);
        if (m) {
          // Add $ prefix if missing
          const val = m[1].trim();
          extracted.grvRaw = val.startsWith('$') ? val : '$' + val;
          console.log('[CONV-EXTRACT] GRV (inline):', extracted.grvRaw);
          break;
        }
      }
    }

    // CONSTRUCTION COST: "cost $3.5m to build", "construction $3.5m", "build cost $3.5m", "itll cost $3.5m"
    if (!extracted.constructionCostRaw) {
      const constructionPatterns = [
        /(?:cost|construction|build)\s+(?:is\s+|of\s+|about\s+|around\s+)?(\$[\d.,]+\s*[mkb](?:illion|il)?)\s*(?:to\s+build|construction|to\s+construct)?/i,
        /(\$[\d.,]+\s*[mkb](?:illion|il)?)\s+(?:to\s+build|construction\s+cost|build\s+cost)/i,
        /(?:it(?:'?ll|s?\s+going\s+to|s?\s+gonna)\s+)?cost\s+(\$[\d.,]+\s*[mkb]?)\s*(?:to\s+build)?/i,
        /(?:construction|build(?:ing)?)\s+(?:cost|budget)\s+(?:is|of|:)?\s*(\$[\d.,]+\s*[mkb]?)/i,
      ];
      for (const pat of constructionPatterns) {
        const m = text.match(pat);
        if (m) {
          extracted.constructionCostRaw = m[1].trim();
          console.log('[CONV-EXTRACT] Construction cost (inline):', extracted.constructionCostRaw);
          break;
        }
      }
    }
  }

  // Count how many inputs we found
  const fields = ['purchasePriceRaw', 'grvRaw', 'constructionCostRaw', 'lvrRaw',
    'interestRateRaw', 'timelineRaw', 'sellingCostsRaw', 'gstSchemeRaw'];
  const foundCount = fields.filter(f => extracted[f]).length;

  console.log(`[CONV-EXTRACT] Found ${foundCount}/${fields.length} inputs from conversation history`);

  if (foundCount === 0) return null;

  return extracted;
}


// ============================================================
// SECTION 6: INPUT VALIDATION & MISMATCH DETECTION
// ============================================================

/**
 * Validate that all required inputs are present before calculation.
 * Returns missing fields (blocking) and warnings (non-blocking).
 *
 * FIX 5: Refuse to calculate on missing inputs — never produce
 * confident-looking results with fabricated/default data.
 */
function validateRequiredInputs(parsed, mode) {
  const missing = [];
  const warnings = [];

  // Required fields (land not required in residual mode)
  if (mode !== 'residual' && (!parsed.landValue || parsed.landValue <= 0)) {
    missing.push('Land/Acquisition Cost');
  }
  if (!parsed.grvTotal || parsed.grvTotal <= 0) {
    missing.push('Target GRV (Gross Revenue)');
  }
  if (!parsed.constructionCost || parsed.constructionCost <= 0) {
    missing.push('Construction Cost');
  }
  if (!parsed.timelineMonths || parsed.timelineMonths <= 0) {
    missing.push('Project Timeline');
  }

  // Sanity warnings (non-blocking — calculation still runs)
  if (parsed.landValue > 0 && parsed.grvTotal > 0 && parsed.landValue > parsed.grvTotal) {
    warnings.push('Land value exceeds GRV — project will always be negative');
  }
  if (parsed.constructionCost > 0 && parsed.grvTotal > 0 && parsed.constructionCost > parsed.grvTotal * 0.9) {
    warnings.push('Construction cost exceeds 90% of GRV — please verify');
  }
  if (parsed.timelineMonths > 60) {
    warnings.push('Timeline exceeds 5 years — is this correct?');
  }
  if (parsed.interestRate > 15) {
    warnings.push('Interest rate above 15% — please verify');
  }

  return { missing, warnings, isValid: missing.length === 0 };
}

/**
 * Detect material mismatches between Claude's tool arguments and
 * conversation extraction results. A mismatch > 15% on any numeric
 * field is a strong signal that extraction grabbed stale/wrong data.
 *
 * FIX 2: Input mismatch detection gate.
 */
function detectInputMismatches(claudeInputs, extractedInputs) {
  const mismatches = [];
  const fields = [
    { key: 'purchasePriceRaw', label: 'Purchase Price', parser: parseMoneyValue },
    { key: 'grvRaw', label: 'GRV', parser: parseMoneyValue },
    { key: 'constructionCostRaw', label: 'Construction Cost', parser: (v) => parseConstructionCost(v).total },
    { key: 'interestRateRaw', label: 'Interest Rate', parser: parsePercentage },
    { key: 'timelineRaw', label: 'Timeline', parser: parseTimeline },
    { key: 'sellingCostsRaw', label: 'Selling Costs', parser: parsePercentage },
  ];

  for (const { key, label, parser } of fields) {
    const claudeRaw = claudeInputs[key];
    const extractedRaw = extractedInputs[key];

    if (!claudeRaw || !extractedRaw) continue;

    const claudeVal = parser(claudeRaw);
    const extractedVal = parser(extractedRaw);

    if (claudeVal === 0 || extractedVal === 0) continue;

    const diff = Math.abs(claudeVal - extractedVal) / Math.max(claudeVal, extractedVal);
    if (diff > 0.15) { // More than 15% difference = likely stale data
      mismatches.push({
        field: label,
        key,
        claudeRaw,
        extractedRaw,
        claudeValue: claudeVal,
        extractedValue: extractedVal,
        diffPercent: Math.round(diff * 100)
      });
    }
  }

  return mismatches;
}


// ============================================================
// SECTION 7: MAIN ENTRY POINT
// ============================================================

/**
 * Complete quick feasibility pipeline (REVISED ARCHITECTURE)
 *
 * KEY CHANGE: Claude's tool arguments are now PRIMARY.
 * Conversation extraction is used as VALIDATION + GAP-FILLER only.
 *
 * Previous architecture trusted extraction over Claude (to prevent hallucination).
 * But if conversationHistory contains stale messages from a previous session,
 * extraction would override current inputs with old data — causing catastrophic
 * "wrong numbers that look right" failures.
 *
 * New priority:
 *   1. Claude's tool args (from current conversation) = PRIMARY
 *   2. Conversation extraction = FILLS GAPS only (never overrides)
 *   3. If mismatch detected between the two, log warning + use Claude's values
 *   4. Validate all required inputs before calculating — refuse if missing
 *
 * Returns: { formattedResponse, calculationData, parsedInputs, inputSources }
 */
export function runQuickFeasibility(rawInputs, address, conversationHistory) {
  console.log('[FEASO] ====== PIPELINE START ======');
  console.log('[FEASO] LOG 1 — Tool args from Claude:', JSON.stringify(rawInputs, null, 2));
  console.log('[FEASO] LOG 2 — Address received:', address || '(none)');
  console.log('[FEASO] LOG 3 — Conversation history length:', conversationHistory?.length || 0);

  // Step 1: Extract from conversation (VALIDATION source, not primary)
  const conversationInputs = extractInputsFromConversation(conversationHistory);
  console.log('[FEASO] LOG 4 — Conversation extraction:', conversationInputs ? JSON.stringify(conversationInputs, null, 2) : '(null — no extraction)');

  // Step 2: INVERTED PRIORITY — Claude's tool args are PRIMARY
  // Conversation extraction only FILLS GAPS (never overrides present values)
  const inputFields = ['purchasePriceRaw', 'grvRaw', 'constructionCostRaw', 'lvrRaw',
    'interestRateRaw', 'timelineRaw', 'sellingCostsRaw', 'gstSchemeRaw', 'gstCostBaseRaw'];

  let finalInputs = {};
  let inputSources = {};

  if (conversationInputs) {
    // FIX 2: Detect mismatches before merging
    const mismatches = detectInputMismatches(rawInputs, conversationInputs);
    if (mismatches.length > 0) {
      console.warn('[FEASO] ⚠️ INPUT MISMATCHES DETECTED (likely stale conversation history):');
      for (const m of mismatches) {
        console.warn(`  ${m.field}: Claude="${m.claudeRaw}" (${m.claudeValue}) vs Extraction="${m.extractedRaw}" (${m.extractedValue}) — ${m.diffPercent}% diff`);
      }
      console.warn('[FEASO] → Using Claude\'s values for all fields where Claude provided a value');
    }

    // FIX 3: Build final inputs — Claude PRIMARY, extraction fills gaps only
    for (const f of inputFields) {
      if (rawInputs[f]) {
        finalInputs[f] = rawInputs[f];
        inputSources[f] = 'claude_tool_args';
      } else if (conversationInputs[f]) {
        finalInputs[f] = conversationInputs[f];
        inputSources[f] = 'conversation_extraction_fallback';
      } else {
        finalInputs[f] = undefined;
        inputSources[f] = 'not_provided';
      }
    }

    // Log comparison
    console.log('[FEASO] === INPUT SOURCE MAP ===');
    for (const f of inputFields) {
      const claudeVal = rawInputs[f] || '(empty)';
      const convVal = conversationInputs[f] || '(empty)';
      console.log(`  ${f}: source=${inputSources[f]} | Claude="${claudeVal}" | Extraction="${convVal}"`);
    }
    console.log('[FEASO] === END SOURCE MAP ===');
  } else {
    console.log('[FEASO] No conversation extraction available — using Claude inputs only');
    finalInputs = { ...rawInputs };
    for (const f of inputFields) {
      inputSources[f] = rawInputs[f] ? 'claude_tool_args' : 'not_provided';
    }
  }

  console.log('[FEASO] LOG 5 — Final inputs used:', JSON.stringify(finalInputs, null, 2));

  // Step 3: Parse raw strings to numbers
  const parsed = parseAllInputs(finalInputs);
  console.log('[FEASO] Parsed numeric values:', JSON.stringify(parsed, null, 2));

  // Step 4: FIX 5 — Validate required inputs (refuse to calculate if missing)
  const validation = validateRequiredInputs(parsed, 'standard');
  if (!validation.isValid) {
    console.error('[FEASO] ❌ MISSING REQUIRED INPUTS:', validation.missing);
    const errorResponse = `I can't run the feasibility yet — I'm missing some required inputs:\n\n${validation.missing.map(f => '• ' + f).join('\n')}\n\nCould you provide ${validation.missing.length === 1 ? 'this value' : 'these values'} so I can crunch the numbers?`;
    return {
      formattedResponse: errorResponse,
      calculationData: { error: true, missing: validation.missing, warnings: validation.warnings },
      parsedInputs: parsed,
      inputSources,
      validationErrors: validation.missing
    };
  }

  if (validation.warnings.length > 0) {
    console.warn('[FEASO] ⚠️ Input warnings (non-blocking):', validation.warnings);
  }

  // Step 5: Calculate
  const calc = calculateFeasibility(parsed);

  console.log('[FEASO] Calculation results:');
  console.log('  Revenue (inc GST):', calc.revenue.grvInclGST);
  console.log('  Total Cost:', calc.costs.totalProjectCost);
  console.log('  Gross Profit:', calc.profitability.grossProfit);
  console.log('  Profit Margin:', calc.profitability.profitMargin + '%');
  console.log('  Viability:', calc.profitability.viabilityLabel);
  console.log('  Residual Land:', calc.residual.residualLandValue);

  // Step 6: Format
  const formattedResponse = formatFeasibilityResponse(calc, address);

  console.log('[FEASO] ====== PIPELINE COMPLETE ======');

  return {
    formattedResponse,
    calculationData: calc,
    parsedInputs: parsed,
    inputSources,
    validationWarnings: validation.warnings
  };
}

/**
 * Residual land value pipeline (REVISED — same inverted priority)
 * Used when user doesn't know the land price — calculates max affordable price.
 */
export function runResidualAnalysis(rawInputs, address, targetMarginOverride, conversationHistory) {
  console.log('[FEASO] ====== RESIDUAL PIPELINE START ======');

  // Extract from conversation (validation/gap-filler only)
  const conversationInputs = extractInputsFromConversation(conversationHistory);

  // Inverted priority: Claude primary, extraction fills gaps
  const inputFields = ['grvRaw', 'constructionCostRaw', 'lvrRaw',
    'interestRateRaw', 'timelineRaw', 'sellingCostsRaw', 'gstSchemeRaw', 'gstCostBaseRaw'];

  let finalInputs = { purchasePriceRaw: '0' }; // Residual mode: land = 0
  for (const f of inputFields) {
    if (rawInputs[f]) {
      finalInputs[f] = rawInputs[f];
    } else if (conversationInputs && conversationInputs[f]) {
      finalInputs[f] = conversationInputs[f];
    }
  }

  const parsed = parseAllInputs(finalInputs);

  // Validate (residual mode — land not required)
  const validation = validateRequiredInputs(parsed, 'residual');
  if (!validation.isValid) {
    console.error('[FEASO] ❌ MISSING REQUIRED INPUTS (residual):', validation.missing);
    const errorResponse = `I can't calculate the residual land value yet — I'm missing:\n\n${validation.missing.map(f => '• ' + f).join('\n')}\n\nCould you provide ${validation.missing.length === 1 ? 'this value' : 'these values'}?`;
    return {
      formattedResponse: errorResponse,
      calculationData: { error: true, missing: validation.missing },
      parsedInputs: parsed
    };
  }

  const calc = calculateFeasibility(parsed);
  const formattedResponse = formatResidualResponse(calc, address, targetMarginOverride);

  console.log('[FEASO] ====== RESIDUAL PIPELINE COMPLETE ======');

  return {
    formattedResponse,
    calculationData: calc,
    parsedInputs: parsed
  };
}
