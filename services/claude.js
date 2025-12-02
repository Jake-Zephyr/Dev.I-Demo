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
              description: 'Full property address in format: "43 Peerless Avenue, MERMAID BEACH, 4218" - must include street number, street name, suburb, and postcode'
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
- Review the conversation history carefully to understand what the user is asking about
- If you previously asked the user for an address and they respond with just an address, understand what they want you to do with it
- If you asked "which address would you like me to search for DAs?" and they reply "14 peerless avenue", then USE search_development_applications
- If you asked "which property?" and they reply "12 aquila court", understand from context whether they want property info or DAs

TOOL SELECTION RULES:
- User says "DAs at [address]" or "development applications" → search_development_applications
- User says "tell me about [address]" or "what's the zoning" → get_property_info
- User just provides an address after you asked for one → use the tool relevant to what they were asking about
- If user previously talked about a property and now asks "what about DAs" → use search_development_applications with that same property address

RESPONSE GUIDELINES:
1. For greetings (hi, hello, hey, etc.): Respond briefly and warmly in 1-2 sentences. Don't over-explain what you do.

2. For property planning questions: Use get_property_info tool. The tool returns:
   - Property details (zone, density, area, overlays)
   - planningSchemeContext: Array of relevant sections from the official Gold Coast City Plan
   
   Provide comprehensive planning advice including what can be built, requirements, and next steps.

3. For DA questions: Use search_development_applications tool with the full address (must include suburb and postcode).

4. When you need information: Ask clearly what you need, then when they respond, take action based on what you asked for.

5. For general Gold Coast questions: Answer briefly, then offer to help with property matters.

6. For unrelated questions: Politely redirect to your expertise area.

Keep responses conversational and friendly. Use conversation history to maintain context and avoid repeating yourself.

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
