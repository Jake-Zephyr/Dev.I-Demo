# Lovable: Feasibility Calculator Live-Fill Integration

> **Priority:** CRITICAL
> **Date:** 2026-02-08
> **Backend PR:** claude/review-feasibility-functions-qAtIm
> **Status:** Backend complete, frontend integration needed

---

## Overview

The backend now sends a `feasibilityPreFill` object in every `advise-stream` response during the Quick Feaso Q&A flow. This object is a **FeasoDraft** that progressively accumulates inputs as the user answers each question.

The frontend should use this data to **progressively fill the Detailed Feasibility Calculator panel** in real-time as the chat Q&A progresses.

---

## What Changed on the Backend

### 1. New `feasibilityPreFill` field in SSE responses

Every `complete` event from `/api/advise-stream` now includes an optional `feasibilityPreFill` field:

```json
{
  "type": "complete",
  "data": {
    "answer": "Got it - $1.2M purchase price. What's your target gross revenue (GRV)?",
    "buttonOptions": null,
    "questionContext": null,
    "usedTool": false,
    "feasibilityPreFill": {
      "conversationId": "abc123",
      "property": {
        "address": "51 Binya Avenue, COOLANGATTA",
        "lotPlan": "43RP93438",
        "siteAreaSqm": 508,
        "zone": "Medium density residential",
        "density": "RD3",
        "heightM": 9
      },
      "inputs": {
        "purchasePrice": 1200000,
        "grv": null,
        "constructionCost": null,
        "lvr": null,
        "interestRate": null,
        "timelineMonths": null,
        "sellingCostsPercent": null,
        "gstScheme": null,
        "gstCostBase": null
      },
      "rawInputs": {
        "purchasePriceRaw": "$1.2m",
        "grvRaw": null,
        "constructionCostRaw": null
      },
      "assumptions": {
        "contingencyPercent": 5,
        "profFeesPercent": 8,
        "statutoryFeesPercent": 2,
        "pmFeesPercent": 3,
        "agentFeesPercent": 1.5,
        "marketingPercent": 1.2,
        "legalSellingPercent": 0.3,
        "insurancePercent": 0.3,
        "interestRateDefault": 6.75,
        "loanLVRDefault": 65,
        "councilRatesAnnual": 5000,
        "waterRatesAnnual": 1400,
        "drawdownProfile": "linear",
        "targetDevMarginSmall": 15,
        "targetDevMarginLarge": 20
      },
      "holdingCosts": {
        "landTaxAnnual": 14900,
        "councilRatesAnnual": 5000,
        "waterRatesAnnual": 1400,
        "insuranceAnnual": 10500,
        "totalHoldingAnnual": 31800,
        "totalHoldingProject": 0
      },
      "timelineSplit": {
        "leadInMonths": 0,
        "constructionMonths": 0,
        "sellingMonths": 0
      },
      "status": "collecting",
      "results": null,
      "sourceMap": {
        "property.address": "property_tool",
        "inputs.purchasePrice": "chat",
        "assumptions.contingencyPercent": "default"
      }
    }
  }
}
```

**Key points:**
- `feasibilityPreFill` is `null` when NOT in a feasibility flow
- It progressively fills as the user answers each Q&A question
- `status` transitions: `"collecting"` → `"ready_to_calculate"` → `"calculated"`
- When `status === "calculated"`, `results` contains the full calculation output
- `sourceMap` tracks where each value came from: `"chat"`, `"panel"`, `"property_tool"`, `"default"`
- `holdingCosts` is auto-recalculated by the backend whenever `purchasePrice`, `constructionCost`, or `timelineMonths` changes
- `holdingCosts.landTaxAnnual` is computed from QLD land tax brackets based on the purchase price

### 2. New Backend API Endpoints

