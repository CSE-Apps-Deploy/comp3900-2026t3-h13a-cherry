const crypto = require('crypto');
const { prisma } = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const { hashPassword } = require('../utils/passwords');
const { hasSmtpConfig, sendPasswordResetEmail } = require('../services/emailService');
const logger = require('../config/logger');
const timing = require('../config/sprint1Timing');

const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');

function assertUsableToken(record, now = new Date()) {
    if (!record) throw new AppError('This reset link is invalid. Request a new link.', 400);
    if (record.usedAt)
        throw new AppError('This reset link has already been used. Request a new link.', 400);
    if (record.expiresAt <= now)
        throw new AppError('This reset link has expired. Request a new link.', 410);
}

async function forgotPassword(req, res) {
    if (!hasSmtpConfig())
        throw new AppError(
            'Password reset email is temporarily unavailable. Please try again later.',
            503
        );
    const expiresInMinutes = timing.passwordResetMinutes;
    const startedAt = Date.now();
    const email = req.body.email.trim().toLowerCase();
    const user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, email: true, firstName: true },
    });
    if (user) {
        const token = crypto.randomBytes(32).toString('hex');
        const now = new Date();
        await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
            await tx.passwordResetToken.updateMany({
                where: { userId: user.id, usedAt: null },
                data: { usedAt: now },
            });
            await tx.passwordResetToken.create({
                data: {
                    userId: user.id,
                    tokenHash: tokenHash(token),
                    expiresAt: new Date(now.getTime() + expiresInMinutes * 60000),
                },
            });
        });
        // SMTP runs outside the transaction and does not change the public response.
        sendPasswordResetEmail({
            email: user.email,
            firstName: user.firstName,
            token,
            expiresInMinutes: expiresInMinutes,
        }).catch(() => logger.warn('A password reset email could not be delivered.'));
    }
    await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, 250 - (Date.now() - startedAt)))
    );
    res.json({
        success: true,
        message: `If an account exists for this email, a password reset link will be sent. The link expires in ${expiresInMinutes} minutes.`,
        data: { expiresInMinutes },
    });
}

async function validateResetLink(req, res) {
    const record = await prisma.passwordResetToken.findUnique({
        where: { tokenHash: tokenHash(req.body.token) },
    });
    assertUsableToken(record);
    res.json({ success: true, data: { expiresAt: record.expiresAt } });
}

async function resetPassword(req, res) {
    if (req.body.password !== req.body.confirmPassword)
        throw new AppError('Passwords do not match.', 400);
    const hashedPassword = hashPassword(req.body.password);
    await prisma.$transaction(async (tx) => {
        const record = await tx.passwordResetToken.findUnique({
            where: { tokenHash: tokenHash(req.body.token) },
        });
        if (!record) assertUsableToken(record);
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${record.userId} FOR UPDATE`;
        const now = new Date();
        assertUsableToken(record, now);
        const consumed = await tx.passwordResetToken.updateMany({
            where: { id: record.id, usedAt: null, expiresAt: { gt: now } },
            data: { usedAt: now },
        });
        if (!consumed.count)
            throw new AppError('This reset link is no longer valid. Request a new link.', 400);
        await tx.user.update({
            where: { id: record.userId },
            data: { password: hashedPassword, passwordResetAt: now },
        });
        await tx.passwordResetToken.updateMany({
            where: { userId: record.userId, usedAt: null },
            data: { usedAt: now },
        });
        await tx.refreshToken.deleteMany({ where: { userId: record.userId } });
    });
    res.json({
        success: true,
        message: 'Password reset successfully. Sign in with your new password.',
    });
}

module.exports = { forgotPassword, validateResetLink, resetPassword };
