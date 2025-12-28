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
 * IMPROVED: More careful about what patterns mean
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
    developmentStrategy: null,
    existingUnits: null,  // Only set if EXISTING units mentioned
    proposedUnits: null,  // NEW: Track proposed development
    isStrata: false,
    priceDiscussed: null,
    budgetRange: null
  };
  
  if (!conversationHistory || conversationHistory.length === 0) {
    return context;
  }
  
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
    const areaMatch = content.match(/(?:site|land|block|lot).*?(\d+)\s*(?:sqm|m2|square\s*met)/i);
    if (areaMatch) {
      context.lastSiteArea = parseInt(areaMatch[1]);
    }
    
    // Look for density codes
    const densityMatch = content.match(/\b(RD[1-8])\b/i);
    if (densityMatch) {
      context.lastDensity = densityMatch[1].toUpperCase();
    }
    
    // Look for height
    const heightMatch = content.match(/(\d+)\s*m(?:etre)?s?\s*(?:height|limit)/i);
    if (heightMatch) {
      context.lastHeight = `${heightMatch[1]}m`;
    }
    
    // IMPROVED: Detect development strategy more carefully
    if (contentLower.includes('renovate') || contentLower.includes('renovation') || contentLower.includes('refurb')) {
      context.developmentStrategy = 'renovation';
    }
    if (contentLower.includes('new build') || contentLower.includes('knock down') || contentLower.includes('demolish') || contentLower.includes('knockdown')) {
      context.developmentStrategy = 'new_build';
    }
    if (contentLower.includes('subdivide') || contentLower.includes('subdivision')) {
      context.developmentStrategy = 'subdivision';
    }
    
    // IMPROVED: Only detect EXISTING units, not proposed
    // Look for "existing X units" or "currently X units" or "has X units"
    const existingUnitsMatch = content.match(/(?:existing|current|currently|already|has)\s+(\d+)\s*units?/i);
    if (existingUnitsMatch) {
      context.existingUnits = parseInt(existingUnitsMatch[1]);
    }
    
    // IMPROVED: Detect PROPOSED units separately
    // "build X units" or "X unit project" or "developing X units"
    const proposedUnitsMatch = content.match(/(?:build|building|develop|developing|propose|proposing|want|planning)\s+(?:a\s+)?(\d+)\s*(?:unit|apartment)/i);
    if (proposedUnitsMatch) {
      context.proposedUnits = parseInt(proposedUnitsMatch[1]);
    }
    
    // Also catch "X unit project" pattern
    const unitProjectMatch = content.match(/(\d+)\s*unit\s*(?:project|development|build)/i);
    if (unitProjectMatch) {
      context.proposedUnits = parseInt(unitProjectMatch[1]);
    }
    
    // Detect strata - only if explicitly mentioned
    if (contentLower.includes('strata title') || contentLower.includes('body corp') || contentLower.includes('existing strata')) {
      context.isStrata = true;
    }
    
    // Look for budget/price discussions
    const priceMatch = content.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(?:m(?:illion)?|k)?/gi);
    if (priceMatch) {
      context.priceDiscussed = priceMatch[priceMatch.length - 1];
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
  if (context.lastHeight) {
    parts.push(`Height limit: ${context.lastHeight}`);
  }
  if (context.developmentStrategy) {
    parts.push(`Strategy discussed: ${context.developmentStrategy.toUpperCase()}`);
  }
  if (context.proposedUnits) {
    parts.push(`Proposed units: ${context.proposedUnits}`);
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
 * Get planning advisory from Claude with function calling
 */
export async function getAdvisory(userQuery, conversationHistory = [], sendProgress = null) {
  try {
    console.log('=====================================');
    console.log('[CLAUDE] New advisory request');
    console.log('[CLAUDE] User query:', userQuery);
    console.log('[CLAUDE] Conversation history length:', conversationHistory?.length || 0);
    console.log('=====================================');

    const conversationContext = extractConversationContext(conversationHistory);
    console.log('[CLAUDE] Extracted context:', JSON.stringify(conversationContext, null, 2));

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
              description: 'Type of development based on conversation context.'
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
              description: 'Which mode to start in. ALWAYS use "selection" first to ask user preference.'
            }
          },
          required: ['propertyAddress', 'mode']
        }
      },
      {
        name: 'calculate_feasibility',
        description: 'Calculate feasibility or residual land value. Use after collecting inputs from user. Can work forwards (given land value, calculate profit) or backwards (given target margin, calculate max land value). Parse ALL inputs the user has given across the conversation.',
        input_schema: {
          type: 'object',
          properties: {
            calculationType: {
              type: 'string',
              enum: ['standard', 'residual_land_value'],
              description: 'standard = calculate profit given land value. residual_land_value = calculate max land value given target margin.'
            },
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
              description: 'Number of units'
            },
            unitMix: {
              type: 'string',
              description: 'Description of unit mix'
            },
            saleableArea: {
              type: 'number',
              description: 'Total saleable area (NSA) in sqm'
            },
            grv: {
              type: 'number',
              description: 'Gross realisation value (total sales revenue including GST)'
            },
            landValue: {
              type: 'number',
              description: 'Land value - required for standard calc, not needed for residual calc'
            },
            constructionCost: {
              type: 'number',
              description: 'Total construction cost'
            },
            constructionPerSqm: {
              type: 'number',
              description: 'Construction cost per sqm of GFA (alternative to total)'
            },
            gfa: {
              type: 'number',
              description: 'Gross floor area in sqm'
            },
            efficiency: {
              type: 'number',
              description: 'Building efficiency as decimal (0.6 = 60%)'
            },
            contingencyIncluded: {
              type: 'boolean',
              description: 'Whether contingency is included. Default false (will add 5%)'
            },
            lvr: {
              type: 'number',
              description: 'LVR as percentage (70 = 70%, 100 = fully funded)'
            },
            interestRate: {
              type: 'number',
              description: 'Interest rate as percentage (6.75 = 6.75%)'
            },
            sellingCostsPercent: {
              type: 'number',
              description: 'Selling costs as percentage (3 = 3%). Default 3.'
            },
            timelineMonths: {
              type: 'number',
              description: 'Project timeline in months'
            },
            gstScheme: {
              type: 'string',
              enum: ['margin', 'fully_taxed'],
              description: 'GST scheme. Default margin.'
            },
            gstCostBase: {
              type: 'number',
              description: 'GST cost base for margin scheme'
            },
            targetMarginPercent: {
              type: 'number',
              description: 'Target margin for residual calcs. Default 20.'
            }
          },
          required: ['calculationType', 'propertyAddress', 'numUnits', 'saleableArea', 'grv']
        }
      }
    ];

    const contextSummary = buildContextSummary(conversationContext);
    
    const systemPrompt = `You are Dev.i, a Gold Coast property development advisor.

CRITICAL: BE SMART ABOUT PARSING USER INPUTS

Users don't follow scripts. They give information in whatever order makes sense to them. Your job is to:

1. IDENTIFY THE TASK
   - "what should I pay" / "what's the land worth" / "max land value" → RESIDUAL LAND VALUE calculation
   - "run a feaso" / "check the numbers" / "does this stack up" → STANDARD FEASIBILITY  
   - "what's the profit" / "what margin" → PROFIT CALCULATION (standard feaso)

2. PARSE ALL INPUTS FROM EACH MESSAGE
   Extract every number and figure mentioned. Examples:
   - "3 units at 300sqm" → numUnits: 3, unitSize: 300, saleableArea: 900
   - "$35k/sqm sales" → grv = saleableArea × 35000
   - "fully funded" or "full fund" or "100% LVR" → lvr: 100
   - "6.75" when discussing interest → interestRate: 6.75 (NOT 675%)
   - "18 months" or "18mo" or "18m" → timelineMonths: 18
   - "$10k/sqm construction at 60% efficiency" → constructionPerSqm: 10000, efficiency: 0.6

3. TRACK STATE ACROSS THE CONVERSATION
   Remember what the user has already told you. Don't ask for things they've given.
   If they said "300sqm units" earlier, you know the unit size.

4. CALCULATE DERIVED VALUES
   - saleableArea = numUnits × unitSize (if given separately)
   - GFA = saleableArea / efficiency
   - constructionTotal = GFA × constructionPerSqm
   - grv = saleableArea × grvPerSqm (or numUnits × grvPerUnit)

5. USE SENSIBLE DEFAULTS (if not specified)
   - contingencyIncluded: false (add 5%)
   - sellingCostsPercent: 3
   - gstScheme: 'margin'
   - targetMarginPercent: 20

6. NEVER ASSUME THESE - MUST ASK:
   - Construction cost or rate
   - GRV / sale prices
   - LVR
   - Interest rate
   - Timeline

7. ASK ONLY FOR MISSING CRITICAL ITEMS
   One question at a time. Be specific about what you need.

8. UNDERSTAND VARIATIONS - these mean the same thing:
   - "fully funded" = "full fund" = "100% LVR" = "100% lvr"
   - "18 months" = "18mo" = "18m" 
   - "6.75" = "6.75%" (in interest rate context)
   - "$35k" = "$35,000" = "35k" = "35000"
   - "margin" = "margin scheme"
   - "3%" = "3" (in percentage context)

9. WHEN USER GIVES LOTS OF INFO AT ONCE
   Parse it all, confirm briefly, then calculate:
   "Got it - 3 units × 300sqm = 900sqm, $35k/sqm = $31.5M GRV, $15M construction, fully funded at 6.75% over 18 months. Calculating..."

10. RESIDUAL LAND VALUE CALCULATIONS
    When user wants to know what to pay:
    - Use calculationType: 'residual_land_value'
    - Show result at 20% margin
    - Also show 15% and 25% for context
    - Don't need landValue input (that's what you're solving for)
    - GST cost base = land value (circular) - handle by using margin on full GRV

11. IF USER CORRECTS YOU
    Accept immediately. Don't argue or re-ask.
    "Got it - [corrected value]. Continuing..."

12. IF NUMBERS SEEM OFF
    Check ONCE, then accept if confirmed:
    "Just checking - $35k/sqm is ultra-premium. Confirm?"
    If they confirm, use it. Don't ask again.

WRITING STYLE:
- Short, punchy sentences
- No fluff or unnecessary commentary
- Lead with the answer/result
- Show your working so user can verify inputs

FORMATTING:
- Never use asterisks or markdown formatting
- Use tables for results
- Blank line between paragraphs

PLANNING FLEXIBILITY:
- If proposal exceeds planning limits, note it needs Impact Assessable DA
- Don't block feasibility for planning exceedances - developers do this all the time
- Only hard limits are flood, bushfire, airport restrictions

${contextSummary}

DO NOT offer feasibility unprompted. Only when explicitly asked.`;

    // Build messages array - INCREASED HISTORY
    const messages = [];
    
    if (conversationHistory && conversationHistory.length > 0) {
      console.log('[CLAUDE] Adding conversation history...');
      // INCREASED from 10 to 20 messages
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
      max_tokens: 1200,  // Increased for longer responses
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
      
      // Handle DA search tool
      else if (toolUse.name === 'search_development_applications') {
        if (sendProgress) sendProgress('🔍 Searching development applications...');
        
        let searchAddress = toolUse.input.address;
        const inputSuburb = toolUse.input.suburb;
        
        const hasSuburb = /(?:mermaid|broadbeach|surfers|southport|palm beach|burleigh|robina|varsity|hope island|coolangatta|currumbin|tugun|miami)/i.test(searchAddress);
        
        if (!hasSuburb) {
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
      
      // Handle start feasibility tool
      else if (toolUse.name === 'start_feasibility') {
        console.log('[CLAUDE] Starting feasibility analysis, mode:', toolUse.input.mode);
        if (sendProgress) sendProgress('📊 Preparing feasibility analysis...');
        
        const { getDetailedFeasibilityPreFill } = await import('./feasibility-calculator.js');
        
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
      
      // Handle feasibility calculation
      else if (toolUse.name === 'calculate_feasibility') {
        console.log('[CLAUDE] Calculating feasibility');
        console.log('[CLAUDE] Calculation type:', toolUse.input.calculationType);
        if (sendProgress) sendProgress('🔢 Crunching the numbers...');
        
        const input = toolUse.input;
        
        // Calculate GFA if not provided
        let gfa = input.gfa;
        if (!gfa && input.saleableArea && input.efficiency) {
          gfa = input.saleableArea / input.efficiency;
        }
        
        // Calculate construction cost
        let constructionCost = input.constructionCost;
        if (!constructionCost && input.constructionPerSqm && gfa) {
          constructionCost = input.constructionPerSqm * gfa;
        }
        
        // Add contingency if not included (default: not included)
        const contingencyIncluded = input.contingencyIncluded || false;
        const constructionWithContingency = contingencyIncluded 
          ? constructionCost 
          : constructionCost * 1.05;
        
        // Use defaults for optional inputs
        const lvr = input.lvr || 70;
        const interestRate = input.interestRate || 7.5;
        const sellingCostsPercent = input.sellingCostsPercent || 3;
        const timelineMonths = input.timelineMonths || 24;
        const gstScheme = input.gstScheme || 'margin';
        const targetMarginPercent = input.targetMarginPercent || 20;
        
        // Convert to decimals
        const lvrDecimal = lvr / 100;
        const interestDecimal = interestRate / 100;
        const sellingDecimal = sellingCostsPercent / 100;
        const targetMarginDecimal = targetMarginPercent / 100;
        
        // Calculate GST
        const grv = input.grv;
        let grvExclGST;
        if (gstScheme === 'margin' && input.gstCostBase) {
          const margin = grv - input.gstCostBase;
          const gstPayable = margin / 11;
          grvExclGST = grv - gstPayable;
        } else {
          // For residual calcs without cost base, use simple /1.1
          grvExclGST = grv / 1.1;
        }
        
        // Selling costs
        const sellingCosts = grvExclGST * sellingDecimal;
        
        if (input.calculationType === 'residual_land_value') {
          // RESIDUAL LAND VALUE CALCULATION
          // Working backwards: GRV - costs - target profit = max land value
          
          // For each margin scenario, calculate max land value
          const calculateResidual = (marginPercent) => {
            const marginDecimal = marginPercent / 100;
            const targetProfit = grvExclGST * marginDecimal;
            
            // Iterative calculation because finance costs depend on land value
            // Start with estimate
            let landEstimate = grvExclGST - constructionWithContingency - sellingCosts - targetProfit;
            
            for (let i = 0; i < 5; i++) {
              const totalDebt = (landEstimate + constructionWithContingency) * lvrDecimal;
              const avgDebt = totalDebt * 0.5;
              const financeCosts = avgDebt * interestDecimal * (timelineMonths / 12);
              
              landEstimate = grvExclGST - constructionWithContingency - sellingCosts - financeCosts - targetProfit;
            }
            
            return Math.round(landEstimate);
          };
          
          const residualAt15 = calculateResidual(15);
          const residualAt20 = calculateResidual(20);
          const residualAt25 = calculateResidual(25);
          
          // Calculate full breakdown at target margin
          const totalDebt = (residualAt20 + constructionWithContingency) * lvrDecimal;
          const avgDebt = totalDebt * 0.5;
          const financeCosts = avgDebt * interestDecimal * (timelineMonths / 12);
          const totalCost = residualAt20 + constructionWithContingency + sellingCosts + financeCosts;
          const profit = grvExclGST - totalCost;
          const actualMargin = (profit / grvExclGST) * 100;
          
          if (sendProgress) sendProgress('✅ Feasibility calculated');
          
          toolResult = {
            success: true,
            feasibilityMode: 'results',
            calculationType: 'residual_land_value',
            
            inputs: {
              address: input.propertyAddress,
              numUnits: input.numUnits,
              unitMix: input.unitMix,
              saleableArea: input.saleableArea,
              gfa: Math.round(gfa),
              efficiency: input.efficiency,
              constructionPerSqm: input.constructionPerSqm,
              constructionTotal: Math.round(constructionWithContingency),
              contingencyIncluded: contingencyIncluded,
              lvr: lvr,
              interestRate: interestRate,
              sellingCostsPercent: sellingCostsPercent,
              timelineMonths: timelineMonths,
              gstScheme: gstScheme
            },
            
            revenue: {
              grvInclGST: grv,
              grvExclGST: Math.round(grvExclGST)
            },
            
            costs: {
              construction: Math.round(constructionWithContingency),
              selling: Math.round(sellingCosts),
              finance: Math.round(financeCosts)
            },
            
            residualLandValue: {
              at15Percent: residualAt15,
              at20Percent: residualAt20,
              at25Percent: residualAt25
            },
            
            targetMargin: targetMarginPercent,
            
            assumptions: {
              contingency: contingencyIncluded ? 'Included' : 'Added 5%',
              financeDrawProfile: '50% average outstanding',
              stampDuty: 'Excluded from land value',
              holdingCosts: 'Excluded'
            }
          };
        } else {
          // STANDARD FEASIBILITY CALCULATION
          const landValue = input.landValue;
          
          const totalDebt = (landValue + constructionWithContingency) * lvrDecimal;
          const avgDebt = totalDebt * 0.5;
          const financeCosts = avgDebt * interestDecimal * (timelineMonths / 12);
          
          const totalCost = landValue + constructionWithContingency + sellingCosts + financeCosts;
          const grossProfit = grvExclGST - totalCost;
          const profitMargin = (grossProfit / grvExclGST) * 100;
          
          // Calculate residual for comparison
          const targetProfit = grvExclGST * targetMarginDecimal;
          const residualLandValue = grvExclGST - constructionWithContingency - sellingCosts - financeCosts - targetProfit;
          
          let viability;
          if (profitMargin >= 25) viability = 'viable';
          else if (profitMargin >= 20) viability = 'marginal';
          else if (profitMargin >= 15) viability = 'challenging';
          else viability = 'not_viable';
          
          if (sendProgress) sendProgress('✅ Feasibility calculated');
          
          toolResult = {
            success: true,
            feasibilityMode: 'results',
            calculationType: 'standard',
            
            inputs: {
              address: input.propertyAddress,
              numUnits: input.numUnits,
              unitMix: input.unitMix,
              saleableArea: input.saleableArea,
              gfa: gfa ? Math.round(gfa) : null,
              landValue: landValue,
              constructionTotal: Math.round(constructionWithContingency),
              lvr: lvr,
              interestRate: interestRate,
              sellingCostsPercent: sellingCostsPercent,
              timelineMonths: timelineMonths,
              gstScheme: gstScheme
            },
            
            revenue: {
              grvInclGST: grv,
              grvExclGST: Math.round(grvExclGST),
              avgPricePerUnit: Math.round(grv / input.numUnits)
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
              vsActualLand: Math.round(residualLandValue - landValue),
              landIsFairValue: residualLandValue >= landValue
            },
            
            assumptions: {
              contingency: contingencyIncluded ? 'Included' : 'Added 5%',
              financeDrawProfile: '50% average outstanding',
              stampDuty: 'Excluded',
              holdingCosts: 'Excluded'
            },
            
            timeline: {
              totalMonths: timelineMonths
            }
          };
        }
      }

      // Send the tool result back to Claude
      const finalResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
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
      
      const isFeasibility = toolUse.name === 'start_feasibility' || toolUse.name === 'calculate_feasibility';
      
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