The backend now has these endpoints for direct draft management:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/feaso/draft?conversationId=X` | Get current draft (creates if needed) |
| `PATCH` | `/api/feaso/draft` | Update draft fields |
| `POST` | `/api/feaso/calc-detailed` | Run calculation from draft |
| `POST` | `/api/feaso/reset` | Reset draft for new property |
| `GET` | `/api/feaso/defaults` | Get default assumptions |

### 3. `conversationId` in requests

The frontend should now send a `conversationId` field in the `advise-stream` POST body:

```json
{
  "query": "$1.2m",
  "conversationHistory": [...],
  "conversationId": "project-1738929600000"
}
```

Use the current project/chat ID. This enables the backend to maintain a server-side draft per conversation.

---

## Frontend Changes Required

### Change 1: Send `conversationId` in advise-stream requests

**File:** `src/pages/Chat.tsx` (or wherever `sendMessage` is implemented)

In the fetch call to `/api/advise-stream`, add the `conversationId` field:

```typescript
const response = await fetch(`${API_BASE_URL}/api/advise-stream`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': API_KEY
  },
  body: JSON.stringify({
    query: message,
    conversationHistory: history,
    conversationId: activeProjectId  // ADD THIS
  })
});
```

### Change 2: Extract `feasibilityPreFill` from SSE responses

When processing the `complete` event from the SSE stream, extract the `feasibilityPreFill`:

```typescript
if (event.type === 'complete') {
  const response = event.data;

  // Extract pre-fill data for the calculator
  if (response.feasibilityPreFill) {
    setFeasibilityPreFill(response.feasibilityPreFill);
  }

  // ... existing response handling
}
```

### Change 3: Auto-open Feasibility Calculator when pre-fill appears

When `feasibilityPreFill` transitions from `null` to a non-null value, automatically open the Feasibility Calculator panel:

```typescript
useEffect(() => {
  if (feasibilityPreFill && feasibilityPreFill.status !== 'collecting') return;
  if (feasibilityPreFill && !isCalculatorOpen) {
    // Only auto-open when we first enter a feaso flow
    setIsCalculatorOpen(true);
  }
}, [feasibilityPreFill]);
```

### Change 4: Bind FeasibilityCalculator to `feasibilityPreFill`

The FeasibilityCalculator should accept the server draft and use it to populate fields:

```typescript
<FeasibilityCalculator
  messages={messages}
  preFill={feasibilityPreFill}  // Server-side draft
  onFieldChange={handleCalculatorFieldChange}
