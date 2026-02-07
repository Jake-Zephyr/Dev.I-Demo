# Dev.I Feasibility Functions: Comprehensive Review

## Date: February 2026

---

## 1. Architecture Overview

The feasibility system is split across **four files** (~3,600 lines total):

| File | Role | Status |
|------|------|--------|
| `services/quick-feasibility-engine.js` | **Primary engine** - parsing, calculation, formatting, conversation extraction | Active / Main |
| `services/feasibility-calculator.js` | Older engine with density codes, quick feasibility, defaults | Partially active (only `getDetailedFeasibilityPreFill` used) |
| `services/feasibility-input-parser.js` | Standalone input parsing utilities | Appears unused (superseded) |
| `services/stamp-duty-calculator.js` | Multi-state stamp duty calculator (standalone API endpoint) | Active (API only) |

### How it works end-to-end

1. User interacts with Claude via `/api/advise` endpoint
2. Claude collects inputs conversationally (purchase price, GRV, construction cost, LVR, interest rate, timeline, selling costs, GST scheme)
3. Claude calls the `calculate_quick_feasibility` tool, passing raw strings
4. **Backend overrides Claude's values** by re-extracting them directly from conversation history (`extractInputsFromConversation`) - the "nuclear option" to prevent hallucination
5. Raw strings are parsed to numbers (`parseAllInputs`)
6. Full financial model runs (`calculateFeasibility`)
7. Results are formatted into a text response (`formatFeasibilityResponse`)
8. **Response bypasses Claude entirely** - returned directly to user to prevent hallucinated modifications

This architecture is a deliberate anti-hallucination design. Claude is treated as a conversation facilitator, not a calculator.

---

## 2. Detailed Function Analysis

### 2.1 Input Parsing (`quick-feasibility-engine.js:13-198`)

**How it works:** Takes raw user strings like "$10M", "80%", "18 months" and converts them to numbers.

| Function | Input Examples | Output |
|----------|--------------|--------|
| `parseMoneyValue` | "$10M", "10 million", "$10,000,000" | 10000000 |
| `parsePercentage` | "80%", "80", "fully funded" | 80 or 0 |
| `parseTimeline` | "18 months", "1.5 years", "18mo" | 18 |
| `parseConstructionCost` | "$30m build + $1m professional + 5% contingency" | { total, breakdown } |
| `parseGSTScheme` | "margin scheme", "fully taxed" | "margin" or "fully_taxed" |
| `parseLVR` | "80%", "fully funded", "no debt" | 80 or 0 |

**Assessment:** The parsing in `quick-feasibility-engine.js` is well-implemented with regex that targets specific suffixes (e.g., `/([\d.]+)\s*(?:m(?:illion|il)?)/`), making it robust against false positives.

### 2.2 Calculation Engine (`quick-feasibility-engine.js:250-433`)

The core `calculateFeasibility(inputs)` function computes:

- **Revenue:** GRV inc/exc GST, GST payable (margin or full scheme)
- **Acquisition costs:** Land + stamp duty (QLD) + legal (0.5% of land)
- **Construction:** User-provided cost + auto-5% contingency if not specified
- **Selling costs:** User-specified % of revenue (exc GST)
- **Holding costs:** Land tax (QLD) + council rates ($5,000/yr) + water ($1,400/yr) + insurance (0.3% construction/yr), prorated to timeline
- **Finance costs:** Interest on (land debt full period + construction debt at ~50% average draw), loan establishment fee (0.5%)
- **Profitability:** Gross profit, profit margin (on revenue), profit on cost, viability rating
- **Residual land value:** Maximum affordable land price at target margin (8-iteration convergence)

### 2.3 Conversation Extraction (`quick-feasibility-engine.js:650-898`)

Two-phase extraction:
- **Phase 1:** Walks assistant/user message pairs, matches the assistant's question text to determine what each user answer refers to (e.g., if assistant asked about "purchase price", the next user message is the purchase price)
- **Phase 2:** Scans all user messages for inline values using regex patterns (e.g., "buying X for $2m", "GRV $10m")

Extracted values **override** Claude's passed values.

### 2.4 Viability Classification

| Condition | Label |
|-----------|-------|
| `profitMargin >= targetMargin + 10%` | HIGHLY VIABLE |
| `profitMargin >= targetMargin` | VIABLE |
| `profitMargin >= targetMargin - 5%` | MARGINAL |
| `profitMargin >= 0%` | CHALLENGING |
| `profitMargin < 0%` | NOT VIABLE |

Target margin: 15% for GRV < $15M, 20% for GRV >= $15M.

---

## 3. Identified Inaccuracies

### 3.1 CRITICAL: QLD Land Tax Rates Are Outdated

