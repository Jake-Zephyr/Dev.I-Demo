/**
 * Server-side input parser for quick feasibility
 *
 * This module parses RAW user inputs (strings) into numbers for calculation.
 * By doing parsing server-side instead of relying on Claude, we eliminate
 * the "Claude extracts wrong numbers" problem.
 */

/**
 * Parse monetary value from user input
 * Handles: $5M, $5m, 5 million, $5,000,000, 5000000
 */
export function parseMoneyValue(input) {
  if (!input) return 0;

  // Clean the string
  let str = String(input).toLowerCase().trim();

  // Remove currency symbols and commas
  str = str.replace(/[$,]/g, '');

  // Handle "million" or "m" suffix
  if (str.includes('m') || str.includes('million')) {
    const num = parseFloat(str.replace(/[^0-9.]/g, ''));
    return num * 1000000;
  }

  // Handle "billion" or "b" suffix
  if (str.includes('b') || str.includes('billion')) {
    const num = parseFloat(str.replace(/[^0-9.]/g, ''));
    return num * 1000000000;
  }

  // Handle "thousand" or "k" suffix
  if (str.includes('k') || str.includes('thousand')) {
    const num = parseFloat(str.replace(/[^0-9.]/g, ''));
    return num * 1000;
  }

  // Plain number
  const num = parseFloat(str.replace(/[^0-9.]/g, ''));
  return isNaN(num) ? 0 : num;
}

/**
 * Parse percentage from user input
 * Handles: 70%, 70, 6.5%, etc.
 */
export function parsePercentage(input) {
  if (!input) return 0;

  let str = String(input).toLowerCase().trim();
  str = str.replace(/%/g, '');

  const num = parseFloat(str);
  return isNaN(num) ? 0 : num;
}

/**
 * Parse timeline from user input
 * Handles: 18 months, 18mo, 18m, 18
 */
export function parseTimelineMonths(input) {
  if (!input) return 0;

  let str = String(input).toLowerCase().trim();
  str = str.replace(/months?|mo/g, '');

  const num = parseFloat(str);
  return isNaN(num) ? 0 : num;
}

/**
 * Parse construction cost with breakdown
 * Handles: "$30m build + $1m professional + $1m council + 5% contingency"
 */
export function parseConstructionCost(input) {
  if (!input) return { total: 0, breakdown: {} };

  const str = String(input).toLowerCase();

  // Try to find individual components
  const buildMatch = str.match(/(\$?[\d.]+[kmb]?)\s*(build|construction)/i);
  const professionalMatch = str.match(/(\$?[\d.]+[kmb]?)\s*(professional|fees)/i);
  const councilMatch = str.match(/(\$?[\d.]+[kmb]?)\s*(council|statutory)/i);
  const contingencyMatch = str.match(/(\d+)%\s*contingency/i);

  const buildCost = buildMatch ? parseMoneyValue(buildMatch[1]) : 0;
  const professionalFees = professionalMatch ? parseMoneyValue(professionalMatch[1]) : 0;
  const councilFees = councilMatch ? parseMoneyValue(councilMatch[1]) : 0;

  let subtotal = buildCost + professionalFees + councilFees;

  // If no breakdown found, treat entire input as total cost
  if (subtotal === 0) {
    subtotal = parseMoneyValue(input);
  }

  // Apply contingency if specified
  const contingencyPercent = contingencyMatch ? parseFloat(contingencyMatch[1]) : 0;
  const contingencyAmount = subtotal * (contingencyPercent / 100);
  const total = subtotal + contingencyAmount;

  return {
    total: total || subtotal,
    breakdown: {
      buildCost,
      professionalFees,
      councilFees,
      contingencyPercent,
      contingencyAmount
    }
  };
}

/**
 * Parse GRV (Gross Realisation Value) with various formats
 * Handles: $84M, $30k/sqm, $5M per unit, etc.
 */
