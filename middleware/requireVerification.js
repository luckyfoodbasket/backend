const logger = require('../utils/logger');

/**
 * Verification Middleware
 * Checks if user has verified their email.
 * Reads from req.userProfile (set by authenticate middleware) — no DB query needed.
 */
const requireVerification = (req, res, next) => {
    if (!req.userProfile) {
        return res.status(404).json({ error: 'User profile not found' });
    }

    if (!req.userProfile.is_verified) {
        logger.warn('Access denied: email not verified', { userId: req.user.id });
        return res.status(403).json({
            error: 'Email verification required',
            code: 'EMAIL_NOT_VERIFIED',
        });
    }

    next();
};

module.exports = requireVerification;