**Files:** `quick-feasibility-engine.js:220-225` and `feasibility-calculator.js:58-63`

The code uses old bracket boundaries that do not match current QLD Revenue Office rates for companies/trusts:

| Bracket | Code Uses | Current QRO Rate |
|---------|-----------|-----------------|
| Threshold | $350,000 (correct) | $350,000 |
| 2nd bracket upper | **$2,100,000** | **$2,249,999** |
| 2nd bracket base | $1,450 + 1.7% (correct) | $1,450 + 1.7% |
| 3rd bracket base amount | **$31,200** | **$33,750** |
| 3rd bracket rate | 1.5% (correct) | 1.5% |
| 4th bracket base amount | **$74,700** | **$75,000** |
| 4th bracket rate | **2.0%** (all above $5M) | **2.25%** ($5M-$10M) |
| 5th bracket | **Missing** | **$187,500 + 2.75%** (above $10M) |

**Impact example:** For a $10M land value:
- Code calculates: $74,700 + ($10M - $5M) x 2.0% = **$174,700/year**
- Correct calculation: $75,000 + ($10M - $5M) x 2.25% = **$187,500/year**
- **Under-estimation: $12,800/year** (multiplied by project timeline)

For an 18-month project at $10M land value, this understates holding costs by approximately **$19,200**.

### 3.2 MODERATE: Stamp Duty Inconsistencies (Three Different Implementations)

There are **three separate stamp duty calculators** with different results:

| File | $75k boundary | $540k cumulative | $1M cumulative | Verdict |
|------|--------------|-----------------|----------------|---------|
| `stamp-duty-calculator.js:14` | `(value-5000)*0.015` = $1,050 | $17,325 | $38,025 | **Correct** |
| `quick-feasibility-engine.js:211` | `value*0.015` = $1,125 | $17,325 | $38,025 | Wrong first bracket, correct higher brackets |
| `feasibility-calculator.js:45` | `price*0.015` = $1,125 | **$17,400** | **$38,100** | Wrong cumulative amounts (all +$75) |

The **correct** rate for the $5,001-$75,000 bracket is `(value - 5000) * 0.015`, confirmed by the QRO: duty at $75,000 should be $1,050, not $1,125.

**Practical impact:** The first bracket error only affects properties valued $5k-$75k (irrelevant for development sites). However, in `feasibility-calculator.js`, the wrong cumulative of $1,125 propagates to all higher brackets, consistently overstating stamp duty by $75. Trivial on multi-million dollar deals, but technically wrong.

### 3.3 MODERATE: GST Margin Scheme Simplification

**File:** `quick-feasibility-engine.js:274-277`

```
const margin = grvTotal - gstCostBase;
gstPayable = Math.max(0, margin / 11);
```

