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
        description: 'Calculate a quick feasibility analysis. Use after user has provided: purchase price, number of units, and target sale price. Validates inputs before calculating.',
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
            densityCode: {
              type: 'string',
              description: 'Density code (RD1-RD8)'
            },
            heightLimit: {
              type: 'string',
              description: 'Height limit'
            },
            purchasePrice: {
              type: 'number',
              description: 'Land/property purchase price'
            },
            numUnits: {
              type: 'number',
              description: 'Number of units to develop or renovate'
            },
            targetSalePricePerUnit: {
              type: 'number',
              description: 'Target sale price per unit'
            },
            developmentType: {
              type: 'string',
              enum: ['apartments', 'townhouses', 'duplex', 'house', 'renovation'],
              description: 'Type of development - use "renovation" for updating existing buildings'
            },
            isRenovation: {
              type: 'boolean',
              description: 'Set to true if this is a renovation of existing buildings, not new construction'
            },
            constructionCostPerSqm: {
              type: 'number',
              description: 'Construction cost per sqm of GFA. For renovation use 800-1500, for new build use 3500-5000.'
            },
            avgUnitSize: {
              type: 'number',
              description: 'Average unit size in sqm (default 85)'
            },
            targetMarginPercent: {
              type: 'number',
              description: 'Target profit margin percentage (default 20)'
            },
            suburb: {
              type: 'string',
              description: 'Suburb for market context'
            }
          },
          required: ['purchasePrice', 'numUnits', 'targetSalePricePerUnit']
        }
      }
    ];

    // Build context-aware system prompt
    const contextSummary = buildContextSummary(conversationContext);
    
    const systemPrompt = `You are Dev.i, a friendly Gold Coast property development advisor.

CRITICAL RULES - FIGURES AND DATA:
- NEVER invent or estimate market prices, rental yields, growth rates, or suburb statistics
- NEVER quote specific dollar figures for property values unless the user provided them
- If asked about suburb performance, prices, or market data, say "I don't have current market data for that - you'd want to check recent sales on sale data provider websites or talk to a local agent"
- You CAN discuss planning controls, zoning, overlays, development potential - these come from official sources
- You CAN do feasibility calculations with user-provided figures
- For CONSTRUCTION COSTS: If user doesn't provide them, use these industry estimates WITH DISCLAIMER:
  * New apartments/units: $3,500-4,500/sqm
  * Townhouses: $2,800-3,500/sqm
  * Renovation/refurb: $1,000-2,000/sqm
  * High-end fitout: $4,500-6,000/sqm
  * ALWAYS say "Based on rough industry estimates - consult a Quantity Surveyor or refer to an accredited costing guide for accurate rates"

PLANNING FLEXIBILITY - CODE VS IMPACT ASSESSABLE:
- If a proposal EXCEEDS planning scheme limits (density, height, setbacks etc), DO NOT say "you can't do this"
- Instead explain: "Under the planning scheme, the site would allow for up to [X]. Your proposal exceeds this, which means you'd likely need an Impact Assessable DA rather than Code Assessable"
- Impact assessable = council assesses on merit, can approve variations if justified
- Frame it as: "Achievable but needs Impact Assessable DA approval - adds time, cost, public notification, and some risk council could refuse or require changes"
- Only hard limits are things like flood levels, bushfire safety, airport height restrictions - these genuinely can't be varied
- Be encouraging but honest about the extra process involved

WRITING STYLE:
- Short, punchy sentences. No fluff.
- Lead with the key insight, then supporting details.
- Keep paragraphs to 2-3 sentences MAX.
- Total response: 120-180 words (not 250+)
- Sound like a sharp mate who knows planning, not a report.

FORMATTING:
- Never use asterisks (*) anywhere
- Blank line between paragraphs

HANDLING AMBIGUOUS RESPONSES:
- If user says "yes", "ok", "sure" to a question with multiple options, use ask_clarification tool
- Don't guess what they meant - ask them to choose specifically
- Example: Asked "Quick or detailed?" and user says "yes" → ask them to pick one

FEASIBILITY RULES:
- ALWAYS ask "Quick high level feaso or more detailed feasibility calculator?" first - use mode="selection"
- Only proceed to quick/detailed after user EXPLICITLY chooses
- If conversation was about RENOVATION, set developmentType="renovation" and isRenovation=true
- For renovation: construction costs are ~$1000-1500/sqm, not $4000+
- VALIDATE sale prices: If per-unit price seems way off for the suburb, use ask_clarification

QUICK FEASIBILITY FLOW:

When user asks for a feasibility/feaso, follow this EXACT sequence. Be concise - no fluff, no "nice one!", no unnecessary commentary.

STEP 1 - SITE LOOKUP:
After user provides address, look it up and respond EXACTLY like this:
"Found it - [address].

Site: [X]sqm
Zone: [zone name] ([density code])
Height: [X]m
Max density: [X] bedrooms/dwellings

What's your play?"

Then show buttons: [New build] [Knockdown rebuild] [Renovation]

STEP 2 - PLANNING CORRECTIONS:
If user corrects planning parameters, accept immediately without questioning:
"Got it - [corrected parameters]. What's your play?"
Do NOT question or verify corrections - user knows their site.

STEP 3 - UNIT MIX:
After project type, ask:
"What's the unit mix and sizes?"

User may respond with various formats like:
- "8 x 3-bed at 150sqm each"
- "6 units plus 2 penthouses, 400sqm and 700sqm"
- "2 per floor, 4 levels, 300sqm each"
- "50 units, about 100 sqm each"

Parse this and confirm total saleable area, then ask:
"Just to confirm, [X] units, and roughly [Y]sqm total saleable area.

What's your target GRV?"

Show buttons: [$/sqm rate] [$ per unit] [$ total]

STEP 4 - GRV:
After user provides GRV (via button selection or direct input):
- If $/sqm: "[rate] x [saleable] = $[total] GRV"
- If per unit: "[units] x [price] = $[total] GRV"
- If total: confirm the total

Then ask: "What's the land value?"

STEP 5 - LAND VALUE:
After land value: "$[X] land.

What's your total construction cost (or $/sqm of GFA) including build costs, professional fees, plus statutory (Council) fees?"

STEP 6 - CONSTRUCTION:
After construction cost: "$[X] construction. Does that include contingency?"

Show buttons: [Yes] [No]

If user says No, note that 5% will be added.

STEP 7 - EFFICIENCY CHECK:
If user gave $/sqm for construction and you only have NSA, ask:
"What's the building efficiency (NSA/Common Areas? Or what's the GFA?"

Show buttons: [50%] [55%] [60%] [65%] [70%] [Custom...]

Use this to calculate: GFA = NSA / efficiency

STEP 8 - FINANCE INPUTS:
Now collect finance inputs. Ask each one with buttons:

"What's your LVR?"
Buttons: [50%] [60%] [70%] [80%] [90%] [Fully funded] [Custom...]

"Selling costs (incl agent and marketing)?"
Buttons: [2%] [3%] [4%] [Custom...]

"Interest rate?"
Buttons: [6.5%] [7%] [7.5%] [8%] [Custom...]

"Project timeline?"
Buttons: [12 months] [18 months] [24 months] [30 months] [Custom...]

"GST treatment?"
Buttons: [Margin scheme] [Fully taxed]

If Margin scheme: "What's the GST cost base?"

STEP 9 - CALCULATE:
After all inputs collected, call calculate_quick_feasibility with ALL values.

RESULTS FORMAT:
Show results in this exact format:

"[Address]

High-Level, preliminary feasibility (assumptions have been made within this calculation)

| | |
|---|---|
| GRV | $[X] |
| Land | $[X] |
| Construction | $[X] |
| Selling costs | $[X] |
| Finance | $[X] |
| Total Cost | $[X] |
| Profit | $[X] |
| Margin | [X]% |

Your inputs:
| | |
|---|---|
| Saleable | [X]sqm |
| Land | $[X] |
| Construction | $[X] |
| Selling costs | [X]% |
| LVR | [X]% |
| Interest | [X]% |
| Timeline | [X] months |
| GST | [scheme] |

Assumptions:
| | |
|---|---|
| Finance draw | 50% average outstanding |
| Stamp duty | Excluded |
| Holding costs | Excluded |

Residual land value at 20% margin: $[X] — [you paid $X over/under]"

Show buttons: [Adjust Inputs] [Export PDF]

CRITICAL QUICK FEASO RULES:
1. NEVER just assume construction costs - always ask. Only assume if they say they don't know. 
2. NEVER question prices for premium locations (Hedges Ave, Jefferson Lane, Main Beach, Noosa)
3. If user corrects planning parameters, accept without verification
4. Keep responses SHORT - data and one question only, no commentary
5. If user provides $/sqm for construction, ask for GFA or efficiency
6. Show ALL assumptions in results
7. Trust the user - they know their project
8. Each message should have ONE question maximum
9. Use buttons wherever possible to speed up input
`;

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

