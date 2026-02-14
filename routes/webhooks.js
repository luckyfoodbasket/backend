const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { verifyWebhookSignature, verifyTransaction } = require('../services/flutterwave');
const logger = require('../utils/logger');
const { createNotification } = require('./notifications');

/**
 * Test endpoint to verify webhook is accessible
 * GET /api/webhooks/flutterwave
 */
router.get('/flutterwave', (req, res) => {
    logger.info('Webhook test endpoint hit (GET)');
    res.json({
        status: 'ok',
        message: 'LuckyBasket Flutterwave webhook endpoint is active',
        timestamp: new Date().toISOString(),
    });
});

/**
 * Flutterwave Webhook Handler
 * Handles incoming webhooks from Flutterwave for payment and transfer notifications
 * POST /api/webhooks/flutterwave
 */
router.post('/flutterwave', async (req, res) => {
    logger.info('Flutterwave webhook received', {
        hasVerifHash: !!req.headers['verif-hash'],
        bodyKeys: Object.keys(req.body || {}),
    });

    try {
        // Verify webhook signature
        const verifHash = req.headers['verif-hash'];
        if (!verifHash || !verifyWebhookSignature(verifHash)) {
            logger.warn('Invalid Flutterwave webhook signature');
            return res.status(401).json({ error: 'Invalid signature' });
        }

        // Flutterwave has two webhook formats:
        // Format 1 (v3 standard): { event: "charge.completed", data: { ... } }
        // Format 2 (legacy/bank transfer): { "event.type": "BANK_TRANSFER_TRANSACTION", id, txRef, amount, ... }
        const event = req.body.event || req.body['event.type'];
        const data = req.body.data || req.body;

        // Normalize camelCase fields from legacy format to snake_case
        const normalizedData = {
            ...data,
            id: data.id,
            tx_ref: data.tx_ref || data.txRef,
            amount: data.amount,
            status: data.status,
            customer: data.customer,
            payment_type: data.payment_type || data.charge_type || (req.body['event.type'] === 'BANK_TRANSFER_TRANSACTION' ? 'banktransfer' : undefined),
            flw_ref: data.flw_ref || data.flwRef,
            order_ref: data.order_ref || data.orderRef,
            reference: data.reference || data.txRef || data.tx_ref,
        };

        logger.info(`Processing Flutterwave event: ${event}`, {
            tx_ref: normalizedData.tx_ref,
            id: normalizedData.id,
            amount: normalizedData.amount,
            status: normalizedData.status,
        });

        // Map event types to handlers
        switch (event) {
            // v3 standard format
            case 'charge.completed':
            // Legacy format for bank transfers, card charges, etc.
            case 'BANK_TRANSFER_TRANSACTION':
            case 'CARD_TRANSACTION':
                if (normalizedData.status === 'successful') {
                    await handleChargeCompleted(normalizedData);
                } else {
                    logger.warn('Charge not successful, skipping', { status: normalizedData.status });
                }
                break;
            case 'transfer.completed':
            case 'TRANSFER_COMPLETED':
                await handleTransferCompleted(normalizedData);
                break;
            case 'transfer.failed':
            case 'TRANSFER_FAILED':
                await handleTransferFailed(normalizedData);
                break;
            default:
                logger.warn('Unhandled Flutterwave event type', { event });
        }

        // Always respond with 200 to acknowledge receipt
        res.status(200).json({ received: true });
    } catch (error) {
        logger.error('Flutterwave webhook processing error', error);
        res.status(500).json({ received: false, error: 'Webhook processing failed' });
    }
});

/**
 * Handle successful charge (wallet deposit via Flutterwave checkout)
 * User flow: initialize-payment → Flutterwave checkout → webhook confirms
 * This is a backup for the verify-payment redirect flow.
 */
