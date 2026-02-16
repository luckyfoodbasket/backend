require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const logger = require('./utils/logger');

const app = express();
const PORT = process.env.PORT || 5000;

// Routes
const walletRoutes = require('./routes/wallet');
const webhookRoutes = require('./routes/webhooks');
const authRoutes = require('./routes/auth');
const drawRoutes = require('./routes/draws');
const ticketRoutes = require('./routes/tickets');
const referralRoutes = require('./routes/referral');
const notificationRoutes = require('./routes/notifications');
const vendorRegistrationRoutes = require('./routes/vendor_registration');
const adminRoutes = require('./routes/admin');
const keepAliveService = require('./services/keepAliveService');
const drawScheduler = require('./services/drawScheduler');

// Security headers
app.use(helmet());

// Middleware
app.use(cors({
    origin: (origin, callback) => {
        const allowedOrigins = process.env.ALLOWED_ORIGINS
            ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
            : ['http://localhost:3000'];

        if (process.env.FRONTEND_URL && !allowedOrigins.includes(process.env.FRONTEND_URL)) {
            allowedOrigins.push(process.env.FRONTEND_URL);
        }

        // Allow if origin is in whitelist or if it's a local network IP during development
        if (!origin || allowedOrigins.includes(origin) ||
            (process.env.NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+):3000$/.test(origin))) {
            callback(null, true);
        } else {
            console.warn('CORS Blocked for origin:', origin);
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '1mb' }));

// Rate limiting for auth endpoints
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20,
    message: { error: 'Too many requests, please try again later', code: 'RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Rate limiting for financial write endpoints (wallet, ticket purchases)
const financialLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 60,
    message: { error: 'Too many requests, please try again later', code: 'RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Rate limiting for read-only data endpoints (generous — supports real-time polling)
const readLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 120,
    message: { error: 'Too many requests, please try again later', code: 'RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Rate limiting for webhooks (generous but prevents abuse)
const webhookLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100,
    message: { error: 'Too many webhook requests' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Request logging middleware
app.use((req, res, next) => {
    const start = Date.now();
    logger.request(req);

    res.on('finish', () => {
        const duration = Date.now() - start;
        logger.response(req, res.statusCode, duration);
    });

    next();
});

// Apply rate limiting
app.use('/api/auth', authLimiter);
app.use('/api/wallet', financialLimiter);
app.post('/api/tickets/buy', financialLimiter); // Strict limit on purchases only
app.get('/api/tickets/*', readLimiter); // Generous limit for read-only ticket data
app.use('/api/webhooks', webhookLimiter);

// Main Routes
app.use('/api/wallet', walletRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/draws', drawRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/referrals', referralRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/vendor-applications', vendorRegistrationRoutes);
app.use('/api/vendor', require('./routes/vendor'));
app.use('/api/admin', adminRoutes);

// Health check
app.get('/', (req, res) => {
    res.json({ message: 'LuckyBasket API is running' });
});

// Global error handler
app.use((err, req, res, next) => {
    logger.error('Unhandled error', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Start Server
app.listen(PORT, () => {
    logger.success('LuckyBasket API Server started', { port: PORT });
    logger.info('Available routes:', {
        wallet: '/api/wallet',
        auth: '/api/auth',
        webhooks: '/api/webhooks',
        draws: '/api/draws',
        tickets: '/api/tickets',
        referrals: '/api/referrals',
        notifications: '/api/notifications',
        vendorApplications: '/api/vendor-applications',
        admin: '/api/admin',
    });

    keepAliveService.init();
    drawScheduler.init();
});
