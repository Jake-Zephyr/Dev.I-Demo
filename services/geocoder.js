// services/geocoder.js
export async function geocodeAddress(address) {
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address + ', Gold Coast, QLD, Australia')}&key=${process.env.GOOGLE_MAPS_API_KEY}`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.status === 'OK' && data.results.length > 0) {
      return {
        formatted_address: data.results[0].formatted_address,
        latitude: data.results[0].geometry.location.lat,
        longitude: data.results[0].geometry.location.lng
      };
    }
    
    return null;
  } catch (error) {
    console.error('[GEOCODER ERROR]', error);
    return null;
  }
}
