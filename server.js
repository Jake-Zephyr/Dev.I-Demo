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

// Main advisory endpoint (Claude + Scraper)
app.post('/api/advise', async (req, res) => {
  try {
    const { query } = req.body;
    
    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'Query is required'
      });
    }
    
    console.log(`[ADVISE] Query: ${query}`);
    
    // Get advisory from Claude (it will call scraper if needed)
    const response = await getAdvisory(query);
    
    res.json({
      success: true,
      response,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[ADVISE ERROR]', error);
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
