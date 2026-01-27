// services/claude.js
import Anthropic from '@anthropic-ai/sdk';
import { scrapeProperty } from './goldcoast-api.js';
import { searchPlanningScheme } from './rag-simple.js';
import {
  calculateLandTaxQLD,
  calculateTargetMargin,
  splitTimeline,
  getDefaultSellingCosts
} from './feasibility-calculator.js';
import { parseFeasibilityInputs } from './feasibility-input-parser.js';

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
 */
function formatIntoParagraphs(text) {
  if (!text) return text;
  
  let normalized = text.replace(/\n+/g, ' ').replace(/  +/g, ' ').trim();
  
  const sentences = [];
  let current = '';
  
  for (let i = 0; i < normalized.length; i++) {
    current += normalized[i];
    
    if (normalized[i] === '.' && 
        (i === normalized.length - 1 || 
         (normalized[i + 1] === ' ' && /[A-Z]/.test(normalized[i + 2] || '')))) {
      sentences.push(current.trim());
      current = '';
      i++;
    }
  }
  
  if (current.trim()) {
    sentences.push(current.trim());
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

  // Track if planning controls have been set from City Plan (get_property_info)
  // Once set, they should NOT be overridden by DA documents
  let planningControlsLocked = false;

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

            // Check if this looks like a property lookup result
            if (toolResultText.includes('"success":true') && toolResultText.includes('"property":{')) {
              const toolResult = JSON.parse(toolResultText);

              if (toolResult.success && toolResult.property) {
                const prop = toolResult.property;

                // Set planning controls (from City Plan - IMMUTABLE)
                if (prop.zone) {
                  context.lastZone = prop.zone;
                  planningControlsLocked = true;
                }
                if (prop.density) {
                  context.lastDensity = prop.density;
                  planningControlsLocked = true;
                }
                if (prop.height) {
                  context.lastHeight = prop.height;
                  planningControlsLocked = true;
                }

                // Also extract basic property info
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
            // Not JSON or not a property result, skip
          }
        }
      }
    }

    // Look for property addresses (fallback for user-mentioned addresses)
    const addressMatch = content.match(/(\d+\s+[\w\s]+(?:street|st|avenue|ave|court|crt|road|rd|drive|dr|parade|pde|circuit|cct|crescent|cres|place|pl|way|lane|ln)),?\s*([\w\s]+?)(?:,|\s+QLD|\s+\d{4}|$)/i);
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
    if (!context.lastSiteArea) {
      const areaMatch = content.match(/(\d+)\s*(?:sqm|m2|square\s*met)/i);
      if (areaMatch) {
        context.lastSiteArea = parseInt(areaMatch[1]);
      }
    }

    // CRITICAL: DO NOT extract density codes or height limits from general text
    // These MUST come from get_property_info to avoid contamination from DA documents
    // Only extract if planning controls haven't been locked by City Plan data
    if (!planningControlsLocked) {
      const densityMatch = content.match(/\b(RD[1-8])\b/i);
      if (densityMatch && !context.lastDensity) {
        context.lastDensity = densityMatch[1].toUpperCase();
      }

      const heightMatch = content.match(/(\d+)\s*m(?:etre)?s?\s*height/i);
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

  // Match pattern like "[60%] [70%] [80%] [Fully funded]"
  const buttonPattern = /\[([^\]]+)\](?:\s*\[([^\]]+)\])+/g;
  const matches = [...text.matchAll(buttonPattern)];

  if (matches.length === 0) return null;

  // Extract all button options from the text
  const allButtons = [];
  for (const match of matches) {
    // Get the full match and extract all individual buttons
    const fullMatch = match[0];
    const individualButtons = fullMatch.match(/\[([^\]]+)\]/g);

    if (individualButtons) {
      for (const btn of individualButtons) {
        const buttonText = btn.replace(/[\[\]]/g, '').trim();
        if (buttonText && !allButtons.includes(buttonText)) {
          allButtons.push(buttonText);
        }
      }
    }
  }

  return allButtons.length > 0 ? allButtons : null;
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
  if (conversationHistory?.length > 0) {
    const recent = conversationHistory.slice(-10);
    for (const msg of recent) {
      if (msg.content) {
        messages.push({
          role: msg.role,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
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
    
    // PROPERTY, ANALYSIS, or UNCLEAR: Proceed with tools
    console.log('[CLAUDE] Proceeding with tool-enabled response');

    const tools = [
      {
        name: 'get_property_info',
        description: `🚨 STRICT USAGE RULES - READ BEFORE CALLING:

ONLY call this tool when ALL of these conditions are met:
1. User has provided a SPECIFIC property address or lot/plan number
2. User is asking about planning controls (zone, density, height, overlays) for THAT SPECIFIC property
3. You need actual planning scheme data from the Gold Coast system

DO NOT call this tool when:
- User is asking general feasibility questions
- User is discussing hypothetical scenarios without a specific address
- User is providing feasibility inputs (GRV, construction costs, etc.)
- You're just having a conversation
- User says "the property" but hasn't given you an address yet

Examples of WHEN to use:
✅ "What's the zoning for 123 Main St Surfers Paradise?"
✅ "Look up lot 295RP21863"
✅ "What can I build at 45 Hedges Avenue?"

Examples of WHEN NOT to use:
❌ User: "I want to run a feasibility" (no address given)
❌ User: "The GRV is $10M" (providing inputs, not asking about planning)
❌ User: "What's the construction cost?" (general question)
❌ User: "Quick or detailed calculator?" (mode selection)

If unsure, ask the user for the address first. Don't call this tool "just in case".

IMPORTANT: This tool works best with lot/plan numbers (e.g., "295RP21863"). Address searches can be unreliable.`,
        input_schema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Lot/plan number (e.g., "295RP21863" - PREFERRED) or street address (e.g., "12 Heron Avenue, Mermaid Beach" - less reliable)'
            }
          },
          required: ['query']
        }
      },
      {
        name: 'search_development_applications',
        description: 'Search for development applications (DAs) at a specific Gold Coast address. ONLY use this when user asks about DAs, development applications, building approvals, or construction activity. Returns application numbers, lodgement dates, status, descriptions, and types.',
        input_schema: {
          type: 'object',
          properties: {
            address: {
              type: 'string',
              description: 'Full street address including suburb (e.g., "22 Mary Avenue, Broadbeach"). If suburb not provided, use context from conversation.'
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
  description: `Calculate a quick feasibility analysis.

🔥 NEW ARCHITECTURE - RAW STRING INPUTS ONLY 🔥

DO NOT extract numbers. DO NOT parse values. Just pass through EXACTLY what the user said as raw strings.

Examples:
- User said "$84M" → grvRaw: "$84M" (NOT 84000000)
- User said "70%" → lvrRaw: "70%" (NOT 70)
- User said "$28m build + $1m professional + $1m council fees" → constructionCostRaw: "$28m build + $1m professional + $1m council fees"

The backend will handle ALL parsing. Your job is ONLY to capture raw strings.

ONLY use after collecting ALL required inputs from user.`,
  input_schema: {
    type: 'object',
    properties: {
      propertyAddress: {
        type: 'string',
        description: 'Property address'
      },
      siteArea: {
        type: 'number',
        description: 'Site area in sqm'
      },
      numUnits: {
        type: 'number',
        description: 'Number of units (optional - only if user provided)'
      },
      saleableArea: {
        type: 'number',
        description: 'Total saleable area in sqm (optional - only if user provided or needed for $/sqm GRV)'
      },
      purchasePriceRaw: {
        type: 'string',
        description: 'RAW user input for purchase price. Examples: "$5M", "$2m", "5 million", "$2,500/sqm". Pass through EXACTLY what user said.'
      },
      grvRaw: {
        type: 'string',
        description: 'RAW user input for GRV. Examples: "$84M", "$30k/sqm", "70 million". Pass through EXACTLY what user said.'
      },
      constructionCostRaw: {
        type: 'string',
        description: 'RAW user input for construction cost. Examples: "$28M", "$30m build + $1m professional + $1m council + 5% contingency". Pass through EXACTLY what user said.'
      },
      lvrRaw: {
        type: 'string',
        description: 'RAW user input for LVR. Examples: "70%", "70", "80 percent". Pass through EXACTLY what user said.'
      },
      interestRateRaw: {
        type: 'string',
        description: 'RAW user input for interest rate. Examples: "7.0%", "6.5", "8 percent". Pass through EXACTLY what user said.'
      },
      timelineRaw: {
        type: 'string',
        description: 'RAW user input for timeline. Examples: "18 months", "18mo", "18m", "18". Pass through EXACTLY what user said.'
      },
      sellingCostsRaw: {
        type: 'string',
        description: 'RAW user input for selling costs. Examples: "3%", "3", "3 percent". Pass through EXACTLY what user said.'
      },
      gstSchemeRaw: {
        type: 'string',
        description: 'RAW user input for GST treatment. Examples: "margin scheme", "margin", "fully taxed". Pass through EXACTLY what user said.'
      },
      gstCostBaseRaw: {
        type: 'string',
        description: 'RAW user input for GST cost base (only for margin scheme). Examples: "same as acquisition", "$5M", "5 million". Pass through EXACTLY what user said.'
      }
    },
    required: ['purchasePriceRaw', 'grvRaw', 'constructionCostRaw', 'lvrRaw', 'interestRateRaw', 'timelineRaw', 'sellingCostsRaw', 'gstSchemeRaw']
  }
}
    ];

    // Build context-aware system prompt
    const contextSummary = buildContextSummary(conversationContext);
    
const systemPrompt = `You are Dev.i, a friendly Gold Coast property development advisor.

🚨 CONVERSATION ISOLATION - READ THIS FIRST 🚨
Each conversation is SEPARATE. DO NOT use values from previous conversations.
When user provides inputs like "$70m GRV" or "$10m land", use THOSE exact values.
DO NOT use "$8m GRV" or "$2m land" from a previous chat.

Example of WRONG behavior:
- Previous chat: User said "$8m GRV, $2m land"
- Current chat: User says "$70m GRV, $10m land"
- You show: "$8m GRV, $2m land" ❌ WRONG - these are from previous chat!
- You should show: "$70m GRV, $10m land" ✅ CORRECT - from current chat

🚨 TOOL USAGE RULES (CRITICAL - READ EVERY TIME) 🚨

WHEN TO USE get_property_info:
✅ User provides address AND asks about planning controls: "What's the zoning for 123 Main St?"
✅ User provides lot/plan: "Look up 295RP21863"

WHEN NOT TO USE get_property_info (DO NOT CALL):
❌ User is providing feasibility inputs: "GRV is $10M" → JUST ACCEPT THE INPUT
❌ User wants to run a feasibility but hasn't given address → ASK for address, don't search
❌ User is choosing quick vs detailed → JUST RESPOND, don't search
❌ General questions: "What's a typical construction cost?" → JUST ANSWER
❌ Greetings or chat: "Hey" → JUST RESPOND
❌ User says "the property" but no address in context → ASK for address first

CRITICAL RULE: If you're about to call get_property_info, ask yourself:
"Did the user give me a SPECIFIC address/lot and ask about PLANNING CONTROLS?"
If NO to either part → DO NOT CALL THE TOOL

If you're unsure whether to use a tool, DON'T - just respond conversationally.

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

WRITING STYLE FOR SITE ANALYSIS:
- Professional, factual, and structured responses
- ALWAYS include the lot/plan reference in the first sentence for verification
- When providing site information, use this exact format:
  "The subject site at [address] (Lot [lotplan]) has a Height Control of [X] metres and a Residential Density Classification of [RDX] (one bedroom per [Y] sqm of net site area) which would allow for the notional development of up to [Z] bedrooms (based on the parent site area of [area] square metres)."
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
Planning Overlays: • Land at or below 5m AHD • Land at or below 20m AHD • Airport environs

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

Step 7: Call the tool with RAW STRING inputs

🔥 NEW ARCHITECTURE - DO NOT EXTRACT NUMBERS 🔥

The backend now handles ALL number parsing. Your job is to pass through EXACTLY what the user said as raw strings.

⚠️ MANDATORY PROCESS:

1. Capture what user said VERBATIM (as strings):
   - User said "12m" for GRV → grvRaw: "12m"
   - User said "2 mil" for land → purchasePriceRaw: "2 mil"
   - User said "$5m" for construction → constructionCostRaw: "$5m"
   - User said "70%" for LVR → lvrRaw: "70%"
   - User said "8%" for interest → interestRateRaw: "8%"
   - User said "13 months" for timeline → timelineRaw: "13 months"
   - User said "4%" for selling → sellingCostsRaw: "4%"

2. BEFORE calling the tool, echo back to the user:
   "Calculating with:
   - GRV: $12M (you said '12m')
   - Land: $2M (you said '2 mil')
   - Construction: $5M (you said '$5m')
   - LVR 70%, 8% interest, 13 months, 4% selling costs, margin scheme"

3. THEN call calculate_quick_feasibility with RAW STRINGS:
   {
     purchasePriceRaw: "2 mil",
     grvRaw: "12m",
     constructionCostRaw: "$5m",
     lvrRaw: "70%",
     interestRateRaw: "8%",
     timelineRaw: "13 months",
     sellingCostsRaw: "4%",
     gstSchemeRaw: "margin scheme",
     gstCostBaseRaw: "same as acquisition"
   }

⚠️ CRITICAL RULES:
- DO NOT convert strings to numbers - pass them through EXACTLY as user said
- Examples of CORRECT usage:
  * User: "$84M" → grvRaw: "$84M" ✅
  * User: "70%" → lvrRaw: "70%" ✅
  * User: "$28m build + $1m professional" → constructionCostRaw: "$28m build + $1m professional" ✅
- Examples of WRONG usage:
  * User: "$84M" → grvRaw: 84000000 ❌ (converted to number)
  * User: "70%" → lvrRaw: 70 ❌ (removed %)
- The backend will handle ALL parsing - your job is ONLY to capture raw strings

🚨 STOP - READ THIS BEFORE PRESENTING RESULTS 🚨

CRITICAL CHECKLIST (answer each):
1. Did you call calculate_quick_feasibility tool? ☐ YES ☐ NO
2. Did the tool return results? ☐ YES ☐ NO
3. Are you about to present tool results or make up numbers? ☐ TOOL RESULTS ☐ MAKING UP
4. Does revenue.grvInclGST from tool match what user said? ☐ YES ☐ NO
5. Does costs.land from tool match what user said? ☐ YES ☐ NO
6. Does costs.construction from tool match what user said? ☐ YES ☐ NO

If ANY answer is wrong, STOP and fix it before presenting.

⚠️ DO NOT STREAM RESULTS WHILE WAITING FOR TOOL
You might be tempted to start writing "Revenue: $..." while the tool is processing.
DO NOT DO THIS. Wait for the tool to complete, then present tool results ONLY.

CRITICAL - PRESENTING FEASIBILITY RESULTS:
⚠️ ABSOLUTE RULES - NEVER VIOLATE THESE:
1. You MUST call calculate_quick_feasibility tool - do NOT calculate manually
2. You MUST wait for the tool to return results - do NOT generate results while waiting
3. You MUST present ONLY what the tool returns - NEVER make up numbers
4. If the tool fails or returns an error, say "I couldn't calculate the feasibility. Please try again."
5. NEVER present different numbers than the tool output - this includes:
   - Land value (use costs.land from tool result, NOT what you remember)
   - GRV (use revenue.grvInclGST from tool result, NOT what user said)
   - Construction costs (use costs.construction from tool result)
   - Profit/loss (use profitability.grossProfit from tool result)

⚠️ COMMON MISTAKE: Showing "$8M GRV" when user said "$12M"
This happens when you use the INPUT (what user said) instead of OUTPUT (what tool returned).
Always use tool.revenue.grvInclGST, NOT what you remember user saying.

WHY YOU MAKE MISTAKES:
- You try to be helpful by calculating during streaming
- You mix up remembered values with calculated values
- You use the INPUTS instead of the OUTPUTS
SOLUTION: Wait for tool, copy tool output exactly, do NOT improvise.

The tool output contains these fields (use them EXACTLY):
- inputs.numUnits, inputs.saleableArea, inputs.constructionCost
- revenue.grvInclGST, revenue.grvExclGST, revenue.avgPricePerUnit
- costs.land, costs.construction, costs.selling, costs.finance, costs.holding, costs.total
- profitability.grossProfit, profitability.profitMargin, profitability.viability
- residual.residualLandValue

VERIFICATION BEFORE PRESENTING:
- Check: Does revenue.grvInclGST match what user told you?
- Check: Does costs.land match what user told you?
- Check: Does costs.construction match what user told you?
- If NO: The tool may have failed - tell user "The calculation returned unexpected results. Let me try again."
- If YES: Present the results exactly as tool returned them

PRESENTING RESULTS - MANDATORY FORMAT:
When showing feasibility results, you MUST use this EXACT format:

**Inputs received:**
- Purchase price: $X.XM (from conversation: user said "X mil")
- Target GRV: $X.XM (from conversation: user said "X m")
- Construction cost: $X.XM (from conversation: user said "$Xm")
- LVR: XX% | Interest: X.X% | Timeline: XX months | Selling costs: X%
- GST: [Margin scheme with $X.XM cost base / Fully taxed]

**Revenue: (Including GST)**
- Gross Revenue (inc GST): $XX.XM
- GST Payable: $XX.XM
- Net Revenue (exc GST): $XX.XM

**Total Project Costs: (Excluding GST)**
- Land acquisition: $XX.XM
- Construction: $XX.XM
- Selling costs (X%): $XX.XM
- Finance costs: $XX.XM
- Holding costs: $XX.XM

Note: Statutory and council fees are GST-free (not subject to GST).

**Profitability:**
- Gross Profit: $XX.XM
- Profit Margin: XX.X%
- Status: [VIABLE/MARGINAL/CHALLENGING/NOT VIABLE]

CRITICAL RULES FOR QUICK FEASO:
- NEVER assume construction costs - always ask the user
- NEVER assume LVR, interest rate, or timeline - always ask
- Accept user corrections immediately without questioning
- If user provides all inputs at once, parse them and confirm before calculating
- One question per message maximum
- Accept variations: "fully funded" = "full fund" = "100% LVR"
- Accept variations: "18 months" = "18mo" = "18m"
- If user says "margin" for GST, that means margin scheme
- CRITICAL: When user says "I already told you" or similar, review conversation history and find their answer
- NEVER ask the same question twice - check conversation context first

TRACKING INPUTS - BEFORE CALLING calculate_quick_feasibility:
You MUST have ALL of these inputs:
1. ✓ Land value / Purchase price (acquisition cost)
2. ✓ GRV (total amount, e.g., "$10M" OR $/sqm rate)
3. ✓ Construction cost (total, including fees and contingency)
4. ✓ LVR
5. ✓ Interest rate
6. ✓ Timeline in months
7. ✓ Selling costs percentage
8. ✓ GST scheme (and cost base if margin scheme)

OPTIONAL INPUTS:
- Number of units (only if user provides $/sqm rate for GRV)
- Unit sizes/mix (only if user provides $/sqm rate for GRV)
- Project type (contextual - doesn't affect calculation, defaults to "new_build")

If ANY required input is missing, ask for it. DO NOT call the tool until you have ALL required inputs.
When you have all inputs, call the tool immediately - don't summarize or delay.

CALLING THE TOOL - REQUIRED PARAMETERS:
TWO SCENARIOS:
A) User provided total GRV (e.g., "$10M total"):
   - numUnits: 1
   - saleableArea: 1
   - grvTotal: User's total amount (e.g., 10000000)

B) User provided $/sqm rate (e.g., "$25k/sqm"):
   - numUnits: Number from user
   - saleableArea: Calculate from unit mix (e.g., 50 × 250sqm + 9 × 400sqm = 16,100sqm)
   - grvTotal: Calculate from $/sqm × area (e.g., $25k/sqm × 16,100 = $402.5M)

ALL OTHER PARAMETERS (same for both scenarios):
- landValue: Purchase price from user (e.g., 5000000 for $5M) - REQUIRED
- constructionCost: Total from user (e.g., $171.7M)
- lvr: As number 0-100 (e.g., 60 for 60%, 100 for fully funded)
- interestRate: As number (e.g., 6.8 for 6.8%)
- timelineMonths: As number (e.g., 32)
- sellingCostsPercent: As number (e.g., 3 for 3%)
- gstScheme: "margin" or "fully_taxed"
- gstCostBase: REQUIRED if gstScheme is "margin" (e.g., 12000000 for $12M)
- propertyAddress: From context
- projectType: Default to "new_build" if not specified

${contextSummary}

DO NOT offer feasibility unprompted. Only when explicitly asked.`;
    
    // Build messages array with conversation history
    const messages = [];
    
    if (conversationHistory && conversationHistory.length > 0) {
      console.log('[CLAUDE] Adding conversation history...');
      const recentHistory = conversationHistory.slice(-20);
      
      for (const msg of recentHistory) {
        if (msg.content && (typeof msg.content === 'string' ? msg.content.trim() : true)) {
          const content = typeof msg.content === 'string' 
            ? msg.content.trim() 
            : msg.content;
          
          if (content && (typeof content !== 'string' || content.length > 0)) {
            messages.push({
              role: msg.role,
              content: content
            });
          }
        }
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
      max_tokens: 800,
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
        if (sendProgress) sendProgress('📍 Accessing Gold Coast City Plan...');
        const propertyData = await scrapeProperty(toolUse.input.query, sendProgress);

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

        if (sendProgress) sendProgress('🧠 Searching planning regulations...');
        console.log('[CLAUDE] Searching planning scheme database...');
        const planningContext = await searchPlanningScheme(toolUse.input.query, propertyData);
        console.log(`[CLAUDE] Found ${planningContext.length} relevant planning sections`);
        
        if (sendProgress) sendProgress('✍️ Analyzing development potential...');
        
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
        const inputSuburb = toolUse.input.suburb;

        // Check if address already has suburb
        const hasSuburb = /(?:mermaid|broadbeach|surfers|southport|palm beach|burleigh|robina|varsity|hope island|coolangatta|currumbin|tugun|miami)/i.test(searchAddress);

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
          if (sendProgress) sendProgress(`Found ${daResult.count} applications`);

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
        if (sendProgress) sendProgress('📊 Preparing feasibility analysis...');
        
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
      
  // Handle quick feasibility calculation
else if (toolUse.name === 'calculate_quick_feasibility') {
  console.log('[CLAUDE] ========== QUICK FEASIBILITY CALCULATION START ==========');
  console.log('[CLAUDE] RAW inputs received from Claude:', JSON.stringify(toolUse.input, null, 2));

  if (sendProgress) sendProgress('🔢 Parsing inputs with server-side parser...');

  const input = toolUse.input;

  // 🔥 NEW ARCHITECTURE: Parse RAW string inputs on the backend
  // This ensures 100% accuracy by bypassing Claude's number extraction
  const rawInputs = {
    purchasePriceRaw: input.purchasePriceRaw,
    grvRaw: input.grvRaw,
    constructionCostRaw: input.constructionCostRaw,
    lvrRaw: input.lvrRaw,
    interestRateRaw: input.interestRateRaw,
    timelineRaw: input.timelineRaw,
    sellingCostsRaw: input.sellingCostsRaw,
    gstSchemeRaw: input.gstSchemeRaw,
    gstCostBaseRaw: input.gstCostBaseRaw,
    saleableArea: input.saleableArea || 0,
    numUnits: input.numUnits || 1
  };

  console.log('[CLAUDE] Calling parseFeasibilityInputs() with raw strings...');
  const parsed = parseFeasibilityInputs(rawInputs);
  console.log('[CLAUDE] PARSED VALUES (from server-side parser):');
  console.log('  - landValue:', parsed.landValue);
  console.log('  - grvTotal:', parsed.grvTotal);
  console.log('  - constructionCost:', parsed.constructionCost);
  console.log('  - lvr:', parsed.lvr);
  console.log('  - interestRate:', parsed.interestRate);
  console.log('  - timelineMonths:', parsed.timelineMonths);
  console.log('  - sellingCostsPercent:', parsed.sellingCostsPercent);
  console.log('  - gstScheme:', parsed.gstScheme);
  console.log('  - gstCostBase:', parsed.gstCostBase);

  if (sendProgress) sendProgress('🔢 Crunching the numbers...');

  // Use parsed values for calculation
  const numUnits = parsed.numUnits;
  const saleableArea = parsed.saleableArea;
  const grvTotal = parsed.grvTotal;
  const landValue = parsed.landValue;
  const constructionCost = parsed.constructionCost;
  const lvr = parsed.lvr;
  const interestRate = parsed.interestRate;
  const timelineMonths = parsed.timelineMonths;
  const sellingCostsPercent = parsed.sellingCostsPercent;
  const gstScheme = parsed.gstScheme;
  const gstCostBase = parsed.gstCostBase;

  // Get property context
  const propertyAddress = input.propertyAddress || conversationContext.lastProperty || '';
  const siteArea = input.siteArea || conversationContext.lastSiteArea || 0;
  const densityCode = conversationContext.lastDensity || '';
  const heightLimit = conversationContext.lastHeight || '';

  // Contingency is handled in parseConstructionCost
  const contingencyPercent = parsed.constructionBreakdown?.contingencyPercent || 0;
  const constructionWithContingency = constructionCost;

  // Convert percentages to decimals
  const lvrDecimal = lvr / 100;
  const interestDecimal = interestRate / 100;
  const sellingDecimal = sellingCostsPercent / 100;

  // Calculate GST
  let grvExclGST;
  let gstPayable;
  if (gstScheme === 'margin' && gstCostBase > 0) {
    const margin = grvTotal - gstCostBase;
    gstPayable = margin / 11;
    grvExclGST = grvTotal - gstPayable;
  } else if (gstScheme === 'fully_taxed') {
    gstPayable = grvTotal / 11;
    grvExclGST = grvTotal / 1.1;
  } else {
    // Default to simple /1.1 if no cost base for margin calc
    gstPayable = grvTotal / 11;
    grvExclGST = grvTotal / 1.1;
  }

  // Determine target margin based on GRV
  const defaultTargetMargin = calculateTargetMargin(grvExclGST);
  const targetMarginPercent = input.targetMarginPercent || defaultTargetMargin;
  const targetMarginDecimal = targetMarginPercent / 100;

  // Get default selling costs breakdown
  const sellingDefaults = getDefaultSellingCosts();

  // Calculate costs
  const sellingCosts = grvExclGST * sellingDecimal;

  // Calculate holding costs based on land value
  const landTaxYearly = calculateLandTaxQLD(landValue);
  const councilRatesAnnual = 5000;
  const waterRatesAnnual = 1400;
  const totalHoldingYearly = landTaxYearly + councilRatesAnnual + waterRatesAnnual;
  const holdingCosts = totalHoldingYearly * (timelineMonths / 12);

  // Finance costs (50% average debt outstanding)
  const totalDebt = (landValue + constructionWithContingency) * lvrDecimal;
  const avgDebt = totalDebt * 0.5;
  const financeCosts = avgDebt * interestDecimal * (timelineMonths / 12);

  // Total costs and profit
  const totalCost = landValue + constructionWithContingency + sellingCosts + financeCosts + holdingCosts;
  const grossProfit = grvExclGST - totalCost;
  const profitMargin = (grossProfit / grvExclGST) * 100;

  // Calculate residual land value at target margin
  const targetProfit = grvExclGST * targetMarginDecimal;
  let residualLandValue = grvExclGST - constructionWithContingency - sellingCosts - targetProfit;

  // Iterate to account for finance costs on land
  for (let i = 0; i < 5; i++) {
    const residualDebt = (residualLandValue + constructionWithContingency) * lvrDecimal;
    const residualAvgDebt = residualDebt * 0.5;
    const residualFinanceCosts = residualAvgDebt * interestDecimal * (timelineMonths / 12);
    const residualHoldingCosts = totalHoldingYearly * (timelineMonths / 12);
    residualLandValue = grvExclGST - constructionWithContingency - sellingCosts - residualFinanceCosts - residualHoldingCosts - targetProfit;
  }

  // Determine viability
  let viability;
  if (profitMargin >= 25) viability = 'viable';
  else if (profitMargin >= 20) viability = 'marginal';
  else if (profitMargin >= 15) viability = 'challenging';
  else viability = 'not_viable';

  // Split timeline into phases
  const timeline = splitTimeline(timelineMonths);

  // Parse professional fees, statutory fees, PM fees from construction cost
  // These are typically provided as part of construction cost breakdown
  const professionalFees = input.professionalFees || 0;
  const statutoryFees = input.statutoryFees || 0;
  const pmFees = input.pmFees || 0;
  const buildCosts = input.buildCosts || (constructionCost - professionalFees - statutoryFees - pmFees);

  if (sendProgress) sendProgress('✅ Feasibility calculated');

  // BUILD CALCULATOR PRE-FILL OBJECT
  // This object maps directly to the detailed form field names
  const calculatorPreFill = {
    // Property (from property lookup, NOT user input)
    property: propertyAddress,
    siteArea: siteArea,  // Actual land parcel size in sqm
    densityCode: densityCode,
    heightLimit: heightLimit,

    // Project (from user input)
    numUnits: numUnits,
    unitMix: input.unitMix || `${numUnits} units`,
    saleableArea: saleableArea,  // Total unit floor area - DIFFERENT from siteArea

    // Revenue
    grvInclGST: Math.round(grvTotal),

    // Acquisition
    landValue: Math.round(landValue),
    gstScheme: gstScheme,
    gstCostBase: Math.round(gstCostBase),

    // Construction (user provided or defaults)
    buildCosts: Math.round(buildCosts),
    contingencyPercent: contingencyPercent,
    professionalFees: Math.round(professionalFees),
    statutoryFees: Math.round(statutoryFees),
    pmFees: Math.round(pmFees),

    // Holding (apply defaults based on land value)
    landTaxYearly: Math.round(landTaxYearly),
    councilRatesAnnual: councilRatesAnnual,
    waterRatesAnnual: waterRatesAnnual,

    // Selling (use defaults or user-provided)
    agentFeesPercent: sellingDefaults.agentFeesPercent,
    marketingPercent: sellingDefaults.marketingPercent,
    legalSellingPercent: sellingDefaults.legalSellingPercent,

    // Finance
    lvr: lvr,
    interestRate: interestRate,

    // Timeline
    totalMonths: timeline.totalMonths,
    leadInMonths: timeline.leadInMonths,
    constructionMonths: timeline.constructionMonths,
    sellingMonths: timeline.sellingMonths,

    // Target
    targetMargin: targetMarginPercent
  };

  toolResult = {
    success: true,
    feasibilityMode: 'results',

    // NEW: Include calculatorPreFill for form/PDF
    calculatorPreFill: calculatorPreFill,

    inputs: {
      address: propertyAddress,
      projectType: input.projectType,
      numUnits: numUnits,
      unitMix: input.unitMix,
      saleableArea: saleableArea,
      landValue: landValue,
      constructionCost: constructionWithContingency,
      contingencyIncluded: contingencyIncluded,
      lvr: lvr,
      interestRate: interestRate,
      timelineMonths: timelineMonths,
      sellingCostsPercent: sellingCostsPercent,
      gstScheme: gstScheme
    },

    revenue: {
      grvInclGST: Math.round(grvTotal),
      grvExclGST: Math.round(grvExclGST),
      gstPayable: Math.round(gstPayable),
      avgPricePerUnit: Math.round(grvTotal / numUnits)
    },

    costs: {
      land: Math.round(landValue),
      construction: Math.round(constructionWithContingency),
      selling: Math.round(sellingCosts),
      finance: Math.round(financeCosts),
      holding: Math.round(holdingCosts),
      total: Math.round(totalCost)
    },

    profitability: {
      grossProfit: Math.round(grossProfit),
      profitMargin: Math.round(profitMargin * 10) / 10,
      targetMargin: targetMarginPercent,
      meetsTarget: profitMargin >= targetMarginPercent,
      viability: viability
    },

    residual: {
      residualLandValue: Math.round(residualLandValue),
      vsActualLand: landValue > 0 ? Math.round(residualLandValue - landValue) : null
    },

    assumptions: {
      contingency: contingencyIncluded ? 'Included in construction' : 'Added 5%',
      financeDrawProfile: '50% average outstanding',
      landTax: `$${Math.round(landTaxYearly).toLocaleString()}/year`,
      councilRates: `$${councilRatesAnnual.toLocaleString()}/year`,
      waterRates: `$${waterRatesAnnual.toLocaleString()}/year`,
      targetMarginBasis: grvExclGST < 15000000 ? 'GRV under $15M → 15%' : 'GRV $15M+ → 20%'
    }
  };

  // CRITICAL: Log what the tool actually calculated
  console.log('[CLAUDE] ========== TOOL CALCULATION RESULTS ==========');
  console.log('[CLAUDE] Tool returned:');
  console.log('  - revenue.grvInclGST:', toolResult.revenue.grvInclGST);
  console.log('  - costs.land:', toolResult.costs.land);
  console.log('  - costs.construction:', toolResult.costs.construction);
  console.log('  - profitability.grossProfit:', toolResult.profitability.grossProfit);
  console.log('[CLAUDE] ========== END TOOL RESULTS ==========');
}
      // Send the tool result back to Claude
      const finalResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        system: systemPrompt,
        tools,
        messages: [
          ...messages,
          {
            role: 'assistant',
            content: response.content
          },
          {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: JSON.stringify(toolResult, null, 2)
            }]
          }
        ]
      });

      console.log('[CLAUDE] Final advisory generated');

      const textContent = finalResponse.content.find(c => c.type === 'text');

      const isFeasibility = toolUse.name === 'start_feasibility' || toolUse.name === 'calculate_quick_feasibility';
      const isPropertyAnalysis = toolUse.name === 'get_property_info';

      // For property analysis, preserve professional structure; for other responses, apply casual formatting
      let formattedAnswer = isPropertyAnalysis
        ? stripMarkdown(textContent?.text)
        : formatIntoParagraphs(stripMarkdown(textContent?.text));

      // Fix inline bullet points by adding newlines between them (only for lists, not explanations)
      formattedAnswer = fixBulletPoints(formattedAnswer);

      // Parse button options from the response
      const buttonOptions = parseButtonOptions(formattedAnswer);
      const questionContext = buttonOptions ? detectQuestionContext(formattedAnswer, buttonOptions) : null;

      return {
        answer: formattedAnswer || 'Unable to generate response',
        propertyData: toolUse.name === 'get_property_info' ? toolResult : null,
        daData: toolUse.name === 'search_development_applications' ? toolResult : null,
        feasibilityData: isFeasibility ? toolResult : null,
        buttonOptions: buttonOptions,
        questionContext: questionContext,
        usedTool: true,
        toolName: toolUse.name,
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
