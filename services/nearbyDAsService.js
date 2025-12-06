// services/nearbyDAsService.js
import axios from 'axios';

const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const PLANNING_ALERTS_API_KEY = process.env.PLANNING_ALERTS_API_KEY;

export async function getNearbyDAs(address, radius, dateFrom, dateTo) {
  console.log('[NEARBY-DAS-SERVICE] Starting search...');
  console.log('[NEARBY-DAS-SERVICE] Address:', address);
  console.log('[NEARBY-DAS-SERVICE] Radius:', radius);
  console.log('[NEARBY-DAS-SERVICE] Google API Key exists:', !!GOOGLE_API_KEY);
  console.log('[NEARBY-DAS-SERVICE] PlanningAlerts Key exists:', !!PLANNING_ALERTS_API_KEY);

  if (!GOOGLE_API_KEY) {
    throw new Error('Google Maps API key not configured');
  }

  if (!PLANNING_ALERTS_API_KEY) {
    throw new Error('PlanningAlerts API key not configured');
  }

  // Step 1: Geocode the address
  console.log('[NEARBY-DAS-SERVICE] Geocoding address...');
  const geocodeResponse = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
    params: {
      address: address,
      key: GOOGLE_API_KEY,
      region: 'au'
    }
  });

  console.log('[NEARBY-DAS-SERVICE] Geocode status:', geocodeResponse.data.status);

  if (geocodeResponse.data.status !== 'OK' || !geocodeResponse.data.results.length) {
    throw new Error('Could not geocode address. Please check and try again.');
  }

  const location = geocodeResponse.data.results[0].geometry.location;
  const formattedAddress = geocodeResponse.data.results[0].formatted_address;
  console.log('[NEARBY-DAS-SERVICE] Geocoded to:', location.lat, location.lng);

  // Step 2: Query PlanningAlerts API
  console.log('[NEARBY-DAS-SERVICE] Querying PlanningAlerts API...');
  const planningResponse = await axios.get('https://api.planningalerts.org.au/applications.json', {
    params: {
      key: PLANNING_ALERTS_API_KEY,
      lat: location.lat,
      lng: location.lng,
      radius: radius || 1000
    }
  });

  console.log('[NEARBY-DAS-SERVICE] PlanningAlerts status:', planningResponse.status);
  console.log('[NEARBY-DAS-SERVICE] Raw applications count:', planningResponse.data.application?.length || 0);

  // Step 3: Map and process applications
  let applications = (planningResponse.data.application || []).map(app => ({
    id: app.id?.toString() || Math.random().toString(),
    council_reference: app.council_reference,
    address: app.address,
    description: app.description,
    council_name: app.authority?.full_name || app.authority_name || 'Unknown Council',
    date_received: app.date_received,
    date_scraped: app.date_scraped,
    info_url: app.info_url,
    comment_url: app.comment_url,
    lat: app.lat,
    lng: app.lng,
    distance: calculateDistance(location.lat, location.lng, app.lat, app.lng)
  }));

  console.log('[NEARBY-DAS-SERVICE] Mapped applications:', applications.length);

  // Step 4: Filter by date range if provided
  if (dateFrom || dateTo) {
    const beforeCount = applications.length;
    applications = applications.filter(app => {
      if (!app.date_received) return true;
      const appDate = new Date(app.date_received);
      if (dateFrom && appDate < new Date(dateFrom)) return false;
      if (dateTo && appDate > new Date(dateTo)) return false;
      return true;
    });
    console.log('[NEARBY-DAS-SERVICE] Filtered by date:', beforeCount, '->', applications.length);
  }

  // Step 5: Sort by distance
  applications.sort((a, b) => a.distance - b.distance);

  console.log('[NEARBY-DAS-SERVICE] ✅ Returning', applications.length, 'applications');

  return {
    success: true,
    count: applications.length,
    search_location: { 
      lat: location.lat, 
      lng: location.lng, 
      address: formattedAddress 
    },
    applications
  };
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth radius in metres
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // Distance in metres
}
