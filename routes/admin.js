const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/role');
const logger = require('../utils/logger');
const { createNotification } = require('./notifications');
const { initiateTransfer } = require('../services/flutterwave');
const { sendEmail } = require('../services/email');

// All admin routes require authentication + admin role
router.use(authenticate);
router.use(authorize(['admin']));

/**
 * Get all withdrawal requests
 * GET /api/admin/withdrawals
 */
router.get('/withdrawals', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('withdrawal_requests')
            .select('*, profiles:vendor_id(full_name, email), draws:draw_id(title, status, is_delivered)')
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (error) {
        logger.error('Admin fetch withdrawals error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Approve withdrawal request
 * POST /api/admin/withdrawals/:id/approve
 */
router.post('/withdrawals/:id/approve', async (req, res) => {
    const { id } = req.params;
    const adminId = req.user.id;

    try {
        // 1. Get request details
        const { data: request, error: fetchError } = await supabaseAdmin
            .from('withdrawal_requests')
            .select('*, draws:draw_id(title, is_delivered)')
            .eq('id', id)
            .single();

        if (fetchError || !request) {
            return res.status(404).json({ error: 'Withdrawal request not found' });
        }

        if (request.status !== 'pending') {
            return res.status(400).json({ error: `Request is already ${request.status}` });
        }

        // 2. CHECK CONDITION: Bundle must be delivered if linked
        if (request.draw_id && !request.draws?.is_delivered) {
            return res.status(400).json({
                error: 'Cannot approve withdrawal',
                details: 'This bundle has not been marked as delivered to the winner yet.'
            });
        }

        // 3. Initiate Flutterwave Transfer
        logger.info('Admin approving withdrawal, initiating transfer', { id, amount: request.amount });

        const result = await initiateTransfer({
            account_bank: request.bank_code,
            account_number: request.account_number,
            amount: request.amount,
            narration: `LuckyBasket Wholesaler Payout - ${request.id}`,
            reference: `LB_PAYOUT_${request.id.substring(0, 8)}`,
        });

        if (!result.success) {
            logger.error('Flutterwave payout failed', result.error);
            return res.status(500).json({ error: result.error || 'Failed to initiate transfer via Flutterwave' });
        }

        // 4. Update request status
        await supabaseAdmin
            .from('withdrawal_requests')
            .update({
                status: 'approved',
                processed_at: new Date().toISOString(),
                processed_by: adminId,
                admin_notes: `Processed by admin. FLW ID: ${result.data?.id}`
            })
            .eq('id', id);

        // 5. Update transaction status
        if (request.transaction_id) {
            await supabaseAdmin
                .from('transactions')
                .update({
                    status: 'completed',
                    completed_at: new Date().toISOString(),
                    external_reference: String(result.data?.id || ''),
                })
                .eq('id', request.transaction_id);
        }

        // 6. Notify vendor
        await createNotification(request.vendor_id, {
            type: 'wallet',
            title: 'Withdrawal Approved! 💸',
            message: `Your withdrawal of ₦${request.amount.toLocaleString()} has been approved and processed.`,
            actionUrl: '/vendor/payouts'
        });

        res.json({ success: true, message: 'Withdrawal approved and transfer initiated' });
    } catch (error) {
        logger.error('Admin approve withdrawal error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Reject withdrawal request
 * POST /api/admin/withdrawals/:id/reject
 */
router.post('/withdrawals/:id/reject', async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    const adminId = req.user.id;

    try {
        const { data: request } = await supabaseAdmin
            .from('withdrawal_requests')
            .select('*')
            .eq('id', id)
            .single();

        if (!request || (request.status !== 'pending' && request.status !== 'failed')) {
            return res.status(400).json({ error: 'Invalid request or already processed' });
        }

        // 1. Update request status
        await supabaseAdmin
            .from('withdrawal_requests')
            .update({
                status: 'rejected',
                processed_at: new Date().toISOString(),
                processed_by: adminId,
                admin_notes: reason || 'Rejected by admin review.'
            })
            .eq('id', id);

        // 2. REFUND Vendor Wallet
        const { data: wallet, error: walletError } = await supabaseAdmin
            .from('wallets')
            .select('vendor_balance')
            .eq('user_id', request.vendor_id)
            .single();

        if (walletError || !wallet) {
            logger.error('Failed to fetch wallet for refund', walletError);
            return res.status(404).json({ error: 'Vendor wallet not found for refund' });
        }

        const refundAmount = Number(request.amount);

        // Fetch fee from transaction
        const { data: tx } = await supabaseAdmin
            .from('transactions')
            .select('metadata')
            .eq('id', request.transaction_id)
            .single();

        const totalRefund = refundAmount + (tx?.metadata?.fee || 0);

        const { error: refundError } = await supabaseAdmin
            .from('wallets')
            .update({ vendor_balance: Number(wallet.vendor_balance) + totalRefund })
            .eq('user_id', request.vendor_id);

        if (refundError) {
            logger.error('Failed to process refund update', refundError);
            return res.status(500).json({ error: 'Failed to refund funds' });
        }

        // 3. Mark transaction as failed
        await supabaseAdmin
            .from('transactions')
            .update({
                status: 'failed',
                description: `Rejected: ${reason || 'Admin review'}. Refunded to balance.`,
                metadata: { ...tx?.metadata, rejection_reason: reason }
            })
            .eq('id', request.transaction_id);

        // 4. Notify vendor
        await createNotification(request.vendor_id, {
            type: 'wallet',
            title: 'Withdrawal Rejected',
            message: `Your withdrawal request was not approved. Reason: ${reason || 'Please contact support.'}`,
            actionUrl: '/vendor/payouts'
        });

        res.json({ success: true, message: 'Withdrawal rejected and funds refunded' });
    } catch (error) {
        logger.error('Admin reject withdrawal error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Retry failed withdrawal request
 * POST /api/admin/withdrawals/:id/retry
 */
router.post('/withdrawals/:id/retry', async (req, res) => {
    const { id } = req.params;
    const adminId = req.user.id;

    try {
        // 1. Get request details
        const { data: request, error: fetchError } = await supabaseAdmin
            .from('withdrawal_requests')
            .select('*, draws:draw_id(title, is_delivered)')
            .eq('id', id)
            .single();

        if (fetchError || !request) {
            return res.status(404).json({ error: 'Withdrawal request not found' });
        }

        if (request.status !== 'failed') {
            return res.status(400).json({ error: 'Only failed requests can be retried' });
        }

        // 2. Initiate Flutterwave Transfer (new reference to avoid FLW duplicates)
        logger.info('Admin retrying withdrawal', { id, amount: request.amount });

        const result = await initiateTransfer({
            account_bank: request.bank_code,
            account_number: request.account_number,
            amount: request.amount,
            narration: `LuckyBasket Wholesaler Payout (Retry) - ${request.id}`,
            reference: `LB_RETRY_${request.id.substring(0, 8)}_${Date.now().toString().slice(-6)}`,
        });

        if (!result.success) {
            logger.error('Flutterwave retry payout failed', result.error);
            return res.status(500).json({ error: result.error || 'Failed to retry transfer via Flutterwave' });
        }

        // 3. Update request status
        await supabaseAdmin
            .from('withdrawal_requests')
            .update({
                status: 'approved',
                processed_at: new Date().toISOString(),
                processed_by: adminId,
                admin_notes: `Retry attempt by admin. FLW ID: ${result.data?.id}`
            })
            .eq('id', id);

        // 4. Update transaction status
        if (request.transaction_id) {
            await supabaseAdmin
                .from('transactions')
                .update({
                    status: 'pending', // Set back to pending until webhook confirms
                    external_reference: String(result.data?.id || ''),
                    // Update reference in transaction to match retry reference? 
                    // Better to keep original or update it so webhook finds it
                    reference: `LB_RETRY_${request.id.substring(0, 8)}_${Date.now().toString().slice(-6)}`,
                })
                .eq('id', request.transaction_id);
        }

        res.json({ success: true, message: 'Withdrawal retry initiated' });
    } catch (error) {
        logger.error('Admin retry withdrawal error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Update bundle delivery status
 * PUT /api/admin/bundles/:id/delivery
 */
router.put('/bundles/:id/delivery', async (req, res) => {
    const { id } = req.params;
    const { is_delivered, proof_url } = req.body;

    try {
        const { data, error } = await supabaseAdmin
            .from('draws')
            .update({
                is_delivered,
                delivery_proof_url: proof_url,
                delivered_at: is_delivered ? new Date().toISOString() : null
            })
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        // If delivered, notify winner
        if (is_delivered && data.winner_id) {
            await createNotification(data.winner_id, {
                type: 'win',
                title: 'Bundle Delivered! 🎁',
                message: `The bundle for "${data.title}" has been marked as delivered. Enjoy!`,
                actionUrl: '/dashboard'
            });
        }

        res.json({ success: true, bundle: data });
    } catch (error) {
        logger.error('Update delivery status error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Get all bundles/draws with vendor info
 * GET /api/admin/bundles?status=pending_review&search=keyword&limit=20&offset=0
 */
router.get('/bundles', async (req, res) => {
    const { status, search, limit = 50, offset = 0 } = req.query;

    try {
        let query = supabaseAdmin
            .from('draws')
            .select('*, profiles:vendor_id(full_name, email)')
            .order('created_at', { ascending: false })
            .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

        if (status && status !== 'all') {
            query = query.eq('status', status);
        }

        if (search) {
            query = query.ilike('title', `%${search}%`);
        }

        const { data, error } = await query;

        if (error) {
            logger.error('Failed to fetch bundles', error);
            return res.status(500).json({ error: 'Failed to fetch bundles' });
        }

        // Also get counts per status
        const { data: allDraws } = await supabaseAdmin
            .from('draws')
            .select('status');

        const counts = {
            total: allDraws?.length || 0,
            pending_review: allDraws?.filter(d => d.status === 'pending_review').length || 0,
            active: allDraws?.filter(d => d.status === 'active').length || 0,
            rejected: allDraws?.filter(d => d.status === 'rejected').length || 0,
            completed: allDraws?.filter(d => d.status === 'completed').length || 0,
        };

        res.json({ bundles: data, counts });
    } catch (error) {
        logger.error('Get admin bundles error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Get single bundle details
 * GET /api/admin/bundles/:id
 */
router.get('/bundles/:id', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('draws')
            .select('*, profiles:vendor_id(full_name, email, phone)')
            .eq('id', req.params.id)
            .single();

        if (error) {
            logger.error('Failed to fetch bundle', error);
            return res.status(404).json({ error: 'Bundle not found' });
        }

        res.json(data);
    } catch (error) {
        logger.error('Get admin bundle error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Approve a bundle - sets draw configuration and status to active
 * POST /api/admin/bundles/:id/approve
 */
router.post('/bundles/:id/approve', async (req, res) => {
    const adminId = req.user.id;
    const { total_tickets, ticket_price, draw_type, draw_date, admin_notes } = req.body;

    logger.info('Bundle approval request', { bundleId: req.params.id, adminId });

    try {
        if (!total_tickets || !ticket_price) {
            return res.status(400).json({ error: 'total_tickets and ticket_price are required' });
        }

        // Fetch platform settings for validation
        const { data: settingsRow } = await supabaseAdmin
            .from('platform_settings')
            .select('settings')
            .eq('id', 1)
            .single();

        const config = settingsRow?.settings || {
            minTicketsPerDraw: 10,
            maxTicketsPerDraw: 10000,
            minTicketPrice: 100,
            maxTicketPrice: 50000
        };

        if (total_tickets < config.minTicketsPerDraw || total_tickets > config.maxTicketsPerDraw) {
            return res.status(400).json({ error: `Total tickets must be between ${config.minTicketsPerDraw} and ${config.maxTicketsPerDraw.toLocaleString()}` });
        }

        if (ticket_price < config.minTicketPrice || ticket_price > config.maxTicketPrice) {
            return res.status(400).json({ error: `Ticket price must be between ₦${config.minTicketPrice.toLocaleString()} and ₦${config.maxTicketPrice.toLocaleString()}` });
        }

        if (draw_type && !['slot_complete', 'timer'].includes(draw_type)) {
            return res.status(400).json({ error: 'draw_type must be slot_complete or timer' });
        }

        if (draw_type === 'timer' && !draw_date) {
            return res.status(400).json({ error: 'draw_date is required for timer-based draws' });
        }

        // Verify the bundle exists and is pending_review
        const { data: draw, error: fetchError } = await supabaseAdmin
            .from('draws')
            .select('id, status, vendor_id, title')
            .eq('id', req.params.id)
            .single();

        if (fetchError || !draw) {
            return res.status(404).json({ error: 'Bundle not found' });
        }

        if (draw.status !== 'pending_review') {
            return res.status(400).json({ error: `Cannot approve a bundle with status: ${draw.status}` });
        }

        // Update the draw
        const { error: updateError } = await supabaseAdmin
            .from('draws')
            .update({
                total_tickets: parseInt(total_tickets),
                ticket_price: parseFloat(ticket_price),
                draw_type: draw_type || 'slot_complete',
                draw_date: draw_date || null,
                admin_notes: admin_notes || null,
                status: 'active',
                reviewed_at: new Date().toISOString(),
                reviewed_by: adminId,
            })
            .eq('id', req.params.id);

        if (updateError) {
            logger.error('Failed to approve bundle', updateError);
            return res.status(500).json({ error: 'Failed to approve bundle' });
        }

        // Notify vendor
        await createNotification(draw.vendor_id, {
            type: 'draw',
            title: 'Bundle Approved!',
            message: `Your bundle "${draw.title}" has been approved and is now live.`,
            actionUrl: `/vendor/bundles/${draw.id}`,
        });

        logger.success('Bundle approved', { bundleId: req.params.id, adminId });

        res.json({ success: true, message: 'Bundle approved and is now active' });
    } catch (error) {
        logger.error('Approve bundle error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Reject a bundle
 * POST /api/admin/bundles/:id/reject
 */
router.post('/bundles/:id/reject', async (req, res) => {
    const adminId = req.user.id;
    const { rejection_reason } = req.body;

    logger.info('Bundle rejection request', { bundleId: req.params.id, adminId });

    try {
        if (!rejection_reason || !rejection_reason.trim()) {
            return res.status(400).json({ error: 'Rejection reason is required' });
        }

        // Verify the bundle exists and is pending_review
        const { data: draw, error: fetchError } = await supabaseAdmin
            .from('draws')
            .select('id, status, vendor_id, title')
            .eq('id', req.params.id)
            .single();

        if (fetchError || !draw) {
            return res.status(404).json({ error: 'Bundle not found' });
        }

        if (draw.status !== 'pending_review') {
            return res.status(400).json({ error: `Cannot reject a bundle with status: ${draw.status}` });
        }

        // Update the draw
        const { error: updateError } = await supabaseAdmin
            .from('draws')
            .update({
                status: 'rejected',
                rejection_reason: rejection_reason.trim(),
                reviewed_at: new Date().toISOString(),
                reviewed_by: adminId,
            })
            .eq('id', req.params.id);

        if (updateError) {
            logger.error('Failed to reject bundle', updateError);
            return res.status(500).json({ error: 'Failed to reject bundle' });
        }

        // Notify vendor
        await createNotification(draw.vendor_id, {
            type: 'draw',
            title: 'Bundle Rejected',
            message: `Your bundle "${draw.title}" was not approved. Reason: ${rejection_reason.trim()}`,
            actionUrl: `/vendor/bundles/${draw.id}`,
        });

        logger.success('Bundle rejected', { bundleId: req.params.id, adminId });

        res.json({ success: true, message: 'Bundle rejected' });
    } catch (error) {
        logger.error('Reject bundle error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Update bundle delivery status
 * PUT /api/admin/bundles/:id/delivery
 */
router.put('/bundles/:id/delivery', async (req, res) => {
    const { id } = req.params;
    const { is_delivered } = req.body;
    const adminId = req.user.id;

    try {
        const { data: draw, error: fetchError } = await supabaseAdmin
            .from('draws')
            .select('id, title, vendor_id')
            .eq('id', id)
            .single();

        if (fetchError || !draw) {
            return res.status(404).json({ error: 'Bundle not found' });
        }

        const { error: updateError } = await supabaseAdmin
            .from('draws')
            .update({
                is_delivered: !!is_delivered,
                delivered_at: is_delivered ? new Date().toISOString() : null,
                updated_at: new Date().toISOString()
            })
            .eq('id', id);

        if (updateError) throw updateError;

        logger.success(`Bundle delivery status updated`, { id, is_delivered, adminId });

        // Notify vendor if marked as delivered
        if (is_delivered) {
            await createNotification(draw.vendor_id, {
                type: 'draw',
                title: 'Bundle Marked as Delivered! 🚚',
                message: `Your bundle "${draw.title}" has been marked as delivered. You can now request your payout.`,
                actionUrl: '/vendor/payouts'
            });
        }

        res.json({ success: true, message: 'Delivery status updated' });
    } catch (error) {
        logger.error('Update delivery status error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Toggle featured status of a bundle
 * POST /api/admin/bundles/:id/toggle-featured
 */
router.post('/bundles/:id/toggle-featured', async (req, res) => {
    const { is_featured } = req.body;

    try {
        const { error } = await supabaseAdmin
            .from('draws')
            .update({ is_featured: !!is_featured })
            .eq('id', req.params.id);

        if (error) {
            logger.error('Failed to toggle featured status', error);
            return res.status(500).json({ error: 'Failed to update featured status' });
        }

        res.json({ success: true, is_featured: !!is_featured });
    } catch (error) {
        logger.error('Toggle featured error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Update bundle details (generic update)
 * PATCH /api/admin/bundles/:id
 */
router.patch('/bundles/:id', async (req, res) => {
    const updates = req.body;
    const adminId = req.user.id;

    try {
        // Fetch platform settings for validation
        const { data: settingsRow } = await supabaseAdmin
            .from('platform_settings')
            .select('settings')
            .eq('id', 1)
            .single();

        const config = settingsRow?.settings || {
            minTicketsPerDraw: 10,
            maxTicketsPerDraw: 10000,
            minTicketPrice: 100,
            maxTicketPrice: 50000
        };

        // Validate some fields if present
        if (updates.total_tickets && (updates.total_tickets < config.minTicketsPerDraw || updates.total_tickets > config.maxTicketsPerDraw)) {
            return res.status(400).json({ error: `Total tickets must be between ${config.minTicketsPerDraw} and ${config.maxTicketsPerDraw.toLocaleString()}` });
        }

        if (updates.ticket_price && (updates.ticket_price < config.minTicketPrice || updates.ticket_price > config.maxTicketPrice)) {
            return res.status(400).json({ error: `Ticket price must be between ₦${config.minTicketPrice.toLocaleString()} and ₦${config.maxTicketPrice.toLocaleString()}` });
        }

        // Remove sensitive fields that shouldn't be patched directly
        const {
            id,
            vendor_id,
            sold_tickets,
            created_at,
            title,
            description,
            category,
            bundle_value,
            images,
            items,
            ...allowedUpdates
        } = updates;

        const { error } = await supabaseAdmin
            .from('draws')
            .update({
                ...allowedUpdates,
                updated_at: new Date().toISOString(),
                reviewed_by: adminId // Track who last edited it
            })
            .eq('id', req.params.id);

        if (error) {
            logger.error('Failed to update bundle', error);
            return res.status(500).json({ error: 'Failed to update bundle' });
        }

        res.json({ success: true, message: 'Bundle updated successfully' });
    } catch (error) {
        logger.error('Update bundle error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================================
// DASHBOARD & USER MANAGEMENT ENDPOINTS
// ============================================================

/**
 * Get dashboard stats (aggregated from multiple tables)
 * GET /api/admin/stats
 */
router.get('/stats', async (req, res) => {
    try {
        // Run all queries in parallel for speed
        const [
            usersRes,
            vendorsRes,
            drawsRes,
            revenueRes,
            payoutRes,
            ticketsSoldRes,
            pendingVendorsRes,
            recentUsersRes,
            recentDrawsRes,
            recentTransactionsRes,
        ] = await Promise.all([
            supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'user'),
            supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'vendor'),
            supabaseAdmin.from('draws').select('status'),
            supabaseAdmin.from('transactions').select('amount').eq('type', 'purchase').eq('status', 'completed'),
            supabaseAdmin.from('transactions').select('amount').eq('type', 'payout').eq('status', 'completed'),
            supabaseAdmin.from('draws').select('sold_tickets').in('status', ['active', 'completed']),
            supabaseAdmin.from('vendor_applications').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
            supabaseAdmin.from('profiles').select('id, full_name, email, role, created_at').order('created_at', { ascending: false }).limit(5),
            supabaseAdmin.from('draws').select('id, title, status, vendor_id, created_at, profiles:vendor_id(full_name)').order('created_at', { ascending: false }).limit(5),
            supabaseAdmin.from('transactions').select('id, user_id, type, amount, status, description, created_at, profiles:user_id(full_name)').eq('status', 'completed').order('created_at', { ascending: false }).limit(5),
        ]);

        const drawStatuses = drawsRes.data || [];
        const totalRevenue = (revenueRes.data || []).reduce((sum, t) => sum + Number(t.amount), 0);
        const totalPayouts = (payoutRes.data || []).reduce((sum, t) => sum + Number(t.amount), 0);
        const totalProfit = totalRevenue - totalPayouts;
        const totalTicketsSold = (ticketsSoldRes.data || []).reduce((sum, d) => sum + (d.sold_tickets || 0), 0);

        // Build recent activity from real data
        const recentActivity = [];

        for (const u of (recentUsersRes.data || [])) {
            recentActivity.push({
                id: u.id,
                type: 'user',
                title: 'New user registered',
                description: u.full_name || u.email,
                time: u.created_at,
                status: 'success',
            });
        }

        for (const d of (recentDrawsRes.data || [])) {
            recentActivity.push({
                id: d.id,
                type: d.status === 'pending_review' ? 'bundle' : 'draw',
                title: d.status === 'pending_review' ? 'Bundle submitted for review' : d.status === 'completed' ? 'Draw completed' : 'Draw created',
                description: `${d.title} by ${d.profiles?.full_name || 'Vendor'}`,
                time: d.created_at,
                status: d.status === 'pending_review' ? 'pending' : 'success',
            });
        }

        for (const t of (recentTransactionsRes.data || [])) {
            if (t.type === 'purchase') {
                recentActivity.push({
                    id: t.id,
                    type: 'payment',
                    title: 'Ticket purchase',
                    description: `${t.profiles?.full_name || 'User'} spent ₦${Number(t.amount).toLocaleString()}`,
                    time: t.created_at,
                    status: 'success',
                });
            }
        }

        // Sort by time descending, take top 10
        recentActivity.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

        res.json({
            totalUsers: usersRes.count || 0,
            totalVendors: vendorsRes.count || 0,
            activeDraws: drawStatuses.filter(d => d.status === 'active').length,
            completedDraws: drawStatuses.filter(d => d.status === 'completed').length,
            pendingBundles: drawStatuses.filter(d => d.status === 'pending_review').length,
            pendingVendors: pendingVendorsRes.count || 0,
            totalRevenue,
            totalPayouts,
            totalProfit,
            totalTicketsSold,
            recentActivity: recentActivity.slice(0, 10),
        });
    } catch (error) {
        logger.error('Get admin stats error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Get paginated users list with wallet balance
 * GET /api/admin/users?search=&role=&verified=&sort=created_at&order=desc&limit=20&offset=0
 */
router.get('/users', async (req, res) => {
    const { search, role, verified, sort = 'created_at', order = 'desc', limit = 20, offset = 0 } = req.query;

    try {
        // Build profiles query
        let query = supabaseAdmin
            .from('profiles')
            .select('*, wallets(balance, is_locked)', { count: 'exact' })
            .neq('role', 'admin');

        if (role && role !== 'all') {
            query = query.eq('role', role);
        }

        if (verified === 'true') {
            query = query.eq('is_verified', true);
        } else if (verified === 'false') {
            query = query.eq('is_verified', false);
        }

        if (search) {
            query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%`);
        }

        // Sorting
        const sortField = ['created_at', 'full_name', 'email'].includes(sort) ? sort : 'created_at';
        query = query.order(sortField, { ascending: order === 'asc' });

        // Pagination
        const lim = Math.min(parseInt(limit) || 20, 100);
        const off = parseInt(offset) || 0;
        query = query.range(off, off + lim - 1);

        const { data, error, count } = await query;

        if (error) {
            logger.error('Failed to fetch users', error);
            return res.status(500).json({ error: 'Failed to fetch users' });
        }

        // Flatten wallet data
        const users = (data || []).map(user => {
            const wallet = Array.isArray(user.wallets) ? user.wallets[0] : user.wallets;
            return {
                id: user.id,
                email: user.email,
                full_name: user.full_name,
                phone: user.phone,
                role: user.role,
                is_verified: user.is_verified,
                referral_code: user.referral_code,
                created_at: user.created_at,
                wallet_balance: wallet ? Number(wallet.balance) : 0,
                is_wallet_locked: wallet ? wallet.is_locked : false,
            };
        });

        // Get summary stats for the header
        const { count: totalCount } = await supabaseAdmin
            .from('profiles')
            .select('id', { count: 'exact', head: true })
            .neq('role', 'admin');

        const { count: verifiedCount } = await supabaseAdmin
            .from('profiles')
            .select('id', { count: 'exact', head: true })
            .neq('role', 'admin')
            .eq('is_verified', true);

        res.json({
            users,
            total: count || 0,
            stats: {
                totalUsers: totalCount || 0,
                verifiedUsers: verifiedCount || 0,
            },
        });
    } catch (error) {
        logger.error('Get admin users error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Get single user details with ticket/transaction stats
 * GET /api/admin/users/:id
 */
router.get('/users/:id', async (req, res) => {
    try {
        // Fetch profile + wallet
        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('*, wallets(balance, is_locked, created_at)')
            .eq('id', req.params.id)
            .single();

        if (profileError || !profile) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Fetch stats in parallel
        const [ticketsRes, winsRes, transactionsRes] = await Promise.all([
            supabaseAdmin.from('tickets').select('id', { count: 'exact', head: true }).eq('user_id', req.params.id),
            supabaseAdmin.from('tickets').select('id', { count: 'exact', head: true }).eq('user_id', req.params.id).eq('is_winner', true),
            supabaseAdmin.from('transactions').select('type, amount, status').eq('user_id', req.params.id).eq('status', 'completed'),
        ]);

        const transactions = transactionsRes.data || [];
        const totalDeposited = transactions.filter(t => t.type === 'topup').reduce((sum, t) => sum + Number(t.amount), 0);
        const totalSpent = transactions.filter(t => t.type === 'purchase').reduce((sum, t) => sum + Number(t.amount), 0);
        const totalBonuses = transactions.filter(t => t.type === 'bonus').reduce((sum, t) => sum + Number(t.amount), 0);

        const wallet = Array.isArray(profile.wallets) ? profile.wallets[0] : profile.wallets;

        res.json({
            id: profile.id,
            email: profile.email,
            full_name: profile.full_name,
            phone: profile.phone,
            role: profile.role,
            is_verified: profile.is_verified,
            referral_code: profile.referral_code,
            referred_by: profile.referred_by,
            created_at: profile.created_at,
            wallet_balance: wallet ? Number(wallet.balance) : 0,
            is_wallet_locked: wallet ? wallet.is_locked : false,
            tickets_purchased: ticketsRes.count || 0,
            wins: winsRes.count || 0,
            total_deposited: totalDeposited,
            total_spent: totalSpent,
            total_bonuses: totalBonuses,
        });
    } catch (error) {
        logger.error('Get user details error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Toggle user status (verify/unverify, lock/unlock wallet)
 * POST /api/admin/users/:id/toggle-status
 */
router.post('/users/:id/toggle-status', async (req, res) => {
    const { action } = req.body;
    const adminId = req.user.id;

    try {
        if (!['verify', 'unverify', 'lock_wallet', 'unlock_wallet'].includes(action)) {
            return res.status(400).json({ error: 'Invalid action. Must be: verify, unverify, lock_wallet, unlock_wallet' });
        }

        if (action === 'verify' || action === 'unverify') {
            const { error } = await supabaseAdmin
                .from('profiles')
                .update({ is_verified: action === 'verify' })
                .eq('id', req.params.id);

            if (error) {
                logger.error('Failed to update user verification', error);
                return res.status(500).json({ error: 'Failed to update user' });
            }
        }

        if (action === 'lock_wallet' || action === 'unlock_wallet') {
            const isLocking = action === 'lock_wallet';
            const { error } = await supabaseAdmin
                .from('wallets')
                .update({
                    is_locked: isLocking,
                    lock_reason: isLocking ? `Locked by admin ${adminId}` : null,
                })
                .eq('user_id', req.params.id);

            if (error) {
                logger.error('Failed to update wallet lock status', error);
                return res.status(500).json({ error: 'Failed to update wallet' });
            }
        }

        logger.success(`User ${req.params.id} action: ${action}`, { adminId });
        res.json({ success: true, action });
    } catch (error) {
        logger.error('Toggle user status error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Send message to user (Notification + Email)
 * POST /api/admin/users/:id/message
 */
router.post('/users/:id/message', async (req, res) => {
    const { id } = req.params;
    const { title, message, sendEmail: shouldSendEmail } = req.body;

    try {
        if (!message) {
            return res.status(400).json({ error: 'Message content is required' });
        }

        // 1. Check user exists
        const { data: user, error: userError } = await supabaseAdmin
            .from('profiles')
            .select('email, full_name')
            .eq('id', id)
            .single();

        if (userError || !user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // 2. Create Notification
        const notificationSent = await createNotification(id, {
            type: 'system',
            title: title || 'System Update',
            message: message,
            actionUrl: '/dashboard'
        });

        // 3. Send Email if requested
        let emailSent = false;
        if (shouldSendEmail) {
            const emailResult = await sendEmail({
                to: user.email,
                subject: title || 'Update from LuckyBasket',
                text: message,
                html: `
                    <div style="font-family: Arial, sans-serif; padding: 20px; color: #333; max-width: 600px; margin: auto; border: 1px solid #eee; border-radius: 10px;">
                        <h2 style="color: #10b981;">${title || 'System Update'}</h2>
                        <p>Hi ${user.full_name || 'there'},</p>
                        <p>${message}</p>
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard" style="background-color: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">Go to Dashboard</a>
                        </div>
                        <p style="font-size: 13px; color: #666;">Best regards,<br>The LuckyBasket Team</p>
                        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
                        <p style="font-size: 11px; color: #999; text-align: center;">This is a system message sent by LuckyBasket administration.</p>
                    </div>
                `
            });
            emailSent = emailResult.success;
        }

        logger.success(`Admin message sent to ${id}`, { id, notification: notificationSent, email: emailSent });

        res.json({
            success: true,
            notification: notificationSent,
            email: shouldSendEmail ? emailSent : 'not_requested'
        });
    } catch (error) {
        logger.error('Admin send message error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================================
// DRAWS MANAGEMENT ENDPOINTS
// ============================================================

/**
 * Execute a draw manually (admin trigger)
 * POST /api/admin/draws/:id/execute
 */
router.post('/draws/:id/execute', async (req, res) => {
    const adminId = req.user.id;

    try {
        // Verify draw exists and is active
        const { data: draw, error: fetchError } = await supabaseAdmin
            .from('draws')
            .select('id, status, sold_tickets, title, vendor_id')
            .eq('id', req.params.id)
            .single();

        if (fetchError || !draw) {
            return res.status(404).json({ error: 'Draw not found' });
        }

        if (draw.status !== 'active') {
            return res.status(400).json({ error: `Cannot execute draw with status: ${draw.status} ` });
        }

        if (draw.sold_tickets === 0) {
            return res.status(400).json({ error: 'Cannot execute draw with no tickets sold' });
        }

        // Call the execute_draw RPC
        const { data: result, error: rpcError } = await supabaseAdmin.rpc('execute_draw', {
            draw_id: req.params.id,
        });

        if (rpcError) {
            logger.error('Failed to execute draw', rpcError);
            return res.status(500).json({ error: 'Failed to execute draw' });
        }

        logger.success('Draw manually executed by admin', { drawId: req.params.id, adminId });

        // Notify vendor
        await createNotification(draw.vendor_id, {
            type: 'draw',
            title: 'Draw Completed',
            message: `Your draw "${draw.title}" has been completed by admin.`,
            actionUrl: `/ vendor / bundles / ${draw.id} `,
        });

        res.json({ success: true, message: 'Draw executed successfully', result });
    } catch (error) {
        logger.error('Execute draw error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================================
// ANALYTICS ENDPOINTS
// ============================================================

/**
 * Get platform analytics data
 * GET /api/admin/analytics
 */
router.get('/analytics', async (req, res) => {
    try {
        const now = new Date();
        const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
        const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
        const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59).toISOString();
        const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1).toISOString();

        const [
            totalUsersRes,
            totalVendorsRes,
            newUsersThisMonthRes,
            allDrawsRes,
            allTransactionsRes,
            thisMonthRevenueRes,
            lastMonthRevenueRes,
            activeTicketBuyersRes,
            recentUsersRes,
            categoryDrawsRes,
        ] = await Promise.all([
            supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'user'),
            supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'vendor'),
            supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).gte('created_at', thisMonthStart),
            supabaseAdmin.from('draws').select('id, status, sold_tickets, total_tickets, ticket_price, category, created_at'),
            supabaseAdmin.from('transactions').select('amount, type, status, created_at').eq('status', 'completed'),
            supabaseAdmin.from('transactions').select('amount').eq('type', 'purchase').eq('status', 'completed').gte('created_at', thisMonthStart),
            supabaseAdmin.from('transactions').select('amount').eq('type', 'purchase').eq('status', 'completed').gte('created_at', lastMonthStart).lte('created_at', lastMonthEnd),
            supabaseAdmin.from('tickets').select('user_id').gte('created_at', thisMonthStart),
            supabaseAdmin.from('profiles').select('created_at').gte('created_at', sixMonthsAgo).order('created_at', { ascending: true }),
            supabaseAdmin.from('draws').select('category, sold_tickets, ticket_price').in('status', ['active', 'completed']),
        ]);

        const draws = allDrawsRes.data || [];
        const transactions = allTransactionsRes.data || [];

        // Revenue calculations
        const totalRevenue = transactions.filter(t => t.type === 'purchase').reduce((sum, t) => sum + Number(t.amount), 0);
        const totalPayouts = transactions.filter(t => t.type === 'payout').reduce((sum, t) => sum + Number(t.amount), 0);
        const totalProfit = totalRevenue - totalPayouts;
        const thisMonthRevenue = (thisMonthRevenueRes.data || []).reduce((sum, t) => sum + Number(t.amount), 0);
        const lastMonthRevenue = (lastMonthRevenueRes.data || []).reduce((sum, t) => sum + Number(t.amount), 0);
        const revenueGrowth = lastMonthRevenue > 0 ? ((thisMonthRevenue - lastMonthRevenue) / lastMonthRevenue * 100) : 0;

        // Draw stats
        const activeDraws = draws.filter(d => d.status === 'active');
        const completedDraws = draws.filter(d => d.status === 'completed');
        const totalTicketsSold = draws.reduce((sum, d) => sum + (d.sold_tickets || 0), 0);
        const totalTicketsAvailable = activeDraws.reduce((sum, d) => sum + (d.total_tickets || 0), 0);
        const avgFillRate = totalTicketsAvailable > 0
            ? (activeDraws.reduce((sum, d) => sum + (d.sold_tickets || 0), 0) / totalTicketsAvailable * 100)
            : 0;
        const ticketPrices = draws.filter(d => d.ticket_price).map(d => Number(d.ticket_price));
        const avgTicketPrice = ticketPrices.length > 0 ? ticketPrices.reduce((a, b) => a + b, 0) / ticketPrices.length : 0;

        // Active users (unique ticket buyers this month)
        const activeUserIds = new Set((activeTicketBuyersRes.data || []).map(t => t.user_id));

        // Category breakdown
        const categoryMap = {};
        for (const d of (categoryDrawsRes.data || [])) {
            const cat = d.category || 'Uncategorized';
            if (!categoryMap[cat]) categoryMap[cat] = { category: cat, count: 0, revenue: 0 };
            categoryMap[cat].count++;
            categoryMap[cat].revenue += (d.sold_tickets || 0) * Number(d.ticket_price || 0);
        }
        const topCategories = Object.values(categoryMap).sort((a, b) => b.revenue - a.revenue).slice(0, 5);

        // User growth by month (last 6 months)
        const userGrowth = [];
        const revenueByMonth = [];
        for (let i = 5; i >= 0; i--) {
            const monthDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
            const monthLabel = monthDate.toLocaleString('en-US', { month: 'short', year: '2-digit' });

            const monthUsers = (recentUsersRes.data || []).filter(u => {
                const d = new Date(u.created_at);
                return d >= monthDate && d <= monthEnd;
            }).length;
            userGrowth.push({ month: monthLabel, count: monthUsers });

            const monthRevenue = transactions
                .filter(t => t.type === 'purchase' && new Date(t.created_at) >= monthDate && new Date(t.created_at) <= monthEnd)
                .reduce((sum, t) => sum + Number(t.amount), 0);
            revenueByMonth.push({ month: monthLabel, revenue: monthRevenue });
        }

        res.json({
            revenue: {
                total: totalRevenue,
                profit: totalProfit,
                payouts: totalPayouts,
                thisMonth: thisMonthRevenue,
                lastMonth: lastMonthRevenue,
                growth: Math.round(revenueGrowth * 10) / 10,
            },
            users: {
                total: (totalUsersRes.count || 0) + (totalVendorsRes.count || 0),
                totalUsers: totalUsersRes.count || 0,
                totalVendors: totalVendorsRes.count || 0,
                newThisMonth: newUsersThisMonthRes.count || 0,
                activeUsers: activeUserIds.size,
            },
            draws: {
                total: draws.length,
                active: activeDraws.length,
                completed: completedDraws.length,
                cancelled: draws.filter(d => d.status === 'cancelled').length,
                pending: draws.filter(d => d.status === 'pending_review').length,
                totalTicketsSold,
                avgFillRate: Math.round(avgFillRate * 10) / 10,
                avgTicketPrice: Math.round(avgTicketPrice),
            },
            topCategories,
            revenueByMonth,
            userGrowth,
        });
    } catch (error) {
        logger.error('Get analytics error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================================
// SETTINGS ENDPOINTS
// ============================================================

/**
 * Get platform settings
 * GET /api/admin/settings
 */
router.get('/settings', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('platform_settings')
            .select('*')
            .single();

        if (error || !data) {
            // Return defaults if no settings row exists
            return res.json({
                platformFee: 15,
                referralBonus: 1000,
                referralPercentage: 10,
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

        res.json(data.settings || data);
    } catch (error) {
        logger.error('Get settings error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Update platform settings
 * POST /api/admin/settings
 */
router.post('/settings', async (req, res) => {
    const adminId = req.user.id;
    const settings = req.body;

    try {
        // Upsert settings into platform_settings table
        const { error } = await supabaseAdmin
            .from('platform_settings')
            .upsert({
                id: 1,
                settings,
                updated_by: adminId,
                updated_at: new Date().toISOString(),
            }, { onConflict: 'id' });

        if (error) {
            logger.error('Failed to save platform settings', error);
            return res.status(500).json({
                error: 'Failed to save settings. Please ensure the platform_settings table exists.',
                details: error.message
            });
        }

        // Also sync to individual settings table for backward compatibility if needed
        // but the main referral logic now uses platform_settings

        logger.success('Platform settings updated', { adminId });
        res.json({ success: true, message: 'Settings saved successfully' });
    } catch (error) {
        logger.error('Save settings error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
