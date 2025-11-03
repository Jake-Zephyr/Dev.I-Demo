// server.js
import express from 'express';
import cors from 'cors';
import { scrapeProperty } from './services/browserbase.js';
import { getAdvisory } from './services/claude.js';

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Direct scraper endpoint (for testing)
app.get('/api/scrape/:query', async (req, res) => {
  try {
    const { query } = req.params;
    console.log(`[SCRAPE] Query: ${query}`);
    
    const data = await scrapeProperty(query);
    
    res.json({
      success: true,
      data,
      scrapedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[SCRAPE ERROR]', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Debug endpoint - returns raw scraped text
app.get('/api/scrape-debug/:query', async (req, res) => {
  try {
    const { query } = req.params;
    console.log(`[SCRAPE-DEBUG] Query: ${query}`);
    
    // Import the test version that returns raw text
    const { scrapePropertyDebug } = await import('./services/browserbase.js');
    const data = await scrapePropertyDebug(query);
    
    res.json({
      success: true,
      debug: data
    });
  } catch (error) {
    console.error('[SCRAPE-DEBUG ERROR]', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Test BrowserBase connection (debugging endpoint)
app.get('/api/test-browserbase', async (req, res) => {
  try {
    console.log('[TEST] Testing BrowserBase connection...');
    
    const sessionResponse = await fetch('https://www.browserbase.com/v1/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BB-API-Key': process.env.BROWSERBASE_API_KEY
      },
      body: JSON.stringify({
        projectId: process.env.BROWSERBASE_PROJECT_ID,
        proxies: true
      })
    });

    const result = await sessionResponse.json();
    
    res.json({
      success: sessionResponse.ok,
      status: sessionResponse.status,
      result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// STREAMING advisory endpoint (with real-time progress updates)
app.post('/api/advise-stream', async (req, res) => {
  // Set headers for Server-Sent Events
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const sendProgress = (message) => {
    res.write(`data: ${JSON.stringify({ type: 'progress', message })}\n\n`);
  };
  
  try {
    const { query, conversationHistory } = req.body;
    
    if (!query) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Query is required' })}\n\n`);
      res.end();
      return;
    }
    
    console.log('[ADVISE-STREAM] Query:', query);
    
    sendProgress('Parsing query parameters...');
    
    sendProgress('Connecting to Gold Coast planning database...');
    
    sendProgress('Scraping property information...');
    
    // Get advisory response (this calls scraper and RAG internally)
    const response = await getAdvisory(query, conversationHistory, sendProgress);
    
    sendProgress('Finalizing report...');
    
    // Send final result
    res.write(`data: ${JSON.stringify({ 
      type: 'complete', 
      data: response,
      timestamp: new Date().toISOString()
    })}\n\n`);
    
    res.end();
    
  } catch (error) {
    console.error('[ADVISE-STREAM ERROR]', error);
    res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
    res.end();
  }
});

// Main advisory endpoint (Claude + Scraper)
app.post('/api/advise', async (req, res) => {
  try {
    console.log('=====================================');
    console.log('[ADVISE] NEW REQUEST');
    console.log('[ADVISE] Timestamp:', new Date().toISOString());
    console.log('[ADVISE] Headers:', JSON.stringify(req.headers, null, 2));
    console.log('[ADVISE] Body received:', JSON.stringify(req.body, null, 2));
    console.log('[ADVISE] Body type:', typeof req.body);
    console.log('[ADVISE] Query field:', req.body.query);
    console.log('[ADVISE] History length:', req.body.conversationHistory?.length || 0);
    console.log('=====================================');
    
    const { query, conversationHistory } = req.body;
    
    if (!query) {
      console.log('[ADVISE] ERROR: No query provided');
      return res.status(400).json({
        success: false,
        error: 'Query is required'
      });
    }
    
    console.log(`[ADVISE] Processing query: "${query}"`);
    
    // Get advisory from Claude with conversation history
    const response = await getAdvisory(query, conversationHistory);
    
    console.log('[ADVISE] Response generated');
    console.log('[ADVISE] Response structure:', JSON.stringify({
      hasAnswer: !!response.answer,
      answerLength: response.answer?.length,
      hasPropertyData: !!response.propertyData,
      usedTool: response.usedTool
    }, null, 2));
    
    const result = {
      success: true,
      response,
      timestamp: new Date().toISOString()
    };
    
    console.log('[ADVISE] Sending response to client');
    console.log('=====================================');
    
    res.json(result);
  } catch (error) {
    console.error('[ADVISE ERROR]', error);
    console.error('[ADVISE ERROR] Stack:', error.stack);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Start server
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`🚀 Gold Coast Planning Advisor API`);
  console.log(`📍 Server running on port ${PORT}`);
  console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`\n📚 Endpoints:`);
  console.log(`   GET  /health`);
  console.log(`   GET  /api/scrape/:query`);
  console.log(`   POST /api/advise`);
});

export default app;
