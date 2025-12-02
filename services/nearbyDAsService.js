const axios = require('axios');

const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const PLANNING_ALERTS_API_KEY = process.env.PLANNING_ALERTS_API_KEY;

async function getNearbyDAs(address, radius, dateFrom, dateTo) {
  try {
    // Geocode address
    const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json`;
    const geocodeResponse = await axios.get(geocodeUrl, {
      params: {
        address: address,
        key: GOOGLE_API_KEY,
        region: 'au'
      }
    });

    if (geocodeResponse.data.status !== 'OK' || !geocodeResponse.data.results.length) {
      throw new Error('Could not geocode address. Please check and try again.');
    }

    const location = geocodeResponse.data.results[0].geometry.location;

    // Query PlanningAlerts API
    const planningResponse = await axios.get('https://api.planningalerts.org.au/applications.json', {
      params: {
        key: PLANNING_ALERTS_API_KEY,
        lat: location.lat,
        lng: location.lng,
        radius: radius || 1000
      }
    });

    let applications = (planningResponse.data.application || []).map(app => ({
      id: app.id,
      council_reference: app.council_reference,
      address: app.address,
      description: app.description,
      council_name: app.authority_name,
      date_received: app.date_received,
      date_scraped: app.date_scraped,
      info_url: app.info_url,
      comment_url: app.comment_url,
      lat: app.lat,
      lng: app.lng,
      distance: calculateDistance(location.lat, location.lng, app.lat, app.lng)
    }));

    // Filter by date range if provided
    if (dateFrom || dateTo) {
      applications = applications.filter(app => {
        const appDate = new Date(app.date_received);
        const fromDate = dateFrom ? new Date(dateFrom) : null;
        const toDate = dateTo ? new Date(dateTo) : null;

        if (fromDate && appDate < fromDate) return false;
        if (toDate && appDate > toDate) return false;
        return true;
      });
    }

    // Sort by distance (closest first)
    applications.sort((a, b) => a.distance - b.distance);

    return {
      success: true,
      count: applications.length,
      search_location: { 
        lat: location.lat, 
        lng: location.lng, 
        address: geocodeResponse.data.results[0].formatted_address 
      },
      applications
    };

  } catch (error) {
    throw error;
  }
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

module.exports = { getNearbyDAs };
