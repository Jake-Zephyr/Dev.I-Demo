// services/claude.js
import Anthropic from '@anthropic-ai/sdk';
import { scrapeProperty } from './goldcoast-api.js';
import { searchPlanningScheme } from './rag-simple.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

/**
 * Strip markdown formatting from Claude's response
 */
function stripMarkdown(text) {
  if (!text) return text;
  
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/\*/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^[\-•]\s*/gm, '')
    .replace(/^\d+[\.\)]\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/  +/g, ' ')
    .trim();
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
  
  // Scan through history looking for property data and strategy signals
  for (const msg of conversationHistory) {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    const contentLower = content.toLowerCase();
    
    // Look for property addresses
    const addressMatch = content.match(/(\d+\s+[\w\s]+(?:street|st|avenue|ave|court|crt|road|rd|drive|dr|parade|pde|circuit|cct|crescent|cres|place|pl|way|lane|ln)),?\s*([\w\s]+?)(?:,|\s+QLD|\s+\d{4}|$)/i);
    if (addressMatch) {
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
    
    // Look for lotplan
    const lotplanMatch = content.match(/\b(\d+[A-Z]{2,4}\d+)\b/i);
    if (lotplanMatch) {
      context.lastLotplan = lotplanMatch[1].toUpperCase();
    }
    
    // Look for site area
    const areaMatch = content.match(/(\d+)\s*(?:sqm|m2|square\s*met)/i);
    if (areaMatch) {
      context.lastSiteArea = parseInt(areaMatch[1]);
    }
    
    // Look for density codes
    const densityMatch = content.match(/\b(RD[1-8])\b/i);
    if (densityMatch) {
      context.lastDensity = densityMatch[1].toUpperCase();
    }
    
    // Look for height
    const heightMatch = content.match(/(\d+)\s*m(?:etre)?s?\s*height/i);
    if (heightMatch) {
      context.lastHeight = `${heightMatch[1]}m`;
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
        description: 'Look up current Gold Coast property planning details including zone, density, height limits, overlays, and relevant planning scheme text. Use this for zoning questions, planning controls, what can be built, overlay information. IMPORTANT: This tool works best with lot/plan numbers (e.g., "295RP21863"). Address searches can be unreliable.',
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
  description: 'Calculate a quick feasibility analysis. ONLY use after collecting ALL required inputs from user: project type, units/sizes, GRV, construction cost, LVR, interest rate, timeline, selling costs, GST scheme. DO NOT call this tool until you have asked for and received all inputs.',
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
      projectType: {
        type: 'string',
        enum: ['new_build', 'knockdown_rebuild', 'renovation'],
        description: 'Type of project'
      },
      numUnits: {
        type: 'number',
        description: 'Number of units'
      },
      unitMix: {
        type: 'string',
        description: 'Description of unit sizes, e.g. "4 x 150sqm" or "3 x 200sqm + 1 x 300sqm penthouse"'
      },
      saleableArea: {
        type: 'number',
        description: 'Total saleable area (NSA) in sqm - calculate from unit mix'
      },
      grvTotal: {
        type: 'number',
        description: 'Gross Realisation Value - total sales revenue including GST'
      },
      grvMethod: {
        type: 'string',
        enum: ['per_sqm', 'per_unit', 'total'],
        description: 'How user provided GRV'
      },
      landValue: {
        type: 'number',
        description: 'Land/property purchase price'
      },
      constructionCost: {
        type: 'number',
        description: 'Total construction cost - MUST be provided by user, never assumed'
      },
      contingencyIncluded: {
        type: 'boolean',
        description: 'Whether contingency is included in construction cost'
      },
      lvr: {
        type: 'number',
        description: 'Loan to Value Ratio as percentage (70 = 70%, 100 = fully funded)'
      },
      interestRate: {
        type: 'number',
        description: 'Interest rate as percentage (6.75 = 6.75%)'
      },
      timelineMonths: {
        type: 'number',
        description: 'Total project timeline in months'
      },
      sellingCostsPercent: {
        type: 'number',
        description: 'Selling costs as percentage (3 = 3%)'
      },
      gstScheme: {
        type: 'string',
        enum: ['margin', 'fully_taxed'],
        description: 'GST treatment - margin scheme or fully taxed'
      },
      targetMarginPercent: {
        type: 'number',
        description: 'Target profit margin percentage (default 20)'
      }
    },
    required: ['numUnits', 'saleableArea', 'grvTotal', 'constructionCost', 'lvr', 'interestRate', 'timelineMonths', 'sellingCostsPercent', 'gstScheme']
  }
}
    ];

    // Build context-aware system prompt
    const contextSummary = buildContextSummary(conversationContext);
    
