# LOVABLE FRONTEND CHANGES REQUIRED

**Date:** 2026-02-07
**Context:** Backend has been patched (claude.js, server.js, quick-feasibility-engine.js, stamp-duty-calculator.js, feasibility-calculator.js). These frontend changes complement those backend fixes.

---

## PRIORITY 1 — CRITICAL (Causes Wrong Data / Bad UX)

### 1.1 LVR Button Labels — Eliminate Ambiguity

**File:** `src/components/QuickFeasoButtons.tsx`
**Problem:** Current LVR button options are ambiguous. "Fully funded" can mean either "100% equity (no debt)" or "100% debt". "100%" is ambiguous — is it 100% LVR or 100% equity?

**Current backend behavior:**
- "Fully funded" → 0% LVR (no debt)
- "80%" → 80% LVR
- "100%" → 100% LVR (explicit number wins)
- "No debt" → 0% LVR

**Change:** Update the LVR button options wherever they appear. The backend system prompt asks Claude to present buttons like:

```
"LVR? [60%] [70%] [80%] [Fully funded]"
```

But these should be changed to **unambiguous labels**:

```
"LVR? [60% debt] [70% debt] [80% debt] [No debt (100% equity)] [Custom]"
```

**In `QuickFeasoButtons.tsx`**, update the `LABEL_CLARIFICATIONS` mapping:

```typescript
// REPLACE the existing LABEL_CLARIFICATIONS with:
const LABEL_CLARIFICATIONS: Record<string, string> = {
  // LVR — make debt/equity explicit
  'fully funded': 'No debt (100% equity)',
  '100% funded': 'No debt (100% equity)',
  'no debt': 'No debt (100% equity)',
  'cash purchase': 'No debt (100% equity)',
  '60%': '60% LVR (debt)',
  '70%': '70% LVR (debt)',
  '80%': '80% LVR (debt)',
  '90%': '90% LVR (debt)',
  '100%': '100% LVR (debt)',
  '60% lvr': '60% LVR (debt)',
  '70% lvr': '70% LVR (debt)',
  '80% lvr': '80% LVR (debt)',
  '60% debt': '60% LVR (debt)',
  '70% debt': '70% LVR (debt)',
  '80% debt': '80% LVR (debt)',
  '100% debt': '100% LVR (debt)',
};
```

**Why this matters:** A user clicking "Fully funded" and getting 100% LVR (debt) instead of 0% LVR completely flips the feasibility result. The backend `parseLVR()` function now handles this correctly, but the frontend labels must match to prevent confusion.

---

### 1.2 SSE Error Recovery — Handle Partial Streams

**File:** `src/pages/Chat.tsx` (inside `handleSendMessage`, SSE parsing section ~lines 676-791)

**Problem:** If the backend sends progress events but then errors out (or the connection drops), the frontend currently shows a perpetual loading state. The `ThinkingIndicator` keeps spinning.

**Change:** Add connection error handling and timeout:

```typescript
// AFTER: const reader = response.body?.getReader();
// ADD a timeout mechanism:

const STREAM_TIMEOUT_MS = 120_000; // 2 minutes
let streamTimeoutId: ReturnType<typeof setTimeout> | null = null;

const resetStreamTimeout = () => {
  if (streamTimeoutId) clearTimeout(streamTimeoutId);
  streamTimeoutId = setTimeout(() => {
    console.warn('[CHAT] Stream timeout — no data received for 2 minutes');
    abortRef.current?.abort();
  }, STREAM_TIMEOUT_MS);
};

resetStreamTimeout(); // Start initial timeout

// Inside the while(true) loop, after receiving any data:
// resetStreamTimeout(); // Reset timeout on each received chunk

// In the finally block:
// if (streamTimeoutId) clearTimeout(streamTimeoutId);
```

Also add to the `catch` block in the SSE reader:

