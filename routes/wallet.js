const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/role');
const requireVerification = require('../middleware/requireVerification');
const {
    initializePayment,
    verifyTransaction,
    initiateTransfer,
    getBanks,
    resolveAccount,
} = require('../services/flutterwave');
const logger = require('../utils/logger');
const { createNotification } = require('./notifications');
const { validateAmount, validateBankCode } = require('../utils/validation');

/**
 * Get user's wallet balance
 * GET /api/wallet
 */
router.get('/', authenticate, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('wallets')
            .select('balance, vendor_balance, currency')
            .eq('user_id', req.user.id)
            .single();

        if (error) {
            logger.error('Failed to fetch wallet', error);
            return res.status(500).json({ error: 'Failed to fetch wallet balance' });
        }

        res.json({
            balance: parseFloat(data.balance) || 0,
            vendor_balance: parseFloat(data.vendor_balance) || 0,
            currency: data.currency || 'NGN'
        });
    } catch (error) {
        logger.error('Get wallet error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Get user's transaction history
 * GET /api/wallet/history
 */
router.get('/history', authenticate, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('transactions')
            .select('*')
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false });

        if (error) {
            logger.error('Failed to fetch transactions', error);
            return res.status(500).json({ error: 'Failed to fetch transaction history' });
        }

        res.json({
            success: true,
            transactions: data.map(tx => ({
                id: tx.id,
                userId: tx.user_id,
                amount: parseFloat(tx.amount),
                type: tx.type,
                status: tx.status,
                reference: tx.reference,
                description: tx.description || 'No description',
                createdAt: tx.created_at
            }))
        });
    } catch (error) {
        logger.error('Get history error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Initialize a Flutterwave payment (redirect checkout)

 * POST /api/wallet/initialize-payment
 */
router.post('/initialize-payment', authenticate, requireVerification, async (req, res) => {
    const userId = req.user.id;
    const { amount } = req.body;

    logger.info('Payment initialization request', { userId, amount });

    try {
        // Fetch platform settings for validation
        const { data: settingsRow } = await supabaseAdmin
            .from('platform_settings')
            .select('settings')
            .eq('id', 1)
            .single();

        const config = settingsRow?.settings || {
            minDeposit: 100,
            maxDeposit: 1000000
        };

        const amountCheck = validateAmount(amount, {
            min: config.minDeposit || 100,
            max: config.maxDeposit || 1000000,
            fieldName: 'Deposit amount',
        });
        if (!amountCheck.valid) {
            return res.status(400).json({ error: amountCheck.error });
        }

        // Get user profile
        const profile = req.userProfile;
        const email = profile?.email || req.user.email;
        const name = profile?.full_name || 'LuckyBasket User';

        const tx_ref = `LB_${userId.substring(0, 8)}_${Date.now()}`;
        const redirect_url = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/wallet/callback`;

        const result = await initializePayment({
            amount,
            email,
            name,
            tx_ref,
            redirect_url,
            meta: { user_id: userId },
        });

        if (!result.success) {
            logger.error('Flutterwave payment initialization failed', { error: result.error });
            return res.status(500).json({ error: result.error || 'Failed to initialize payment' });
        }

        // Get wallet to record pending transaction
        const { data: wallet } = await supabaseAdmin
            .from('wallets')
            .select('id, balance')
            .eq('user_id', userId)
            .single();

        if (wallet) {
            logger.db('INSERT', 'transactions', { type: 'topup', amount, status: 'pending' });

            await supabaseAdmin
                .from('transactions')
                .insert({
                    user_id: userId,
                    wallet_id: wallet.id,
                    type: 'topup',
                    amount,
                    status: 'pending',
                    reference: tx_ref,
                    payment_method: 'flutterwave_checkout',
                    provider: 'flutterwave',
                    description: 'Wallet Top-up via Flutterwave',
                    balance_before: wallet.balance,
                });
        }

        logger.success('Payment initialized', { tx_ref, link: result.data.link });

        res.json({
            success: true,
            paymentLink: result.data.link,
            txRef: result.data.tx_ref,
        });
    } catch (error) {
        logger.error('Initialize payment error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Verify payment after Flutterwave redirect callback
 * GET /api/wallet/verify-payment?transaction_id=xxx&tx_ref=xxx
 */
router.get('/verify-payment', authenticate, async (req, res) => {
    const userId = req.user.id;
    const { transaction_id, tx_ref } = req.query;

    logger.info('Payment verification request', { userId, transaction_id, tx_ref });

    try {
        if (!transaction_id) {
            return res.status(400).json({ error: 'Missing transaction_id' });
        }

        // Verify with Flutterwave
        const result = await verifyTransaction(transaction_id);

        if (!result.success) {
            logger.warn('Payment verification failed', { transaction_id, error: result.error });

            // Update pending transaction to failed if tx_ref matches
            if (tx_ref) {
                await supabaseAdmin
                    .from('transactions')
                    .update({
                        status: 'failed',
                        metadata: { flw_transaction_id: transaction_id, failure_reason: result.error },
                    })
                    .eq('reference', tx_ref)
                    .eq('user_id', userId)
                    .eq('status', 'pending');
            }

            return res.status(400).json({
                success: false,
                error: result.error || 'Payment verification failed',
            });
        }

        const txData = result.data;
        const verifiedTxRef = txData.tx_ref;
        const amountPaid = Number(txData.amount) || 0;

        // Check idempotency
        const { data: existingTx } = await supabaseAdmin
            .from('transactions')
            .select('id, status')
            .eq('reference', verifiedTxRef)
            .single();

        if (existingTx?.status === 'completed') {
            logger.info('Transaction already processed (idempotent)', { tx_ref: verifiedTxRef });
            return res.json({
                success: true,
                message: 'Payment already processed',
                amount: amountPaid,
            });
        }

        // Get wallet
        const { data: wallet, error: walletError } = await supabaseAdmin
            .from('wallets')
            .select('id, balance')
            .eq('user_id', userId)
            .single();

        if (walletError || !wallet) {
            logger.error('Wallet not found for payment verification', { userId });
            return res.status(500).json({ error: 'Wallet not found' });
        }

        const previousBalance = Number(wallet.balance) || 0;
        const newBalance = previousBalance + amountPaid;

        // Credit wallet
        const { error: updateError } = await supabaseAdmin
            .from('wallets')
            .update({ balance: newBalance })
            .eq('id', wallet.id);

        if (updateError) {
            logger.error('Failed to update wallet balance', updateError);
            return res.status(500).json({ error: 'Failed to credit wallet' });
        }

        // Update or create transaction record
        if (existingTx) {
            await supabaseAdmin
                .from('transactions')
                .update({
                    status: 'completed',
                    amount: amountPaid,
                    balance_before: previousBalance,
                    balance_after: newBalance,
                    completed_at: new Date().toISOString(),
                    external_reference: String(transaction_id),
                    metadata: {
                        flw_transaction_id: transaction_id,
                        payment_type: txData.payment_type,
                        provider: 'flutterwave',
                    },
                })
                .eq('id', existingTx.id);
        } else {
            await supabaseAdmin
                .from('transactions')
                .insert({
                    user_id: userId,
                    wallet_id: wallet.id,
                    amount: amountPaid,
                    type: 'topup',
                    status: 'completed',
                    reference: verifiedTxRef,
                    external_reference: String(transaction_id),
                    payment_method: txData.payment_type || 'flutterwave_checkout',
                    provider: 'flutterwave',
                    description: 'Wallet Top-up via Flutterwave',
                    balance_before: previousBalance,
                    balance_after: newBalance,
                    completed_at: new Date().toISOString(),
                    metadata: {
                        flw_transaction_id: transaction_id,
                        payment_type: txData.payment_type,
                    },
                });
        }

        logger.success('Wallet topped up', {
            userId,
            amount: amountPaid,
            previousBalance,
            newBalance,
        });

        // Notify user
        await createNotification(userId, {
            type: 'wallet',
            title: 'Wallet Funded',
            message: `Your wallet has been credited with NGN ${amountPaid.toLocaleString()}`,
            actionUrl: '/wallet',
        });

        res.json({
            success: true,
            message: 'Payment verified and wallet credited',
            amount: amountPaid,
            newBalance,
        });
    } catch (error) {
        logger.error('Verify payment error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// =====================================================
// VENDOR-ONLY ENDPOINTS (Withdrawals)
// =====================================================

/**
 * Get list of Nigerian banks
 * GET /api/wallet/banks
 */
router.get('/banks', authenticate, authorize(['vendor', 'admin']), async (req, res) => {
    try {
        const result = await getBanks('NG');

        if (!result.success) {
            return res.status(500).json({ error: result.error || 'Failed to fetch banks' });
        }

        res.json({
            banks: result.data.map(bank => ({
                code: bank.code,
                name: bank.name,
            })),
        });
    } catch (error) {
        logger.error('Get banks error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Resolve/verify a bank account
 * POST /api/wallet/resolve-account
 */
router.post('/resolve-account', authenticate, authorize(['vendor', 'admin']), async (req, res) => {
    const { account_number, bank_code } = req.body;

    if (!account_number || !bank_code) {
        return res.status(400).json({ error: 'account_number and bank_code are required' });
    }

    if (!/^\d{10}$/.test(account_number)) {
        return res.status(400).json({ error: 'Account number must be 10 digits' });
    }

    try {
        const result = await resolveAccount(account_number, bank_code);

        if (!result.success) {
            return res.status(400).json({ error: result.error || 'Could not resolve account' });
        }

        res.json({
            account_number: result.data.account_number,
            account_name: result.data.account_name,
        });
    } catch (error) {
        logger.error('Resolve account error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Initiate vendor withdrawal
 * POST /api/wallet/withdraw
 */
router.post('/withdraw', authenticate, authorize(['vendor', 'admin']), async (req, res) => {
    const userId = req.user.id;
    const isVendor = req.userProfile?.role === 'vendor' || req.user.role === 'vendor';
    const { amount, bank_code, account_number, account_name, draw_id } = req.body;

    logger.info('Withdrawal request received', { userId, isVendor, amount, draw_id });

    try {
        // Fetch platform settings for validation
        const { data: settingsRow } = await supabaseAdmin
            .from('platform_settings')
            .select('settings')
            .eq('id', 1)
            .single();

        const config = settingsRow?.settings || {
            minWithdrawal: 1000,
            withdrawalFee: 100
        };

        const amountCheck = validateAmount(amount, {
            min: config.minWithdrawal || 1000,
            fieldName: 'Withdrawal amount',
        });
        if (!amountCheck.valid) {
            return res.status(400).json({ error: amountCheck.error });
        }
        if (!bank_code || !account_number || !account_name) {
            return res.status(400).json({ error: 'Bank details are required' });
        }
        const bankCodeCheck = validateBankCode(bank_code);
        if (!bankCodeCheck.valid) {
            return res.status(400).json({ error: bankCodeCheck.error });
        }

        // Get wallet and check balance
        const { data: wallet, error: walletError } = await supabaseAdmin
            .from('wallets')
            .select('id, balance, vendor_balance, is_locked')
            .eq('user_id', userId)
            .single();

        if (walletError || !wallet) {
            return res.status(404).json({ error: 'Wallet not found' });
        }

        if (wallet.is_locked) {
            return res.status(403).json({ error: 'Wallet is locked. Please contact support.' });
        }

        // For vendors, we use vendor_balance. For regular users (if allowed), we use balance.
        const currentBalance = isVendor ? Number(wallet.vendor_balance) : Number(wallet.balance);
        const totalDebit = amount + (config.withdrawalFee || 0);

        if (currentBalance < totalDebit) {
            logger.warn('Insufficient balance for withdrawal', { userId, amount, totalDebit, currentBalance });
            return res.status(400).json({
                error: 'Insufficient balance for this withdrawal amount (including fees).',
            });
        }

        const reference = `LB_WD_${userId.substring(0, 8)}_${Date.now()}`;
        const newBalance = currentBalance - totalDebit;

        // Start transaction - deduct from wallet
        const walletUpdate = isVendor ? { vendor_balance: newBalance } : { balance: newBalance };
        const { error: updateError } = await supabaseAdmin
            .from('wallets')
            .update(walletUpdate)
            .eq('id', wallet.id);

        if (updateError) {
            logger.error('Failed to deduct wallet balance', updateError);
            return res.status(500).json({ error: 'Failed to process withdrawal request' });
        }

        // Create transaction record (pending)
        const { data: transaction, error: txError } = await supabaseAdmin
            .from('transactions')
            .insert({
                user_id: userId,
                wallet_id: wallet.id,
                type: 'withdrawal',
                amount: -amount,
                fee: config.withdrawalFee || 0,
                status: 'pending',
                reference,
                payment_method: 'bank_transfer',
                provider: 'flutterwave',
                description: `Withdrawal request to ${account_name} (${account_number})`,
                balance_before: currentBalance,
                balance_after: newBalance,
                metadata: {
                    bank_code,
                    account_number,
                    account_name,
                    fee: config.withdrawalFee || 0,
                    total_debit: totalDebit,
                    draw_id: draw_id || null,
                    is_vendor_payout: isVendor
                },
            })
            .select()
            .single();

        if (txError) {
            logger.error('Failed to create transaction', txError);
            // Rollback balance? Manual intervention needed if this happens, usually atomic in DB
            return res.status(500).json({ error: 'Internal server error' });
        }

        // Create the official Withdrawal Request entry for admin review
        const { error: reqError } = await supabaseAdmin
            .from('withdrawal_requests')
            .insert({
                vendor_id: userId,
                transaction_id: transaction.id,
                amount: amount,
                bank_code,
                account_number,
                account_name,
                status: 'pending',
                draw_id: draw_id || null,
                admin_notes: draw_id ? `Linked to bundle delivery verification.` : 'General balance withdrawal.'
            });

        if (reqError) {
            logger.error('Failed to create withdrawal request entry', reqError);
            // Transaction still exists, but admin needs to see it. 
        }

        logger.success('Withdrawal request submitted for review', { userId, amount, reference });

        res.json({
            success: true,
            message: 'Withdrawal request submitted successfully and is awaiting admin approval.',
            reference,
            amount,
            newBalance,
        });
    } catch (error) {
        logger.error('Withdrawal error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Get vendor's withdrawal history
 * GET /api/wallet/withdrawals
 */
router.get('/withdrawals', authenticate, authorize(['vendor', 'admin']), async (req, res) => {
    const userId = req.user.id;
    const { limit = 20, offset = 0 } = req.query;

    try {
        const { data: withdrawals, error } = await supabaseAdmin
            .from('transactions')
            .select('*')
            .eq('user_id', userId)
            .eq('type', 'withdrawal')
            .order('created_at', { ascending: false })
            .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

        if (error) {
            logger.error('Failed to fetch withdrawals', error);
            return res.status(500).json({ error: 'Failed to fetch withdrawals' });
        }

        res.json({
            withdrawals: withdrawals.map(tx => ({
                id: tx.id,
                amount: Math.abs(tx.amount),
                status: tx.status,
                reference: tx.reference,
                description: tx.description,
                bankDetails: tx.metadata ? {
                    bankCode: tx.metadata.bank_code,
                    accountNumber: tx.metadata.account_number,
                    accountName: tx.metadata.account_name,
                } : null,
                createdAt: tx.created_at,
                completedAt: tx.completed_at,
            })),
        });
    } catch (error) {
        logger.error('Get withdrawals error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
