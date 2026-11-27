const { AppError } = require('../middleware/errorHandler');
// for token
const crypto = require('crypto');
const { prisma } = require('../config/database');
const { sendVerificationEmail } = require('../services/emailService');
const { hashPassword, comparePassword, passwordNeedsRehash, isValidNewPassword } = require('../utils/passwords');
const { createAccessToken, createRefreshToken, verifyRefreshToken } = require('../utils/tokens');

const toBoolean = (value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        return normalized === 'true' || normalized === '1';
    }
    return false;
};

const normalizeIpAddress = (value) => {
    const rawValue = Array.isArray(value) ? value[0] : value;
    const candidate = String(rawValue || '')
        .split(',')[0]
        .trim();

    if (!candidate || candidate.toLowerCase() === 'unknown') {
        return null;
    }

    if (candidate === '::1') {
        return '127.0.0.1';
    }

    return candidate.replace(/^::ffff:/i, '');
};

const getRequestIpAddress = (req) =>
    normalizeIpAddress(
        req.headers['x-forwarded-for'] ||
            req.headers['x-real-ip'] ||
            req.ip ||
            req.socket?.remoteAddress
    );

const authUserSelect = {
    id: true,
    email: true,
    firstName: true,
    lastName: true,
    timezone: true,
    role: true,
    status: true,
    avatar: true,
    phone: true,
    bio: true,
    createdAt: true,
    lastLoginAt: true,
    passwordResetAt: true,
    isEmailVerified: true,
    tutorProfile: {
        select: {
            id: true,
            status: true,
            applicationSubmitted: true,
            isVerified: true,
        },
    },
};

const authUserSelectWithPassword = {
    ...authUserSelect,
    password: true,
};

// user authentication and registration logic
const serializeAuthUser = (user, ipAddress = null) => ({
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    timezone: user.timezone || null,
    role: user.role,
    status: user.status,
    avatar: user.avatar || null,
    phone: user.phone || null,
    bio: user.bio || null,
    createdAt: user.createdAt || null,
    lastLoginAt: user.lastLoginAt || null,
    ipAddress,
    isEmailVerified: Boolean(user.isEmailVerified),
    tutorProfileId: user.tutorProfile?.id || null,
    tutorProfile: user.tutorProfile
        ? {
              id: user.tutorProfile.id,
              status: user.tutorProfile.status,
              applicationSubmitted: Boolean(user.tutorProfile.applicationSubmitted),
              isVerified: Boolean(user.tutorProfile.isVerified),
          }
        : null,
});

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const createEmailVerificationToken = () => crypto.randomBytes(32).toString('hex');

const createEmailVerificationExpiry = () => {
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);
    return expiresAt;
};

const isEmailVerificationRequired = () => {
    const setting = process.env.EMAIL_VERIFICATION_REQUIRED;

    if (setting === 'false') {
        return false;
    }

    return true;
};

