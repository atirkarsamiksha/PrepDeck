require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first'); // FIX for Node 18+ Windows network ipv6 fallback issues

// Polyfill DOMMatrix for pdf-parse compatibility in Node.js 22+
if (typeof DOMMatrix === 'undefined') {
  global.DOMMatrix = class DOMMatrix {};
}

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

// Security Headers (Helmet with CSP compatible with CDNs and blob URLs)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.tailwindcss.com", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      mediaSrc: ["'self'", "blob:"],
      frameSrc: ["'self'", "blob:"],
      connectSrc: ["'self'", "http://localhost:*", "ws://localhost:*", "*"]
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// CORS Configuration
const corsOrigin = process.env.CORS_ORIGIN;
if (corsOrigin && corsOrigin !== '*') {
  const allowedOrigins = corsOrigin.split(',').map(o => o.trim());
  app.use(cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true
  }));
} else {
  app.use(cors());
}

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Ensure private uploads folder exists
const uploadsDir = path.resolve(process.env.STORAGE_PATH || path.join(__dirname, 'uploads'));
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Cache control policy: Ensure HTML pages are not stored in browser cache/bfcache
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/' || !path.extname(req.path)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
  next();
});

// Serve public static assets (DO NOT publicly serve /uploads)
app.use('/models', express.static(path.join(__dirname, '../client/models')));
app.use(express.static(path.join(__dirname, '../client')));

// Rate Limiting on Authentication Routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // Limit each IP to 30 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many authentication attempts from this IP, please try again after 15 minutes.' }
});
app.use('/api/auth', authLimiter);

// Health check endpoint
app.get('/api/health', (req, res) => {
  const dbState = mongoose.connection.readyState;
  const dbStatus = dbState === 1 ? 'connected' : dbState === 2 ? 'connecting' : 'disconnected';
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    database: dbStatus,
    geminiConfigured: !!process.env.GEMINI_API_KEY
  });
});

// Database Connection & Initial Startup Sync
const { syncUploadsToDb } = require('./controllers/docController');
const Document = require('./models/Document');
const User = require('./models/User');

mongoose.connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log('MongoDB connected successfully');
    try {
      const docCount = await Document.countDocuments();
      if (docCount === 0) {
        const defaultUser = await User.findOne();
        if (defaultUser) {
          const synced = await syncUploadsToDb(defaultUser._id);
          console.log(`Initial DB check: Automatically synced ${synced.length} existing uploads to MongoDB.`);
        }
      }
    } catch (syncErr) {
      console.warn('Initial upload sync warning:', syncErr.message);
    }
  })
  .catch(err => console.error('MongoDB connection error:', err));

// Routes
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/docs', require('./routes/docRoutes'));
app.use('/api/study', require('./routes/studyRoutes'));

// Specific Filter Routes (Notes & PYQs)
const { protect } = require('./middleware/authMiddleware');
const { getFilteredNotes, getFilteredPyqs } = require('./controllers/docController');
app.get('/api/notes', protect, getFilteredNotes);
app.get('/api/pyqs', protect, getFilteredPyqs);

// Return 404 for unmatched API routes and uploads
app.use(['/api', '/uploads'], (req, res) => {
  res.status(404).json({ message: 'Resource not found' });
});

// Global Express error handler
app.use((err, req, res, next) => {
  console.error('Unhandled Express error:', err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    message: err.message || 'An unexpected server error occurred'
  });
});

// Fallback for SPA or simple HTML serving
app.use((req, res) => {
  res.sendFile(path.join(__dirname, '../client', 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is in use. Please terminate the process or change PORT.`);
  } else {
    console.error('Server error:', err);
  }
});

const gracefulShutdown = () => {
  console.log('Received shutdown signal, closing server gracefully...');
  server.close(async () => {
    console.log('HTTP server closed.');
    try {
      await mongoose.connection.close(false);
      console.log('MongoDB connection closed.');
      process.exit(0);
    } catch (err) {
      console.error('Error closing MongoDB connection:', err);
      process.exit(1);
    }
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

module.exports = app;
