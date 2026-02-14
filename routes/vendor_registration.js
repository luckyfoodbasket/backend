const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/role');
const logger = require('../utils/logger');
const { createNotification } = require('./notifications');

/**
 * Submit vendor application
 * POST /api/vendor-applications
 */
router.post('/', authenticate, async (req, res) => {
    const userId = req.user.id;
    const { businessName, businessAddress, phone, idProofUrl } = req.body;

    if (!businessName || !businessAddress || !phone) {
        return res.status(400).json({ error: 'Missing required business details' });
    }

    try {
        // Check if user already has a pending application
        const { data: existingApp } = await supabaseAdmin
            .from('vendor_applications')
            .select('status')
            .eq('user_id', userId)
            .single();

        if (existingApp) {
            if (existingApp.status === 'pending') {
                return res.status(400).json({ error: 'You already have a pending application' });
            } else if (existingApp.status === 'approved') {
                return res.status(400).json({ error: 'You are already a registered vendor' });
            }
        }

        // Create application
        const { data, error } = await supabaseAdmin
            .from('vendor_applications')
            .insert({
                user_id: userId,
                business_name: businessName,
                business_address: businessAddress,
                phone: phone,
                id_proof_url: idProofUrl,
                status: 'pending'
            })
            .select()
            .single();

        if (error) throw error;

        // Notify user
        await createNotification(userId, {
            type: 'system',
            title: 'Application Received! 🏪',
            message: 'Your wholesaler application has been received and is under review. We will notify you once approved.',
            actionUrl: '/dashboard'
        });

        res.status(201).json({
            success: true,
            message: 'Application submitted successfully',
            application: data
        });

    } catch (err) {
        logger.error('Vendor application submission error', err);
        res.status(500).json({ error: 'Failed to submit application' });
    }
});

/**
 * Get current user's application status
 * GET /api/vendor-applications/status
 */
router.get('/status', authenticate, async (req, res) => {
    const userId = req.user.id;
    try {
        const { data, error } = await supabaseAdmin
            .from('vendor_applications')
            .select('*')
            .eq('user_id', userId)
            .single();

        if (error && error.code !== 'PGRST116') throw error;

        res.json({ application: data || null });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch status' });
    }
});

/**
 * Update vendor business info
 * PUT /api/vendor-applications/my
 */
router.put('/my', authenticate, authorize(['vendor']), async (req, res) => {
    const userId = req.user.id;
    const { businessName, businessAddress, phone } = req.body;

    try {
        const { data, error } = await supabaseAdmin
            .from('vendor_applications')
            .update({
                business_name: businessName,
                business_address: businessAddress,
                phone: phone,
                updated_at: new Date().toISOString()
            })
            .eq('user_id', userId)
            .select()
            .single();

        if (error) throw error;

        res.json({
            success: true,
            message: 'Business information updated successfully',
            application: data
        });
    } catch (err) {
        logger.error('Update vendor info error', err);
        res.status(500).json({ error: 'Failed to update business information' });
    }
});

/**
 * ADMIN: Get all applications
 * GET /api/vendor-applications/admin/list
 */
router.get('/admin/list', authenticate, authorize(['admin']), async (req, res) => {
    try {
        logger.info('Admin fetching vendor applications', { userId: req.user?.id, role: req.role });

        const { data, error } = await supabaseAdmin
            .from('vendor_applications')
            .select('*, profiles:user_id(full_name, email)')
            .order('created_at', { ascending: false });

        if (error) {
            logger.error('Supabase error fetching applications', error);
            throw error;
        }

        logger.info(`Successfully fetched ${data?.length || 0} applications`);
        res.json(data);
    } catch (err) {
        logger.error('Failed to fetch vendor applications', err);
        res.status(500).json({ error: 'Failed to fetch applications' });
    }
});

/**
 * ADMIN: Approve/Reject application
 * PUT /api/vendor-applications/admin/:id/review
 */
router.put('/admin/:id/review', authenticate, authorize(['admin']), async (req, res) => {
    const { id } = req.params;
    const { status, reason } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }

    try {
        const { data: application, error: appError } = await supabaseAdmin
            .from('vendor_applications')
            .update({ status, rejection_reason: reason, updated_at: new Date().toISOString() })
            .eq('id', id)
            .select()
            .single();

        if (appError) throw appError;

        if (status === 'approved') {
            // Update user role to vendor
            await supabaseAdmin
                .from('profiles')
                .update({ role: 'vendor' })
                .eq('id', application.user_id);

            // Notify user
            await createNotification(application.user_id, {
                type: 'system',
                title: 'Application Approved! 🎊',
                message: 'Congratulations! You are now a verified wholesaler on LuckyBasket. You can start uploading bundles.',
                actionUrl: '/vendor'
            });
        } else {
            // Notify user of rejection
            await createNotification(application.user_id, {
                type: 'system',
                title: 'Application Update',
                message: `Your wholesaler application was not approved. Reason: ${reason || 'Incomplete details'}`,
                actionUrl: '/vendor/register'
            });
        }

        res.json({ success: true, application });
    } catch (err) {
        logger.error('Vendor application review error', err);
        res.status(500).json({ error: 'Failed to review application' });
    }
});

module.exports = router;
