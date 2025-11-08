// middleware/protection.js
// Multi-layer protection against bot spam and cost overruns

/**
 * Simple in-memory rate limiter
 * For production, use Redis for distributed rate limiting
 */
class RateLimiter {
  constructor() {
    this.requests = new Map(); // IP -> [{timestamp, cost}, ...]
    this.hourlyBudget = parseFloat(process.env.HOURLY_BUDGET_LIMIT || '10'); // $10/hour default
    this.dailyBudget = parseFloat(process.env.DAILY_BUDGET_LIMIT || '50'); // $50/day default
    this.totalSpent = { hour: 0, day: 0, lastHourReset: Date.now(), lastDayReset: Date.now() };
  }

  /**
   * Clean up old entries (older than 1 hour)
   */
  cleanup() {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    
    for (const [ip, requests] of this.requests.entries()) {
      const recent = requests.filter(r => r.timestamp > oneHourAgo);
      if (recent.length === 0) {
        this.requests.delete(ip);
      } else {
        this.requests.set(ip, recent);
      }
    }
    
    // Reset hourly/daily counters
    if (Date.now() - this.totalSpent.lastHourReset > 60 * 60 * 1000) {
      this.totalSpent.hour = 0;
      this.totalSpent.lastHourReset = Date.now();
    }
    
    if (Date.now() - this.totalSpent.lastDayReset > 24 * 60 * 60 * 1000) {
      this.totalSpent.day = 0;
      this.totalSpent.lastDayReset = Date.now();
    }
  }

  /**
   * Check if IP is allowed to make request
   */
  checkRateLimit(ip) {
    this.cleanup();
    
    const requests = this.requests.get(ip) || [];
    const now = Date.now();
    
    // Limits per IP
    const oneMinuteAgo = now - 60 * 1000;
    const oneHourAgo = now - 60 * 60 * 1000;
    
    const requestsLastMinute = requests.filter(r => r.timestamp > oneMinuteAgo).length;
    const requestsLastHour = requests.filter(r => r.timestamp > oneHourAgo).length;
    
    // Rate limits - adjusted for real users
    if (requestsLastMinute >= 5) {  // 5 requests per minute (blocks rapid spam)
      return { allowed: false, reason: 'Too many requests (max 5/minute). Please slow down.' };
    }
    
    if (requestsLastHour >= 50) {  // 50 requests per hour (reasonable for real users)
      return { allowed: false, reason: 'Too many requests (max 50/hour). Take a break!' };
    }
    
    // Budget limits
    if (this.totalSpent.hour >= this.hourlyBudget) {
      return { allowed: false, reason: `Hourly budget limit reached ($${this.hourlyBudget})` };
    }
    
    if (this.totalSpent.day >= this.dailyBudget) {
      return { allowed: false, reason: `Daily budget limit reached ($${this.dailyBudget})` };
    }
    
    return { allowed: true };
  }

  /**
   * Record a request
   */
  recordRequest(ip, estimatedCost = 0.50) {
    const requests = this.requests.get(ip) || [];
    requests.push({ timestamp: Date.now(), cost: estimatedCost });
    this.requests.set(ip, requests);
    
    this.totalSpent.hour += estimatedCost;
    this.totalSpent.day += estimatedCost;
  }

  /**
   * Get current usage stats
   */
  getStats() {
    return {
      hourlySpent: this.totalSpent.hour.toFixed(2),
      dailySpent: this.totalSpent.day.toFixed(2),
      hourlyLimit: this.hourlyBudget,
      dailyLimit: this.dailyBudget,
      activeIPs: this.requests.size
    };
  }
}

// Singleton instance
const rateLimiter = new RateLimiter();

/**
 * Rate limiting middleware
 */
export function rateLimitMiddleware(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  
  const check = rateLimiter.checkRateLimit(ip);
  
  if (!check.allowed) {
    console.log(`[RATE LIMIT] Blocked ${ip}: ${check.reason}`);
    return res.status(429).json({
      error: 'Rate limit exceeded',
      message: check.reason,
      retryAfter: 60 // seconds
    });
  }
  
  // Estimate cost: ~$0.30 for scraping + ~$0.20 for Claude = $0.50 per request
  rateLimiter.recordRequest(ip, 0.50);
  
  next();
}

/**
 * Simple query validation middleware
 */
export function queryValidationMiddleware(req, res, next) {
  const { query } = req.body;
  
  if (!query || typeof query !== 'string') {
    return res.status(400).json({
      error: 'Invalid request',
      message: 'Query must be a non-empty string'
    });
  }
  
  // Prevent extremely long queries
  if (query.length > 500) {
    return res.status(400).json({
      error: 'Query too long',
      message: 'Query must be less than 500 characters'
    });
  }
  
  // Prevent obviously malicious content
  const suspiciousPatterns = [
    /<script/i,
    /javascript:/i,
    /eval\(/i,
    /exec\(/i
  ];
  
  if (suspiciousPatterns.some(pattern => pattern.test(query))) {
    console.log(`[SECURITY] Blocked suspicious query from ${req.ip}: ${query.substring(0, 50)}`);
    return res.status(400).json({
      error: 'Invalid query',
      message: 'Query contains suspicious content'
    });
  }
  
  next();
}

/**
 * Usage stats endpoint (for monitoring)
 */
export function getUsageStats() {
  return rateLimiter.getStats();
}

/**
 * Emergency kill switch
 * Set EMERGENCY_SHUTDOWN=true in Railway to completely disable API
 */
export function emergencyShutdownMiddleware(req, res, next) {
  if (process.env.EMERGENCY_SHUTDOWN === 'true') {
    console.log(`[EMERGENCY] API is in shutdown mode`);
    return res.status(503).json({
      error: 'Service temporarily unavailable',
      message: 'API is currently in maintenance mode'
    });
  }
  next();
}
