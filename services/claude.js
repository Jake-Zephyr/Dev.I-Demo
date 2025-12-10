// services/claude.js
import Anthropic from '@anthropic-ai/sdk';
import { scrapeProperty } from './goldcoast-api.js';
import { searchPlanningScheme } from './rag-simple.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

/**
 * Strip markdown formatting from Claude's response
 * Safety net because Claude sometimes ignores instructions
 */
function stripMarkdown(text) {
  if (!text) return text;
  
  return text
    // Remove all asterisks used for bold/italic (keep the text between them)
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    // Remove any remaining standalone asterisks
    .replace(/\*/g, '')
    // Remove ## headers
    .replace(/^#{1,6}\s*/gm, '')
    // Remove bullet points (dash or bullet character)
    .replace(/^[\-•]\s*/gm, '')
    // Remove numbered lists
    .replace(/^\d+[\.\)]\s*/gm, '')
    // Clean up multiple newlines (keep max 2)
    .replace(/\n{3,}/g, '\n\n')
    // Clean up double spaces
    .replace(/  +/g, ' ')
    .trim();
}

/**
 * Force paragraph breaks every 2-3 sentences
 * Because Claude keeps writing walls of text
 */
function formatIntoParagraphs(text) {
  if (!text) return text;
  
  // Normalize to single spaces
  let normalized = text.replace(/\n+/g, ' ').replace(/  +/g, ' ').trim();
  
  // Simple sentence split: period followed by space and capital letter
  // This regex actually splits and keeps the period with the sentence
  const sentences = [];
  let current = '';
  
  for (let i = 0; i < normalized.length; i++) {
    current += normalized[i];
    
    // Check for sentence end: period + space + capital letter (or end of string)
    if (normalized[i] === '.' && 
        (i === normalized.length - 1 || 
         (normalized[i + 1] === ' ' && /[A-Z]/.test(normalized[i + 2] || '')))) {
      sentences.push(current.trim());
      current = '';
      i++; // Skip the space
    }
  }
  
  // Don't forget leftover text
  if (current.trim()) {
    sentences.push(current.trim());
  }
  
  // If 3 or fewer sentences, return as-is
  if (sentences.length <= 3) {
    return sentences.join(' ');
  }
  
  // Group into paragraphs of 3 sentences each
  const paragraphs = [];
  for (let i = 0; i < sentences.length; i += 3) {
    const group = sentences.slice(i, i + 3);
    paragraphs.push(group.join(' '));
  }
  
  return paragraphs.join('\n\n');
}

/**
 * Get planning advisory from Claude with function calling
 * Claude will automatically call the scraper when needed
 */
