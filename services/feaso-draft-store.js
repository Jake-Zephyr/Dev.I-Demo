/**
 * FeasoDraft Store — Server-side feasibility session state
 *
 * ARCHITECTURE:
 * - In-memory store keyed by conversationId
 * - Single source of truth for all feasibility inputs
 * - Eliminates stale conversation history contamination
 * - Property-locked: once a property is set, inputs cannot silently switch
 * - SourceMap tracks where each value came from
 * - Auto-expires drafts after 4 hours
 *
 * USAGE:
 *   import { getDraft, patchDraft, calculateDraft, getDefaultAssumptions } from './feaso-draft-store.js';
 */

import { parseAllInputs, calculateFeasibility, formatFeasibilityResponse, formatResidualResponse } from './quick-feasibility-engine.js';

// ============================================================
// DEFAULTS — single source, deterministic
// ============================================================

export function getDefaultAssumptions() {
  return {
    contingencyPercent: 5,
    profFeesPercent: 8,
    statutoryFeesPercent: 2,
    pmFeesPercent: 3,
    sellingCostsPercent: 3,       // Fixed 3% (agent + marketing + legal)
    agentFeesPercent: 1.5,
    marketingPercent: 1.2,
    legalSellingPercent: 0.3,
    sellOnCompletion: true,       // Sell all on completion (0 month selling period)
    interestRateDefault: 6.75,
    loanLVRDefault: 65,
    councilRatesAnnual: 5000,
    waterRatesAnnual: 1400,
    insurancePercent: 0.3,        // % of construction cost per year
    drawdownProfile: 'linear',
    targetDevMarginSmall: 15,     // GRV < $15M
    targetDevMarginLarge: 20      // GRV >= $15M
  };
}

// ============================================================
// DRAFT SCHEMA
// ============================================================

function createEmptyDraft(conversationId) {
  return {
    conversationId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),

    property: {
      address: null,
      lotPlan: null,
      siteAreaSqm: null,
      zone: null,
      density: null,
      heightM: null,
      overlays: null
    },

    inputs: {
      purchasePrice: null,
      grv: null,
      constructionCost: null,
      lvr: null,
      interestRate: null,
      timelineMonths: null,
      sellingCostsPercent: 3,       // Default 3% — not asked during Q&A
      sellOnCompletion: true,       // Sell all on completion (0 month selling period)
      gstScheme: null,
      gstCostBase: null
    },

    // Raw strings exactly as user typed (for display / re-parsing)
    rawInputs: {
      purchasePriceRaw: null,
      grvRaw: null,
      constructionCostRaw: null,
      lvrRaw: null,
      interestRateRaw: null,
      timelineRaw: null,
      sellingCostsRaw: null,
      gstSchemeRaw: null,
      gstCostBaseRaw: null
    },

    assumptions: getDefaultAssumptions(),

    // Computed holding costs — recalculated whenever inputs change
    holdingCosts: {
      landTaxAnnual: 0,         // Calculated from purchasePrice using QLD brackets
      councilRatesAnnual: 5000, // From assumptions
      waterRatesAnnual: 1400,   // From assumptions
      insuranceAnnual: 0,       // 0.3% of construction cost per year
      totalHoldingAnnual: 6400, // Sum of above
      totalHoldingProject: 0    // Prorated for timeline (months / 12)
    },

    status: 'collecting',  // 'collecting' | 'ready_to_calculate' | 'calculated'
    results: null,
    lastCalculatedAt: null,

    // Track where each value came from
    sourceMap: {}
  };
}

// ============================================================
// IN-MEMORY STORE
// ============================================================

const store = new Map();
const EXPIRY_MS = 4 * 60 * 60 * 1000; // 4 hours

// Cleanup expired drafts every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, draft] of store.entries()) {
    if (now - new Date(draft.updatedAt).getTime() > EXPIRY_MS) {
      console.log(`[FEASO-DRAFT] Expired draft: ${key}`);
      store.delete(key);
    }
  }
}, 30 * 60 * 1000);

// ============================================================
// GET DRAFT
// ============================================================

