const crypto = require('crypto');
const { supabaseAdmin } = require('../config/supabase');
const logger = require('../utils/logger');
const { createNotification } = require('../routes/notifications');

/**
 * Resolves and validates a referral code
 * @param {string} referralCode - The referral code to validate
 * @param {string} userId - The current user's ID (to prevent self-referral)
 * @returns {Promise<{referrerId: string|null, referredBonus: number}>}
 */
async function resolveReferral(referralCode, userId) {
    if (!referralCode || !referralCode.trim()) {
        return { referrerId: null, referredBonus: 0 };
    }

    const code = referralCode.trim().toUpperCase();
    logger.info('Validating referral code', { code });

    // Find the referrer by code
    const { data: referrer, error: referrerError } = await supabaseAdmin
        .from('profiles')
        .select('id, full_name')
        .eq('referral_code', code)
        .single();

    // Check if referral is valid
    if (!referrer) {
        logger.warn('Invalid referral code provided', { code });
        return { referrerId: null, referredBonus: 0 };
    }

    if (referrer.id === userId) {
        logger.warn('User tried to use own referral code', { userId, code });
        return { referrerId: null, referredBonus: 0 };
    }

    // Get bonus amount from platform_settings
    const { data: settingsRow } = await supabaseAdmin
        .from('platform_settings')
        .select('settings')
        .eq('id', 1)
        .single();

    const config = settingsRow?.settings || {};
    const referredBonus = config.referralBonusReferee || config.referralBonus || 500;

    logger.success('Valid referral code found', {
        referrerId: referrer.id,
        referrerName: referrer.full_name,
        bonus: referredBonus
    });

    return { referrerId: referrer.id, referredBonus };
}

/**
 * Creates or updates a user profile with verification token
 * @param {string} userId - User's Supabase auth ID
 * @param {string} email - User's email
 * @param {object} profileInfo - Profile data {fullName, phone}
 * @param {string|null} referrerId - ID of the user who referred them
 * @returns {Promise<{existingProfile: object|null, verificationToken: string}>}
 */
async function upsertProfile(userId, email, profileInfo, referrerId = null) {
    const { fullName, phone } = profileInfo;

    // Check if profile already exists
    logger.db('SELECT', 'profiles', { userId });
    const { data: existingProfile } = await supabaseAdmin
        .from('profiles')
        .select('id, referred_by')
        .eq('id', userId)
        .single();

    // Generate verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');

    // Build profile data
    const profileData = {
        id: userId,
        email: email,
        full_name: fullName,
        phone: phone || null,
        verification_token: verificationToken,
        verification_expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours
    };

    // Only set referred_by if there's a referrer and user doesn't already have one
    if (referrerId && (!existingProfile || !existingProfile.referred_by)) {
        profileData.referred_by = referrerId;
    }

    // Create or update profile
    if (existingProfile) {
        logger.info('Updating existing profile', { userId });
        logger.db('UPDATE', 'profiles', profileData);
        await supabaseAdmin
            .from('profiles')
            .update(profileData)
            .eq('id', userId);
    } else {
        logger.info('Creating new profile', { userId });
        logger.db('INSERT', 'profiles', profileData);
        const { error: insertError } = await supabaseAdmin
            .from('profiles')
            .insert(profileData);

        if (insertError && insertError.code !== '23505') {
            logger.error('Failed to create profile', insertError);
            throw insertError;
        }
    }

    return { existingProfile, verificationToken };
}

/**
 * Ensures a wallet exists for the user, creates one if it doesn't
 * @param {string} userId - User's ID
 * @returns {Promise<{id: string, balance: number}|null>}
 */
async function ensureWallet(userId) {
    logger.db('SELECT', 'wallets', { userId });
    let { data: wallet } = await supabaseAdmin
        .from('wallets')
        .select('id, balance')
        .eq('user_id', userId)
        .single();

    if (!wallet) {
        logger.info('Creating wallet for new user', { userId });
        logger.db('INSERT', 'wallets', { userId, balance: 0 });
        const { data: newWallet, error: walletError } = await supabaseAdmin
            .from('wallets')
            .insert({ user_id: userId, balance: 0 })
            .select('id, balance')
            .single();

        if (walletError) {
            logger.error('Failed to create wallet', walletError);
            return null;
        }

        wallet = newWallet;
        logger.success('Wallet created', { walletId: newWallet.id });
    }

    return wallet;
}

/**
 * Processes referral bonus for a newly registered user
 * @param {string} userId - New user's ID
 * @param {string} referrerId - Referrer's ID
 * @param {object} wallet - User's wallet object {id, balance}
 * @param {number} referredBonus - Bonus amount to credit
 * @returns {Promise<number>} - New wallet balance
 */
async function processReferralBonus(userId, referrerId, wallet, referredBonus) {
    // Check if referral already exists (prevent duplicate records)
    const { data: existingReferral } = await supabaseAdmin
        .from('referrals')
        .select('id')
        .eq('referred_id', userId)
        .single();

    if (existingReferral) {
        logger.info('Referral record already exists', { userId, referrerId });
        return wallet.balance;
    }

    // Create referral record in 'pending' status
    // Bonus is only credited after the first ticket purchase
    logger.info('Creating pending referral record', { referrerId, referredId: userId });
    const { error: referralError } = await supabaseAdmin
        .from('referrals')
        .insert({
            referrer_id: referrerId,
            referred_id: userId,
            status: 'pending',
            referred_bonus: referredBonus,
        });

    if (referralError) {
        logger.error('Failed to create referral record', referralError);
        return wallet.balance;
    }

    // Send notification to referrer that someone used their code
    await createNotification(referrerId, {
        type: 'referral',
        title: 'New Referral! 🎊',
        message: `Someone signed up using your referral code! They need to buy their first ticket for you both to earn a bonus.`,
        actionUrl: '/referrals',
        metadata: { referredUserId: userId, status: 'pending' }
    });

    // NOTE: We don't credit the wallet here anymore. 
    // It happens in the ticket purchase route via credit_referral_bonus RPC.

    return wallet.balance;
}

module.exports = {
    resolveReferral,
    upsertProfile,
    ensureWallet,
    processReferralBonus,
};
