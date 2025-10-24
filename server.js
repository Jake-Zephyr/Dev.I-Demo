import express from "express";
import { config } from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

function detectPropertyMention(query) {
  const lotplanMatch = query.match(/\b(\d+[A-Z]{1,4}\d+)\b/i);
  if (lotplanMatch) return lotplanMatch[1];
  
  const addressMatch = query.match(/\b\d+\s+[A-Za-z\s]+(?:Street|St|Road|Rd|Avenue|Ave|Court|Ct|Lane|Drive|Dr|Way|Place|Pl|Crescent|Cres)[,\s]+[A-Za-z\s]+\b/i);
  if (addressMatch) return addressMatch[0];
  
  return null;
}

async function scrapeProperty(query) {
  return new Promise((resolve, reject) => {
    const pythonScript = join(__dirname, "goldcoast_scraper.py");
    const pythonProcess = spawn("python3", [pythonScript, query]);

    let stdout = "";
    let stderr = "";

    pythonProcess.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    pythonProcess.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    pythonProcess.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Scraper failed: ${stderr}`));
        return;
      }

      try {
        const lines = stdout.split("\n").filter(l => l.trim());
        const jsonLine = lines[lines.length - 1];
        const result = JSON.parse(jsonLine);
        resolve(result);
      } catch (e) {
        reject(new Error(`Failed to parse: ${e.message}`));
      }
    });

    setTimeout(() => {
      pythonProcess.kill();
      reject(new Error("Timeout"));
    }, 90000);
  });
}

app.get("/", (req, res) => {
  res.json({
    status: "Planning Advisor API is running",
    endpoints: [
      "GET / - Health check",
      "POST /api/advise - Get planning advice",
      "GET /api/scrape/:query - Test scraper"
    ]
  });
});

app.post("/api/advise", async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || query.length < 10) {
      return res.status(400).json({ error: "Query too short" });
    }

    console.log(`[API] Query: ${query}`);

    const propertyMention = detectPropertyMention(query);
    let scrapedData = null;
    
    if (propertyMention) {
      console.log(`[API] Scraping: ${propertyMention}`);
      try {
        scrapedData = await scrapeProperty(propertyMention);
        console.log(`[API] Scrape ${scrapedData.success ? "success" : "failed"}`);
      } catch (error) {
        console.error(`[API] Scraper error: ${error.message}`);
      }
    }

    let userPrompt = `User Question: ${query}\n\n`;
    
    if (scrapedData?.success) {
      userPrompt += `=== OFFICIAL PROPERTY DATA ===\n`;
      if (scrapedData.address) userPrompt += `Address: ${scrapedData.address}\n`;
      if (scrapedData.lot_plan) userPrompt += `Lot/Plan: ${scrapedData.lot_plan}\n`;
      if (scrapedData.zone) userPrompt += `Zone: ${scrapedData.zone}\n`;
      if (scrapedData.residential_density) userPrompt += `Density: ${scrapedData.residential_density}\n`;
      if (scrapedData.area_sqm) userPrompt += `Area: ${scrapedData.area_sqm} m²\n\n`;
    }

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: "You are a Gold Coast planning advisor. Provide advice as JSON: {summary, key_items, notes, citations}",
      messages: [{ role: "user", content: userPrompt }]
    });

    const responseText = message.content[0].text;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) {
      return res.json({ summary: responseText, key_items: [], notes: [], citations: [] });
    }

    return res.json(JSON.parse(jsonMatch[0]));

  } catch (error) {
    console.error("[API] Error:", error);
    return res.status(500).json({ error: error.message });
  }
});

app.get("/api/scrape/:query", async (req, res) => {
  try {
    const query = decodeURIComponent(req.params.query);
    const result = await scrapeProperty(query);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ Server running on port ${PORT}`);
});
