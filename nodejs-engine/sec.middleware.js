// Rate Limit Middleware for Express
const rateLimitMap = new Map();
const RATE_LIMITS = {
  default: { requests: 30, windowMs: 60000 }, // 30 req/min
  api: { requests: 100, windowMs: 60000 }, // 100 req/min for API
  trade: { requests: 10, windowMs: 60000 }, // 10 trades/min per user
};

function checkRateLimit(identifier, limitType = 'default') {
  const now = Date.now();
  const limit = RATE_LIMITS[limitType];
  const key = `${limitType}:${identifier}`;
  const record = rateLimitMap.get(key);

  if (!record || now > record.resetTime) {
    rateLimitMap.set(key, { count: 1, resetTime: now + limit.windowMs });
    return { allowed: true, remaining: limit.requests - 1, retryAfter: null };
  }

  if (record.count >= limit.requests) {
    const retryAfter = Math.ceil((record.resetTime - now) / 1000);
    return { allowed: false, remaining: 0, retryAfter };
  }

  record.count++;
  return { allowed: true, remaining: limit.requests - record.count, retryAfter: null };
}

// Input Validation Functions

function isValidPageNumber(page) {
  const num = parseInt(page, 10);
  return !isNaN(num) && num > 0 && num <= 100;
}

function isValidChatId(chatId) {
  return /^\d{5,}$/.test(String(chatId));
}

function isValidWalletAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function isValidSlug(slug) {
  return /^[a-z0-9\-]{3,255}$/.test(slug);
}

function isValidSide(side) {
  return ['YES', 'NO'].includes(side?.toUpperCase());
}

function isValidAmount(amount) {
  const num = parseFloat(amount);
  return !isNaN(num) && num > 0 && num <= 10000; // Max $10k per trade
}

function isValidKeyword(keyword) {
  return keyword && keyword.length > 0 && keyword.length <= 100 && /^[a-zA-Z0-9\s\-]{1,100}$/.test(keyword);
}

// XSS Prevention and Input Sanitization

function sanitizeInput(input) {
  if (typeof input !== 'string') return input;
  return input
    .replace(/[<>]/g, '') // Remove angle brackets
    .trim()
    .substring(0, 1000); // Max length
}

// CORS Configuration

const corsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = [
      process.env.FRONTEND_URL || 'http://localhost:3000',
      'https://zero-drift-eight.vercel.app',
      'http://localhost:3000',
      'http://localhost:3001',
    ];
    
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS policy violation'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
};

// Request Timeout Middleware

function requestTimeout(ms = 30000) {
  return (req, res, next) => {
    const timeout = setTimeout(() => {
      console.error(`[ZeroDrift] Request timeout: ${req.method} ${req.path}`);
      res.status(408).json({ success: false, error: 'Request timeout' });
    }, ms);

    res.on('finish', () => clearTimeout(timeout));
    res.on('close', () => clearTimeout(timeout));
    next();
  };
}


// Request Logger
function logRequest(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const statusColor = res.statusCode >= 400 ? '❌' : '✅';
    console.log(
      `[ZeroDrift] ${statusColor} ${req.method} ${req.path} — ${res.statusCode} (${duration}ms)`
    );
  });
  next();
}


function rateLimitMiddleware(limitType = 'default') {
  return (req, res, next) => {
    const identifier = req.ip || req.connection.remoteAddress;
    const result = checkRateLimit(identifier, limitType);

    res.set('X-RateLimit-Remaining', result.remaining);
    
    if (!result.allowed) {
      res.set('Retry-After', result.retryAfter);
      return res.status(429).json({ 
        success: false, 
        error: 'Too many requests', 
        retryAfter: result.retryAfter 
      });
    }
    
    next();
  };
}



// Export 

module.exports = {
  checkRateLimit,
  isValidPageNumber,
  isValidChatId,
  isValidWalletAddress,
  isValidSlug,
  isValidSide,
  isValidAmount,
  isValidKeyword,
  sanitizeInput,
  corsOptions,
  requestTimeout,
  logRequest,
  rateLimitMiddleware,
};