async function handleChargeCompleted(data) {
    const transactionId = data.id;
    const tx_ref = data.tx_ref || data.txRef;
    const customer = data.customer;

    logger.info('Processing charge completed', {
        transactionId,
        tx_ref,
        amount: data.amount,
        email: customer?.email,
        payment_type: data.payment_type,
    });

    // Verify the transaction with Flutterwave API (never trust webhook data alone)
    const verification = await verifyTransaction(transactionId);

    let verifiedAmount, verifiedTxRef, verifiedData;
    if (verification.success) {
        verifiedData = verification.data;
        verifiedAmount = Number(verifiedData.amount) || 0;
        verifiedTxRef = verifiedData.tx_ref;
    } else {
        const isTestMode = process.env.FLUTTERWAVE_SECRET_KEY?.includes('TEST');
        if (!isTestMode) {
            logger.warn('Webhook charge verification failed (LIVE MODE)', { transactionId, error: verification.error });
            return;
        }
        logger.warn('Webhook verification failed in TEST mode, using webhook data', { transactionId });
        verifiedData = data;
        verifiedAmount = Number(data.amount) || 0;
        verifiedTxRef = tx_ref;
    }

    const effectiveTxRef = verifiedTxRef || tx_ref;
    let userId = null;

    // 1. PRIMARY: Find by tx_ref in pending transactions (created by initialize-payment)
    if (effectiveTxRef) {
        const { data: existingTx } = await supabaseAdmin
            .from('transactions')
            .select('id, status, user_id')
            .eq('reference', effectiveTxRef)
            .single();

        if (existingTx) {
            if (existingTx.status === 'completed') {
                logger.info('Charge already processed (idempotent)', { tx_ref: effectiveTxRef });
                return;
            }
            userId = existingTx.user_id;
        }
    }

    // 2. Find by meta.user_id (passed during initialize-payment)
    const metaUserId = data.meta?.user_id || verifiedData?.meta?.user_id;
    if (!userId && metaUserId) {
        const { data: wallet } = await supabaseAdmin
            .from('wallets')
            .select('user_id')
            .eq('user_id', metaUserId)
            .single();
        userId = wallet?.user_id;
    }

    // 3. Fallback: Find by customer email
    const customerEmail = customer?.email || verifiedData?.customer?.email;
    if (!userId && customerEmail) {
        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('id')
            .eq('email', customerEmail)
            .single();
        userId = profile?.id;
    }

    if (!userId) {
        logger.error('User not found for webhook charge', {
            tx_ref: effectiveTxRef,
            email: customerEmail,
            metaUserId,
        });
        return;
    }

    // Get wallet
    const { data: wallet } = await supabaseAdmin
        .from('wallets')
        .select('id, balance')
        .eq('user_id', userId)
        .single();

    if (!wallet) {
        logger.error('Wallet not found for webhook charge', { userId });
        return;
    }

    // Check idempotency by Flutterwave transaction ID
    const { data: existingCompletedTx } = await supabaseAdmin
        .from('transactions')
        .select('id')
        .eq('wallet_id', wallet.id)
        .eq('external_reference', String(transactionId))
        .eq('status', 'completed')
        .single();

    if (existingCompletedTx) {
        logger.info('Transaction already credited (idempotent check)', { transactionId });
        return;
    }

    const previousBalance = Number(wallet.balance) || 0;
    const newBalance = previousBalance + verifiedAmount;

    // Credit wallet
    const { error: updateError } = await supabaseAdmin
        .from('wallets')
        .update({ balance: newBalance })
        .eq('id', wallet.id);

    if (updateError) {
        logger.error('Failed to update wallet balance via webhook', updateError);
        throw updateError;
    }

    // Update existing pending transaction or create new one
    const { data: pendingTx } = await supabaseAdmin
        .from('transactions')
        .select('id')
        .eq('reference', effectiveTxRef)
        .eq('status', 'pending')
        .single();

    if (pendingTx) {
        await supabaseAdmin
            .from('transactions')
            .update({
                status: 'completed',
                amount: verifiedAmount,
                external_reference: String(transactionId),
                balance_before: previousBalance,
                balance_after: newBalance,
                completed_at: new Date().toISOString(),
                metadata: {
                    flw_transaction_id: transactionId,
                    payment_type: verifiedData.payment_type,
                    source: 'webhook',
                },
            })
            .eq('id', pendingTx.id);
    } else {
        await supabaseAdmin
            .from('transactions')
            .insert({
                user_id: userId,
                wallet_id: wallet.id,
                amount: verifiedAmount,
                type: 'topup',
                status: 'completed',
                reference: effectiveTxRef,
                external_reference: String(transactionId),
                payment_method: verifiedData.payment_type || 'flutterwave',
                provider: 'flutterwave',
                description: 'Wallet Top-up via Flutterwave',
                balance_before: previousBalance,
                balance_after: newBalance,
                completed_at: new Date().toISOString(),
                metadata: {
                    flw_transaction_id: transactionId,
                    payment_type: verifiedData.payment_type,
                    source: 'webhook',
                },
            });
    }

    logger.success('Wallet topped up via webhook', {
        userId,
        amount: verifiedAmount,
        previousBalance,
        newBalance,
    });

    // Notify user
    await createNotification(userId, {
        type: 'wallet',
        title: 'Wallet Funded',
        message: `Your wallet has been credited with NGN ${verifiedAmount.toLocaleString()}`,
        actionUrl: '/wallet',
    });
}

