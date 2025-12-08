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

RULE 3 - DA SEARCH RESULTS:
When you receive DA search results, ALWAYS list ALL applications found in a clear format like this:

"I found [X] development applications for this address:

1. [Application Number] - [Type] - Lodged [Date] - Status: [Status if known]
   [Brief description if available]

2. [Application Number] - [Type] - Lodged [Date] - Status: [Status if known]
   [Brief description if available]"

Then provide your analysis of what these DAs tell us about the site. Never summarize or skip any DAs - list them all, then discuss.

If the user asks for more details on a specific DA, provide everything you know about that one.

RULE 4 - LENGTH:
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
