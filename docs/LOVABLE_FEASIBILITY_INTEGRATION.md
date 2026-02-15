# Lovable: Feasibility Calculator Integration (v2)

> **Priority:** CRITICAL
> **Date:** 2026-02-15
> **Backend PR:** claude/perfect-feasibility-calculator-jZkcg
> **Status:** Backend complete, frontend changes needed

---

## What Changed (v2 — this PR)

### Summary of backend changes:
1. **Simplified Q&A flow** — reduced from 8 questions to 6 (max 7 if LVR > 0%)
2. **Selling costs removed from Q&A** — fixed at 3% (agent + marketing + legal), never asked
3. **Sell on completion** — selling period = 0 months, assumed by default
4. **LVR button options changed** — now `[0% (self funded)] [60%] [70%] [100% (fully funded)] [Other]`
5. **Conditional interest rate** — only asked if LVR > 0%. If LVR = 0%, interest rate auto-set to 0%
6. **Construction cost = lump sum** — user provides all-in cost exc GST (including prof fees, council fees, PM). Backend adds 5% contingency automatically
7. **New `calculatorFields` properties** — `sellOnCompletion: "true"`, `sellingMonths: "0"`, `sellingCostsPercent: "3"`
8. **Updated `feasibilityPreFill.inputs`** — `sellingCostsPercent` defaults to `3`, `sellOnCompletion` defaults to `true`

---

## New Q&A Flow (6-7 questions)

The backend now expects Claude to ask these questions in order:

| Step | Question | Button Options | Notes |
|------|----------|---------------|-------|
| 1 | Land acquisition cost | (text input) | |
| 2 | GRV inc GST | (text input) | |
| 3 | Construction costs exc GST | (text input) | Lump sum including prof fees, council, PM. Backend adds 5% contingency. |
| 4 | GST treatment | `[Margin scheme]` `[Fully taxed]` | If Margin: follow-up for cost base |
| 4b | Cost base (margin only) | `[Same as acquisition cost]` `[Different cost base]` | Only if margin scheme selected |
| 5 | Timeline | (text input, months) | |
| 6 | LVR | `[0% (self funded)]` `[60%]` `[70%]` `[100% (fully funded)]` `[Other]` | |
| 6b | Interest rate | `[7%]` `[8%]` `[9%]` `[10%]` `[Other]` | **ONLY asked if LVR > 0%** |

**Removed from Q&A:**
- Selling costs (fixed at 3%)
- Selling timeline (sell on completion, 0 months)

---

## Frontend Changes Required

### Change A: Update button options for LVR question

When Claude asks the LVR question, the frontend should render these buttons:
- `[0% (self funded)]` — maps to 0% LVR, interest rate skipped
- `[60%]` — standard LVR
- `[70%]` — standard LVR
- `[100% (fully funded)]` — 100% debt funded
- `[Other]` — user types custom value

The frontend already renders `[text]` patterns as buttons. No change needed to the button rendering logic — just verify the new options display correctly.

### Change B: Add "Sell on completion" checkbox to detailed calculator

The detailed calculator panel should have a **"Sell on completion" checkbox** (or toggle):
- **Default: checked/true**
- When checked: selling period = 0 months, selling months input is disabled/hidden
- When unchecked: show selling months input field

The `calculatorFields` from the backend now includes:
```json
{
  "sellOnCompletion": "true",
  "sellingMonths": "0"
}
```

Apply this to the form:
```typescript
if (response.calculatorFields) {
  // ... existing field mapping
  if (response.calculatorFields.sellOnCompletion === 'true') {
    setSellOnCompletion(true);
    setSellingMonths('0');
  }
}
```

### Change C: Selling costs display

Selling costs are now fixed at 3% and split into:
- Agent fees: 1.5%
- Marketing: 1.2%
- Legal selling: 0.3%
- **Total: 3.0%**

The `calculatorFields` now includes:
```json
{
  "sellingCostsPercent": "3",
  "sellingAgentFeesPercent": "1.5",
  "marketingPercent": "1.2",
  "legalSellingPercent": "0.3"
}
```

In the detailed calculator, these should be:
- Visible as a section (so user can see the breakdown)
- Editable in "Adjust Inputs" mode
- Defaulting to the 3% total (1.5% + 1.2% + 0.3%)

### Change D: Handle self-funded (0% LVR) display

When LVR is 0%, the formatted response shows:
```
• Finance: Self funded (no debt) | Timeline: 18 months
```

Instead of:
```
• LVR: 0% | Interest: 0% p.a. | Timeline: 18 months
```

The detailed calculator should display this cleanly:
- If LVR = 0: show "Self funded" label, disable/hide interest rate field
- If LVR > 0: show LVR and interest rate fields as normal

### Change E: Updated `calculatorFields` mapping

The `calculatorFields` object now has these additional/changed fields:

```json
{
  "sellingCostsPercent": "3",
  "sellOnCompletion": "true",
  "sellingMonths": "0",
  "sellingAgentFeesPercent": "1.5",
  "marketingPercent": "1.2",
  "legalSellingPercent": "0.3"
}
```