async function register(req, res) {
    const {
        email,
        password,
        firstName,
        lastName,
        role,
        isMinor,
        parentName,
        parentEmail,
        parentPhone,
    } = req.body;

    const normalizedEmail = normalizeEmail(email);
    const normalizedFirstName = String(firstName || '').trim();
    const normalizedLastName = String(lastName || '').trim();
    const normalizedRole = String(role || 'LEARNER').trim().toUpperCase();
    const emailVerificationToken = createEmailVerificationToken();
    const emailVerificationExpiry = createEmailVerificationExpiry();
    const hashedPassword = hashPassword(password);

    if (!normalizedEmail || !password || !normalizedFirstName || !normalizedLastName) {
        return res.status(400).json({
            success: false,
            message: 'Email, password, first name and last name are required.',
        });
    }

    if (!isValidNewPassword(password)) {
        return res.status(400).json({
            success: false,
            message: 'Password must contain 8-20 characters, including uppercase, lowercase, a number and a supported special character.',
        });
    }

    if (!['LEARNER', 'TUTOR'].includes(normalizedRole)) {
        return res.status(400).json({
            success: false,
            message: 'Role must be LEARNER or TUTOR.',
        });
    }

    if (normalizedRole === 'LEARNER' && toBoolean(isMinor) && !String(parentName || '').trim()) {
        return res.status(400).json({
            success: false,
            message: 'Parent/guardian name is required for minors.',
        });
    }

    const existingUser = await prisma.user.findUnique({
        where: { email: normalizedEmail },
    });

    if (existingUser) {
        return res.status(409).json({
            success: false,
            message: 'User already exists.',
        });
    }

    const user = await prisma.user.create({
        data: {
            email: normalizedEmail,
            password: hashedPassword,
            firstName: normalizedFirstName,
            lastName: normalizedLastName,
            role: normalizedRole,
            isEmailVerified: false,
            emailVerificationToken,
            emailVerificationExpiry,
            ...(normalizedRole === 'LEARNER'
                ? {
                      learnerProfile: {
                          create: {
                              subjects: [],
                              isMinor: toBoolean(isMinor),
                              parentName: String(parentName || '').trim() || null,
                              parentEmail: String(parentEmail || '').trim() || null,
                              parentPhone: String(parentPhone || '').trim() || null,
                          },
                      },
                  }
                : {
                      tutorProfile: {
                          create: {
                              applicationSubmitted: false,
                              status: 'SUSPENDED',
                              yearsExperience: 0,
                              education: [],
                              certifications: [],
                              isVerified: false,
                              verifiedAt: null,
                          },
                      },
                  }),
        },
        select: authUserSelect,
    });

    const emailResult = await sendVerificationEmail({
        email: normalizedEmail,
        firstName: normalizedFirstName,
        token: emailVerificationToken,
    });

    return res.status(201).json({
        success: true,
        message:
            normalizedRole === 'TUTOR'
                ? 'Registration successful. Please verify your email, then complete tutor verification after your first login.'
                : 'Registration successful. Please check your email to verify your account.',
        user: serializeAuthUser(user),
        verificationDelivery: emailResult.deliveryMethod,
        ...(emailResult.mailboxUrl ? { verificationMailboxUrl: emailResult.mailboxUrl } : {}),
        ...(emailResult.verificationUrl ? { verificationUrl: emailResult.verificationUrl } : {}),
    });
}

async function login(req, res) {
    const { email, password } = req.body;
    const normalizedEmail = normalizeEmail(email);

    if (!normalizedEmail || !password) {
        return res.status(400).json({
            success: false,
            message: 'Email and password are required.',
        });
    }

    const user = await prisma.user.findUnique({
        where: { email: normalizedEmail },
        select: authUserSelectWithPassword,
    });

    const passwordMatches = user ? comparePassword(password, user.password) : false;

    if (!user || !passwordMatches) {
        return res.status(401).json({
            success: false,
            message: 'Invalid email or password.',
        });
    }

    if (user.status !== 'ACTIVE') {
        return res.status(403).json({ success: false, message: 'This account is not active. Please contact support.' });
    }

    if (isEmailVerificationRequired() && !user.isEmailVerified) {
        return res.status(403).json({
            success: false,
            message: 'Please verify your email before logging in.',
        });
    }

    const authenticatedUser = await prisma.user.update({
        where: { id: user.id },
        data: {
            lastLoginAt: new Date(),
            ...(passwordNeedsRehash(user.password) ? { password: hashPassword(password) } : {}),
        },
        select: authUserSelect,
    });

    const ipAddress = getRequestIpAddress(req);

    return res.status(200).json({
        success: true,
        message: 'Login successful.',
        accessToken: createAccessToken(authenticatedUser),
        refreshToken: createRefreshToken(authenticatedUser),
        user: serializeAuthUser(authenticatedUser, ipAddress),
    });
}

async function verifyEmail(req, res) {
    const token = String(req.query.token || req.body?.token || '').trim();

    if (!token) {
        return res.status(400).json({
            success: false,
            message: 'Verification token is required.',
        });
    }

    const user = await prisma.user.findUnique({
        where: { emailVerificationToken: token },
        select: {
            id: true,
            emailVerificationExpiry: true,
            isEmailVerified: true,
        },
    });

    if (!user) {
        return res.status(400).json({
            success: false,
            message: 'This verification link is invalid or has expired.',
        });
    }

    if (user.isEmailVerified) {
        return res.status(200).json({
            success: true,
            message: 'Email is already verified.',
        });
    }

    if (!user.emailVerificationExpiry || user.emailVerificationExpiry.getTime() < Date.now()) {
        return res.status(400).json({
            success: false,
            message: 'This verification link is invalid or has expired.',
        });
    }

    await prisma.user.update({
        where: { id: user.id },
        data: {
            isEmailVerified: true,
            emailVerificationToken: null,
            emailVerificationExpiry: null,
        },
    });

    return res.status(200).json({
        success: true,
        message: 'Email verified successfully.',
    });
}

