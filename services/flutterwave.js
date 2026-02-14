const axios = require('axios');
require('dotenv').config();
const logger = require('../utils/logger');

const FLW_SECRET_KEY = process.env.FLUTTERWAVE_SECRET_KEY;
const FLW_BASE_URL = process.env.FLUTTERWAVE_BASE_URL || 'https://api.flutterwave.com/v3';

if (!FLW_SECRET_KEY) {
    throw new Error('Missing required environment variable: FLUTTERWAVE_SECRET_KEY');
}

/**
 * Pre-configured Flutterwave HTTP client
 */
const flwClient = axios.create({
    baseURL: FLW_BASE_URL,
    timeout: 30000, // 30 second timeout
    headers: {
        'Authorization': `Bearer ${FLW_SECRET_KEY}`,
        'Content-Type': 'application/json',
    },
});

/**
 * Initialize a Flutterwave Standard payment (redirect checkout)
 * @param {object} options - { amount, email, name, tx_ref, redirect_url, meta }
 * @returns {{ success: boolean, data?: { link: string, tx_ref: string }, error?: string }}
 */
const initializePayment = async ({ amount, email, name, tx_ref, redirect_url, meta }) => {
    const ref = tx_ref || `LB_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    logger.api('Flutterwave', 'Initializing payment', { amount, email, tx_ref: ref });

    try {
        const response = await flwClient.post('/payments', {
            tx_ref: ref,
            amount,
            currency: 'NGN',
            redirect_url,
            customer: {
                email,
                name: name || 'LuckyBasket User',
            },
            customizations: {
                title: 'LuckyBasket Wallet Top-up',
                description: `Fund wallet with NGN ${amount}`,
                logo: null,
            },
            meta: meta || {},
        });

        if (response.data.status === 'success') {
            logger.success('Payment initialized', { tx_ref: ref, link: response.data.data.link });
            return {
                success: true,
                data: {
                    link: response.data.data.link,
                    tx_ref: ref,
                },
            };
        }

        throw new Error(response.data.message || 'Failed to initialize payment');
    } catch (error) {
        const message = error.response?.data?.message || error.message;
        logger.error('Flutterwave payment initialization failed', error);
        return { success: false, error: message };
    }
};

/**
 * Verify a transaction by its ID
 * @param {string|number} transactionId - Flutterwave transaction ID
 * @returns {{ success: boolean, data?: object, error?: string }}
 */
const verifyTransaction = async (transactionId) => {
    logger.api('Flutterwave', 'Verifying transaction', { transactionId });

    try {
        const response = await flwClient.get(`/transactions/${transactionId}/verify`);

        if (response.data.status === 'success' && response.data.data.status === 'successful') {
            logger.success('Transaction verified', {
                transactionId,
                amount: response.data.data.amount,
                tx_ref: response.data.data.tx_ref,
            });
            return { success: true, data: response.data.data };
        }

        return {
            success: false,
            error: `Transaction status: ${response.data.data?.status || 'unknown'}`,
            data: response.data.data,
        };
    } catch (error) {
        const message = error.response?.data?.message || error.message;
        logger.error('Flutterwave transaction verification failed', error);
        return { success: false, error: message };
    }
};

/**
 * Verify webhook authenticity
 * @param {string} webhookHash - The verif-hash header from the webhook request
 * @returns {boolean}
 */
const verifyWebhookSignature = (webhookHash) => {
    const secretHash = process.env.FLW_WEBHOOK_SECRET;

    if (!secretHash) {
        logger.error('CRITICAL: FLW_WEBHOOK_SECRET not configured. All webhooks will be rejected. Set this env variable immediately.');
        return false;
    }

    if (!webhookHash) {
        logger.warn('Webhook received without verif-hash header');
        return false;
    }

    return webhookHash === secretHash;
};

/**
 * Initiate a bank transfer (for vendor withdrawals)
 * @param {object} options - { account_bank, account_number, amount, narration, reference, currency }
 * @returns {{ success: boolean, data?: object, error?: string }}
 */
const initiateTransfer = async ({ account_bank, account_number, amount, narration, reference, currency = 'NGN' }) => {
    logger.api('Flutterwave', 'Initiating transfer', { account_bank, account_number, amount, reference });

    try {
        const response = await flwClient.post('/transfers', {
            account_bank,
            account_number,
            amount,
            narration: narration || 'LuckyBasket Vendor Withdrawal',
            currency,
            reference: reference || `LB_WD_${Date.now()}`,
            debit_currency: 'NGN',
        });

        if (response.data.status === 'success') {
            logger.success('Transfer initiated', {
                reference,
                transferId: response.data.data?.id,
                status: response.data.data?.status,
            });
            return { success: true, data: response.data.data };
        }

        throw new Error(response.data.message || 'Failed to initiate transfer');
    } catch (error) {
        const message = error.response?.data?.message || error.message;
        logger.error('Flutterwave transfer initiation failed', error);
        return { success: false, error: message };
    }
};

/**
 * Get list of banks for a country
 * @param {string} country - Country code (default: 'NG')
 * @returns {{ success: boolean, data?: Array, error?: string }}
 */
const getBanks = async (country = 'NG') => {
    logger.api('Flutterwave', 'Fetching banks', { country });

    try {
        const response = await flwClient.get(`/banks/${country}`);

        if (response.data.status === 'success') {
            logger.success('Banks fetched', { count: response.data.data?.length });
            return { success: true, data: response.data.data };
        }

        throw new Error(response.data.message || 'Failed to fetch banks');
    } catch (error) {
        const message = error.response?.data?.message || error.message;
        logger.error('Flutterwave fetch banks failed', error);
        return { success: false, error: message };
    }
};

/**
 * Resolve/verify a bank account
 * @param {string} accountNumber
 * @param {string} bankCode
 * @returns {{ success: boolean, data?: { account_number, account_name }, error?: string }}
 */
const resolveAccount = async (accountNumber, bankCode) => {
    logger.api('Flutterwave', 'Resolving account', { accountNumber, bankCode });

    try {
        const response = await flwClient.post('/accounts/resolve', {
            account_number: accountNumber,
            account_bank: bankCode,
        });

        if (response.data.status === 'success') {
            logger.success('Account resolved', {
                accountName: response.data.data?.account_name,
            });
            return { success: true, data: response.data.data };
        }

        throw new Error(response.data.message || 'Failed to resolve account');
    } catch (error) {
        const message = error.response?.data?.message || error.message;
        logger.error('Flutterwave account resolution failed', error);
        return { success: false, error: message };
    }
};

/**
 * Create a virtual account (for direct bank transfer deposits)
 * @param {object} options - { email, bvn, firstname, lastname, phonenumber, narration, is_permanent }
 * @returns {{ success: boolean, data?: object, error?: string }}
 */
const createVirtualAccount = async ({
    email,
    bvn,
    firstname,
    lastname,
    phonenumber,
    narration,
    is_permanent = true,
    tx_ref,
}) => {
    const ref = tx_ref || `LB_VDA_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    logger.api('Flutterwave', 'Creating virtual account', {
        email,
        hasBvn: !!bvn,
        is_permanent,
        tx_ref: ref,
    });

    try {
        const payload = {
            email,
            is_permanent,
            tx_ref: ref,
            narration: narration || 'LuckyBasket Wallet',
        };

        // Add optional fields
        if (bvn) payload.bvn = bvn;
        if (firstname) payload.firstname = firstname;
        if (lastname) payload.lastname = lastname;
        if (phonenumber) payload.phonenumber = phonenumber;

        const response = await flwClient.post('/virtual-account-numbers', payload);

        if (response.data.status === 'success') {
            logger.success('Virtual account created', {
                account_number: response.data.data?.account_number,
                bank_name: response.data.data?.bank_name,
                tx_ref: ref,
            });
            return { success: true, data: response.data.data };
        }

        throw new Error(response.data.message || 'Failed to create virtual account');
    } catch (error) {
        const message = error.response?.data?.message || error.message;
        logger.error('Flutterwave virtual account creation failed', error);
        return { success: false, error: message };
    }
};

