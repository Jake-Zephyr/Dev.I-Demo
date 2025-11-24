// server.js
import express from 'express';
import cors from 'cors';
import { scrapeProperty } from './services/goldcoast-api.js';
import { getAdvisory } from './services/claude.js';
import { 
  rateLimitMiddleware, 
  queryValidationMiddleware,
  emergencyShutdownMiddleware,
  getUsageStats 
} from './middleware/protection.js';
import { apiKeyAuthMiddleware } from './middleware/auth.js';
import { calculateStampDuty } from './services/stamp-duty-calculator.js';

const app = express();

// Middleware
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : ['*']; // Default: allow all (set ALLOWED_ORIGINS in Railway!)

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log(`[CORS] Blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json({ limit: '2mb' }));

// Emergency shutdown check (first line of defense)
app.use(emergencyShutdownMiddleware);

// Trust proxy (for correct IP detection behind Railway)
app.set('trust proxy', true);

// IP Blocklist middleware
const blockedIPs = new Set(
  (process.env.BLOCKED_IPS || '').split(',').filter(ip => ip.trim())
);

app.use((req, res, next) => {
  if (blockedIPs.has(req.ip)) {
    console.log(`[BLOCKED] Request from banned IP: ${req.ip}`);
    return res.status(403).json({
      error: 'Access denied',
      message: 'Your IP has been blocked'
    });
  }
  next();
});

// Request logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path} - IP: ${req.ip}`);
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Usage stats endpoint (for monitoring your costs)
app.get('/api/usage-stats', (req, res) => {
  const stats = getUsageStats();
  res.json({
    success: true,
    stats,
    timestamp: new Date().toISOString()
  });
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
    const { scrapePropertyDebug } = await import('./services/goldcoast-api.js');
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

// ===== NEW: DEDICATED OVERLAY CHECKER ENDPOINT =====
// Simplified endpoint specifically for overlay checking
app.post('/api/check-overlays', apiKeyAuthMiddleware, rateLimitMiddleware, async (req, res) => {
  try {
    const { address, lga } = req.body;
    
    console.log('[OVERLAY-CHECK] Request received');
    console.log('[OVERLAY-CHECK] Address:', address);
    console.log('[OVERLAY-CHECK] LGA:', lga);
    
    // Validate input
    if (!address || !lga) {
      return res.status(400).json({
        success: false,
        error: 'Both address and LGA are required'
      });
    }
    
    // Only support Gold Coast for now
    if (lga !== 'Gold Coast') {
      return res.status(400).json({
        success: false,
        error: 'Only Gold Coast is currently supported'
      });
    }
    
    console.log('[OVERLAY-CHECK] Starting scrape...');
    
    // Scrape property data
    const propertyData = await scrapeProperty(address);
    
    console.log('[OVERLAY-CHECK] Scrape complete');
    console.log('[OVERLAY-CHECK] Full response:', JSON.stringify(propertyData, null, 2));
    console.log('[OVERLAY-CHECK] Success flag:', propertyData?.success);
    console.log('[OVERLAY-CHECK] Has property data:', !!propertyData?.property);
    console.log('[OVERLAY-CHECK] Overlay count:', propertyData?.property?.overlays?.length || 0);
    
    // MORE FORGIVING: Accept if we have property data with overlays, even if success isn't explicitly true
    if (propertyData?.property?.overlays && propertyData.property.overlays.length > 0) {
      console.log('[OVERLAY-CHECK] ✅ Found overlays:', propertyData.property.overlays.length);
      
      return res.json({
        success: true,
        property: {
          address: propertyData.property.address || address,
          lotplan: propertyData.property.lotplan || 'N/A',
          overlays: propertyData.property.overlays,
          overlayCount: propertyData.property.overlays.length
        },
        timestamp: new Date().toISOString()
      });
    }
    
    // If we got SOME data (zone, address, etc) but no overlays
    if (propertyData?.property) {
      console.log('[OVERLAY-CHECK] ⚠️ Property found but no overlays');
      
      return res.json({
        success: true,
        property: {
          address: propertyData.property.address || address,
          lotplan: propertyData.property.lotplan || 'N/A',
          overlays: [],
          overlayCount: 0
        },
        timestamp: new Date().toISOString()
      });
    }
    
    // Complete failure - no property data at all
    console.log('[OVERLAY-CHECK] ❌ Property not found');
    return res.status(404).json({
      success: false,
      error: 'Property not found. Please check the address and try again.'
    });
    
  } catch (error) {
    console.error('[OVERLAY-CHECK ERROR]', error);
    res.status(500).json({
      success: false,
      error: 'Unable to fetch overlays. Please try again.'
    });
  }
});
// ===== STAMP DUTY CALCULATOR ENDPOINTS =====
app.post('/api/calculate-stamp-duty', apiKeyAuthMiddleware, rateLimitMiddleware, async (req, res) => {
  try {
    const { propertyValue, state, useType, isFirstHomeBuyer, isNewHome, isVacantLand, isForeign, ownershipStructure, contractDate } = req.body;

    if (!propertyValue || propertyValue <= 0) {
      return res.status(400).json({ success: false, error: 'Property value must be a positive number' });
    }

    if (!state) {
      return res.status(400).json({ success: false, error: 'State is required' });
    }

    const validStates = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];
    if (!validStates.includes(state)) {
      return res.status(400).json({ success: false, error: `Invalid state. Must be one of: ${validStates.join(', ')}` });
    }

    const input = {
      propertyValue: Number(propertyValue),
      state,
      useType: useType || 'owner_occupied',
      isFirstHomeBuyer: Boolean(isFirstHomeBuyer),
      isNewHome: Boolean(isNewHome),
      isVacantLand: Boolean(isVacantLand),
      isForeign: Boolean(isForeign),
      ownershipStructure,
      contractDate: contractDate || new Date().toISOString().split('T')[0],
    };

    const result = calculateStampDuty(input);
    console.log('[STAMP DUTY]', input.state, input.propertyValue, '→', result.stampDuty);
    
    return res.json(result);
  } catch (error) {
    console.error('[STAMP DUTY ERROR]', error);
    return res.status(500).json({ success: false, error: 'Internal server error', message: error.message });
  }
});

app.get('/api/stamp-duty/states', (req, res) => {
  res.json({
    success: true,
    states: [
      { code: 'NSW', name: 'New South Wales', fhbAvailable: true },
      { code: 'VIC', name: 'Victoria', fhbAvailable: true },
      { code: 'QLD', name: 'Queensland', fhbAvailable: true },
      { code: 'WA', name: 'Western Australia', fhbAvailable: true },
      { code: 'SA', name: 'South Australia', fhbAvailable: true },
      { code: 'TAS', name: 'Tasmania', fhbAvailable: true },
      { code: 'ACT', name: 'Australian Capital Territory', fhbAvailable: true },
      { code: 'NT', name: 'Northern Territory', fhbAvailable: false },
    ],
  });
});
// STREAMING advisory endpoint (with real-time progress updates)
app.post('/api/advise-stream', apiKeyAuthMiddleware, rateLimitMiddleware, queryValidationMiddleware, async (req, res) => {
  // Set headers for Server-Sent Events
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const sendProgress = (message) => {
    res.write(`data: ${JSON.stringify({ type: 'progress', message })}\n\n`);
  };
  
  try {
    const { query, conversationHistory, requestType } = req.body;
    
    if (!query) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Query is required' })}\n\n`);
      res.end();
      return;
    }
    
    console.log('[ADVISE-STREAM] Query:', query);
    console.log('[ADVISE-STREAM] Request type:', requestType || 'standard');
    
    // OVERLAY-ONLY MODE: Just scrape overlays, skip Claude/RAG
    if (requestType === 'overlays-only') {
      console.log('[ADVISE-STREAM] Overlay-only mode activated');
      
      sendProgress('📍 Searching Gold Coast City Plan...');
      
      try {
        const propertyData = await scrapeProperty(query, sendProgress);
        
        if (!propertyData?.success) {
          res.write(`data: ${JSON.stringify({ 
            type: 'error', 
            message: 'Property not found. Please check the address and try again.' 
          })}\n\n`);
          res.end();
          return;
        }
        
        sendProgress('✅ Overlays retrieved successfully');
        
        // Return overlays data
        res.write(`data: ${JSON.stringify({ 
          type: 'complete',
          propertyData: {
            property: {
              address: propertyData.property?.address || query,
              lotplan: propertyData.property?.lotplan || 'N/A',
              overlays: propertyData.property?.overlays || [],
              overlayCount: propertyData.property?.overlays?.length || 0
            }
          }
        })}\n\n`);
        
        res.end();
        return;
        
      } catch (error) {
        console.error('[ADVISE-STREAM] Overlay scraping failed:', error.message);
        res.write(`data: ${JSON.stringify({ 
          type: 'error', 
          message: 'Unable to fetch overlays. Please try again.' 
        })}\n\n`);
        res.end();
        return;
      }
    }
    
    // STANDARD MODE: Full advisory with Claude + RAG
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
    console.error('[ADVISE-STREAM ERROR]', error.message);
    
    // Check if it's an Anthropic overload error
    const isOverloaded = error.message?.includes('529') || 
                         error.message?.includes('overloaded') ||
                         error.message?.includes('Overloaded');
    
    if (isOverloaded) {
      res.write(`data: ${JSON.stringify({ 
        type: 'error', 
        message: "Dev.i's server is overloaded. Please ask your question again." 
      })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ 
        type: 'error', 
        message: error.message 
      })}\n\n`);
    }
    
    res.end();
  }
});

