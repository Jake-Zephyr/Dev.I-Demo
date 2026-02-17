# Lovable Frontend: Sync with Backend Calculator Changes

**Date:** 2026-02-17
**Context:** Backend feasibility calculators have been updated with corrected QLD tax rates, graduated target margin, and improved residual convergence. The Lovable frontend `FeasibilityCalculator.tsx` needs to match.

**Scope:** Only the detailed calculator (`FeasibilityCalculator.tsx`) and results components. The quick feasibility (chat-based Q&A) is handled entirely by the backend — no frontend calculation changes needed there.

---

## CHANGE 1 — CRITICAL: Stamp Duty Rates (DO NOT CHANGE)

**File:** `src/components/FeasibilityCalculator.tsx` — `calculateStampDutyQLD()`

**Status: YOUR CODE IS ALREADY CORRECT. Do not change it.**

The previous instruction doc (`LOVABLE_FRONTEND_CHANGES.md` section 3.1) told you to update to `1125 / 17400 / 38100`. **That was wrong.** Your current code already has the correct cumulative amounts:

```typescript
// CORRECT — keep this exactly as-is
const calculateStampDutyQLD = (price: number): number => {
  if (price <= 5000) return 0;
  if (price <= 75000) return (price - 5000) * 0.015;   // cumulative at $75k = $1,050
  if (price <= 540000) return 1050 + (price - 75000) * 0.035;   // $17,325 at $540k
  if (price <= 1000000) return 17325 + (price - 540000) * 0.045; // $38,025 at $1M
  return 38025 + (price - 1000000) * 0.0575;
};
```

The backend has now been fixed to match YOUR rates. All three backend calculators (`quick-feasibility-engine.js`, `feasibility-calculator.js`, `stamp-duty-calculator.js`) now produce identical results to your frontend.

**Verification:** Stamp duty on $2,000,000 should be **$95,525**.
- `38025 + (2000000 - 1000000) * 0.0575 = 38025 + 57500 = $95,525`

---

## CHANGE 2 — HIGH: Graduate Target Margin

**File:** `src/components/FeasibilityCalculator.tsx`

**Problem:** Your calculator uses a flat 20% default target margin:

```typescript
// CURRENT (wrong — doesn't match backend)
const ASSUMED_DEFAULTS = {
  // ...
  targetMargin: '20',
};
```

The backend now uses a **graduated scale** based on GRV (exc GST):

| GRV (exc GST) | Target Margin |
|---|---|
| Under $10M | 15% |
| $10M – $20M | 15% → 20% (linear interpolation) |
| Over $20M | 20% |

**Change:** Add this helper function and use it in `calculateFeasibility()`:

```typescript
// Add this function near the top of the file (alongside the other helpers)
function calculateTargetMargin(grvExclGST: number): number {
  if (grvExclGST <= 10_000_000) return 15;
  if (grvExclGST >= 20_000_000) return 20;
  return Math.round((15 + ((grvExclGST - 10_000_000) / 10_000_000) * 5) * 10) / 10;
}
```

Then in `calculateFeasibility()`, replace the flat default with the graduated calculation:

```typescript
// BEFORE (flat 20% default):
const targetMargin = (parseFloat(inputs.targetMargin) || parseFloat(ASSUMED_DEFAULTS.targetMargin)) / 100;

// AFTER (graduated, with user override):
const userTargetMargin = parseFloat(inputs.targetMargin);
const targetMarginPercent = userTargetMargin > 0
  ? userTargetMargin
  : calculateTargetMargin(grvExclGST);
const targetMargin = targetMarginPercent / 100;
```

And update the results object:

```typescript
// In the setResults() call, change:
targetMargin: parseFloat(inputs.targetMargin) || 20,

// To:
targetMargin: targetMarginPercent,
```

**Also update the `ASSUMED_DEFAULTS`** placeholder text. Since the target margin is now dynamic, change the placeholder to indicate this:

```typescript
// Change the placeholder on the target margin input from:
placeholder={`Assumed: ${ASSUMED_DEFAULTS.targetMargin}%`}

// To:
placeholder={`Auto: ${calculateTargetMargin(parseFloat(inputs.grvInclGST) / 1.1 || 0)}% (based on GRV)`}
```

Or simpler — just change the placeholder to a static hint:

```typescript
placeholder="Auto: 15-20% based on GRV"
```

**Why this matters:** A $12M GRV project was getting a 20% target margin (too high), making projects appear less viable than they should. The graduated scale means smaller projects get a more realistic 15% target.

---

## CHANGE 3 — HIGH: Add "Highly Viable" to FeasibilityResults

**File:** `src/components/FeasibilityResults.tsx`

**Problem:** The backend now returns 5 viability states, but the frontend only handles 4:

| Backend | Frontend |
|---|---|
| `highly_viable` | **MISSING** |
| `viable` | `viable` |
| `marginal` | `marginal` |
| `challenging` | `challenging` |
| `not_viable` | `not_viable` |

