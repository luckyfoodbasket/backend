const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const authenticate = require('../middleware/auth');
const logger = require('../utils/logger');
const { createNotification } = require('./notifications');
const { sendVerificationEmail } = require('../services/email');
const {
    resolveReferral,
    upsertProfile,
    ensureWallet,
    processReferralBonus,
} = require('../services/registration');
const crypto = require('crypto');

/**
 * Complete user registration after Supabase Auth signup
 * Creates profile and wallet, handles referral code
 * POST /api/auth/complete-registration
 */
router.post('/complete-registration', authenticate, async (req, res) => {
    const userId = req.user.id;
    const email = req.user.email;
    const { fullName, phone, referralCode } = req.body;

    // Input validation
    if (!fullName || typeof fullName !== 'string' || fullName.trim().length < 2) {
        return res.status(400).json({ error: 'Full name is required (minimum 2 characters)', code: 'INVALID_INPUT' });
    }
    if (phone && (typeof phone !== 'string' || phone.trim().length < 10)) {
        return res.status(400).json({ error: 'Invalid phone number format', code: 'INVALID_INPUT' });
    }
    if (referralCode && typeof referralCode !== 'string') {
        return res.status(400).json({ error: 'Invalid referral code format', code: 'INVALID_INPUT' });
    }

    logger.info('Complete registration request', { userId, email, fullName, referralCode: referralCode || 'none' });

    try {
        // 1. Validate referral code if provided
        const { referrerId, referredBonus } = await resolveReferral(referralCode, userId);

        // 2. Create or update profile with verification token
        const { verificationToken } = await upsertProfile(userId, email, { fullName, phone }, referrerId);

        // 3. Ensure wallet exists
        const wallet = await ensureWallet(userId);

        // 4. Process referral bonus if applicable
        if (referrerId && wallet) {
            const newBalance = await processReferralBonus(userId, referrerId, wallet, referredBonus);
            wallet.balance = newBalance;
        }

        // 5. Get final profile data
        const { data: finalProfile } = await supabaseAdmin
            .from('profiles')
            .select('full_name, email, phone, role, referral_code')
            .eq('id', userId)
            .single();

        logger.success('Registration completed', {
            userId,
            email,
            hasWallet: !!wallet,
            wasReferred: !!referrerId
        });

        // Send welcome notification
        await createNotification(userId, {
            type: 'welcome',
            title: 'Welcome to LuckyBasket! 🎉',
            message: 'Your account is ready. Please verify your email to access all features.',
            actionUrl: '/dashboard',
            metadata: { event: 'registration_complete' }
        });

        // Send verification email
        await sendVerificationEmail(email, fullName, verificationToken);

        res.json({
            success: true,
            message: referrerId
                ? 'Registration completed! Buy your first ticket to receive your referral bonus.'
                : 'Registration completed successfully',
            profile: finalProfile,
            wallet: wallet ? { balance: wallet.balance || 0 } : null,
            referralBonusPending: referrerId ? referredBonus : 0,
        });

    } catch (err) {
        logger.error('Complete registration error', err);
        res.status(500).json({ error: 'Failed to complete registration' });
    }
});

/**
 * Get current user profile
 * GET /api/auth/me
 */
router.get('/me', authenticate, async (req, res) => {
    const userId = req.user.id;
    logger.info('Get profile request', { userId });

    try {
        logger.db('SELECT', 'profiles', { userId });
        const { data: profile, error } = await supabaseAdmin
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .single();

        if (error) {
            logger.warn('Profile not found', { userId, error: error.message });
            return res.status(404).json({ error: 'Profile not found' });
        }

        // Get wallet
        logger.db('SELECT', 'wallets', { userId });
        const { data: wallet } = await supabaseAdmin
            .from('wallets')
            .select('balance, currency, is_locked')
            .eq('user_id', userId)
            .single();

        // Get virtual accounts (if any)
        logger.db('SELECT', 'virtual_accounts', { userId });
        const { data: virtualAccounts } = await supabaseAdmin
            .from('virtual_accounts')
            .select('account_number, bank_name, account_name')
            .eq('user_id', userId)
            .eq('is_active', true);

        const hasCompletedKyc = virtualAccounts && virtualAccounts.length > 0;

        logger.success('Profile fetched', {
            userId,
            role: profile.role,
            hasCompletedKyc
        });

        res.json({
            profile: {
                id: profile.id,
                email: profile.email,
                fullName: profile.full_name,
                phone: profile.phone,
                role: profile.role,
                isVerified: profile.is_verified,
                referralCode: profile.referral_code,
                avatarUrl: profile.avatar_url,
            },
            wallet: wallet ? {
                balance: wallet.balance,
                currency: wallet.currency,
                isLocked: wallet.is_locked,
            } : null,
            virtualAccounts: virtualAccounts?.map(va => ({
                accountNumber: va.account_number,
                bankName: va.bank_name,
                accountName: va.account_name,
            })) || [],
            hasCompletedKyc,
        });
    } catch (err) {
        logger.error('Get profile error', err);
        res.status(500).json({ error: 'Failed to fetch profile' });
    }
});

