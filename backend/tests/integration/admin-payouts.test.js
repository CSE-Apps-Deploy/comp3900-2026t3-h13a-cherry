const request = require('supertest');

const prisma = {
  user: { findUnique: vi.fn() },
  booking: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  payment: { updateMany: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  paymentRefund: { findMany: vi.fn(), findUnique: vi.fn() },
  tutorProfile: { updateMany: vi.fn() },
  adminAction: { create: vi.fn() },
  $executeRaw: vi.fn(),
  $transaction: vi.fn((callback) => callback(prisma)),
};

const notify = vi.fn();
const createRefundClaim = vi.fn();
const submitRefund = vi.fn();
const serializeRefund = (refund) =>
  refund
    ? {
        id: refund.id,
        source: refund.source,
        amount: Number(refund.amount || 0).toFixed(2),
        currency: refund.currency || 'AUD',
        status: refund.status,
        resolutionNote: refund.resolutionNote || null,
        failureReason: refund.failureReason || null,
        requestedAt: refund.requestedAt,
        failedAt: refund.failedAt || null,
        completedAt: refund.completedAt || null,
        attemptCount: refund.attemptCount || 1,
      }
    : null;

const databaseModulePath = require.resolve('../../src/config/database');
const stripeModulePath = require.resolve('../../src/config/stripe');
const notificationModulePath = require.resolve('../../src/services/notificationService');
const refundServiceModulePath = require.resolve('../../src/services/refundService');
const appModulePath = require.resolve('../../src/app');

for (const modulePath of [
  databaseModulePath,
  stripeModulePath,
  notificationModulePath,
  refundServiceModulePath,
  appModulePath,
]) {
  delete require.cache[modulePath];
}

require.cache[databaseModulePath] = {
  id: databaseModulePath,
  filename: databaseModulePath,
  loaded: true,
  exports: { prisma },
};
require.cache[stripeModulePath] = {
  id: stripeModulePath,
  filename: stripeModulePath,
  loaded: true,
  exports: { isStripeConfigured: () => false, getStripe: vi.fn() },
};
require.cache[notificationModulePath] = {
  id: notificationModulePath,
  filename: notificationModulePath,
  loaded: true,
  exports: { notify, notifyOrRefresh: vi.fn(), notifyAdmin: vi.fn() },
};
require.cache[refundServiceModulePath] = {
  id: refundServiceModulePath,
  filename: refundServiceModulePath,
  loaded: true,
  exports: {
    REFUND_SOURCES: {
      TUTOR_NON_COMPLETION: 'TUTOR_NON_COMPLETION',
      ADMIN_COMPLETION_DISPUTE: 'ADMIN_COMPLETION_DISPUTE',
    },
    createRefundClaim,
    submitRefund,
    serializeRefund,
  },
};

const app = require('../../src/app');
const { createAccessToken } = require('../../src/utils/tokens');

const users = {
  ADMIN: { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN', status: 'ACTIVE' },
  SYSTEM_ADMIN: {
    id: 'system-admin-1',
    email: 'system@example.com',
    role: 'SYSTEM_ADMIN',
    status: 'ACTIVE',
  },
  LEARNER: { id: 'learner-1', email: 'learner@example.com', role: 'LEARNER', status: 'ACTIVE' },
  SUSPENDED_ADMIN: {
    id: 'suspended-admin-1',
    email: 'suspended-admin@example.com',
    role: 'ADMIN',
    status: 'SUSPENDED',
  },
};

const authAs = (role) => {
  prisma.user.findUnique.mockResolvedValue(users[role]);
  return `Bearer ${createAccessToken(users[role])}`;
};

beforeEach(() => {
  vi.resetAllMocks();
  prisma.$transaction.mockImplementation((callback) => callback(prisma));
  prisma.booking.updateMany.mockResolvedValue({ count: 0 });
  prisma.booking.findMany.mockResolvedValue([]);
  prisma.payment.updateMany.mockResolvedValue({ count: 0 });
  prisma.payment.findMany.mockResolvedValue([]);
  prisma.payment.count.mockResolvedValue(0);
  prisma.paymentRefund.findMany.mockResolvedValue([]);
});

describe('admin payout API authorization', () => {
  test.each(['ADMIN', 'SYSTEM_ADMIN'])('allows %s to review payout operations', async (role) => {
    const response = await request(app)
      .get('/api/v1/admin/payouts')
      .set('Authorization', authAs(role));

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(
      expect.objectContaining({
        providerConfigured: false,
        readyGroups: [],
        disputed: [],
      })
    );
  });

  test('denies learners access to payout operations', async () => {
    const response = await request(app)
      .get('/api/v1/admin/payouts')
      .set('Authorization', authAs('LEARNER'));

    expect(response.status).toBe(403);
    expect(prisma.payment.findMany).not.toHaveBeenCalled();
  });

  test('denies suspended administrators access to financial operations', async () => {
    const response = await request(app)
      .get('/api/v1/admin/payouts')
      .set('Authorization', authAs('SUSPENDED_ADMIN'));

    expect(response.status).toBe(403);
    expect(prisma.payment.findMany).not.toHaveBeenCalled();
  });

  test('shows open completion disputes with the learner refund quote and refund lifecycle', async () => {
    const disputedBooking = {
      id: 'booking-disputed-overview',
      version: 3,
      learnerId: 'learner-1',
      tutorId: 'tutor-profile-1',
      subject: 'Physics',
      scheduledAt: new Date('2026-08-01T10:00:00.000Z'),
      completedAt: new Date('2026-08-01T11:00:00.000Z'),
      status: 'COMPLETED',
      isTrialLesson: false,
      currency: 'AUD',
      completionReviewStatus: 'DISPUTED',
      completionDisputeReason: 'The lesson did not take place.',
      completionDisputedAt: new Date('2026-08-01T12:00:00.000Z'),
      learner: { id: 'learner-1', firstName: 'Lee', lastName: 'Learner' },
      tutorProfile: {
        user: {
          id: 'tutor-user-1',
          firstName: 'Taylor',
          lastName: 'Tutor',
          email: 'tutor@example.com',
        },
      },
      payment: {
        id: 'payment-disputed-overview',
        amount: 100,
        refundAmount: 20,
        currency: 'AUD',
        tutorPayoutAmount: 68,
        payoutStatus: 'DISPUTED',
      },
    };
    const processingRefund = {
      id: 'refund-overview-1',
      source: 'ADMIN_COMPLETION_DISPUTE',
      amount: 80,
      currency: 'AUD',
      status: 'PROCESSING',
      resolutionNote: 'Evidence supports the learner.',
      attemptCount: 1,
      requestedAt: new Date('2026-08-01T13:00:00.000Z'),
      payment: { booking: disputedBooking },
    };
    prisma.booking.findMany.mockResolvedValueOnce([disputedBooking]);
    prisma.paymentRefund.findMany
      .mockResolvedValueOnce([processingRefund])
      .mockResolvedValueOnce([]);

    const response = await request(app)
      .get('/api/v1/admin/payouts')
      .set('Authorization', authAs('ADMIN'));

    expect(response.status).toBe(200);
    expect(response.body.data.disputed[0]).toEqual(
      expect.objectContaining({
        bookingId: disputedBooking.id,
        version: 3,
        refundQuote: { amount: '80.00', currency: 'AUD' },
      })
    );
    expect(response.body.data.refunds[0]).toEqual(
      expect.objectContaining({
        id: processingRefund.id,
        status: 'PROCESSING',
        canRetry: true,
        bookingId: disputedBooking.id,
      })
    );
    expect(response.body.data.counts.refundsProcessing).toBe(1);
  });

  test('exposes the single-tutor payout action to administrators', async () => {
    const response = await request(app)
      .post('/api/v1/admin/payout-runs/tutors/10000000-0000-4000-8000-000000000001')
      .set('Authorization', authAs('ADMIN'));

    expect(response.status).toBe(503);
    expect(response.body.message).toMatch(/Stripe transfers are currently unavailable/i);
  });

  test('records a neutral outcome when an administrator confirms a free trial', async () => {
    const booking = {
      id: 'booking-trial-disputed-1',
      version: 2,
      learnerId: 'learner-1',
      tutorId: 'tutor-profile-1',
      subject: 'Chemistry',
      status: 'COMPLETED',
      isTrialLesson: true,
      completionReviewStatus: 'DISPUTED',
      payment: null,
      learner: { id: 'learner-1' },
      tutorProfile: { user: { id: 'tutor-user-1' } },
    };
    prisma.booking.findUnique.mockResolvedValueOnce(booking);
    prisma.booking.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.adminAction.create.mockResolvedValueOnce({ id: 'admin-action-trial-1' });

    const response = await request(app)
      .patch('/api/v1/admin/bookings/booking-trial-disputed-1/completion-dispute/clear')
      .set('Authorization', authAs('ADMIN'))
      .send({ note: 'The free trial was delivered.', expectedVersion: 2 });

    expect(response.status).toBe(200);
    expect(prisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          completionReviewStatus: 'CLEARED',
          completionResolution: 'ADMIN_CONFIRMED_TRIAL',
        }),
      })
    );
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(response.body.message).toMatch(/no earning or payout was created/i);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  test('lets an administrator resolve a completion dispute in the learner\'s favour', async () => {
    const booking = {
      id: 'booking-disputed-1',
      version: 4,
      learnerId: 'learner-1',
      tutorId: 'tutor-profile-1',
      subject: 'Mathematics',
      status: 'COMPLETED',
      isTrialLesson: false,
      currency: 'AUD',
      completionReviewStatus: 'DISPUTED',
      completionDisputeReason: 'The lesson did not take place.',
      learner: { id: 'learner-1', firstName: 'Lee', lastName: 'Learner' },
      tutorProfile: {
        id: 'tutor-profile-1',
        user: { id: 'tutor-user-1', firstName: 'Taylor', lastName: 'Tutor' },
      },
      payment: {
        id: 'payment-disputed-1',
        status: 'PAID',
        amount: 100,
        refundAmount: 0,
        currency: 'AUD',
        platformFeePercent: 15,
        tutorPayoutAmount: 85,
        payoutStatus: 'DISPUTED',
        refund: null,
      },
    };
    const finalBooking = {
      ...booking,
      version: 5,
      status: 'NOT_COMPLETED',
      completionReviewStatus: 'RESOLVED_LEARNER',
      completionResolution: 'ADMIN_REFUNDED_LEARNER',
      completionReviewResolvedAt: new Date(),
    };
    const refund = {
      id: 'refund-admin-1',
      paymentId: booking.payment.id,
      source: 'ADMIN_COMPLETION_DISPUTE',
      amount: 100,
      currency: 'AUD',
      status: 'PROCESSING',
      resolutionNote: 'Evidence supports the learner.',
      attemptCount: 1,
      requestedAt: new Date(),
    };

    prisma.booking.findUnique.mockResolvedValueOnce(booking).mockResolvedValueOnce(booking);
    prisma.booking.update.mockResolvedValueOnce(finalBooking);
    prisma.tutorProfile.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.adminAction.create.mockResolvedValueOnce({ id: 'admin-action-1' });
    createRefundClaim.mockResolvedValueOnce(refund);
    submitRefund.mockResolvedValueOnce({ ...refund, status: 'SUCCEEDED', completedAt: new Date() });

    const response = await request(app)
      .patch('/api/v1/admin/bookings/booking-disputed-1/completion-dispute/refund')
      .set('Authorization', authAs('ADMIN'))
      .send({ note: 'Evidence supports the learner.', expectedVersion: 4 });

    expect(response.status).toBe(200);
    expect(createRefundClaim).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        payment: booking.payment,
        initiatedById: 'admin-1',
        source: 'ADMIN_COMPLETION_DISPUTE',
        resolutionNote: 'Evidence supports the learner.',
      })
    );
    expect(prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: booking.id,
          status: 'COMPLETED',
          version: 4,
          completionReviewStatus: 'DISPUTED',
        }),
        data: expect.objectContaining({
          status: 'NOT_COMPLETED',
          completionReviewStatus: 'RESOLVED_LEARNER',
          completionResolution: 'ADMIN_REFUNDED_LEARNER',
        }),
      })
    );
    expect(submitRefund).toHaveBeenCalledWith('refund-admin-1');
    expect(response.body.data).toEqual(
      expect.objectContaining({
        bookingId: booking.id,
        status: 'NOT_COMPLETED',
        completionReviewStatus: 'RESOLVED_LEARNER',
        completionResolution: 'ADMIN_REFUNDED_LEARNER',
        refund: expect.objectContaining({ status: 'SUCCEEDED', amount: '100.00' }),
      })
    );
    expect(notify).toHaveBeenCalledTimes(2);
  });

  test('rejects a stale administrator dispute resolution without requesting a refund', async () => {
    prisma.booking.findUnique.mockResolvedValueOnce({
      id: 'booking-disputed-1',
      version: 5,
      learnerId: 'learner-1',
      tutorId: 'tutor-profile-1',
      subject: 'Mathematics',
      status: 'COMPLETED',
      completionReviewStatus: 'DISPUTED',
      learner: { id: 'learner-1' },
      tutorProfile: { user: { id: 'tutor-user-1' } },
      payment: { id: 'payment-disputed-1', status: 'PAID', refund: null },
    });

    const response = await request(app)
      .patch('/api/v1/admin/bookings/booking-disputed-1/completion-dispute/refund')
      .set('Authorization', authAs('ADMIN'))
      .send({ note: 'Evidence supports the learner.', expectedVersion: 4 });

    expect(response.status).toBe(409);
    expect(createRefundClaim).not.toHaveBeenCalled();
    expect(submitRefund).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });
});
