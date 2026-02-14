const nodemailer = require('nodemailer');
const { Resend } = require('resend');
const logger = require('../utils/logger');
const dns = require('dns');

// Parse boolean from string or boolean value
const parseBoolean = (value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.toLowerCase() === 'true';
    return false;
};

// ==========================================
// SMTP Transport Configuration (Nodemailer)
// ==========================================
const smtpConfig = {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: parseBoolean(process.env.SMTP_USE_SSL),
    auth: {
        user: process.env.SMTP_USERNAME,
        pass: process.env.SMTP_PASSWORD,
    },
    connectionTimeout: 60000,
    socketTimeout: 60000,
    greetingTimeout: 30000,
    debug: true,
    logger: true,
    tls: { rejectUnauthorized: false }
};

const transporter = nodemailer.createTransport(smtpConfig);

// DNS Lookup for SMTP Host (Diagnostics)
// Only run if we are NOT explicitly using Resend (defaulting to SMTP)
if (process.env.SMTP_HOST && (!process.env.EMAIL_PROVIDER || process.env.EMAIL_PROVIDER === 'smtp')) {
    dns.lookup(process.env.SMTP_HOST, (err, address, family) => {
        if (err) {
            logger.error(`DNS Resolution Failed for ${process.env.SMTP_HOST}:`, err.message);
        } else {
            logger.info(`DNS Resolution Successful: ${process.env.SMTP_HOST} resolved to ${address}`);
        }
    });

    // Verify SMTP connection
    transporter.verify(function (error, success) {
        if (error) {
            logger.error('SMTP Connection Verify Error:', error);
        } else {
            logger.success('SMTP Transport is ready');
        }
    });
}

// ==========================================
// Resend Configuration
// ==========================================
let resend;
if (process.env.RESEND_API_KEY) {
    try {
        resend = new Resend(process.env.RESEND_API_KEY);
        logger.info('Resend API initialized.');
    } catch (error) {
        logger.error('Failed to initialize Resend:', error.message);
    }
}

/**
 * Send email using Nodemailer (SMTP)
 */
async function sendEmailSMTP({ to, subject, text, html }) {
    try {
        logger.info(`[SMTP] Attempting to send using Nodemailer to ${to} subject: ${subject}`);
        const info = await transporter.sendMail({
            from: `"${process.env.SMTP_SENDER_NAME}" <${process.env.SMTP_SENDER_EMAIL}>`,
            to,
            subject,
            text,
            html,
        });
        logger.success('[SMTP] Email sent successfully', { messageId: info.messageId, to });
        return { success: true, messageId: info.messageId };
    } catch (error) {
        logger.error('[SMTP] Failed to send email', { error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Send email using Resend API
 */
async function sendEmailResend({ to, subject, text, html }) {
    if (!resend) {
        throw new Error('Resend API Key is missing or Resend not initialized. Check RESEND_API_KEY env var.');
    }

    try {
        logger.info(`[Resend] Attempting to send using API to ${to} subject: ${subject}`);

        const { data, error } = await resend.emails.send({
            from: process.env.EMAIL_FROM || 'onboarding@resend.dev',
            to: [to],
            subject: subject,
            html: html,
            text: text
        });

        if (error) {
            logger.error('[Resend] API Error:', error);
            throw new Error(error.message || 'Resend API error occurred.');
        }

        logger.success('[Resend] Email sent successfully', { id: data.id, to });
        return { success: true, messageId: data.id };
    } catch (error) {
        logger.error('[Resend] Failed to send email', error);
        throw error;
    }
}

/**
 * Main Send Email Function
 * Switches provider based on EMAIL_PROVIDER env var
 */
async function sendEmail(params) {
    const provider = process.env.EMAIL_PROVIDER || 'smtp'; // default to smtp

    try {
        if (provider.toLowerCase() === 'resend') {
            return await sendEmailResend(params);
        } else {
            return await sendEmailSMTP(params);
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * Send verification email
 */
async function sendVerificationEmail(to, name, token) {
    const verificationUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/verify?token=${token}`;

    const html = `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333; max-width: 600px; margin: auto; border: 1px solid #eee; border-radius: 10px;">
            <h2 style="color: #10b981;">Verify your email</h2>
            <p>Hi ${name},</p>
            <p>Welcome to LuckyBasket! Please click the button below to verify your email address and start winning.</p>
            <div style="text-align: center; margin: 30px 0;">
                <a href="${verificationUrl}" style="background-color: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">Verify Email</a>
            </div>
            <p>Or copy and paste this link in your browser:</p>
            <p style="word-break: break-all; color: #666;">${verificationUrl}</p>
            <p>This link will expire in 24 hours.</p>
            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
            <p style="font-size: 12px; color: #999; text-align: center;">If you didn't create an account, you can safely ignore this email.</p>
        </div>
    `;

    return sendEmail({
        to,
        subject: 'Verify your LuckyBasket account',
        text: `Hi ${name}, verify your LuckyBasket account here: ${verificationUrl}`,
        html
    });
}

module.exports = {
    sendEmail,
    sendVerificationEmail
};
