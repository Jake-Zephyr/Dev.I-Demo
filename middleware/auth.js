// middleware/auth.js
// Optional API key authentication
/**
 * API Key authentication middleware
 * Enable by setting API_KEYS environment variable
 */
export function apiKeyAuthMiddleware(req, res, next) {
  // Check if authentication is enabled
  const apiKeysEnv = process.env.API_KEYS;
  
  if (!apiKeysEnv) {
    // Auth disabled - allow all requests
    console.log('[AUTH] API key authentication is DISABLED');
    return next();
  }
  
  // Parse allowed API keys
  const allowedKeys = apiKeysEnv.split(',').map(k => k.trim());
  
  // Get API key from request
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  
  if (!apiKey) {
    console.log(`[AUTH] Blocked ${req.ip}: No API key provided`);  // ← FIXED
    return res.status(401).json({
      error: 'Authentication required',
      message: 'Please provide an API key in X-API-Key header or apiKey query parameter'
    });
  }
  
  // Validate API key
  if (!allowedKeys.includes(apiKey)) {
    console.log(`[AUTH] Blocked ${req.ip}: Invalid API key`);  // ← FIXED
    return res.status(401).json({
      error: 'Authentication failed',
      message: 'Invalid API key'
    });
  }
  
  // Valid key - allow request
  console.log(`[AUTH] Valid API key from ${req.ip}`);  // ← FIXED
  next();
}
```

---

## 🔧 Set Environment Variable in Railway:

Go to your Railway project and add:
```
API_KEYS=dev_sk_devi_x7k9m2p4n8q5w3e6r1t0
