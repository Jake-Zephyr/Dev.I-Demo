// services/claude.js
import Anthropic from '@anthropic-ai/sdk';
import { scrapeProperty } from './goldcoast-api.js';
import { searchPlanningScheme } from './rag-simple.js';
import { getDetailedFeasibilityPreFill } from './feasibility-calculator.js';
import { runQuickFeasibility, runResidualAnalysis, extractInputsFromConversation } from './quick-feasibility-engine.js';
import { getDraft, patchDraft, calculateDraft, resetDraft, parseInputValue, getDefaultAssumptions } from './feaso-draft-store.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

/**
 * Strip markdown formatting from Claude's response
 * PRESERVES bullet points (•) and newlines for structured content
 */
function stripMarkdown(text) {
  if (!text) return text;

  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')  // Remove bold
    .replace(/\*(.*?)\*/g, '$1')       // Remove italics
    .replace(/\*/g, '')                // Remove remaining asterisks
    .replace(/^#{1,6}\s*/gm, '')       // Remove headings
    // REMOVED: .replace(/^[\-•]\s*/gm, '') - We want to keep bullet points!
    .replace(/^\d+[\.\)]\s*/gm, '')    // Remove numbered lists
    .replace(/\n{3,}/g, '\n\n')        // Collapse multiple newlines to double
    .replace(/  +/g, ' ')              // Collapse multiple spaces
    .trim();
}

/**
 * Fix inline bullet points by converting them to proper line-separated format
 * ONLY applies when response contains "Planning Overlays" (overlay lists)
 */
function fixBulletPoints(text) {
  if (!text) return text;

  // Only fix bullets if this is an overlay list response
  if (text.includes('Planning Overlays for')) {
    // Add TWO newlines after "Planning Overlays for [address] (Lot [lotplan]):" heading for proper spacing
    let fixed = text.replace(/(Planning Overlays for [^:]+:)\s*/g, '$1\n\n');

    // Convert all inline bullets to line-separated format
    fixed = fixed.replace(/ • /g, '\n• ');

    // Remove duplicate overlay lists if Claude generated them twice
    // Match "Planning Overlays for..." through the list, then check if it repeats
    const overlayPattern = /(Planning Overlays for[^:]+:\s*\n\n(?:• [^\n]+\n)+)/g;
    const matches = fixed.match(overlayPattern);

    if (matches && matches.length > 1) {
      // Found duplicate lists - keep only the first one
      console.log('[CLAUDE] Detected duplicate overlay lists, removing duplicates');
      const firstList = matches[0];
      // Remove all subsequent identical lists
      for (let i = 1; i < matches.length; i++) {
        fixed = fixed.replace(matches[i], '');
      }
    }

    return fixed;
  }

  // Not an overlay list - return unchanged
  return text;
}

/**
 * Force paragraph breaks every 2-3 sentences
 * ONLY applies to plain prose paragraphs. Preserves:
 * - Bullet point lists (lines starting with • or -)
 * - Numbered lists
 * - Lines with colons (headers/labels like "Revenue:")
 * - Feasibility output (structured data)
 * - Existing paragraph breaks
 */
function formatIntoParagraphs(text) {
  if (!text) return text;

  // If text already has structure (bullets, multiple newlines, headers), preserve it
  const hasBullets = /^[•\-]\s/m.test(text);
  const hasHeaders = /^[A-Z][A-Za-z\s]+:/m.test(text);
  const hasMultipleParagraphs = (text.match(/\n\n/g) || []).length >= 2;

  if (hasBullets || hasHeaders || hasMultipleParagraphs) {
    // Already structured — just clean up excessive whitespace
    return text.replace(/\n{3,}/g, '\n\n').trim();
  }

  // Plain prose: split into sentences and group into paragraphs
  let normalized = text.replace(/\n+/g, ' ').replace(/  +/g, ' ').trim();

  // Common abbreviations that shouldn't trigger sentence splits
  const abbrevs = /(?:Dr|Mr|Mrs|Ms|Prof|St|Ave|Rd|Ltd|Inc|Corp|etc|vs|approx|e\.g|i\.e)\./gi;
  // Temporarily replace abbreviation dots
  let temp = normalized.replace(abbrevs, (match) => match.replace('.', '§DOT§'));

  const sentences = [];
  let current = '';

  for (let i = 0; i < temp.length; i++) {
    current += temp[i];

    if (temp[i] === '.' &&
        (i === temp.length - 1 ||
         (temp[i + 1] === ' ' && /[A-Z]/.test(temp[i + 2] || '')))) {
      sentences.push(current.trim().replace(/§DOT§/g, '.'));
      current = '';
      i++; // skip the space
    }
  }

  if (current.trim()) {
    sentences.push(current.trim().replace(/§DOT§/g, '.'));
  }

  if (sentences.length <= 3) {
    return sentences.join(' ');
  }

  const paragraphs = [];
  for (let i = 0; i < sentences.length; i += 3) {
    const group = sentences.slice(i, i + 3);
    paragraphs.push(group.join(' '));
  }

  return paragraphs.join('\n\n');
}

/**
 * Extract context from conversation history
 * Pulls out property data, suburb, development strategy etc
 */
function extractConversationContext(conversationHistory) {
  const context = {
    lastProperty: null,
    lastSuburb: null,
    lastLotplan: null,
    lastSiteArea: null,
    lastDensity: null,
    lastHeight: null,
    lastZone: null,
    developmentStrategy: null, // 'renovation', 'new_build', 'subdivision', etc
    existingUnits: null,
    isStrata: false,
    priceDiscussed: null,
    budgetRange: null
  };

  if (!conversationHistory || conversationHistory.length === 0) {
    return context;
  }

  // Track which individual planning controls have been set from City Plan (get_property_info)
  // Only lock fields that were actually found — don't block others from fallback extraction
  let zoneLocked = false;
  let densityLocked = false;
  let heightLocked = false;

  // Scan through history looking for property data and strategy signals
  for (const msg of conversationHistory) {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    const contentLower = content.toLowerCase();

    // CRITICAL: Extract planning controls ONLY from get_property_info tool results
    // This prevents DA documents from contaminating City Plan data
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          try {
            const toolResultText = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);

            // Check if this looks like a property lookup result (must have both markers)
            if (toolResultText.includes('"success":true') && toolResultText.includes('"property":{')) {
              const toolResult = JSON.parse(toolResultText);

              if (toolResult.success && toolResult.property) {
                const prop = toolResult.property;

                // Set planning controls per-field (from City Plan - IMMUTABLE once set)
                if (prop.zone) {
                  context.lastZone = prop.zone;
                  zoneLocked = true;
                }
                if (prop.density) {
                  context.lastDensity = prop.density;
                  densityLocked = true;
                }
                if (prop.height) {
                  context.lastHeight = prop.height;
                  heightLocked = true;
                }

                // Always update property info from tool results (latest wins)
                if (prop.address) {
                  context.lastProperty = prop.address;
                }
                if (prop.lotplan) {
                  context.lastLotplan = prop.lotplan;
                }
                if (prop.area) {
                  const areaNum = parseInt(prop.area.replace(/[^\d]/g, ''));
                  if (!isNaN(areaNum)) {
                    context.lastSiteArea = areaNum;
                  }
                }
              }
            }
          } catch (e) {
            console.log('[CONTEXT] Tool result parse skipped (not JSON or not property result)');
          }
        }
      }
    }

    // Look for property addresses (fallback for user-mentioned addresses)
    // Updated regex: require at least one word before street type, limit capture width
    const addressMatch = content.match(/(\d+\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3}\s+(?:street|st|avenue|ave|court|crt|road|rd|drive|dr|parade|pde|circuit|cct|crescent|cres|place|pl|way|lane|ln|terrace|tce|boulevard|blvd|esplanade|esp)),?\s*([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)(?:,|\s+QLD|\s+\d{4}|$)/i);
    if (addressMatch && !context.lastProperty) {
      context.lastProperty = addressMatch[0].trim();
      context.lastSuburb = addressMatch[2]?.trim();
    }

    // Look for suburbs mentioned
    const suburbPatterns = [
      'mermaid waters', 'mermaid beach', 'broadbeach', 'surfers paradise',
      'southport', 'main beach', 'palm beach', 'burleigh', 'robina',
      'varsity lakes', 'hope island', 'sanctuary cove', 'coolangatta',
      'currumbin', 'tugun', 'miami', 'nobby beach', 'runaway bay'
    ];
    for (const suburb of suburbPatterns) {
      if (contentLower.includes(suburb)) {
        context.lastSuburb = suburb.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      }
    }

    // Look for lotplan (fallback)
    const lotplanMatch = content.match(/\b(\d+[A-Z]{2,4}\d+)\b/i);
    if (lotplanMatch && !context.lastLotplan) {
      context.lastLotplan = lotplanMatch[1].toUpperCase();
    }

    // Look for site area (fallback, only if not already set by property lookup)
    // Support decimal areas like "1500.5 sqm"
    if (!context.lastSiteArea) {
      const areaMatch = content.match(/([\d,.]+)\s*(?:sqm|m2|m²|square\s*met)/i);
      if (areaMatch) {
        const parsed = parseFloat(areaMatch[1].replace(/,/g, ''));
        if (!isNaN(parsed) && parsed > 0) {
          context.lastSiteArea = Math.round(parsed);
        }
      }
    }

    // CRITICAL: DO NOT extract density codes or height limits from general text
    // These MUST come from get_property_info to avoid contamination from DA documents
    // Only extract if the SPECIFIC field hasn't been locked by City Plan data
    if (!densityLocked) {
      const densityMatch = content.match(/\b(RD\d{1,2})\b/i);
      if (densityMatch && !context.lastDensity) {
        context.lastDensity = densityMatch[1].toUpperCase();
      }
    }

    if (!heightLocked) {
      // Match both "9m height" AND "Maximum height: 9 metres" / "height limit: 12m"
      const heightMatch = content.match(/(\d+)\s*m(?:etre)?s?\s*(?:height|tall)/i) ||
        content.match(/(?:height|height\s*limit)\s*(?::|is|of|=)\s*(\d+)\s*m/i) ||
        content.match(/(?:maximum|max)\s+height\s*(?::|is|of|=)\s*(\d+)\s*m/i);
      if (heightMatch && !context.lastHeight) {
        // The match group index depends on which regex matched
        const heightVal = heightMatch[1] || heightMatch[2];
        if (heightVal) {
          context.lastHeight = `${heightVal}m`;
        }
      }
    }

    // Detect development strategy from conversation
    if (contentLower.includes('renovate') || contentLower.includes('renovation') || contentLower.includes('update')) {
      context.developmentStrategy = 'renovation';
    }
    if (contentLower.includes('new build') || contentLower.includes('knock down') || contentLower.includes('demolish')) {
      context.developmentStrategy = 'new_build';
    }
    if (contentLower.includes('subdivide') || contentLower.includes('subdivision')) {
      context.developmentStrategy = 'subdivision';
    }

    // Detect existing units
    const unitsMatch = content.match(/(\d+)\s*(?:existing\s*)?units?|already\s*(?:has\s*)?(\d+)\s*units?|strata.*?(\d+)\s*units?/i);
    if (unitsMatch) {
      context.existingUnits = parseInt(unitsMatch[1] || unitsMatch[2] || unitsMatch[3]);
    }

    // Look for "4 units" or "subdivided into X units"
    const strataUnitsMatch = content.match(/(?:subdivided|split|divided)\s*into\s*(\d+)\s*(?:strata\s*)?units?/i);
    if (strataUnitsMatch) {
      context.existingUnits = parseInt(strataUnitsMatch[1]);
      context.isStrata = true;
    }

    // Detect strata
    if (contentLower.includes('strata') || contentLower.includes('body corp')) {
      context.isStrata = true;
    }

    // Look for budget/price discussions
    const priceMatch = content.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(?:m(?:illion)?|k)?/gi);
    if (priceMatch) {
      context.priceDiscussed = priceMatch[priceMatch.length - 1]; // Most recent price
    }
  }

  return context;
}