const systemPrompt = `You are Dev.i, a friendly Gold Coast property development advisor.

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
- Example: "600sqm site with RD6 = 600/33 = 18 bedrooms max. So you could do 6 x 3-bed units or 9 x 2-bed units theoretically, but height will probably limit you before density does."

CRITICAL RULES - FIGURES AND DATA:
- NEVER invent or estimate market prices, rental yields, growth rates, or suburb statistics
- Never question the values for the proposed dwellings if someone mentions they will able to sell something for X amount, if the GR values seem high, just comment and say they are strong, repeat the amount they have told you, then move on. 
- NEVER quote specific dollar figures for property values unless the user provided them
- If asked about suburb performance, prices, or market data, say "I don't have current market data for that - you'd want to check recent sales on realestate.com.au or talk to a local agent"
- You CAN discuss planning controls, zoning, overlays, development potential - these come from official sources
- You CAN do feasibility calculations with user-provided figures
- For CONSTRUCTION COSTS: If user doesn't provide them, use these industry estimates WITH DISCLAIMER:
  * New apartments/units: $3,500-$8,000/sqm
  * Townhouses: $2,800-$3,500/sqm  
  * Renovation/refurb: $1,000-$3,000/sqm
  * High-end fitout: $4,500-$10,000/sqm
  * ALWAYS say "Based on industry estimates - get a QS quote or check Rawlinsons for accurate costs"

PLANNING FLEXIBILITY - CODE VS IMPACT ASSESSABLE:
- If a proposal EXCEEDS planning scheme limits (density, height, setbacks etc), DO NOT say "you can't do this"
- Instead explain: "Under the planning scheme this would be [X]. Your proposal exceeds this, which means you'd need an IMPACT ASSESSABLE DA rather than code assessable"
- Impact assessable = council assesses on merit, can approve variations if justified
- Frame it as: "Achievable but needs DA approval - adds time, cost, and some risk council could refuse or require changes"
- Only hard limits are things like flood levels, bushfire safety, airport height restrictions - these genuinely can't be varied
- Be encouraging but honest about the extra process involved

WRITING STYLE:
- Short, punchy sentences. No fluff.
- Lead with the key insight, then supporting details.
- Keep paragraphs to 2-3 sentences max.
- Total response: 120-180 words (not 250+)
- Sound like a sharp mate who knows planning, not a report.

FORMATTING:
- Never use asterisks (*) anywhere
- Blank line between paragraphs
- No bullet points in conversation

HANDLING AMBIGUOUS RESPONSES:
- If user says "yes", "ok", "sure" to a question with multiple options, use ask_clarification tool
- Don't guess what they meant - ask them to choose specifically
- Example: Asked "Quick or detailed?" and user says "yes" → ask them to pick one

FEASIBILITY RULES:
- ALWAYS ask "Quick feaso or detailed calculator?" first - use mode="selection"
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

Step 1: Project type (if not already known)
"What type of project? [New build] [Knockdown rebuild] [Renovation]"

Step 2: Unit count and sizes
"How many units and what sizes? E.g. '4 units at 150sqm each' or '3 x 200sqm + 1 x 300sqm penthouse'"

Step 3: GRV (Gross Realisation Value)
"What's your target sale price? [$/sqm rate] [$ per unit] [$ total GRV]"

Step 4: Construction cost - NEVER ASSUME THIS
"What's your total construction cost including professional fees, statutory fees, and contingency?"
DO NOT suggest a $/sqm rate unless user explictly asks for market rates. Wait for user to provide their number.

Step 5: Finance inputs
"Finance details:
- LVR? [60%] [70%] [80%] [Fully funded]
- Interest rate?
- Project timeline in months?"

Step 6: Other costs
"- Selling costs (agent + marketing)? [3%] [4%] [Custom]
- GST treatment? [Margin scheme] [Fully taxed]"
multiple choice options appear as buttons. If user selects Margin Scheme, make the button open a chat box for the user to input what the project's cost base will be and say: "What is the project's cost base for Margin Scheme purposes?"

Step 7: Calculate
Only call calculate_quick_feasibility AFTER collecting ALL inputs above.

CRITICAL RULES FOR QUICK FEASO:
- NEVER assume construction costs - always ask the user
- NEVER assume LVR, interest rate, or timeline - always ask
- Accept user corrections immediately without questioning
- If user provides all inputs at once, parse them and confirm before calculating
- One question per message maximum
- Accept variations: "fully funded" = "full fund" = "100% LVR"
- Accept variations: "18 months" = "18mo" = "18m"
- If user says "margin" for GST, that means margin scheme

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
  console.log('[CLAUDE] Calculating quick feasibility');
  if (sendProgress) sendProgress('🔢 Crunching the numbers...');
  
  const input = toolUse.input;
  
  // Get values from input
  const numUnits = input.numUnits;
  const saleableArea = input.saleableArea;
  const grvTotal = input.grvTotal;
  const landValue = input.landValue || 0;
  const constructionCost = input.constructionCost;
  const lvr = input.lvr;
  const interestRate = input.interestRate;
  const timelineMonths = input.timelineMonths;
  const sellingCostsPercent = input.sellingCostsPercent;
  const gstScheme = input.gstScheme || 'margin';
  const targetMarginPercent = input.targetMarginPercent || 20;
  const contingencyIncluded = input.contingencyIncluded !== false;
  
  // Add contingency if not included
  const constructionWithContingency = contingencyIncluded 
    ? constructionCost 
    : constructionCost * 1.05;
  
  // Convert percentages to decimals
  const lvrDecimal = lvr / 100;
  const interestDecimal = interestRate / 100;
  const sellingDecimal = sellingCostsPercent / 100;
  const targetMarginDecimal = targetMarginPercent / 100;
  
  // Calculate GST
  let grvExclGST;
  if (gstScheme === 'margin' && landValue > 0) {
    const margin = grvTotal - landValue;
    const gstPayable = margin / 11;
    grvExclGST = grvTotal - gstPayable;
  } else if (gstScheme === 'fully_taxed') {
    grvExclGST = grvTotal / 1.1;
  } else {
    // Default to simple /1.1 if no land value for margin calc
    grvExclGST = grvTotal / 1.1;
  }
  
  // Calculate costs
  const sellingCosts = grvExclGST * sellingDecimal;
  
  // Finance costs (50% average debt outstanding)
  const totalDebt = (landValue + constructionWithContingency) * lvrDecimal;
  const avgDebt = totalDebt * 0.5;
  const financeCosts = avgDebt * interestDecimal * (timelineMonths / 12);
  
  // Total costs and profit
  const totalCost = landValue + constructionWithContingency + sellingCosts + financeCosts;
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
    residualLandValue = grvExclGST - constructionWithContingency - sellingCosts - residualFinanceCosts - targetProfit;
  }
  
  // Determine viability
  let viability;
  if (profitMargin >= 25) viability = 'viable';
  else if (profitMargin >= 20) viability = 'marginal';
  else if (profitMargin >= 15) viability = 'challenging';
  else viability = 'not_viable';
  
  if (sendProgress) sendProgress('✅ Feasibility calculated');
  
  toolResult = {
    success: true,
    feasibilityMode: 'results',
    
    inputs: {
      address: input.propertyAddress || conversationContext.lastProperty,
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
      grvInclGST: grvTotal,
      grvExclGST: Math.round(grvExclGST),
      avgPricePerUnit: Math.round(grvTotal / numUnits)
    },
    
    costs: {
      land: landValue,
      construction: Math.round(constructionWithContingency),
      selling: Math.round(sellingCosts),
      finance: Math.round(financeCosts),
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
      stampDuty: 'Excluded',
      holdingCosts: 'Excluded'
    }
  };
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
      
      return {
        answer: formatIntoParagraphs(stripMarkdown(textContent?.text)) || 'Unable to generate response',
        propertyData: toolUse.name === 'get_property_info' ? toolResult : null,
        daData: toolUse.name === 'search_development_applications' ? toolResult : null,
        feasibilityData: isFeasibility ? toolResult : null,
        usedTool: true,
        toolName: toolUse.name,
        toolQuery: toolUse.input.query || toolUse.input.address || toolUse.input.propertyAddress
      };
    } else {
      console.log('[CLAUDE] Answered without tool use');
      
      const textContent = response.content.find(c => c.type === 'text');
      
      return {
        answer: formatIntoParagraphs(stripMarkdown(textContent?.text)) || 'Unable to generate response',
        propertyData: null,
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