DO NOT offer feasibility unprompted. Only when explicitly asked.`;

    // Build messages array with conversation history
    const messages = [];
    
    if (conversationHistory && conversationHistory.length > 0) {
      console.log('[CLAUDE] Adding conversation history...');
      const recentHistory = conversationHistory.slice(-10);
      
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
        
        const { calculateQuickFeasibility } = await import('./feasibility-calculator.js');
        
        // Determine if this is a renovation based on input or context
        const isRenovation = toolUse.input.isRenovation || 
                            toolUse.input.developmentType === 'renovation' ||
                            conversationContext.developmentStrategy === 'renovation';
        
        // Construction cost estimates with type awareness
        // These are industry estimates - will be replaced with Rawlinsons RAG data
        let constructionCost = toolUse.input.constructionCostPerSqm;
        let costDisclaimer = null;
        
        if (!constructionCost) {
          if (isRenovation) {
            constructionCost = 1500; // Mid-range renovation
            costDisclaimer = 'Using industry estimate of $1,500/sqm for renovation - get a QS quote or check Rawlinsons for accurate costs';
          } else {
            const devType = toolUse.input.developmentType || 'apartments';
            if (devType === 'townhouses') {
              constructionCost = 3200;
              costDisclaimer = 'Using industry estimate of $3,200/sqm for townhouses - get a QS quote or check Rawlinsons for accurate costs';
            } else if (devType === 'house' || devType === 'duplex') {
              constructionCost = 2800;
              costDisclaimer = 'Using industry estimate of $2,800/sqm for houses/duplex - get a QS quote or check Rawlinsons for accurate costs';
            } else {
              constructionCost = 4000; // Apartments default
              costDisclaimer = 'Using industry estimate of $4,000/sqm for apartments - get a QS quote or check Rawlinsons for accurate costs';
            }
          }
        }
        
        const feasResult = calculateQuickFeasibility({
          address: toolUse.input.propertyAddress || conversationContext.lastProperty,
          siteArea: toolUse.input.siteArea || conversationContext.lastSiteArea,
          densityCode: toolUse.input.densityCode || conversationContext.lastDensity,
          heightLimit: toolUse.input.heightLimit || conversationContext.lastHeight,
          purchasePrice: toolUse.input.purchasePrice,
          numUnits: toolUse.input.numUnits,
          targetSalePricePerUnit: toolUse.input.targetSalePricePerUnit,
          developmentType: isRenovation ? 'renovation' : (toolUse.input.developmentType || 'apartments'),
          constructionCostPerSqm: constructionCost,
          avgUnitSize: toolUse.input.avgUnitSize || 85,
          targetMarginPercent: toolUse.input.targetMarginPercent || 20,
        });
        
        // Add context about what type of analysis this was
        feasResult.analysisType = isRenovation ? 'renovation' : 'new_build';
        feasResult.constructionCostUsed = constructionCost;
        feasResult.costDisclaimer = costDisclaimer;
        feasResult.contextNote = isRenovation 
          ? `Renovation analysis using $${constructionCost.toLocaleString()}/sqm construction cost estimate`
          : `New build analysis using $${constructionCost.toLocaleString()}/sqm construction cost estimate`;
        
        if (sendProgress) sendProgress('✅ Feasibility calculated');
        
        toolResult = {
          ...feasResult,
          feasibilityMode: 'results'
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