async function resendVerification(req, res) {
    const normalizedEmail = normalizeEmail(req.body?.email);

    if (!normalizedEmail) {
        return res.status(400).json({
            success: false,
            message: 'Email is required.',
        });
    }

    const user = await prisma.user.findUnique({
        where: { email: normalizedEmail },
        select: {
            id: true,
            email: true,
            firstName: true,
            isEmailVerified: true,
        },
    });

    if (!user) {
        return res.status(404).json({
            success: false,
            message: 'No account found for this email.',
        });
    }

    if (user.isEmailVerified) {
        return res.status(400).json({
            success: false,
            message: 'This email is already verified.',
        });
    }

    const emailVerificationToken = createEmailVerificationToken();
    const emailVerificationExpiry = createEmailVerificationExpiry();

    await prisma.user.update({
        where: { id: user.id },
        data: {
            emailVerificationToken,
            emailVerificationExpiry,
        },
    });

    const emailResult = await sendVerificationEmail({
        email: user.email,
        firstName: user.firstName,
        token: emailVerificationToken,
    });

    return res.status(200).json({
        success: true,
        message: 'Verification email resent.',
        verificationDelivery: emailResult.deliveryMethod,
        ...(emailResult.mailboxUrl ? { verificationMailboxUrl: emailResult.mailboxUrl } : {}),
        ...(emailResult.verificationUrl ? { verificationUrl: emailResult.verificationUrl } : {}),
    });
}

async function refreshToken(req, res) {
    const { refreshToken } = req.body;

    if (!refreshToken) {
        return res.status(400).json({
            success: false,
            message: 'Refresh token is required.',
        });
    }

    let payload;

    try {
        payload = verifyRefreshToken(refreshToken);
    } catch (error) {
        return res.status(401).json({
            success: false,
            message: 'Invalid refresh token.',
        });
    }

    const user = await prisma.user.findUnique({
        where: { id: payload.id },
        select: authUserSelect,
    });

    if (!user) {
        return res.status(404).json({
            success: false,
            message: 'User not found.',
        });
    }

    if (user.status !== 'ACTIVE') {
        return res.status(403).json({ success: false, message: 'This account is not active. Please contact support.' });
    }

    // ACC-01: reject refresh tokens issued before the latest password reset.
    if (user.passwordResetAt && payload.passwordResetAt !== user.passwordResetAt.toISOString()) {
        return res.status(401).json({ success: false, message: 'Password changed. Please sign in again.' });
    }

    return res.status(200).json({
        success: true,
        message: 'Token refreshed.',
        accessToken: createAccessToken(user),
    });
}

async function logout(req, res) {
    return res.status(200).json({
        success: true,
        message: 'Logout successful.',
    });
}

async function changePassword(req, res) {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    if (typeof currentPassword !== 'string' || !currentPassword) {
        throw new AppError('Current password is required.', 400);
    }
    if (!isValidNewPassword(newPassword)) {
        throw new AppError('New password must be 8-20 characters with uppercase, lowercase, a number and a special character.', 400);
    }
    if (newPassword !== confirmPassword) {
        throw new AppError('Passwords do not match.', 400);
    }
    const user = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${req.user.id} FOR UPDATE`;
        const current = await tx.user.findUnique({ where: { id: req.user.id }, select: authUserSelectWithPassword });
        if (!current) throw new AppError('User not found.', 404);
        if (!comparePassword(currentPassword, current.password)) {
            throw new AppError('Current password is incorrect.', 400);
        }
        const now = new Date();
        const updated = await tx.user.update({
            where: { id: current.id },
            data: { password: hashPassword(newPassword), passwordResetAt: now },
            select: authUserSelect,
        });
        await tx.passwordResetToken.updateMany({ where: { userId: current.id, usedAt: null }, data: { usedAt: now } });
        await tx.refreshToken.deleteMany({ where: { userId: current.id } });
        return updated;
    });
    return res.status(200).json({
        success: true,
        message: 'Password changed successfully.',
        user: serializeAuthUser(user, getRequestIpAddress(req)),
        accessToken: createAccessToken(user),
        refreshToken: createRefreshToken(user),
    });
}

// should return the currently logged-in user
async function getMe(req, res) {
    if (!req.user || !req.user.id) {
        return res.status(401).json({
            success: false,
            message: 'Authentication required.',
        });
    }

    const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: authUserSelect,
    });

    if (!user) {
        return res.status(404).json({
            success: false,
            message: 'User not found.',
        });
    }

    return res.status(200).json({
        success: true,
        user: serializeAuthUser(user, getRequestIpAddress(req)),
    });
}

module.exports = {
    register,
    login,
    verifyEmail,
    resendVerification,
    refreshToken,
    logout,
    getMe,
    changePassword,
};
