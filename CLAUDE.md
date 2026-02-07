# CLAUDE.md - AI Assistant Guide for Gold Coast Planning Advisor API

> **Last Updated:** 2026-01-15
> **Project:** Gold Coast Planning Advisor API
> **Version:** 1.0.0
> **Purpose:** This document provides comprehensive guidance for AI assistants (like Claude) working on this codebase.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Architecture & Design Patterns](#architecture--design-patterns)
3. [Directory Structure](#directory-structure)
4. [Core Services](#core-services)
5. [API Endpoints](#api-endpoints)
6. [Development Workflow](#development-workflow)
7. [Environment Configuration](#environment-configuration)
8. [Data Models](#data-models)
9. [Common Tasks & Patterns](#common-tasks--patterns)
10. [Testing & Debugging](#testing--debugging)
11. [Git Conventions](#git-conventions)
12. [Important Considerations](#important-considerations)

---

## Project Overview

### What This Project Does

This is a Node.js Express API that provides AI-powered planning advice for Gold Coast properties. It combines:
- **Real-time data scraping** from official Queensland government sources
- **AI advisory** using Claude Sonnet 4.5 with function calling
- **Browser automation** via BrowserBase for council systems (PDOnline)
- **Financial modeling** for development feasibility analysis
- **Multi-layer security** with rate limiting and budget controls

### Tech Stack

- **Runtime:** Node.js 18+ (ES Modules)
- **Framework:** Express.js 4.21+
- **AI:** Anthropic Claude (via @anthropic-ai/sdk ^0.32.1)
- **Browser Automation:** Playwright Core + BrowserBase
- **Database:** Pinecone (vector DB for RAG - optional)
- **External APIs:** Google Maps, QLD Spatial-GIS, PlanningAlerts, Replicate

### Key Features

1. **Property Data Scraping** - Lot/plan numbers or addresses → zoning, density, height, overlays
2. **AI Advisory** - Conversational interface with context preservation across turns
3. **Development Applications** - Search nearby DAs via PlanningAlerts or scrape PDOnline
4. **Stamp Duty Calculator** - All Australian states with FHB exemptions
5. **Feasibility Analysis** - Project financial modeling with revenue/cost/profit calculations
6. **Architectural Visualization** - Generate renders via Replicate API

---

## Architecture & Design Patterns

### High-Level Architecture

```
User Request
    ↓
[Express Middleware Stack]
├─ CORS
├─ Body Parser
├─ Protection (rate limit, budget, validation)
└─ Auth (optional API key)
    ↓
[Route Handler] (server.js)
    ↓
[Service Layer]
├─ claude.js         → AI orchestration + function calling
├─ goldcoast-api.js  → Property data scraping (ArcGIS)
├─ pdonline-scraper.js → DA scraping (BrowserBase)
├─ nearbyDAsService.js → DA search (PlanningAlerts)
├─ stamp-duty-calculator.js → Financial calculations
├─ feasibility-calculator.js → Development analysis
└─ rag-simple.js     → Planning scheme search (Pinecone)
    ↓
[External Services]
├─ Anthropic API (Claude)
├─ BrowserBase (browser automation)
├─ Gold Coast ArcGIS REST APIs
├─ Google Maps API (geocoding)
├─ QLD Spatial-GIS (geocoding)
└─ PlanningAlerts API
```

### Key Design Patterns

#### 1. Intent Classification Pattern
**Location:** `claude.js:classifyIntent()`

Before processing any query, classify user intent to optimize response:
- **conversational** → Fast path, no tools (greetings, casual chat)
- **property** → Needs property data lookup
- **development** → Needs DA search
- **analysis** → Needs feasibility analysis
- **context_needed** → Missing required information

```javascript
// Example flow
if (intent === 'conversational') {
    // Skip tool setup, use minimal Claude call
    return await fastConversationalResponse(query);
} else {
    // Full Claude with function calling
    return await claudeWithTools(query, conversationHistory);
}
```

#### 2. Conversation Context Preservation
**Location:** `claude.js:extractConversationContext()`

Parse previous messages to extract property details and avoid re-scraping:

```javascript
const context = extractConversationContext(conversationHistory);
// Returns: { hasProperty, propertyData, recentTopic, ... }
```

**Why:** Enables multi-turn conversations where users can ask follow-up questions without re-specifying property details.

#### 3. Function Calling Orchestration
**Location:** `claude.js:getAdvisory()`

Claude uses tool use (function calling) to autonomously:
1. Decide when to scrape property data
2. Search for development applications
3. Run feasibility calculations
4. Request clarification from user

**Available Tools:**
- `get_property_info` - Scrape property data (with disambiguation)
- `search_development_applications` - Find nearby DAs
- `start_feasibility` - Collect feasibility inputs step-by-step
- `calculate_quick_feasibility` - Run full financial analysis
- `ask_clarification` - Request user clarification

#### 4. Multi-Source Geocoding Strategy
**Location:** `goldcoast-api.js:geocodeAddress()`

Implements fallback chain for address resolution:
1. **QLD Spatial-GIS** (official government, most accurate)
2. **Nominatim (OpenStreetMap)** (fallback for non-QLD addresses)
3. **Error handling** with informative messages

#### 5. Strata Title Intelligence
**Location:** `goldcoast-api.js:getCadastreWithGeometry()`

Automatically detects strata schemes (BUP/GTP) and:
- Uses parent lot (lot 0) for zoning/overlay analysis
- Preserves unit-specific data (unit number, strata info)
- Returns `isStrata`, `isParentLot`, `numberOfUnits` flags

**Why:** Strata lots inherit planning rules from parent site, not individual unit boundaries.

#### 6. Disambiguation Flow
**Location:** `goldcoast-api.js:scrapeProperty()`, `claude.js:get_property_info tool`

When multiple properties exist at one address:
1. Return all options with lot/plan numbers
2. Claude uses `ask_clarification` tool to present choices
3. User selects specific property
4. Claude re-calls `get_property_info` with lot/plan

---

## Directory Structure

```
/home/user/Dev.I-Demo/
├── server.js                    # Main Express app (722 lines)
│   ├── Express setup
│   ├── Middleware stack (CORS, protection, auth)
│   ├── All API route handlers
│   └── Error handling
│
├── package.json                 # Dependencies & scripts
├── README.md                    # User-facing documentation
├── CLAUDE.md                    # This file (AI assistant guide)
│
├── middleware/
│   ├── auth.js                 # Optional API key authentication
│   │   └── Checks X-API-Key header or apiKey query param
│   │
│   └── protection.js           # Multi-layer security
│       ├── Rate limiting (15/min, 200/hour per IP)
│       ├── Budget controls ($25/hour, $100/day default)
│       ├── Query validation (max length, injection blocking)
│       ├── IP blocklist
│       └── Emergency shutdown flag
│
└── services/
    ├── goldcoast-api.js        # Property scraping (967 lines)
    │   ├── scrapeProperty(query) - Main entry point
    │   ├── geocodeAddress() - Multi-source geocoding
    │   ├── getCadastreByLotPlan() - Direct lot lookup
    │   ├── searchCadastreByAddress() - Address-based search
    │   ├── getCadastreWithGeometry() - Geometry + strata handling
    │   ├── getZone() - Zoning data from ArcGIS
    │   ├── getHeight() - Height restrictions
    │   └── getOverlays() - Planning overlays (131 verified layers)
    │
    ├── claude.js               # AI orchestration (1230 lines)
    │   ├── getAdvisory() - Main advisory entry point
    │   ├── classifyIntent() - Intent classification
    │   ├── extractConversationContext() - Parse conversation history
    │   ├── handleConversationalMessage() - Fast path for casual chat
    │   └── Tool definitions (function calling schemas)
    │
    ├── stamp-duty-calculator.js # Stamp duty for all AU states (156 lines)
    │   ├── calculateStampDuty(state, price, isFHB, isForeign)
    │   └── State-specific rate tables + exemptions
    │
    ├── nearbyDAsService.js     # PlanningAlerts API integration (118 lines)
    │   └── searchDAs(address, radius, dateRange)
    │
    ├── pdonline-scraper.js     # BrowserBase DA scraping (247 lines)
    │   └── scrapeGoldCoastDAs(address) - PDOnline web scraping
    │
    ├── rag-simple.js           # Pinecone planning scheme search (133 lines)
    │   └── searchPlanningScheme(query) - Metadata-based search
    │
    ├── feasibility-calculator.js # Development feasibility (100+ lines)
    │   └── calculateFeasibility(inputs) - Revenue/cost/profit analysis
    │
    └── visualiserService.ts    # Replicate AI image generation interface
        └── generateVisualization(prompt) - Architectural renders
```

---

## Core Services

### 1. goldcoast-api.js - Property Data Scraping

**Purpose:** Scrapes property planning data from official Gold Coast ArcGIS REST API

**Main Function:** `scrapeProperty(query)`
- **Input:** Address string or lot/plan number (e.g., "22 Mary Ave Broadbeach" or "12RP39932")
- **Output:** Property object with zoning, density, height, overlays, area, etc.
- **Process:**
  1. Detect if input is lot/plan or address
  2. If address → geocode using QLD Spatial-GIS
  3. Query cadastre (lot boundaries)
  4. Get geometry for lot
  5. Query zoning, height, overlays using ArcGIS Identify service
  6. Extract density code from zone description (RD1-8 pattern)
  7. Handle strata lots (detect parent lot 0)
  8. Validate address match for disambiguation

**Data Sources:**
```javascript
// All URLs are Gold Coast City Council ArcGIS services
const CADASTRE_URL = 'https://gisservices.goldcoast.qld.gov.au/arcgis/rest/services/Public/Isoplan_Cadastre/MapServer/0';
const ZONE_URL = 'https://gisservices.goldcoast.qld.gov.au/arcgis/rest/services/Public/CityPlan_V12_Zone/MapServer/identify';
const HEIGHT_URL = 'https://gisservices.goldcoast.qld.gov.au/arcgis/rest/services/Public/CityPlan_V12_Buildingheight/MapServer/identify';
const OVERLAYS_URL = 'https://gisservices.goldcoast.qld.gov.au/arcgis/rest/services/Public/V8_Overlays/MapServer/identify';
```

**Key Functions:**

- `geocodeAddress(address)` - Multi-stage geocoding with fallback
- `getCadastreByLotPlan(lotplan)` - Direct lot/plan lookup
- `searchCadastreByAddress(address)` - Address-based cadastre search
- `getCadastreWithGeometry(lat, lon, unitNumber, originalAddress)` - Get lot geometry with strata handling
- `getZone(lotGeometry)` - Extract zoning data
- `getHeight(lotGeometry)` - Extract height restrictions
- `getOverlays(lotGeometry)` - Extract planning overlays (whitelisted layers only)

**Important Patterns:**

1. **Strata Detection:**
   ```javascript
   // Lot 0 indicates parent lot in BUP/GTP scheme
   const isParentLot = lotNumber === '0';
   const isStrata = /[BG]UP|GTP/i.test(lotplan);
   ```

2. **Density Code Extraction:**
   ```javascript
   // Extract RD1-8 from zone description
   const densityMatch = zoneDescription.match(/\b(RD[1-8])\b/);
   ```

3. **Address Validation:**
   ```javascript
   // For disambiguation - check if cadastre address matches search
   const addressMatches = normalizeAddress(cadastreAddress).includes(
       normalizeAddress(searchedAddress)
   );
   ```

4. **Overlay Filtering:**
   ```javascript
   // Only use whitelisted layers (131 verified layers)
   const OVERLAY_LAYER_IDS = [7, 8, 9, 10, 11, 12, ...];
   ```

**Return Structure:**
```javascript
{
  success: true,
  property: {
    lotplan: "295RP21863",
    address: "22 Mary Avenue, Broadbeach QLD 4218",
    searchedAddress: "22 mary ave broadbeach",
    zone: "High Density Residential",
    zoneCode: "HDR",
    density: "RD5",           // 1 bedroom per 50sqm
    height: "12m",            // or null if no limit
    area: "2500sqm",
    overlays: ["Broadbeach LAP", "HX Height Overlay"],
    isStrata: false,
    isParentLot: false,
    numberOfUnits: null,
    unitNumber: null
  },
  planningContext: {
    zoneDescription: "The High Density Residential zone provides for...",
    lapRequirements: "The Broadbeach LAP requires...",
    overlayRestrictions: null
  },
  scrapedAt: "2026-01-15T10:30:00.000Z",
  timeTaken: 2.3
}
```

---

### 2. claude.js - AI Orchestration

**Purpose:** AI-powered advisory engine with Claude function calling and conversation management

**Main Function:** `getAdvisory(userQuery, conversationHistory, sendProgress)`
- **Input:** User query string, conversation history array, optional progress callback
- **Output:** AI response with property data and tool usage metadata
- **Process:**
  1. Extract context from conversation history
  2. Classify user intent
  3. Handle conversational messages with fast path
  4. Build tool definitions for Claude function calling
  5. Stream Claude response with tool use
  6. Execute tools (scrape property, search DAs, calculate feasibility)
  7. Send tool results back to Claude for final response
  8. Format and return answer

**Intent Classification:**
```javascript
const intents = {
    'conversational': ['hi', 'hello', 'thanks', 'how are you'],
    'property': ['zone', 'build', 'density', 'height', 'lot'],
    'development': ['da', 'development application', 'nearby'],
    'analysis': ['feasibility', 'profit', 'cost', 'stamp duty'],
    'context_needed': [] // When missing required information
};
```

**Function Calling Tools:**

1. **get_property_info**
   - Scrapes property data using `goldcoast-api.js`
   - Handles disambiguation with multiple properties
   - Automatically injects suburb from conversation context

2. **search_development_applications**
   - Calls `scrapeGoldCoastDAs()` for PDOnline search
   - Context-aware suburb injection from previous property lookups

3. **start_feasibility**
   - Initiates feasibility collection flow
   - Guides user through: project type → units → GRV → construction → finance

4. **calculate_quick_feasibility**
   - Runs full financial analysis
   - Includes: revenue, costs, profit, margin, residual land value

5. **ask_clarification**
   - Requests user clarification for ambiguous queries
   - Used for property disambiguation

**System Prompt Key Points:**

- Educates Claude on Gold Coast density codes (RD1-8)
- Explains impact assessable vs code assessable
- Multi-property disambiguation protocol
- Feasibility flow collection steps
- Conversation context preservation rules
- Response formatting guidelines (professional structure for property analysis)

**Important Patterns:**

1. **Fast Path for Casual Messages:**
   ```javascript
   // Skip tool setup for conversational messages
   if (intent === 'conversational') {
       return await handleConversationalMessage(query, context);
   }
   ```

2. **Context Extraction:**
   ```javascript
   // Parse conversation history to avoid re-scraping
   const context = extractConversationContext(conversationHistory);
   // Returns: { hasProperty, propertyData, recentTopic, suburb, ... }
   ```

3. **Progress Streaming:**
   ```javascript
   // Send progress updates during long operations
   sendProgress?.({ type: 'thinking', content: 'Looking up property data...' });
   ```

4. **Tool Result Injection:**
   ```javascript
   // After tool execution, inject results back to Claude
   messages.push({
       role: 'user',
       content: [{ type: 'tool_result', tool_use_id, content: JSON.stringify(result) }]
   });
   ```

---

### 3. stamp-duty-calculator.js - Stamp Duty Calculations

**Purpose:** Calculate stamp duty for all Australian states with first home buyer exemptions

**Main Function:** `calculateStampDuty(state, purchasePrice, isFirstHomeBuyer, isForeign)`

**Supported States:** NSW, VIC, QLD, WA, SA, TAS, ACT, NT

**Queensland Example:**
```javascript
// Rate table
const QLD_RATES = [
    { threshold: 5000, rate: 0, base: 0 },
    { threshold: 75000, rate: 0.015, base: 0 },
    { threshold: 540000, rate: 0.035, base: 1050 },
    { threshold: 1000000, rate: 0.045, base: 17325 },
    { threshold: Infinity, rate: 0.0575, base: 38025 }
];

// First Home Buyer concession
const QLD_FHB = {
    exemptionThreshold: 500000,  // Full exemption under $500k
    concessionStart: 500000,     // Concession $500k-$550k
    concessionEnd: 550000
};

// Home concession (all buyers)
const homeConcession = 8750; // First $350k of home
```

**Return Structure:**
```javascript
{
    duty: 45000,
    fhbSavings: 8750,
    foreignSurcharge: 35000,  // 7-8% depending on state
    totalDuty: 71250,
    state: "QLD"
}
```

---

### 4. pdonline-scraper.js - DA Web Scraping

**Purpose:** Scrape PDOnline (Gold Coast council DA system) using BrowserBase browser automation

**Main Function:** `scrapeGoldCoastDAs(address)`

**Process:**
1. Connect to BrowserBase CDP endpoint
2. Navigate to PDOnline homepage
3. Accept terms & conditions
4. Select "All applications" search type
5. Parse address into components (number, street name, type, suburb)
6. Fill search form
7. Extract results from HTML table
8. Click into each DA for description & status
9. Return structured data

**Important Considerations:**

- **Timeout-prone:** 30s per step, can fail on slow connections
- **Requires credentials:** `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID`
- **Address parsing:** Splits address into number/name/type/suburb
- **Stale elements:** Navigates fresh to each DA detail page to avoid stale element errors

**Return Structure:**
```javascript
{
    success: true,
    count: 5,
    applications: [
        {
            application_number: "DA/2024/12345",
            lodgement_date: "12/03/2024",
            location: "22 Mary Avenue, Broadbeach",
            application_type: "Residential Development",
            suburb: "BROADBEACH",
            status: "Decided",
            application_description: "Construction of 12 storey apartment building..."
        }
    ]
}
```

---

### 5. nearbyDAsService.js - PlanningAlerts Integration

**Purpose:** Search for development applications near an address using PlanningAlerts API

**Main Function:** `searchDAs(address, radiusMetres, dateRange)`

**Process:**
1. Geocode address using Google Maps API
2. Query PlanningAlerts API by lat/lng/radius
3. Calculate distance from search point
4. Filter by date range if provided
5. Sort by proximity

**Return Structure:**
```javascript
{
    success: true,
    count: 3,
    applications: [
        {
            application_number: "DA/2024/12345",
            lodgement_date: "2024-03-12",
            location: "22 Mary Avenue, Broadbeach",
            application_type: "Residential",
            description: "12 storey apartment building",
            distance: 150  // metres from search point
        }
    ]
}
```

---

### 6. feasibility-calculator.js - Development Feasibility

**Purpose:** Calculate development project financial feasibility

**Main Function:** `calculateFeasibility(inputs)`

**Inputs:**
```javascript
{
    projectType: "apartment",
    units: 12,
    GRV: 8400000,              // Gross Realisation Value
    constructionCost: 4200000,
    landValue: 2500000,
    LVR: 65,                   // Loan to Value Ratio
    interestRate: 7.5,
    timeline: 24               // months
}
```

**Output:**
```javascript
{
    inputs: { ... },
    revenue: {
        grvInclGST: 8400000,
        grvExclGST: 7636363,
        pricePerUnit: 700000
    },
    costs: {
        land: 2500000,
        stampDuty: 125000,
        construction: 4200000,
        contingency: 420000,    // 10% of construction
        professional: 756363,   // 10% of GRV excl GST
        selling: 305454,        // 4% of GRV excl GST
        finance: 393750,        // Interest on drawn amount
        total: 8700567
    },
    profitability: {
        grossProfit: -936204,
        margin: -12.3,
        targetMargin: 20,
        viable: false
    },
    residual: {
        landValue: 1427796      // Land value for 20% target margin
    },
    assumptions: {
        contingency: "10%",
        professionalFees: "10%",
        sellingCosts: "4%",
        financeDrawdown: "50%",
        stampDutyQLD: "5% on land over $1M"
    }
}
```

---

### 7. rag-simple.js - Planning Scheme Search

**Purpose:** Search Pinecone vector database for planning scheme information

**Main Function:** `searchPlanningScheme(query)`

**Approach:**
- Uses metadata-based filtering (not true embeddings)
- Searches for: zone name, density code, overlay keywords
- Returns top 5 unique planning sections
- Gracefully fails (returns empty array on error)

**Note:** This is optional functionality and can be skipped if Pinecone is not configured.

---

## API Endpoints

### Health & Status

```http
GET /health
Response: { status: "ok", timestamp: "2026-01-15T10:30:00.000Z" }
```

```http
GET /api/usage-stats
Response: { ip: "192.168.1.1", requests: { minute: 5, hour: 50, day: 200 }, budget: { hour: 1.50, day: 15.00 } }
```

### Property Data

```http
GET /api/scrape/:query
Example: GET /api/scrape/12RP39932
Example: GET /api/scrape/22%20Mary%20Avenue%20Broadbeach
Response: { success, property, planningContext, scrapedAt, timeTaken }
```

```http
GET /api/scrape-debug/:query
Response: Same as /api/scrape but with additional debug information
```

```http
POST /api/check-overlays
Body: { address: "22 Mary Ave Broadbeach" }
Response: { success, overlays: [], coordinates }
Requires: Authentication
```

### Advisory & Analysis

```http
POST /api/advise
Body: { query: "What can I build on 12RP39932?", conversationHistory: [] }
Response: { success, response: { answer, propertyData, usedTool }, timestamp }
Requires: Authentication
```

```http
POST /api/advise-stream
Body: { query: "...", conversationHistory: [] }
Response: Server-sent events (SSE) stream with progress updates
Content-Type: text/event-stream
Requires: Authentication
```

### Development Applications

```http
POST /api/nearby-das
Body: { address: "22 Mary Ave Broadbeach", radius: 500, dateRange: "last6months" }
Response: { success, count, applications: [] }
Requires: Authentication
```

```http
POST /api/pdonline-das
Body: { address: "22 Mary Ave Broadbeach" }
Response: { success, count, applications: [] }
Requires: Authentication
```

### Financial Tools

```http
POST /api/calculate-stamp-duty
Body: { state: "QLD", purchasePrice: 500000, isFirstHomeBuyer: true, isForeign: false }
Response: { duty, fhbSavings, foreignSurcharge, totalDuty, state }
Requires: Authentication
```

```http
GET /api/stamp-duty/states
Response: ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"]
```

### Visualization

```http
POST /api/generate-visualization
Body: { prompt: "Modern 12 storey apartment building with glass facade" }
Response: { success, imageUrl }
Requires: Authentication
```

### Address Lookup

```http
POST /api/address-autocomplete
Body: { input: "22 mary ave" }
Response: { predictions: [{ description, placeId }] }
Requires: Authentication
```

### BrowserBase Testing

```http
GET /api/test-browserbase
Response: { success, message, debugUrl }
```

---

## Development Workflow

### Setting Up Development Environment

1. **Clone repository:**
   ```bash
   git clone <repository-url>
   cd Dev.I-Demo
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment:**
   ```bash
   # Create .env file with required variables
   ANTHROPIC_API_KEY=sk-ant-api03-xxxxx
   BROWSERBASE_API_KEY=bb_xxxxx
   BROWSERBASE_PROJECT_ID=xxxxx
   PORT=8787
   NODE_ENV=development

   # Optional variables
   PINECONE_API_KEY=xxxxx
   GOOGLE_MAPS_API_KEY=xxxxx
   PLANNING_ALERTS_API_KEY=xxxxx
   REPLICATE_API_TOKEN=xxxxx
   ```

4. **Run development server:**
   ```bash
   npm run dev  # Auto-restarts on file changes
   ```

5. **Test endpoints:**
   ```bash
   curl http://localhost:8787/health
   curl http://localhost:8787/api/scrape/12RP39932
   ```

### Making Changes

#### Before Making Changes

1. **Read relevant files first** - NEVER propose changes without reading the code
2. **Understand existing patterns** - Follow established conventions
3. **Check conversation context** - Look for property data or context from previous messages

#### Code Style & Conventions

1. **ES Modules** - Use `import`/`export`, not `require()`
2. **Async/Await** - Prefer async/await over promises
3. **Error Handling** - Always use try/catch blocks
4. **Logging** - Use console.log with service prefixes: `[GOLDCOAST-API]`, `[CLAUDE]`, etc.
5. **Comments** - Only add comments where logic isn't self-evident
6. **Avoid Over-Engineering:**
   - Don't add features beyond what's requested
   - Don't create helpers for one-time operations
   - Don't add error handling for impossible scenarios
   - Three similar lines are better than premature abstraction

#### Security Considerations

When making changes, be careful to avoid:
- **Command injection** - Never pass user input directly to shell commands
- **SQL injection** - Not applicable (no SQL database), but validate all API queries
- **XSS** - Already handled by middleware validation
- **Path traversal** - Validate file paths if adding file operations
- **Credential exposure** - Never commit API keys or secrets

#### Testing Changes

1. **Test locally** - Run development server and test manually
2. **Test with real data** - Use actual Gold Coast addresses/lot numbers
3. **Test error cases** - Invalid addresses, missing data, API failures
4. **Test authentication** - If endpoint requires auth, test with/without API key
5. **Check rate limits** - Test with `GET /api/usage-stats`

Example test flow:
```bash
# Test property scraping
curl http://localhost:8787/api/scrape/12RP39932
curl http://localhost:8787/api/scrape/22%20Mary%20Avenue%20Broadbeach

# Test advisory (requires API key if enabled)
curl -X POST http://localhost:8787/api/advise \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-key-here" \
  -d '{"query": "What can I build on 12RP39932?"}'

# Test stamp duty
curl -X POST http://localhost:8787/api/calculate-stamp-duty \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-key-here" \
  -d '{"state": "QLD", "purchasePrice": 500000, "isFirstHomeBuyer": true, "isForeign": false}'
```

---

## Environment Configuration

### Required Variables

```env
# Anthropic (Claude AI)
ANTHROPIC_API_KEY=sk-ant-api03-xxxxx

# BrowserBase (browser automation)
BROWSERBASE_API_KEY=bb_xxxxx
BROWSERBASE_PROJECT_ID=xxxxx
```

### Optional Variables

```env
# Server Configuration
PORT=8787                       # Default: 8787
NODE_ENV=development            # development | production

# Security
API_KEYS=key1,key2,key3        # Comma-separated API keys (enables auth if set)
ALLOWED_ORIGINS=*              # CORS origins (comma-separated or *)
BLOCKED_IPS=192.168.1.100      # Comma-separated IP addresses to block

# Rate Limiting & Budget
HOURLY_BUDGET_LIMIT=25         # USD per hour (default: $25)
DAILY_BUDGET_LIMIT=100         # USD per day (default: $100)
EMERGENCY_SHUTDOWN=false       # Set to true to disable all requests (503 response)

# External Services
PINECONE_API_KEY=xxxxx         # Pinecone vector database (optional)
GOOGLE_MAPS_API_KEY=xxxxx      # Google Maps geocoding (optional, uses QLD Spatial-GIS fallback)
PLANNING_ALERTS_API_KEY=xxxxx  # PlanningAlerts.org.au (optional)
REPLICATE_API_TOKEN=xxxxx      # Replicate AI image generation (optional)
```

### Where to Get API Keys

- **ANTHROPIC_API_KEY:** https://console.anthropic.com/settings/keys
- **BROWSERBASE_API_KEY:** BrowserBase Dashboard → Settings → API Keys
- **BROWSERBASE_PROJECT_ID:** BrowserBase Dashboard → Projects → Click your project
- **GOOGLE_MAPS_API_KEY:** Google Cloud Console → APIs & Services → Credentials
- **PINECONE_API_KEY:** Pinecone Console → API Keys
- **PLANNING_ALERTS_API_KEY:** Contact PlanningAlerts.org.au
- **REPLICATE_API_TOKEN:** Replicate.com → Account → API Tokens

---

## Data Models

### Property Data Object

```typescript
interface PropertyData {
    lotplan: string;              // "295RP21863"
    address: string;              // "22 Mary Avenue, Broadbeach QLD 4218"
    searchedAddress: string;      // Original search query
    zone: string;                 // "High Density Residential"
    zoneCode: string;             // "HDR"
    density: string | null;       // "RD5" (1 bedroom per 50sqm)
    height: string | null;        // "12m" or null if no limit
    area: string;                 // "2500sqm"
    overlays: string[];           // ["Broadbeach LAP", "HX Height Overlay"]
    isStrata: boolean;            // BUP/GTP scheme?
    isParentLot: boolean;         // Lot 0 in strata scheme?
    numberOfUnits: number | null; // Number of units in complex
    unitNumber: number | null;    // Which unit (if queried by unit)
}
```

### Gold Coast Density Codes

```javascript
const DENSITY_CODES = {
    'RD1': { bedroomsPerSqm: 250, description: 'Very Low Density' },
    'RD2': { bedroomsPerSqm: 125, description: 'Low Density' },
    'RD3': { bedroomsPerSqm: 80,  description: 'Medium-Low Density' },
    'RD4': { bedroomsPerSqm: 60,  description: 'Medium Density' },
    'RD5': { bedroomsPerSqm: 50,  description: 'Medium-High Density' },
    'RD6': { bedroomsPerSqm: 45,  description: 'High Density' },
    'RD7': { bedroomsPerSqm: 40,  description: 'Very High Density' },
    'RD8': { bedroomsPerSqm: 35,  description: 'Ultra High Density' }
};
```

### Development Application Object

```typescript
interface DevelopmentApplication {
    application_number: string;   // "DA/2024/12345"
    lodgement_date: string;       // "12/03/2024" or "2024-03-12"
    location: string;             // "22 Mary Avenue, Broadbeach"
    application_type: string;     // "Residential Development"
    suburb: string;               // "BROADBEACH"
    status: string;               // "Decided" | "In Progress" | etc
    application_description: string; // Full description
    distance?: number;            // Metres from search point (PlanningAlerts only)
}
```

### Feasibility Result Object

```typescript
interface FeasibilityResult {
    inputs: {
        projectType: string;
        units: number;
        GRV: number;              // Gross Realisation Value
        constructionCost: number;
        landValue: number;
        LVR: number;              // Loan to Value Ratio
        interestRate: number;
        timeline: number;         // months
    };
    revenue: {
        grvInclGST: number;
        grvExclGST: number;
        pricePerUnit: number;
    };
    costs: {
        land: number;
        stampDuty: number;
        construction: number;
        contingency: number;
        professional: number;
        selling: number;
        finance: number;
        total: number;
    };
    profitability: {
        grossProfit: number;
        margin: number;           // percentage
        targetMargin: number;     // percentage
        viable: boolean;
    };
    residual: {
        landValue: number;        // Land value for target margin
    };
    assumptions: {
        contingency: string;
        professionalFees: string;
        sellingCosts: string;
        financeDrawdown: string;
        stampDutyQLD: string;
    };
}
```

### Conversation History Format

```typescript
interface ConversationMessage {
    role: 'user' | 'assistant';
    content: string;              // User message or assistant response
    timestamp?: string;
}

// When calling claude.js:getAdvisory()
const conversationHistory: ConversationMessage[] = [
    { role: 'user', content: 'What can I build on 12RP39932?' },
    { role: 'assistant', content: 'Let me look up that property...' },
    { role: 'user', content: 'What about nearby DAs?' }
];
```

---

## Common Tasks & Patterns

### Task 1: Adding a New API Endpoint

**Steps:**

1. **Define route in server.js:**
   ```javascript
   app.post('/api/my-new-endpoint', protection, optionalAuth, async (req, res) => {
       try {
           const { param1, param2 } = req.body;

           // Validate inputs
           if (!param1) {
               return res.status(400).json({
                   success: false,
                   error: 'param1 is required'
               });
           }

           // Call service function
           const result = await myService.doSomething(param1, param2);

           // Return response
           res.json({ success: true, data: result });
       } catch (error) {
           console.error('[MY-ENDPOINT] Error:', error);
           res.status(500).json({
               success: false,
               error: error.message
           });
       }
   });
   ```

2. **Create service function if needed:**
   ```javascript
   // services/my-service.js
   export async function doSomething(param1, param2) {
       // Implementation
       return result;
   }
   ```

3. **Test endpoint:**
   ```bash
   curl -X POST http://localhost:8787/api/my-new-endpoint \
     -H "Content-Type: application/json" \
     -H "X-API-Key: your-key" \
     -d '{"param1": "value1", "param2": "value2"}'
   ```

### Task 2: Adding a New Claude Tool (Function Calling)

**Steps:**

1. **Define tool schema in claude.js:**
   ```javascript
   const tools = [
       // ... existing tools
       {
           name: "my_new_tool",
           description: "Description of what this tool does",
           input_schema: {
               type: "object",
               properties: {
                   param1: {
                       type: "string",
                       description: "Description of param1"
                   },
                   param2: {
                       type: "number",
                       description: "Description of param2"
                   }
               },
               required: ["param1"]
           }
       }
   ];
   ```

2. **Handle tool execution in claude.js:**
   ```javascript
   // In getAdvisory() function, add case to tool execution switch
   if (toolName === 'my_new_tool') {
       const { param1, param2 } = toolInput;
       sendProgress?.({
           type: 'thinking',
           content: 'Executing my new tool...'
       });

       const result = await myService.doSomething(param1, param2);

       toolResults.push({
           type: 'tool_result',
           tool_use_id: block.id,
           content: JSON.stringify(result)
       });
   }
   ```

3. **Update system prompt** to explain when Claude should use this tool

4. **Test in conversation:**
   ```bash
   curl -X POST http://localhost:8787/api/advise \
     -H "Content-Type: application/json" \
     -H "X-API-Key: your-key" \
     -d '{"query": "Trigger condition for my new tool"}'
   ```

### Task 3: Modifying Property Scraping Logic

**Location:** `services/goldcoast-api.js`

**Common modifications:**

1. **Add new data extraction:**
   ```javascript
   // In scrapeProperty() function
   const newData = await getNewData(lotGeometry);
   property.newField = newData;
   ```

2. **Add new ArcGIS layer:**
   ```javascript
   // Add to OVERLAY_LAYER_IDS if it's an overlay
   const OVERLAY_LAYER_IDS = [7, 8, 9, ..., NEW_LAYER_ID];

   // Or create new function for different MapServer
   async function getNewLayerData(lotGeometry) {
       const NEW_LAYER_URL = 'https://gisservices.goldcoast.qld.gov.au/...';
       // Implementation
   }
   ```

3. **Improve address matching:**
   ```javascript
   // In getCadastreWithGeometry() or scrapeProperty()
   function betterAddressMatch(address1, address2) {
       // Enhanced matching logic
   }
   ```

### Task 4: Improving Intent Classification

**Location:** `services/claude.js:classifyIntent()`

**Steps:**

1. **Add new intent type:**
   ```javascript
   const INTENT_KEYWORDS = {
       conversational: [...],
       property: [...],
       development: [...],
       analysis: [...],
       my_new_intent: ['keyword1', 'keyword2', 'keyword3']
   };
   ```

2. **Handle new intent in getAdvisory():**
   ```javascript
   if (intent === 'my_new_intent') {
       // Special handling for this intent
       return await handleMyNewIntent(userQuery, context);
   }
   ```

3. **Update system prompt** to guide Claude's behavior for this intent

### Task 5: Adding State to Stamp Duty Calculator

**Location:** `services/stamp-duty-calculator.js`

**Steps:**

1. **Add rate table:**
   ```javascript
   const NEW_STATE_RATES = [
       { threshold: 100000, rate: 0.01, base: 0 },
       { threshold: 500000, rate: 0.03, base: 1000 },
       { threshold: Infinity, rate: 0.05, base: 13000 }
   ];
   ```

2. **Add first home buyer rules:**
   ```javascript
   const NEW_STATE_FHB = {
       exemptionThreshold: 600000,
       concessionStart: 600000,
       concessionEnd: 800000
   };
   ```

3. **Add to calculation switch:**
   ```javascript
   case 'NEW_STATE':
       return calculateForState(
           price,
           NEW_STATE_RATES,
           NEW_STATE_FHB,
           isFHB,
           isForeign,
           0.08  // foreign surcharge rate
       );
   ```

4. **Update exports:**
   ```javascript
   export const AVAILABLE_STATES = [
       'NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT', 'NEW_STATE'
   ];
   ```

### Task 6: Handling New Conversation Context

**Location:** `services/claude.js:extractConversationContext()`

**Pattern:**

```javascript
// Extract new context type from conversation history
let newContextField = null;
for (const msg of conversationHistory) {
    if (msg.role === 'assistant') {
        const match = msg.content.match(/pattern to extract/);
        if (match) {
            newContextField = match[1];
        }
    }
}

return {
    hasProperty,
    propertyData,
    suburb,
    newContextField,  // Add to returned context
    recentTopic
};
```

### Task 7: Adding Middleware Protection

**Location:** `middleware/protection.js`

**Examples:**

1. **Add IP to blocklist:**
   ```javascript
   // In .env file
   BLOCKED_IPS=192.168.1.100,10.0.0.50
   ```

2. **Adjust rate limits:**
   ```javascript
   // In protection.js
   const LIMITS = {
       requestsPerMinute: 20,      // Increase from 15
       requestsPerHour: 300,        // Increase from 200
       requestsPerDay: 2000
   };
   ```

3. **Add custom validation:**
   ```javascript
   // In protection middleware
   if (req.body.query) {
       const query = req.body.query.toLowerCase();

       // Add custom block pattern
       if (query.includes('malicious-pattern')) {
           return res.status(400).json({
               error: 'Invalid query pattern'
           });
       }
   }
   ```

---

## Testing & Debugging

### Debug Endpoints

1. **Scraper Debug:**
   ```bash
   curl http://localhost:8787/api/scrape-debug/12RP39932
   # Returns full scraper output with timing information
   ```

2. **BrowserBase Test:**
   ```bash
   curl http://localhost:8787/api/test-browserbase
   # Tests BrowserBase connectivity and returns debug URL
   ```

3. **Usage Stats:**
   ```bash
   curl http://localhost:8787/api/usage-stats
   # Shows rate limiting state for your IP
   ```

### Logging Patterns

All services use prefixed console.log statements:

```javascript
console.log('[GOLDCOAST-API] Scraping property:', query);
console.log('[CLAUDE] Intent classified as:', intent);
console.log('[STAMP-DUTY] Calculating for state:', state);
console.error('[PDONLINE] Error connecting to BrowserBase:', error.message);
```

**Best Practice:** Always use service prefix for easy log filtering

### Common Issues & Solutions

#### 1. "Session failed to create" (BrowserBase)

**Cause:** Invalid BrowserBase credentials or project ID

**Solution:**
```bash
# Verify credentials in .env
echo $BROWSERBASE_API_KEY
echo $BROWSERBASE_PROJECT_ID

# Test connection
curl http://localhost:8787/api/test-browserbase
```

#### 2. "Anthropic API error"

**Cause:** Invalid API key or insufficient credits

**Solution:**
```bash
# Verify API key
echo $ANTHROPIC_API_KEY

# Check Anthropic console for credit balance
# https://console.anthropic.com/settings/billing
```

#### 3. "Address not found"

**Cause:** Geocoding failure or invalid address

**Debug:**
```javascript
// In goldcoast-api.js:geocodeAddress()
console.log('[GOLDCOAST-API] Geocoding result:', geocoded);
console.log('[GOLDCOAST-API] Coordinates:', lat, lon);
```

**Solution:**
- Try with lot/plan number instead of address
- Check address spelling and format
- Verify address is within Gold Coast region

#### 4. "Multiple properties found"

**Cause:** Disambiguation needed

**Expected behavior:**
- Claude receives multiple options
- Uses `ask_clarification` tool to present choices
- User selects specific property
- Claude re-queries with lot/plan

**Not an error** - this is intentional design

#### 5. Rate limit exceeded

**Cause:** Too many requests from same IP

**Solution:**
```bash
# Check current usage
curl http://localhost:8787/api/usage-stats

# Wait for rate limit to reset (next hour)
# Or adjust limits in .env:
HOURLY_BUDGET_LIMIT=50
```

#### 6. "No overlays found"

**Possible causes:**
- Property has no planning overlays (legitimate)
- Overlay layer IDs changed in ArcGIS (rare)

**Debug:**
```javascript
// In goldcoast-api.js:getOverlays()
console.log('[GOLDCOAST-API] Overlay identify results:', identifyResults);
```

---

## Git Conventions

### Branch Naming

Based on recent commit history, the project uses:

```
claude/<feature-description>-<session-id>
```

**Examples:**
- `claude/fix-parent-lot-priority-JptGl`
- `claude/add-disambiguation-JptGl`
- `claude/fix-site-response-format-JptGl`

**Pattern for AI assistants:**
- Prefix with `claude/`
- Use kebab-case for feature description
- Append session ID if provided

### Commit Messages

**Format:** Imperative mood, concise, descriptive

**Good examples:**
```
Improve address search precision and prioritize parent lots
Add multi-property disambiguation and improve address search accuracy
Fix site response format to be professional and structured
Add Gold Coast density codes and critical rules
Implement intent classification and improve message handling
```

**Bad examples:**
```
Updated some files
Fixed bug
Changes to claude.js
WIP
```

### Commit Workflow

1. **Make changes** to relevant files
2. **Test locally** to ensure changes work
3. **Check git status:**
   ```bash
   git status
   git diff
   ```

4. **Stage changes:**
   ```bash
   git add services/goldcoast-api.js
   git add services/claude.js
   ```

5. **Commit with descriptive message:**
   ```bash
   git commit -m "Add support for new planning overlay types"
   ```

6. **Push to feature branch:**
   ```bash
   git push -u origin claude/add-overlay-support-XyZ123
   ```

### Pull Request Workflow

Based on recent PRs:

1. **Create PR** from feature branch to main
2. **Title:** Clear description of what was changed
3. **Description:**
   - Summary of changes
   - Why the changes were made
   - Any testing performed
4. **Merge** after review (squash and merge preferred)

---

## Important Considerations

### 1. Strata Lots Always Use Parent Lot

When scraping strata properties (BUP/GTP schemes), always query lot 0 (parent lot) for zoning and overlays:

```javascript
// Correct approach
if (isStrata && lotNumber !== '0') {
    // Query parent lot for planning rules
    const parentLotPlan = `0${planNumber}`;
    const parentData = await getCadastreByLotPlan(parentLotPlan);
}
```

**Why:** Individual strata lots inherit planning rules from the parent site.

### 2. Address Disambiguation is Expected

Multiple properties at the same address is NORMAL (strata buildings, multiple dwellings):

```javascript
// Don't treat this as an error
if (possibleProperties.length > 1) {
    return {
        success: true,
        needsDisambiguation: true,
        options: possibleProperties
    };
}
```

**Why:** Claude handles this via function calling and user clarification.

### 3. Density Codes Aren't Always Present

Not all zones have RD1-8 density codes:

```javascript
// Handle gracefully
const densityMatch = zoneDescription.match(/\b(RD[1-8])\b/);
property.density = densityMatch ? densityMatch[1] : null;
```

**Why:** Some zones (commercial, industrial) don't use residential density codes.

### 4. Rate Limiting is Per-IP, In-Memory Only

Rate limiting state resets on server restart:

```javascript
// In middleware/protection.js
const ipData = {}; // Not persistent!
```

**Limitation:** Not suitable for distributed deployments without Redis/database.

### 5. BrowserBase is Expensive

Each PDOnline scrape consumes browser minutes:

```javascript
// Use sparingly - prefer ArcGIS API when possible
const das = await scrapeGoldCoastDAs(address); // Uses BrowserBase
```

**Best Practice:** Only use PDOnline scraper when user explicitly asks for DAs.

### 6. Context Preservation is Critical

Always pass conversation history to maintain context:

```javascript
// Good - preserves context
const response = await getAdvisory(query, conversationHistory);

// Bad - loses context, will re-scrape unnecessarily
const response = await getAdvisory(query, []);
```

### 7. Intent Classification Optimizes Performance

Fast path for conversational messages avoids tool setup overhead:

```javascript
// Greetings, thanks, casual chat → Fast path
if (intent === 'conversational') {
    return await handleConversationalMessage(query); // No tools
}

// Property queries → Full Claude with function calling
return await fullClaudeWithTools(query, conversationHistory);
```

**Why:** Tool setup adds latency; conversational messages don't need it.

### 8. Overlays Use Whitelisted Layers Only

Only 131 verified ArcGIS layers are checked for overlays:

```javascript
const OVERLAY_LAYER_IDS = [7, 8, 9, 10, ...]; // Explicitly whitelisted
```

**Why:** Prevents false positives from unverified or deprecated layers.

### 9. Geocoding Uses Multi-Stage Fallback

Always prefer official government geocoding:

```javascript
// 1. Try QLD Spatial-GIS (official, most accurate)
const qldResult = await geocodeWithQLD(address);

// 2. Fall back to Nominatim (OSM)
if (!qldResult) {
    const osmResult = await geocodeWithNominatim(address);
}
```

**Why:** QLD government geocoder has most accurate cadastre data.

### 10. Never Commit Credentials

All API keys must be in `.env` file, never in code:

```javascript
// Good
const apiKey = process.env.ANTHROPIC_API_KEY;

// Bad - NEVER do this
const apiKey = 'sk-ant-api03-xxxxx';
```

**Why:** Security and credential management.

---

## Quick Reference

### Project Commands

```bash
# Development
npm run dev              # Auto-restart on changes

# Production
npm start                # Start server

# Testing
curl http://localhost:8787/health
curl http://localhost:8787/api/scrape/12RP39932
```

### Key File Locations

```
server.js                              # Main Express app + all routes
services/goldcoast-api.js              # Property scraping
services/claude.js                     # AI orchestration
middleware/protection.js               # Rate limiting + security
middleware/auth.js                     # API key authentication
```

### Important URLs

- **Gold Coast ArcGIS:** https://gisservices.goldcoast.qld.gov.au/arcgis/rest/services/Public/
- **QLD Geocoder:** https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Geocoding/QldGeocodingHTTP/GeocodeServer/
- **PDOnline:** https://pdonline.goldcoast.qld.gov.au/Module/Application/Search.aspx
- **BrowserBase CDP:** wss://connect.browserbase.com
- **Anthropic API:** https://api.anthropic.com/v1/messages

### Environment Variable Checklist

**Required:**
- [x] ANTHROPIC_API_KEY
- [x] BROWSERBASE_API_KEY
- [x] BROWSERBASE_PROJECT_ID

**Optional:**
- [ ] PINECONE_API_KEY
- [ ] GOOGLE_MAPS_API_KEY
- [ ] PLANNING_ALERTS_API_KEY
- [ ] REPLICATE_API_TOKEN
- [ ] API_KEYS (enables authentication)

---

## Summary

This codebase is a production-ready API that combines:
- **Official data sources** (ArcGIS, QLD government geocoding)
- **AI-powered advisory** (Claude with function calling)
- **Browser automation** (BrowserBase for council systems)
- **Financial modeling** (feasibility, stamp duty)
- **Multi-layer security** (rate limiting, budget controls)

**Key Architectural Decisions:**
1. Intent classification optimizes performance
2. Context preservation enables conversational UI
3. Function calling allows Claude to autonomously gather data
4. Multi-source fallback ensures reliability
5. Strata title intelligence handles complex property structures

**When working on this codebase:**
- Always read files before making changes
- Follow established patterns and conventions
- Test locally with real Gold Coast properties
- Preserve conversation context across API calls
- Avoid over-engineering and unnecessary abstractions

**For AI assistants:**
- Use intent classification to optimize responses
- Extract context from conversation history
- Handle disambiguation gracefully
- Provide progress updates during long operations
- Format responses appropriately (professional for property data, casual for conversation)

---

**Document Version:** 1.0
**Last Updated:** 2026-01-15
**Maintained By:** AI Assistants working on this codebase

For questions or clarifications, refer to:
- README.md (user-facing documentation)
- Code comments in service files
- Recent git commits for context on changes
