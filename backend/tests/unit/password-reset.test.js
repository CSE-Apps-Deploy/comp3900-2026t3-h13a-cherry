const express = require('express');
require('express-async-errors');
const request = require('supertest');
const { errorHandler } = require('../../src/middleware/errorHandler');
const { hashPassword, comparePassword } = require('../../src/utils/passwords');
const crypto = require('crypto');

let tokens;
let sentMail;
let users;
let refreshTokens;
let caseNumber = 0;
const prisma = {
    user: {
        findUnique: async ({ where }) =>
            users.find((user) => user.id === where.id || user.email === where.email) || null,
        update: async ({ where, data }) => {
            const user = users.find((item) => item.id === where.id);
            Object.assign(user, data);
            return user;
        },
    },
    passwordResetToken: {
        create: async ({ data }) => {
            const token = { id: String(tokens.length + 1), usedAt: null, ...data };
            tokens.push(token);
            return token;
        },
        findUnique: async ({ where }) =>
            tokens.find((token) => token.tokenHash === where.tokenHash) || null,
        updateMany: async ({ where, data }) => {
            let count = 0;
            for (const token of tokens) {
                if (where.id && token.id !== where.id) continue;
                if (where.userId && token.userId !== where.userId) continue;
                if (where.usedAt === null && token.usedAt !== null) continue;
                if (where.expiresAt && token.expiresAt <= where.expiresAt.gt) continue;
                Object.assign(token, data);
                count += 1;
            }
            return { count };
        },
    },
    refreshToken: {
        deleteMany: async ({ where }) => {
            refreshTokens = refreshTokens.filter((token) => token.userId !== where.userId);
            return { count: 1 };
        },
    },
    $queryRaw: async () => [],
    $transaction: async (callback) => callback(prisma),
};
const databasePath = require.resolve('../../src/config/database');
require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: { prisma },
};
const emailPath = require.resolve('../../src/services/emailService');
require.cache[emailPath] = {
    id: emailPath,
    filename: emailPath,
    loaded: true,
    exports: {
        hasSmtpConfig: () => true,
        sendPasswordResetEmail: async (mail) => {
            sentMail.push(mail);
            return { delivered: true };
        },
    },
};
const routes = require('../../src/routes/passwordReset');
const app = express();
app.use(express.json());
app.use('/api/v1/auth', routes);
app.use('/api/v1/auth', require('../../src/routes/auth'));
app.use(errorHandler);

beforeEach(() => {
    tokens = [];
    sentMail = [];
    refreshTokens = [{ userId: 'learner', token: 'old-session' }];
    caseNumber += 1;
    users = [
        {
            id: 'learner',
            email: `learner${caseNumber}@example.com`,
            firstName: 'Lee',
            lastName: 'Learner',
            role: 'LEARNER',
            status: 'ACTIVE',
            isEmailVerified: true,
            password: hashPassword('OldPassword1!'),
        },
    ];
});

test('registered and unknown emails receive the same public reset response', async () => {
    const known = await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: users[0].email });
    const unknown = await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'unknown@example.com' });
    expect(known.status).toBe(200);
    expect(unknown.body.message).toBe(known.body.message);
    expect(sentMail[0].email).toBe(users[0].email);
    expect(sentMail[0].token).toMatch(/^[a-f0-9]{64}$/);
    expect(known.body).not.toHaveProperty('token');
});

test('a valid reset allows the new password to log in and rejects the old password and used link', async () => {
    await request(app).post('/api/v1/auth/forgot-password').send({ email: users[0].email });
    const token = sentMail[0].token;
    const reset = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({ token, password: 'NewPassword2!', confirmPassword: 'NewPassword2!' });
    expect(reset.status).toBe(200);
    const oldLogin = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: users[0].email, password: 'OldPassword1!' });
    const newLogin = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: users[0].email, password: 'NewPassword2!' });
    expect(oldLogin.status).toBe(401);
    expect(newLogin.status).toBe(200);
    const used = await request(app).post('/api/v1/auth/reset-password/validate').send({ token });
    expect(used.status).toBe(400);
    expect(used.body.message).toContain('already been used');
});

test('a reset token expires after the agreed 30 minutes', async () => {
    await request(app).post('/api/v1/auth/forgot-password').send({ email: users[0].email });
    const token = sentMail[0].token;
    // Fixture time represents a link issued more than 30 minutes ago.
    tokens[0].expiresAt = new Date(Date.now() - 1000);
    const checked = await request(app).post('/api/v1/auth/reset-password/validate').send({ token });
    expect(checked.status).toBe(410);
    expect(checked.body.message).toContain('expired');
    const reset = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({ token, password: 'NewPassword2!', confirmPassword: 'NewPassword2!' });
    expect(reset.status).toBe(410);
});

test('requesting another link invalidates the older link', async () => {
    await request(app).post('/api/v1/auth/forgot-password').send({ email: users[0].email });
    const oldToken = sentMail[0].token;
    await request(app).post('/api/v1/auth/forgot-password').send({ email: users[0].email });
    expect(
        (await request(app).post('/api/v1/auth/reset-password/validate').send({ token: oldToken }))
            .status
    ).toBe(400);
    expect(
        (
            await request(app)
                .post('/api/v1/auth/reset-password/validate')
                .send({ token: sentMail[1].token })
        ).status
    ).toBe(200);
});

