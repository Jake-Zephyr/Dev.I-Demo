/**
 * Quick Feasibility Engine - Complete Rebuild
 *
 * This module handles ALL aspects of quick feasibility:
 * 1. Input parsing (robust number extraction)
 * 2. Calculations (accurate GST, interest, all costs)
 * 3. Response formatting (professional, ready to display)
 *
 * Claude's job: Just display the formatted response verbatim
 */

import { calculateLandTaxQLD } from './feasibility-calculator.js';

/**
 * Parse monetary value - handles all formats
 */
function parseMoneyValue(input) {
  if (!input) return 0;
  if (typeof input === 'number') return input;

  let str = String(input).toLowerCase().trim();

  // Remove currency symbols, commas, spaces
  str = str.replace(/[$,\s]/g, '');

  // Handle "million" or "m" suffix
  if (str.match(/(\d+\.?\d*)m(illion)?$/)) {
    const num = parseFloat(str.replace(/m(illion)?/, ''));
    return num * 1000000;
  }

  // Handle "billion" or "b" suffix
  if (str.match(/(\d+\.?\d*)b(illion)?$/)) {
    const num = parseFloat(str.replace(/b(illion)?/, ''));
    return num * 1000000000;
  }

  // Handle "thousand" or "k" suffix
  if (str.match(/(\d+\.?\d*)k(thousand)?$/)) {
    const num = parseFloat(str.replace(/k(thousand)?/, ''));
    return num * 1000;
  }

  // Plain number (may have been comma-separated like 10,000,000)
  const num = parseFloat(str.replace(/[^0-9.]/g, ''));
  return isNaN(num) ? 0 : num;
}

/**
 * Parse percentage - handles % symbol and plain numbers
 */
function parsePercentage(input) {
  if (!input) return 0;
  if (typeof input === 'number') return input;

  let str = String(input).replace(/%/g, '').trim();
  const num = parseFloat(str);
  return isNaN(num) ? 0 : num;
}

/**
 * Format currency for display
 */
function formatCurrency(amount, decimals = 2) {
  if (amount >= 1000000) {
    return `$${(amount / 1000000).toFixed(decimals)}M`;
  } else if (amount >= 1000) {
    return `$${(amount / 1000).toFixed(decimals)}k`;
  } else {
    return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  }
}

/**
 * Calculate GST based on scheme
 */
function calculateGST(grvInclGST, scheme, costBase) {
  if (scheme === 'margin') {
    // Margin scheme: GST = (GRV - Cost Base) / 11
    const margin = grvInclGST - costBase;
    const gstPayable = margin / 11;
    const grvExclGST = grvInclGST - gstPayable;
    return { grvExclGST, gstPayable };
  } else {
    // Fully taxed: GST = GRV / 11
    const gstPayable = grvInclGST / 11;
    const grvExclGST = grvInclGST / 1.1;
    return { grvExclGST, gstPayable };
  }
}

/**
 * Calculate stamp duty (Queensland)
 */
function calculateStampDuty(landValue) {
  // QLD stamp duty rates (2024)
  if (landValue <= 5000) return 0;
  if (landValue <= 75000) return landValue * 0.015;
  if (landValue <= 540000) return 1125 + (landValue - 75000) * 0.035;
  if (landValue <= 1000000) return 17400 + (landValue - 540000) * 0.045;
  // Over $1M
  return 38100 + (landValue - 1000000) * 0.0575;
}

/**
 * Main calculation engine
 */