/**
 * Detect and parse button options from Claude's response
 * Looks for patterns like "[Option 1] [Option 2] [Option 3]"
 * Returns array of button options if found, null otherwise
 */
function parseButtonOptions(text) {
  if (!text) return null;

  // Extract ALL [bracketed] options from the text
  // Supports single buttons and multi-button groups
  const allButtons = [];
  const individualPattern = /\[([^\]]+)\]/g;
  let match;

  while ((match = individualPattern.exec(text)) !== null) {
    const buttonText = match[1].trim();
    // Filter out markdown-style links like [text](url) and common false positives
    if (buttonText &&
        !allButtons.includes(buttonText) &&
        !text.substring(match.index + match[0].length).startsWith('(') && // not a markdown link
        buttonText.length < 60) { // reasonable button text length
      allButtons.push(buttonText);
    }
  }

  // Need at least 2 buttons to be meaningful (single bracket is likely not a button)
  return allButtons.length >= 2 ? allButtons : null;
}

/**
 * Determine the question type/context for button options
 * This helps the frontend show appropriate follow-up inputs
 */
function detectQuestionContext(text, buttons) {
  if (!text || !buttons) return null;

  const lowerText = text.toLowerCase();

  // Detect question type based on content
  if (lowerText.includes('lvr') || lowerText.includes('loan to value')) {
    return { type: 'lvr', label: 'LVR (Loan to Value Ratio)' };
  }
  if (lowerText.includes('interest rate')) {
    return { type: 'interest_rate', label: 'Interest Rate', needsCustomInput: buttons.includes('Custom') };
  }
  if (lowerText.includes('selling cost')) {
    return { type: 'selling_costs', label: 'Selling Costs', needsCustomInput: buttons.includes('Custom') };
  }
  if (lowerText.includes('gst') && (lowerText.includes('scheme') || lowerText.includes('treatment'))) {
    return {
      type: 'gst_scheme',
      label: 'GST Treatment',
      needsFollowUp: buttons.some(b => b.toLowerCase().includes('margin'))
    };
  }
  if (lowerText.includes('project type') || lowerText.includes('type of project')) {
    return { type: 'project_type', label: 'Project Type' };
  }
  if (lowerText.includes('cost base') && (lowerText.includes('margin scheme') || lowerText.includes('gst'))) {
    return {
      type: 'gst_cost_base',
      label: 'GST Margin Scheme Cost Base',
      needsCustomInput: buttons.some(b => b.toLowerCase().includes('different'))
    };
  }
  if ((lowerText.includes('quick') && lowerText.includes('detailed')) ||
      (lowerText.includes('feaso') && lowerText.includes('calculator'))) {
    return {
      type: 'feasibility_mode',
      label: 'Feasibility Mode Selection'
    };
  }

  return { type: 'general', label: 'Select an option' };
}

/**
 * Build context summary for system prompt
 */
function buildContextSummary(context) {
  const parts = [];
  
  if (context.lastProperty) {
    parts.push(`Last property discussed: ${context.lastProperty}`);
  }
  if (context.lastSuburb) {
    parts.push(`Suburb: ${context.lastSuburb}`);
  }
  if (context.lastLotplan) {
    parts.push(`Lotplan: ${context.lastLotplan}`);
  }
  if (context.lastSiteArea) {
    parts.push(`Site area: ${context.lastSiteArea}sqm`);
  }
  if (context.lastDensity) {
    parts.push(`Density: ${context.lastDensity}`);
  }
  if (context.developmentStrategy) {
    parts.push(`Strategy discussed: ${context.developmentStrategy.toUpperCase()}`);
  }
  if (context.existingUnits) {
    parts.push(`Existing units on site: ${context.existingUnits}`);
  }
  if (context.isStrata) {
    parts.push(`Property is strata titled`);
  }
  
  return parts.length > 0 ? `\n\nCONVERSATION CONTEXT:\n${parts.join('\n')}` : '';
}

/**
 * Detect if we're currently in an active feasibility Q&A flow.
 * Returns true if recent messages contain feaso-related Q&A.
 */