Full updated `calculatorFields` example:
```json
{
  "propertyAddress": "75 Dixon Street, Coolangatta",
  "siteArea": "592",
  "densityCode": "",
  "heightLimit": "9",
  "zone": "Township zone",
  "lotPlan": "1C28543",

  "purchasePrice": "1500000",
  "landValue": "1500000",
  "grvInclGST": "6000000",
  "constructionCost": "3000000",
  "lvr": "70",
  "interestRate": "8",
  "totalMonths": "18",
  "gstScheme": "margin",
  "gstCostBase": "1500000",

  "contingencyPercent": "5",
  "profFeesPercent": "8",
  "statutoryFeesPercent": "2",
  "pmFeesPercent": "3",
  "sellingCostsPercent": "3",
  "sellingAgentFeesPercent": "1.5",
  "marketingPercent": "1.2",
  "legalSellingPercent": "0.3",
  "sellOnCompletion": "true",
  "insurancePercent": "0.3",
  "drawdownProfile": "linear",
  "targetMarginSmall": "15",
  "targetMarginLarge": "20",
  "targetDevMargin": "15",

  "landTaxAnnual": "19550",
  "councilRatesAnnual": "5000",
  "waterRatesAnnual": "1400",
  "insuranceAnnual": "9450",
  "totalHoldingAnnual": "35400",
  "totalHoldingProject": "53100",

  "leadInMonths": "4",
  "constructionMonths": "14",
  "sellingMonths": "0",

  "loanFee": "10500",
  "financeCosts": "157500"
}
```

### Change F: Updated `feasibilityPreFill.inputs` defaults

The draft `inputs` object now defaults:
```json
{
  "purchasePrice": null,
  "grv": null,
  "constructionCost": null,
  "lvr": null,
  "interestRate": null,
  "timelineMonths": null,
  "sellingCostsPercent": 3,
  "sellOnCompletion": true,
  "gstScheme": null,
  "gstCostBase": null
}
```

Note: `sellingCostsPercent` is no longer `null` — it defaults to `3`. And `sellOnCompletion` is a new boolean field defaulting to `true`.

The assumptions object also has two new fields:
```json
{
  "sellingCostsPercent": 3,
  "sellOnCompletion": true,
  "...existing fields..."
}
```

---

## Unchanged from v1

Everything else from the previous integration doc remains the same:
- `feasibilityPreFill` structure (draft-driven progressive fill)
- `calculatorFields` as authoritative override on calculation complete
- `conversationId` in advise-stream requests
- SSE response handling
- Auto-open calculator panel
- Source badges
- Adjust Inputs / Recalculate / Download PDF buttons
- Panel editability rules
- Backend API endpoints (`/api/feaso/draft`, `/api/feaso/calc-detailed`, etc.)
- Holding costs auto-calculation

---

## Updated Field Mapping Reference

| Chat Q&A Field | Draft Path | Calculator Field | Asked? |
|----------------|-----------|-----------------|--------|
| Purchase Price | `inputs.purchasePrice` | `purchasePrice` / `landValue` | Yes |
| GRV (inc GST) | `inputs.grv` | `grvInclGST` | Yes |
| Construction Cost | `inputs.constructionCost` | `constructionCost` | Yes |
| GST Scheme | `inputs.gstScheme` | `gstScheme` | Yes |
| GST Cost Base | `inputs.gstCostBase` | `gstCostBase` | Yes (if margin) |
| Timeline | `inputs.timelineMonths` | `totalMonths` | Yes |
| LVR | `inputs.lvr` | `lvr` | Yes |
| Interest Rate | `inputs.interestRate` | `interestRate` | Only if LVR > 0% |
| Selling Costs | `inputs.sellingCostsPercent` | `sellingCostsPercent` | **No — fixed 3%** |
| Sell on Completion | `inputs.sellOnCompletion` | `sellOnCompletion` | **No — default true** |

---

## Updated Acceptance Criteria

1. Start quick feaso on a Gold Coast property
2. Claude asks **6 questions** (not 8) — no selling costs, no selling timeline
3. If LVR = 0% (self funded), Claude **skips** interest rate question
4. If LVR > 0%, Claude asks interest rate with `[7%] [8%] [9%] [10%] [Other]`
5. Results show "Sell on completion (0 month selling period)" in assumptions
6. Results show "Selling Costs: 3%" without ever asking
7. Detailed calculator panel shows sell on completion checkbox = checked
8. Detailed calculator panel shows selling months = 0
9. Detailed calculator panel shows selling costs breakdown (1.5% + 1.2% + 0.3% = 3%)
10. Self funded projects show "Self funded (no debt)" instead of "LVR: 0% | Interest: 0%"
11. All other acceptance criteria from v1 still pass

---

## Updated Quick Test

1. Say "lets look at 51 Binya Avenue, COOLANGATTA"
2. Wait for property data
3. Say "run a quick feaso"
4. Enter: $1.2m (land) → $7m (GRV) → $3.5m (construction) → Margin scheme → Same as acquisition → 18 months → 60% → 8%
5. Verify: Results show correct values
6. Verify: "Sell on completion (0 month selling period)" in assumptions
7. Verify: "Selling Costs: 3%" shown without being asked
8. Verify: Calculator panel has sellOnCompletion = true, sellingMonths = 0

**Self-funded test:**
1. Run another feaso
2. Enter: $2m → $10m → $5m → Fully taxed → 24 months → 0% (self funded)
3. Verify: Interest rate question is **NOT asked**
4. Verify: Results show "Self funded (no debt)" not "LVR: 0% | Interest: 0%"
5. Verify: Finance costs = $0