/>
```

**Inside FeasibilityCalculator:**

```typescript
useEffect(() => {
  if (!preFill) return;

  setInputs(prev => {
    const next = { ...prev };

    // Property fields (from server)
    if (preFill.property?.address && !prev.propertyAddress) {
      next.propertyAddress = preFill.property.address;
    }
    if (preFill.property?.siteAreaSqm && !prev.siteArea) {
      next.siteArea = String(preFill.property.siteAreaSqm);
    }
    if (preFill.property?.density && !prev.densityCode) {
      next.densityCode = preFill.property.density;
    }
    if (preFill.property?.heightM && !prev.heightLimit) {
      next.heightLimit = String(preFill.property.heightM);
    }

    // Required inputs (from chat Q&A)
    if (preFill.inputs?.purchasePrice && !prev.purchasePrice) {
      next.purchasePrice = String(preFill.inputs.purchasePrice);
      next.landValue = String(preFill.inputs.purchasePrice);
    }
    if (preFill.inputs?.grv && !prev.grvInclGST) {
      next.grvInclGST = String(preFill.inputs.grv);
    }
    if (preFill.inputs?.constructionCost && !prev.constructionCost) {
      next.constructionCost = String(preFill.inputs.constructionCost);
    }
    if (preFill.inputs?.lvr !== null && preFill.inputs?.lvr !== undefined && !prev.lvr) {
      next.lvr = String(preFill.inputs.lvr);
    }
    if (preFill.inputs?.interestRate && !prev.interestRate) {
      next.interestRate = String(preFill.inputs.interestRate);
    }
    if (preFill.inputs?.timelineMonths && !prev.totalMonths) {
      next.totalMonths = String(preFill.inputs.timelineMonths);
    }
    if (preFill.inputs?.sellingCostsPercent && !prev.agentFeesPercent) {
      next.agentFeesPercent = String(preFill.inputs.sellingCostsPercent);
    }
    if (preFill.inputs?.gstScheme && !prev.gstScheme) {
      next.gstScheme = preFill.inputs.gstScheme;
    }
    if (preFill.inputs?.gstCostBase && !prev.gstCostBase) {
      next.gstCostBase = String(preFill.inputs.gstCostBase);
    }

    // ======================================
    // Assumptions (defaults from server)
    // ALL of these should be populated into the detailed view
    // ======================================
    if (preFill.assumptions?.contingencyPercent !== undefined && !prev.contingencyPercent) {
      next.contingencyPercent = String(preFill.assumptions.contingencyPercent);
    }
    if (preFill.assumptions?.profFeesPercent !== undefined && !prev.profFeesPercent) {
      next.profFeesPercent = String(preFill.assumptions.profFeesPercent);
    }
    if (preFill.assumptions?.statutoryFeesPercent !== undefined && !prev.statutoryFeesPercent) {
      next.statutoryFeesPercent = String(preFill.assumptions.statutoryFeesPercent);
    }
    if (preFill.assumptions?.pmFeesPercent !== undefined && !prev.pmFeesPercent) {
      next.pmFeesPercent = String(preFill.assumptions.pmFeesPercent);
    }
    if (preFill.assumptions?.agentFeesPercent !== undefined && !prev.sellingAgentFeesPercent) {
      next.sellingAgentFeesPercent = String(preFill.assumptions.agentFeesPercent);
    }
    if (preFill.assumptions?.marketingPercent !== undefined && !prev.marketingPercent) {
      next.marketingPercent = String(preFill.assumptions.marketingPercent);
    }
    if (preFill.assumptions?.legalSellingPercent !== undefined && !prev.legalSellingPercent) {
      next.legalSellingPercent = String(preFill.assumptions.legalSellingPercent);
    }
    if (preFill.assumptions?.insurancePercent !== undefined && !prev.insurancePercent) {
      next.insurancePercent = String(preFill.assumptions.insurancePercent);
    }
    if (preFill.assumptions?.targetDevMarginSmall !== undefined && !prev.targetMarginSmall) {
      next.targetMarginSmall = String(preFill.assumptions.targetDevMarginSmall);
    }
    if (preFill.assumptions?.targetDevMarginLarge !== undefined && !prev.targetMarginLarge) {
      next.targetMarginLarge = String(preFill.assumptions.targetDevMarginLarge);
    }
    if (preFill.assumptions?.drawdownProfile && !prev.drawdownProfile) {
      next.drawdownProfile = preFill.assumptions.drawdownProfile;
    }

    // ======================================
    // Holding Costs (auto-calculated by backend)
    // These update as purchasePrice/constructionCost/timeline are provided
    // ======================================
    if (preFill.holdingCosts?.landTaxAnnual !== undefined) {
      next.landTaxAnnual = String(preFill.holdingCosts.landTaxAnnual);
    }
    if (preFill.holdingCosts?.councilRatesAnnual !== undefined) {
      next.councilRatesAnnual = String(preFill.holdingCosts.councilRatesAnnual);
    }
    if (preFill.holdingCosts?.waterRatesAnnual !== undefined) {
      next.waterRatesAnnual = String(preFill.holdingCosts.waterRatesAnnual);
    }
    if (preFill.holdingCosts?.insuranceAnnual !== undefined) {
      next.insuranceAnnual = String(preFill.holdingCosts.insuranceAnnual);
    }
    if (preFill.holdingCosts?.totalHoldingAnnual !== undefined) {
      next.totalHoldingAnnual = String(preFill.holdingCosts.totalHoldingAnnual);
    }
    if (preFill.holdingCosts?.totalHoldingProject !== undefined) {
      next.totalHoldingProject = String(preFill.holdingCosts.totalHoldingProject);
    }

    // ======================================
    // Timeline Split (auto-calculated by backend: 17% lead-in, 67% construction, remainder selling)
    // ======================================
    if (preFill.timelineSplit?.leadInMonths !== undefined) {
      next.leadInMonths = String(preFill.timelineSplit.leadInMonths);
    }
    if (preFill.timelineSplit?.constructionMonths !== undefined) {
      next.constructionMonths = String(preFill.timelineSplit.constructionMonths);
    }
    if (preFill.timelineSplit?.sellingMonths !== undefined) {
      next.sellingMonths = String(preFill.timelineSplit.sellingMonths);
    }

    return next;
  });

  // If results are available, show them
  if (preFill.results && preFill.status === 'calculated') {
    setCalculationResults(preFill.results);
  }
}, [preFill]);
```

**Critical rule: Only populate EMPTY fields.** If the user has manually edited a field in the panel, do NOT overwrite it.

### Change 5: Source badges

Display a small badge next to each field showing where the value came from:

```typescript
const getSourceBadge = (fieldPath: string) => {
  if (!preFill?.sourceMap) return null;
  const source = preFill.sourceMap[fieldPath];
  if (!source) return null;

  switch (source) {
    case 'chat': return <Badge variant="outline" className="text-xs">From chat</Badge>;
    case 'panel': return <Badge variant="outline" className="text-xs text-blue-600">Edited</Badge>;
    case 'property_tool': return <Badge variant="outline" className="text-xs text-green-600">Property data</Badge>;
    case 'default': return <Badge variant="outline" className="text-xs text-gray-400">Default</Badge>;
    default: return null;
  }
};