function detectFeasibilityFlow(conversationHistory) {
  if (!conversationHistory || conversationHistory.length < 2) return false;

  // Check the last few assistant messages for feaso-related content
  const recentMessages = conversationHistory.slice(-6);
  for (const msg of recentMessages) {
    if (msg.role !== 'assistant') continue;
    const content = String(msg.content || '').toLowerCase();
    if (
      content.includes('purchase price') ||
      content.includes('acquisition cost') ||
      content.includes('gross revenue') ||
      content.includes('grv') ||
      content.includes('construction cost') ||
      content.includes('lvr') ||
      content.includes('loan to value') ||
      content.includes('interest rate') ||
      content.includes('timeline') ||
      content.includes('selling cost') ||
      content.includes('gst') ||
      content.includes('quick feaso') ||
      content.includes('feasibility') ||
      content.includes('cost base')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Build progressive feasibility pre-fill data for the frontend calculator.
 * Called during active feasibility Q&A to progressively fill the detailed calculator panel.
 *
 * @param {Array} conversationHistory - Full conversation history
 * @param {Object} conversationContext - Extracted context from conversation
 * @param {string} conversationId - Unique ID for this conversation
 * @returns {Object|null} Pre-fill data for the frontend calculator
 */
function buildFeasibilityPreFill(conversationHistory, conversationContext, conversationId) {
  // Get or create draft
  const draft = getDraft(conversationId);

  // Always include property data from context
  if (conversationContext.lastProperty && !draft.property.address) {
    patchDraft(conversationId, {
      property: {
        address: conversationContext.lastProperty,
        lotPlan: conversationContext.lastLotplan,
        siteAreaSqm: conversationContext.lastSiteArea,
        zone: conversationContext.lastZone,
        density: conversationContext.lastDensity,
        heightM: conversationContext.lastHeight ? parseInt(conversationContext.lastHeight) : null
      }
    }, 'property_tool');
  }

  // Extract inputs from conversation and patch into draft
  // SAFETY: Only patch fields that are still null in the draft.
  // This prevents conversation extraction errors from overwriting correct values
  // that were already set by a previous progressive fill step.
  const extracted = extractInputsFromConversation(conversationHistory);
  if (extracted) {
    const inputPatch = {};
    const rawPatch = {};

    const fieldMap = {
      purchasePriceRaw: 'purchasePrice',
      grvRaw: 'grv',
      constructionCostRaw: 'constructionCost',
      lvrRaw: 'lvr',
      interestRateRaw: 'interestRate',
      timelineRaw: 'timelineMonths',
      sellingCostsRaw: 'sellingCostsPercent',
      gstSchemeRaw: 'gstScheme',
      gstCostBaseRaw: 'gstCostBase'
    };

    for (const [rawKey, parsedKey] of Object.entries(fieldMap)) {
      if (extracted[rawKey]) {
        const existingValue = draft.inputs[parsedKey];
        const existingRaw = draft.rawInputs[rawKey];
        const parsedValue = parseInputValue(parsedKey, extracted[rawKey]);

        // Only patch if: field is empty, OR the raw value changed (genuine new answer)
        if (existingValue === null || existingValue === undefined || extracted[rawKey] !== existingRaw) {
          rawPatch[rawKey] = extracted[rawKey];
          if (parsedValue !== null && parsedValue !== undefined) {
            inputPatch[parsedKey] = parsedValue;
          }
        }
      }
    }

    // Handle gstCostBase special case: "same as acquisition" → use purchasePrice
    if (extracted.gstCostBaseRaw) {
      const lower = extracted.gstCostBaseRaw.toLowerCase();
      if (lower.includes('same') || lower.includes('acquisition')) {
        const pp = inputPatch.purchasePrice || draft.inputs.purchasePrice;
        if (pp) inputPatch.gstCostBase = pp;
      }
    }

    if (Object.keys(inputPatch).length > 0) {
      patchDraft(conversationId, { inputs: inputPatch, rawInputs: rawPatch }, 'chat');
    }
  }

  // Return the current draft state for frontend
  const updatedDraft = getDraft(conversationId);
  return updatedDraft;
}

/**
 * Quick intent classification - no LLM needed for obvious cases
 * Returns: 'conversational' | 'property' | 'analysis' | 'needs_context' | 'unclear'
 */
function classifyIntent(query, conversationContext) {
  const q = query.toLowerCase().trim();
  
  // Conversational patterns - NO TOOLS NEEDED
  const conversationalPatterns = [
    /^(hi|hey|hello|g'day|yo)\b/,
    /^how are you/,
    /^are you (ok|okay|good|feeling)/,
    /^what('s| is) up/,
    /^thanks?( you)?$/,
    /^(good|great|nice|cool|awesome|perfect)$/,
    /^(yes|no|yeah|nah|yep|nope)$/,
    /^what can you do/,
    /^who are you/,
    /^help$/,
    /^lol/,
    /^haha/,
  ];
  
  if (conversationalPatterns.some(p => p.test(q))) {
    return 'conversational';
  }
  
  // Property patterns - TOOLS LIKELY NEEDED
  const hasAddress = /\d+\s+\w+\s+(street|st|avenue|ave|road|rd|drive|dr|parade|pde|court|crt|crescent|cres|place|pl|way|lane|ln)/i.test(query);
  const hasLotplan = /\d+[A-Z]{2,4}\d+/i.test(query);
  const hasPropertyKeywords = /(zoning|zone|overlay|height|density|what can i build|development potential|RD\d)/i.test(q);
  
  if (hasAddress || hasLotplan) {
    return 'property';
  }
  
  // Explicit analysis requests
  const analysisPatterns = [
    /run (a )?feaso/i,
    /feasibility/i,
    /check (the )?(overlays|das|applications)/i,
    /nearby (das|development applications)/i,
    /what('s| is) the zoning/i,
    /search for das/i,
  ];
  
  if (analysisPatterns.some(p => p.test(q))) {
    // Only proceed if we have property context
    if (conversationContext.lastProperty || conversationContext.lastLotplan) {
      return 'analysis';
    }
    return 'needs_context';
  }
  
  // Property question with existing context
  if (hasPropertyKeywords && (conversationContext.lastProperty || conversationContext.lastLotplan)) {
    return 'property';
  }
  
  // Default: let Claude decide with tools available
  return 'unclear';
}
/**
 * Handle conversational messages WITHOUT tools
 * Fast, cheap, no scraping
 */
async function handleConversationalMessage(userQuery, conversationHistory, context) {
  const messages = [];

  // Add recent history (last 10 messages max for context)
  // Only include string content — skip tool_result blocks for conversational responses
  if (conversationHistory?.length > 0) {
    const recent = conversationHistory.slice(-10);
    for (const msg of recent) {
      if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
        messages.push({
          role: msg.role,
          content: msg.content.trim()
        });
      }
    }
  }
  
  messages.push({ role: 'user', content: userQuery });
  
  const contextNote = context.lastProperty 
    ? `\n\nContext: You've been discussing ${context.lastProperty}${context.lastSuburb ? ` in ${context.lastSuburb}` : ''}.` 
    : '';
  
  const systemPrompt = `You are Dev.i, an AI-powered property development advisor built for the Gold Coast.

RIGHT NOW you're just having a casual chat - no property analysis needed.${contextNote}

RULES FOR THIS RESPONSE:
- Keep it short and friendly (1-3 sentences max)
- Professional and approachable — like a sharp colleague, not a robot or a report
- If they seem ready to work, invite them to drop an address or tell you what they're working on
- Never say "I don't have access to" or apologise for limitations
- Never use bullet points, asterisks, or markdown formatting
- Never offer to do things you can't do

Examples of good responses:
- "how are you" → "Good — ready when you are. Got a site in mind?"
- "thanks" → "No worries. Shout if you need anything else."
- "what can you do" → "I can pull up planning controls, run a preliminary feasibility on your numbers, search development applications, or help you think through a site. What are you working on?"
- "hello" → "Hey! What site are we looking at today?"`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 150,
      system: systemPrompt,
      messages
    });
    
    const text = response.content.find(c => c.type === 'text')?.text || "Ready when you are.";
    
    return {
      answer: stripMarkdown(text),
      propertyData: null,
      usedTool: false,
      isConversational: true
    };
    
  } catch (error) {
    console.error('[CLAUDE] Conversational error:', error.message);
    return {
      answer: "Ready when you are — drop an address and I'll take a look.",
      propertyData: null,
      usedTool: false
    };
  }
}
/**
 * Get planning advisory from Claude with function calling
 *
 * @param {string} userQuery - The user's message
 * @param {Array} conversationHistory - Conversation history array
 * @param {Function|null} sendProgress - SSE progress callback
 * @param {string|null} conversationId - Unique conversation ID for draft store
 */
export async function getAdvisory(userQuery, conversationHistory = [], sendProgress = null, conversationId = null) {
  try {
    console.log('=====================================');
    console.log('[CLAUDE] New advisory request');
    console.log('[CLAUDE] User query:', userQuery);
    console.log('[CLAUDE] Conversation history length:', conversationHistory?.length || 0);
    console.log('[CLAUDE] Conversation ID:', conversationId || '(none)');
    console.log('=====================================');

    // Extract context from conversation history
    const conversationContext = extractConversationContext(conversationHistory);
    console.log('[CLAUDE] Extracted context:', JSON.stringify(conversationContext, null, 2));

    // NEW: Classify intent BEFORE calling Claude with tools
    const intent = classifyIntent(userQuery, conversationContext);
    console.log('[CLAUDE] Intent classification:', intent);
    
    // CONVERSATIONAL: Respond without tools (fast path)
    if (intent === 'conversational') {
      console.log('[CLAUDE] Conversational message - skipping tools');
      if (sendProgress) sendProgress('💭 Thinking...');
      return await handleConversationalMessage(userQuery, conversationHistory, conversationContext);
    }
    
    // NEEDS CONTEXT: Ask for property info before proceeding
    if (intent === 'needs_context') {
      console.log('[CLAUDE] Needs property context - asking user');
      return {
        answer: "I can help with that — I just need a property address or lot/plan number first. What site are you looking at?",
        propertyData: null,
        usedTool: false,
        needsPropertyContext: true
      };
    }
    
    // PROPERTY, ANALYSIS, or UNCLEAR: Check if query has specific property identifier
    console.log('[CLAUDE] Checking for property identifier in query...');

    // Check if query contains actual property identifier
    const hasPropertyIdentifier = /\d{1,4}\s+[\w\s]+(street|st|avenue|ave|road|rd|drive|dr|parade|pde|court|ct|crescent|cres|place|pl|way|lane|ln)\s*,?\s*\w+|\b\d+[A-Z]{2,4}\d+\b/i.test(userQuery);

    const isGeneralQuestion = /what should i|tell me about|general|planning|area|demographics|style|concept|want to build|thinking about|considering|looking at building|interested in|advice|suggestions|recommendations|possibilities|options/i.test(userQuery.toLowerCase());

    const hasSuburbOnly = /\b(mermaid|broadbeach|surfers|southport|burleigh|palm beach|robina|varsity|currumbin|coolangatta|labrador|runaway bay|hope island|coomera|ormeau|oxenford|helensvale|miami|nobby beach|main beach|ashmore|benowa|bundall|elanora|merrimac|molendinar|mudgeeraba|nerang|paradise point|parkwood|reedy creek|tallebudgera|worongary|carrara|biggera waters|coombabah|gilston|gaven|highland park|hollywell|jacobs well|maudsland|pacific pines|pimpama|stapylton|upper coomera|willow vale|wongawallan|arundel)\b/i.test(userQuery);

    // If general question without specific property, respond conversationally without tools
    if (isGeneralQuestion && !hasPropertyIdentifier && !conversationContext.lastProperty) {
      console.log('[CLAUDE] General question without property identifier - using conversational response');

      if (sendProgress) sendProgress('💭 Thinking...');

      return await handleConversationalMessage(userQuery, conversationHistory, conversationContext);
    }

    console.log('[CLAUDE] Proceeding with tool-enabled response');

    // Send initial progress message for tool-based queries
    if (sendProgress) {
      sendProgress('💭 Analysing your question...');
    }

    const tools = [
      {
        name: 'get_property_info',
        description: 'Look up current Gold Coast property planning details including zone, density, height limits, overlays, and relevant planning scheme text. ONLY use if user provides a specific address (with street number) or lot/plan number. Do NOT use for general suburb questions like "I want to build in Robina" - those should be answered conversationally. IMPORTANT: This tool works best with lot/plan numbers (e.g., "295RP21863"). Address searches can be unreliable.',
        input_schema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Lot/plan number (e.g., "295RP21863" - PREFERRED) or full street address with number (e.g., "12 Heron Avenue, Mermaid Beach" - less reliable). Do NOT use suburb-only queries.'
            }
          },
          required: ['query']
        }
      },
      {
        name: 'search_development_applications',
        description: 'Search for development applications (DAs) at a specific Gold Coast address. ONLY use this when user asks about DAs at a SPECIFIC street address with a number. Do NOT use for general suburb queries. ONLY use when user asks about DAs, development applications, building approvals, or construction activity. Returns application numbers, lodgement dates, status, descriptions, and types.',
        input_schema: {
          type: 'object',
          properties: {
            address: {
              type: 'string',
              description: 'Full street address with number including suburb (e.g., "22 Mary Avenue, Broadbeach"). Must have street number. If suburb not provided, use context from conversation.'
            },
            suburb: {
              type: 'string',
              description: 'Suburb name if known from conversation context'
            },
            months_back: {
              type: 'number',
              description: 'How many months back to search (default 12)',
              default: 12
            }
          },
          required: ['address']
        }
      },
      {
        name: 'get_da_decision_notice',
        description: 'Download and analyze the decision notice PDF for a specific development application. Use when user selects a DA from search results and wants to see the decision notice, conditions, or approval details. This tool searches through all document pages to find the signed decision notice (or falls back to unsigned if not available). CRITICAL: DA approvals show what was approved for a SPECIFIC APPLICATION - they do NOT change the underlying planning scheme controls (zone, height, density). Never say "the site\'s height limit is 45m" if 45m came from a DA approval - the actual planning control might be HX.',
        input_schema: {
          type: 'object',
          properties: {
            application_number: {
              type: 'string',
              description: 'DA application number (e.g., "MIN/2024/216", "MCU/2019/386"). Must be from a previous DA search result.'
            },
            address: {
              type: 'string',
              description: 'Property address for context (optional but helpful for user confirmation)'
            }
          },
          required: ['application_number']
        }
      },
      {
        name: 'start_feasibility',
        description: 'Start a feasibility analysis for a property. Use when user explicitly asks to "run a feaso", "do a feasibility", "check the numbers", or similar.',
        input_schema: {
          type: 'object',
          properties: {
            propertyAddress: {
              type: 'string',
              description: 'The property address to run feasibility on'
            },
            siteArea: {
              type: 'number',
              description: 'Site area in sqm (from previous property lookup)'
            },
            densityCode: {
              type: 'string',
              description: 'Density code like RD3, RD5 etc (from previous property lookup)'
            },
            heightLimit: {
              type: 'string',
              description: 'Height limit like "9m" or "15 metres" (from previous property lookup)'
            },
            zone: {
              type: 'string',
              description: 'Zone name (from previous property lookup)'
            },
            developmentType: {
              type: 'string',
              enum: ['renovation', 'new_build', 'subdivision', 'unknown'],
              description: 'Type of development based on conversation context. Use "renovation" if discussing updating existing buildings, "new_build" for knockdown/rebuild, "subdivision" for land splitting.'
            },
            existingUnits: {
              type: 'number',
              description: 'Number of existing units if this is a renovation/strata property'
            },
            isStrata: {
              type: 'boolean',
              description: 'Whether property is strata titled'
            },
            mode: {
              type: 'string',
              enum: ['selection', 'quick', 'detailed'],
              description: 'Which mode to start in. ALWAYS use "selection" first to ask user preference. Only use "quick" or "detailed" if user has EXPLICITLY said which they want.'
            }
          },
          required: ['propertyAddress', 'mode']
        }
      },
      {
        name: 'ask_clarification',
        description: 'Use when user gives an ambiguous response like "yes", "ok", "sure" to a question that requires a specific choice. Also use when user provides figures that seem unrealistic and need verification.',
        input_schema: {
          type: 'object',
          properties: {
            originalQuestion: {
              type: 'string',
              description: 'What was the original question or choice presented'
            },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: 'The specific options user needs to choose from'
            },
            clarificationType: {
              type: 'string',
              enum: ['choice_needed', 'value_verification', 'missing_info'],
              description: 'Type of clarification needed'
            },
            suspiciousValue: {
              type: 'string',
              description: 'If verifying a value, what value seems suspicious'
            },
            expectedRange: {
              type: 'string',
              description: 'If verifying a value, what range would be expected'
            }
          },
          required: ['originalQuestion', 'clarificationType']
        }
      },
      {
  name: 'calculate_quick_feasibility',
  description: `Calculate a quick feasibility. Pass EXACTLY what the user typed as raw strings. The backend handles ALL parsing and calculation. You will receive a pre-formatted response to display VERBATIM.

CRITICAL: Copy the user's EXACT words into the Raw fields. Do NOT convert numbers.
Example: User said "$10M" → purchasePriceRaw: "$10M" (not 10000000)
Example: User said "$45m" → grvRaw: "$45m" (not 45000000)
Example: User said "80%" → lvrRaw: "80%" (not 80)

SELLING COSTS: Always pass "3%" — this is a fixed assumption, never ask the user.
INTEREST RATE: If LVR is 0% (self funded), pass "0" for interestRateRaw.`,
  input_schema: {
    type: 'object',
    properties: {
      propertyAddress: { type: 'string', description: 'Property address from conversation context' },
      purchasePriceRaw: { type: 'string', description: 'EXACT user input for purchase price. e.g. "$10M", "$5,000,000", "5 million"' },
      grvRaw: { type: 'string', description: 'EXACT user input for GRV (inc GST). e.g. "$45M", "$12,333,333", "70 million"' },
      constructionCostRaw: { type: 'string', description: 'EXACT user input for total construction cost exc GST (lump sum including prof fees, council fees, PM). e.g. "$10M", "$10,000,000". Backend adds 5% contingency automatically.' },
      lvrRaw: { type: 'string', description: 'EXACT user input for LVR. e.g. "60%", "70%", "100%", "0%" or "self funded" or "no loan"' },
      interestRateRaw: { type: 'string', description: 'EXACT user input for interest rate. e.g. "7%", "8", "9%", "10". Pass "0" if LVR is 0%.' },
      timelineRaw: { type: 'string', description: 'EXACT user input for timeline. e.g. "18", "24 months", "2 years"' },
      sellingCostsRaw: { type: 'string', description: 'Fixed at "3%" — do not ask user. Always pass "3%".' },
      gstSchemeRaw: { type: 'string', description: 'EXACT user input for GST. e.g. "margin scheme", "fully taxed"' },
      gstCostBaseRaw: { type: 'string', description: 'EXACT user input for GST cost base (only if margin scheme). e.g. "same as acquisition", "$5M"' },
      mode: { type: 'string', enum: ['standard', 'residual'], description: 'standard = full feasibility with land price. residual = calculate max land price.' }
    },
    required: ['purchasePriceRaw', 'grvRaw', 'constructionCostRaw', 'lvrRaw', 'timelineRaw', 'gstSchemeRaw']
  }
}
    ];

    // Build context-aware system prompt
    const contextSummary = buildContextSummary(conversationContext);
    