test('mismatched passwords are rejected without consuming the valid link', async () => {
    await request(app).post('/api/v1/auth/forgot-password').send({ email: users[0].email });
    const token = sentMail[0].token;
    expect(
        (
            await request(app)
                .post('/api/v1/auth/reset-password')
                .send({ token, password: 'NewPassword2!', confirmPassword: 'Different3!' })
        ).status
    ).toBe(400);
    expect(
        (await request(app).post('/api/v1/auth/reset-password/validate').send({ token })).status
    ).toBe(200);
});

test('reset revokes the previous refresh token while a new login can still refresh', async () => {
    const original = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: users[0].email, password: 'OldPassword1!' });
    await request(app).post('/api/v1/auth/forgot-password').send({ email: users[0].email });
    await request(app).post('/api/v1/auth/reset-password').send({
        token: sentMail[0].token,
        password: 'NewPassword2!',
        confirmPassword: 'NewPassword2!',
    });
    const revoked = await request(app)
        .post('/api/v1/auth/refresh-token')
        .send({ refreshToken: original.body.refreshToken });
    expect(revoked.status).toBe(401);
    const current = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: users[0].email, password: 'NewPassword2!' });
    expect(
        (
            await request(app)
                .post('/api/v1/auth/refresh-token')
                .send({ refreshToken: current.body.refreshToken })
        ).status
    ).toBe(200);
});

test('reset response, email and link expiry use the configured duration', async () => {
    const timing = require('../../src/config/sprint1Timing');
    const original = timing.passwordResetMinutes;
    timing.passwordResetMinutes = 21;
    try {
        const requestedAt = Date.now();
        const response = await request(app)
            .post('/api/v1/auth/forgot-password')
            .send({ email: users[0].email });
        expect(response.body.data.expiresInMinutes).toBe(21);
        expect(response.body.message).toContain('21 minutes');
        expect(sentMail[0].expiresInMinutes).toBe(21);
        const validated = await request(app)
            .post('/api/v1/auth/reset-password/validate')
            .send({ token: sentMail[0].token });
        expect(validated.status).toBe(200);
        const expiresAt = new Date(validated.body.data.expiresAt).getTime();
        expect(expiresAt - requestedAt).toBeGreaterThanOrEqual(21 * 60000);
        expect(expiresAt - requestedAt).toBeLessThan(21 * 60000 + 2000);
    } finally {
        timing.passwordResetMinutes = original;
    }
});


test('a reset rejects more than twenty characters without consuming the link', async () => {
    await request(app).post('/api/v1/auth/forgot-password').send({ email: users[0].email });
    const token = sentMail[0].token;
    const password = 'Ab1!' + 'x'.repeat(17);
    const reset = await request(app).post('/api/v1/auth/reset-password')
        .send({ token, password, confirmPassword: password });
    expect(reset.status).toBe(400);
    const checked = await request(app).post('/api/v1/auth/reset-password/validate').send({ token });
    expect(checked.status).toBe(200);
});


test('signed-in password change updates login credentials and rotates the refresh token', async () => {
    const login = await request(app).post('/api/v1/auth/login')
        .send({ email: users[0].email, password: 'OldPassword1!' });
    const changed = await request(app).post('/api/v1/auth/change-password')
        .set('Authorization', 'Bearer ' + login.body.accessToken)
        .send({ currentPassword: 'OldPassword1!', newPassword: 'FullDemo2!', confirmPassword: 'FullDemo2!' });
    expect(changed.status).toBe(200);
    expect(changed.body.user.id).toBe('learner');
    expect(changed.body.user.password).toBeUndefined();
    expect((await request(app).post('/api/v1/auth/login')
        .send({ email: users[0].email, password: 'OldPassword1!' })).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/login')
        .send({ email: users[0].email, password: 'FullDemo2!' })).status).toBe(200);
    expect((await request(app).post('/api/v1/auth/refresh-token')
        .send({ refreshToken: login.body.refreshToken })).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/refresh-token')
        .send({ refreshToken: changed.body.refreshToken })).status).toBe(200);
});


test.each([
    ['wrong-password', 'FullDemo2!', 'FullDemo2!'],
    ['OldPassword1!', 'weak', 'weak'],
    ['OldPassword1!', 'FullDemo2!', 'Different3!'],
])('password change rejects invalid credentials or confirmation', async (currentPassword, newPassword, confirmPassword) => {
    const login = await request(app).post('/api/v1/auth/login')
        .send({ email: users[0].email, password: 'OldPassword1!' });
    const changed = await request(app).post('/api/v1/auth/change-password')
        .set('Authorization', 'Bearer ' + login.body.accessToken)
        .send({ currentPassword, newPassword, confirmPassword });
    expect(changed.status).toBe(400);
    expect((await request(app).post('/api/v1/auth/login')
        .send({ email: users[0].email, password: 'OldPassword1!' })).status).toBe(200);
});
