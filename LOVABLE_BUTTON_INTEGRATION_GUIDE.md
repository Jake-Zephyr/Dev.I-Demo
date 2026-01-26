# Quick Feasibility Integration Guide

## Overview

The backend returns structured data to support:
1. Clickable button options for multiple-choice questions
2. Pre-filling the detailed calculator form with quick feasibility results
3. PDF generation from quick feasibility data

This guide explains how to implement these features in the frontend.

## Backend Changes

The backend (`services/claude.js`) now detects button options in Claude's responses and returns them in a structured format:

```javascript
{
  answer: "LVR (Loan to Value Ratio)? [60%] [70%] [80%] [Fully funded]",
  buttonOptions: ["60%", "70%", "80%", "Fully funded"],
  questionContext: {
    type: "lvr",
    label: "LVR (Loan to Value Ratio)",
    needsCustomInput: false
  },
  // ... other fields
}
```

## Button Detection Logic

The backend automatically detects button patterns like `[Option 1] [Option 2]` in Claude's responses and extracts them into the `buttonOptions` array.

### Question Types Detected

| Question Type | `questionContext.type` | Example Buttons | Notes |
|---------------|----------------------|-----------------|-------|
| **LVR** | `lvr` | `["60%", "70%", "80%", "Fully funded"]` | No custom input needed |
| **Interest Rate** | `interest_rate` | `["6.5%", "7.0%", "7.5%", "Custom"]` | Shows text input if "Custom" selected |
| **Selling Costs** | `selling_costs` | `["3%", "4%", "Custom"]` | Shows text input if "Custom" selected |
| **GST Scheme** | `gst_scheme` | `["Margin scheme", "Fully taxed"]` | Shows follow-up if "Margin scheme" selected |
| **GST Cost Base** | `gst_cost_base` | `["Same as acquisition cost", "Different cost base"]` | Shows text input if "Different cost base" selected |
| **Project Type** | `project_type` | `["New build", "Knockdown rebuild", "Renovation"]` | No custom input needed |

## Frontend Implementation

### 1. Detect Button Options in Response

When you receive a response from the backend, check if `buttonOptions` exists:

```typescript
interface ClaudeResponse {
  answer: string;
  buttonOptions?: string[] | null;
  questionContext?: {
    type: string;
    label: string;
    needsCustomInput?: boolean;
    needsFollowUp?: boolean;
  } | null;
  // ... other fields
}
```

### 2. Render Buttons

When `buttonOptions` is present, render clickable buttons instead of (or alongside) the text:

```tsx
// Example React component
function ChatMessage({ response }: { response: ClaudeResponse }) {
  const [showCustomInput, setShowCustomInput] = useState(false);

  return (
    <div className="message">
      {/* Show the question text */}
      <p>{response.answer}</p>

      {/* Render buttons if available */}
      {response.buttonOptions && (
        <div className="button-group">
          {response.buttonOptions.map((option) => (
            <button
              key={option}
              onClick={() => handleButtonClick(option, response.questionContext)}
              className="option-button"
            >
              {option}
            </button>
          ))}
        </div>
      )}

      {/* Show custom input if needed */}
      {showCustomInput && (
        <input
          type="text"
          placeholder="Enter custom value..."
          onKeyPress={(e) => {
            if (e.key === 'Enter') {
              handleCustomInput(e.target.value);
            }
          }}
        />
      )}
    </div>
  );
}
```

### 3. Handle Button Clicks

When a button is clicked:

1. **For standard options**: Send the selected value as the user's message
2. **For "Custom" option**: Show a text input field
3. **For "Margin scheme"**: Wait for cost base follow-up question

```typescript
function handleButtonClick(
  selectedOption: string,
  context: QuestionContext | null
) {
  // Check if this requires custom input
  if (selectedOption.toLowerCase() === 'custom') {
    setShowCustomInput(true);
    return;
  }

  // For "Margin scheme", expect a follow-up question for cost base
  // Just send the selection and wait for Claude to ask about cost base
  if (selectedOption.toLowerCase().includes('margin')) {
    sendMessage(selectedOption);
    // Backend will automatically ask: "What is the project's cost base for Margin Scheme purposes?"
    return;
  }

  // Standard option - send it as user's response
  sendMessage(selectedOption);
}
```