export function parseGRV(input, saleableArea = 0, numUnits = 0) {
  if (!input) return { total: 0, method: 'unknown' };

  const str = String(input).toLowerCase();

  // Check for per sqm rate
  if (str.includes('/sqm') || str.includes('per sqm') || str.includes('psm')) {
    const rate = parseMoneyValue(str.replace(/\/(sqm|per sqm|psm)/g, ''));
    if (saleableArea > 0) {
      return {
        total: rate * saleableArea,
        method: 'per_sqm',
        rate: rate
      };
    }
    return { total: 0, method: 'per_sqm', rate: rate };
  }

  // Check for per unit
  if (str.includes('/unit') || str.includes('per unit')) {
    const rate = parseMoneyValue(str.replace(/\/(unit|per unit)/g, ''));
    if (numUnits > 0) {
      return {
        total: rate * numUnits,
        method: 'per_unit',
        rate: rate
      };
    }
    return { total: 0, method: 'per_unit', rate: rate };
  }

  // Total GRV
  return {
    total: parseMoneyValue(input),
    method: 'total'
  };
}

/**
 * Main parser - takes raw conversation inputs and returns parsed values
 */
export function parseFeasibilityInputs(rawInputs) {
  const {
    purchasePriceRaw,
    grvRaw,
    constructionCostRaw,
    lvrRaw,
    interestRateRaw,
    timelineRaw,
    sellingCostsRaw,
    gstSchemeRaw,
    gstCostBaseRaw,
    saleableArea = 0,
    numUnits = 0
  } = rawInputs;

  // Parse each input
  const purchasePrice = parseMoneyValue(purchasePriceRaw);
  const grv = parseGRV(grvRaw, saleableArea, numUnits);
  const construction = parseConstructionCost(constructionCostRaw);
  const lvr = parsePercentage(lvrRaw);
  const interestRate = parsePercentage(interestRateRaw);
  const timeline = parseTimelineMonths(timelineRaw);
  const sellingCosts = parsePercentage(sellingCostsRaw);

  // Parse GST scheme
  const gstScheme = String(gstSchemeRaw || '').toLowerCase().includes('margin')
    ? 'margin'
    : 'fully_taxed';

  // Parse GST cost base
  let gstCostBase = 0;
  if (gstScheme === 'margin') {
    const costBaseStr = String(gstCostBaseRaw || '').toLowerCase();
    if (costBaseStr.includes('same') || costBaseStr.includes('acquisition')) {
      gstCostBase = purchasePrice;
    } else {
      gstCostBase = parseMoneyValue(gstCostBaseRaw);
    }
  }

  return {
    landValue: purchasePrice,
    grvTotal: grv.total,
    grvMethod: grv.method,
    constructionCost: construction.total,
    constructionBreakdown: construction.breakdown,
    lvr: lvr,
    interestRate: interestRate,
    timelineMonths: timeline,
    sellingCostsPercent: sellingCosts,
    gstScheme: gstScheme,
    gstCostBase: gstCostBase,
    numUnits: numUnits || 1,
    saleableArea: saleableArea || 1
  };
}

/**
 * Test the parser with examples
 */
export function testParser() {
  const tests = [
    {
      input: { purchasePriceRaw: '$5M' },
      expected: 5000000,
      field: 'landValue'
    },
    {
      input: { grvRaw: '$84M' },
      expected: 84000000,
      field: 'grvTotal'
    },
    {
      input: { grvRaw: '$30k/sqm', saleableArea: 2800 },
      expected: 84000000,
      field: 'grvTotal'
    },
    {
      input: { constructionCostRaw: '$28M' },
      expected: 28000000,
      field: 'constructionCost'
    },
    {
      input: { constructionCostRaw: '$30m build + $1m professional + $1m council + 5% contingency' },
      expected: 33600000,
      field: 'constructionCost'
    },
    {
      input: { lvrRaw: '70%' },
      expected: 70,
      field: 'lvr'
    },
    {
      input: { interestRateRaw: '7.0%' },
      expected: 7.0,
      field: 'interestRate'
    },
    {
      input: { timelineRaw: '18 months' },
      expected: 18,
      field: 'timelineMonths'
    }
  ];

  console.log('=== FEASIBILITY INPUT PARSER TESTS ===');

  for (const test of tests) {
    const result = parseFeasibilityInputs(test.input);
    const actual = result[test.field];
    const passed = Math.abs(actual - test.expected) < 0.01;

    console.log(`${passed ? '✅' : '❌'} ${test.field}:`, {
      input: test.input,
      expected: test.expected,
      actual: actual
    });
  }
}
