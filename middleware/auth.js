const { supabaseAdmin } = require('../config/supabase');
const logger = require('../utils/logger');

/**
 * Authentication Middleware
 * Verifies JWT token, fetches user profile, and attaches both to the request.
 *
 * After this middleware runs, downstream handlers have access to:
 *   - req.user         Supabase auth user object
 *   - req.userProfile  { role, is_verified, email, full_name } or null
 */
const authenticate = async (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            error: 'Unauthorized: Missing or invalid token',
            code: 'MISSING_TOKEN',
        });
    }

    const token = authHeader.split(' ')[1];

    if (!token || token === 'undefined' || token === 'null') {
        return res.status(401).json({
            error: 'Unauthorized: Invalid token format',
            code: 'INVALID_TOKEN_FORMAT',
        });
    }

    try {
        const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

        if (error) {
            logger.warn('Auth failed: token verification error', { message: error.message });

            // Specific handling for deleted/non-existent users
            if (error.message && error.message.includes('not exist')) {
                return res.status(401).json({
                    error: 'Unauthorized: User account not found. Please log in again.',
                    code: 'USER_DELETED',
                    requiresReauth: true,
                });
            }

            return res.status(401).json({
                error: 'Unauthorized: Invalid or expired session',
                code: 'INVALID_SESSION',
                requiresReauth: true,
            });
        }

        if (!user) {
            return res.status(401).json({
                error: 'Unauthorized: User not found',
                code: 'USER_NOT_FOUND',
                requiresReauth: true,
            });
        }

        req.user = user;

        // Fetch profile once for all downstream middleware (authorize, requireVerification).
        // This eliminates 1-2 redundant DB queries per protected request.
        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('role, is_verified, email, full_name')
            .eq('id', user.id)
            .single();

        if (profileError && profileError.code !== 'PGRST116') {
            logger.error('Auth middleware: profile fetch error', profileError);
        }

        req.userProfile = profile || null;

        next();
    } catch (err) {
        logger.error('Auth middleware: internal error', err);
        return res.status(500).json({
            error: 'Internal server error during authentication',
            code: 'AUTH_INTERNAL_ERROR',
        });
    }
};

module.exports = authenticate;
