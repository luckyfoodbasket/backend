const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/role');
const logger = require('../utils/logger');

// All vendor routes require authentication + vendor role
router.use(authenticate);
router.use(authorize(['vendor', 'admin']));

/**
 * Get vendor dashboard stats
 * GET /api/vendor/stats
 */
router.get('/stats', async (req, res) => {
    const vendorId = req.user.id;

    try {
        // Get platform settings for fee calculation
        const { data: settingsRow } = await supabaseAdmin
            .from('platform_settings')
            .select('settings')
            .eq('id', 1)
            .single();

        const platformFee = settingsRow?.settings?.platformFee || 15;

        // 1. Get all draws for this vendor
        const { data: draws, error: drawsError } = await supabaseAdmin
            .from('draws')
            .select('*')
            .eq('vendor_id', vendorId);

        if (drawsError) throw drawsError;

        // 2. Get vendor wallet for actual balance
        const { data: wallet, error: walletError } = await supabaseAdmin
            .from('wallets')
            .select('vendor_balance')
            .eq('user_id', vendorId)
            .single();

        if (walletError && walletError.code !== 'PGRST116') throw walletError;

        // 3. Get unique customers
        const drawIds = draws.map(d => d.id);
        let customerCount = 0;
        if (drawIds.length > 0) {
            const { data: uniqueUsers } = await supabaseAdmin
                .from('tickets')
                .select('user_id')
                .in('draw_id', drawIds);

            customerCount = new Set(uniqueUsers?.map(u => u.user_id)).size;
        }

        // 4. Calculate stats
        const activeBundles = draws.filter(d => d.status === 'active').length;
        const completedBundles = draws.filter(d => d.status === 'completed').length;

        // Use the actual vendor_balance from the wallet table
        const totalEarnings = wallet?.vendor_balance || 0;

        // Average bundle price (only for active/completed draws)
        const relevantDraws = draws.filter(d => ['active', 'completed'].includes(d.status));
        const avgBundlePrice = relevantDraws.length > 0
            ? relevantDraws.reduce((acc, d) => acc + (d.bundle_value || 0), 0) / relevantDraws.length
            : 0;

        res.json({
            stats: {
                totalRevenue: totalEarnings,
                activeBundles,
                completedBundles,
                customers: customerCount,
                avgBundlePrice,
                platformFee
            }
        });

    } catch (error) {
        logger.error('Vendor stats error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Get vendor's draws/bundles
 * GET /api/vendor/bundles
 */
router.get('/bundles', async (req, res) => {
    const vendorId = req.user.id;
    const { status, limit = 20, offset = 0 } = req.query;

    try {
        let query = supabaseAdmin
            .from('draws')
            .select('*')
            .eq('vendor_id', vendorId)
            .order('created_at', { ascending: false })
            .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

        if (status && status !== 'all') {
            query = query.eq('status', status);
        }

        const { data, error } = await query;

        if (error) throw error;

        res.json({ bundles: data });
    } catch (error) {
        logger.error('Vendor bundles error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Get vendor's customers
 * GET /api/vendor/customers
 */
router.get('/customers', async (req, res) => {
    const vendorId = req.user.id;

    try {
        // 1. Get all draws for this vendor
        const { data: draws } = await supabaseAdmin
            .from('draws')
            .select('id')
            .eq('vendor_id', vendorId);

        const drawIds = (draws || []).map(d => d.id);
        if (drawIds.length === 0) {
            return res.json({ customers: [] });
        }

        // 2. Get unique users from tickets for these draws
        const { data: tickets, error } = await supabaseAdmin
            .from('tickets')
            .select('user_id, profiles:user_id(full_name, email, phone)')
            .in('draw_id', drawIds);

        if (error) throw error;

        // Group by user_id to get unique customers and their purchase counts
        const customerMap = new Map();
        (tickets || []).forEach(t => {
            if (!customerMap.has(t.user_id)) {
                customerMap.set(t.user_id, {
                    id: t.user_id,
                    name: t.profiles?.full_name || 'Anonymous',
                    email: t.profiles?.email || '-',
                    phone: t.profiles?.phone || '-',
                    purchaseCount: 0
                });
            }
            customerMap.get(t.user_id).purchaseCount++;
        });

        res.json({ customers: Array.from(customerMap.values()) });

    } catch (error) {
        logger.error('Vendor customers error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
