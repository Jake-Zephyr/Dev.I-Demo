// services/rag.js - Simple RAG for Gold Coast Planning Scheme
import { Pinecone } from '@pinecone-database/pinecone';

const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY
});

const INDEX_NAME = 'gc-zoning'; // Your Pinecone index name

/**
 * Search for relevant planning scheme information
 * Uses text-based metadata search (no embeddings needed for now)
 */
export async function searchPlanningScheme(query, propertyData) {
  try {
    console.log('[RAG] Searching planning scheme...');
    console.log('[RAG] Property zone:', propertyData.property.zone);
    console.log('[RAG] Property density:', propertyData.property.density);
    console.log('[RAG] Property overlays:', propertyData.property.overlays?.length || 0);
    
    const index = pinecone.index(INDEX_NAME);
    const results = [];
    
    // Simple approach: Query with dummy vector and filter by metadata
    // This works even without embeddings!
    
    // Search for zone information
    if (propertyData.property.zone) {
      try {
        console.log(`[RAG] Searching for zone: ${propertyData.property.zone}`);
        const zoneResults = await index.query({
          vector: Array(1024).fill(0), // Dummy vector
          topK: 10,
          includeMetadata: true
        });
        
        // Filter results that match the zone
        const matching = zoneResults.matches.filter(m => {
          const text = (m.metadata?.text || '').toLowerCase();
          const zoneLower = propertyData.property.zone.toLowerCase();
          return text.includes(zoneLower);
        });
        
        if (matching.length > 0) {
          console.log(`[RAG] Found ${matching.length} zone matches`);
          results.push(...matching);
        }
      } catch (e) {
        console.log(`[RAG] Zone search error:`, e.message);
      }
    }
    
    // Search for density information
    if (propertyData.property.density) {
      try {
        console.log(`[RAG] Searching for density: ${propertyData.property.density}`);
        const densityResults = await index.query({
          vector: Array(1024).fill(0),
          topK: 10,
          includeMetadata: true
        });
        
        const matching = densityResults.matches.filter(m => {
          const text = (m.metadata?.text || '').toLowerCase();
          const densityLower = propertyData.property.density.toLowerCase();
          return text.includes(densityLower);
        });
        
        if (matching.length > 0) {
          console.log(`[RAG] Found ${matching.length} density matches`);
          results.push(...matching);
        }
      } catch (e) {
        console.log(`[RAG] Density search error:`, e.message);
      }
    }
    
    // Search for overlays (top 3)
    if (propertyData.property.overlays && propertyData.property.overlays.length > 0) {
      const topOverlays = propertyData.property.overlays.slice(0, 3);
      
      for (const overlay of topOverlays) {
        try {
          console.log(`[RAG] Searching for overlay: ${overlay.substring(0, 50)}...`);
          const overlayResults = await index.query({
            vector: Array(1024).fill(0),
            topK: 10,
            includeMetadata: true
          });
          
          // Try to match overlay by keywords
          const keywords = overlay.toLowerCase().split(' ').filter(w => w.length > 3);
          const matching = overlayResults.matches.filter(m => {
            const text = (m.metadata?.text || '').toLowerCase();
            return keywords.some(keyword => text.includes(keyword));
          });
          
          if (matching.length > 0) {
            console.log(`[RAG] Found ${matching.length} matches for overlay`);
            results.push(...matching.slice(0, 2)); // Top 2 per overlay
          }
        } catch (e) {
          console.log(`[RAG] Overlay search error:`, e.message);
        }
      }
    }
    
    // Deduplicate and format
    const uniqueResults = [];
    const seenIds = new Set();
    
    for (const result of results) {
      if (!seenIds.has(result.id)) {
        seenIds.add(result.id);
        uniqueResults.push({
          text: result.metadata?.text || '',
          section: result.metadata?.name || result.id,
          relevance: result.score || 0
        });
      }
    }
    
    console.log(`[RAG] Returning ${uniqueResults.length} planning sections`);
    
    return uniqueResults.slice(0, 5); // Top 5
    
  } catch (error) {
    console.error('[RAG ERROR]', error);
    console.error('[RAG ERROR] Stack:', error.stack);
    return []; // Return empty on error
  }
}