When the backend sends `highly_viable`, the viability badge renders blank.

**Change:** Add the missing state:

```typescript
const viabilityColors = {
  highly_viable: 'bg-green-100 text-green-800 border-green-300',  // ADD THIS
  viable: 'bg-green-100 text-green-800 border-green-300',
  marginal: 'bg-yellow-100 text-yellow-800 border-yellow-300',
  challenging: 'bg-orange-100 text-orange-800 border-orange-300',
  not_viable: 'bg-red-100 text-red-800 border-red-300',
};

const viabilityLabels = {
  highly_viable: 'Highly Viable',  // ADD THIS
  viable: 'Viable',
  marginal: 'Marginal',
  challenging: 'Challenging',
  not_viable: 'Not Viable',
};
```

Also update the `FeasibilityResultsData` interface:

```typescript
viability: 'highly_viable' | 'viable' | 'marginal' | 'challenging' | 'not_viable';
```

---

## CHANGE 4 — MEDIUM: Fix Finance Calculation to Use LVR

**File:** `src/components/FeasibilityCalculator.tsx` — `calculateFeasibility()`

**Problem:** Your finance cost calculation ignores the user's LVR input entirely. It hardcodes 60% of total dev costs as average debt:

```typescript
// CURRENT (wrong — ignores LVR input)
const avgDebt = totalDevCosts * 0.6;
const interestCost = (avgDebt * interestRate * (totalMonths / 12));
```

The backend calculates finance costs based on actual LVR:

```javascript
// BACKEND (correct)
const landDebt = landValue * lvrDecimal;
const constructionDebt = constructionWithContingency * lvrDecimal;
const avgDebt = landDebt + (constructionDebt * 0.5); // land full period, construction ~50% avg draw
const financeCosts = avgDebt * interestRate * (timelineMonths / 12);
const loanFee = (landDebt + constructionDebt) * 0.005; // 0.5% establishment
```

**Change:** Replace the finance section in `calculateFeasibility()`:

```typescript
// Replace the finance cost section with:
const loanFees = parseFloat(inputs.loanFees) || 0;
const interestRate = (parseFloat(inputs.interestRate) || parseFloat(ASSUMED_DEFAULTS.interestRate)) / 100;

// LVR-based debt calculation (matches backend)
// If user hasn't set LVR explicitly, fall back to 65% (industry default)
const lvr = parseFloat(inputs.lvr) || 65;  // Note: you'll need to add 'lvr' to inputs state
const lvrDecimal = lvr / 100;
const landDebt = landValue * lvrDecimal;
const constructionDebt = totalProjectConstructionCosts * lvrDecimal;
const avgDebt = landDebt + (constructionDebt * 0.5); // Land for full period, construction ~50% average draw
const interestCost = avgDebt * interestRate * (totalMonths / 12);
const loanEstablishment = (landDebt + constructionDebt) * 0.005; // 0.5% establishment fee
const totalFinance = interestCost + loanFees + loanEstablishment;
```

**NOTE:** Your `inputs` state object doesn't currently have an `lvr` field. You'll need to add it:

```typescript
// In the inputs state initialization, add:
lvr: '',

// In the preFill useEffect, add:
lvr: fillNum(prev.lvr, preFill.lvr),

// And add an input field in the Finance Costs section of the form:
<div>
  <label className="block text-xs font-medium text-slate-700 mb-1">LVR %</label>
  <input
    type="number"
    step="5"
    value={inputs.lvr}
    onChange={(e) => handleInputChange('lvr', e.target.value)}
    className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded placeholder:text-muted-foreground/60 placeholder:italic"
    placeholder="Assumed: 65%"
  />
</div>
```

**Why this matters:** A self-funded (0% LVR) project currently gets charged finance costs on 60% of dev costs. An 80% LVR project gets the same 60%. Neither is correct.

---

## CHANGE 5 — MEDIUM: Improve Residual Land Value Calculation

**File:** `src/components/FeasibilityCalculator.tsx` — `calculateFeasibility()`

**Problem:** Your residual calculation is a single pass:

```typescript
// CURRENT (inaccurate — single pass)
const residualLandValue = grvExclGST - (totalDevCosts + totalFinance) - targetProfit;
```

This doesn't account for the fact that stamp duty, land tax, legal costs, and finance costs all change as the residual land value changes. The backend uses iterative convergence (up to 20 iterations).

**Change:** Replace the residual calculation with an iterative version:

```typescript
// Replace the single-pass residual calculation with:
const targetProfit = grvExclGST * targetMargin;

// Initial estimate (before land-dependent costs)
let residualLandValue = grvExclGST
  - totalProjectConstructionCosts
  - totalSellingCosts
  - targetProfit;

// Iterate to converge (stamp duty, legal, finance, holding all depend on land value)
let prevResidual = 0;
for (let i = 0; i < 20; i++) {
  const resStampDuty = inputs.state === 'QLD'
    ? calculateStampDutyQLD(residualLandValue)
    : calculateStampDutyNSW(residualLandValue);
  const resLegal = Math.round(residualLandValue * 0.005);

  // Finance on residual land value
  const resLandDebt = residualLandValue * lvrDecimal;
  const resAvgDebt = resLandDebt + (constructionDebt * 0.5);
  const resFinance = resAvgDebt * interestRate * (totalMonths / 12);
  const resLoanFee = (resLandDebt + constructionDebt) * 0.005;

  // Holding costs (prorated to timeline)
  const resLandTaxYearly = parseFloat(inputs.landTaxYearly) || 0;
  const resHolding = (resLandTaxYearly / 12 + councilRatesBA / 6 + waterRatesQ / 3) * totalMonths + otherHolding;

  residualLandValue = grvExclGST
    - totalProjectConstructionCosts
    - totalSellingCosts
    - resFinance - resLoanFee
    - resHolding
    - resStampDuty - resLegal
    - targetProfit;

  if (Math.abs(residualLandValue - prevResidual) < 100) break; // Converged
  prevResidual = residualLandValue;
}
residualLandValue = Math.max(0, Math.round(residualLandValue));

const residualPerSqm = siteArea > 0 ? residualLandValue / siteArea : 0;
const residualPerUnit = numUnits > 0 ? residualLandValue / numUnits : 0;
```

**Why this matters:** On a $5M+ land residual, stamp duty alone is ~$268k. The single-pass calculation ignores this, so the displayed residual is overstated by several hundred thousand dollars.

---

## CHANGE 6 — LOW: Viability Classification in Detailed Calculator

**File:** `src/components/FeasibilityCalculator.tsx`

**Problem:** The detailed calculator doesn't compute viability classification at all — it just shows the margin number. If you want to add viability badges (like in `FeasibilityResults.tsx`), use the backend's classification logic:

```typescript
// Add to the results object in setResults():
function classifyViability(profitMargin: number, targetMarginPercent: number) {
  if (profitMargin >= targetMarginPercent + 10) return 'highly_viable';
  if (profitMargin >= targetMarginPercent) return 'viable';
  if (profitMargin >= targetMarginPercent - 5) return 'marginal';
  if (profitMargin >= 0) return 'challenging';
  return 'not_viable';
}
```

This is optional — the detailed calculator currently just shows the raw margin number with green/red coloring, which works fine.

---

## SUMMARY

| # | Priority | File | What | Impact |
|---|---|---|---|---|
| 1 | CRITICAL | FeasibilityCalculator.tsx | **DO NOT** change stamp duty rates | Prevents breaking correct code |
| 2 | HIGH | FeasibilityCalculator.tsx | Graduate target margin (15-20% based on GRV) | Smaller projects get realistic targets |
| 3 | HIGH | FeasibilityResults.tsx | Add `highly_viable` state | Prevents blank viability badge |
| 4 | MEDIUM | FeasibilityCalculator.tsx | Use LVR for finance calc (not hardcoded 60%) | Finance costs match user's actual funding |
| 5 | MEDIUM | FeasibilityCalculator.tsx | Iterative residual convergence | Residual accuracy on large land values |
| 6 | LOW | FeasibilityCalculator.tsx | Add viability classification | Consistent with quick feaso results |

---

## VERIFICATION CHECKLIST

After making these changes, verify with this test case:

**Inputs:**
- Site Area: 1,000 sqm
- Density: RD6
- Units: 20
- GRV (inc GST): $12,000,000
- Land Value: $3,000,000
- Construction: $6,000,000
- Contingency: 5%
- GST Scheme: Margin (cost base = $3,000,000)
- Interest Rate: 7%
- LVR: 70%
- Timeline: 3 months lead-in + 15 months construction + 0 selling
- Selling Costs: Agent 1.5%, Marketing 1.5%, Legal 1.0%
- Target Margin: (leave blank — should auto-calculate)

**Expected results:**
- Target margin should auto-calculate to **15%** (GRV exc GST ~$11.2M, which is under $10M threshold)
  - Actually: GRV exc GST with margin scheme = $12M - ($12M - $3M)/11 = $12M - $818k = **$11,181,818**
  - $11.18M is between $10M and $20M, so target = 15 + ((11.18M - 10M) / 10M) * 5 = **15.6%**
- Stamp duty on $3M land: `38025 + (3000000 - 1000000) * 0.0575` = **$153,025**
- Finance should use 70% LVR, not hardcoded 60%

---

## SUPERSEDES

This document **supersedes section 3.1** of `LOVABLE_FRONTEND_CHANGES.md` (which incorrectly told you to use wrong stamp duty cumulative amounts 1125/17400/38100). All other sections of that document remain valid.

---

**END OF DOCUMENT**
