# Quick Feasibility Button Integration Guide

## Overview

The backend now returns structured data to support clickable button options for multiple-choice questions during the quick feasibility flow. This guide explains how to implement button rendering in the frontend.

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