export function calculateQuickFeasibility(inputs) {
  // Parse all inputs
  const landValue = parseMoneyValue(inputs.landValue);
  const grvInclGST = parseMoneyValue(inputs.grvInclGST);
  const constructionCost = parseMoneyValue(inputs.constructionCost);
  const lvr = parsePercentage(inputs.lvr);
  const interestRate = parsePercentage(inputs.interestRate);
  const timelineMonths = parseFloat(inputs.timelineMonths) || 18;
  const sellingCostsPercent = parsePercentage(inputs.sellingCostsPercent);

  const gstScheme = String(inputs.gstScheme || '').toLowerCase().includes('margin') ? 'margin' : 'fully_taxed';
  const gstCostBase = gstScheme === 'margin' ? parseMoneyValue(inputs.gstCostBase) || landValue : 0;

  const propertyAddress = inputs.propertyAddress || '';
  const mode = inputs.mode || 'standard'; // standard, residual, profitability
  const targetMargin = parsePercentage(inputs.targetMargin) || 20;

  // Add 5% contingency if not included
  const constructionWithContingency = constructionCost * 1.05;

  // Calculate GST
  const { grvExclGST, gstPayable } = calculateGST(grvInclGST, gstScheme, gstCostBase);

  // Calculate stamp duty
  const stampDuty = calculateStampDuty(landValue);

  // Calculate selling costs
  const sellingCosts = grvExclGST * (sellingCostsPercent / 100);

  // Calculate holding costs
  const landTaxYearly = calculateLandTaxQLD(landValue);
  const councilRatesAnnual = 5000;
  const waterRatesAnnual = 1400;
  const holdingCostsYearly = landTaxYearly + councilRatesAnnual + waterRatesAnnual;
  const holdingCosts = holdingCostsYearly * (timelineMonths / 12);

  // Calculate finance costs (50% average draw for construction)
  const totalDebt = (landValue + constructionWithContingency) * (lvr / 100);
  const avgDebt = totalDebt * 0.5; // Average 50% outstanding
  const financeCosts = avgDebt * (interestRate / 100) * (timelineMonths / 12);

  // Total project costs
  const totalCosts = landValue + constructionWithContingency + sellingCosts + financeCosts + holdingCosts + stampDuty;

  // Profitability
  const grossProfit = grvExclGST - totalCosts;
  const profitMargin = (grossProfit / grvExclGST) * 100;

  // Residual land value (at target margin)
  const targetProfit = grvExclGST * (targetMargin / 100);
  let residualLandValue = grvExclGST - constructionWithContingency - sellingCosts - targetProfit;

  // Iterate to account for finance costs on land (5 iterations for convergence)
  for (let i = 0; i < 5; i++) {
    const residualDebt = (residualLandValue + constructionWithContingency) * (lvr / 100);
    const residualAvgDebt = residualDebt * 0.5;
    const residualFinanceCosts = residualAvgDebt * (interestRate / 100) * (timelineMonths / 12);
    const residualHoldingCosts = holdingCostsYearly * (timelineMonths / 12);
    const residualStampDuty = calculateStampDuty(residualLandValue);
    residualLandValue = grvExclGST - constructionWithContingency - sellingCosts - residualFinanceCosts - residualHoldingCosts - residualStampDuty - targetProfit;
  }

  // Determine viability
  let viability;
  if (profitMargin >= 25) viability = 'HIGHLY VIABLE';
  else if (profitMargin >= 20) viability = 'VIABLE';
  else if (profitMargin >= 15) viability = 'MARGINAL';
  else if (profitMargin >= 10) viability = 'CHALLENGING';
  else viability = 'NOT VIABLE';

  // Return structured data
  return {
    success: true,
    mode: mode,

    inputs: {
      propertyAddress,
      landValue,
      grvInclGST,
      constructionCost: constructionWithContingency,
      lvr,
      interestRate,
      timelineMonths,
      sellingCostsPercent,
      gstScheme,
      gstCostBase,
      targetMargin
    },

    revenue: {
      grvInclGST,
      grvExclGST,
      gstPayable
    },

    costs: {
      land: landValue,
      stampDuty,
      construction: constructionWithContingency,
      selling: sellingCosts,
      finance: financeCosts,
      holding: holdingCosts,
      total: totalCosts
    },

    profitability: {
      grossProfit,
      profitMargin,
      viability,
      targetMargin
    },

    residual: {
      landValue: residualLandValue,
      upside: residualLandValue - landValue
    }
  };
}

/**
 * Format professional response for display
 */