export function getDraft(conversationId) {
  if (!conversationId) return null;

  if (store.has(conversationId)) {
    return store.get(conversationId);
  }

  // Create new empty draft
  const draft = createEmptyDraft(conversationId);
  store.set(conversationId, draft);
  console.log(`[FEASO-DRAFT] Created new draft for conversation: ${conversationId}`);
  return draft;
}

// ============================================================
// PATCH DRAFT — partial update with source tracking
// ============================================================

/**
 * Apply a partial update to the draft.
 *
 * @param {string} conversationId
 * @param {object} patch - Partial draft object (deep merge into inputs, property, etc.)
 * @param {string} source - 'chat' | 'panel' | 'property_tool' | 'default'
 * @returns {{ draft, propertyMismatch? }}
 */
export function patchDraft(conversationId, patch, source = 'chat') {
  const draft = getDraft(conversationId);

  // Property lock check
  if (patch.property?.address && draft.property.address) {
    const existingAddr = normalizeAddress(draft.property.address);
    const newAddr = normalizeAddress(patch.property.address);
    if (existingAddr && newAddr && existingAddr !== newAddr) {
      console.warn(`[FEASO-DRAFT] Property mismatch: "${draft.property.address}" → "${patch.property.address}". Resetting draft.`);
      // Reset draft for new property
      const newDraft = createEmptyDraft(conversationId);
      Object.assign(draft, newDraft);
    }
  }

  // Deep merge property
  if (patch.property) {
    for (const [key, val] of Object.entries(patch.property)) {
      if (val !== null && val !== undefined) {
        draft.property[key] = val;
        draft.sourceMap[`property.${key}`] = source;
      }
    }
  }

  // Deep merge inputs (parsed numeric values)
  if (patch.inputs) {
    for (const [key, val] of Object.entries(patch.inputs)) {
      if (val !== null && val !== undefined) {
        draft.inputs[key] = val;
        draft.sourceMap[`inputs.${key}`] = source;
      }
    }
  }

  // Deep merge rawInputs (user-typed strings)
  if (patch.rawInputs) {
    for (const [key, val] of Object.entries(patch.rawInputs)) {
      if (val !== null && val !== undefined) {
        draft.rawInputs[key] = val;
        draft.sourceMap[`rawInputs.${key}`] = source;
      }
    }
  }

  // Deep merge assumptions (only if explicitly provided)
  if (patch.assumptions) {
    for (const [key, val] of Object.entries(patch.assumptions)) {
      if (val !== null && val !== undefined) {
        draft.assumptions[key] = val;
        draft.sourceMap[`assumptions.${key}`] = source;
      }
    }
  }

  // Recompute holding costs whenever inputs or assumptions change
  if (patch.inputs || patch.assumptions) {
    recomputeHoldingCosts(draft);
  }

  // Update status
  draft.status = checkReadyStatus(draft);
  draft.updatedAt = new Date().toISOString();

  console.log(`[FEASO-DRAFT] Patched (source=${source}):`, Object.keys(patch).join(', '));
  console.log(`[FEASO-DRAFT] Status: ${draft.status}`);

  return { draft };
}

// ============================================================
// CALCULATE — uses draft inputs + assumptions
// ============================================================

/**
 * Run feasibility calculation from draft state.
 * Returns { draft, chatSummary, formattedResponse }
 */