/**
 * Handle successful transfer (vendor withdrawal completed)
 */
async function handleTransferCompleted(data) {
    const reference = data.reference || data.txRef || data.tx_ref;
    const amount = data.amount;
    const complete_message = data.complete_message || data.completeMessage;

    logger.info('Processing transfer.completed', { reference, amount });

    if (!reference) {
        logger.warn('Transfer webhook missing reference');
        return;
    }

    // Find the withdrawal transaction
    const { data: tx } = await supabaseAdmin
        .from('transactions')
        .select('id, user_id, status')
        .eq('reference', reference)
        .eq('type', 'withdrawal')
        .single();

    if (!tx) {
        logger.warn('Withdrawal transaction not found', { reference });
        return;
    }

    if (tx.status === 'completed') {
        logger.info('Withdrawal already completed (idempotent)', { reference });
        return;
    }

    // Mark as completed
    await supabaseAdmin
        .from('transactions')
        .update({
            status: 'completed',
            completed_at: new Date().toISOString(),
            metadata: {
                ...tx.metadata,
                ...data,
                complete_message,
                source: 'webhook',
            },
        })
        .eq('id', tx.id);

    // Sync with withdrawal_requests
    await supabaseAdmin
        .from('withdrawal_requests')
        .update({
            status: 'completed',
            processed_at: new Date().toISOString(),
        })
        .eq('transaction_id', tx.id);

    logger.success('Withdrawal completed', { reference, amount });

    // Notify vendor
    await createNotification(tx.user_id, {
        type: 'wallet',
        title: 'Withdrawal Successful',
        message: `Your withdrawal of NGN ${Number(amount).toLocaleString()} has been completed.`,
        actionUrl: '/wallet',
    });
}

/**
 * Handle failed transfer (vendor withdrawal failed - refund wallet)
 */
async function handleTransferFailed(data) {
    const reference = data.reference || data.txRef || data.tx_ref;
    const amount = data.amount;
    const complete_message = data.complete_message || data.completeMessage;

    logger.warn('Processing transfer.failed', { reference, amount });

    if (!reference) {
        logger.warn('Transfer failed webhook missing reference');
        return;
    }

    // Find the withdrawal transaction
    const { data: tx } = await supabaseAdmin
        .from('transactions')
        .select('id, user_id, wallet_id, amount, balance_before, metadata')
        .eq('reference', reference)
        .eq('type', 'withdrawal')
        .single();

    if (!tx) {
        logger.warn('Failed withdrawal transaction not found', { reference });
        return;
    }

    const refundAmount = Math.abs(Number(tx.amount) || 0);

    /* 
       REMOVED AUTO-REFUND per user request. 
       Admin will now handle failed transfers manually via "Retry" or "Refund" buttons.
    */
    logger.info('Transfer failed. Auto-refund skipped to allow Admin manual intervention.', {
        reference,
        amount,
        walletId: tx.wallet_id
    });

    // Update withdrawal_requests status so admin can see failure and retry
    await supabaseAdmin
        .from('withdrawal_requests')
        .update({
            status: 'failed',
            admin_notes: `System: Transfer failed on Flutterwave. Message: ${complete_message || 'Reason unknown'}. You can retry or refund manually.`
        })
        .eq('transaction_id', tx.id);

    // Update transaction status
    await supabaseAdmin
        .from('transactions')
        .update({
            status: 'failed',
            metadata: {
                failure_reason: complete_message || 'Transfer failed',
                source: 'webhook',
                ...data,
            },
        })
        .eq('id', tx.id);

    logger.warn('Withdrawal failed', { reference, refundAmount });

    // Notify vendor
    await createNotification(tx.user_id, {
        type: 'wallet',
        title: 'Withdrawal Failed ⚠',
        message: `Your withdrawal of NGN ${refundAmount.toLocaleString()} failed on the network. Our admin is reviewing the issue and will retry or refund shortly.`,
        actionUrl: '/wallet',
    });
}

module.exports = router;
