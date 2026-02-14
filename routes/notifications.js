const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const authenticate = require('../middleware/auth');
const logger = require('../utils/logger');

/**
 * Get user's notifications
 * GET /api/notifications
 */
router.get('/', authenticate, async (req, res) => {
    const userId = req.user.id;
    const { limit = 20, offset = 0, unreadOnly = false } = req.query;

    logger.info('Fetching notifications', { userId, limit, offset, unreadOnly });

    try {
        let query = supabaseAdmin
            .from('notifications')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

        if (unreadOnly === 'true') {
            query = query.eq('is_read', false);
        }

        const { data: notifications, error } = await query;

        if (error) {
            logger.error('Failed to fetch notifications', error);
            return res.status(500).json({ error: 'Failed to fetch notifications' });
        }

        // Get unread count
        const { count: unreadCount } = await supabaseAdmin
            .from('notifications')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('is_read', false);

        logger.success('Notifications fetched', {
            userId,
            count: notifications?.length || 0,
            unreadCount
        });

        res.json({
            notifications: notifications?.map(n => ({
                id: n.id,
                type: n.type,
                title: n.title,
                message: n.message,
                actionUrl: n.action_url,
                isRead: n.is_read,
                createdAt: n.created_at,
                metadata: n.metadata,
            })) || [],
            unreadCount: unreadCount || 0,
        });
    } catch (error) {
        logger.error('Get notifications error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Mark notification(s) as read
 * PUT /api/notifications/read
 */
router.put('/read', authenticate, async (req, res) => {
    const userId = req.user.id;
    const { notificationIds, markAll = false } = req.body;

    logger.info('Marking notifications as read', { userId, notificationIds, markAll });

    try {
        let query = supabaseAdmin
            .from('notifications')
            .update({ is_read: true })
            .eq('user_id', userId);

        if (!markAll && notificationIds && notificationIds.length > 0) {
            query = query.in('id', notificationIds);
        }

        const { error } = await query;

        if (error) {
            logger.error('Failed to mark notifications as read', error);
            return res.status(500).json({ error: 'Failed to update notifications' });
        }

        logger.success('Notifications marked as read', { userId, markAll });

        res.json({ success: true });
    } catch (error) {
        logger.error('Mark notifications read error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Get unread notification count
 * GET /api/notifications/count
 */
router.get('/count', authenticate, async (req, res) => {
    const userId = req.user.id;

    try {
        const { count, error } = await supabaseAdmin
            .from('notifications')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('is_read', false);

        if (error) {
            logger.error('Failed to get notification count', error);
            return res.status(500).json({ error: 'Failed to get count' });
        }

        res.json({ unreadCount: count || 0 });
    } catch (error) {
        logger.error('Get notification count error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Helper function to create a notification (used internally by other routes)
 * @param {string} userId - User ID
 * @param {object} notification - Notification data
 */
async function createNotification(userId, { type, title, message, actionUrl = null, metadata = {} }) {
    try {
        const { error } = await supabaseAdmin
            .from('notifications')
            .insert({
                user_id: userId,
                type,
                title,
                message,
                action_url: actionUrl,
                metadata,
            });

        if (error) {
            logger.error('Failed to create notification', error);
            return false;
        }

        logger.success('Notification created', { userId, type, title });
        return true;
    } catch (err) {
        logger.error('Create notification error', err);
        return false;
    }
}

// Export both router and helper function
module.exports = router;
module.exports.createNotification = createNotification;