// Main advisory endpoint (Claude + Scraper)
app.post('/api/advise', apiKeyAuthMiddleware, rateLimitMiddleware, queryValidationMiddleware, async (req, res) => {
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
    
    // Check if it's an Anthropic overload error
    const isOverloaded = error.message?.includes('529') || 
                         error.message?.includes('overloaded') ||
                         error.message?.includes('Overloaded');
    
    res.status(isOverloaded ? 503 : 500).json({
      success: false,
      error: isOverloaded 
        ? "Dev.i's server is overloaded. Please ask your question again." 
        : error.message
    });
  }
});
// ===== PROJECT VISUALISER ENDPOINT (FIXED) =====
app.post('/api/generate-visualization', 
  apiKeyAuthMiddleware, 
  rateLimitMiddleware, 
  async (req, res) => {
    try {
      const { 
        developmentType,
        architecturalStyle,
        stories,
        materials,
        viewPerspective,
        timeOfDay,
        landscaping,
        projectDescription  // ← This is the user's actual description
      } = req.body;
      
      console.log('[VISUALISER] Request received:', {
        developmentType,
        architecturalStyle,
        stories,
        hasCustomDescription: !!projectDescription
      });
      
      // Build prompt - USER DESCRIPTION FIRST
      let prompt = '';
      
      // Start with user's description if provided
      if (projectDescription && projectDescription.trim()) {
        prompt = projectDescription.trim();
      } else {
        // Fallback to structured description
        const materialsText = materials?.join(', ') || 'modern materials';
        prompt = `${developmentType || 'residential development'}, ${architecturalStyle || 'contemporary'} architecture, ${stories || 2}-storey, ${materialsText} facade`;
      }
      
      // Add technical parameters to enhance (not override) the description
      const enhancements = [];
      
      // View perspective
      if (viewPerspective === 'Street Level') {
        enhancements.push('street-level perspective');
      } else if (viewPerspective === 'Aerial') {
        enhancements.push('aerial view at 45-degree angle');
      } else if (viewPerspective === '3/4 View') {
        enhancements.push('three-quarter architectural view');
      }
      
      // Lighting
      if (timeOfDay === 'Day') {
        enhancements.push('bright daylight, blue sky');
      } else if (timeOfDay === 'Dusk') {
        enhancements.push('golden hour lighting, warm sunset glow');
      } else if (timeOfDay === 'Night') {
        enhancements.push('dramatic night lighting');
      }
      
      // Landscaping context
      if (landscaping === 'Tropical') {
        enhancements.push('tropical landscaping, palm trees');
      } else if (landscaping === 'Lush') {
        enhancements.push('mature landscaping, established gardens');
      } else if (landscaping === 'Minimal') {
        enhancements.push('minimalist landscaping');
      }
      
      // Add location context
      enhancements.push('Gold Coast, Queensland, Australia');
      
      // Quality directives - make it HYPER-REALISTIC
      const qualityTags = 'photorealistic architectural visualization, professional photography, ultra-detailed, 8K resolution, architectural digest quality, physically accurate materials and lighting';
      
      // Combine everything
      const fullPrompt = `${prompt}, ${enhancements.join(', ')}, ${qualityTags}`;
      
      console.log('[VISUALISER] Final prompt:', fullPrompt);
      
      // Call Replicate API with Flux Schnell
      console.log('[VISUALISER] Calling Replicate API...');
      const response = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: {
          'Authorization': `Token ${process.env.REPLICATE_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          version: 'black-forest-labs/flux-schnell',
          input: {
            prompt: fullPrompt,
            num_outputs: 1,
            aspect_ratio: "16:9",
            output_format: "webp",  // ← Changed to WebP for better quality
            output_quality: 95,     // ← Cranked up to 95
            disable_safety_checker: false
          }
        })
      });
      
      if (!response.ok) {
        const error = await response.text();
        console.error('[VISUALISER] Replicate error:', error);
        throw new Error(`Replicate API error: ${response.status}`);
      }
      
      const prediction = await response.json();
      console.log('[VISUALISER] Prediction created:', prediction.id);
      
      // Poll for completion
      let result = prediction;
      let attempts = 0;
      const maxAttempts = 60; // 60 seconds max
      
      while (
        (result.status === 'starting' || result.status === 'processing') && 
        attempts < maxAttempts
      ) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const statusResponse = await fetch(
          `https://api.replicate.com/v1/predictions/${result.id}`,
          {
            headers: {
              'Authorization': `Token ${process.env.REPLICATE_API_TOKEN}`
            }
          }
        );
        
        result = await statusResponse.json();
        attempts++;
        console.log(`[VISUALISER] Status: ${result.status} (attempt ${attempts})`);
      }
      
      if (result.status === 'succeeded') {
        console.log('[VISUALISER] ✅ Image generated successfully');
        res.json({
          success: true,
          imageUrl: result.output[0],
          prompt: fullPrompt,  // Return actual prompt used
          timestamp: new Date().toISOString()
        });
      } else {
        console.error('[VISUALISER] ❌ Generation failed:', result.status);
        throw new Error(`Image generation failed: ${result.status}`);
      }
      
    } catch (error) {
      console.error('[VISUALISER ERROR]', error);
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
  console.log(`   POST /api/advise-stream`);
  console.log(`   POST /api/check-overlays  ⭐ NEW`);
});

export default app;
