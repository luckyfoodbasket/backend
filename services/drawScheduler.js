const cron = require('node-cron');
const { supabaseAdmin } = require('../config/supabase');
const logger = require('../utils/logger');

const drawScheduler = {
    init: () => {
        // Check for expired timer-based draws every minute
        cron.schedule('* * * * *', async () => {
            try {
                // Find active timer draws whose draw_date has passed
                const { data: expiredDraws, error } = await supabaseAdmin
                    .from('draws')
                    .select('id, title, sold_tickets')
                    .eq('status', 'active')
                    .eq('draw_type', 'timer')
                    .lte('draw_date', new Date().toISOString());

                if (error) {
                    logger.error('Failed to check for expired draws:', error.message);
                    return;
                }

                if (!expiredDraws || expiredDraws.length === 0) return;

                for (const draw of expiredDraws) {
                    // Skip draws with no tickets sold
                    if (!draw.sold_tickets || draw.sold_tickets === 0) {
                        logger.info(`Draw ${draw.id} (${draw.title}) expired with 0 tickets, marking as cancelled`);
                        await supabaseAdmin
                            .from('draws')
                            .update({ status: 'cancelled', completed_at: new Date().toISOString() })
                            .eq('id', draw.id);
                        continue;
                    }

                    logger.info(`Executing expired timer draw: ${draw.id} (${draw.title}) with ${draw.sold_tickets} tickets`);

                    // Call execute_draw RPC
                    const { data: result, error: drawError } = await supabaseAdmin
                        .rpc('execute_draw', { _draw_id: draw.id });

                    if (drawError) {
                        logger.error(`Failed to execute draw ${draw.id}:`, drawError.message);
                        continue;
                    }

                    if (result?.success) {
                        logger.info(`Draw ${draw.id} completed! Winner: ${result.winner_id}, Ticket: ${result.winning_ticket_number}`);

                        // Send winner notification
                        try {
                            await supabaseAdmin.from('notifications').insert({
                                user_id: result.winner_id,
                                type: 'draw_won',
                                title: 'You Won! 🎉',
                                message: `Congratulations! Your ticket ${result.winning_ticket_number} won the draw for "${draw.title}"!`,
                                metadata: { draw_id: draw.id, ticket_number: result.winning_ticket_number },
                            });
                        } catch (notifErr) {
                            logger.error('Failed to send winner notification:', notifErr.message);
                        }
                    } else {
                        logger.error(`Draw ${draw.id} execution returned:`, result?.message);
                    }
                }
            } catch (err) {
                logger.error('Draw scheduler error:', err.message);
            }
        });

        logger.info('Draw scheduler initialized (checking every minute for expired timer draws)');
    }
};

module.exports = drawScheduler;
