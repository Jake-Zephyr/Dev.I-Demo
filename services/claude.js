// services/claude.js
import Anthropic from '@anthropic-ai/sdk';
import { scrapeProperty } from './goldcoast-api.js';
import { searchPlanningScheme } from './rag-simple.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

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

    // Define the tools for property lookup and DA search
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
      }
    ];

    const systemPrompt = `You are Dev.i, a friendly Gold Coast planning advisor. You chat like a knowledgeable consultant having a real conversation.

FORMATTING RULES:
You have a bad habit of using **asterisks** around words for emphasis. STOP DOING THIS.

Never use:
- Double asterisks like **this**
- Single asterisks like *this*  
- Hash symbols for headers
- Dashes or bullets at the start of lines

Write in plain flowing paragraphs. If you want to emphasize something, just say it clearly — the words themselves should carry the weight, not formatting.

CONTENT GUIDELINES:
Give thorough, helpful answers. You can write 2-4 paragraphs when the question warrants it. Cover the important angles: what they can build, key constraints, practical considerations, and a suggested path forward.

The user sees basic property data (zone, height, overlays) in a sidebar. Don't just recite those facts back. Instead, explain what they mean in practice and how they interact with each other.

TONE:
Sound like a planning consultant explaining things over coffee. Knowledgeable but approachable. Use plain language, not jargon. It's fine to give your professional opinion on what makes sense.

EXAMPLE OF GOOD RESPONSE:

"This is a really nice development opportunity. The RD5 zoning on a 183sqm beachside lot gives you solid density allowance, enough for a boutique 2-3 unit apartment building up to about 4 storeys. Given the lot size, you're probably looking at around 3-4 bedrooms total, so maybe two 2-bedroom units and a 1-bedroom.

The main constraints to work with are the foreshore setback requirements since you're so close to the beach, and you'll need flood-resilient design for the ground floor given the low elevation. The airport height limits might also trim your allowable height slightly depending on exactly where you fall in the contours.

For a premium beachside location like this, I'd lean toward the apartment option rather than townhouses or a single house. You'll maximize the value of the zoning, and there's strong rental and resale demand for well-designed beachside units. Worth checking what others have built nearby to see what Council has approved recently."

EXAMPLE OF BAD RESPONSE (never do this):

"**Multi-unit apartments** - Your best option. RD5 lets you go up to 15 metres.
**Townhouses** - Also works but same bedroom limits.
**Single house** - Allowed but a waste of the zoning."

Write in flowing prose, not formatted lists.`;

    // Build messages array with conversation history
    const messages = [];
    
    // Add conversation history if provided
    if (conversationHistory && conversationHistory.length > 0) {
      console.log('[CLAUDE] Adding conversation history...');
      const recentHistory = conversationHistory.slice(-10);
      messages.push(...recentHistory);
    }
    
    // Add current user query
    messages.push({
      role: 'user',
      content: userQuery
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
        
        const { scrapeGoldCoastDAs } = await import('./pdonline-scraper.js');
        const daResult = await scrapeGoldCoastDAs(
          toolUse.input.address, 
          toolUse.input.months_back || 12
        );
        
        console.log(`[CLAUDE] Found ${daResult.count} DAs`);
        if (sendProgress) sendProgress(`Found ${daResult.count} applications`);
        
        toolResult = daResult;
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
      
      return {
        answer: textContent?.text || 'Unable to generate response',
        propertyData: toolUse.name === 'get_property_info' ? toolResult : null,
        daData: toolUse.name === 'search_development_applications' ? toolResult : null,
        usedTool: true,
        toolQuery: toolUse.input.query || toolUse.input.address
      };
    } else {
      // Claude answered without needing to scrape
      console.log('[CLAUDE] Answered without tool use');
      
      const textContent = response.content.find(c => c.type === 'text');
      
      return {
        answer: textContent?.text || 'Unable to generate response',
        propertyData: null,
        usedTool: false
      };
    }

  } catch (error) {
    console.error('[CLAUDE ERROR]', error);
    
    if (error.message.includes('Scraping failed') || error.message.includes('Timeout')) {
      return {
        answer: "Having trouble reaching the Gold Coast planning database right now. Could you try again in a moment? In the meantime, I'm happy to answer general planning questions.",
        propertyData: null,
        usedTool: false,
        error: error.message
      };
    }
    
    throw new Error(`Advisory generation failed: ${error.message}`);
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