The code calculates GST on the **total margin** (total GRV minus total cost base). In practice, the GST margin scheme is calculated on a **per-lot basis** (each individual sale's margin). For a quick feasibility with uniform unit pricing, this simplification is mathematically equivalent. However:

- It won't correctly handle mixed developments (commercial + residential)
- It doesn't account for the fact that new residential premises may be subject to **full GST** regardless of margin scheme election
- The cost base for margin scheme purposes should be the original acquisition cost of the land **attributable to each lot**, which requires subdivision apportionment

### 3.4 LOW: Hardcoded Holding Cost Assumptions

**File:** `quick-feasibility-engine.js:298-299`

```javascript
const councilRatesAnnual = 5000;
const waterRatesAnnual = 1400;
```

These are hardcoded Gold Coast-specific estimates. Issues:
- Council rates vary significantly by property value (GCCC rates can range from $3,000 to $30,000+ for development sites)
- Water/sewerage charges depend on connections, not a flat rate
- No disclosure to the user that these are fixed estimates (the "Assumptions" section partially addresses this)
- Insurance at 0.3% of construction cost is simplistic (contract works insurance varies by project type and risk)

---

## 4. Identified Risks

### 4.1 Conversation Extraction Fragility

The `extractInputsFromConversation` function is the linchpin of accuracy - it overrides Claude's values with what it parses from the chat history. Risks:

- **Question matching is keyword-based:** If the assistant rephrases a question differently, the extractor may not match it. For example, asking "What's the site acquisition figure?" instead of "purchase price" would match (via "acquisition"), but "How much are you paying?" would not.
- **"Custom" flow handling is fragile:** The code jumps to `i+3` to find the user's actual rate after they click "Custom" - this assumes exactly one assistant follow-up message between "Custom" and the answer. Any deviation (e.g., a clarifying exchange) breaks it.
- **Phase 2 inline extraction** only activates if a message contains 2+ dollar values or contains "buy"/"feaso"/"feasibility" + a dollar sign. A message like "I want to do a quick feaso, the land is 10 million" with no $ symbol would be missed.
- **No validation on extracted values:** If extraction misparses (e.g., picking up a cost base figure as a purchase price), the wrong number silently flows through the entire calculation.

### 4.2 No Input Validation or Sanity Checks

The system will happily calculate a feasibility with:
- $0 GRV and $10M land (guaranteed loss, but no warning)
- $1B construction cost on a $500k project (clear input error)
- 0% interest rate with 80% LVR (possible but suspicious)
- 600-month timeline (50 years - likely an error)

There are no bounds checks or "did you mean...?" confirmations for outlier values.

### 4.3 Residual Land Value Convergence

**File:** `quick-feasibility-engine.js:350-360`

The residual calculation uses a fixed 8 iterations with no convergence check:

```javascript
for (let i = 0; i < 8; i++) {
  residualLandValue = grvExclGST - constructionWithContingency - ... - targetProfit;
}
```

- 8 iterations is likely sufficient for typical scenarios (the function should converge quickly since land-dependent costs are a small fraction of total)
- However, there's no convergence test - if inputs create an oscillating or diverging sequence, it silently returns the 8th iteration's value
- For edge cases (e.g., very high LVR + high interest rate), convergence may not occur in 8 iterations

### 4.4 Finance Cost Model Simplicity

**File:** `quick-feasibility-engine.js:307-312`

```javascript
const avgDebt = landDebt + (constructionDebt * 0.5);
const financeCosts = Math.round(avgDebt * interestDecimal * (timelineMonths / 12));
```

The code claims "S-curve draw" in comments but implements a simple 50% average draw for construction. Issues:
- Real construction draws follow an S-curve: slow start, rapid middle, slow finish
- A 50% average slightly underestimates true interest costs (typical S-curve average is ~55-60%)
- Land debt is assumed drawn for the **entire** timeline, including the selling period when units may be settling and land debt reducing
- No capitalisation of interest (interest-on-interest for projects > 12 months)

### 4.5 Dead/Duplicate Code Creates Maintenance Risk

- `feasibility-calculator.js` contains `calculateQuickFeasibility()` - an older, different feasibility engine that uses per-unit pricing, construction cost per sqm, and density codes. It appears **unused** by the main flow (superseded by `quick-feasibility-engine.js`), but `getDetailedFeasibilityPreFill()` from the same file IS used.
- `feasibility-input-parser.js` contains `parseMoneyValue`, `parsePercentage`, `parseConstructionCost` - all superseded by similar functions in `quick-feasibility-engine.js`.
- The old `feasibility-input-parser.js` has a dangerous `parseMoneyValue` implementation: `if (str.includes('b'))` would match any string containing the letter 'b' (e.g., "bought for $10m" would be parsed as $10 **billion**).

### 4.6 Tax Rate Staleness

All tax rates (stamp duty, land tax) are hardcoded with no version/date indicator. When QLD changes rates (which happens regularly), there's no mechanism to:
- Flag that rates may be stale
- Update rates without code changes
- Show users which year's rates are being applied

### 4.7 Target Margin Step Function

```javascript
return grvExclGST < 15_000_000 ? 15 : 20;
```

This creates a cliff edge at $15M GRV (exc GST):
- Project at $14.99M GRV → 15% target → labeled VIABLE at 15%
- Project at $15.01M GRV → 20% target → labeled MARGINAL at 15%

The same project economics would get wildly different viability labels depending on which side of the line GRV falls. A graduated scale would be more appropriate.

---

## 5. Improvement Suggestions

### 5.1 HIGH PRIORITY: Update QLD Land Tax Rates

Update both `quick-feasibility-engine.js:220-225` and `feasibility-calculator.js:58-63` to current QRO rates:

```javascript
function calculateLandTaxQLD(landValue) {
  if (landValue < 350000) return 0;
  if (landValue <= 2249999) return 1450 + (landValue - 350000) * 0.017;
  if (landValue <= 4999999) return 33750 + (landValue - 2250000) * 0.015;
  if (landValue <= 9999999) return 75000 + (landValue - 5000000) * 0.0225;
  return 187500 + (landValue - 10000000) * 0.0275;
}
```

### 5.2 HIGH PRIORITY: Consolidate Stamp Duty to Single Source

Eliminate the three separate implementations. Create one canonical `calculateStampDutyQLD()` function and import it everywhere. Use the correct version from `stamp-duty-calculator.js`:

```javascript
// Correct QLD transfer duty (investment/commercial)
if (value <= 5000) return 0;
if (value <= 75000) return (value - 5000) * 0.015;
if (value <= 540000) return 1050 + (value - 75000) * 0.035;
if (value <= 1000000) return 17325 + (value - 540000) * 0.045;
return 38025 + (value - 1000000) * 0.0575;
```

### 5.3 HIGH PRIORITY: Extract Tax Rates into Configuration

Move all tax rates into a versioned configuration file:

```javascript
// config/tax-rates.js
export const QLD_RATES = {
  version: '2025-26',
  effectiveFrom: '2025-07-01',
  transferDuty: { brackets: [...] },
  landTax: { company: { brackets: [...] } }
};
```

This enables:
- Easy annual updates
- Displaying rate version to users ("Rates as at 2025-26 FY")
- Auditing which rates are being used

### 5.4 MEDIUM PRIORITY: Add Input Validation

Add sanity checks before calculation:

```javascript
function validateInputs(inputs) {
  const warnings = [];
  if (inputs.grvTotal > 0 && inputs.landValue > inputs.grvTotal)
    warnings.push('Land value exceeds GRV - project will always be negative');
  if (inputs.constructionCost > inputs.grvTotal * 0.8)
    warnings.push('Construction exceeds 80% of GRV - unusual, please verify');
  if (inputs.timelineMonths > 60)
    warnings.push('Timeline exceeds 5 years - is this correct?');
  if (inputs.interestRate > 15)
    warnings.push('Interest rate above 15% - please verify');
  return warnings;
}
```

### 5.5 MEDIUM PRIORITY: Improve Residual Convergence

Add a convergence check and increase max iterations as safety:

```javascript
let prevResidual = 0;
for (let i = 0; i < 20; i++) {
  // ... existing calculation ...
  if (Math.abs(residualLandValue - prevResidual) < 100) break; // Converged within $100
  prevResidual = residualLandValue;
}
```

### 5.6 MEDIUM PRIORITY: Graduate Target Margin

Replace the step function with a graduated scale:

```javascript
function calculateTargetMargin(grvExclGST) {
  if (grvExclGST < 10_000_000) return 15;
  if (grvExclGST > 20_000_000) return 20;
  // Linear interpolation between $10M and $20M
  return 15 + ((grvExclGST - 10_000_000) / 10_000_000) * 5;
}
```

### 5.7 MEDIUM PRIORITY: Remove Dead Code

- Delete or clearly deprecate `feasibility-calculator.js`'s `calculateQuickFeasibility()` function (it's been superseded)
- Delete or clearly deprecate `feasibility-input-parser.js` (superseded by `quick-feasibility-engine.js` parsing)
- If `getDetailedFeasibilityPreFill()` is still needed, move it to the active engine file