```typescript
catch (streamError) {
  if (streamError.name === 'AbortError') {
    console.log('[CHAT] Stream aborted (user switched chat or timeout)');
  } else {
    console.error('[CHAT] Stream error:', streamError);
    // Show error message to user instead of perpetual loading
    const errorMessage: Message = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: "Something went wrong on my end. Could you try asking again?",
    };
    setProjectStates((prev) => {
      const state = prev[projectIdAtSend] ?? getDefaultProjectState();
      return {
        ...prev,
        [projectIdAtSend]: { ...state, messages: [...state.messages, errorMessage] }
      };
    });
  }
}
```

---

### 1.3 Feasibility Results — Handle `validationErrors` State

**File:** `src/components/ChatMessage.tsx` and `src/components/FeasibilityResults.tsx`

**Problem:** When the backend returns `feasibilityData.calculationData.error === true` (missing required inputs), the frontend may still try to render `FeasibilityResults` with null/undefined values.

**Change:** In `ChatMessage.tsx`, check for the error state before rendering FeasibilityResults:

```typescript
// Where feasibility results are rendered, add a guard:
{feasibilityData?.feasibilityMode === 'results' && feasibilityData?.calculationData && !feasibilityData.calculationData.error && (
  <FeasibilityResults data={feasibilityData} ... />
)}
```

The `formattedResponse` text (which contains the "I'm missing these inputs..." message) will still be shown via the normal content rendering. The structured `FeasibilityResults` card should only render when calculation succeeded.

---

## PRIORITY 2 — HIGH (Improves Reliability)

### 2.1 Button Option Normalization — Handle Backend Format Variations

**File:** `src/pages/Chat.tsx` or wherever `buttonOptions` from the API response are processed

**Problem:** The backend now sends `buttonOptions` as an array of strings (parsed from `[bracketed]` text). But sometimes Claude doesn't format perfectly and the bracket text ends up in the message content without being parsed server-side.

**Change:** Add client-side fallback parsing if `buttonOptions` is null but content contains `[brackets]`:

```typescript
function normalizeButtonOptions(apiButtons: string[] | undefined, content: string): string[] | null {
  // If API already parsed them, use those
  if (apiButtons && apiButtons.length >= 2) {
    return apiButtons;
  }

  // Fallback: parse from content text
  const bracketPattern = /\[([^\]]{1,50})\]/g;
  const matches = [...content.matchAll(bracketPattern)];
  if (matches.length >= 2) {
    const buttons = matches
      .map(m => m[1].trim())
      .filter(b => b.length > 0 && b.length < 50);
    return buttons.length >= 2 ? buttons : null;
  }

  return null;
}
```

Use this when processing the `complete` event:

```typescript
const buttonOptionsFromAPI = normalizeButtonOptions(event.data?.buttonOptions, event.data.answer);
```

---

### 2.2 Chat Input — Prevent Double-Send on Fast Click

**File:** `src/components/ChatInput.tsx`

**Problem:** If user clicks Send quickly twice or hits Enter rapidly, `handleSendMessage` can be called twice before `isLoading` is set to true (React state batching).

**Change:** Add a local ref-based guard:

```typescript
const sendingRef = useRef(false);

const handleSubmit = (e: React.FormEvent) => {
  e.preventDefault();
  if (sendingRef.current) return; // Prevent double-send
  if ((input.trim() || selectedFiles.length > 0) && !disabled) {
    sendingRef.current = true;
    onSend(input, selectedFiles.length > 0 ? selectedFiles : undefined);
    setInput("");
    setSelectedFiles([]);
    // Reset after short delay (parent will set loading state)
    setTimeout(() => { sendingRef.current = false; }, 500);
    // ... rest of reset logic
  }
};
```

---

### 2.3 Map Button — Show Disabled Tooltip

**File:** `src/components/FeatureToolbar.tsx`

**Problem:** The Map button is disabled when no `mapData` exists, but users don't know why it's greyed out.

**Change:** Add a tooltip when disabled:

```typescript
// For the Map button, wrap in Tooltip when disabled:
<TooltipProvider>
  <Tooltip>
    <TooltipTrigger asChild>
      <button disabled={!mapData} ...>
        <Map /> Map
      </button>
    </TooltipTrigger>
    {!mapData && (
      <TooltipContent>
        <p>Look up a property first to enable the map</p>
      </TooltipContent>
    )}
  </Tooltip>
</TooltipProvider>
```

---

## PRIORITY 3 — MEDIUM (Polish & Edge Cases)

### 3.1 Feasibility Calculator — Update Stamp Duty Rates

**File:** `src/components/FeasibilityCalculator.tsx`

**Problem:** The frontend's detailed calculator has its own QLD stamp duty calculation that may be outdated. The backend has been updated to use current 2025-26 QRO rates.

**Change:** Update the QLD stamp duty function to match the backend:

```typescript
const calculateStampDutyQLD = (price: number): number => {
  if (price <= 5000) return 0;
  if (price <= 75000) return (price - 5000) * 0.015;
  if (price <= 540000) return 1125 + (price - 75000) * 0.035;
  if (price <= 1000000) return 17400 + (price - 540000) * 0.045;
  return 38100 + (price - 1000000) * 0.0575;
};
```

Also ensure the NSW rates match:

```typescript
const calculateStampDutyNSW = (price: number): number => {
  if (price <= 16000) return price * 0.0125;
  if (price <= 35000) return 200 + (price - 16000) * 0.015;
  if (price <= 93000) return 485 + (price - 35000) * 0.0175;
  if (price <= 351000) return 1500 + (price - 93000) * 0.035;
  if (price <= 1168000) return 10530 + (price - 351000) * 0.045;
  return 47295 + (price - 1168000) * 0.055;
};
```

---

### 3.2 Quick Feaso Buttons — Handle "Custom" Flow Better

**File:** `src/components/QuickFeasoButtons.tsx`

**Problem:** When user clicks "Custom" for interest rate or selling costs, the backend asks a follow-up question. But the frontend still shows button options from the previous question.

**Change:** When a button with value "Custom" is clicked, don't show it as a button anymore — the next message should just be a text input prompt. Add logic:

```typescript
// When rendering buttons, filter out "Custom" if the PREVIOUS message already had a Custom click:
const filteredButtons = buttonOptions?.filter(btn => {
  // If this is a follow-up to a "Custom" selection, hide the buttons
  // (the user should type a value, not click a button)
  return true; // Default — could add logic to detect custom follow-ups
});
```

Alternatively, the backend now detects custom follow-ups and won't send button options for the follow-up question. So this may already work correctly.

---

### 3.3 PropertySidebar — Zone Detail Accuracy

**File:** `src/components/PropertySidebar.tsx`

**Problem:** The `getZoneDetails()` function uses hardcoded zone info that may not match the actual planning controls returned by the backend. For example, it defaults "medium density" to RD3 and "9 metres" height, but the actual property might be RD6 with 29m height.

**Change:** Use the actual `propertyData` values instead of zone-based defaults:

```typescript
const getZoneDetails = () => {
  const zone = propertyData.zone?.toLowerCase() || '';
  const density = propertyData.density || '';
  const height = propertyData.height || '';
  const area = propertyData.area || '';

  // Use ACTUAL values from backend, with zone-based fallbacks only for display labels
  return {
    name: propertyData.zone || 'Unknown Zone',
    code: density || 'Unknown',
    maxHeight: height || 'Not specified',
    // ... use real data, not hardcoded approximations
  };
};
```

---

### 3.4 DemoBox Examples — More Useful Defaults

**File:** `src/components/DemoBox.tsx`

**Problem:** The example queries ("295RP21863", "What's the max building height?") work well but could be more intuitive for new users.

**Suggested Change:** Add an address-based example since lot/plan numbers are unfamiliar to most users:

```typescript
const examples = [
  { label: "Property Lookup", query: "265 Jefferson Lane, Palm Beach", description: "Look up zoning and planning controls" },
  { label: "Lot/Plan Search", query: "295RP21863", description: "Search by lot/plan number (most accurate)" },
  { label: "Development Query", query: "What's the max building height?", description: "Ask about regulations and constraints" },
  { label: "Quick Feasibility", query: "Run a quick feaso", description: "Run a development feasibility analysis" }
];
```

---

### 3.5 ThinkingIndicator — Handle Backend Emoji Stripping

**File:** `src/components/ThinkingIndicator.tsx`

**Problem:** The backend sends progress messages with emojis (e.g., "📍 Searching Gold Coast City Plan...") and the frontend strips them. This is fine, but the normalization could miss some patterns.

**Current normalization handles:**
- Emoji removal
- "Scraping" → "Accessing"
- US → AU spelling

**Additional patterns to normalize:**

```typescript
// Add to normalizeText():
.replace(/scraping property/gi, 'Accessing property')
.replace(/scraping gold coast/gi, 'Accessing Gold Coast')
.replace(/connecting to gold coast/gi, 'Connecting to planning')
.replace(/parsing query/gi, 'Processing')
```

---

## PRIORITY 4 — LOW (Nice to Have)

### 4.1 Feasibility PDF Export — Include Input Sources

**File:** `src/utils/pdfGenerator.ts`

The backend now returns `inputSources` alongside feasibility results, showing where each value came from (claude_tool_args vs conversation_extraction_fallback). The PDF could include a small note about data provenance.

### 4.2 Error Message Content — Don't Show in History

**File:** `src/pages/Chat.tsx` (in the `conversationHistory` building logic)

The ERROR_PATTERNS array already filters out error messages from history. Verify these patterns match the updated backend error messages:

```typescript
const ERROR_PATTERNS = [
  "I apologize, but I'm having trouble connecting",
  "Dev.i's chat limit has been reached",
  "Something went wrong on my end",
  "Could you try rephrasing your question",
  "Unable to generate response",
  "Failed to get response",
  "Please check if your Railway deployment",
  "Dev.i's server is overloaded",    // NEW — matches updated server.js
  "Something went wrong processing",  // NEW — matches updated server.js
];
```

### 4.3 Sidebar Toggle Animation

**File:** `src/pages/Chat.tsx` (render section)

The property sidebar toggle button works but could use a smoother animation. Consider adding `transition-all duration-200` to the expand/collapse.

---

## SUMMARY TABLE

| # | File | Priority | Change |
|---|------|----------|--------|
| 1.1 | QuickFeasoButtons.tsx | CRITICAL | Fix LVR button labels to be unambiguous |
| 1.2 | Chat.tsx | CRITICAL | Add SSE stream timeout and error recovery |
| 1.3 | ChatMessage.tsx / FeasibilityResults.tsx | CRITICAL | Guard against rendering failed feasibility |
| 2.1 | Chat.tsx | HIGH | Fallback button parsing from content |
| 2.2 | ChatInput.tsx | HIGH | Prevent double-send with ref guard |
| 2.3 | FeatureToolbar.tsx | HIGH | Disabled Map button tooltip |
| 3.1 | FeasibilityCalculator.tsx | MEDIUM | Update stamp duty rates to 2025-26 |
| 3.2 | QuickFeasoButtons.tsx | MEDIUM | Handle "Custom" flow |
| 3.3 | PropertySidebar.tsx | MEDIUM | Use actual property data not hardcoded zone defaults |
| 3.4 | DemoBox.tsx | MEDIUM | Better example queries |
| 3.5 | ThinkingIndicator.tsx | MEDIUM | Additional normalization patterns |
| 4.1 | pdfGenerator.ts | LOW | Include input sources in PDF |
| 4.2 | Chat.tsx | LOW | Update ERROR_PATTERNS |
| 4.3 | Chat.tsx | LOW | Sidebar animation polish |

---

**END OF DOCUMENT**