### 4. Custom Input Handling

When user selects "Custom" and enters a value:

```typescript
function handleCustomInput(value: string) {
  // Send the custom value as the user's message
  sendMessage(value);
  setShowCustomInput(false);
}
```

## Example Flow

### LVR Question

**Backend Response:**
```json
{
  "answer": "LVR (Loan to Value Ratio)? [60%] [70%] [80%] [Fully funded]",
  "buttonOptions": ["60%", "70%", "80%", "Fully funded"],
  "questionContext": {
    "type": "lvr",
    "label": "LVR (Loan to Value Ratio)"
  }
}
```

**Frontend Display:**
```
Dev.i: LVR (Loan to Value Ratio)?

[ 60% ]  [ 70% ]  [ 80% ]  [ Fully funded ]
```

**User clicks "Fully funded"**

**Frontend sends:** `"Fully funded"`

---

### Interest Rate Question

**Backend Response:**
```json
{
  "answer": "Interest rate? [6.5%] [7.0%] [7.5%] [Custom]",
  "buttonOptions": ["6.5%", "7.0%", "7.5%", "Custom"],
  "questionContext": {
    "type": "interest_rate",
    "label": "Interest Rate",
    "needsCustomInput": true
  }
}
```

**Frontend Display:**
```
Dev.i: Interest rate?

[ 6.5% ]  [ 7.0% ]  [ 7.5% ]  [ Custom ]
```

**If user clicks "Custom":**
```
Dev.i: Interest rate?

[ 6.5% ]  [ 7.0% ]  [ 7.5% ]  [ Custom ]

Enter custom rate: [_________]
```

**User types "8.25" and presses Enter**

**Frontend sends:** `"8.25"`

---

### GST Scheme Question with Follow-up

**Backend Response:**
```json
{
  "answer": "GST treatment? [Margin scheme] [Fully taxed]",
  "buttonOptions": ["Margin scheme", "Fully taxed"],
  "questionContext": {
    "type": "gst_scheme",
    "label": "GST Treatment",
    "needsFollowUp": true
  }
}
```

**Frontend Display:**
```
Dev.i: GST treatment?

[ Margin scheme ]  [ Fully taxed ]
```

**User clicks "Margin scheme"**

**Frontend sends:** `"Margin scheme"`

**Backend automatically responds:**
```json
{
  "answer": "What is the project's cost base for Margin Scheme purposes?"
}
```

**Frontend shows text input for user to type cost base:**
```
Dev.i: What is the project's cost base for Margin Scheme purposes?

You: [_________]
```

**User types "12m" or "$12,000,000"**

---

## Styling Recommendations

### Button Styles

```css
.button-group {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
  margin-bottom: 12px;
}

.option-button {
  padding: 10px 20px;
  border: 2px solid #e5e7eb;
  border-radius: 8px;
  background: white;
  color: #374151;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.option-button:hover {
  border-color: #3b82f6;
  background: #eff6ff;
  color: #1d4ed8;
}

.option-button:active {
  transform: scale(0.98);
}
```

### Mobile Responsive

```css
@media (max-width: 640px) {
  .button-group {
    flex-direction: column;
  }

  .option-button {
    width: 100%;
  }
}
```

## Testing

### Test Scenarios

1. **LVR Selection**
   - Click each LVR button option
   - Verify value is sent correctly

2. **Interest Rate with Custom**
   - Click "6.5%" → should send "6.5%"
   - Click "Custom" → should show text input
   - Type "8.25" → should send "8.25"

3. **Margin Scheme Flow**
   - Click "Margin scheme" → should send "Margin scheme"
   - Backend asks for cost base → user types value
   - Both values are captured correctly

4. **Fallback to Text Input**
   - If `buttonOptions` is null, show normal text input
   - User can still type responses manually

## Key Points

