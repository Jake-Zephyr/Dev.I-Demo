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

// Nearby DAs service
let getNearbyDAs = async () => ({ success: false, error: 'Service not available' });
try {
  const module = await import('./services/nearbyDAsService.js');
  getNearbyDAs = module.getNearbyDAs;
  console.log('[NEARBY-DAS] ✅ Service loaded successfully');
} catch (e) {
  console.error('[NEARBY-DAS] ❌ Failed to load service:', e.message);
  console.error('[NEARBY-DAS] Stack:', e.stack);
}

const app = express();

// Middleware
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : ['*'];

app.use(cors({
  origin: function (origin, callback) {
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
app.use(emergencyShutdownMiddleware);
app.set('trust proxy', true);

// IP Blocklist
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

// Request logging
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path} - IP: ${req.ip}`);
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Usage stats
app.get('/api/usage-stats', (req, res) => {
  const stats = getUsageStats();
  res.json({
    success: true,
    stats,
    timestamp: new Date().toISOString()
  });
});

// Direct scraper endpoint
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

// Debug endpoint
app.get('/api/scrape-debug/:query', async (req, res) => {
  try {
    const { query } = req.params;
    console.log(`[SCRAPE-DEBUG] Query: ${query}`);
    
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

// Test BrowserBase
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

// Overlay checker
app.post('/api/check-overlays', apiKeyAuthMiddleware, rateLimitMiddleware, async (req, res) => {
  try {
    const { address, lga } = req.body;
    
    console.log('[OVERLAY-CHECK] Request received');
    console.log('[OVERLAY-CHECK] Address:', address);
    console.log('[OVERLAY-CHECK] LGA:', lga);
    
    if (!address || !lga) {
      return res.status(400).json({
        success: false,
        error: 'Both address and LGA are required'
      });
    }
    
    if (lga !== 'Gold Coast') {
      return res.status(400).json({
        success: false,
        error: 'Only Gold Coast is currently supported'
      });
    }
    
    console.log('[OVERLAY-CHECK] Starting scrape...');
    
    const propertyData = await scrapeProperty(address);
    
    console.log('[OVERLAY-CHECK] Scrape complete');
    console.log('[OVERLAY-CHECK] Full response:', JSON.stringify(propertyData, null, 2));
    console.log('[OVERLAY-CHECK] Success flag:', propertyData?.success);
    console.log('[OVERLAY-CHECK] Has property data:', !!propertyData?.property);
    console.log('[OVERLAY-CHECK] Overlay count:', propertyData?.property?.overlays?.length || 0);
    
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

// Stamp duty calculator
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

// Nearby DAs (PlanningAlerts)
app.post('/api/nearby-das', apiKeyAuthMiddleware, rateLimitMiddleware, async (req, res) => {
  try {
    const { address, radius, dateFrom, dateTo } = req.body;
    
    console.log('[NEARBY-DAS] Request received');
    console.log('[NEARBY-DAS] Address:', address);
    console.log('[NEARBY-DAS] Radius:', radius);
    console.log('[NEARBY-DAS] Date range:', dateFrom, 'to', dateTo);

    if (!address) {
      return res.status(400).json({ 
        success: false, 
        error: 'Address is required' 
      });
    }

    const result = await getNearbyDAs(address, radius, dateFrom, dateTo);
    
    console.log('[NEARBY-DAS] ✅ Found', result.count, 'applications');
    
    res.json(result);

  } catch (error) {
    console.error('[NEARBY-DAS ERROR]', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch development applications',
      details: error.message
    });
  }
});

// ===== NEW: PDONLINE DA SEARCH =====
app.post('/api/pdonline-das', apiKeyAuthMiddleware, rateLimitMiddleware, async (req, res) => {
  try {
    const { address, months_back } = req.body;
    
    console.log('[PDONLINE-DAS] Request received');
    console.log('[PDONLINE-DAS] Address:', address);
    console.log('[PDONLINE-DAS] Months back:', months_back || 12);

    if (!address) {
      return res.status(400).json({ 
        success: false, 
        error: 'Address is required' 
      });
    }

    const { scrapeGoldCoastDAs } = await import('./services/pdonline-scraper.js');
    const result = await scrapeGoldCoastDAs(address, months_back || 12);
    
    console.log('[PDONLINE-DAS] ✅ Found', result.count, 'applications');
    
    res.json(result);

  } catch (error) {
    console.error('[PDONLINE-DAS ERROR]', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch development applications',
      details: error.message
    });
  }
});

// Streaming advisory
app.post('/api/advise-stream', apiKeyAuthMiddleware, rateLimitMiddleware, queryValidationMiddleware, async (req, res) => {
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
    
    sendProgress('Parsing query parameters...');
    sendProgress('Connecting to Gold Coast planning database...');
    sendProgress('Scraping property information...');
    
    const response = await getAdvisory(query, conversationHistory, sendProgress);
    
    sendProgress('Finalizing report...');
    
    res.write(`data: ${JSON.stringify({ 
      type: 'complete', 
      data: response,
      timestamp: new Date().toISOString()
    })}\n\n`);
    
    res.end();
    
  } catch (error) {
    console.error('[ADVISE-STREAM ERROR]', error.message);
    
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

// Main advisory
app.post('/api/advise', apiKeyAuthMiddleware, rateLimitMiddleware, queryValidationMiddleware, async (req, res) => {
  try {
    console.log('=====================================');
    console.log('[ADVISE] NEW REQUEST');
    console.log('[ADVISE] Timestamp:', new Date().toISOString());
    console.log('[ADVISE] Query:', req.body.query);
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
    
    const response = await getAdvisory(query, conversationHistory);
    
    console.log('[ADVISE] Response generated');
    
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

// Project visualizer
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
        projectDescription
      } = req.body;
      
      console.log('[VISUALISER] Request received:', {
        developmentType,
        architecturalStyle,
        stories,
        hasCustomDescription: !!projectDescription
      });
      
      let prompt = '';
      
      if (projectDescription && projectDescription.trim()) {
        prompt = projectDescription.trim();
      } else {
        const materialsText = materials?.join(', ') || 'modern materials';
        prompt = `${developmentType || 'residential development'}, ${architecturalStyle || 'contemporary'} architecture, ${stories || 2}-storey, ${materialsText} facade`;
      }
      
      const enhancements = [];
      
      if (viewPerspective === 'Street Level') {
        enhancements.push('street-level perspective');
      } else if (viewPerspective === 'Aerial') {
        enhancements.push('aerial view at 45-degree angle');
      } else if (viewPerspective === '3/4 View') {
        enhancements.push('three-quarter architectural view');
      }
      
      if (timeOfDay === 'Day') {
        enhancements.push('bright daylight, blue sky');
      } else if (timeOfDay === 'Dusk') {
        enhancements.push('golden hour lighting, warm sunset glow');
      } else if (timeOfDay === 'Night') {
        enhancements.push('dramatic night lighting');
      }
      
      if (landscaping === 'Tropical') {
        enhancements.push('tropical landscaping, palm trees');
      } else if (landscaping === 'Lush') {
        enhancements.push('mature landscaping, established gardens');
      } else if (landscaping === 'Minimal') {
        enhancements.push('minimalist landscaping');
      }
      
      enhancements.push('Gold Coast, Queensland, Australia');
      
      const qualityTags = 'photorealistic architectural visualization, professional photography, ultra-detailed, 8K resolution, architectural digest quality, physically accurate materials and lighting';
      
      const fullPrompt = `${prompt}, ${enhancements.join(', ')}, ${qualityTags}`;
      
      console.log('[VISUALISER] Final prompt:', fullPrompt);
      
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
            output_format: "webp",
            output_quality: 95,
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
      
      let result = prediction;
      let attempts = 0;
      const maxAttempts = 60;
      
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
          prompt: fullPrompt,
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
// ===== ADDRESS AUTOCOMPLETE (Google Places) =====
app.post('/api/address-autocomplete', apiKeyAuthMiddleware, async (req, res) => {
  try {
    const { input, country } = req.body;
    
    if (!input || input.length < 3) {
      return res.json({ success: true, predictions: [] });
    }

    const response = await fetch(
      `https://maps.googleapis.com/maps/api/place/autocomplete/json?` +
      `input=${encodeURIComponent(input)}` +
      `&types=address` +
      `&components=country:${country || 'au'}` +
      `&key=${process.env.GOOGLE_MAPS_API_KEY}`
    );

    const data = await response.json();
    
    if (data.status === 'OK') {
      res.json({
        success: true,
        predictions: data.predictions.map(p => ({
          place_id: p.place_id,
          description: p.description
        }))
      });
    } else {
      console.log('[AUTOCOMPLETE] Google API status:', data.status);
      res.json({ success: true, predictions: [] });
    }

  } catch (error) {
    console.error('[AUTOCOMPLETE ERROR]', error);
    res.json({ success: true, predictions: [] });
  }
});