export function calculateDraft(conversationId, mode = 'standard') {
  const draft = getDraft(conversationId);

  if (!draft) {
    return { error: 'No draft found', code: 404 };
  }

  // Validate required fields
  const required = ['purchasePrice', 'grv', 'constructionCost', 'timelineMonths'];
  if (mode !== 'residual') {
    // Standard mode requires land value
  }
  const missing = [];
  for (const field of required) {
    if (mode === 'residual' && field === 'purchasePrice') continue;
    if (draft.inputs[field] === null || draft.inputs[field] === undefined) {
      missing.push(field);
    }
  }

  if (missing.length > 0) {
    return {
      error: 'Missing required inputs',
      missing,
      code: 400
    };
  }

  // Build raw inputs for the parser (use rawInputs if available, fall back to numeric)
  const rawForParser = {
    purchasePriceRaw: draft.rawInputs.purchasePriceRaw || String(draft.inputs.purchasePrice || 0),
    grvRaw: draft.rawInputs.grvRaw || String(draft.inputs.grv || 0),
    constructionCostRaw: draft.rawInputs.constructionCostRaw || String(draft.inputs.constructionCost || 0),
    lvrRaw: draft.rawInputs.lvrRaw || String(draft.inputs.lvr ?? draft.assumptions.loanLVRDefault),
    interestRateRaw: draft.rawInputs.interestRateRaw || String(draft.inputs.interestRate ?? draft.assumptions.interestRateDefault),
    timelineRaw: draft.rawInputs.timelineRaw || String(draft.inputs.timelineMonths || 0),
    sellingCostsRaw: draft.rawInputs.sellingCostsRaw || '3%', // Always defaults to 3%
    gstSchemeRaw: draft.rawInputs.gstSchemeRaw || (draft.inputs.gstScheme || 'margin'),
    gstCostBaseRaw: draft.rawInputs.gstCostBaseRaw || String(draft.inputs.gstCostBase || draft.inputs.purchasePrice || 0)
  };

  console.log('[FEASO-DRAFT] Calculating with raw inputs:', JSON.stringify(rawForParser, null, 2));

  const parsed = parseAllInputs(rawForParser);
  const calc = calculateFeasibility(parsed);
  const address = draft.property.address || '';

  let formattedResponse;
  if (mode === 'residual') {
    formattedResponse = formatResidualResponse(calc, address);
  } else {
    formattedResponse = formatFeasibilityResponse(calc, address);
  }

  // Update draft
  draft.results = calc;
  draft.lastCalculatedAt = new Date().toISOString();
  draft.status = 'calculated';
  draft.updatedAt = new Date().toISOString();

  // Build chat summary (template-based, no LLM)
  const chatSummary = formattedResponse;

  console.log('[FEASO-DRAFT] Calculation complete. Margin:', calc.profitability.profitMargin + '%');

  return {
    draft,
    chatSummary,
    formattedResponse,
    calculationData: calc,
    parsedInputs: parsed
  };
}

// ============================================================
// RESET — clear draft for new property
// ============================================================

export function resetDraft(conversationId) {
  const newDraft = createEmptyDraft(conversationId);
  store.set(conversationId, newDraft);
  console.log(`[FEASO-DRAFT] Reset draft for: ${conversationId}`);
  return newDraft;
}

// ============================================================
// DELETE
// ============================================================

export function deleteDraft(conversationId) {
  store.delete(conversationId);
}

// ============================================================
// HOLDING COSTS — auto-recalculated when inputs change
// ============================================================

/**
 * QLD Land Tax brackets (2025-26 QRO rates, companies/trusts)
 * Matches quick-feasibility-engine.js calculateLandTaxQLD()
 * Source: https://qro.qld.gov.au/land-tax/calculate/company-trust/
 */
function calculateLandTaxQLD(landValue) {
  if (!landValue || landValue < 350000) return 0;
  if (landValue <= 2249999) return 1450 + (landValue - 350000) * 0.017;
  if (landValue <= 4999999) return 33750 + (landValue - 2250000) * 0.015;
  if (landValue <= 9999999) return 75000 + (landValue - 5000000) * 0.0225;
  return 187500 + (landValue - 10000000) * 0.0275;
}

/**
 * Recompute holdingCosts on the draft from current inputs + assumptions.
 * Called automatically after every patchDraft.
 */
function recomputeHoldingCosts(draft) {
  const landValue = draft.inputs.purchasePrice || 0;
  const constructionCost = draft.inputs.constructionCost || 0;
  const timelineMonths = draft.inputs.timelineMonths || 0;
  const insurancePct = draft.assumptions.insurancePercent ?? 0.3;

  const landTaxAnnual = Math.round(calculateLandTaxQLD(landValue));
  const councilRatesAnnual = draft.assumptions.councilRatesAnnual || 5000;
  const waterRatesAnnual = draft.assumptions.waterRatesAnnual || 1400;
  const insuranceAnnual = Math.round(constructionCost * (insurancePct / 100));
  const totalHoldingAnnual = landTaxAnnual + councilRatesAnnual + waterRatesAnnual + insuranceAnnual;
  const totalHoldingProject = timelineMonths > 0
    ? Math.round(totalHoldingAnnual * (timelineMonths / 12))
    : 0;

  draft.holdingCosts = {
    landTaxAnnual,
    councilRatesAnnual,
    waterRatesAnnual,
    insuranceAnnual,
    totalHoldingAnnual,
    totalHoldingProject
  };
}