✅ **Always show button options when `buttonOptions` is present**
✅ **Send the exact button text as the user's message** (e.g., "Fully funded", not "100%")
✅ **Handle "Custom" option by showing text input**
✅ **For "Margin scheme", expect automatic follow-up question from backend**
✅ **Allow users to type manually if they prefer** (don't force buttons)
✅ **Mobile-friendly button layout** (stack vertically on small screens)

## Backwards Compatibility

The backend changes are backwards compatible:

- If frontend doesn't implement buttons, users can still type responses
- `buttonOptions` field is optional (null when no buttons detected)
- Existing text-based flow continues to work

## Questions?

If you have questions about implementation, check:

1. The backend code in `services/claude.js` (functions `parseButtonOptions` and `detectQuestionContext`)
2. The system prompt showing button format (search for "CRITICAL - BUTTON FORMAT RULES")
3. Example responses in this guide

---

**Implementation Priority:** HIGH
**Estimated Effort:** 2-4 hours
**Impact:** Significantly improves UX for quick feasibility flow

---

## Part 2: Calculator Pre-Fill Integration

### Overview

When quick feasibility completes, the backend returns a `calculatorPreFill` object that contains all the data needed to:
1. Pre-fill the detailed calculator form
2. Generate a PDF report  
3. Allow users to adjust inputs and re-calculate

### Backend Response Structure

When the `calculate_quick_feasibility` tool completes, the response includes:

```typescript
interface QuickFeasibilityResponse {
  answer: string;  // Human-readable results summary
  feasibilityData: {
    success: true;
    feasibilityMode: 'results';
    
    // THIS IS THE KEY OBJECT - Use it to pre-fill the detailed form
    calculatorPreFill: {
      // Property (from property lookup)
      property: string;          // e.g. "9 Hawaii Avenue, Palm Beach"
      siteArea: number;           // e.g. 1394 (sqm)
      densityCode: string;        // e.g. "RD8"
      heightLimit: string;        // e.g. "9m"
      
      // Project (from user input)
      numUnits: number;           // e.g. 1 (or actual unit count if provided)
      unitMix: string;            // e.g. "1 units" or "50 x 250sqm + 9 x 400sqm"
      saleableArea: number;       // e.g. 1 (or actual saleable area)
      
      // Revenue
      grvInclGST: number;         // e.g. 8000000 ($8M)
      
      // Acquisition
      landValue: number;          // e.g. 2000000 ($2M)
      gstScheme: string;          // "margin" or "fully_taxed"
      gstCostBase: number;        // e.g. 2000000 (if margin scheme)
      
      // Construction
      buildCosts: number;         // e.g. 3500000
      contingencyPercent: number; // e.g. 0 or 5
      professionalFees: number;   // e.g. 0
      statutoryFees: number;      // e.g. 0
      pmFees: number;             // e.g. 0
      
      // Holding
      landTaxYearly: number;      // e.g. 14950
      councilRatesAnnual: number; // e.g. 5000
      waterRatesAnnual: number;   // e.g. 1400
      
      // Selling
      agentFeesPercent: number;   // e.g. 1.5
      marketingPercent: number;   // e.g. 1.2
      legalSellingPercent: number;// e.g. 0.3
      
      // Finance
      lvr: number;                // e.g. 70 (percent)
      interestRate: number;       // e.g. 8 (percent)
      
      // Timeline
      totalMonths: number;        // e.g. 13
      leadInMonths: number;       // e.g. 2
      constructionMonths: number; // e.g. 9
      sellingMonths: number;      // e.g. 2
      
      // Target
      targetMargin: number;       // e.g. 15 (percent)
    };
    
    // Summary results (for display)
    revenue: {...};
    costs: {...};
    profitability: {...};
    residual: {...};
  };
}
```

### Implementation: Pre-Fill Detailed Calculator

When the user clicks "Fill from chat" or navigates to the detailed calculator after completing quick feasibility:

**Step 1: Extract calculatorPreFill from last feasibility result**

```typescript
// Find the most recent feasibility response in chat history
const lastFeasibility = chatHistory
  .reverse()
  .find(msg => msg.feasibilityData?.calculatorPreFill);

const preFillData = lastFeasibility?.feasibilityData?.calculatorPreFill;

if (!preFillData) {
  console.error('No quick feasibility data found to pre-fill');
  return;
}
```

**Step 2: Map calculatorPreFill to form fields**

```typescript
// Assuming you have a form state object
function fillFormFromQuickFeasibility(preFillData: CalculatorPreFill) {
  setFormData({
    // Property tab
    propertyAddress: preFillData.property,
    siteAreaSqm: preFillData.siteArea,
    densityCode: preFillData.densityCode,
    heightLimit: preFillData.heightLimit,
    
    // Project tab
    numberOfUnits: preFillData.numUnits,
    unitMixDescription: preFillData.unitMix,
    totalSaleableAreaSqm: preFillData.saleableArea,
    
    // Revenue tab
    grossRevenueInclGST: preFillData.grvInclGST,
    
    // Acquisition tab
    landPurchasePrice: preFillData.landValue,
    gstTreatment: preFillData.gstScheme === 'margin' ? 'Margin Scheme' : 'Fully Taxed',
    gstCostBase: preFillData.gstCostBase,
    
    // Construction tab
    baseBuildCosts: preFillData.buildCosts,
    contingencyPercentage: preFillData.contingencyPercent,
    professionalFeesTotal: preFillData.professionalFees,
    statutoryFeesTotal: preFillData.statutoryFees,
    projectManagementFees: preFillData.pmFees,
    
    // Holding costs tab
    landTaxPerYear: preFillData.landTaxYearly,
    councilRatesPerYear: preFillData.councilRatesAnnual,
    waterRatesPerYear: preFillData.waterRatesAnnual,
    
    // Selling costs tab
    agentFeesPercent: preFillData.agentFeesPercent,
    marketingCostsPercent: preFillData.marketingPercent,
    legalFeesPercent: preFillData.legalSellingPercent,
    
    // Finance tab
    loanToValueRatio: preFillData.lvr,
    interestRatePercent: preFillData.interestRate,
    
    // Timeline tab
    totalProjectMonths: preFillData.totalMonths,
    leadInPhaseMonths: preFillData.leadInMonths,
    constructionPhaseMonths: preFillData.constructionMonths,
    sellingPhaseMonths: preFillData.sellingMonths,
    
    // Target tab
    targetProfitMarginPercent: preFillData.targetMargin
  });
}
```

**Step 3: Handle missing/default values**

Some fields may be `0` or empty if not provided during quick feasibility:

```typescript
function fillFormFromQuickFeasibility(preFillData: CalculatorPreFill) {
  setFormData({
    // ... other fields
    
    // Only set if non-zero
    professionalFeesTotal: preFillData.professionalFees || null,
    statutoryFeesTotal: preFillData.statutoryFees || null,
    projectManagementFees: preFillData.pmFees || null,
    
    // For quick feaso with total GRV (not per-unit), these might be 1
    // Check if they're placeholder values
    numberOfUnits: preFillData.numUnits === 1 ? null : preFillData.numUnits,
    totalSaleableAreaSqm: preFillData.saleableArea === 1 ? null : preFillData.saleableArea,
  });
}
```

### Common Issues and Solutions

#### Issue 1: Form fields not updating

**Problem:** `calculatorPreFill` is in the response but form stays empty

**Solution:** Check your form state management:
```typescript
// BAD - state not updating
const [formData, setFormData] = useState(initialData);
setFormData(newData);  // Might not trigger re-render if object reference same

// GOOD - force new object reference
setFormData({ ...newData });  // Spread creates new object
```

#### Issue 2: Number formatting

**Problem:** Values like `2000000` showing as "2000000" instead of "$2M" or formatted

**Solution:** Format numbers for display:
```typescript
function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

// Display: formatCurrency(preFillData.landValue) → "$2,000,000"
```

#### Issue 3: GST scheme mapping

**Problem:** Backend returns `"margin"` but form expects `"Margin Scheme"`

**Solution:** Map the values:
```typescript
const gstSchemeMap = {
  'margin': 'Margin Scheme',
  'fully_taxed': 'Fully Taxed'
};

const gstSchemeDisplay = gstSchemeMap[preFillData.gstScheme] || 'Margin Scheme';
```

### Testing Checklist

Use this checklist to verify calculator pre-fill is working:

- [ ] Complete a quick feasibility with total GRV (e.g., "$8M")
- [ ] Click "Fill from chat" or navigate to detailed calculator
- [ ] Verify **Property** fields filled: address, site area, density, height
- [ ] Verify **Revenue** field filled: GRV = $8M
- [ ] Verify **Acquisition** fields filled: land value, GST scheme, cost base
- [ ] Verify **Construction** field filled: total construction cost
- [ ] Verify **Finance** fields filled: LVR, interest rate
- [ ] Verify **Timeline** fields filled: total months, phases
- [ ] Verify **Selling costs** fields filled: percentages
- [ ] Verify **Holding costs** fields filled: land tax, council rates, water rates
- [ ] Generate PDF from detailed view - verify all values match quick feasibility
- [ ] Modify one value in detailed view, recalculate - verify it updates correctly

### Debugging

If pre-fill isn't working, add logging:

```typescript
console.log('[PREFILL] Searching for quick feasibility data...');
console.log('[PREFILL] Chat history length:', chatHistory.length);

const lastFeasibility = chatHistory
  .reverse()
  .find(msg => msg.feasibilityData?.calculatorPreFill);

console.log('[PREFILL] Found feasibility:', !!lastFeasibility);
console.log('[PREFILL] calculatorPreFill:', lastFeasibility?.feasibilityData?.calculatorPreFill);

if (lastFeasibility) {
  const data = lastFeasibility.feasibilityData.calculatorPreFill;
  console.log('[PREFILL] Land value:', data.landValue);
  console.log('[PREFILL] GRV:', data.grvInclGST);
  console.log('[PREFILL] Construction:', data.buildCosts);
}
```

Then check the browser console when clicking "Fill from chat".

### Example: Complete Integration

```typescript
import { useState, useEffect } from 'react';

function DetailedCalculator({ chatHistory }) {
  const [formData, setFormData] = useState(null);
  const [preFilled, setPreFilled] = useState(false);

  // Auto-fill on mount if quick feasibility exists
  useEffect(() => {
    fillFromQuickFeasibility();
  }, []);

  function fillFromQuickFeasibility() {
    // Find last quick feasibility result
    const lastFeaso = chatHistory
      .slice()
      .reverse()
      .find(msg => msg.feasibilityData?.calculatorPreFill);

    if (!lastFeaso) {
      console.log('No quick feasibility data to pre-fill');
      return;
    }

    const data = lastFeaso.feasibilityData.calculatorPreFill;
    
    setFormData({
      property: data.property,
      siteArea: data.siteArea,
      landValue: data.landValue,
      grv: data.grvInclGST,
      construction: data.buildCosts,
      lvr: data.lvr,
      interestRate: data.interestRate,
      timeline: data.totalMonths,
      gstScheme: data.gstScheme === 'margin' ? 'Margin Scheme' : 'Fully Taxed',
      gstCostBase: data.gstCostBase,
      // ... all other fields
    });

    setPreFilled(true);
    
    console.log('[CALCULATOR] Pre-filled from quick feasibility:', data.property);
  }

  return (
    <div>
      {preFilled && (
        <div className="prefill-notice">
          ✓ Form pre-filled from quick feasibility
        </div>
      )}
      
      <form>
        {/* Render all form fields using formData */}
      </form>
      
      <button onClick={fillFromQuickFeasibility}>
        Fill from chat
      </button>
    </div>
  );
}
```

---

## Part 3: Common Pitfalls

### 1. Confusing siteArea vs saleableArea

- **siteArea**: The land parcel size (e.g., 1,394 sqm) - from property lookup
- **saleableArea**: Total unit floor area (e.g., 16,100 sqm for 50 x 250 + 9 x 400) - from user

These are DIFFERENT values. Don't mix them up!

### 2. Using input values instead of calculated values

When displaying quick feasibility results, use the VALUES FROM THE TOOL OUTPUT, not what the user said:

```typescript
// BAD - using what user told you
const grv = userInput.grv;  // Might be string, might have typos

// GOOD - using tool output
const grv = response.feasibilityData.revenue.grvInclGST;  // Validated number
```

### 3. Not handling null/undefined

Always check if calculatorPreFill exists before accessing it:

```typescript
// BAD
const landValue = response.feasibilityData.calculatorPreFill.landValue;  // TypeError if undefined

// GOOD
const landValue = response.feasibilityData?.calculatorPreFill?.landValue ?? 0;
```

