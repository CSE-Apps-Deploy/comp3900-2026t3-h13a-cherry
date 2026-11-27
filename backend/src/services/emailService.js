const nodemailer = require('nodemailer');

const logger = require('../config/logger');

const normalizeUrl = (value = '') => String(value || '').trim().replace(/\/+$/, '');

const parseBoolean = (value, fallback = false) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    }
    return fallback;
};

const getFrontendUrl = () => normalizeUrl(process.env.FRONTEND_URL || 'http://localhost:8080');

const getVerificationUrl = (token) =>
    `${getFrontendUrl()}/verify-email?token=${encodeURIComponent(token)}`;

const getMailFrom = () => process.env.EMAIL_FROM || 'TutorConnect <no-reply@tutorconnect.local>';

const getVerificationMailboxUrl = () => {
    const mailboxUrl = normalizeUrl(process.env.DEV_MAILBOX_URL || '');
    const smtpHost = String(process.env.SMTP_HOST || '').trim().toLowerCase();
    const smtpUrl = String(process.env.SMTP_URL || '').trim().toLowerCase();

    if (!mailboxUrl) {
        return '';
    }

    if (smtpHost === 'mailpit' || smtpUrl.includes('mailpit')) {
        return mailboxUrl;
    }

    return '';
};

const hasSmtpConfig = () =>
    Boolean(process.env.SMTP_URL || (process.env.SMTP_HOST && process.env.SMTP_PORT));

let cachedTransporter = null;

const getTransporter = () => {
    if (cachedTransporter) return cachedTransporter;

    if (process.env.SMTP_URL) {
        cachedTransporter = nodemailer.createTransport(process.env.SMTP_URL);
        return cachedTransporter;
    }

    if (!hasSmtpConfig()) {
        return null;
    }

    cachedTransporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: parseBoolean(process.env.SMTP_SECURE, false),
        auth:
            process.env.SMTP_USER || process.env.SMTP_PASS
                ? {
                      user: process.env.SMTP_USER || '',
                      pass: process.env.SMTP_PASS || '',
                  }
                : undefined,
    });

    return cachedTransporter;
};

async function sendVerificationEmail({ email, firstName, token }) {
    const verificationUrl = getVerificationUrl(token);
    const transporter = getTransporter();
    const mailboxUrl = getVerificationMailboxUrl();

    if (!transporter) {
        logger.info(`Email verification link for ${email}: ${verificationUrl}`);
        return {
            delivered: false,
            deliveryMethod: 'log',
            verificationUrl,
        };
    }

    const recipientName = String(firstName || '').trim() || 'there';

    await transporter.sendMail({
        from: getMailFrom(),
        to: email,
        subject: 'Verify your TutorConnect email',
        text: `Hi ${recipientName}, verify your TutorConnect account: ${verificationUrl}`,
        html: `
          <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
            <h2 style="margin-bottom: 12px;">Verify your TutorConnect account</h2>
            <p>Hi ${recipientName},</p>
            <p>Thanks for registering. Please verify your email address to activate your account.</p>
            <p>
              <a href="${verificationUrl}" style="display: inline-block; padding: 12px 18px; background: #0891b2; color: #ffffff; border-radius: 10px; text-decoration: none; font-weight: 600;">
                Verify Email
              </a>
            </p>
            <p>If the button does not work, copy and paste this link into your browser:</p>
            <p><a href="${verificationUrl}">${verificationUrl}</a></p>
            <p>This link will expire in 24 hours.</p>
          </div>
        `,
    });

    return {
        delivered: true,
        deliveryMethod: 'smtp',
        ...(mailboxUrl ? { mailboxUrl } : {}),
    };
}

async function sendPasswordResetEmail({ email, firstName, token, expiresInMinutes = 30 }) {
    const transporter = getTransporter();
    if (!transporter) {
        throw new Error('SMTP is required for password reset emails.');
    }

    const resetUrl = `${getFrontendUrl()}/reset-password?token=${encodeURIComponent(token)}`;
    await transporter.sendMail({
        from: getMailFrom(),
        to: email,
        subject: 'Reset your TutorConnect password',
        text: `Reset your TutorConnect password: ${resetUrl}\nThis link expires in ${expiresInMinutes} minutes and can only be used once. If you did not request this, ignore this email.`,
        html: `
          <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
            <h2>Reset your TutorConnect password</h2>
            <p><a href="${resetUrl}">Reset Password</a></p>
            <p>This link expires in ${expiresInMinutes} minutes and can only be used once.</p>
            <p>If you did not request this, ignore this email.</p>
          </div>
        `,
    });
    return { delivered: true, deliveryMethod: 'smtp' };
}


async function sendMeetingLinkUpdatedEmail({ email, subject, scheduledAt, duration, timezone, meetingLink, bookingId }) {
    const transporter = getTransporter();
    if (!transporter) throw new Error('SMTP is required for meeting link update emails.');
    const { formatLessonTimeForUser } = require('../utils/timezone');
    const lessonTime = formatLessonTimeForUser(scheduledAt, timezone);
    const bookingUrl = `${getFrontendUrl()}/bookings/${encodeURIComponent(bookingId)}`;
    const escapeHtml = (value) => String(value || '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
    await transporter.sendMail({
        from: getMailFrom(),
        to: email,
        subject: 'Your TutorConnect meeting link was updated',
        text: `Your tutor updated the meeting link for ${subject}.\nLesson: ${lessonTime} (${duration} minutes)\nMeeting link: ${meetingLink}\nView booking: ${bookingUrl}`,
        html: `
          <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
            <h2>Your meeting link was updated</h2>
            <p>Your tutor updated the meeting link for ${escapeHtml(subject)}.</p>
            <p>${escapeHtml(lessonTime)} · ${Number(duration)} minutes</p>
            <p><a href="${escapeHtml(meetingLink)}">Open meeting link</a></p>
            <p><a href="${escapeHtml(bookingUrl)}">View booking</a></p>
          </div>
        `,
    });
    return { delivered: true, deliveryMethod: 'smtp' };
}

module.exports = {
    getVerificationUrl,
    hasSmtpConfig,
    sendVerificationEmail,
    sendPasswordResetEmail,
    sendMeetingLinkUpdatedEmail,
};
