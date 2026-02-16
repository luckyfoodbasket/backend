const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const authenticate = require('../middleware/auth');
const logger = require('../utils/logger');
const { createNotification } = require('./notifications');
const requireVerification = require('../middleware/requireVerification');

// Get sold slot indices for a draw (Public - for ticket grid)
router.get('/draw/:drawId/slots', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('tickets')
            .select('slot_index')
            .eq('draw_id', req.params.drawId)
            .not('slot_index', 'is', null);

        if (error) throw error;

        const slots = (data || []).map(t => t.slot_index);
        res.json({ slots });
    } catch (err) {
        logger.error('Sold slots error:', err);
        res.status(500).json({ error: 'Failed to fetch sold slots' });
    }
});

// Buy Tickets (User only) - Supports multiple tickets at once
router.post('/buy', authenticate, requireVerification, async (req, res) => {
    const { draw_id, quantity = 1, slot_indices } = req.body;
    const userId = req.user.id;

    if (!draw_id) {
        return res.status(400).json({ error: 'Draw ID is required' });
    }

    // Fetch platform settings for validation
    const { data: settingsRow } = await supabaseAdmin
        .from('platform_settings')
        .select('settings')
        .eq('id', 1)
        .single();

    const config = settingsRow?.settings || {
        maxTicketsPerPurchase: 50
    };

    // Determine quantity from slot_indices if provided
    const qty = slot_indices && Array.isArray(slot_indices) ? slot_indices.length : parseInt(quantity);
    if (isNaN(qty) || qty < 1 || qty > (config.maxTicketsPerPurchase || 50)) {
        return res.status(400).json({ error: `Quantity must be between 1 and ${(config.maxTicketsPerPurchase || 50)}` });
    }

    // Validate slot_indices if provided
    if (slot_indices && Array.isArray(slot_indices)) {
        // Check for duplicates
        const uniqueSlots = new Set(slot_indices);
        if (uniqueSlots.size !== slot_indices.length) {
            return res.status(400).json({ error: 'Duplicate slot selections are not allowed' });
        }

        // Check if any selected slots are already taken
        const { data: takenSlots } = await supabaseAdmin
            .from('tickets')
            .select('slot_index')
            .eq('draw_id', draw_id)
            .in('slot_index', slot_indices);

        if (takenSlots && takenSlots.length > 0) {
            return res.status(400).json({
                error: 'Some selected slots are already taken. Please refresh and try again.',
                taken_slots: takenSlots.map(t => t.slot_index),
            });
        }
    }

    try {
        // 1. Check if this is user's first ticket purchase (for referral bonus)
        const { data: existingTickets } = await supabaseAdmin
            .from('tickets')
            .select('id')
            .eq('user_id', userId)
            .limit(1);

        const isFirstPurchase = !existingTickets || existingTickets.length === 0;

        // 2. Call atomic buy_tickets_v2 RPC
        const { data: result, error: rpcError } = await supabaseAdmin.rpc('buy_tickets_v2', {
            _user_id: userId,
            _draw_id: draw_id,
            _quantity: qty,
        });

        if (rpcError) {
            logger.error('RPC Error:', rpcError);
            return res.status(400).json({ error: rpcError.message || 'Transaction failed' });
        }

        if (!result.success) {
            return res.status(400).json({ error: result.error || 'Transaction failed' });
        }

        // 3. Assign slot_indices to created tickets (after RPC success)
        if (slot_indices && Array.isArray(slot_indices) && result.tickets) {
            for (let i = 0; i < result.tickets.length && i < slot_indices.length; i++) {
                await supabaseAdmin
                    .from('tickets')
                    .update({ slot_index: slot_indices[i] })
                    .eq('id', result.tickets[i].id);
            }
        }

        // 4. Get draw title for notifications
        const { data: draw } = await supabaseAdmin
            .from('draws')
            .select('title, vendor_id')
            .eq('id', draw_id)
            .single();

        const drawTitle = draw?.title || 'the draw';
        const ticketNumbers = result.tickets.map(t => t.ticket_number).join(', ');

        // 5. Send purchase notification to user
        await createNotification(userId, {
            type: 'ticket',
            title: `${qty} Ticket${qty > 1 ? 's' : ''} Purchased!`,
            message: `You bought ${qty} ticket${qty > 1 ? 's' : ''} for ${drawTitle}. Numbers: ${ticketNumbers}. Good luck!`,
            actionUrl: `/draws/${draw_id}`,
            metadata: { drawId: draw_id, tickets: result.tickets, totalCost: result.total_cost },
        });

        // 6. Handle referral bonus notifications if credited
        if (result.referral_bonus_credited) {
            logger.success('Referral bonuses were credited via RPC', {
                referrerId: result.referrer_id,
                refereeId: userId,
                bonusReferrer: result.bonus_referrer,
                bonusReferee: result.bonus_referee,
            });

            // Notify Referrer
            if (result.referrer_id && result.bonus_referrer > 0) {
                await createNotification(result.referrer_id, {
                    type: 'referral',
                    title: 'Referral Bonus Received! 🎊',
                    message: `Your friend made their first purchase. You've been credited with ₦${result.bonus_referrer.toLocaleString()}!`,
                    actionUrl: '/wallet',
                    metadata: { amount: result.bonus_referrer, referredUserId: userId },
                });
            }

            // Notify Referee
            if (result.bonus_referee > 0) {
                await createNotification(userId, {
                    type: 'referral',
                    title: 'Welcome Bonus Received! 🎁',
                    message: `Congratulations! Since you joined via referral, you've been credited with ₦${result.bonus_referee.toLocaleString()} for your first purchase!`,
                    actionUrl: '/wallet',
                    metadata: { amount: result.bonus_referee },
                });
            }
        }

        // 7. Handle draw completion (auto-draw for slot_complete)
        if (result.draw_completed && result.draw_result?.success) {
            const winnerId = result.draw_result.winner_id;
            const winningTicketNumber = result.draw_result.winning_ticket_number;

            logger.success('Draw completed automatically!', {
                drawId: draw_id,
                winnerId,
                winningTicketNumber,
            });

            // Notify winner
            await createNotification(winnerId, {
                type: 'win',
                title: 'You Won!',
                message: `Congratulations! Your ticket ${winningTicketNumber} won the draw for "${drawTitle}"!`,
                actionUrl: '/winners',
                metadata: {
                    drawId: draw_id,
                    winningTicketNumber,
                    prizeValue: draw?.bundle_value,
                },
            });

            // Notify vendor
            if (draw?.vendor_id) {
                await createNotification(draw.vendor_id, {
                    type: 'draw',
                    title: 'Draw Completed!',
                    message: `All slots for "${drawTitle}" have been filled and a winner has been selected.`,
                    actionUrl: `/vendor/bundles`,
                    metadata: { drawId: draw_id },
                });
            }
        }

        logger.success('Tickets purchased successfully', {
            userId,
            drawId: draw_id,
            quantity: qty,
            isFirstPurchase,
            drawCompleted: result.draw_completed,
        });

        res.json({
            message: `${qty} ticket${qty > 1 ? 's' : ''} purchased successfully`,
            tickets: result.tickets,
            total_cost: result.total_cost,
            new_balance: result.new_balance,
            draw_completed: result.draw_completed,
            draw_result: result.draw_result || null,
        });
    } catch (err) {
        logger.error('Purchase error:', err);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
});

// Get My Tickets
router.get('/my', authenticate, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('tickets')
            .select('*, draws(id, title, bundle_value, status, images, winner_id, winning_ticket_id, draw_type, draw_date, ticket_price, total_tickets, sold_tickets, category)')
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch tickets' });
    }
});

