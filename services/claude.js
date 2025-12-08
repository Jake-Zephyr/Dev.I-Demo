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
  
  // First, normalize existing line breaks to spaces (to work with walls of text)
  let normalized = text.replace(/\n+/g, ' ').replace(/  +/g, ' ').trim();
  
  // Split into sentences (handle common abbreviations)
  const sentenceEnders = /(?<!\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|e\.g|i\.e))\.\s+(?=[A-Z])/g;
  const sentences = normalized.split(sentenceEnders);
  
  if (sentences.length <= 3) {
    return text; // Short response, leave as-is
  }
  
  // Group into paragraphs of 2-3 sentences
  const paragraphs = [];
  let currentParagraph = [];
  
  sentences.forEach((sentence, index) => {
    // Add period back if it was removed during split
    const cleanSentence = sentence.trim();
    if (!cleanSentence) return;
    
    currentParagraph.push(cleanSentence.endsWith('.') ? cleanSentence : cleanSentence + '.');
    
    // Create paragraph break every 2-3 sentences
    if (currentParagraph.length >= 2 && (currentParagraph.length >= 3 || index === sentences.length - 1)) {
      paragraphs.push(currentParagraph.join(' '));
      currentParagraph = [];
    }
  });
  
  // Don't forget remaining sentences
  if (currentParagraph.length > 0) {
    paragraphs.push(currentParagraph.join(' '));
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

    const systemPrompt = `You are Dev.i, a friendly Gold Coast planning advisor.

RULE 1 - NO ASTERISKS:
Never use * anywhere. The asterisk key is broken.

RULE 2 - PARAGRAPH BREAKS ARE MANDATORY:
You MUST put a blank line between every 2-3 sentences. This is non-negotiable.

NEVER write a response as one big block of text. Break it up.

WRONG (never do this):
"Given this unique waterfront site with all its constraints and opportunities, I'd recommend a dual occupancy development as your best option. Here's why this makes the most sense. The dual occupancy pathway offers the sweet spot between feasibility and return. With RD3 density at 1 dwelling per 250 square metres, your 405 square metre site can theoretically support 1.6 dwellings, which rounds down to a practical maximum of 1-2 dwellings."

CORRECT (always do this):
"Given this unique waterfront site, I'd recommend a dual occupancy as your best option. It hits the sweet spot between feasibility and return.

With RD3 density at 1 dwelling per 250sqm, your 405sqm site supports a maximum of 2 dwellings. A dual occupancy fits perfectly without triggering complex multi-unit approval processes.

From a design perspective, you could create two high-quality waterfront townhouses with boat berths and premium finishes. The 50% site cover gives you about 200sqm of footprint across two storeys.

The flood overlay actually works in your favor here - elevated design with parking underneath is exactly what canal buyers expect."

RULE 3 - LENGTH:
Keep responses to 150-250 words total. Be helpful but concise. Don't over-explain.

CONTENT:
The user sees property data in a sidebar. Focus on insights and recommendations, not reciting facts. Sound like a knowledgeable friend giving advice.`;

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
        answer: formatIntoParagraphs(stripMarkdown(textContent?.text)) || 'Unable to generate response',
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
        answer: formatIntoParagraphs(stripMarkdown(textContent?.text)) || 'Unable to generate response',
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
