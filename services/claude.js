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

    // Define the tool for property lookup
    const tools = [{
      name: 'get_property_info',
      description: 'Look up current Gold Coast property planning details including zone, density, height limits, overlays, and relevant planning scheme text. IMPORTANT: This tool works best with lot/plan numbers (e.g., "295RP21863"). Address searches can be unreliable. If the user provides an address, ask them for the lot/plan number if they have it, or explain that lot/plan gives more accurate results.',
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
    }];

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

RESPONSE GUIDELINES:
1. For Gold Coast property questions (lot/plan numbers or addresses): Use the get_property_info tool to look up data. The tool returns:
   - Property details (zone, density, area, overlays)
   - planningSchemeContext: Array of relevant sections from the official Gold Coast City Plan
   
   IMPORTANT: The planningSchemeContext contains the actual planning scheme rules and requirements. Use this information to provide accurate, specific advice. Quote relevant sections when explaining requirements.
   
   Provide comprehensive planning advice including:
   - What can be built (based on the planning scheme sections)
   - Specific zoning requirements (from the scheme text)
   - Density and height limits (as stated in the scheme)
   - Overlay requirements (from the retrieved context)
   - Next steps

2. For general Gold Coast questions (mayor, council, local info, weather, etc.): Answer briefly and helpfully, then offer to help with property matters.

3. For questions completely unrelated to property or Gold Coast: Politely redirect by saying something like:
   "I'm not sure what that has to do with property development! I specialize in Gold Coast property planning and development. Is there anything about Gold Coast properties or planning I can help you with?"

Keep responses conversational and friendly, but stay focused on your expertise area. Use the conversation history to provide contextual responses.

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

    // Check if Claude wants to use the tool
    const toolUse = response.content.find(c => c.type === 'tool_use');

    if (toolUse) {
      console.log('=====================================');
      console.log(`[CLAUDE] Tool called: ${toolUse.name}`);
      console.log(`[CLAUDE] Tool input:`, JSON.stringify(toolUse.input, null, 2));
      console.log('=====================================');

      // Call the scraper
      if (sendProgress) sendProgress('📍 Accessing Gold Coast City Plan...');
      const propertyData = await scrapeProperty(toolUse.input.query, sendProgress);
      console.log('[CLAUDE] Property data retrieved');

      // Search for relevant planning scheme information
      if (sendProgress) sendProgress('🧠 Searching planning regulations database...');
      console.log('[CLAUDE] Searching planning scheme database...');
      const planningContext = await searchPlanningScheme(toolUse.input.query, propertyData);
      console.log(`[CLAUDE] Found ${planningContext.length} relevant planning sections`);
      
      if (sendProgress) sendProgress('✍️ Compiling comprehensive property report...');
      
      // Combine property data with planning context
      const enrichedData = {
        ...propertyData,
        planningSchemeContext: planningContext
      };

      // Send the tool result back to Claude
      const finalResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        tools,
        messages: [
          {
            role: 'user',
            content: `You are a Gold Coast planning advisor. Help the user with their planning query.

User query: ${userQuery}`
          },
          {
            role: 'assistant',
            content: response.content
          },
          {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: JSON.stringify(enrichedData, null, 2)
            }]
          }
        ]
      });

      console.log('[CLAUDE] Final advisory generated');

      // Extract text response
      const textContent = finalResponse.content.find(c => c.type === 'text');
      
      return {
        answer: textContent?.text || 'Unable to generate response',
        propertyData,
        usedTool: true,
        toolQuery: toolUse.input.query
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
