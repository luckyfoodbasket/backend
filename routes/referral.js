const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const authenticate = require('../middleware/auth');
const logger = require('../utils/logger');
const requireVerification = require('../middleware/requireVerification');

/**
 * Get referral settings (bonus amounts)
 * GET /api/referrals/settings
 */
router.get('/settings', async (req, res) => {
    try {
        const { data: settings, error } = await supabaseAdmin
            .from('settings')
            .select('key, value')
            .in('key', ['referral_bonus_referrer', 'referral_bonus_referred']);

        if (error) {
            logger.error('Failed to fetch referral settings', error);
            return res.status(500).json({ error: 'Failed to fetch settings' });
        }

        const settingsObj = {};
        settings?.forEach(s => {
            settingsObj[s.key] = parseFloat(s.value) || 500;
        });

        res.json({
            referrerBonus: settingsObj.referral_bonus_referrer || 500,
            referredBonus: settingsObj.referral_bonus_referred || 500,
        });
    } catch (error) {
        logger.error('Get referral settings error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Validate a referral code
 * GET /api/referrals/validate/:code
 */
router.get('/validate/:code', async (req, res) => {
    const { code } = req.params;

    if (!code || code.length < 6) {
        return res.status(400).json({ valid: false, error: 'Invalid referral code format' });
    }

    try {
        logger.info('Validating referral code', { code });

        const { data: referrer, error } = await supabaseAdmin
            .from('profiles')
            .select('id, full_name')
            .eq('referral_code', code.toUpperCase())
            .single();

        if (error || !referrer) {
            logger.warn('Referral code not found', { code });
            return res.json({ valid: false });
        }

        logger.success('Referral code valid', { code, referrerId: referrer.id });

        res.json({
            valid: true,
            referrerName: referrer.full_name ? referrer.full_name.split(' ')[0] : 'A friend',
        });
    } catch (error) {
        logger.error('Validate referral code error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Get user's referral stats and list
 * GET /api/referrals
 */
router.get('/', authenticate, requireVerification, async (req, res) => {
    const userId = req.user.id;
    logger.info('Fetching referral data', { userId });

    try {
        // Get user's referral code
        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('referral_code')
            .eq('id', userId)
            .single();

        if (profileError || !profile) {
            logger.error('Profile not found', profileError);
            return res.status(404).json({ error: 'Profile not found' });
        }

        // Get referrals made by this user
        const { data: referrals, error: referralsError } = await supabaseAdmin
            .from('referrals')
            .select(`
                id,
                status,
                referrer_bonus,
                referred_bonus,
                created_at,
                first_purchase_at,
                referred:referred_id (
                    id,
                    full_name,
                    email,
                    created_at
                )
            `)
            .eq('referrer_id', userId)
            .order('created_at', { ascending: false });

        if (referralsError) {
            logger.error('Failed to fetch referrals', referralsError);
            return res.status(500).json({ error: 'Failed to fetch referrals' });
        }

        // Calculate stats
        const totalReferrals = referrals?.length || 0;
        const activeReferrals = referrals?.filter(r => r.status === 'completed').length || 0;
        const pendingReferrals = referrals?.filter(r => r.status === 'pending').length || 0;
        const totalEarned = referrals?.reduce((sum, r) => sum + (parseFloat(r.referrer_bonus) || 0), 0) || 0;
        const pendingEarnings = pendingReferrals * 500; // Potential earnings from pending referrals

        logger.success('Referral data fetched', {
            userId,
            totalReferrals,
            activeReferrals,
            totalEarned
        });

        res.json({
            referralCode: profile.referral_code,
            referralLink: `${process.env.FRONTEND_URL || 'https://luckybasket.com'}/auth/register?ref=${profile.referral_code}`,
            stats: {
                totalReferrals,
                activeReferrals,
                pendingReferrals,
                totalEarned,
                pendingEarnings,
            },
            referrals: referrals?.map(r => ({
                id: r.id,
                name: r.referred?.full_name || 'Anonymous',
                email: r.referred?.email ? maskEmail(r.referred.email) : '',
                date: r.created_at,
                status: r.status,
                earned: parseFloat(r.referrer_bonus) || 0,
                firstPurchaseAt: r.first_purchase_at,
            })) || [],
        });
    } catch (error) {
        logger.error('Get referrals error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Helper function to mask email addresses
 */
function maskEmail(email) {
    if (!email) return '';
    const [name, domain] = email.split('@');
    if (!name || !domain) return email;
    const maskedName = name.substring(0, 3) + '***';
    return `${maskedName}@${domain}`;
}

module.exports = router;