/**
 * Update user profile
 * PUT /api/auth/profile
 */
router.put('/profile', authenticate, async (req, res) => {
    const userId = req.user.id;
    const { fullName, phone, avatarUrl } = req.body;

    logger.info('Update profile request', { userId, fullName, phone });

    try {
        const updateData = {};
        if (fullName) updateData.full_name = fullName;
        if (phone) updateData.phone = phone;
        if (avatarUrl) updateData.avatar_url = avatarUrl;

        logger.db('UPDATE', 'profiles', { userId, ...updateData });
        const { data: profile, error } = await supabaseAdmin
            .from('profiles')
            .update(updateData)
            .eq('id', userId)
            .select()
            .single();

        if (error) {
            logger.error('Failed to update profile', error);
            return res.status(500).json({ error: 'Failed to update profile' });
        }

        logger.success('Profile updated', { userId });

        res.json({
            success: true,
            profile: {
                id: profile.id,
                email: profile.email,
                fullName: profile.full_name,
                phone: profile.phone,
                role: profile.role,
            },
        });
    } catch (err) {
        logger.error('Update profile error', err);
        res.status(500).json({ error: 'Failed to update profile' });
    }
});

/**
 * Verify email address
 * GET /api/auth/verify-email/:token
 */
router.get('/verify-email/:token', async (req, res) => {
    const { token } = req.params;

    try {
        const { data: profile, error } = await supabaseAdmin
            .from('profiles')
            .select('id, full_name, is_verified, verification_expires')
            .eq('verification_token', token)
            .single();

        if (error || !profile) {
            return res.status(400).json({ error: 'Invalid or expired verification token' });
        }

        if (profile.is_verified) {
            return res.json({ success: true, message: 'Email already verified' });
        }

        if (new Date(profile.verification_expires) < new Date()) {
            return res.status(400).json({ error: 'Verification token has expired' });
        }

        // Update profile
        const { error: updateError } = await supabaseAdmin
            .from('profiles')
            .update({
                is_verified: true,
                verification_token: null,
                verification_expires: null
            })
            .eq('id', profile.id);

        if (updateError) throw updateError;

        // Send success notification
        await createNotification(profile.id, {
            type: 'system',
            title: 'Email Verified! ✅',
            message: 'Your email has been successfully verified. You now have full access to LuckyBasket.',
            actionUrl: '/dashboard'
        });

        res.json({ success: true, message: 'Email verified successfully' });
    } catch (err) {
        logger.error('Email verification error', err);
        res.status(500).json({ error: 'Verification failed' });
    }
});

/**
 * Resend verification email
 * POST /api/auth/resend-verification
 */
router.post('/resend-verification', authenticate, async (req, res) => {
    const userId = req.user.id;
    const email = req.user.email;

    try {
        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('full_name, is_verified')
            .eq('id', userId)
            .single();

        if (!profile) return res.status(404).json({ error: 'Profile not found' });
        if (profile.is_verified) return res.json({ success: true, message: 'Email already verified' });

        const token = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

        await supabaseAdmin
            .from('profiles')
            .update({
                verification_token: token,
                verification_expires: expires
            })
            .eq('id', userId);

        await sendVerificationEmail(email, profile.full_name, token);

        res.json({ success: true, message: 'Verification email resent' });
    } catch (err) {
        logger.error('Resend verification error', err);
        res.status(500).json({ error: 'Failed to resend verification email' });
    }
});

module.exports = router;
