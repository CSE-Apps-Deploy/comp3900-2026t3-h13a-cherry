const request = require('supertest');
const { randomUUID } = require('node:crypto');

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const { prisma } = require('../../src/config/database');
const stripePath = require.resolve('stripe');
require.cache[stripePath] = {
  id: stripePath, filename: stripePath, loaded: true,
  exports: class StripeBoundary {
    constructor() {
      this.transfers = { create: async () => ({ id: 'tr_external_boundary' }) };
    }
  },
};
const app = require('../../src/app');
const { createAccessToken } = require('../../src/utils/tokens');

// Opt-in: this suite exercises the real database through HTTP. Its fixture
// cleanup is restricted to the separately provisioned TST-01 database.
describe.skipIf(!enabled)('local Fake Payment through the existing booking APIs', () => {
  let learner;
  let tutor;
  let admin;
  let tutorProfile;
  let slotOffset = 4;
  const auth = (user) => ({ Authorization: `Bearer ${createAccessToken(user)}` });
  const clean = () => prisma.$executeRawUnsafe('TRUNCATE TABLE "users", "fake_payment_objects" CASCADE');
  const acceptedLesson = async (details = {}) => {
    const setup = await request(app).post('/api/v1/payments/setup-intent').set(auth(learner));
    expect(setup.status).toBe(200);
    await request(app).post('/api/v1/payments/complete-setup-intent').set(auth(learner))
      .send({ setupIntentId: setup.body.data.setupIntentId }).expect(200);
    await request(app).post('/api/v1/payments/payout-account/onboarding-link').set(auth(tutor)).expect(201);
    const slot = new Date();
    slot.setUTCDate(slot.getUTCDate() + slotOffset++);
    slot.setUTCHours(9, 0, 0, 0);
    const created = await request(app).post('/api/v1/bookings').set(auth(learner)).send({
      tutorId: tutorProfile.id, subject: 'TST-01 simulated lesson', scheduledAt: slot.toISOString(),
      duration: 60, sessionType: 'ONLINE', cancellationPolicyAcknowledgement: { cutoffHours: 24, lateRefundPercent: 0 },
      ...details,
    }).expect(201);
    await request(app).patch(`/api/v1/bookings/${created.body.data.id}/accept`).set(auth(tutor))
      .send({ expectedVersion: created.body.data.version, meetingLink: 'https://meet.google.com/abc-defg-hij' }).expect(200);
    return created.body.data;
  };

  beforeAll(async () => {
    if (new URL(process.env.TEST_DATABASE_URL).pathname !== '/tutorconnect_tst01_tests') {
      throw new Error('Provision the dedicated tutorconnect_tst01_tests database before running this suite.');
    }
    process.env.PAYMENT_PROVIDER = 'fake';
    process.env.APP_ENV = 'test';
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    await clean();
    const base = { password: 'fixture-not-used-for-login', firstName: 'TST01', lastName: 'Test', timezone: 'UTC', isEmailVerified: true };
    learner = await prisma.user.create({ data: { ...base, email: `${randomUUID()}@example.test`, role: 'LEARNER' } });
    admin = await prisma.user.create({ data: { ...base, email: `${randomUUID()}@example.test`, role: 'ADMIN' } });
    tutor = await prisma.user.create({ data: {
      ...base, email: `${randomUUID()}@example.test`, role: 'TUTOR',
      tutorProfile: { create: {
        status: 'ACTIVE', applicationSubmitted: true, isVerified: true,
        hourlyRate: 100, education: [], certifications: [],
        availability: { create: Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, startTime: '00:00', endTime: '23:30' })) },
      } },
    }, include: { tutorProfile: true } });
    tutorProfile = tutor.tutorProfile;
  });

  afterAll(async () => {
    if (new URL(process.env.TEST_DATABASE_URL).pathname === '/tutorconnect_tst01_tests') await clean();
    await prisma.$disconnect();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    process.env.PAYMENT_PROVIDER = 'fake';
  });

  test('a simulated charge accepts a booking and shows the same marked financial result to both participants', async () => {
    const setup = await request(app).post('/api/v1/payments/setup-intent').set(auth(learner));
    expect(setup.status).toBe(200);
    const saved = await request(app).post('/api/v1/payments/complete-setup-intent').set(auth(learner))
      .send({ setupIntentId: setup.body.data.setupIntentId });
    expect(saved.status).toBe(200);
    const onboarding = await request(app).post('/api/v1/payments/payout-account/onboarding-link').set(auth(tutor));
    expect(onboarding.status).toBe(201);
    const slot = new Date();
    slot.setUTCDate(slot.getUTCDate() + 3);
    slot.setUTCHours(9, 0, 0, 0);
    const created = await request(app).post('/api/v1/bookings').set(auth(learner)).send({
      tutorId: tutorProfile.id, subject: 'TST-01 simulated lesson', scheduledAt: slot.toISOString(),
      duration: 60, sessionType: 'ONLINE',
      cancellationPolicyAcknowledgement: { cutoffHours: 24, lateRefundPercent: 0 },
    });
    expect(created.status).toBe(201);
    const booking = created.body.data;
    const accepted = await request(app).patch(`/api/v1/bookings/${booking.id}/accept`).set(auth(tutor))
      .send({ expectedVersion: booking.version, meetingLink: 'https://meet.google.com/abc-defg-hij' });
    expect(accepted.status).toBe(200);
    for (const actor of [learner, tutor]) {
      const viewed = await request(app).get(`/api/v1/bookings/${booking.id}`).set(auth(actor));
      expect(viewed.status).toBe(200);
      expect(viewed.body.data).toMatchObject({ status: 'ACCEPTED', payment: { status: 'PAID', isTestPayment: true } });
      expect(Number(viewed.body.data.payment.platformFeeAmount)).toBe(15);
      expect(Number(viewed.body.data.payment.tutorPayoutAmount)).toBe(85);
    }
  });

  test('cancelling a fake-paid future lesson records a full simulated refund for both participants', async () => {
    const booking = await acceptedLesson();
    const cancelled = await request(app).post(`/api/v1/bookings/${booking.id}/cancel`).set(auth(learner))
      .send({ reason: 'TST-01 cancellation test' });
    expect(cancelled.status).toBe(200);
    for (const actor of [learner, tutor]) {
      const viewed = await request(app).get(`/api/v1/bookings/${booking.id}`).set(auth(actor)).expect(200);
      expect(viewed.body.data).toMatchObject({ status: 'CANCELLED', payment: { status: 'REFUNDED', isTestPayment: true } });
      expect(Number(viewed.body.data.payment.refundAmount)).toBe(100);
    }
  });

  test('completion confirmation permits a review and a clearly marked simulated administrator payout', async () => {
    const booking = await acceptedLesson();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(new Date(booking.scheduledAt).getTime() + 61 * 60_000));
    let viewed = await request(app).get(`/api/v1/bookings/${booking.id}`).set(auth(tutor)).expect(200);
    await request(app).patch(`/api/v1/bookings/${booking.id}/complete`).set(auth(tutor))
      .send({ expectedVersion: viewed.body.data.version }).expect(200);
    viewed = await request(app).get(`/api/v1/bookings/${booking.id}`).set(auth(learner)).expect(200);
    expect(viewed.body.data.completionReviewStatus).toBe('AWAITING_LEARNER');
    await request(app).patch(`/api/v1/bookings/${booking.id}/completion-review/confirm`).set(auth(learner))
      .send({ expectedVersion: viewed.body.data.version }).expect(200);
    await request(app).post('/api/v1/reviews').set(auth(learner))
      .send({ bookingId: booking.id, rating: 5, comment: 'TST-01 simulated lesson review' }).expect(201);
    const earnings = await request(app).get('/api/v1/payments/earnings').set(auth(tutor)).expect(200);
    expect(earnings.body.data.records.find((record) => record.lesson.id === booking.id))
      .toMatchObject({ payoutStatus: 'ELIGIBLE', isTestPayment: true });
    const run = await request(app).post(`/api/v1/admin/payout-runs/tutors/${tutorProfile.id}`).set(auth(admin));
    expect(run.status).toBe(201);
    expect(run.body.data).toMatchObject({ status: 'COMPLETED', successfulTransferCount: 1 });
    expect(run.body.data.transfers[0]).toMatchObject({ status: 'SUCCEEDED', amount: '85.00', isTestPayment: true });
  });

  test.each(['clear', 'refund'])('a disputed simulated lesson can be resolved by an administrator (%s)', async (resolution) => {
    const booking = await acceptedLesson();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(new Date(booking.scheduledAt).getTime() + 61 * 60_000));
    let viewed = await request(app).get(`/api/v1/bookings/${booking.id}`).set(auth(tutor)).expect(200);
    await request(app).patch(`/api/v1/bookings/${booking.id}/complete`).set(auth(tutor))
      .send({ expectedVersion: viewed.body.data.version }).expect(200);
    viewed = await request(app).get(`/api/v1/bookings/${booking.id}`).set(auth(learner)).expect(200);
    await request(app).post(`/api/v1/bookings/${booking.id}/completion-dispute`).set(auth(learner))
      .send({ expectedVersion: viewed.body.data.version, reason: 'TST-01 simulated completion dispute' }).expect(200);
    const overview = await request(app).get('/api/v1/admin/payouts').set(auth(admin)).expect(200);
    expect(overview.body.data.disputed.find((record) => record.bookingId === booking.id))
      .toMatchObject({ payoutStatus: 'DISPUTED', isTestPayment: true });
    viewed = await request(app).get(`/api/v1/bookings/${booking.id}`).set(auth(learner)).expect(200);
    await request(app).patch(`/api/v1/admin/bookings/${booking.id}/completion-dispute/${resolution}`).set(auth(admin))
      .send({ expectedVersion: viewed.body.data.version, note: 'TST-01 simulated resolution' }).expect(200);
    viewed = await request(app).get(`/api/v1/bookings/${booking.id}`).set(auth(learner)).expect(200);
    if (resolution === 'clear') {
      expect(viewed.body.data).toMatchObject({ status: 'COMPLETED', completionReviewStatus: 'CLEARED', payment: { status: 'PAID' } });
    } else {
      expect(viewed.body.data).toMatchObject({ status: 'NOT_COMPLETED', payment: { status: 'REFUNDED', refund: { status: 'SUCCEEDED' } } });
    }
  });

  test('cancelling one fake-paid recurring lesson leaves its sibling independently payable', async () => {
    const recurringGroupId = randomUUID();
    const first = await acceptedLesson({ recurringGroupId, recurringType: 'WEEKLY' });
    const siblingSlot = new Date(new Date(first.scheduledAt).getTime() + 7 * 24 * 60 * 60_000);
    const sibling = await request(app).post('/api/v1/bookings').set(auth(learner)).send({
      tutorId: tutorProfile.id, subject: 'TST-01 second recurring lesson', scheduledAt: siblingSlot.toISOString(),
      duration: 60, sessionType: 'ONLINE', recurringGroupId, recurringType: 'WEEKLY',
      cancellationPolicyAcknowledgement: { cutoffHours: 24, lateRefundPercent: 0 },
    }).expect(201);
    await request(app).post(`/api/v1/bookings/${first.id}/cancel`).set(auth(learner))
      .send({ reason: 'Cancel only the first TST-01 occurrence' }).expect(200);
    let viewed = await request(app).get(`/api/v1/bookings/${sibling.body.data.id}`).set(auth(learner)).expect(200);
    expect(viewed.body.data).toMatchObject({ status: 'PENDING', payment: { status: 'PENDING', isTestPayment: true } });
    await request(app).patch(`/api/v1/bookings/${sibling.body.data.id}/accept`).set(auth(tutor))
      .send({ expectedVersion: viewed.body.data.version }).expect(200);
    viewed = await request(app).get(`/api/v1/bookings/${first.id}`).set(auth(learner)).expect(200);
    expect(viewed.body.data).toMatchObject({ status: 'CANCELLED', payment: { status: 'REFUNDED' } });
    viewed = await request(app).get(`/api/v1/bookings/${sibling.body.data.id}`).set(auth(learner)).expect(200);
    expect(viewed.body.data).toMatchObject({ status: 'ACCEPTED', payment: { status: 'PAID' } });
  });

  test('rescheduling a fake-paid lesson preserves its payment and notifies both participants', async () => {
    const booking = await acceptedLesson();
    const nextSlot = new Date(new Date(booking.scheduledAt).getTime() + 2 * 60 * 60_000).toISOString();
    let viewed = await request(app).get(`/api/v1/bookings/${booking.id}`).set(auth(learner)).expect(200);
    const proposed = await request(app).post(`/api/v1/bookings/${booking.id}/reschedule-requests`).set(auth(learner))
      .send({ scheduledAt: nextSlot, reason: 'TST-01 paid lesson reschedule', expectedVersion: viewed.body.data.version }).expect(201);
    viewed = await request(app).get(`/api/v1/bookings/${booking.id}`).set(auth(tutor)).expect(200);
    await request(app).patch(`/api/v1/bookings/${booking.id}/reschedule-requests/${proposed.body.data.id}/accept`).set(auth(tutor))
      .send({ expectedVersion: viewed.body.data.version }).expect(200);
    for (const actor of [learner, tutor]) {
      viewed = await request(app).get(`/api/v1/bookings/${booking.id}`).set(auth(actor)).expect(200);
      expect(viewed.body.data).toMatchObject({ status: 'ACCEPTED', scheduledAt: nextSlot, payment: { status: 'PAID', isTestPayment: true } });
      expect(Number(viewed.body.data.payment.amount)).toBe(100);
      const notices = await request(app).get('/api/v1/notifications?limit=100').set(auth(actor)).expect(200);
      expect(notices.body.data.notifications.some((notice) => notice.link === `/bookings/${booking.id}` && /reschedul/i.test(notice.title))).toBe(true);
    }
  });

  test('Stripe mode refuses simulated earnings even when a tutor has a real-provider destination', async () => {
    const booking = await acceptedLesson();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(new Date(booking.scheduledAt).getTime() + 61 * 60_000));
    let viewed = await request(app).get(`/api/v1/bookings/${booking.id}`).set(auth(tutor)).expect(200);
    await request(app).patch(`/api/v1/bookings/${booking.id}/complete`).set(auth(tutor))
      .send({ expectedVersion: viewed.body.data.version }).expect(200);
    viewed = await request(app).get(`/api/v1/bookings/${booking.id}`).set(auth(learner)).expect(200);
    await request(app).patch(`/api/v1/bookings/${booking.id}/completion-review/confirm`).set(auth(learner))
      .send({ expectedVersion: viewed.body.data.version }).expect(200);
    const account = await prisma.tutorPayoutAccount.findUnique({ where: { tutorProfileId: tutorProfile.id } });
    await prisma.tutorPayoutAccount.update({ where: { id: account.id }, data: { stripeAccountId: 'acct_real_provider_fixture' } });
    try {
      process.env.PAYMENT_PROVIDER = 'stripe';
      vi.stubEnv('STRIPE_SECRET_KEY', 'not-a-real-key');
      const run = await request(app).post(`/api/v1/admin/payout-runs/tutors/${tutorProfile.id}`).set(auth(admin));
      expect(run.status).toBe(409);
      expect(run.body.code).toBe('PAYMENT_ENVIRONMENT_MISMATCH');
    } finally {
      await prisma.tutorPayoutAccount.update({ where: { id: account.id }, data: { stripeAccountId: account.stripeAccountId } });
    }
  });
});