// Usage:
<div className="flex items-center gap-2">
  <Input value={inputs.purchasePrice} onChange={...} />
  {getSourceBadge('inputs.purchasePrice')}
</div>
```

### Change 6: Panel "Adjust Inputs" / "Recalculate" / "Download PDF" buttons

After results are shown:

```typescript
{preFill?.status === 'calculated' && (
  <div className="flex gap-2 mt-4">
    <Button variant="outline" onClick={() => setIsEditing(true)}>
      Adjust Inputs
    </Button>
    <Button onClick={handleRecalculate}>
      Recalculate
    </Button>
    <Button variant="outline" onClick={handleDownloadPDF}>
      Download PDF
    </Button>
  </div>
)}
```

**Recalculate handler:**
```typescript
const handleRecalculate = async () => {
  const response = await fetch(`${API_BASE_URL}/api/feaso/calc-detailed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify({ conversationId: activeProjectId })
  });
  const result = await response.json();
  if (result.draft) {
    setFeasibilityPreFill(result.draft);
  }
};
```

**Adjust Inputs handler:**
When the user edits a field in the panel, PATCH the backend:
```typescript
const handleCalculatorFieldChange = async (field: string, value: any) => {
  await fetch(`${API_BASE_URL}/api/feaso/draft`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify({
      conversationId: activeProjectId,
      patch: { inputs: { [field]: value } },
      source: 'panel'
    })
  });
};
```

### Change 7: Panel editability rules

| Status | Panel inputs | Assumptions |
|--------|-------------|-------------|
| `collecting` | **Read-only** (filled by chat) | Visible, collapsed |
| `ready_to_calculate` | **Read-only** | Visible, collapsed |
| `calculated` | **Editable** (after clicking "Adjust Inputs") | **Editable** |

During the chat wizard, inputs are read-only in the panel to prevent user edits from fighting with chat updates.

---

## Field Mapping Reference

| Chat Q&A Field | Draft Path | Calculator Field |
|----------------|-----------|-----------------|
| Purchase Price | `inputs.purchasePrice` | `purchasePrice` / `landValue` |
| GRV | `inputs.grv` | `grvInclGST` |
| Construction Cost | `inputs.constructionCost` | `constructionCost` |
| LVR | `inputs.lvr` | `lvr` |
| Interest Rate | `inputs.interestRate` | `interestRate` |
| Timeline | `inputs.timelineMonths` | `totalMonths` |
| Selling Costs | `inputs.sellingCostsPercent` | `agentFeesPercent` |
| GST Scheme | `inputs.gstScheme` | `gstScheme` |
| GST Cost Base | `inputs.gstCostBase` | `gstCostBase` |

## Assumptions Field Mapping

| Assumption | Draft Path | Calculator Field | Default |
|-----------|-----------|-----------------|---------|
| Contingency | `assumptions.contingencyPercent` | `contingencyPercent` | 5% |
| Prof Fees | `assumptions.profFeesPercent` | `profFeesPercent` | 8% |
| Statutory | `assumptions.statutoryFeesPercent` | `statutoryFeesPercent` | 2% |
| PM Fees | `assumptions.pmFeesPercent` | `pmFeesPercent` | 3% |
| Agent Fees | `assumptions.agentFeesPercent` | `sellingAgentFeesPercent` | 1.5% |
| Marketing | `assumptions.marketingPercent` | `marketingPercent` | 1.2% |
| Legal Selling | `assumptions.legalSellingPercent` | `legalSellingPercent` | 0.3% |
| Insurance | `assumptions.insurancePercent` | `insurancePercent` | 0.3% |
| Interest Rate | `assumptions.interestRateDefault` | `interestRate` | 6.75% |
| LVR Default | `assumptions.loanLVRDefault` | `lvr` | 65% |
| Drawdown Profile | `assumptions.drawdownProfile` | `drawdownProfile` | "linear" |
| Target Margin (< $15M) | `assumptions.targetDevMarginSmall` | `targetMarginSmall` | 15% |
| Target Margin (>= $15M) | `assumptions.targetDevMarginLarge` | `targetMarginLarge` | 20% |

## Holding Costs Field Mapping

These are **auto-calculated by the backend** whenever `purchasePrice`, `constructionCost`, or `timelineMonths` changes. They update progressively as the user provides inputs during the Q&A.

| Holding Cost | Draft Path | Calculator Field | How It's Calculated |
|-------------|-----------|-----------------|-------------------|
| Land Tax (annual) | `holdingCosts.landTaxAnnual` | `landTaxAnnual` | QLD tiered brackets based on purchasePrice |
| Council Rates (annual) | `holdingCosts.councilRatesAnnual` | `councilRatesAnnual` | Default $5,000/yr |
| Water Rates (annual) | `holdingCosts.waterRatesAnnual` | `waterRatesAnnual` | Default $1,400/yr |
| Insurance (annual) | `holdingCosts.insuranceAnnual` | `insuranceAnnual` | 0.3% of constructionCost/yr |
| Total Holding (annual) | `holdingCosts.totalHoldingAnnual` | `totalHoldingAnnual` | Sum of all above |
| Total Holding (project) | `holdingCosts.totalHoldingProject` | `totalHoldingProject` | Annual total prorated for timelineMonths |

**QLD Land Tax Brackets (2025-26):**
- $0 - $350,000: $0
- $350,001 - $2,250,000: $1,450 + 1.7% above $350k
- $2,250,001 - $5,000,000: $33,750 + 1.5% above $2.25M
- $5,000,001+: $75,000 + 2.0% above $5M

**Example:** Purchase price $1,200,000 → Land tax = $1,450 + ($850,000 x 0.017) = $15,900/yr

## Timeline Split Field Mapping

Auto-calculated by the backend when `timelineMonths` is provided. Uses the same split ratios as the quick feasibility engine.

| Phase | Draft Path | Calculator Field | Calculation |
|-------|-----------|-----------------|------------|
| Lead-in | `timelineSplit.leadInMonths` | `leadInMonths` | 17% of total |
| Construction | `timelineSplit.constructionMonths` | `constructionMonths` | 67% of total |
| Selling | `timelineSplit.sellingMonths` | `sellingMonths` | Remainder |

**Example:** 18 months total → Lead-in: 3, Construction: 12, Selling: 3

---

## Acceptance Criteria

1. Start quick feaso on a Gold Coast property
2. As each Q&A answer is given, the Feasibility Calculator panel fills progressively
3. Each field shows a "From chat" / "Property data" / "Default" badge
4. On the final answer (GST cost base), calculation runs automatically
5. Results appear in both the chat AND the calculator panel
6. Click "Adjust Inputs" → fields become editable
7. Change a value → click "Recalculate" → results update
8. Click "Download PDF" → PDF generated with correct values
9. **CRITICAL**: No stale data from previous properties appears
10. The address in results MATCHES the property being discussed
11. **ALL assumptions** (contingency, prof fees, statutory, PM, agent, marketing, legal, insurance, drawdown, target margins) are populated in the detailed view with their defaults
12. **ALL holding costs** (land tax, council rates, water rates, insurance) are populated and update as the user provides purchase price, construction cost, and timeline

---

## Quick Test

After implementing, test this exact flow:

1. Say "lets look at 51 Binya Avenue, COOLANGATTA"
2. Wait for property data
3. Say "run feaso for 4 townhouses"
4. Choose "Quick"
5. Enter: $1.2m → $7m → $3.5m → 80% → 8% → 12 → 3% → Margin scheme → Same as acquisition
6. Verify: Results show "51 Binya Avenue" (NOT "247 Hedges Avenue")
7. Verify: Land = $1,200,000, GRV = $7,000,000, Construction = $3,500,000
8. Verify: Calculator panel has ALL required inputs:
   - Purchase Price = 1,200,000
   - GRV = 7,000,000
   - Construction Cost = 3,500,000
   - LVR = 80%
   - Interest Rate = 8%
   - Timeline = 12 months
   - Selling Costs = 3%
   - GST Scheme = margin
   - GST Cost Base = 1,200,000
9. Verify: Calculator panel has ALL default assumptions populated:
   - Contingency = 5%
   - Prof Fees = 8%
   - Statutory Fees = 2%
   - PM Fees = 3%
   - Agent Fees = 1.5%
   - Marketing = 1.2%
   - Legal Selling = 0.3%
   - Insurance = 0.3%
   - Target Margin = 15% (GRV < $15M)
10. Verify: Calculator panel has holding costs populated:
    - Land Tax = ~$15,900/yr (auto-calculated from $1.2M)
    - Council Rates = $5,000/yr
    - Water Rates = $1,400/yr
    - Insurance = ~$10,500/yr (0.3% of $3.5M)
    - Total Holding Annual = ~$32,800/yr
    - Total Holding Project = ~$32,800 (12 months)