// Get Recent Buyers for a Draw (Public - no auth required)
router.get('/draw/:drawId/recent', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('tickets')
            .select('ticket_number, created_at, profiles:user_id(full_name)')
            .eq('draw_id', req.params.drawId)
            .order('created_at', { ascending: false })
            .limit(10);

        if (error) throw error;

        // Mask buyer names for privacy (e.g., "Adebayo Ola" -> "Ade***")
        const masked = (data || []).map(ticket => {
            const fullName = ticket.profiles?.full_name || 'Anonymous';
            const maskedName = fullName.length > 3
                ? fullName.substring(0, 3) + '***'
                : fullName + '***';

            return {
                ticket_number: ticket.ticket_number,
                buyer_name: maskedName,
                created_at: ticket.created_at,
            };
        });

        res.json(masked);
    } catch (err) {
        logger.error('Recent buyers error:', err);
        res.status(500).json({ error: 'Failed to fetch recent buyers' });
    }
});

// Get All Tickets for a Draw (Public - for verification)
router.get('/draw/:drawId', async (req, res) => {
    try {
        const { data: draw } = await supabaseAdmin
            .from('draws')
            .select('status')
            .eq('id', req.params.drawId)
            .single();

        // Only return full ticket list for completed draws
        if (!draw || draw.status !== 'completed') {
            return res.status(400).json({ error: 'Ticket list only available for completed draws' });
        }

        const { data, error } = await supabaseAdmin
            .from('tickets')
            .select('id, ticket_number, is_winner, created_at, profiles:user_id(full_name)')
            .eq('draw_id', req.params.drawId)
            .order('created_at', { ascending: true });

        if (error) throw error;

        // Mask names but show full info for winner
        const tickets = (data || []).map(ticket => ({
            id: ticket.id,
            ticket_number: ticket.ticket_number,
            is_winner: ticket.is_winner,
            buyer_name: ticket.is_winner
                ? ticket.profiles?.full_name || 'Winner'
                : (ticket.profiles?.full_name || 'Anonymous').substring(0, 3) + '***',
            created_at: ticket.created_at,
        }));

        res.json(tickets);
    } catch (err) {
        logger.error('Draw tickets error:', err);
        res.status(500).json({ error: 'Failed to fetch draw tickets' });
    }
});

// Get Audit Log for a Draw (Public - transparency)
router.get('/draw/:drawId/audit', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('draw_audit_log')
            .select('*')
            .eq('draw_id', req.params.drawId)
            .order('created_at', { ascending: true });

        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        logger.error('Audit log error:', err);
        res.status(500).json({ error: 'Failed to fetch audit log' });
    }
});

module.exports = router;