// ============================================================
// HELPERS
// ============================================================

function normalizeAddress(addr) {
  if (!addr) return '';
  return addr.toLowerCase().replace(/[,\s]+/g, ' ').trim();
}

/**
 * Check if all required inputs are present
 */
function checkReadyStatus(draft) {
  if (draft.status === 'calculated') return 'calculated';

  const required = ['purchasePrice', 'grv', 'constructionCost', 'timelineMonths'];
  const allPresent = required.every(f =>
    draft.inputs[f] !== null && draft.inputs[f] !== undefined
  );

  // Also need LVR, interest rate, GST scheme (sellingCosts defaults to 3%)
  const optional = ['lvr', 'interestRate', 'gstScheme'];
  const optionalPresent = optional.every(f =>
    draft.inputs[f] !== null && draft.inputs[f] !== undefined
  );

  if (allPresent && optionalPresent) return 'ready_to_calculate';
  return 'collecting';
}

/**
 * Parse a raw user string into a numeric value for a specific input field.
 * Used when patching the draft from chat - we store both raw and parsed.
 */
export function parseInputValue(fieldName, rawValue) {
  if (!rawValue) return null;

  // Import parsing functions from quick-feasibility-engine
  const parsers = {
    purchasePrice: (v) => {
      const str = String(v).toLowerCase().trim();
      return parseMoneyFromStr(str);
    },
    grv: (v) => parseMoneyFromStr(String(v).toLowerCase().trim()),
    constructionCost: (v) => parseMoneyFromStr(String(v).toLowerCase().trim()),
    lvr: (v) => {
      const str = String(v).toLowerCase().trim();
      if (str.includes('no debt') || str.includes('equity') || str.includes('cash')) return 0;
      if (str.includes('100') && str.includes('debt')) return 100;
      const num = parseFloat(str.replace(/[^0-9.]/g, ''));
      return isNaN(num) ? null : num;
    },
    interestRate: (v) => {
      const str = String(v).replace(/%|percent/g, '').trim();
      const num = parseFloat(str);
      return isNaN(num) ? null : num;
    },
    timelineMonths: (v) => {
      const str = String(v).toLowerCase().trim();
      const yearMatch = str.match(/([\d.]+)\s*(?:year|yr)/);
      if (yearMatch) return Math.round(parseFloat(yearMatch[1]) * 12);
      const num = parseFloat(str.replace(/months?|mo|mths?/gi, '').trim());
      return isNaN(num) ? null : Math.round(num);
    },
    sellingCostsPercent: (v) => {
      const str = String(v).replace(/%|percent/g, '').trim();
      const num = parseFloat(str);
      return isNaN(num) ? null : num;
    },
    gstScheme: (v) => {
      const str = String(v).toLowerCase();
      if (str.includes('fully') || str.includes('full tax') || str.includes('standard')) return 'fully_taxed';
      return 'margin';
    },
    gstCostBase: (v) => {
      const str = String(v).toLowerCase();
      if (str.includes('same') || str.includes('acquisition') || str.includes('purchase')) return 'same_as_acquisition';
      return parseMoneyFromStr(str);
    }
  };

  if (parsers[fieldName]) {
    return parsers[fieldName](rawValue);
  }
  return rawValue;
}

/**
 * Simple money parser (duplicated here to avoid circular imports)
 */
function parseMoneyFromStr(str) {
  if (!str) return 0;
  str = str.replace(/[$,\s]/g, '');
  const billionMatch = str.match(/([\d.]+)\s*(?:b(?:illion)?)/);
  if (billionMatch) return parseFloat(billionMatch[1]) * 1_000_000_000;
  const millionMatch = str.match(/([\d.]+)\s*(?:m(?:illion|il)?)/);
  if (millionMatch) return parseFloat(millionMatch[1]) * 1_000_000;
  const thousandMatch = str.match(/([\d.]+)\s*(?:k|thousand)/);
  if (thousandMatch) return parseFloat(thousandMatch[1]) * 1_000;
  const num = parseFloat(str.replace(/[^0-9.]/g, ''));
  return isNaN(num) ? 0 : num;
}
