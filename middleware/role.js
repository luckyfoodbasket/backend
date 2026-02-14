const logger = require('../utils/logger');

/**
 * Authorization Middleware Factory
 * Verifies user has one of the allowed roles.
 * Reads from req.userProfile (set by authenticate middleware) — no DB query needed.
 *
 * @param {string[]} allowedRoles - Array of allowed role names
 * @returns Express middleware function
 *
 * @example
 * router.get('/admin/list', authenticate, authorize(['admin']), handler);
 * router.get('/data', authenticate, authorize(['admin', 'vendor']), handler);
 */
const authorize = (allowedRoles) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                error: 'Unauthorized: User not authenticated',
                code: 'NOT_AUTHENTICATED',
            });
        }

        if (!req.userProfile) {
            return res.status(403).json({
                error: 'Forbidden: User profile not found',
                code: 'PROFILE_NOT_FOUND',
            });
        }

        const userRole = req.userProfile.role;

        if (!allowedRoles.includes(userRole)) {
            logger.warn(`Authorization denied: ${req.userProfile.email} has role '${userRole}', required: [${allowedRoles.join(', ')}]`);
            return res.status(403).json({
                error: `Forbidden: Requires one of these roles: ${allowedRoles.join(', ')}`,
                code: 'INSUFFICIENT_ROLE',
                currentRole: userRole,
                requiredRoles: allowedRoles,
            });
        }

        req.role = userRole;
        next();
    };
};

module.exports = authorize;
