// services/claude.js
import Anthropic from '@anthropic-ai/sdk';
import { scrapeProperty } from './goldcoast-api.js';
import { searchPlanningScheme } from './rag-simple.js';
import { getDetailedFeasibilityPreFill } from './feasibility-calculator.js';
import { runQuickFeasibility, runResidualAnalysis } from './quick-feasibility-engine.js';

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
      const heightMatch = content.match(/(\d+)\s*m(?:etre)?s?\s*(?:height|tall)/i);
      if (heightMatch && !context.lastHeight) {
        context.lastHeight = `${heightMatch[1]}m`;
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
  
  const systemPrompt = `You are Dev.i, a friendly Gold Coast property development advisor.

RIGHT NOW you're just having a casual chat - no property analysis needed.${contextNote}

RULES FOR THIS RESPONSE:
- Keep it short and friendly (1-3 sentences max)
- Sound like a sharp mate, not a robot or a report
- If they seem ready to work, invite them to drop an address
- Never say "I don't have access to" or apologise for limitations
- Never use bullet points, asterisks, or markdown formatting
- Never offer to do things you can't do

Examples of good responses:
- "how are you" → "Good — ready when you are. Got a site in mind?"
- "thanks" → "No worries. Shout if you need anything else."
- "what can you do" → "I pull zoning, overlays, nearby DAs, and run quick feasos for Gold Coast sites. Drop an address when you're ready."
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
 */
export async function getAdvisory(userQuery, conversationHistory = [], sendProgress = null) {
  try {
    console.log('=====================================');
    console.log('[CLAUDE] New advisory request');
    console.log('[CLAUDE] User query:', userQuery);
    console.log('[CLAUDE] Conversation history length:', conversationHistory?.length || 0);
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
Example: User said "80%" → lvrRaw: "80%" (not 80)`,
  input_schema: {
    type: 'object',
    properties: {
      propertyAddress: { type: 'string', description: 'Property address from conversation context' },
      purchasePriceRaw: { type: 'string', description: 'EXACT user input for purchase price. e.g. "$10M", "$5,000,000", "5 million"' },
      grvRaw: { type: 'string', description: 'EXACT user input for GRV. e.g. "$45M", "$12,333,333", "70 million"' },
      constructionCostRaw: { type: 'string', description: 'EXACT user input for construction cost. e.g. "$10M", "$10,000,000"' },
      lvrRaw: { type: 'string', description: 'EXACT user input for LVR (debt percentage). e.g. "80%", "70", "100% debt", "no debt", "fully funded". If user says "100%" or "fully funded 100%" pass exactly that. If user says "no debt" or "cash" pass that.' },
      interestRateRaw: { type: 'string', description: 'EXACT user input for interest rate. e.g. "8.5", "7.0%", "6.5 percent"' },
      timelineRaw: { type: 'string', description: 'EXACT user input for timeline. e.g. "18", "24 months", "2 years"' },
      sellingCostsRaw: { type: 'string', description: 'EXACT user input for selling costs. e.g. "3%", "4"' },
      gstSchemeRaw: { type: 'string', description: 'EXACT user input for GST. e.g. "margin scheme", "fully taxed"' },
      gstCostBaseRaw: { type: 'string', description: 'EXACT user input for GST cost base. e.g. "same as acquisition", "$5M"' },
      mode: { type: 'string', enum: ['standard', 'residual'], description: 'standard = full feasibility with land price. residual = calculate max land price.' }
    },
    required: ['purchasePriceRaw', 'grvRaw', 'constructionCostRaw', 'lvrRaw', 'interestRateRaw', 'timelineRaw', 'sellingCostsRaw', 'gstSchemeRaw']
  }
}
    ];

    // Build context-aware system prompt
    const contextSummary = buildContextSummary(conversationContext);
    
