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
    console.log('[CLAUDE] Processing query...');

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
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      tools,
      messages: [{
        role: 'user',
        content: `You are a Gold Coast planning advisor. Help the user with their planning query.

IMPORTANT: When you receive property data from the get_property_info tool, provide a comprehensive advisory that includes:
1. A clear summary of what can be built
2. Key zoning requirements
3. Density and height limits
4. Any overlays or special requirements
5. Next steps for the user

User query: ${userQuery}`
      }]
    });

    console.log('[CLAUDE] Initial response received');

    // Check if Claude wants to use the tool
    const toolUse = response.content.find(c => c.type === 'tool_use');

    if (toolUse) {
      console.log(`[CLAUDE] Tool called: ${toolUse.name}`);
      console.log(`[CLAUDE] Tool input:`, toolUse.input);

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
