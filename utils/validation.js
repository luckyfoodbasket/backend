/**
 * Validate and sanitize a monetary amount.
 * Returns { valid: boolean, amount: number, error?: string }
 */
function validateAmount(value, { min = 0, max = Infinity, fieldName = 'Amount' } = {}) {
    // Must be a number
    if (value === undefined || value === null) {
        return { valid: false, amount: 0, error: `${fieldName} is required` };
    }

    const amount = Number(value);

    // Reject NaN, Infinity, non-finite
    if (!Number.isFinite(amount)) {
        return { valid: false, amount: 0, error: `${fieldName} must be a valid number` };
    }

    // Reject negative or zero
    if (amount <= 0) {
        return { valid: false, amount: 0, error: `${fieldName} must be greater than zero` };
    }

    // Reject excessive decimal places (max 2 for currency)
    if (Math.round(amount * 100) / 100 !== amount) {
        return { valid: false, amount: 0, error: `${fieldName} cannot have more than 2 decimal places` };
    }

    if (amount < min) {
        return { valid: false, amount, error: `Minimum ${fieldName.toLowerCase()} is NGN ${min.toLocaleString()}` };
    }

    if (amount > max) {
        return { valid: false, amount, error: `Maximum ${fieldName.toLowerCase()} is NGN ${max.toLocaleString()}` };
    }

    return { valid: true, amount };
}

/**
 * Validate bank code format (Nigerian banks use 3-digit codes)
 */
function validateBankCode(code) {
    if (!code || typeof code !== 'string') {
        return { valid: false, error: 'Bank code is required' };
    }
    if (!/^\d{3}$/.test(code)) {
        return { valid: false, error: 'Invalid bank code format' };
    }
    return { valid: true };
}

module.exports = { validateAmount, validateBankCode };