// ===== CHAT TITLE GENERATION =====
app.post('/api/generate-chat-title', apiKeyAuthMiddleware, rateLimitMiddleware, async (req, res) => {
  try {
    const { firstMessage, claudeResponse } = req.body;

    console.log('[CHAT-TITLE] Request received');
    console.log('[CHAT-TITLE] First message:', firstMessage);

    if (!firstMessage || typeof firstMessage !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'firstMessage is required and must be a string'
      });
    }

    const message = firstMessage.toLowerCase();

    // Pattern matching for property identifiers
    const addressMatch = firstMessage.match(/(\d+\s+[\w\s]+(?:street|st|avenue|ave|road|rd|drive|dr|parade|pde|court|ct|crescent|cres|place|pl|terrace|tce|boulevard|bvd|highway|hwy|lane|ln|way|walk))/i);
    const lotplanMatch = firstMessage.match(/\b(\d+[A-Z]{2,4}\d+)\b/i);
    const suburbMatch = firstMessage.match(/\b(mermaid|broadbeach|surfers|southport|burleigh|palm beach|robina|varsity|currumbin|coolangatta|labrador|runaway bay|hope island|coomera|ormeau|oxenford|helensvale|miami|nobby beach|main beach|clear island|ashmore|benowa|bundall|chevron island|elanora|merrimac|molendinar|mudgeeraba|nerang|paradise point|parkwood|reedy creek|tallebudgera|worongary|carrara|biggera waters|coombabah|gilston|gaven|highland park|hollywell|jacobs well|maudsland|monterey keys|pacific pines|pimpama|stapylton|upper coomera|willow vale|wongawallan|arundel|bonogin|natural bridge|advancetown|cedar creek)\b/i);

    // Intent keywords (ordered by specificity - most specific first)
    const intentPatterns = {
      'Development Applications': /development application|DA|planning approval|permit|approval|consent/i,
      'Stamp Duty': /stamp duty|tax|transfer duty|duty/i,
      'Height': /height|storeys|stories|floors|tall|how tall|building height/i,
      'Overlays': /overlay|overlays|restriction|constraint|heritage|environmental|flood/i,
      'Density': /density|RD\d|how many|units|dwellings|bedrooms/i,
      'Feasibility': /feasibility|feaso|numbers|viable|profit|cost|roi|return/i,
      'Zoning': /zone|zoning|what can i build|can i build|planning rules|land use|permitted/i,
      'Property Info': /information|info|details|data|tell me about/i
    };

    // Find matching intent
    let intent = null;
    for (const [key, pattern] of Object.entries(intentPatterns)) {
      if (pattern.test(message)) {
        intent = key;
        break;
      }
    }

    // Generate title based on priority
    let title = '';

    // Priority 1: Address + Intent
    if (addressMatch && intent) {
      const address = addressMatch[1];
      // Shorten address if too long (keep number + first word of street)
      const shortAddress = address.match(/(\d+\s+\w+)/)?.[1] || address.substring(0, 20);
      title = `${shortAddress} ${intent}`;
    }
    // Priority 2: Lot/Plan + Intent
    else if (lotplanMatch && intent) {
      title = `${lotplanMatch[1]} ${intent}`;
    }
    // Priority 3: Suburb + Intent
    else if (suburbMatch && intent) {
      const suburb = suburbMatch[1].charAt(0).toUpperCase() + suburbMatch[1].slice(1).toLowerCase();
      title = `${suburb} ${intent}`;
    }
    // Priority 4: Intent only
    else if (intent) {
      title = `${intent} Query`;
    }
    // Fallback: First 40 characters of message
    else {
      title = firstMessage.substring(0, 40);
      if (firstMessage.length > 40) {
        title += '...';
      }
      // Capitalize first letter
      title = title.charAt(0).toUpperCase() + title.slice(1);
    }

    console.log('[CHAT-TITLE] Generated title:', title);

    res.json({
      success: true,
      title: title,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('[CHAT-TITLE ERROR]', error);
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
  console.log(`   POST /api/check-overlays  ⭐`);
  console.log(`   POST /api/calculate-stamp-duty  💰`);
  console.log(`   GET  /api/stamp-duty/states  💰`);
  console.log(`   POST /api/nearby-das  📍`);
  console.log(`   POST /api/pdonline-das  🏗️`);
  console.log(`   POST /api/generate-visualization  🎨`);
  console.log(`   POST /api/generate-chat-title  💬 NEW`);
});

export default app;