export function formatFeasibilityResponse(data) {
  const { inputs, revenue, costs, profitability, residual } = data;

  const addressLine = inputs.propertyAddress ? `**FEASIBILITY ANALYSIS: ${inputs.propertyAddress}**\n\n` : '**FEASIBILITY ANALYSIS**\n\n';

  let response = addressLine;

  // INPUTS SECTION
  response += `**INPUTS RECEIVED:**\n`;
  response += `• Land Acquisition: ${formatCurrency(inputs.landValue, 2)}\n`;
  response += `• Target GRV (inc GST): ${formatCurrency(inputs.grvInclGST, 2)}\n`;
  response += `• Construction Cost: ${formatCurrency(inputs.constructionCost, 2)} (inc 5% contingency)\n`;
  response += `• LVR: ${inputs.lvr}% | Interest: ${inputs.interestRate}% | Timeline: ${inputs.timelineMonths} months\n`;
  response += `• Selling Costs: ${inputs.sellingCostsPercent}% | GST: ${inputs.gstScheme === 'margin' ? 'Margin Scheme' : 'Fully Taxed'}\n`;
  if (inputs.gstScheme === 'margin') {
    response += `• GST Cost Base: ${formatCurrency(inputs.gstCostBase, 2)}\n`;
  }
  response += `\n`;

  // REVENUE SECTION
  response += `**REVENUE (Including GST):**\n`;
  response += `• Gross Revenue (inc GST): ${formatCurrency(revenue.grvInclGST, 2)}\n`;
  response += `• GST Payable: ${formatCurrency(revenue.gstPayable, 2)}\n`;
  response += `• Net Revenue (exc GST): ${formatCurrency(revenue.grvExclGST, 2)}\n`;
  response += `\n`;

  // COSTS SECTION
  response += `**PROJECT COSTS (Excluding GST):**\n`;
  response += `• Land Acquisition: ${formatCurrency(costs.land, 2)}\n`;
  response += `• Stamp Duty: ${formatCurrency(costs.stampDuty, 2)}\n`;
  response += `• Construction: ${formatCurrency(costs.construction, 2)}\n`;
  response += `• Selling Costs (${inputs.sellingCostsPercent}%): ${formatCurrency(costs.selling, 2)}\n`;
  response += `• Finance Costs: ${formatCurrency(costs.finance, 2)}\n`;
  response += `• Holding Costs: ${formatCurrency(costs.holding, 2)}\n`;
  response += `• **Total Project Cost: ${formatCurrency(costs.total, 2)}**\n`;
  response += `\n`;

  // PROFITABILITY SECTION
  response += `**PROFITABILITY:**\n`;
  response += `• Gross Profit: ${formatCurrency(profitability.grossProfit, 2)}\n`;
  response += `• Profit Margin: ${profitability.profitMargin.toFixed(1)}%\n`;
  response += `• Status: **${profitability.viability}** ${profitability.profitMargin >= 15 ? '✅' : '⚠️'}\n`;
  response += `\n`;

  // RESIDUAL LAND VALUE SECTION
  response += `**RESIDUAL LAND VALUE (at ${inputs.targetMargin}% margin):**\n`;
  response += `• Maximum affordable land value: ${formatCurrency(residual.landValue, 2)}\n`;
  response += `• vs Actual land cost: ${formatCurrency(inputs.landValue, 2)}\n`;
  if (residual.upside > 0) {
    response += `• Upside: +${formatCurrency(residual.upside, 2)} 💰\n`;
  } else {
    response += `• Shortfall: ${formatCurrency(residual.upside, 2)} ⚠️\n`;
  }
  response += `\n`;

  // FOOTER
  if (profitability.profitMargin >= 20) {
    response += `This project shows strong returns with a ${profitability.profitMargin.toFixed(1)}% margin, well above typical targets.`;
  } else if (profitability.profitMargin >= 15) {
    response += `This project meets standard feasibility thresholds with a ${profitability.profitMargin.toFixed(1)}% margin.`;
  } else {
    response += `This project falls below typical feasibility thresholds. Consider adjusting inputs or reviewing assumptions.`;
  }

  return response;
}
