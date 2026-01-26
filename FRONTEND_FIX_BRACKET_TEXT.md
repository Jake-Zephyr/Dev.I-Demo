# Frontend Fix: Remove Bracketed Text When Buttons Are Present

## Issue

When the backend returns button options, the message text contains BOTH:
1. The bracketed options in the text: `GST treatment? [Margin scheme] [Fully taxed]`
2. The actual button components below the text

**User sees:**
```
GST treatment? [Margin scheme] [Fully taxed]

[Margin scheme button] [Fully taxed button]
```

**User wants:**
```
GST treatment?

[Margin scheme button] [Fully taxed button]
```

## Solution

When displaying a message that has `buttonOptions`, strip the bracketed text from the message.

### Implementation

```typescript
function formatMessageText(response: ClaudeResponse): string {
  let displayText = response.answer;

  // If buttons are present, remove bracketed options from text
  if (response.buttonOptions && response.buttonOptions.length > 0) {
    // Remove all [text] patterns
    displayText = displayText.replace(/\[([^\]]+)\]/g, '');

    // Clean up extra spaces
    displayText = displayText.replace(/\s{2,}/g, ' ').trim();

    // Clean up trailing punctuation after removal
    displayText = displayText.replace(/\?\s*$/, '?').replace(/:\s*$/, '');
  }

  return displayText;
}
```

### Usage Example

```tsx
function ChatMessage({ message }: { message: ClaudeResponse }) {
  const displayText = formatMessageText(message);

  return (
    <div className="message">
      <p>{displayText}</p>

      {message.buttonOptions && (
        <div className="button-group">
          {message.buttonOptions.map((option) => (
            <button key={option} onClick={() => handleClick(option)}>
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

### Test Cases

**Input:**
```javascript
{
  answer: "GST treatment? [Margin scheme] [Fully taxed]",
  buttonOptions: ["Margin scheme", "Fully taxed"]
}
```

**Output:**
```javascript
displayText = "GST treatment?"
// Buttons render below
```

---

**Input:**
```javascript
{
  answer: "LVR (Loan to Value Ratio)? [60%] [70%] [80%] [Fully funded]",
  buttonOptions: ["60%", "70%", "80%", "Fully funded"]
}
```

**Output:**
```javascript
displayText = "LVR (Loan to Value Ratio)?"
// Buttons render below
```

---

**Input:**
```javascript
{
  answer: "Interest rate? [6.5%] [7.0%] [7.5%] [Custom]",
  buttonOptions: ["6.5%", "7.0%", "7.5%", "Custom"]
}
```

**Output:**
```javascript
displayText = "Interest rate?"
// Buttons render below
```

### Edge Cases

**Multiple bracketed text (not buttons):**
```javascript
{
  answer: "The property has [height control] of 9m and [density] of RD4.",
  buttonOptions: null  // No buttons
}
```

**Output:**
```javascript
displayText = "The property has [height control] of 9m and [density] of RD4."
// Don't strip brackets when no buttons present
```

**Empty brackets:**
```javascript
{
  answer: "Choose an option: []",
  buttonOptions: []
}
```

**Output:**
```javascript
displayText = "Choose an option:"
```

### Complete Implementation

```typescript
interface ClaudeResponse {
  answer: string;
  buttonOptions?: string[] | null;
  questionContext?: {
    type: string;
    label: string;
    needsCustomInput?: boolean;
  } | null;
}

function formatMessageText(response: ClaudeResponse): string {
  if (!response.answer) return '';

  let displayText = response.answer;

  // Only strip brackets if we have actual buttons to render
  if (response.buttonOptions && response.buttonOptions.length > 0) {
    // Remove all [text] patterns from the message
    displayText = displayText.replace(/\[([^\]]+)\]/g, '');

    // Clean up multiple spaces left by removal
    displayText = displayText.replace(/\s{2,}/g, ' ');

    // Trim whitespace
    displayText = displayText.trim();

    // Fix common punctuation issues after removal
    // "GST treatment?  " → "GST treatment?"
    displayText = displayText.replace(/([?:])\s+$/, '$1');
  }

  return displayText;
}

// Usage in component
function ChatMessage({ message }: { message: ClaudeResponse }) {
  const displayText = formatMessageText(message);
  const hasButtons = message.buttonOptions && message.buttonOptions.length > 0;

  return (
    <div className="chat-message">
      <div className="message-text">
        {displayText}
      </div>

      {hasButtons && (
        <div className="button-options">
          {message.buttonOptions.map((option, index) => (
            <button
              key={index}
              className="option-button"
              onClick={() => sendMessage(option)}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

## Testing

1. Complete a quick feasibility flow
2. Verify each button question shows:
   - Clean question text WITHOUT brackets
   - Buttons below the text
3. Questions to test:
   - "LVR?" → 4 buttons
   - "Interest rate?" → 4 buttons
   - "Selling costs?" → 3 buttons
   - "GST treatment?" → 2 buttons
   - "Cost base?" → 2 buttons
   - "Quick feaso or detailed calculator?" → 2 buttons

## Alternative: Backend Fix

If you prefer, the backend could be modified to NOT include bracketed text when buttonOptions are present. However, this requires backend changes and coordination. The frontend fix is simpler and gives you more control.

## Questions?

Ask if you need clarification on:
- Regex pattern explanation
- Handling edge cases
- Integration with your existing message rendering
- CSS styling for button groups
