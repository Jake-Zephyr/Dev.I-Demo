// services/claude.js
import Anthropic from '@anthropic-ai/sdk';
import { scrapeProperty } from './browserbase.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

/**
 * Get planning advisory from Claude with function calling
 * Claude will automatically call the scraper when needed
 */
export async function getAdvisory(userQuery) {
  try {
    console.log('=====================================');
    console.log('[CLAUDE] New advisory request');
    console.log('[CLAUDE] User query:', userQuery);
    console.log('[CLAUDE] Query type:', typeof userQuery);
    console.log('[CLAUDE] Query length:', userQuery?.length);
    console.log('=====================================');

    // Define the tool for property lookup
    const tools = [{
      name: 'get_property_info',
      description: 'Look up current Gold Coast property planning details including zone, density, height limits, overlays, and relevant planning scheme text. Use this when the user asks about a specific property, lot/plan number, or address.',
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Lot/plan number (e.g., "12RP39932") or street address (e.g., "22 Mary Avenue, Broadbeach")'
          }
        },
        required: ['query']
      }
    }];

    // Initial request to Claude
    console.log('[CLAUDE] Sending request to Anthropic API...');
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      tools,
      messages: [{
        role: 'user',
        content: `You are Dev.I, an AI assistant specializing in Gold Coast property development and planning.

CORE EXPERTISE:
- Gold Coast property planning, zoning, and development
- Building regulations and overlay restrictions
- Development applications and approvals
- Property investment advice for Gold Coast

RESPONSE GUIDELINES:
1. For Gold Coast property questions (lot/plan numbers or addresses): Use the get_property_info tool to look up data and provide comprehensive planning advice including:
   - What can be built
   - Zoning requirements
   - Density and height limits
   - Overlays and special requirements
   - Next steps

2. For general Gold Coast questions (mayor, council, local info, weather, etc.): Answer briefly and helpfully, then offer to help with property matters.

3. For questions completely unrelated to property or Gold Coast: Politely redirect by saying something like:
   "I'm not sure what that has to do with property development! I specialize in Gold Coast property planning and development. Is there anything about Gold Coast properties or planning I can help you with?"

Keep responses conversational and friendly, but stay focused on your expertise area.

User query: ${userQuery}`
      }]
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
      const propertyData = await scrapeProperty(toolUse.input.query);
      console.log('[CLAUDE] Property data retrieved');

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
              content: JSON.stringify(propertyData, null, 2)
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
