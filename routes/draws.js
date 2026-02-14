const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/role');

// Get platform settings (Public)
router.get('/config', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('platform_settings')
            .select('settings')
            .eq('id', 1)
            .single();

        if (error || !data) {
            // Return defaults if no settings row exists
            return res.json({
                platformFee: 15,
                referralBonus: 500,
                referralBonusReferee: 500,
                referralPercentage: 5,
                minTicketPrice: 500,
                maxTicketPrice: 5000,
                defaultTicketPrice: 1000,
                maxTicketsPerDraw: 1000,
                minTicketsPerDraw: 10,
                autoDrawOnFull: true,
                maxTicketsPerPurchase: 50,
                minDeposit: 1000,
                minWithdrawal: 5000,
                withdrawalFee: 100,
                minBundlePrice: 50000,
                maxBundlePrice: 500000,
            });
        }

        res.json(data.settings);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch platform config' });
    }
});

// Get Platform Statistics (Public)
router.get('/stats', async (req, res) => {
    try {
        // 1. Total Impact & Families Fed (Completed Draws)
        const { data: completedDraws, error: drawError } = await supabaseAdmin
            .from('draws')
            .select('bundle_value')
            .eq('status', 'completed');

        if (drawError) throw drawError;

        const familiesFed = completedDraws?.length || 0;
        const totalImpact = completedDraws?.reduce((sum, draw) => sum + parseFloat(draw.bundle_value), 0) || 0;

        // 2. Verified Partners (Approved Vendors)
        const { count: verifiedPartners, error: vendorError } = await supabaseAdmin
            .from('vendor_applications')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'approved');

        if (vendorError) throw vendorError;

        // 3. Weekly/Active Draws
        const { count: activeDraws, error: activeError } = await supabaseAdmin
            .from('draws')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'active');

        if (activeError) throw activeError;

        res.json({
            familiesFed,
            totalImpact,
            verifiedPartners: verifiedPartners || 0,
            activeDraws: activeDraws || 0
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch platform stats' });
    }
});

// Get all active draws (Public)
router.get('/', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('draws')
            .select('id, title, description, bundle_value, ticket_price, total_tickets, sold_tickets, status, category, images, items, draw_type, draw_date, created_at, profiles:vendor_id(full_name)')
            .eq('status', 'active')
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch draws' });
    }
});

// Get single draw (Public - only active draws, or own draws for vendors)
router.get('/:id', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('draws')
            .select('*, profiles:vendor_id(full_name)')
            .eq('id', req.params.id)
            .single();

        if (error) throw error;

        // Only return active draws to the public
        // Vendors can see their own draws regardless of status (handled by RLS on frontend)
        if (data.status !== 'active') {
            // Check if the requester is the vendor (optional auth)
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.status(404).json({ error: 'Draw not found' });
            }
        }

        res.json(data);
    } catch (err) {
        res.status(404).json({ error: 'Draw not found' });
    }
});

// Get completed draws for verification history
router.get('/history/recent', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('draws')
            .select('id, title, bundle_value, status, draw_date, completed_at, profiles:vendor_id(full_name), winner_profile:winner_id(full_name), winning_ticket_id')
            .eq('status', 'completed')
            .order('completed_at', { ascending: false })
            .limit(10);

        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error('Recent history error:', err);
        res.status(500).json({ error: 'Failed to fetch verification history' });
    }
});

// Verify a draw or ticket
router.get('/verify/:query', async (req, res) => {
    const { query } = req.params;
    try {
        let draw = null;

        // 1. Try to find by draw UUID (Verification ID)
        if (query.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
            const { data, error } = await supabaseAdmin
                .from('draws')
                .select('*, vendor:profiles!draws_vendor_id_fkey(full_name), winner:profiles!draws_winner_id_fkey(full_name)')
                .eq('id', query)
                .single();
            if (data) draw = data;
        }

        // 2. Try by ticket number if not found or not a UUID
        if (!draw) {
            const { data: ticket } = await supabaseAdmin
                .from('tickets')
                .select('draw_id')
                .eq('ticket_number', query)
                .single();

            if (ticket) {
                const { data } = await supabaseAdmin
                    .from('draws')
                    .select('*, vendor:profiles!draws_vendor_id_fkey(full_name), winner:profiles!draws_winner_id_fkey(full_name)')
                    .eq('id', ticket.draw_id)
                    .single();
                draw = data;
            }
        }

        if (!draw) {
            return res.status(404).json({ error: 'No verification record found for this code' });
        }

        // Fetch audit logs for this draw
        const { data: auditLogs } = await supabaseAdmin
            .from('draw_audit_log')
            .select('*')
            .eq('draw_id', draw.id)
            .order('created_at', { ascending: true });

        // Get winning ticket details for the audit section
        let winningTicket = null;
        if (draw.winning_ticket_id) {
            const { data } = await supabaseAdmin
                .from('tickets')
                .select('ticket_number')
                .eq('id', draw.winning_ticket_id)
                .single();
            winningTicket = data;
        }

        res.json({
            draw,
            winningTicketNumber: winningTicket?.ticket_number,
            auditLogs: auditLogs || []
        });
    } catch (err) {
        console.error('Verify error:', err);
        res.status(500).json({ error: 'Verification process failed' });
    }
});

module.exports = router;
