# Gold Coast Planning Advisor API

A Node.js API that provides AI-powered planning advice for Gold Coast properties using:
- **BrowserBase** for real-time web scraping
- **Claude Sonnet 4.5** for intelligent responses
- **Express** for API endpoints

## Features

- 🔍 Real-time property data scraping from Gold Coast City Plan
- 🤖 AI-powered planning advisory with Claude
- 📊 Extracts: Zone, Density, Height limits, Overlays, Planning context
- ⚡ Function calling - Claude automatically scrapes when needed
- 🌐 RESTful API ready for any frontend

---

## Quick Start

### 1. Prerequisites

- Node.js 18+ installed
- BrowserBase account (free trial at https://browserbase.com)
- Anthropic API key (from https://console.anthropic.com)

### 2. Installation

```bash
# Clone the repo
cd goldcoast-planner-api

# Install dependencies
npm install

# Copy environment template
cp .env.example .env
```

### 3. Configure Environment Variables

Edit `.env` with your credentials:

```env
ANTHROPIC_API_KEY=sk-ant-api03-xxxxx
BROWSERBASE_API_KEY=bb_xxxxx
BROWSERBASE_PROJECT_ID=xxxxx
PORT=8787
NODE_ENV=development
```

**Where to get these:**
- **ANTHROPIC_API_KEY**: https://console.anthropic.com/settings/keys
- **BROWSERBASE_API_KEY**: BrowserBase Dashboard → Settings → API Keys
- **BROWSERBASE_PROJECT_ID**: BrowserBase Dashboard → Projects → Click your project

### 4. Run Locally

```bash
# Development mode (auto-restart on changes)
npm run dev

# Production mode
npm start
```

Server runs on `http://localhost:8787`

---

## API Endpoints

### Health Check
```bash
GET /health
```

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2025-10-25T10:30:00.000Z"
}
```

---

### Test Scraper
```bash
GET /api/scrape/:query
```

**Examples:**
```bash
# By lot/plan
curl http://localhost:8787/api/scrape/12RP39932

# By address
curl http://localhost:8787/api/scrape/22%20Mary%20Avenue%20Broadbeach
```

**Response:**
```json
{
  "success": true,
  "data": {
    "property": {
      "lotplan": "12RP39932",
      "address": "22 Mary Avenue, Broadbeach",
      "zone": "High Density Residential",
      "zoneCode": "HDR",
      "density": "RD5",
      "height": "No limit (HX overlay)",
      "area": "405sqm",
      "overlays": ["Broadbeach LAP", "HX Height Overlay"]
    },
    "planningContext": {
      "zoneDescription": "High Density Residential zone provides for...",
      "lapRequirements": "Broadbeach LAP requires...",
      "overlayRestrictions": null
    },
    "scrapedAt": "2025-10-25T10:30:00.000Z"
  },
  "scrapedAt": "2025-10-25T10:30:00.000Z"
}
```

---

### Get AI Advisory
```bash
POST /api/advise
Content-Type: application/json

{
  "query": "What can I build on 12RP39932?"
}
```

**Response:**
```json
{
  "success": true,
  "response": {
    "answer": "Based on the current planning scheme, 12RP39932 is zoned High Density Residential with RD5 density and no height limit due to the HX overlay. This means you can potentially develop a high-rise apartment building. Key considerations:\n\n1. Density: RD5 allows 1 bedroom per 50sqm\n2. Height: No limit (HX overlay)\n3. Overlays: Must comply with Broadbeach LAP requirements\n4. Next steps: Engage a town planner for detailed assessment",
    "propertyData": { ... },
    "usedTool": true,
    "toolQuery": "12RP39932"
  },
  "timestamp": "2025-10-25T10:30:00.000Z"
}
```

---

## Deploy to Railway

### 1. Push to GitHub

```bash
cd goldcoast-planner-api
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### 2. Deploy on Railway

1. Go to https://railway.app
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your repo
4. Railway auto-detects Node.js (no config needed!)

### 3. Add Environment Variables

In Railway dashboard:
1. Click your project
2. Go to "Variables" tab
3. Add:
   - `ANTHROPIC_API_KEY`
   - `BROWSERBASE_API_KEY`
   - `BROWSERBASE_PROJECT_ID`
   - `NODE_ENV` = `production`

### 4. Deploy

Railway auto-deploys. Your API will be live at:
```
https://your-project.up.railway.app
```

---

## Usage with Frontend

### Example: Lovable.dev Frontend

```javascript
// In your Lovable frontend
const API_URL = 'https://your-project.up.railway.app';

async function getAdvice(query) {
  const response = await fetch(`${API_URL}/api/advise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });
  
  const data = await response.json();
  return data.response.answer;
}

// Usage
const advice = await getAdvice("What can I build on 12RP39932?");
console.log(advice);
```

---

## How It Works

1. **User asks a question** via `/api/advise`
2. **Claude analyzes** the query
3. **If property-specific**, Claude calls `get_property_info` function
4. **BrowserBase scraper** fetches real-time data from Gold Coast City Plan
5. **Claude receives** property data + planning context
6. **Claude generates** comprehensive advisory
7. **API returns** answer to frontend

---

## Cost Estimate

- **Railway Hobby**: $5/month (or free tier)
- **BrowserBase Free**: 60 browser minutes/month (≈20-40 queries)
- **BrowserBase Starter**: $25/month (1000 queries)
- **Anthropic API**: ~$0.01 per query (Claude Sonnet 4.5)

**Total for 100 queries/month**: ~$30/month

---

## Troubleshooting

### "Session failed to create"
- Check BROWSERBASE_API_KEY is correct
- Verify BROWSERBASE_PROJECT_ID matches your project

### "Anthropic API error"
- Check ANTHROPIC_API_KEY is valid
- Verify you have API credits

### "Scraping timeout"
- Increase timeout in browserbase.js
- Check Gold Coast City Plan website is accessible

---

## Next Steps

1. ✅ Get it working locally
2. ✅ Deploy to Railway
3. 🔄 Build Lovable frontend
4. 🔄 Add caching (optional, to reduce BrowserBase costs)
5. 🔄 Add more planning context extraction
6. 🔄 Add user authentication (if needed)

---

## Support

For issues:
- BrowserBase: https://docs.browserbase.com
- Anthropic: https://docs.anthropic.com
- Railway: https://docs.railway.app

---

## License

MIT