const systemPrompt = `You are Dev.i, an AI-powered property development advisor built for the Gold Coast. You have direct access to Gold Coast City Council's planning databases and can retrieve real zoning, density, height, overlay, and development application data.

You are professional, knowledgeable, and genuinely useful — but you are an AI, not a licensed professional. You provide facts from official sources and informed guidance based on planning controls, but you cannot guarantee outcomes, confirm compliance, or provide legal/financial advice. When interpretation matters, you direct users to the right professional.

WHAT DEV.I DOES NOT DO:
- Estimate market values, sale prices, or rental yields — refer to a local agent or valuer
- Estimate construction costs — refer to a QS or Rawlinsons Cost Guide
- Confirm compliance or approval likelihood — refer to a town planner
- Provide legal interpretations of DA conditions — refer to a planning solicitor
- Generate suburb statistics, growth rates, or market forecasts

If a user asks for any of the above, say clearly: "That's outside what I can reliably provide — you'd want to speak with [specific professional] for that."

TOOL USAGE RULES (CRITICAL):
- ONLY use tools when the user is asking about a SPECIFIC PROPERTY with an address or lot/plan
- NEVER use get_property_info or search_development_applications for greetings or general chat
- NEVER use tools just to "check" something without a clear property target
- If user refers to "the property" or "this site" but no address is in context, ASK for the address — don't guess or search randomly
- If you're unsure whether to use a tool, DON'T — just respond conversationally

RESPONSE STYLE:
- Professional and conversational. Think analytical but approachable — like a sharp colleague, not a report
- Concise but complete. Don't pad responses, but don't cut important information either
- Vary your responses naturally. Not every answer needs the same structure
- Use Australian English (analyse, metres, licence, colour)
- No asterisks, no markdown formatting
- Blank line between paragraphs
- No emojis

GOLD COAST DENSITY CODES (CRITICAL - GET THIS RIGHT):
- RD1-RD4 are DWELLING density (low-medium density residential)
- RD5-RD8 are BEDROOM density (medium-high density) — this is what most GC developers care about
- RD5 = 1 bedroom per 50sqm of site area
- RD6 = 1 bedroom per 33sqm
- RD7 = 1 bedroom per 25sqm
- RD8 = 1 bedroom per 13sqm (highest density possible)
- IMPORTANT: Density is rarely the constraint. Most developments exceed notional density anyway. HEIGHT is usually the real limiting factor on the Gold Coast
- Never explain density in "dwellings per hectare" — that's greenfield/government language, not how GC developers think
- When discussing density calculations, always state the notional bedroom capacity based on the density code formula

CRITICAL RULES — FIGURES AND DATA:
- NEVER invent or estimate market prices, rental yields, growth rates, or suburb statistics
- NEVER estimate construction costs or GRV — refer to a QS/Rawlinsons for costs and a local agent/valuer for values
- Never question the values for the proposed dwellings if someone mentions they will sell for X amount. If the GR values seem high, just comment that they are strong, repeat the amount they have told you, then move on
- NEVER quote specific dollar figures for property values unless the user provided them
- If asked about suburb performance, prices, or market data, say "I don't have current market data for that — you'd want to check recent sales on realestate.com.au or talk to a local agent"
- You CAN discuss planning controls, zoning, overlays, development potential — these come from official sources
- You CAN do feasibility calculations with user-provided figures

HANDLING DATA DISPUTES (CRITICAL):
When a user disputes or questions data you've returned:
- NEVER ask the user to provide the correct data as if they should have it
- You are the expert on Gold Coast property data — the user is asking YOU for information
- If property data returned is for a strata scheme (GTP/BUP), the area breakdown should show all lots
- If there's uncertainty about data accuracy: "I can see from the cadastre that [explain what data shows]. If this doesn't match your records, there may be recent changes or I may have found the wrong lot — can you provide the lot/plan number for verification?"
- ADMIT limitations honestly rather than deflecting questions back to the user

- NEVER assume physical features like "beachfront", "waterfront", "ocean views", "river frontage" etc:
  * Do NOT assume beachfront just because street name contains "Surf", "Marine", "Ocean", "Beach", "Esplanade" etc
  * Do NOT assume waterfront just because of overlays like "Foreshore seawall setback" — these are just regulatory zones
  * Only mention beachfront/waterfront if the user explicitly states it or asks about it
  * Overlays indicate planning requirements, not guaranteed physical features

CRITICAL: PLANNING CONTROLS VS DA APPROVALS — DATA SOURCE PRECEDENCE
=======================================================================
PLANNING SCHEME CONTROLS (Zone, Height, Density, Overlays):
- ONLY come from get_property_info tool (queries Gold Coast City Plan)
- These are the UNDERLYING PLANNING RULES that apply to the land
- NEVER override or change these based on DA documents

DA DECISION NOTICES (Development Approvals):
- Show what was APPROVED for a SPECIFIC APPLICATION
- These are project-specific, NOT planning scheme controls
- A DA approving "45m height" does NOT mean the planning scheme control is "45m"

RULE: Always distinguish between "what the planning scheme allows" vs "what a previous DA approved"

OVERLAY PRESENTATION:
Overlays require context, not alarm. Most Gold Coast sites have multiple overlays — this is normal, not concerning.

Rules:
- Present overlays as factual information, not warnings
- NEVER describe any overlay as a "red flag", "significant constraint", "major concern" or "dealbreaker"
- Before saying an overlay constrains a site, CHECK: is the zone control already more restrictive? If zone height is 9m and an aviation overlay is 50m, the zone is the binding limit — don't mention the aviation overlay as a constraint
- Flood overlay: Note it's present but acknowledge most of the Gold Coast is flood affected. Say it may affect minimum habitable floor levels and stormwater design. Recommend confirming with a flood/civil engineer for the specific site
- Bushfire overlay: Note it's present. Development still occurs in bushfire zones — it affects construction requirements (BAL rating). Recommend confirming with a bushfire assessor
- Heritage: Each heritage listing is different. Note it's present and say the user needs to investigate the specific heritage requirements — don't speculate on impact
- Coastal/erosion: The A Line (seawall setback) is a hard constraint — if present, flag it clearly as a buildable area limit. General coastal erosion zones cover most of the coastal GC and should just be noted as context, not flagged as a major issue unless the property is literally beachfront or first row
- Airport OLS/PANS-OPS: Only mention if the proposed building height would realistically approach the surface. For low-mid rise residential, these are irrelevant — don't mention them
- Acid sulfate soils ("Land at or below 5m AHD" / "Land at or below 20m AHD"): These relate to soil chemistry management during excavation, not flood risk. Only mention if specifically asked about all overlays or acid sulfate soils. Do NOT bring up when asked about flooding
- Everything else: Note briefly in passing or let the side panel handle it. Don't list every overlay in chat

The full overlay list always appears in the side panel for the user to review. Your job in chat is to highlight what actually matters for their specific situation and not overwhelm with irrelevant overlays.

End overlay discussions with something like: "The full list of overlays is in the panel. A town planner can confirm exactly how these apply to your specific proposal."

PLANNING FLEXIBILITY — CODE VS IMPACT ASSESSABLE:
- If a proposal exceeds density guidelines, this is common and doesn't automatically trigger impact assessment. Don't make a big deal of it
- If a proposal exceeds the HEIGHT LIMIT, that is what triggers impact assessable development. This is significant — it adds time, cost, council scrutiny, and risk of refusal or conditions. Only flag impact assessment when height is genuinely exceeded
- Don't casually say "this would be impact assessable" — it's a meaningful statement that affects project viability. Only raise it when height exceedance is clear
- Frame it as: "Exceeding the height limit would move this from code assessable to impact assessable, which means council assesses on merit. It's achievable but adds significant time and cost to the approvals process"
- Only hard limits are things like flood levels, bushfire safety, airport height restrictions — these genuinely can't be varied

WRITING STYLE FOR SITE ANALYSIS:
- Professional, factual, and structured responses
- ALWAYS include the lot/plan reference in the first sentence for verification
- When providing site information, use this exact format:
  "The subject site at [address] (Lot [lotplan]) has a Height Control of [X] metres and a Residential Density Classification of [RDX] (one bedroom per [Y] sqm of net site area) which would allow for the notional development of up to [Z] bedrooms (based on the parent site area of [area] square metres)."
- For STRATA PROPERTIES (GTP/BUP): When areaBreakdown is provided, include it in your response:
  "The total site area is [total]sqm, comprising: [breakdown of all lots]"
- After the primary site details, provide relevant constraints and considerations
- For casual conversation (greetings, clarifications), remain friendly and conversational
- Be concise but thorough — prioritize clarity over brevity

MULTIPLE PROPERTIES AT SAME ADDRESS:
- When the tool returns multiple properties (needsDisambiguation: true), present them clearly
- Wait for user to select before proceeding with analysis
- When user responds with "Option A", "A", or a lot/plan number, call get_property_info again with that specific lot/plan

EXPLANATORY CONTENT STRUCTURE:
When providing detailed explanations:
- Break content into SHORT, focused paragraphs (2-4 sentences each)
- Each paragraph should cover ONE main point or aspect
- Use paragraph breaks to separate different aspects
- Do NOT use bullets for explanations — use natural paragraph flow

BULLET POINT USAGE RULES:
Use bullet points ONLY for:
1. When listing overlay names
2. When presenting structured site summary data (Zone, Area, Height, etc.)
3. When listing multiple distinct implications or features

DO NOT use bullets for explanatory paragraphs, detailed descriptions, or conversational responses.

CRITICAL OVERLAY RULE — NEWLINES REQUIRED:
When user asks specifically about "overlays" or "what are the overlays":
- Respond with ONLY a simple bullet-pointed list
- NO explanations, NO grouping, NO categories, NO descriptions
- Each bullet must start on a NEW LINE
- DO NOT put multiple bullets on the same line

HANDLING AMBIGUOUS RESPONSES:
- If user says "yes", "ok", "sure" to a question with multiple options, use ask_clarification tool
- Don't guess what they meant — ask them to choose specifically

INPUT VALIDATION — CRITICAL THINKING NOT RIGID RULES:
- NEVER question user-provided sale prices or GRV unless there is a genuine order-of-magnitude mismatch with the project type
- 6 townhouses at $50M build cost? That's clearly a typo — ask
- 15-storey tower at $50M build cost? That could be right — proceed
- High-rise GRV of $500M+? Completely normal for Gold Coast beachfront — proceed
- $3M per townhouse in a premium suburb? That's the market — proceed
- Use critical thinking about the project TYPE and SCALE, not arbitrary thresholds
- When in doubt, proceed with the user's numbers. They know their market better than you do

FEASIBILITY RULES:
- When user asks for feasibility, ask: "Quick feaso or detailed calculator?" using mode="selection"
- Only proceed after user explicitly chooses
- Make clear this is a BALLPARK / PRELIMINARY analysis — not a bankable feasibility
- If conversation was about RENOVATION, set developmentType="renovation" and isRenovation=true
- DO NOT offer feasibility unprompted — only when explicitly asked

DA SEARCHES:
- If user asks for DAs and doesn't give suburb, CHECK CONVERSATION CONTEXT for the suburb
- Use the suburb from the last property lookup
- Include suburb in the address when calling search_development_applications

CONTEXT AWARENESS:
- Remember what property was discussed earlier
- Remember development strategy discussed
- Remember suburb from previous lookups
${contextSummary}

QUICK FEASIBILITY FLOW:
Collect these inputs conversationally — don't be rigid about order, and if the user gives you multiple things at once, take them all:

Required inputs:
1. Land acquisition cost (purchase price)
2. Gross Realisation Value (total expected sales revenue incl GST) — user must provide this, do NOT estimate. If they ask what to budget, say "Speak with a local agent or valuer — I can't reliably estimate sale values"
3. Construction costs including build cost, professional fees, statutory/council fees — user must provide, do NOT estimate. If they ask what to budget, say "Get a QS quote or check Rawlinsons — I can't reliably estimate construction costs"
4. GST treatment: margin scheme (ask for cost base — usually same as acquisition cost) or fully taxed
5. Project timeline in months
6. LVR and interest rate (if leveraged). If they say "fully funded" or "cash" or "self funded" = 0% LVR, no debt

AUTO-FILL PROPERTY DATA:
If the user has already looked up a property in this conversation, automatically use that property's address, site area, density code, and height limit — do NOT ask for these again. Mention it briefly: "I'll use the property data from [address] we looked up earlier."

ACCEPTING USER VARIATIONS:
- "$5M" / "$5,000,000" / "5 million" → Accept as land value
- "$2,500/sqm" → Need site area to calculate (from property lookup)
- "I already own it" / "already purchased" → Ask: "What was the purchase price?"
- If user doesn't know: Use residual land value approach (calculate after getting other inputs)
- "self funded" / "no loan" / "cash" / "0%" → 0% LVR
- "fully funded" / "100%" / "full debt" → 100% LVR

Defaults (apply automatically, mention briefly):
- Target development margin: calculated based on project size (15% for larger projects, 20% for smaller)
- Selling costs: 3% estimate
- Holding costs: estimated from land value and timeline
- Sales timing: sell all during construction (default selected)

Unit count and sizes are useful context but not required unless the user is giving you $/sqm rates. If they just give you a total GRV and total construction cost, that's enough to run the numbers.

After collecting inputs, confirm the key numbers back to the user before calculating: "Just to confirm — $X land, $X GRV, $X construction, X% LVR at X%, X months. Running it now."

CRITICAL — BUTTON FORMAT RULES:
- Multiple choice options MUST be in square brackets like [Option 1] [Option 2] [Option 3]
- The frontend renders [text] patterns as clickable buttons
- Always present button options on the SAME LINE as the question
- Example: "LVR? [0% (self funded)] [60%] [70%] [100% (fully funded)] [Other]"

CALLING THE TOOL:
When you have ALL required inputs, call calculate_quick_feasibility immediately.
Pass EXACTLY what the user typed as raw strings. Always pass sellingCostsRaw: "3%".
If LVR is 0%, pass interestRateRaw: "0".

The backend handles ALL parsing and calculation. It returns a pre-formatted response.
Your ONLY job after calling the tool: display the formattedResponse VERBATIM.
Do NOT add to it, modify it, or recalculate anything.

REQUIRED INPUTS (must collect ALL before calling tool):
1. Purchase price / Land value
2. GRV (inc GST)
3. Construction cost (exc GST, lump sum)
4. GST scheme (and cost base if margin scheme)
5. Timeline in months
6. LVR
7. Interest rate (only if LVR > 0%)

SELLING COSTS: DO NOT ASK. Fixed at 3% (agent fees + marketing + legal). Always pass sellingCostsRaw: "3%".
SELL ON COMPLETION: Assumed. Selling period = 0 months. Do not ask about selling timeline.

RULES:
- NEVER assume construction costs, LVR, or timeline — always ask
- Selling costs are ALWAYS 3% — never ask
- One question per message
- Accept variations: "self funded" = 0% LVR, "18 months" = "18mo" = "18"
- If user says "margin" for GST, that means margin scheme
- When you have all inputs, call the tool immediately
- NEVER ask the same question twice
- Accept user corrections without questioning

WHEN YOU ARE UNCERTAIN:
1. If one missing variable would change the answer — ask for it
2. If user wants speed — provide a range with stated assumptions
3. If you genuinely can't give a reliable answer — say so and direct to the right professional

${contextSummary}`;
    
    // Build messages array with conversation history
    const messages = [];
    
    if (conversationHistory && Array.isArray(conversationHistory) && conversationHistory.length > 0) {
      console.log('[CLAUDE] Adding conversation history...');
      const recentHistory = conversationHistory.slice(-20);

      for (const msg of recentHistory) {
        // Validate message structure
        if (!msg || !msg.role || !msg.content) continue;
        if (msg.role !== 'user' && msg.role !== 'assistant') continue;

        if (typeof msg.content === 'string') {
          const trimmed = msg.content.trim();
          if (trimmed.length > 0) {
            messages.push({ role: msg.role, content: trimmed });
          }
        } else if (Array.isArray(msg.content)) {
          // Structured content (e.g., tool_result blocks) - pass through if valid
          const validBlocks = msg.content.filter(block =>
            block && typeof block === 'object' && block.type
          );
          if (validBlocks.length > 0) {
            messages.push({ role: msg.role, content: validBlocks });
          }
        }
        // Skip non-string, non-array content (objects, numbers, etc.)
      }

      console.log('[CLAUDE] Filtered history:', messages.length, 'messages');
    }
    
    const trimmedQuery = userQuery?.trim() || 'hello';
    messages.push({
      role: 'user',
      content: trimmedQuery
    });

    console.log('[CLAUDE] Sending request to Anthropic API...');
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: systemPrompt,
      tools,
      messages
    });

    console.log('[CLAUDE] Initial response received');
    console.log('[CLAUDE] Response content types:', response.content.map(c => c.type));

    const toolUse = response.content.find(c => c.type === 'tool_use');

    if (toolUse) {
      console.log('=====================================');
      console.log(`[CLAUDE] Tool called: ${toolUse.name}`);
      console.log(`[CLAUDE] Tool input:`, JSON.stringify(toolUse.input, null, 2));
      console.log('=====================================');

      let toolResult;

      // Handle property info tool
      if (toolUse.name === 'get_property_info') {
        const propertyQuery = toolUse.input.query;
        if (sendProgress) sendProgress(`📍 Accessing planning controls for ${propertyQuery}...`);
        const propertyData = await scrapeProperty(propertyQuery, sendProgress);

        if (propertyData.needsDisambiguation) {
          console.log('[CLAUDE] Disambiguation needed, asking user...');

          // Handle new multi-property disambiguation (multiple lots at same address)
          if (propertyData.disambiguationType === 'multiple_properties') {
            const optionLabels = ['A', 'B', 'C', 'D', 'E'];
            const propertyList = propertyData.properties
              .map((p, i) => `Option ${optionLabels[i]}: Lot ${p.lotplan} - ${p.areaDisplay} (${p.description})`)
              .join('\n');

            return {
              answer: `I found ${propertyData.properties.length} properties at this address:\n\n${propertyList}\n\nWhich property are you interested in? Please specify the option letter or lot/plan number.`,
              usedTool: 'get_property_info',
              propertyData: propertyData,
              disambiguationData: propertyData.properties
            };
          }

          // Handle old OSM-based disambiguation (multiple addresses)
          const suggestionsList = propertyData.suggestions
            .map((s, i) => `${i + 1}. ${s.address}`)
            .join('\n');

          return {
            answer: `I found a few properties matching that. Which one did you mean?\n\n${suggestionsList}`,
            usedTool: 'get_property_info',
            propertyData: null
          };
        }

        if (propertyData.addressNotFound) {
          console.log('[CLAUDE] Address not found:', propertyData.searchedAddress);
          
          const usefulSuggestions = (propertyData.suggestions || []).filter(s => {
            const addr = s.address || '';
            return /^\d+/.test(addr) && addr.includes(' ') && !addr.match(/^[A-Za-z\s,]+$/);
          });
          
          if (usefulSuggestions.length > 0) {
            const suggestionsList = usefulSuggestions
              .slice(0, 3)
              .map((s, i) => `${i + 1}. ${s.address}${s.lotplan ? ` (${s.lotplan})` : ''}`)
              .join('\n');
            
            return {
              answer: `I couldn't find "${propertyData.searchedAddress}" in the Gold Coast planning database.\n\nDid you mean one of these?\n\n${suggestionsList}\n\nOr try searching with the lot/plan number for more accurate results.`,
              usedTool: 'get_property_info',
              propertyData: null
            };
          }
          
          return {
            answer: `I couldn't find "${propertyData.searchedAddress}" in the Gold Coast planning database.\n\nThis address may not exist or could be registered under a different name. Try:\n\n- Adding the suburb: "120 Marine Parade, Coolangatta"\n- Using the lot/plan number from your rates notice\n- Checking Google Maps for the exact address format`,
            usedTool: 'get_property_info',
            propertyData: null
          };
        }

        console.log('[CLAUDE] Property data retrieved');

        if (sendProgress) sendProgress('✓ Located property - checking zoning controls...');
        console.log('[CLAUDE] Searching planning scheme database...');
        const planningContext = await searchPlanningScheme(toolUse.input.query, propertyData);
        console.log(`[CLAUDE] Found ${planningContext.length} relevant planning sections`);

        const zoneInfo = propertyData.property?.zone || 'zone';
        if (sendProgress) sendProgress(`✓ Found ${zoneInfo} - checking overlays...`);
        
        toolResult = {
          ...propertyData,
          planningSchemeContext: planningContext
        };
      }
      
      // Handle DA search tool - WITH CONTEXT AWARENESS
      else if (toolUse.name === 'search_development_applications') {
        if (sendProgress) sendProgress('🔍 Searching development applications...');

        // Build full address using context if suburb missing
        let searchAddress = toolUse.input.address;
        if (sendProgress) sendProgress(`🔍 Searching development applications for ${searchAddress}...`);
        const inputSuburb = toolUse.input.suburb;

        // Check if address already has a Gold Coast suburb
        const hasSuburb = /(?:mermaid|broadbeach|surfers|southport|palm beach|burleigh|robina|varsity|hope island|coolangatta|currumbin|tugun|miami|nobby|runaway bay|sanctuary cove|main beach|labrador|arundel|ashmore|benowa|biggera waters|bundall|carrara|clear island|coombabah|coomera|elanora|helensvale|highland park|hollywell|mudgeeraba|nerang|ormeau|oxenford|pacific pines|paradise point|parkwood|reedy creek|tallebudgera|upper coomera|worongary|springbrook|pimpama|molendinar|merrimac)/i.test(searchAddress);

        if (!hasSuburb) {
          // Try to add suburb from input or context
          const suburb = inputSuburb || conversationContext.lastSuburb;
          if (suburb) {
            searchAddress = `${searchAddress}, ${suburb}`;
            console.log(`[CLAUDE] Added suburb from context: ${searchAddress}`);
          }
        }

        console.log('[CLAUDE] Searching DAs for:', searchAddress);

        try {
          const { scrapeGoldCoastDAs } = await import('./pdonline-scraper.js');
          const daResult = await scrapeGoldCoastDAs(
            searchAddress,
            toolUse.input.months_back || 12
          );

          console.log(`[CLAUDE] Found ${daResult.count} DAs`);
          const daCountMsg = daResult.count === 0 ? 'No applications found'
            : daResult.count === 1 ? '✓ Found 1 development application'
            : `✓ Found ${daResult.count} development applications`;
          if (sendProgress) sendProgress(daCountMsg);

          toolResult = daResult;
        } catch (daError) {
          console.error('[CLAUDE] DA search failed:', daError.message);

          toolResult = {
            success: false,
            count: 0,
            applications: [],
            error: daError.message,
            errorType: 'DA_SEARCH_FAILED'
          };

          if (sendProgress) sendProgress('⚠️ DA search encountered an issue');
        }
      }

      // Handle DA decision notice download tool
      else if (toolUse.name === 'get_da_decision_notice') {
        if (sendProgress) sendProgress('📄 Downloading decision notice...');

        const appNumber = toolUse.input.application_number;

        try {
          const { getDecisionNotice } = await import('./pdonline-documents.js');
          const docResult = await getDecisionNotice(appNumber, '/tmp');

          if (docResult.success) {
            if (sendProgress) sendProgress(docResult.isSigned ? '✅ Analyzing signed decision notice...' : '⚠️ Analyzing unsigned decision notice...');

            // Read PDF and analyze with Claude
            const fs = await import('fs');
            const pdfBuffer = fs.readFileSync(docResult.filePath);
            const base64Pdf = pdfBuffer.toString('base64');

            try {
              const analysisResponse = await anthropic.messages.create({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 4000,
                messages: [{
                  role: 'user',
                  content: [
                    {
                      type: 'document',
                      source: {
                        type: 'base64',
                        media_type: 'application/pdf',
                        data: base64Pdf
                      }
                    },
                    {
                      type: 'text',
                      text: `Analyze this decision notice and provide a structured summary in the following format:

1. Start with the application number as a header
2. Write an opening paragraph explaining what this application is about and what it approves
3. Add a "Key Changes Approved:" section that lists the main categories of changes
4. For each major category, use a clear header followed by bullet points with " - " prefix
5. Common categories to look for:
   - Mixed Use Authorization or Use Changes
   - Major Infrastructure Requirements
   - Operational Controls or Restrictions
   - Pre-Commencement Requirements
6. End with a summary paragraph explaining the significance

CRITICAL FORMATTING:
- Use double line breaks (\\n\\n) between major sections
- Use single line break (\\n) between bullet points within a section
- Start each bullet point with " - " (space, dash, space)
- Keep paragraphs concise (2-4 sentences)

Focus on conditions that affect:
- How the property can be used
- Required infrastructure or parking
- Operational restrictions (hours, vehicle access, etc.)
- What must be completed before operation
- Any significant amenities or requirements

Be specific with numbers, hours, and requirements. Avoid generic statements.

CRITICAL WARNING - DO NOT CONFUSE DA APPROVALS WITH PLANNING CONTROLS:
- This DA shows what was APPROVED for this specific application
- It does NOT change the underlying planning scheme controls (zone, height, density)
- Example: If DA approves "45m building height", that's the APPROVED height for THIS project
- The underlying City Plan control might still be "HX" - the DA achieved a variation
- Never refer to DA-approved specs as if they're the planning scheme controls`
                    }
                  ]
                }]
              });

              const summary = analysisResponse.content.find(c => c.type === 'text')?.text || 'Could not analyze document';
              if (sendProgress) sendProgress('✅ Analysis complete');

              toolResult = {
                success: true,
                application_number: appNumber,
                filename: docResult.filename,
                file_path: docResult.filePath,
                file_size_kb: docResult.fileSizeKB,
                is_signed: docResult.isSigned,
                document_name: docResult.documentName,
                warning: docResult.warning,
                summary: summary  // The analyzed summary
              };
            } catch (analysisError) {
              console.error('[CLAUDE] PDF analysis failed:', analysisError.message);
              // Still return success with file info, but note analysis failed
              toolResult = {
                success: true,
                application_number: appNumber,
                filename: docResult.filename,
                file_path: docResult.filePath,
                file_size_kb: docResult.fileSizeKB,
                is_signed: docResult.isSigned,
                document_name: docResult.documentName,
                warning: docResult.warning,
                summary: 'PDF analysis failed - document downloaded but could not be analyzed',
                analysis_error: analysisError.message
              };
            }
          } else {
            console.error('[CLAUDE] Decision notice download failed:', docResult.error);
            toolResult = {
              success: false,
              error: docResult.error,
              application_number: appNumber
            };
            if (sendProgress) sendProgress('⚠️ Could not find decision notice');
          }
        } catch (docError) {
          console.error('[CLAUDE] Decision notice download error:', docError.message);
          toolResult = {
            success: false,
            error: docError.message,
            errorType: 'DOCUMENT_DOWNLOAD_FAILED',
            application_number: appNumber
          };
          if (sendProgress) sendProgress('⚠️ Document download failed');
        }
      }

      // Handle clarification tool
      else if (toolUse.name === 'ask_clarification') {
        console.log('[CLAUDE] Clarification needed:', toolUse.input);
        
        let clarificationMessage = '';
        
        if (toolUse.input.clarificationType === 'choice_needed') {
          const optionsList = toolUse.input.options?.map((opt, i) => `${i + 1}. ${opt}`).join('\n') || '';
          clarificationMessage = `${toolUse.input.originalQuestion}\n\nPlease choose:\n${optionsList}`;
        } 
        else if (toolUse.input.clarificationType === 'value_verification') {
          clarificationMessage = `Just checking - you said ${toolUse.input.suspiciousValue}. ${toolUse.input.expectedRange ? `Typical range for this area would be ${toolUse.input.expectedRange}.` : ''} Did you mean that figure, or was it a typo?`;
        }
        else {
          clarificationMessage = toolUse.input.originalQuestion;
        }
        
        return {
          answer: clarificationMessage,
          usedTool: 'ask_clarification',
          propertyData: null,
          needsClarification: true
        };
      }
      
      // Handle start feasibility tool
      else if (toolUse.name === 'start_feasibility') {
        console.log('[CLAUDE] Starting feasibility analysis, mode:', toolUse.input.mode);
        const feasPropertyAddr = toolUse.input.propertyAddress || conversationContext.lastProperty || 'property';
        if (sendProgress) sendProgress(`📊 Preparing feasibility analysis for ${feasPropertyAddr}...`);
        
        const { getDetailedFeasibilityPreFill } = await import('./feasibility-calculator.js');
        
        // Use context to fill in missing data
        const propertyData = {
          property: {
            address: toolUse.input.propertyAddress || conversationContext.lastProperty,
            area: toolUse.input.siteArea ? `${toolUse.input.siteArea}sqm` : (conversationContext.lastSiteArea ? `${conversationContext.lastSiteArea}sqm` : null),
            density: toolUse.input.densityCode || conversationContext.lastDensity,
            height: toolUse.input.heightLimit || conversationContext.lastHeight,
            zone: toolUse.input.zone || conversationContext.lastZone,
          }
        };
        
        const preFillData = getDetailedFeasibilityPreFill(propertyData);
        const mode = toolUse.input.mode || 'selection';
        
        // Include development context
        const developmentType = toolUse.input.developmentType || conversationContext.developmentStrategy || 'unknown';
        const existingUnits = toolUse.input.existingUnits || conversationContext.existingUnits;
        const isStrata = toolUse.input.isStrata || conversationContext.isStrata;
        
        toolResult = {
          success: true,
          feasibilityMode: mode,
          propertyAddress: toolUse.input.propertyAddress,
          preFill: preFillData.preFill || {},
          constraints: preFillData.constraints || {},
          developmentContext: {
            developmentType,
            existingUnits,
            isStrata,
            isRenovation: developmentType === 'renovation'
          },
          message: mode === 'detailed' 
            ? 'Opening detailed feasibility calculator' 
            : mode === 'quick'
            ? 'Starting quick feasibility analysis'
            : 'Choose quick or detailed analysis'
        };
      }
      
  // Handle quick feasibility calculation — DRAFT-DRIVEN ENGINE
else if (toolUse.name === 'calculate_quick_feasibility') {
  console.log('[FEASO] ========== QUICK FEASIBILITY START (DRAFT-DRIVEN) ==========');
  console.log('[FEASO] Raw inputs from Claude:', JSON.stringify(toolUse.input, null, 2));

  if (sendProgress) sendProgress('🔢 Parsing inputs...');

  const input = toolUse.input;
  const address = input.propertyAddress || conversationContext.lastProperty || '';
  const mode = input.mode || 'standard';

  try {
    // STEP 1: Patch Claude's tool args into the draft store (if conversationId exists)
    if (conversationId) {
      const draftPatch = { inputs: {}, rawInputs: {} };
      const fieldMap = {
        purchasePriceRaw: 'purchasePrice',
        grvRaw: 'grv',
        constructionCostRaw: 'constructionCost',
        lvrRaw: 'lvr',
        interestRateRaw: 'interestRate',
        timelineRaw: 'timelineMonths',
        sellingCostsRaw: 'sellingCostsPercent',
        gstSchemeRaw: 'gstScheme',
        gstCostBaseRaw: 'gstCostBase'
      };

      for (const [rawKey, parsedKey] of Object.entries(fieldMap)) {
        if (input[rawKey]) {
          draftPatch.rawInputs[rawKey] = input[rawKey];
          const parsed = parseInputValue(parsedKey, input[rawKey]);
          if (parsed !== null && parsed !== undefined) {
            draftPatch.inputs[parsedKey] = parsed;
          }
        }
      }

      // Handle gstCostBase "same as acquisition"
      if (input.gstCostBaseRaw) {
        const lower = input.gstCostBaseRaw.toLowerCase();
        if (lower.includes('same') || lower.includes('acquisition')) {
          const pp = draftPatch.inputs.purchasePrice || getDraft(conversationId)?.inputs?.purchasePrice;
          if (pp) draftPatch.inputs.gstCostBase = pp;
        }
      }

      if (address) {
        draftPatch.property = { address };
      }

      patchDraft(conversationId, draftPatch, 'chat');
      console.log('[FEASO] Draft patched with Claude tool args');
    }

    // STEP 2: Calculate — uses ONLY Claude's tool args + scoped conversation extraction
    // Conversation extraction is now scoped to the most recent feaso session
    let result;
    const fullHistory = [
      ...(conversationHistory || []),
      { role: 'user', content: userQuery }
    ];

    if (mode === 'residual') {
      if (sendProgress) sendProgress('📊 Calculating residual land value...');
      result = runResidualAnalysis(input, address, null, fullHistory);
    } else {
      if (sendProgress) sendProgress('📊 Crunching the numbers...');
      result = runQuickFeasibility(input, address, fullHistory);
    }

    if (!result) {
      throw new Error('Feasibility engine returned no result');
    }

    if (result.validationErrors) {
      console.log('[FEASO] Validation failed — missing inputs:', result.validationErrors);
      if (sendProgress) sendProgress('⚠️ Missing required inputs');
      toolResult = {
        success: false,
        feasibilityMode: 'results',
        formattedResponse: result.formattedResponse,
        calculationData: result.calculationData,
        parsedInputs: result.parsedInputs
      };
    } else {
      if (sendProgress) sendProgress('✅ Feasibility calculated');

      console.log('[FEASO] ========== RESULTS ==========');
      console.log('[FEASO] Address used:', address);
      console.log('[FEASO] Profit:', result.calculationData.profitability.grossProfit);
      console.log('[FEASO] Margin:', result.calculationData.profitability.profitMargin + '%');
      console.log('[FEASO] Viability:', result.calculationData.profitability.viabilityLabel);
      console.log('[FEASO] ========== END ==========');

      // Update draft with results
      if (conversationId) {
        const draft = getDraft(conversationId);
        if (draft) {
          draft.results = result.calculationData;
          draft.lastCalculatedAt = new Date().toISOString();
          draft.status = 'calculated';
        }
      }

      toolResult = {
        success: true,
        feasibilityMode: 'results',
        formattedResponse: result.formattedResponse,
        calculationData: result.calculationData,
        parsedInputs: result.parsedInputs
      };
    }
  } catch (calcError) {
    console.error('[FEASO] Calculation error:', calcError.message);
    console.error('[FEASO] Stack:', calcError.stack);
    toolResult = {
      success: false,
      error: calcError.message,
      formattedResponse: 'I couldn\'t calculate the feasibility with those inputs. Could you double-check the numbers and try again?'
    };
  }
}
      // ============================================================
      // FEASIBILITY: Return pre-formatted response directly
      // DO NOT send back to Claude - this eliminates hallucination
      // ============================================================
      if (toolUse.name === 'calculate_quick_feasibility' && toolResult?.formattedResponse) {
        console.log('[CLAUDE] Returning pre-formatted feasibility response (bypassing Claude)');

        // Parse button options from the formatted response
        const buttonOptions = parseButtonOptions(toolResult.formattedResponse);
        const questionContext = buttonOptions ? detectQuestionContext(toolResult.formattedResponse, buttonOptions) : null;

        // Include draft for progressive panel fill
        const feasoDraft = conversationId ? getDraft(conversationId) : null;

        // ============================================================
        // BUILD CALCULATOR FIELDS — authoritative, flat field mapping
        // The frontend should use this to REPLACE all form fields when
        // status === 'calculated'. This eliminates field mapping bugs
        // caused by progressive fill or name mismatches.
        // ============================================================
        let calculatorFields = null;
        if (toolResult.success && toolResult.calculationData && feasoDraft) {
          const calc = toolResult.calculationData;
          const defaults = getDefaultAssumptions();
          calculatorFields = {
            // --- Property fields ---
            propertyAddress: feasoDraft.property.address || '',
            siteArea: feasoDraft.property.siteAreaSqm ? String(feasoDraft.property.siteAreaSqm) : '',
            densityCode: feasoDraft.property.density || '',
            heightLimit: feasoDraft.property.heightM ? String(feasoDraft.property.heightM) : '',
            zone: feasoDraft.property.zone || '',
            lotPlan: feasoDraft.property.lotPlan || '',

            // --- Core inputs (from calculation — authoritative values) ---
            purchasePrice: String(calc.inputs.landValue || 0),
            landValue: String(calc.inputs.landValue || 0),
            grvInclGST: String(calc.inputs.grvTotal || 0),
            constructionCost: String(calc.inputs.constructionCost || 0),
            lvr: String(calc.inputs.lvr ?? 0),
            interestRate: String(calc.inputs.interestRate ?? 0),
            totalMonths: String(calc.inputs.timelineMonths || 0),
            agentFeesPercent: String(calc.inputs.sellingCostsPercent || 3),
            gstScheme: calc.inputs.gstScheme || 'margin',
            gstCostBase: String(calc.inputs.gstCostBase || 0),

            // --- Assumptions (defaults — always populated) ---
            contingencyPercent: String(calc.inputs.appliedContingency ?? defaults.contingencyPercent),
            profFeesPercent: String(defaults.profFeesPercent),
            statutoryFeesPercent: String(defaults.statutoryFeesPercent),
            pmFeesPercent: String(defaults.pmFeesPercent),
            sellingCostsPercent: String(calc.inputs.sellingCostsPercent || defaults.sellingCostsPercent || 3),
            sellingAgentFeesPercent: String(defaults.agentFeesPercent),
            marketingPercent: String(defaults.marketingPercent),
            legalSellingPercent: String(defaults.legalSellingPercent),
            sellOnCompletion: 'true',   // Always sell on completion
            insurancePercent: String(defaults.insurancePercent),
            drawdownProfile: defaults.drawdownProfile,
            targetMarginSmall: String(defaults.targetDevMarginSmall),
            targetMarginMid: String(defaults.targetDevMarginMid),
            targetMarginLarge: String(defaults.targetDevMarginLarge),
            targetDevMargin: String(calc.profitability.targetMargin),

            // --- Holding costs (auto-calculated) ---
            landTaxAnnual: String(calc.holdingBreakdown?.landTaxYearly || feasoDraft.holdingCosts?.landTaxAnnual || 0),
            councilRatesAnnual: String(calc.holdingBreakdown?.councilRatesAnnual || defaults.councilRatesAnnual),
            waterRatesAnnual: String(calc.holdingBreakdown?.waterRatesAnnual || defaults.waterRatesAnnual),
            insuranceAnnual: String(calc.holdingBreakdown?.insuranceAnnual || 0),
            totalHoldingAnnual: String(calc.holdingBreakdown?.totalYearly || 0),
            totalHoldingProject: String(calc.costs?.holding || 0),

            // --- Timeline breakdown ---
            leadInMonths: String(calc.timeline?.leadIn || 0),
            constructionMonths: String(calc.timeline?.construction || 0),
            sellingMonths: '0',   // Sell on completion — 0 month selling period

            // --- Finance ---
            loanFee: String(calc.costs?.loanFee || 0),
            financeCosts: String(calc.costs?.finance || 0)
          };
          console.log('[FEASO] Built calculatorFields for frontend');
        }

        return {
          answer: toolResult.formattedResponse,
          propertyData: null,
          feasibilityData: {
            success: toolResult.success,
            feasibilityMode: 'results',
            calculationData: toolResult.calculationData,
            parsedInputs: toolResult.parsedInputs
          },
          feasibilityPreFill: feasoDraft,
          calculatorFields: calculatorFields,
          buttonOptions: buttonOptions,
          questionContext: questionContext,
          usedTool: true,
          toolName: toolUse.name,
          toolQuery: toolUse.input.propertyAddress
        };
      }

      // ============================================================
      // ALL OTHER TOOLS: Send result back to Claude for interpretation
      // Handle follow-up tool calls in a loop (e.g. property lookup → start_feasibility → text)
      // ============================================================
      let loopMessages = [
        ...messages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(toolResult, null, 2) }] }
      ];

      let allTextParts = [];
      let latestPropertyData = toolUse.name === 'get_property_info' ? toolResult : null;
      let latestFeasibilityData = null;
      let latestDaData = toolUse.name === 'search_development_applications' ? toolResult : null;
      let latestToolName = toolUse.name;
      const MAX_TOOL_LOOPS = 4;

      for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
        console.log(`[CLAUDE] Tool loop ${loop + 1}/${MAX_TOOL_LOOPS}`);

        const loopResponse = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 2000,
          system: systemPrompt,
          tools,
          messages: loopMessages
        });

        console.log('[CLAUDE] Loop response types:', loopResponse.content.map(c => c.type));
        console.log('[CLAUDE] Loop stop_reason:', loopResponse.stop_reason);

        // Collect text from this response
        const textBlock = loopResponse.content.find(c => c.type === 'text');
        if (textBlock?.text?.trim()) {
          allTextParts.push(textBlock.text.trim());
        }

        // Check for follow-up tool call
        const nextTool = loopResponse.content.find(c => c.type === 'tool_use');

        if (!nextTool) {
          // No more tools — we have our final text response
          console.log('[CLAUDE] No more tool calls, returning text');
          break;
        }

        console.log(`[CLAUDE] Follow-up tool: ${nextTool.name}`);

        let nextResult;

        // Handle calculate_quick_feasibility — BYPASS (return immediately)
        if (nextTool.name === 'calculate_quick_feasibility') {
          console.log('[CLAUDE] Follow-up: calculate_quick_feasibility — bypassing');
          const fInput = nextTool.input;
          const fAddress = fInput.propertyAddress || conversationContext.lastProperty || '';
          const fMode = fInput.mode || 'standard';

          try {
            // Patch draft with Claude's tool args (follow-up path)
            if (conversationId) {
              const draftPatch = { inputs: {}, rawInputs: {} };
              const fFieldMap = {
                purchasePriceRaw: 'purchasePrice', grvRaw: 'grv', constructionCostRaw: 'constructionCost',
                lvrRaw: 'lvr', interestRateRaw: 'interestRate', timelineRaw: 'timelineMonths',
                sellingCostsRaw: 'sellingCostsPercent', gstSchemeRaw: 'gstScheme', gstCostBaseRaw: 'gstCostBase'
              };
              for (const [rawKey, parsedKey] of Object.entries(fFieldMap)) {
                if (fInput[rawKey]) {
                  draftPatch.rawInputs[rawKey] = fInput[rawKey];
                  const parsed = parseInputValue(parsedKey, fInput[rawKey]);
                  if (parsed !== null && parsed !== undefined) draftPatch.inputs[parsedKey] = parsed;
                }
              }
              if (fAddress) draftPatch.property = { address: fAddress };
              patchDraft(conversationId, draftPatch, 'chat');
            }

            const fullHistory = [...(conversationHistory || []), { role: 'user', content: userQuery }];
            let fResult;
            if (fMode === 'residual') {
              fResult = runResidualAnalysis(fInput, fAddress, null, fullHistory);
            } else {
              fResult = runQuickFeasibility(fInput, fAddress, fullHistory);
            }

            // Update draft with results
            if (conversationId) {
              const draft = getDraft(conversationId);
              if (draft && fResult?.calculationData) {
                draft.results = fResult.calculationData;
                draft.lastCalculatedAt = new Date().toISOString();
                draft.status = 'calculated';
              }
            }

            // Combine earlier text with feasibility response
            const preText = allTextParts.length > 0 ? allTextParts.join('\n\n') + '\n\n' : '';
            const fButtonOptions = parseButtonOptions(fResult.formattedResponse);
            const fQuestionContext = fButtonOptions ? detectQuestionContext(fResult.formattedResponse, fButtonOptions) : null;
            const feasoDraft = conversationId ? getDraft(conversationId) : null;

            // Build calculatorFields for follow-up path too
            let fCalcFields = null;
            if (fResult.calculationData && feasoDraft) {
              const fCalc = fResult.calculationData;
              const fDefaults = getDefaultAssumptions();
              fCalcFields = {
                propertyAddress: feasoDraft.property.address || '',
                siteArea: feasoDraft.property.siteAreaSqm ? String(feasoDraft.property.siteAreaSqm) : '',
                densityCode: feasoDraft.property.density || '',
                heightLimit: feasoDraft.property.heightM ? String(feasoDraft.property.heightM) : '',
                zone: feasoDraft.property.zone || '',
                lotPlan: feasoDraft.property.lotPlan || '',
                purchasePrice: String(fCalc.inputs.landValue || 0),
                landValue: String(fCalc.inputs.landValue || 0),
                grvInclGST: String(fCalc.inputs.grvTotal || 0),
                constructionCost: String(fCalc.inputs.constructionCost || 0),
                lvr: String(fCalc.inputs.lvr ?? 0),
                interestRate: String(fCalc.inputs.interestRate ?? 0),
                totalMonths: String(fCalc.inputs.timelineMonths || 0),
                agentFeesPercent: String(fCalc.inputs.sellingCostsPercent || 3),
                gstScheme: fCalc.inputs.gstScheme || 'margin',
                gstCostBase: String(fCalc.inputs.gstCostBase || 0),
                contingencyPercent: String(fCalc.inputs.appliedContingency ?? fDefaults.contingencyPercent),
                profFeesPercent: String(fDefaults.profFeesPercent),
                statutoryFeesPercent: String(fDefaults.statutoryFeesPercent),
                pmFeesPercent: String(fDefaults.pmFeesPercent),
                sellingAgentFeesPercent: String(fDefaults.agentFeesPercent),
                marketingPercent: String(fDefaults.marketingPercent),
                legalSellingPercent: String(fDefaults.legalSellingPercent),
                insurancePercent: String(fDefaults.insurancePercent),
                drawdownProfile: fDefaults.drawdownProfile,
                targetMarginSmall: String(fDefaults.targetDevMarginSmall),
                targetMarginMid: String(fDefaults.targetDevMarginMid),
                targetMarginLarge: String(fDefaults.targetDevMarginLarge),
                targetDevMargin: String(fCalc.profitability.targetMargin),
                landTaxAnnual: String(fCalc.holdingBreakdown?.landTaxYearly || 0),
                councilRatesAnnual: String(fCalc.holdingBreakdown?.councilRatesAnnual || fDefaults.councilRatesAnnual),
                waterRatesAnnual: String(fCalc.holdingBreakdown?.waterRatesAnnual || fDefaults.waterRatesAnnual),
                insuranceAnnual: String(fCalc.holdingBreakdown?.insuranceAnnual || 0),
                totalHoldingAnnual: String(fCalc.holdingBreakdown?.totalYearly || 0),
                totalHoldingProject: String(fCalc.costs?.holding || 0),
                leadInMonths: String(fCalc.timeline?.leadIn || 0),
                constructionMonths: String(fCalc.timeline?.construction || 0),
                sellingMonths: '0',   // Sell on completion — 0 month selling period
                loanFee: String(fCalc.costs?.loanFee || 0),
                financeCosts: String(fCalc.costs?.finance || 0)
              };
            }

            return {
              answer: preText + fResult.formattedResponse,
              propertyData: latestPropertyData,
              feasibilityData: {
                success: true,
                feasibilityMode: 'results',
                calculationData: fResult.calculationData,
                parsedInputs: fResult.parsedInputs
              },
              feasibilityPreFill: feasoDraft,
              calculatorFields: fCalcFields,
              buttonOptions: fButtonOptions,
              questionContext: fQuestionContext,
              usedTool: true,
              toolName: nextTool.name,
              toolQuery: fInput.propertyAddress
            };
          } catch (calcError) {
            console.error('[CLAUDE] Follow-up feasibility error:', calcError.message);
            nextResult = { success: false, error: calcError.message };
          }
        }

        // Handle ask_clarification — return immediately
        else if (nextTool.name === 'ask_clarification') {
          let clarMsg = nextTool.input.originalQuestion;
          if (nextTool.input.clarificationType === 'choice_needed') {
            const opts = nextTool.input.options?.map((o, i) => `${i + 1}. ${o}`).join('\n') || '';
            clarMsg = `${nextTool.input.originalQuestion}\n\nPlease choose:\n${opts}`;
          }
          const preText = allTextParts.length > 0 ? allTextParts.join('\n\n') + '\n\n' : '';
          return {
            answer: preText + clarMsg,
            propertyData: latestPropertyData,
            usedTool: 'ask_clarification',
            needsClarification: true
          };
        }

        // Handle start_feasibility
        else if (nextTool.name === 'start_feasibility') {
          const fesoMode = nextTool.input.mode || 'selection';
          nextResult = {
            success: true,
            feasibilityMode: fesoMode,
            propertyAddress: nextTool.input.propertyAddress,
            message: fesoMode === 'detailed'
              ? 'Opening detailed feasibility calculator'
              : fesoMode === 'quick'
              ? 'Starting quick feasibility analysis'
              : 'Choose quick or detailed analysis'
          };
          latestFeasibilityData = nextResult;
          latestToolName = 'start_feasibility';
        }

        // Handle get_property_info
        else if (nextTool.name === 'get_property_info') {
          try {
            if (sendProgress) sendProgress('📍 Accessing Gold Coast City Plan...');
            const propData = await scrapeProperty(nextTool.input.query, sendProgress);
            nextResult = propData;
            latestPropertyData = propData;
            latestToolName = 'get_property_info';
          } catch (e) {
            nextResult = { error: e.message };
          }
        }

        // Any other tool — provide simple result
        else {
          nextResult = { success: true, message: 'Processed' };
          latestToolName = nextTool.name;
        }

        // Add exchange to messages for next iteration
        loopMessages.push(
          { role: 'assistant', content: loopResponse.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: nextTool.id, content: JSON.stringify(nextResult, null, 2) }] }
        );
      }

      // Build final response from collected text
      const combinedText = allTextParts.join('\n\n');
      const isPropertyAnalysis = latestToolName === 'get_property_info';
      const isFeasibility = latestToolName === 'start_feasibility';

      let formattedAnswer = isPropertyAnalysis
        ? stripMarkdown(combinedText)
        : formatIntoParagraphs(stripMarkdown(combinedText));

      formattedAnswer = fixBulletPoints(formattedAnswer);

      const buttonOptions = parseButtonOptions(formattedAnswer);
      const questionContext = buttonOptions ? detectQuestionContext(formattedAnswer, buttonOptions) : null;

      // Build progressive feasibility pre-fill if in feaso flow
      let feasibilityPreFill = null;
      if (conversationId && (isFeasibility || detectFeasibilityFlow(conversationHistory))) {
        feasibilityPreFill = buildFeasibilityPreFill(
          [...(conversationHistory || []), { role: 'user', content: userQuery }],
          conversationContext,
          conversationId
        );
      }

      // If property was just looked up, update the draft with property data
      if (conversationId && latestPropertyData?.success && latestPropertyData?.property) {
        const prop = latestPropertyData.property;
        patchDraft(conversationId, {
          property: {
            address: prop.address,
            lotPlan: prop.lotplan,
            siteAreaSqm: prop.area ? parseInt(String(prop.area).replace(/[^\d]/g, '')) : null,
            zone: prop.zone,
            density: prop.density,
            heightM: prop.height ? parseInt(String(prop.height).replace(/[^\d]/g, '')) : null,
            overlays: prop.overlays
          }
        }, 'property_tool');
      }

      return {
        answer: formattedAnswer || 'Unable to generate response',
        propertyData: latestPropertyData,
        daData: latestDaData,
        feasibilityData: latestFeasibilityData,
        feasibilityPreFill: feasibilityPreFill,
        buttonOptions: buttonOptions,
        questionContext: questionContext,
        usedTool: true,
        toolName: latestToolName,
        toolQuery: toolUse.input.query || toolUse.input.address || toolUse.input.propertyAddress
      };
    } else {
      console.log('[CLAUDE] Answered without tool use');

      const textContent = response.content.find(c => c.type === 'text');

      // Format and fix bullet points for non-tool responses too
      let formattedAnswer = formatIntoParagraphs(stripMarkdown(textContent?.text));
      formattedAnswer = fixBulletPoints(formattedAnswer);

      // Parse button options from the response (for feasibility questions)
      const buttonOptions = parseButtonOptions(formattedAnswer);
      const questionContext = buttonOptions ? detectQuestionContext(formattedAnswer, buttonOptions) : null;

      // Build progressive feasibility pre-fill if in feaso flow (no-tool path)
      let feasibilityPreFill = null;
      if (conversationId && detectFeasibilityFlow(conversationHistory)) {
        feasibilityPreFill = buildFeasibilityPreFill(
          [...(conversationHistory || []), { role: 'user', content: userQuery }],
          conversationContext,
          conversationId
        );
      }

      return {
        answer: formattedAnswer || 'Unable to generate response',
        propertyData: null,
        feasibilityPreFill: feasibilityPreFill,
        buttonOptions: buttonOptions,
        questionContext: questionContext,
        usedTool: false
      };
    }

  } catch (error) {
    console.error('[CLAUDE ERROR]', error.message);
    console.error('[CLAUDE ERROR STACK]', error.stack);
    
    if (error.message.includes('Scraping failed') || 
        error.message.includes('Timeout') ||
        error.message.includes('BrowserBase') ||
        error.message.includes('PDOnline') ||
        error.message.includes('ECONNREFUSED') ||
        error.message.includes('ETIMEDOUT')) {
      return {
        answer: "I'm having trouble connecting to the council database right now. This happens occasionally when the service is busy. Could you try asking again?",
        propertyData: null,
        usedTool: false,
        error: error.message
      };
    }
    
    if (error.message.includes('529') || 
        error.message.includes('overloaded') ||
        error.message.includes('rate_limit')) {
      return {
        answer: "I'm experiencing high demand right now. Please try again in a moment.",
        propertyData: null,
        usedTool: false,
        error: error.message
      };
    }
    
    return {
      answer: "Something went wrong on my end. Could you try rephrasing your question or try again?",
      propertyData: null,
      usedTool: false,
      error: error.message
    };
  }
}

/**
 * Direct Claude query without function calling
 */
export async function simpleQuery(userQuery) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are Dev.i, an AI-powered property development advisor for the Gold Coast. Answer concisely in plain text, no markdown. NEVER invent market prices, statistics, or construction cost estimates - only discuss planning controls and regulations. Refer users to appropriate professionals (QS, valuer, town planner) for anything outside planning data: ${userQuery}`
      }]
    });

    const textContent = response.content.find(c => c.type === 'text');
    return textContent?.text || 'Unable to generate response';

  } catch (error) {
    console.error('[CLAUDE ERROR]', error);
    throw new Error(`Query failed: ${error.message}`);
  }
}
