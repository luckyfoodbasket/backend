/**
 * Simple Logger Utility for LuckyBasket API
 * Logs to console with timestamps and colored output
 */

const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
};

const getTimestamp = () => {
    return new Date().toISOString();
};

const formatMessage = (level, message, data = null) => {
    const timestamp = getTimestamp();
    const dataStr = data ? `\n${JSON.stringify(data, null, 2)}` : '';
    return `[${timestamp}] [${level}] ${message}${dataStr}`;
};

const logger = {
    info: (message, data = null) => {
        console.log(`${colors.cyan}${formatMessage('INFO', message, data)}${colors.reset}`);
    },

    success: (message, data = null) => {
        console.log(`${colors.green}${formatMessage('SUCCESS', message, data)}${colors.reset}`);
    },

    warn: (message, data = null) => {
        console.warn(`${colors.yellow}${formatMessage('WARN', message, data)}${colors.reset}`);
    },

    error: (message, error = null) => {
        const errorData = error ? {
            message: error.message,
            stack: error.stack,
            ...(error.response?.data && { response: error.response.data }),
        } : null;
        console.error(`${colors.red}${formatMessage('ERROR', message, errorData)}${colors.reset}`);
    },

    request: (req) => {
        const { method, originalUrl, ip, headers } = req;
        console.log(`${colors.blue}${formatMessage('REQUEST', `${method} ${originalUrl}`, {
            ip: ip || headers['x-forwarded-for'],
            userAgent: headers['user-agent']?.substring(0, 50),
            userId: req.user?.id || 'anonymous',
        })}${colors.reset}`);
    },

    response: (req, statusCode, duration) => {
        const color = statusCode >= 400 ? colors.red : statusCode >= 300 ? colors.yellow : colors.green;
        console.log(`${color}${formatMessage('RESPONSE', `${req.method} ${req.originalUrl} - ${statusCode}`, {
            duration: `${duration}ms`,
            userId: req.user?.id || 'anonymous',
        })}${colors.reset}`);
    },

    api: (service, action, data = null) => {
        console.log(`${colors.magenta}${formatMessage('API', `[${service}] ${action}`, data)}${colors.reset}`);
    },

    db: (operation, table, data = null) => {
        console.log(`${colors.gray}${formatMessage('DB', `${operation} on ${table}`, data)}${colors.reset}`);
    },
};

module.exports = logger;