const systemPrompt = `You are Dev.i, a friendly Gold Coast property development advisor.

*** CRITICAL WARNING - ACID SULFATE SOILS ARE NOT FLOOD ZONES ***
The overlays "Land at or below 5m AHD" and "Land at or below 20m AHD" are ACID SULFATE SOIL overlays.
They have NOTHING to do with flooding. AHD = Australian Height Datum (elevation measurement).
NEVER say a property is in a flood zone because of these overlays.
NEVER mention flood risk, storm surge, or coastal flooding when discussing AHD overlays.
These overlays only concern soil chemistry during excavation.
***

TOOL USAGE RULES (CRITICAL):
- ONLY use tools when the user is asking about a SPECIFIC PROPERTY with an address or lot/plan
- NEVER use get_property_info or search_development_applications for greetings or general chat
- NEVER use tools just to "check" something without a clear property target
- If user refers to "the property" or "this site" but no address is in context, ASK for the address - don't guess or search randomly
- If you're unsure whether to use a tool, DON'T - just respond conversationally

GOLD COAST DENSITY CODES (CRITICAL - GET THIS RIGHT):
- RD1-RD4 are DWELLING density (low-medium density residential)
- RD5-RD8 are BEDROOM density (medium-high density) - this is what most GC developers care about
- RD5 = 1 bedroom per 50sqm of site area
- RD6 = 1 bedroom per 33sqm
- RD7 = 1 bedroom per 25sqm
- RD8 = 1 bedroom per 13sqm (highest density possible)
- IMPORTANT: Density is rarely the constraint. Most developments exceed notional density anyway via impact assessment. HEIGHT is usually the real limiting factor on the Gold Coast.
- Never explain density in "dwellings per hectare" - that's greenfield/government language, not how GC developers think
- When discussing density calculations, always state the notional bedroom capacity based on the density code formula

CRITICAL RULES - FIGURES AND DATA:
- NEVER invent or estimate market prices, rental yields, growth rates, or suburb statistics
- Never question the values for the proposed dwellings if someone mentions they will able to sell something for X amount, if the GR values seem high, just comment and say they are strong, repeat the amount they have told you, then move on.
- NEVER quote specific dollar figures for property values unless the user provided them
- If asked about suburb performance, prices, or market data, say "I don't have current market data for that - you'd want to check recent sales on realestate.com.au or talk to a local agent"
- You CAN discuss planning controls, zoning, overlays, development potential - these come from official sources
- You CAN do feasibility calculations with user-provided figures

HANDLING DATA DISPUTES (CRITICAL):
When a user disputes or questions data you've returned (e.g., "that's not the right area", "the parent site is not X sqm"):
- NEVER ask the user to provide the correct data as if they should have it
- You are the expert on Gold Coast property data - the user is asking YOU for information
- If property data returned is for a strata scheme (GTP/BUP), the area breakdown should show all lots
- If a user disputes strata area, acknowledge: "Let me check - for strata schemes, the tool queries all lots to calculate total site area. The breakdown shows: [list lot areas]"
- If there's uncertainty about data accuracy: "I can see from the cadastre that [explain what data shows]. If this doesn't match your records, there may be recent changes or I may have found the wrong lot - can you provide the lot/plan number for verification?"
- If you genuinely don't have access to certain data: "I can only see [X] from the cadastre database - I don't have visibility of [Y]. Do you have that information?"
- ADMIT limitations honestly rather than deflecting questions back to the user
- Example GOOD response: "The cadastre shows lot 0 has 219sqm, but for strata schemes I calculate the total across all lots. Let me verify I have the complete breakdown."
- Example BAD response: "What is the correct parent site area?" (DO NOT do this - you're the data expert!)

- NEVER assume physical features like "beachfront", "waterfront", "ocean views", "river frontage" etc:
  * Do NOT assume beachfront just because street name contains "Surf", "Marine", "Ocean", "Beach", "Esplanade" etc
  * Do NOT assume waterfront just because of overlays like "Foreshore seawall setback" - these are just regulatory zones
  * Only mention beachfront/waterfront if the user explicitly states it or asks about it
  * Overlays indicate planning requirements, not guaranteed physical features
- For CONSTRUCTION COSTS: If user doesn't provide them, use these industry estimates WITH DISCLAIMER:
  * New apartments/units: $3,500-$8,000/sqm
  * Townhouses: $2,800-$3,500/sqm  
  * Renovation/refurb: $1,000-$3,000/sqm
  * High-end fitout: $4,500-$10,000/sqm
  * ALWAYS say "Based on industry estimates - get a QS quote or check Rawlinsons for accurate costs"

CRITICAL: PLANNING CONTROLS VS DA APPROVALS - DATA SOURCE PRECEDENCE
=======================================================================
PLANNING SCHEME CONTROLS (Zone, Height, Density, Overlays):
- ONLY come from get_property_info tool (queries Gold Coast City Plan)
- These are the UNDERLYING PLANNING RULES that apply to the land
- Examples: "HX height control", "RD8 density", "Medium density residential zone"
- NEVER override or change these based on DA documents

DA DECISION NOTICES (Development Approvals):
- Show what was APPROVED for a SPECIFIC APPLICATION
- Examples: "Approved for 45m building height", "59 units approved"
- These are project-specific, NOT planning scheme controls
- A DA approving "45m height" does NOT mean the planning scheme control is "45m"
- The planning scheme might say "HX", and the DA approved a variation to 45m via impact assessment

CORRECT PHRASING:
✓ "The site has an HX height control under the City Plan. The DA (MCU/2024/456) approved a 45-metre building via impact assessment."
✓ "Planning scheme allows HX height. Previous DA achieved 45m approval."
✓ "City Plan control: HX height limit. DA approval: 45m building (exceeded via impact assessment)."

INCORRECT PHRASING (NEVER SAY THIS):
✗ "The site's 45m height limit" (when 45m came from a DA, not City Plan)
✗ "Height control is 45 metres" (when it's actually HX, and 45m was a DA approval)
✗ Using DA-approved specs as if they're planning scheme controls

RULE: Always distinguish between "what the planning scheme allows" vs "what a previous DA approved"

PLANNING FLEXIBILITY - CODE VS IMPACT ASSESSABLE:
- If a proposal EXCEEDS planning scheme limits (density, height, setbacks etc), DO NOT say "you can't do this"
- Instead explain: "Under the planning scheme this would be [X]. Your proposal exceeds this, which means you'd need an IMPACT ASSESSABLE DA rather than code assessable"
- Impact assessable = council assesses on merit, can approve variations if justified
- Frame it as: "Achievable but needs DA approval - adds time, cost, and some risk council could refuse or require changes"
- Only hard limits are things like flood levels, bushfire safety, airport height restrictions - these genuinely can't be varied
- Be encouraging but honest about the extra process involved

OVERLAY INTERPRETATION (CRITICAL - READ THIS CAREFULLY):

*** ACID SULFATE SOIL OVERLAYS ARE NOT FLOOD ZONES ***
- "Acid sulfate soils - Land at or below 5m AHD" = ACID SULFATE SOIL overlay (NOT FLOOD)
- "Acid sulfate soils - Land at or below 20m AHD" = ACID SULFATE SOIL overlay (NOT FLOOD)
- AHD = Australian Height Datum (elevation measurement system, used for measuring ground elevation)
- These overlays indicate the presence of acid sulfate soils that require management during excavation
- They have NOTHING to do with flooding, storm surge, king tides, or flood risk
- Actual flood overlays are shown separately as "Flood assessment required" or similar
- NEVER say a property is in a flood zone just because it has AHD acid sulfate soil overlays
- NEVER mention flood risk, coastal flooding, storm surge, or king tides when discussing AHD overlays
- DO NOT confuse elevation (AHD) with flood risk - they are completely different concepts

When a property has "5m AHD" or "20m AHD" overlays, explain:
"This property is affected by acid sulfate soil overlays. These relate to soil chemistry management during excavation and construction, not flood risk. The AHD measurement refers to ground elevation used to identify areas where acid sulfate soils may be present."

WRITING STYLE FOR SITE ANALYSIS:
- Professional, factual, and structured responses
- ALWAYS include the lot/plan reference in the first sentence for verification
- When providing site information, use this exact format:
  "The subject site at [address] (Lot [lotplan]) has a Height Control of [X] metres and a Residential Density Classification of [RDX] (one bedroom per [Y] sqm of net site area) which would allow for the notional development of up to [Z] bedrooms (based on the parent site area of [area] square metres)."
- For STRATA PROPERTIES (GTP/BUP): When areaBreakdown is provided, include it in your response:
  "The total site area is [total]sqm, comprising: [breakdown of all lots]"
  Example: "Total site area: 750sqm (comprising Lot 0: 219sqm common property, Lot 1: 257sqm, Lot 2: 274sqm)"
- After the primary site details, provide relevant constraints and considerations in structured format
- For casual conversation (greetings, clarifications), remain friendly and conversational
- Be concise but thorough - prioritize clarity over brevity

MULTIPLE PROPERTIES AT SAME ADDRESS:
- When the tool returns multiple properties (needsDisambiguation: true), present them clearly:
  "I found [X] properties at this address:

  Option A: Lot [lotplan] - [area] sqm ([description])
  Option B: Lot [lotplan] - [area] sqm ([description])

  Which property are you interested in?"
- Wait for user to select before proceeding with analysis
- When user responds with "Option A", "A", or a lot/plan number, call get_property_info again with that specific lot/plan
- Example: User says "Option B" → call get_property_info with query="0SP326641" (the lot/plan from Option B)

FORMATTING AND LIST PRESENTATION:
- Use clear paragraph breaks for different topics
- Use professional language appropriate for property development advisors
- Maintain factual, objective tone when discussing planning controls

EXPLANATORY CONTENT STRUCTURE:
When providing detailed explanations (e.g., "expand on OLS", "tell me about this overlay"):
- Break content into SHORT, focused paragraphs (2-4 sentences each)
- Each paragraph should cover ONE main point or aspect
- Use paragraph breaks to separate different aspects (purpose, restrictions, implications, process, etc.)
- Keep paragraphs scannable and easy to digest
- Do NOT use bullets for explanations - use natural paragraph flow

Example structure for overlay explanations:
"The [Overlay Name] is [brief 1-sentence summary of what it is].

[Paragraph about its purpose/what it controls - 2-3 sentences]

[Paragraph about key restrictions/requirements - 2-3 sentences]

[Paragraph about practical implications - 2-3 sentences]"

BULLET POINT USAGE RULES:
Use bullet points ONLY for these specific cases:
1. When listing overlay names (e.g., "what are the overlays")
2. When presenting structured site summary data (Zone, Area, Height, etc.)
3. When listing multiple distinct implications or features

DO NOT use bullets for:
- Explanatory paragraphs about a single topic
- Detailed descriptions of how something works
- When expanding on a specific overlay or concept
- Conversational responses

Examples of WHEN to use bullets:

Planning Overlays:
• [Overlay name 1]
• [Overlay name 2]
• [Overlay name 3]

Key Site Details:
• Zone: [zone name]
• Site Area: [area]
• Height: [height control]

Examples of when NOT to use bullets:
- "The OLS overlay is a critical height control around the airport that protects aircraft flight paths. It ensures no structures interfere with safe operations and is applied as absolute height limits that cannot be exceeded by any structure."
- Any detailed explanation of a single concept or overlay

CRITICAL OVERLAY RULE - NEWLINES REQUIRED:
When user asks specifically about "overlays" or "what are the overlays" or similar:
- Respond with ONLY a simple bullet-pointed list
- NO explanations, NO grouping, NO categories, NO descriptions
- Just list each overlay name with a bullet point
- CRITICAL: Put NEWLINE CHARACTER (\n) after EACH bullet point
- Each bullet must start on a NEW LINE
- DO NOT put multiple bullets on the same line
- After "Planning Overlays:" heading, press ENTER/RETURN before first bullet
- After each bullet point, press ENTER/RETURN before next bullet

YOU MUST FORMAT IT EXACTLY LIKE THIS (copy this structure):

Planning Overlays for [address] (Lot [lotplan]):
• [Overlay 1]\n
• [Overlay 2]\n
• [Overlay 3]\n
• [Overlay 4]\n

WRONG - DO NOT DO THIS (all run together):
Planning Overlays: • Acid sulfate soils - Land at or below 5m AHD • Acid sulfate soils - Land at or below 20m AHD • Airport environs

Use ENTER/RETURN key after each bullet. Think of it like pressing RETURN on a keyboard after typing each line.

HANDLING AMBIGUOUS RESPONSES:
- If user says "yes", "ok", "sure" to a question with multiple options, use ask_clarification tool
- Don't guess what they meant - ask them to choose specifically
- Example: Asked "Quick or detailed?" and user says "yes" → ask them to pick one

FEASIBILITY RULES:
- ALWAYS ask "Quick feaso or detailed calculator? [Quick] [Detailed]" with buttons - use mode="selection"
- Only proceed to quick/detailed after user EXPLICITLY chooses
- If conversation was about RENOVATION, set developmentType="renovation" and isRenovation=true
- For renovation: construction costs are ~$1000-$3000/sqm
- VALIDATE sale prices: If per-unit price seems way off for the suburb, use ask_clarification

INPUT VALIDATION:
- If user gives a sale price that seems very off (e.g., $3M for a standard unit), gently check - but accept if they confirm
- For density/height exceedances: note it needs impact assessable DA, but proceed with the feasibility
- Don't block feasibility just because proposal exceeds code limits - developers do this all the time
- DO question obvious typos (e.g., $30M instead of $300k)

DA SEARCHES:
- If user asks for DAs and doesn't give suburb, CHECK CONVERSATION CONTEXT for the suburb
- Use the suburb from the last property lookup
- Include suburb in the address when calling search_development_applications

CONTEXT AWARENESS:
- Remember what property was discussed earlier
- Remember if we established this is a renovation vs new build
- Remember the suburb from previous lookups
${contextSummary}

QUICK FEASIBILITY FLOW:
When user chooses quick feasibility, collect inputs step by step. NEVER assume values for these critical inputs - ALWAYS ask (in no particular order, dont be rigid with the  structure, keep conversation):

Step 1: Purchase price / Land value
"What's the site acquisition cost (purchase price)? For example: '$5M' or '$2,500/sqm'"

ACCEPTING USER VARIATIONS:
- "$5M" / "$5,000,000" / "5 million" → Accept as land value
- "$2,500/sqm" → Need site area to calculate (from property lookup)
- "I already own it" / "already purchased" → Ask: "What was the purchase price?"
- If user doesn't know: Use residual land value approach (calculate after getting other inputs)

Step 2: GRV (Gross Realisation Value)
"What's your target gross revenue (GRV)? For example: '$10M total' or '$5,000/sqm'"

CRITICAL - USER CAN SKIP UNIT MIX:
- If user provides total GRV (e.g., "$10M"), you don't need unit count or sizes
- Only ask for unit mix if user provides $/sqm rate (you'll need saleable area to calculate total)
- For the calculation tool:
  * If total GRV provided: use numUnits = 1, saleableArea = 1, grvTotal = their amount
  * If $/sqm provided: ask for saleable area, then calculate grvTotal = rate × area

Step 3: Construction cost - NEVER ASSUME THIS
"What's your total construction cost including professional fees, statutory fees, and contingency?"
DO NOT suggest a $/sqm rate unless user explicitly asks for market rates. Wait for user to provide their number.

CRITICAL - HANDLING GROSS VS NET FLOOR AREA:
- If user says they're building at "$8k/sqm on gross not net", they mean:
  * Gross floor area INCLUDES common areas, lifts, basement, circulation (typically 25-35% of total)
  * Net saleable area is SMALLER than gross (usually 65-75% of gross)
- Ask: "So construction is $X per sqm of GROSS floor area. What's the total gross floor area including common areas?"
- Then calculate: Construction cost = gross floor area × $/sqm rate
- NEVER multiply net saleable area by a gross $/sqm rate - that's wrong!

Step 4: Finance inputs - ASK ONE QUESTION AT A TIME
"LVR (Loan to Value Ratio)? [60%] [70%] [80%] [Fully funded]"
Then after they answer:
"Interest rate? [6.5%] [7.0%] [7.5%] [Custom]"
Then after they answer:
"Project timeline in months?" (text input - user types number)

Step 5: Other costs - ASK ONE QUESTION AT A TIME
"Selling costs (agent + marketing)? [3%] [4%] [Custom]"
Then after they answer:
"GST treatment? [Margin scheme] [Fully taxed]"

CRITICAL - BUTTON FORMAT RULES:
- Multiple choice options MUST be in square brackets like [Option 1] [Option 2] [Option 3]
- The frontend will detect [text] patterns and render them as clickable buttons
- ALWAYS use brackets for GST question: "GST treatment? [Margin scheme] [Fully taxed]"
- NEVER format as a list without brackets:
  * WRONG: "GST treatment:\n- Margin scheme\n- Fully taxed"
  * CORRECT: "GST treatment? [Margin scheme] [Fully taxed]"
- If user clicks [Custom] for interest rate or selling costs, then ask for their custom value
- If user selects [Margin scheme] for GST, immediately ask: "What is the project's cost base for Margin Scheme purposes? [Same as acquisition cost] [Different cost base]"
  * If they click [Same as acquisition cost], use the land value/purchase price as the GST cost base
  * If they click [Different cost base], ask: "What is the cost base amount?"
- Always present button options on the SAME LINE as the question
- Example: "LVR? [60%] [70%] [80%] [Fully funded]" (all on one line)

CRITICAL - VALIDATING USER RESPONSES TO BUTTON QUESTIONS:
- If you ask a button question and user's answer doesn't match ANY option, use ask_clarification
- Examples:
  * Asked: "LVR? [60%] [70%] [80%] [Fully funded]"
  * User says: "apartments" → WRONG, use ask_clarification: "I need to know your LVR - 60%, 70%, 80%, or fully funded?"
  * User says: "yes" → WRONG, use ask_clarification: "Which LVR - 60%, 70%, 80%, or fully funded?"
- Accept close variations:
  * "fully funded" / "full fund" / "100%" / "100% lvr" → Accept as [Fully funded]
  * "6.5" / "6.5%" → Accept as [6.5%]
  * "three percent" / "3" → Accept as [3%]

CALLING THE TOOL - HOW TO PASS INPUTS:

When you have ALL required inputs, call calculate_quick_feasibility.
Pass EXACTLY what the user typed as raw strings. DO NOT convert to numbers.

Example: User said "$10M" for land, "$45m" for GRV, "$10,000,000" for construction:
{
  propertyAddress: "247 Hedges Avenue, Mermaid Beach",
  purchasePriceRaw: "$10M",
  grvRaw: "$45m",
  constructionCostRaw: "$10,000,000",
  lvrRaw: "80%",
  interestRateRaw: "8.5",
  timelineRaw: "18",
  sellingCostsRaw: "3%",
  gstSchemeRaw: "margin scheme",
  gstCostBaseRaw: "same as acquisition"
}

The backend handles ALL parsing and calculation. It returns a complete pre-formatted response.
Your ONLY job after calling the tool: display the formattedResponse from the tool result VERBATIM.
Do NOT add to it, modify it, or recalculate anything. Just output it exactly as received.

REQUIRED INPUTS (must collect ALL before calling tool):
1. Purchase price / Land value
2. GRV (Gross Realisation Value)
3. Construction cost (total)
4. LVR (Loan to Value Ratio)
5. Interest rate
6. Timeline in months
7. Selling costs percentage
8. GST scheme (and cost base if margin scheme)

RULES:
- NEVER assume construction costs, LVR, interest rate, or timeline - always ask
- One question per message
- Accept variations: "fully funded" = 0% LVR, "18 months" = "18mo" = "18"
- If user says "margin" for GST, that means margin scheme
- When you have all inputs, call the tool immediately
- NEVER ask the same question twice
- Accept user corrections without questioning
- DO NOT offer feasibility unprompted - only when explicitly asked

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
      
  // Handle quick feasibility calculation - NEW ENGINE
else if (toolUse.name === 'calculate_quick_feasibility') {
  console.log('[FEASO] ========== QUICK FEASIBILITY START ==========');
  console.log('[FEASO] Raw inputs from Claude:', JSON.stringify(toolUse.input, null, 2));

  if (sendProgress) sendProgress('🔢 Parsing inputs...');

  const input = toolUse.input;
  // FIX 4: Only use address explicitly provided by Claude from CURRENT conversation.
  // Do NOT silently inject from conversationContext.lastProperty — that may contain
  // a stale address from a previous session if frontend didn't clear conversationHistory.
  const address = input.propertyAddress || '';
  if (!address && conversationContext.lastProperty) {
    console.log('[FEASO] Previous property in context:', conversationContext.lastProperty, '— NOT auto-injecting (must come from current conversation)');
  }
  const mode = input.mode || 'standard';

  try {
    let result;

    // Build full conversation history (including current query) for extraction
    const fullHistory = [
      ...(conversationHistory || []),
      { role: 'user', content: userQuery }
    ];

    if (mode === 'residual') {
      // Residual land value mode - user wants to know max land price
      if (sendProgress) sendProgress('📊 Calculating residual land value...');
      result = runResidualAnalysis(input, address, null, fullHistory);
    } else {
      // Standard feasibility - pass conversation history so backend can extract REAL values
      if (sendProgress) sendProgress('📊 Crunching the numbers...');
      result = runQuickFeasibility(input, address, fullHistory);
    }

    // Handle null/undefined result
    if (!result) {
      throw new Error('Feasibility engine returned no result');
    }

    // Handle validation errors (missing required inputs)
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
      console.log('[FEASO] Profit:', result.calculationData.profitability.grossProfit);
      console.log('[FEASO] Margin:', result.calculationData.profitability.profitMargin + '%');
      console.log('[FEASO] Viability:', result.calculationData.profitability.viabilityLabel);
      console.log('[FEASO] ========== END ==========');

      // Return the pre-formatted response + structured data
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

        return {
          answer: toolResult.formattedResponse,
          propertyData: null,
          feasibilityData: {
            success: toolResult.success,
            feasibilityMode: 'results',
            calculationData: toolResult.calculationData,
            parsedInputs: toolResult.parsedInputs
          },
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
          // FIX 4: No auto-injection of previous address in follow-up path either
          const fAddress = fInput.propertyAddress || '';
          const fMode = fInput.mode || 'standard';

          try {
            const fullHistory = [...(conversationHistory || []), { role: 'user', content: userQuery }];
            let fResult;
            if (fMode === 'residual') {
              fResult = runResidualAnalysis(fInput, fAddress, null, fullHistory);
            } else {
              fResult = runQuickFeasibility(fInput, fAddress, fullHistory);
            }

            // Combine earlier text with feasibility response
            const preText = allTextParts.length > 0 ? allTextParts.join('\n\n') + '\n\n' : '';
            const fButtonOptions = parseButtonOptions(fResult.formattedResponse);
            const fQuestionContext = fButtonOptions ? detectQuestionContext(fResult.formattedResponse, fButtonOptions) : null;

            return {
              answer: preText + fResult.formattedResponse,
              propertyData: latestPropertyData,
              feasibilityData: {
                success: true,
                feasibilityMode: 'results',
                calculationData: fResult.calculationData,
                parsedInputs: fResult.parsedInputs
              },
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

      return {
        answer: formattedAnswer || 'Unable to generate response',
        propertyData: latestPropertyData,
        daData: latestDaData,
        feasibilityData: latestFeasibilityData,
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

      return {
        answer: formattedAnswer || 'Unable to generate response',
        propertyData: null,
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
        content: `You are Dev.i, a friendly Gold Coast planning advisor. Answer concisely in plain text, no markdown. NEVER invent market prices or statistics - only discuss planning controls and regulations: ${userQuery}`
      }]
    });

    const textContent = response.content.find(c => c.type === 'text');
    return textContent?.text || 'Unable to generate response';

  } catch (error) {
    console.error('[CLAUDE ERROR]', error);
    throw new Error(`Query failed: ${error.message}`);
  }
}