export async function getAdvisory(userQuery, conversationHistory = [], sendProgress = null) {
  try {
    console.log('=====================================');
    console.log('[CLAUDE] New advisory request');
    console.log('[CLAUDE] User query:', userQuery);
    console.log('[CLAUDE] Conversation history length:', conversationHistory?.length || 0);
    console.log('=====================================');

    // Define the tools for property lookup, DA search, and feasibility
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
              description: 'Street address - can be partial like "22 Mary Avenue" or full like "22 Mary Avenue, Broadbeach, 4218"'
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
        description: 'Start a feasibility analysis for a property. Use when user asks to "run a feaso", "do a feasibility", "check the numbers", or similar. Set mode to "quick" or "detailed" if user has already specified which they want.',
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
            mode: {
              type: 'string',
              enum: ['selection', 'quick', 'detailed'],
              description: 'Which mode to start in. Use "selection" to ask user, "quick" if they chose quick, "detailed" if they chose full form/detailed'
            }
          },
          required: ['propertyAddress']
        }
      },
      {
        name: 'calculate_quick_feasibility',
        description: 'Calculate a quick feasibility analysis with minimal inputs. Use after user has provided: purchase price, number of units, and target sale price. Other values use sensible defaults.',
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
              description: 'Number of units to develop'
            },
            targetSalePricePerUnit: {
              type: 'number',
              description: 'Target sale price per unit'
            },
            developmentType: {
              type: 'string',
              enum: ['apartments', 'townhouses', 'duplex', 'house'],
              description: 'Type of development'
            },
            constructionCostPerSqm: {
              type: 'number',
              description: 'Construction cost per sqm of GFA (default 4000)'
            },
            avgUnitSize: {
              type: 'number',
              description: 'Average unit size in sqm (default 85)'
            },
            targetMarginPercent: {
              type: 'number',
              description: 'Target profit margin percentage (default 20)'
            }
          },
          required: ['purchasePrice', 'numUnits', 'targetSalePricePerUnit']
        }
      }
    ];

    const systemPrompt = `You are Dev.i, a friendly Gold Coast planning advisor.

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

DA SEARCH RESULTS:
List ALL applications with number, type, date, status. Brief analysis after.

PROPERTY LOOKUPS:
Give them what they asked for. Key stats, development potential, notable constraints.

DO NOT offer feasibility unprompted. Only when explicitly asked.

FEASIBILITY:
Only start when user says: "run a feaso", "do feasibility", "check numbers", etc.

When requested:
1. Ask "Quick feaso (5 questions) or full detailed calculator?"
2. QUICK: Ask questions one at a time
3. DETAILED: Use start_feasibility with mode="detailed"

IMPORTANT:
- Never say "let me launch" - just DO IT
- When user says "ok"/"yes" - proceed, don't repeat
- NEVER offer feasibility unless asked

User sees property data in sidebar. Focus on insights they can't see there.`;

    // Build messages array with conversation history
    const messages = [];
    
    // Add conversation history if provided, filtering out empty content
    if (conversationHistory && conversationHistory.length > 0) {
      console.log('[CLAUDE] Adding conversation history...');
      const recentHistory = conversationHistory.slice(-10);
      
      // Filter out any messages with empty content
      for (const msg of recentHistory) {
        if (msg.content && (typeof msg.content === 'string' ? msg.content.trim() : true)) {
          // Ensure content is never empty
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
    
    // Add current user query (ensure it's not empty)
    const trimmedQuery = userQuery?.trim() || 'hello';
    messages.push({
      role: 'user',
      content: trimmedQuery
    });

    // Initial request to Claude
    console.log('[CLAUDE] Sending request to Anthropic API...');
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,  // Allow detailed responses
      system: systemPrompt,
      tools,
      messages
    });

    console.log('[CLAUDE] Initial response received');
    console.log('[CLAUDE] Response content types:', response.content.map(c => c.type));

    // Check if Claude wants to use any tool
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

        // Check if disambiguation is needed
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

        // Handle address not found
        if (propertyData.addressNotFound) {
          console.log('[CLAUDE] Address not found:', propertyData.searchedAddress);
          
          // Filter out useless suggestions (suburb-only, no street number)
          const usefulSuggestions = (propertyData.suggestions || []).filter(s => {
            const addr = s.address || '';
            // Must have a street number and be a real address
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
          
          // No useful suggestions - give helpful guidance
          return {
            answer: `I couldn't find "${propertyData.searchedAddress}" in the Gold Coast planning database.\n\nThis address may not exist or could be registered under a different name (common for corner lots). Try:\n\n- Adding the suburb: "120 Marine Parade, Coolangatta"\n- Using the lot/plan number from your rates notice\n- Checking Google Maps for the exact address format\n\nWould you like to try a different address?`,
            usedTool: 'get_property_info',
            propertyData: null
          };
        }

        console.log('[CLAUDE] Property data retrieved');

        // Search for relevant planning scheme information
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
        console.log('[CLAUDE] Searching DAs for:', toolUse.input.address);
        
        try {
          const { scrapeGoldCoastDAs } = await import('./pdonline-scraper.js');
          const daResult = await scrapeGoldCoastDAs(
            toolUse.input.address, 
            toolUse.input.months_back || 12
          );
          
          console.log(`[CLAUDE] Found ${daResult.count} DAs`);
          if (sendProgress) sendProgress(`Found ${daResult.count} applications`);
          
          toolResult = daResult;
        } catch (daError) {
          console.error('[CLAUDE] DA search failed:', daError.message);
          console.error('[CLAUDE] DA search stack:', daError.stack);
          
          // Return a graceful failure message instead of crashing
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
        console.log('[CLAUDE] Starting feasibility analysis, mode:', toolUse.input.mode || 'selection');
        if (sendProgress) sendProgress('📊 Preparing feasibility analysis...');
        
        const { getDetailedFeasibilityPreFill } = await import('./feasibility-calculator.js');
        
        // Build property data from tool input
        const propertyData = {
          property: {
            address: toolUse.input.propertyAddress,
            area: toolUse.input.siteArea ? `${toolUse.input.siteArea}sqm` : null,
            density: toolUse.input.densityCode,
            height: toolUse.input.heightLimit,
            zone: toolUse.input.zone,
          }
        };
        
        const preFillData = getDetailedFeasibilityPreFill(propertyData);
        const mode = toolUse.input.mode || 'selection';
        
        toolResult = {
          success: true,
          feasibilityMode: mode,
          propertyAddress: toolUse.input.propertyAddress,
          preFill: preFillData.preFill || {},
          constraints: preFillData.constraints || {},
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
        
        const feasResult = calculateQuickFeasibility({
          address: toolUse.input.propertyAddress,
          siteArea: toolUse.input.siteArea,
          densityCode: toolUse.input.densityCode,
          heightLimit: toolUse.input.heightLimit,
          purchasePrice: toolUse.input.purchasePrice,
          numUnits: toolUse.input.numUnits,
          targetSalePricePerUnit: toolUse.input.targetSalePricePerUnit,
          developmentType: toolUse.input.developmentType || 'apartments',
          constructionCostPerSqm: toolUse.input.constructionCostPerSqm || 4000,
          avgUnitSize: toolUse.input.avgUnitSize || 85,
          targetMarginPercent: toolUse.input.targetMarginPercent || 20,
        });
        
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

      // Extract text response
      const textContent = finalResponse.content.find(c => c.type === 'text');
      
      // Determine what type of data to return
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
      // Claude answered without needing to scrape
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
    
    // Handle specific error types gracefully
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
    
    // Handle Anthropic API errors
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
    
    // Generic fallback - don't crash, return a message
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
        content: `You are Dev.i, a friendly Gold Coast planning advisor. Answer concisely in plain text, no markdown: ${userQuery}`
      }]
    });

    const textContent = response.content.find(c => c.type === 'text');
    return textContent?.text || 'Unable to generate response';

  } catch (error) {
    console.error('[CLAUDE ERROR]', error);
    throw new Error(`Query failed: ${error.message}`);
  }
}
