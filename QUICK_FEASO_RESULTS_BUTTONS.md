# Quick Feasibility Results - Button Requirements

## Overview
When quick feasibility calculation completes, the results page should display two action buttons at the bottom.

## Button 1: "Adjust Inputs/Assumptions"

### Behavior
- Clicking this button should allow the user to modify any of the quick feasibility inputs
- Re-runs the calculation with the new values
- Preserves the property context (address, site area, planning controls)

### Implementation Options

**Option A: Modal/Dialog**
- Opens a modal with input fields for all feasibility parameters
- Shows current values pre-filled
- "Recalculate" button to submit changes

**Option B: Inline Editing**
- Makes the input values clickable/editable in place
- Shows an "Update" button when changes are detected

**Option C: Restart Flow**
- Sends a message to Dev.i: "Adjust inputs"
- Dev.i asks which input to change
- User responds, calculation re-runs

**Recommended: Option C** - Most consistent with chat interface, requires no new UI components

## Button 2: "Download as PDF"

### Behavior
- Generates a PDF report of the quick feasibility results
- Uses the same PDF generator as the detailed calculator
- Should include all sections: Revenue, Costs, Profitability, Assumptions

### Backend Data Structure

When the backend returns quick feasibility results, it includes a `calculatorPreFill` object:

```javascript
{
  answer: "Quick Feasibility Results...",
  feasibilityData: {
    success: true,
    feasibilityMode: 'results',

    // THIS OBJECT contains all data for PDF generation
    calculatorPreFill: {
      // Property
      property: "9 Hawaii Avenue, Palm Beach",
      siteArea: 1394,
      densityCode: "RD8",
      heightLimit: "9m",

      // Project
      numUnits: 1,
      unitMix: "1 units",
      saleableArea: 1,

      // Revenue
      grvInclGST: 8000000,

      // Acquisition
      landValue: 2000000,
      gstScheme: "margin",
      gstCostBase: 2000000,

      // Construction
      buildCosts: 3500000,
      contingencyPercent: 0,
      professionalFees: 0,
      statutoryFees: 0,
      pmFees: 0,

      // Holding
      landTaxYearly: 14950,
      councilRatesAnnual: 5000,
      waterRatesAnnual: 1400,

      // Selling
      agentFeesPercent: 1.5,
      marketingPercent: 1.2,
      legalSellingPercent: 0.3,

      // Finance
      lvr: 70,
      interestRate: 8,

      // Timeline
      totalMonths: 13,
      leadInMonths: 2,
      constructionMonths: 9,
      sellingMonths: 2,

      // Target
      targetMargin: 15
    },

    // Summary results
    revenue: {
      grvInclGST: 8000000,
      grvExclGST: 7727273,
      gstPayable: 272727,
      avgPricePerUnit: 8000000
    },

    costs: {
      land: 2000000,
      construction: 3500000,
      selling: 193182,
      finance: 219158,
      holding: 21142,
      total: 5933482
    },

    profitability: {
      grossProfit: 1793791,
      profitMargin: 23.2,
      targetMargin: 15,
      meetsTarget: true,
      viability: "viable"
    },

    residual: {
      residualLandValue: 2631061,
      vsActualLand: 631061
    }
  }
}
```

### PDF Generation Implementation

**Step 1: Extract calculatorPreFill**
```typescript
const calculatorData = response.feasibilityData?.calculatorPreFill;
if (!calculatorData) {
  console.error('No calculator data available for PDF');
  return;
}
```

**Step 2: Call Existing PDF Generator**
You should already have a PDF generator for the detailed calculator. Reuse that same function:

```typescript
// Assuming you have this function from detailed calculator
import { generateFeasibilityPDF } from './pdf-generator';

function handleDownloadPDF(feasibilityData) {
  const pdfData = {
    ...feasibilityData.calculatorPreFill,
    // Add computed results
    results: {
      revenue: feasibilityData.revenue,
      costs: feasibilityData.costs,
      profitability: feasibilityData.profitability,
      residual: feasibilityData.residual
    }
  };

  generateFeasibilityPDF(pdfData);
}
```

**Step 3: PDF Content Sections**

The PDF should include:

1. **Header**
   - Property address
   - Site area, zone, density, height limit
   - Date generated

2. **Project Summary**
   - Unit mix: X units
   - Total GRV: $X.XM (inc GST)
   - Construction cost: $X.XM
   - Timeline: X months

3. **Revenue Breakdown** *(Including GST)*
   - Gross Revenue (inc GST): $X.XM
   - GST Payable: $X.XM
   - Net Revenue (exc GST): $X.XM

4. **Cost Breakdown** *(Excluding GST)*
   - Land acquisition: $X.XM
   - Construction: $X.XM
   - Selling costs (X%): $X.XM
   - Finance costs: $X.XM
   - Holding costs: $X.XM
   - **Total Costs: $X.XM**

5. **Profitability**
   - Gross Profit: $X.XM
   - Profit Margin: XX.X%
   - Target Margin: XX%
   - Status: VIABLE/MARGINAL/CHALLENGING/NOT VIABLE

6. **Residual Land Value Analysis**
   - Maximum land value at target margin: $X.XM
   - Actual land cost: $X.XM
   - Difference: $X.XM over/under

7. **Assumptions**
   - Contingency: Included in construction / Added 5%
   - Finance draw profile: 50% average outstanding
   - Land tax: $X/year
   - Council rates: $X/year
   - Water rates: $X/year
   - GST treatment: Margin scheme / Fully taxed
   - Target margin basis: GRV under $15M → 15% / GRV $15M+ → 20%

8. **Disclaimer**
   - "This is a preliminary feasibility analysis based on inputs provided. Actual costs and revenue may vary. Consult with qualified professionals before making investment decisions."

### Styling Notes

**Button Styling:**
```css
.feasibility-actions {
  display: flex;
  gap: 12px;
  margin-top: 24px;
  padding-top: 24px;
  border-top: 1px solid #e5e7eb;
}

.btn-adjust-inputs {
  flex: 1;
  padding: 12px 24px;
  background: white;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  font-weight: 500;
  cursor: pointer;
}

.btn-download-pdf {
  flex: 1;
  padding: 12px 24px;
  background: #3b82f6;
  color: white;
  border: none;
  border-radius: 8px;
  font-weight: 500;
  cursor: pointer;
}
```

## Testing Scenarios

### Test 1: Adjust Inputs
1. Complete a quick feasibility
2. Click "Adjust Inputs/Assumptions"
3. Change LVR from 70% to 80%
4. Verify results update correctly

### Test 2: Download PDF
1. Complete a quick feasibility
2. Click "Download as PDF"
3. Verify PDF contains all sections listed above
4. Verify numbers match the screen results exactly

### Test 3: calculatorPreFill Integration
1. Complete a quick feasibility
2. Click "Open in detailed calculator" (if this button exists)
3. Verify all form fields are pre-filled with correct values
4. Verify the PDF from detailed view matches quick feasibility PDF

## Questions for Frontend Team

1. Do you already have a PDF generator for the detailed calculator?
2. If yes, what format does it expect data in?
3. If no, do you want a recommendation for a PDF library (e.g., jsPDF, pdfmake)?
4. Where should the "Adjust Inputs" button send the user? (Chat, modal, or dedicated edit page?)

## Backend Support

The backend is ready and returns all required data in the `calculatorPreFill` object. No backend changes needed for this feature.
