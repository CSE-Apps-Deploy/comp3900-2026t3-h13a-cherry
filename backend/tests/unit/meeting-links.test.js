const express = require('express');
require('express-async-errors');
const request = require('supertest');
const { createAccessToken } = require('../../src/utils/tokens');
const { errorHandler } = require('../../src/middleware/errorHandler');

let booking;
let sentMail = [];
const smtpEnvironment = { host: process.env.SMTP_HOST, port: process.env.SMTP_PORT };
process.env.SMTP_HOST = 'mailpit';
process.env.SMTP_PORT = '1025';
vi.spyOn(require('nodemailer'), 'createTransport').mockReturnValue({
    sendMail: async (message) => { sentMail.push(message); return {}; },
});
afterAll(() => {
    if (smtpEnvironment.host === undefined) delete process.env.SMTP_HOST;
    else process.env.SMTP_HOST = smtpEnvironment.host;
    if (smtpEnvironment.port === undefined) delete process.env.SMTP_PORT;
    else process.env.SMTP_PORT = smtpEnvironment.port;
});
const users = {
    tutor: {
        id: 'tutor',
        email: 'tutor@example.com',
        role: 'TUTOR',
        status: 'ACTIVE',
        tutorProfile: { id: 'profile', status: 'ACTIVE' },
    },
    learner: { id: 'learner', email: 'learner@example.com', role: 'LEARNER', status: 'ACTIVE' },
    stranger: { id: 'stranger', role: 'LEARNER', status: 'ACTIVE' },
};
const prisma = {
    user: { findUnique: async ({ where }) => users[where.id] || null },
    booking: {
        findUnique: async ({ where }) => (where.id === booking.id ? { ...booking } : null),
        updateMany: async ({ where, data }) => {
            if (
                where.id !== booking.id ||
                where.tutorId !== booking.tutorId ||
                where.status !== booking.status ||
                where.version !== booking.version
            )
                return { count: 0 };
            booking = { ...booking, ...data, version: booking.version + data.version.increment };
            return { count: 1 };
        },
    },
    notification: { create: async () => ({}) },
    $transaction: async (callback) => callback(prisma),
};
const databasePath = require.resolve('../../src/config/database');
require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: { prisma },
};
const routes = require('../../src/routes/meetingLinks');
const app = express();
app.use(express.json());
app.use('/api/v1/bookings', routes);
app.use(errorHandler);
const auth = (name) => `Bearer ${createAccessToken(users[name])}`;

beforeEach(() => {
    sentMail = [];
    booking = {
        id: 'lesson',
        learnerId: 'learner',
        tutorId: 'profile',
        status: 'ACCEPTED',
        version: 1,
        meetingLink: null,
        meetingTool: null,
        scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        duration: 60,
        subject: 'Maths',
        sessionType: 'ONLINE',
    };
});

test('a tutor saves a meeting link that the learner can retrieve', async () => {
    const saved = await request(app)
        .patch('/api/v1/bookings/lesson/meeting-link')
        .set('Authorization', auth('tutor'))
        .send({ meetingLink: 'https://meet.google.com/abc-defg-hij', expectedVersion: 1 });
    expect(saved.status).toBe(200);
    const viewed = await request(app)
        .get('/api/v1/bookings/lesson/meeting-link')
        .set('Authorization', auth('learner'));
    expect(viewed.status).toBe(200);
    expect(viewed.body.data.meetingLink).toBe('https://meet.google.com/abc-defg-hij');
    expect(viewed.body.data.meetingTool).toBe('GOOGLE_MEET');
});

test('a learner cannot edit a tutor meeting link and another learner cannot read it', async () => {
    const denied = await request(app)
        .patch('/api/v1/bookings/lesson/meeting-link')
        .set('Authorization', auth('learner'))
        .send({ meetingLink: 'https://zoom.us/j/123456789', expectedVersion: 1 });
    expect(denied.status).toBe(403);
    const hidden = await request(app)
        .get('/api/v1/bookings/lesson/meeting-link')
        .set('Authorization', auth('stranger'));
    expect(hidden.status).toBe(404);
});