### 5.8 LOW PRIORITY: Improve Finance Model

- Use a more realistic S-curve draw profile (55-60% average instead of 50%)
- Consider interest capitalisation for longer projects
- Model land debt reduction during settlement period
- Add option for mezzanine/preferred equity layers

### 5.9 LOW PRIORITY: Strengthen Conversation Extraction

- Add fuzzy matching for question detection (not just exact keyword matching)
- Add validation: if extracted value differs significantly from Claude's parsed value, log a warning
- Add a "confidence score" to extracted values
- Consider a structured form input flow as an alternative to free-text extraction

### 5.10 LOW PRIORITY: Dynamic Holding Costs

Replace hardcoded council/water rates with a lookup or estimate based on property value:

```javascript
const councilRatesAnnual = Math.max(3000, landValue * 0.0015); // ~0.15% of land value, min $3k
```

---

## 6. Summary Risk Matrix

| Issue | Severity | Likelihood | Financial Impact | Fix Effort |
|-------|----------|-----------|-----------------|------------|
| Outdated land tax rates | High | Every calculation | Up to $19k+ understatement | Low |
| Three stamp duty implementations | Medium | Every calculation | $75 overstatement | Low |
| No input validation | Medium | Occasional | Could produce nonsensical results | Low |
| Conversation extraction fragility | Medium | Occasional | Wrong inputs → wrong results | Medium |
| GST margin scheme simplification | Low | Edge cases | Variable | Medium |
| Finance model simplicity | Low | Every calculation | ~5-10% understatement of interest | Medium |
| Dead code maintenance risk | Low | Future changes | Confusion / wrong function called | Low |
| Target margin cliff edge | Low | Near $15M GRV | Misleading viability label | Low |
| Hardcoded holding costs | Low | Every calculation | Variable | Low |

---

## 7. Sources

- [QLD Transfer Duty Rates - Queensland Revenue Office](https://qro.qld.gov.au/duties/transfer-duty/calculate/rates/)
- [QLD Land Tax - Companies and Trusts](https://qro.qld.gov.au/land-tax/calculate/company-trust/)
- [Armstrong Legal - Transfer Duty QLD](https://www.armstronglegal.com.au/administrative-law/qld/stamp-duty/)
