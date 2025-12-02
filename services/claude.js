// services/claude.js
import Anthropic from '@anthropic-ai/sdk';
import { scrapeProperty } from './goldcoast-api.js';
import { searchPlanningScheme } from './rag-simple.js';
import { geocodeAddress } from './goldcoast-api.js';

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
    console.log('[CLAUDE] Query type:', typeof userQuery);
    console.log('[CLAUDE] Query length:', userQuery?.length);
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

    // Build messages array with conversation history
    const messages = [];
    
    // Add conversation history if provided
    if (conversationHistory && conversationHistory.length > 0) {
      console.log('[CLAUDE] Adding conversation history...');
      // Take last 10 messages to avoid token limits
      const recentHistory = conversationHistory.slice(-10);
      messages.push(...recentHistory);
    }
    
    // Add current user query
    messages.push({
      role: 'user',
      content: `You are Dev.I, an AI assistant specializing in Gold Coast property development and planning.

CORE EXPERTISE:
- Gold Coast property planning, zoning, and development
- Building regulations and overlay restrictions
- Development applications and approvals
- Property investment advice for Gold Coast

AVAILABLE TOOLS:
1. get_property_info: Look up zoning, overlays, planning scheme rules (for "what can I build", "what's the zoning", "tell me about this property")
2. search_development_applications: Find DAs at an address (for "what DAs", "any development applications", "building approvals")

CRITICAL CONTEXT AWARENESS:
- Use conversation history to understand context, but NEVER explicitly mention you're looking at history
- If you previously asked for an address and user provides one, immediately use the appropriate tool
- If you asked "which address for DAs?" and they reply "14 peerless avenue" → immediately use search_development_applications
- If user previously discussed a property and asks "what about DAs" → use search_development_applications with that address
- NEVER say "I can see from our conversation" or "based on our chat history" - just act on the context naturally

TOOL SELECTION RULES:
- User asks about DAs/development applications → search_development_applications
- User asks about zoning/planning/what can be built → get_property_info
- User provides address after you asked for one → use the tool they were asking about
- For search_development_applications: You can accept partial addresses like "22 Mary Avenue" - the geocoder will find the full address

RESPONSE GUIDELINES:
1. For greetings: Respond briefly and warmly in 1-2 sentences.

2. For property planning questions: Use get_property_info tool.

3. For DA questions: Use search_development_applications tool. Accept partial addresses - the system will geocode them.

4. When you need information: Ask clearly, then ACT when they respond. Don't acknowledge you're using context.

5. Keep responses conversational and friendly. Use context silently to maintain flow.

User query: ${userQuery}`
    });

    // Initial request to Claude
    console.log('[CLAUDE] Sending request to Anthropic API...');
    console.log('[CLAUDE] Messages count:', messages.length);
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
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
            answer: `I found multiple properties matching "${propertyData.originalQuery}". Please specify which one:\n\n${suggestionsList}\n\nWhich property would you like information about?`,
            usedTool: 'get_property_info',
            propertyData: null
          };
        }

        console.log('[CLAUDE] Property data retrieved');

        // Search for relevant planning scheme information
        if (sendProgress) sendProgress('🧠 Searching planning regulations database...');
        console.log('[CLAUDE] Searching planning scheme database...');
        const planningContext = await searchPlanningScheme(toolUse.input.query, propertyData);
        console.log(`[CLAUDE] Found ${planningContext.length} relevant planning sections`);
        
        if (sendProgress) sendProgress('✍️ Compiling comprehensive property report...');
        
        // Combine property data with planning context
        toolResult = {
          ...propertyData,
          planningSchemeContext: planningContext
        };
      }
        
        console.log('[CLAUDE] Geocoded to:', geocoded.formatted_address);
        if (sendProgress) sendProgress('🔍 Searching development applications...');
        
        const { scrapeGoldCoastDAs } = await import('./pdonline-scraper.js');
        const daResult = await scrapeGoldCoastDAs(
          geocoded.formatted_address, 
          toolUse.input.months_back || 12
        );
        
        console.log(`[CLAUDE] Found ${daResult.count} DAs`);
        if (sendProgress) sendProgress(`✅ Found ${daResult.count} development applications`);
        
        toolResult = daResult;
      }

      // Send the tool result back to Claude
      const finalResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
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
    
    // If it's a scraping error, give a user-friendly message
    if (error.message.includes('Scraping failed') || error.message.includes('Timeout')) {
      return {
        answer: "I'm having trouble accessing the Gold Coast City Plan website right now. This could be due to:\n\n" +
                "1. The website is experiencing high traffic\n" +
                "2. The property reference might not exist\n" +
                "3. There's a temporary connectivity issue\n\n" +
                "Could you try:\n" +
                "- Double-checking the lot/plan number format (e.g., 295RP21863)\n" +
                "- Providing the street address instead\n" +
                "- Trying again in a moment\n\n" +
                "I'm still here to answer general Gold Coast planning questions in the meantime!",
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
 * Useful for general planning questions that don't need property lookup
 */
export async function simpleQuery(userQuery) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `You are a Gold Coast planning advisor. Answer this question: ${userQuery}`
      }]
    });

    const textContent = response.content.find(c => c.type === 'text');
    return textContent?.text || 'Unable to generate response';

  } catch (error) {
    console.error('[CLAUDE ERROR]', error);
    throw new Error(`Query failed: ${error.message}`);
  }
}