/**
 * Get virtual account details by order reference
 * @param {string} orderRef - The order_ref from virtual account creation
 * @returns {{ success: boolean, data?: object, error?: string }}
 */
const getVirtualAccount = async (orderRef) => {
    logger.api('Flutterwave', 'Getting virtual account', { orderRef });

    try {
        const response = await flwClient.get(`/virtual-account-numbers/${orderRef}`);

        if (response.data.status === 'success') {
            logger.success('Virtual account retrieved', { orderRef });
            return { success: true, data: response.data.data };
        }

        throw new Error(response.data.message || 'Failed to get virtual account');
    } catch (error) {
        const message = error.response?.data?.message || error.message;
        logger.error('Flutterwave get virtual account failed', error);
        return { success: false, error: message };
    }
};

/**
 * Initiate a direct bank transfer charge (used for VDA deposit testing in sandbox)
 * POST /v3/charges?type=bank_transfer
 * @param {object} options - { amount, email, tx_ref }
 * @returns {{ success: boolean, data?: object, error?: string }}
 */
const chargeBankTransfer = async ({ amount, email, tx_ref }) => {
    const ref = tx_ref || `LB_BT_${Date.now()}`;

    logger.api('Flutterwave', 'Initiating bank transfer charge', { amount, email, tx_ref: ref });

    try {
        const response = await flwClient.post('/charges?type=bank_transfer', {
            tx_ref: ref,
            amount,
            email,
            currency: 'NGN',
        });

        if (response.data.status === 'success') {
            logger.success('Bank transfer charge initiated', { tx_ref: ref });
            return { success: true, data: response.data };
        }

        throw new Error(response.data.message || 'Failed to initiate bank transfer charge');
    } catch (error) {
        const message = error.response?.data?.message || error.message;
        logger.error('Flutterwave bank transfer charge failed', error);
        return { success: false, error: message };
    }
};

module.exports = {
    initializePayment,
    verifyTransaction,
    verifyWebhookSignature,
    initiateTransfer,
    getBanks,
    resolveAccount,
    createVirtualAccount,
    getVirtualAccount,
    chargeBankTransfer,
};