test.each([
    'http://meet.google.com/abc-defg-hij',
    'https://meet.google.com.evil.example/abc-defg-hij',
    'https://user:password@zoom.us/j/123',
    'https://example.com/meeting',
])('rejects unsupported or unsafe meeting URL %s', async (meetingLink) => {
    const result = await request(app)
        .patch('/api/v1/bookings/lesson/meeting-link')
        .set('Authorization', auth('tutor'))
        .send({ meetingLink, expectedVersion: 1 });
    expect(result.status).toBe(400);
});

test('an outdated booking version cannot overwrite a newer link', async () => {
    await request(app)
        .patch('/api/v1/bookings/lesson/meeting-link')
        .set('Authorization', auth('tutor'))
        .send({ meetingLink: 'https://zoom.us/j/123456789', expectedVersion: 1 });
    const conflict = await request(app)
        .patch('/api/v1/bookings/lesson/meeting-link')
        .set('Authorization', auth('tutor'))
        .send({ meetingLink: 'https://meet.google.com/abc-defg-hij', expectedVersion: 1 });
    expect(conflict.status).toBe(409);
    const viewed = await request(app)
        .get('/api/v1/bookings/lesson/meeting-link')
        .set('Authorization', auth('learner'));
    expect(viewed.body.data.meetingLink).toBe('https://zoom.us/j/123456789');
});

test('links cannot be added to a pending booking', async () => {
    booking.status = 'PENDING';
    const result = await request(app)
        .patch('/api/v1/bookings/lesson/meeting-link')
        .set('Authorization', auth('tutor'))
        .send({ meetingLink: 'https://zoom.us/j/123456789', expectedVersion: 1 });
    expect(result.status).toBe(400);
});

test('meeting responses use the centrally configured joining and missing-link windows', async () => {
    const timing = require('../../src/config/sprint1Timing');
    const original = { ...timing };
    timing.joinEarlyMinutes = 5;
    timing.missingLinkWarningHours = 12;
    try {
        const viewed = await request(app)
            .get('/api/v1/bookings/lesson/meeting-link')
            .set('Authorization', auth('learner'));
        expect(viewed.status).toBe(200);
        expect(viewed.body.data.policy).toEqual({
            joinEarlyMinutes: 5,
            meetingLinkEditCutoffMinutes: 15,
            missingLinkWarningHours: 12,
        });
        const saved = await request(app)
            .patch('/api/v1/bookings/lesson/meeting-link')
            .set('Authorization', auth('tutor'))
            .send({ meetingLink: 'https://meet.google.com/abc-defg-hij', expectedVersion: 1 });
        expect(saved.body.data.policy).toEqual({
            joinEarlyMinutes: 5,
            meetingLinkEditCutoffMinutes: 15,
            missingLinkWarningHours: 12,
        });
    } finally {
        Object.assign(timing, original);
    }
});


test.each([15, 14, -60])('meeting link editing is blocked when the lesson starts in %s minutes', async (minutes) => {
    booking.scheduledAt = new Date(Date.now() + minutes * 60000);
    booking.meetingLink = 'https://meet.google.com/original-link';
    const result = await request(app)
        .patch('/api/v1/bookings/lesson/meeting-link')
        .set('Authorization', auth('tutor'))
        .send({ meetingLink: 'https://zoom.us/j/123456789', expectedVersion: 1 });
    expect(result.status).toBe(400);
    const viewed = await request(app)
        .get('/api/v1/bookings/lesson/meeting-link')
        .set('Authorization', auth('learner'));
    expect(viewed.status).toBe(200);
    expect(viewed.body.data.meetingLink).toBe('https://meet.google.com/original-link');
    expect(sentMail).toHaveLength(0);
});

test('saving a new meeting link sends the learner an email, while saving the same link does not repeat it', async () => {
    const payload = { meetingLink: 'https://meet.google.com/abc-defg-hij', expectedVersion: 1 };
    const saved = await request(app)
        .patch('/api/v1/bookings/lesson/meeting-link')
        .set('Authorization', auth('tutor')).send(payload);
    expect(saved.status).toBe(200);
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0].to).toBe('learner@example.com');
    expect(sentMail[0].subject).toBe('Your TutorConnect meeting link was updated');
    expect(sentMail[0].text).toContain('https://meet.google.com/abc-defg-hij');
    const unchanged = await request(app)
        .patch('/api/v1/bookings/lesson/meeting-link')
        .set('Authorization', auth('tutor')).send({ ...payload, expectedVersion: 2 });
    expect(unchanged.status).toBe(200);
    expect(sentMail).toHaveLength(1);
});
