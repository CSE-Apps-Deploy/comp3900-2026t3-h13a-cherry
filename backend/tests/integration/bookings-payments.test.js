const request = require('supertest');

const prisma = {
  user: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  tutorProfile: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  subject: {
    findUnique: vi.fn(),
  },
  tutorSubject: {
    upsert: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(),
    deleteMany: vi.fn(),
  },
  booking: {
    count: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  bookingPriceOffer: {
    findFirst: vi.fn(),
  },
  payment: {
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  paymentRefund: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  paymentRefundAttempt: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  paymentAttempt: {
    create: vi.fn(),
    updateMany: vi.fn(),
  },
  tutorPayoutAccount: {
    findUnique: vi.fn(),
  },
  stripeWebhookEvent: {
    create: vi.fn(),
  },
  bookingStatusHistory: {
    create: vi.fn(),
  },
  notification: {
    findFirst: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
  },
  rescheduleRequest: {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  $transaction: vi.fn((callback) => callback(prisma)),
  $executeRaw: vi.fn(),
};

const notify = vi.fn();
const notifyOrRefresh = vi.fn();
const notifyAdmin = vi.fn();
const stripeRefundCreate = vi.fn();
const stripeRefundList = vi.fn();
const stripeSetupIntentRetrieve = vi.fn();
const stripePaymentMethodRetrieve = vi.fn();
const stripePaymentMethodList = vi.fn();
const stripePaymentMethodDetach = vi.fn();
const stripePaymentIntentCreate = vi.fn();
const stripePaymentIntentRetrieve = vi.fn();
const stripePaymentIntentUpdate = vi.fn();
const stripePaymentIntentConfirm = vi.fn();
const stripeWebhookConstructEvent = vi.fn();
let stripeConfigured = false;

const databaseModulePath = require.resolve('../../src/config/database');
const notificationServiceModulePath = require.resolve('../../src/services/notificationService');
const stripeModulePath = require.resolve('../../src/config/stripe');
const appModulePath = require.resolve('../../src/app');

delete require.cache[databaseModulePath];
delete require.cache[notificationServiceModulePath];
delete require.cache[stripeModulePath];
delete require.cache[appModulePath];

require.cache[databaseModulePath] = {
  id: databaseModulePath,
  filename: databaseModulePath,
  loaded: true,
  exports: { prisma },
};

require.cache[notificationServiceModulePath] = {
  id: notificationServiceModulePath,
  filename: notificationServiceModulePath,
  loaded: true,
  exports: {
    notify,
    notifyOrRefresh,
    notifyAdmin,
  },
};

require.cache[stripeModulePath] = {
  id: stripeModulePath,
  filename: stripeModulePath,
  loaded: true,
  exports: {
    isStripeConfigured: () => stripeConfigured,
    getStripe: () => ({
      refunds: { create: stripeRefundCreate, list: stripeRefundList },
      setupIntents: { retrieve: stripeSetupIntentRetrieve },
      paymentMethods: {
        retrieve: stripePaymentMethodRetrieve,
        list: stripePaymentMethodList,
        detach: stripePaymentMethodDetach,
      },
      paymentIntents: {
        create: stripePaymentIntentCreate,
        retrieve: stripePaymentIntentRetrieve,
        update: stripePaymentIntentUpdate,
        confirm: stripePaymentIntentConfirm,
      },
      webhooks: { constructEvent: stripeWebhookConstructEvent },
    }),
  },
};

const app = require('../../src/app');
const { createAccessToken } = require('../../src/utils/tokens');

const learnerUser = {
  id: 'learner-1',
  email: 'learner@example.com',
  role: 'LEARNER',
  status: 'ACTIVE',
};

const learnerRecord = {
  ...learnerUser,
  firstName: 'Learner',
  lastName: 'Example',
};

const otherLearnerUser = {
  id: 'learner-2',
  email: 'other@example.com',
  role: 'LEARNER',
  status: 'ACTIVE',
};

const ownedPaymentMethod = {
  id: 'pm_learner_new',
  type: 'card',
  customer: 'cus_learner_1',
  card: {
    brand: 'visa',
    last4: '4242',
    exp_month: 12,
    exp_year: 2030,
  },
  billing_details: {
    name: 'Learner Example',
  },
};

const tutorUser = {
  id: 'tutor-user-1',
  email: 'tutor@example.com',
  role: 'TUTOR',
  status: 'ACTIVE',
  tutorProfile: {
    id: 'tutor-profile-1',
    status: 'ACTIVE',
    applicationSubmitted: true,
    isVerified: true,
  },
};

const acceptedFutureBooking = {
  id: 'booking-1',
  learnerId: learnerUser.id,
  tutorId: 'tutor-profile-1',
  subject: 'Mathematics',
  status: 'ACCEPTED',
  version: 1,
  scheduledAt: new Date('2027-05-07T10:00:00.000Z'),
  duration: 60,
  learner: {
    ...learnerRecord,
    timezone: 'UTC',
  },
  tutorProfile: {
    id: 'tutor-profile-1',
    userId: 'tutor-user-1',
    user: {
      id: 'tutor-user-1',
      firstName: 'Tutor',
      lastName: 'Example',
      email: 'tutor@example.com',
      timezone: 'UTC',
    },
  },
};

const tutorAvailability = {
  id: 'tutor-profile-1',
  user: { timezone: 'UTC' },
  availability: [
    {
      dayOfWeek: 5,
      startTime: '09:00',
      endTime: '13:00',
    },
  ],
};

const buildPendingAcceptanceBooking = (overrides = {}) => {
  const base = {
    ...acceptedFutureBooking,
    status: 'PENDING',
    version: 1,
    isTrialLesson: false,
    totalAmount: 100,
    currency: 'AUD',
    recurringType: 'ONE_OFF',
    recurringGroupId: null,
    negotiationStatus: 'NONE',
    learner: {
      ...learnerRecord,
      timezone: 'UTC',
      stripeCustomerId: 'cus_learner_1',
      stripeDefaultPaymentMethodId: ownedPaymentMethod.id,
    },
    payment: {
      id: 'payment-1',
      bookingId: 'booking-1',
      userId: learnerUser.id,
      status: 'PENDING',
      amount: 100,
      currency: 'AUD',
      stripeCustomerId: null,
      stripePaymentMethodId: null,
      stripePaymentIntentId: null,
      stripeIdempotencyKey: 'accept-booking-1',
      acceptanceAttemptCount: 0,
      acceptanceMode: null,
      acceptanceAuthorizedById: null,
      acceptanceAuthorizedAt: null,
      acceptanceBookingVersion: null,
      acceptanceMeetingLink: null,
      processingStartedAt: null,
      platformFeePercent: null,
        platformFeeAmount: null,
        tutorPayoutAmount: null,
        payoutStatus: null,
        payoutPendingAt: null,
        payoutEligibleAt: null,
        payoutAt: null,
        payoutFailedAt: null,
        payoutFailureReason: null,
        attempts: [],
    },
    priceOffers: [],
    rescheduleRequests: [],
    statusHistory: [{ status: 'PENDING' }],
  };

  return {
    ...base,
    ...overrides,
    learner: { ...base.learner, ...(overrides.learner || {}) },
    tutorProfile: {
      ...base.tutorProfile,
      ...(overrides.tutorProfile || {}),
      user: {
        ...base.tutorProfile.user,
        ...(overrides.tutorProfile?.user || {}),
      },
    },
    payment:
      overrides.payment === null
        ? null
        : { ...base.payment, ...(overrides.payment || {}) },
    priceOffers: overrides.priceOffers || base.priceOffers,
    rescheduleRequests: overrides.rescheduleRequests || base.rescheduleRequests,
  };
};

const arrangeAcceptancePayment = ({
  booking = buildPendingAcceptanceBooking(),
  intentStatus = 'succeeded',
  intentId = 'pi_booking_1',
  paymentMethod = ownedPaymentMethod,
  retryIntentStatus = 'succeeded',
} = {}) => {
  let state = booking;
  let providerIntent = null;
  const snapshot = () => ({
    ...state,
    learner: state.learner ? { ...state.learner } : null,
    tutorProfile: state.tutorProfile
      ? {
          ...state.tutorProfile,
          user: state.tutorProfile.user ? { ...state.tutorProfile.user } : null,
        }
      : null,
    payment: state.payment
      ? {
          ...state.payment,
          attempts: [...(state.payment.attempts || [])],
        }
      : null,
    priceOffers: [...(state.priceOffers || [])],
    rescheduleRequests: [...(state.rescheduleRequests || [])],
    statusHistory: [...(state.statusHistory || [])],
  });
  const matchesStatus = (actual, expected) => {
    if (!expected) return true;
    if (typeof expected === 'string') return actual === expected;
    if (expected.in) return expected.in.includes(actual);
    return true;
  };

  stripeConfigured = true;
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  prisma.user.findUnique.mockResolvedValue(tutorUser);
  prisma.tutorProfile.findUnique.mockResolvedValue({
    ...tutorAvailability,
    userId: tutorUser.id,
    status: 'ACTIVE',
    user: { id: tutorUser.id, status: 'ACTIVE', timezone: 'UTC' },
  });
  prisma.booking.findUnique.mockImplementation(async () => snapshot());
  prisma.booking.findMany.mockResolvedValue([]);
  prisma.bookingPriceOffer.findFirst.mockResolvedValue(null);
  prisma.payment.findUnique.mockImplementation(async () => ({
    ...state.payment,
    attempts: [...(state.payment?.attempts || [])],
    booking: snapshot(),
  }));
  prisma.payment.updateMany.mockImplementation(async ({ where, data }) => {
    if (!state.payment || where.id !== state.payment.id || !matchesStatus(state.payment.status, where.status)) {
      return { count: 0 };
    }
    if (
      where.stripePaymentIntentId !== undefined &&
      state.payment.stripePaymentIntentId !== where.stripePaymentIntentId
    ) {
      return { count: 0 };
    }
    if (data.acceptanceAttemptCount?.increment) {
      state.payment.acceptanceAttemptCount += data.acceptanceAttemptCount.increment;
    }
    for (const [key, value] of Object.entries(data)) {
      if (key !== 'acceptanceAttemptCount') state.payment[key] = value;
    }
    return { count: 1 };
  });
  prisma.paymentAttempt.create.mockImplementation(async ({ data }) => {
    const attempt = {
      id: `attempt-${data.sequence}`,
      ...data,
      completedAt: data.completedAt || null,
    };
    state.payment.attempts = [attempt, ...(state.payment.attempts || [])];
    return attempt;
  });
  prisma.paymentAttempt.updateMany.mockImplementation(async ({ where, data }) => {
    const attempt = (state.payment?.attempts || []).find(
      (item) =>
        (!where.id || item.id === where.id) &&
        (!where.paymentId || item.paymentId === where.paymentId) &&
        (where.sequence === undefined || item.sequence === where.sequence) &&
        (!where.outcome || item.outcome === where.outcome)
    );
    if (!attempt) return { count: 0 };
    Object.assign(attempt, data);
    return { count: 1 };
  });
  prisma.booking.updateMany.mockImplementation(async ({ where, data }) => {
    if (where.id !== state.id || !matchesStatus(state.status, where.status)) return { count: 0 };
    if (data.version?.increment) state.version += data.version.increment;
    for (const [key, value] of Object.entries(data)) {
      if (key !== 'version') state[key] = value;
    }
    return { count: 1 };
  });
  prisma.rescheduleRequest.updateMany.mockResolvedValue({ count: 1 });
  prisma.bookingStatusHistory.create.mockImplementation(async ({ data }) => {
    state.statusHistory.push({ ...data, createdAt: new Date() });
    return { id: `history-${state.statusHistory.length}`, ...data };
  });
  prisma.notification.createMany.mockResolvedValue({ count: 2 });
  prisma.notification.create.mockResolvedValue({ id: 'notification-1' });
  prisma.notification.findFirst.mockResolvedValue(null);
  stripePaymentMethodRetrieve.mockResolvedValue(paymentMethod);
  stripePaymentIntentCreate.mockImplementation(async (params) => {
    providerIntent = {
      id: intentId,
      status: intentStatus,
      amount: params.amount,
      currency: params.currency,
      customer: params.customer,
      payment_method: params.payment_method,
      metadata: params.metadata,
      ...(intentStatus === 'requires_payment_method'
        ? {
            last_payment_error: {
              code: 'card_declined',
              message: 'Your card was declined.',
            },
          }
        : {}),
    };
    return providerIntent;
  });
  stripePaymentIntentRetrieve.mockImplementation(async () => providerIntent);
  stripePaymentIntentUpdate.mockImplementation(async (_id, params) => {
    providerIntent = { ...providerIntent, metadata: params.metadata };
    return providerIntent;
  });
  stripePaymentIntentConfirm.mockImplementation(async (_id, params) => {
    providerIntent = {
      ...providerIntent,
      status: retryIntentStatus,
      payment_method: params.payment_method,
      last_payment_error: null,
    };
    return providerIntent;
  });

  return {
    get booking() {
      return state;
    },
  };
};

beforeEach(() => {
  vi.resetAllMocks();
  stripeConfigured = false;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  prisma.$transaction.mockImplementation((input) =>
    typeof input === 'function' ? input(prisma) : Promise.all(input)
  );
  prisma.payment.update.mockImplementation(({ where, data }) =>
    Promise.resolve({ id: where.id, ...data, updatedAt: new Date() })
  );
  prisma.booking.updateMany.mockResolvedValue({ count: 0 });
  prisma.payment.updateMany.mockResolvedValue({ count: 0 });
  stripeRefundList.mockResolvedValue({ data: [], has_more: false });
  // PAY-05: these suites cover payment behaviour, not payout onboarding, so the
  // tutor is payout-ready by default. The guard fails closed, so without this
  // every paid acceptance here would be blocked before reaching Stripe.
  prisma.tutorPayoutAccount.findUnique.mockResolvedValue({ isPayoutReady: true });
});

describe('booking and payment API integration tests', () => {
  test('returns the learner remaining trial allowance on a tutor profile', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.tutorProfile.findFirst.mockResolvedValueOnce({
      id: 'tutor-profile-1',
      userId: 'tutor-user-1',
      status: 'ACTIVE',
      trialLessonLimit: 2,
      user: {
        id: 'tutor-user-1',
        firstName: 'Tutor',
        lastName: 'Example',
      },
      subjects: [],
      availability: [],
    });
    prisma.booking.count.mockResolvedValueOnce(1);

    const response = await request(app)
      .get('/api/v1/tutors/tutor-profile-1')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`);

    expect(response.status).toBe(200);
    expect(response.body.data.trialLessonLimit).toBe(2);
    expect(response.body.data.cancellationPolicy).toEqual({
      cutoffHours: 24,
      lateRefundPercent: 0,
    });
    expect(response.body.data.trialLessonsRemaining).toBe(1);
    expect(response.body.data.isTrialLessonEligible).toBe(true);
    expect(prisma.booking.count).toHaveBeenCalledWith({
      where: {
        learnerId: learnerUser.id,
        tutorId: 'tutor-profile-1',
        isTrialLesson: true,
        status: { notIn: ['CANCELLED', 'DECLINED', 'NOT_COMPLETED'] },
      },
    });
  });

  test('allows only the active tutor to update their own valid cancellation policy', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(tutorUser);
    prisma.tutorProfile.update.mockResolvedValueOnce({
      id: 'tutor-profile-1',
      userId: tutorUser.id,
      status: 'ACTIVE',
      cancellationCutoffHours: 48,
      lateCancellationRefundPercent: 50,
      user: { id: tutorUser.id },
      subjects: [],
      availability: [],
    });

    const response = await request(app)
      .put('/api/v1/tutors/me/cancellation-policy')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({
        tutorId: 'another-tutor-profile',
        cutoffHours: 48,
        lateRefundPercent: 50,
      });

    expect(response.status).toBe(200);
    expect(response.body.data.cancellationPolicy).toEqual({
      cutoffHours: 48,
      lateRefundPercent: 50,
    });
    expect(prisma.tutorProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: tutorUser.id },
        data: {
          cancellationCutoffHours: 48,
          lateCancellationRefundPercent: 50,
        },
      })
    );
  });

  test('rejects unsupported cancellation policy values without updating the tutor', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(tutorUser);

    const response = await request(app)
      .put('/api/v1/tutors/me/cancellation-policy')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ cutoffHours: 36, lateRefundPercent: 25 });

    expect(response.status).toBe(400);
    expect(prisma.tutorProfile.update).not.toHaveBeenCalled();
  });

  test('denies cancellation policy updates from learners and inactive tutors', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce(learnerUser)
      .mockResolvedValueOnce({
        ...tutorUser,
        tutorProfile: { ...tutorUser.tutorProfile, status: 'PENDING' },
      });

    const learnerResponse = await request(app)
      .put('/api/v1/tutors/me/cancellation-policy')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ cutoffHours: 24, lateRefundPercent: 0 });
    const inactiveTutorResponse = await request(app)
      .put('/api/v1/tutors/me/cancellation-policy')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ cutoffHours: 24, lateRefundPercent: 0 });

    expect(learnerResponse.status).toBe(403);
    expect(inactiveTutorResponse.status).toBe(403);
    expect(prisma.tutorProfile.update).not.toHaveBeenCalled();
  });

  test('requires an acknowledged cancellation policy when creating a booking', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);

    const response = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({
        tutorId: 'tutor-profile-1',
        subject: 'Mathematics',
        scheduledAt: '2027-05-07T10:00:00.000Z',
        duration: 60,
        sessionType: 'ONLINE',
      });

    expect(response.status).toBe(400);
    expect(prisma.tutorProfile.findFirst).not.toHaveBeenCalled();
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  test('rejects a booking when the acknowledged policy is stale', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.tutorProfile.findFirst.mockResolvedValueOnce({
      id: 'tutor-profile-1',
      userId: tutorUser.id,
      status: 'ACTIVE',
      cancellationCutoffHours: 12,
      lateCancellationRefundPercent: 50,
      user: tutorUser,
      subjects: [],
    });

    const response = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({
        tutorId: 'tutor-profile-1',
        subject: 'Mathematics',
        scheduledAt: '2027-05-07T10:00:00.000Z',
        duration: 60,
        sessionType: 'ONLINE',
        cancellationPolicyAcknowledgement: { cutoffHours: 24, lateRefundPercent: 0 },
      });

    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/policy has changed/i);
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  test('creates a booking for an active tutor profile', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.tutorProfile.findFirst.mockResolvedValueOnce({
      id: 'tutor-profile-1',
      userId: 'tutor-user-1',
      status: 'ACTIVE',
      hourlyRate: '80.00',
      currency: 'AUD',
      preferredMeetingTool: 'ZOOM',
      user: {
        id: 'tutor-user-1',
        firstName: 'Tutor',
        lastName: 'Example',
        avatar: null,
        email: 'tutor@example.com',
      },
      subjects: [
        {
          hourlyRate: '95.50',
          subjectId: 'subject-1',
          subject: { name: 'Mathematics' },
        },
      ],
    });
    prisma.tutorProfile.findUnique.mockResolvedValueOnce({
      id: 'tutor-profile-1',
      user: { timezone: 'UTC' },
      availability: [
        {
          dayOfWeek: 5,
          startTime: '09:00',
          endTime: '12:00',
        },
      ],
    });
    prisma.booking.count.mockResolvedValueOnce(0);
    prisma.booking.findMany.mockResolvedValueOnce([]);
    prisma.booking.create.mockResolvedValueOnce({
      id: 'booking-1',
      learnerId: learnerUser.id,
      tutorId: 'tutor-profile-1',
      subject: 'Mathematics',
      scheduledAt: '2027-05-07T10:00:00.000Z',
      status: 'PENDING',
      totalAmount: 95.5,
      currency: 'AUD',
      payment: { id: 'payment-1', status: 'PENDING', amount: 95.5, currency: 'AUD' },
      learner: {
        id: learnerUser.id,
        firstName: 'Learner',
        lastName: 'Example',
        avatar: null,
        email: learnerUser.email,
      },
      tutorProfile: {
        user: {
          id: 'tutor-user-1',
          firstName: 'Tutor',
          lastName: 'Example',
          avatar: null,
          email: 'tutor@example.com',
          timezone: 'Australia/Sydney',
        },
      },
      statusHistory: [{ status: 'PENDING' }],
    });

    const response = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({
        tutorId: 'tutor-profile-1',
        subjectId: 'subject-1',
        scheduledAt: '2027-05-07T10:00:00.000Z',
        duration: 60,
        sessionType: 'ONLINE',
        cancellationPolicyAcknowledgement: { cutoffHours: 24, lateRefundPercent: 0 },
      });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.message).toBe('Booking request sent successfully');
    expect(response.body.data.subject).toBe('Mathematics');
    expect(prisma.booking.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          hourlyRate: 95.5,
          totalAmount: 95.5,
          cancellationCutoffHours: 24,
          lateCancellationRefundPercent: 0,
          payment: expect.objectContaining({
            create: expect.objectContaining({
              amount: 95.5,
            }),
          }),
        }),
      })
    );
    expect(notify).toHaveBeenCalledWith(
      'tutor-user-1',
      'booking',
      'New Booking Request',
      expect.stringMatching(/^New booking request for .+ (\(GMT[+-][\d:]+\)|UTC)\.$/),
      '/bookings/booking-1'
    );
  });

  test('uses selected subject rate independently of tutor general rate', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.tutorProfile.findFirst.mockResolvedValueOnce({
      id: 'tutor-profile-1',
      userId: 'tutor-user-1',
      status: 'ACTIVE',
      hourlyRate: '80.00',
      currency: 'AUD',
      preferredMeetingTool: 'ZOOM',
      user: {
        id: 'tutor-user-1',
        firstName: 'Tutor',
        lastName: 'Example',
        avatar: null,
        email: 'tutor@example.com',
      },
      subjects: [
        {
          subjectId: 'subject-1',
          hourlyRate: '120.00',
          subject: { name: 'Mathematics' },
        },
      ],
    });
    prisma.tutorProfile.findUnique.mockResolvedValueOnce({
      id: 'tutor-profile-1',
      user: { timezone: 'UTC' },
      availability: [{ dayOfWeek: 5, startTime: '09:00', endTime: '12:00' }],
    });
    prisma.booking.count.mockResolvedValueOnce(0);
    prisma.booking.findMany.mockResolvedValueOnce([]);
    prisma.booking.create.mockResolvedValueOnce({
      id: 'booking-1',
      learnerId: learnerUser.id,
      tutorId: 'tutor-profile-1',
      subject: 'Mathematics',
      scheduledAt: '2027-05-07T10:00:00.000Z',
      status: 'PENDING',
      totalAmount: 60,
      currency: 'AUD',
      payment: { id: 'payment-1', status: 'PENDING', amount: 60, currency: 'AUD' },
      learner: { id: learnerUser.id, firstName: 'Learner', lastName: 'Example', avatar: null, email: learnerUser.email },
      tutorProfile: {
        user: {
          id: 'tutor-user-1',
          firstName: 'Tutor',
          lastName: 'Example',
          avatar: null,
          email: 'tutor@example.com',
          timezone: 'Australia/Sydney',
        },
      },
      statusHistory: [{ status: 'PENDING' }],
    });

    const response = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({
        tutorId: 'tutor-profile-1',
        subjectId: 'subject-1',
        scheduledAt: '2027-05-07T10:00:00.000Z',
        duration: 30,
        sessionType: 'ONLINE',
        cancellationPolicyAcknowledgement: { cutoffHours: 24, lateRefundPercent: 0 },
      });

    expect(response.status).toBe(201);
    expect(prisma.booking.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          hourlyRate: 120,
          totalAmount: 60,
          payment: expect.objectContaining({
            create: expect.objectContaining({ amount: 60 }),
          }),
        }),
      })
    );
  });

  test('adds a tutor subject with a valid hourly rate', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(tutorUser);
    prisma.tutorProfile.findUnique.mockResolvedValueOnce({
      id: 'tutor-profile-1',
      userId: tutorUser.id,
      status: 'ACTIVE',
    });
    prisma.subject.findUnique.mockResolvedValueOnce({ id: 'subject-1', name: 'Mathematics' });
    prisma.tutorSubject.upsert.mockResolvedValueOnce({
      id: 'tutor-subject-1',
      tutorId: 'tutor-profile-1',
      subjectId: 'subject-1',
      level: 'advanced',
      hourlyRate: '88.50',
      subject: { id: 'subject-1', name: 'Mathematics' },
    });

    const response = await request(app)
      .post('/api/v1/tutors/me/subjects')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ subjectId: 'subject-1', level: 'advanced', hourlyRate: '88.50' });

    expect(response.status).toBe(200);
    expect(prisma.tutorSubject.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ hourlyRate: '88.50' }),
        create: expect.objectContaining({ hourlyRate: '88.50' }),
      })
    );
  });

  test.each([[undefined], [''], ['0'], ['-1'], ['abc'], ['12.345']])(
    'rejects invalid tutor subject hourly rate %s',
    async (hourlyRate) => {
      prisma.user.findUnique.mockResolvedValueOnce(tutorUser);
      prisma.tutorProfile.findUnique.mockResolvedValueOnce({
        id: 'tutor-profile-1',
        userId: tutorUser.id,
        status: 'ACTIVE',
      });
      prisma.subject.findUnique.mockResolvedValueOnce({ id: 'subject-1', name: 'Mathematics' });

      const response = await request(app)
        .post('/api/v1/tutors/me/subjects')
        .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
        .send({ subjectId: 'subject-1', level: 'advanced', hourlyRate });

      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/Hourly rate/i);
      expect(prisma.tutorSubject.upsert).not.toHaveBeenCalled();
    }
  );

  test('denies subject rate updates for subjects not owned by the tutor', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(tutorUser);
    prisma.tutorProfile.findUnique.mockResolvedValueOnce({
      id: 'tutor-profile-1',
      userId: tutorUser.id,
      status: 'ACTIVE',
    });
    prisma.tutorSubject.updateMany.mockResolvedValueOnce({ count: 0 });

    const response = await request(app)
      .patch('/api/v1/tutors/me/subjects/other-subject/rate')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ hourlyRate: '90.00' });

    expect(response.status).toBe(404);
    expect(response.body.message).toBe('Subject not found');
    expect(prisma.tutorSubject.updateMany).toHaveBeenCalledWith({
      where: { tutorId: 'tutor-profile-1', subjectId: 'other-subject' },
      data: { hourlyRate: '90.00' },
    });
    expect(prisma.tutorSubject.findUnique).not.toHaveBeenCalled();
  });

  test('creates an eligible free trial lesson without a charge', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.tutorProfile.findFirst.mockResolvedValueOnce({
      id: 'tutor-profile-1',
      userId: 'tutor-user-1',
      status: 'ACTIVE',
      hourlyRate: '80.00',
      trialLessonLimit: 2,
      currency: 'AUD',
      preferredMeetingTool: 'ZOOM',
      user: {
        id: 'tutor-user-1',
        firstName: 'Tutor',
        lastName: 'Example',
        email: 'tutor@example.com',
      },
      subjects: [
        {
          subjectId: 'subject-1',
          subject: { name: 'Mathematics' },
        },
      ],
    });
    prisma.tutorProfile.findUnique.mockResolvedValueOnce(tutorAvailability);
    prisma.booking.count.mockResolvedValueOnce(1);
    prisma.booking.findMany.mockResolvedValueOnce([]);
    prisma.booking.create.mockImplementationOnce(async ({ data }) => ({
      id: 'trial-booking-1',
      ...data,
      payment: data.payment?.create || null,
      learner: learnerRecord,
      tutorProfile: {
        user: {
          id: 'tutor-user-1',
          timezone: 'UTC',
        },
      },
      statusHistory: [{ status: 'PENDING' }],
    }));

    const response = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({
        tutorId: 'tutor-profile-1',
        subjectId: 'subject-1',
        scheduledAt: '2027-05-07T10:00:00.000Z',
        duration: 60,
        sessionType: 'ONLINE',
        useTrialLesson: true,
        cancellationPolicyAcknowledgement: { cutoffHours: 24, lateRefundPercent: 0 },
      });

    expect(response.status).toBe(201);
    expect(response.body.data.isTrialLesson).toBe(true);
    expect(response.body.data.totalAmount).toBe(0);
    expect(response.body.data.payment).toBeNull();
    expect(prisma.booking.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isTrialLesson: true,
          totalAmount: 0,
        }),
      })
    );
    expect(prisma.booking.create.mock.calls[0][0].data).not.toHaveProperty('payment');
    expect(stripePaymentIntentCreate).not.toHaveBeenCalled();
  });

  test('rejects a free trial after the learner has used the tutor allowance', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.tutorProfile.findFirst.mockResolvedValueOnce({
      id: 'tutor-profile-1',
      userId: 'tutor-user-1',
      status: 'ACTIVE',
      hourlyRate: '80.00',
      trialLessonLimit: 1,
      currency: 'AUD',
      user: {
        id: 'tutor-user-1',
        firstName: 'Tutor',
        lastName: 'Example',
      },
      subjects: [
        {
          subjectId: 'subject-1',
          subject: { name: 'Mathematics' },
        },
      ],
    });
    prisma.tutorProfile.findUnique.mockResolvedValueOnce(tutorAvailability);
    prisma.booking.count.mockResolvedValueOnce(1);
    prisma.booking.findMany.mockResolvedValueOnce([]);

    const response = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({
        tutorId: 'tutor-profile-1',
        subjectId: 'subject-1',
        scheduledAt: '2027-05-07T10:00:00.000Z',
        duration: 60,
        sessionType: 'ONLINE',
        useTrialLesson: true,
        cancellationPolicyAcknowledgement: { cutoffHours: 24, lateRefundPercent: 0 },
      });

    expect(response.status).toBe(409);
    expect(response.body.message).toBe(
      'You have already used your trial lesson allowance with this tutor'
    );
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  test('allows a tutor to accept a free trial without a learner payment method', async () => {
    let trialBooking = {
      ...acceptedFutureBooking,
      status: 'PENDING',
      version: 1,
      isTrialLesson: true,
      totalAmount: 0,
      currency: 'AUD',
      payment: null,
      priceOffers: [],
      rescheduleRequests: [],
      statusHistory: [{ status: 'PENDING' }],
    };
    prisma.user.findUnique.mockResolvedValueOnce(tutorUser);
    prisma.tutorProfile.findUnique.mockResolvedValue({
      ...tutorAvailability,
      userId: tutorUser.id,
      status: 'ACTIVE',
      user: { id: tutorUser.id, status: 'ACTIVE', timezone: 'UTC' },
    });
    prisma.bookingPriceOffer.findFirst.mockResolvedValue(null);
    prisma.booking.findUnique.mockImplementation(async () => trialBooking);
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.booking.update.mockImplementation(async () => {
      trialBooking = {
        ...trialBooking,
        version: trialBooking.version + 1,
        status: 'ACCEPTED',
        negotiationStatus: 'NONE',
        rescheduleRequests: [],
      };
      return trialBooking;
    });
    prisma.bookingStatusHistory.create.mockResolvedValue({ id: 'history-trial-accepted' });
    prisma.notification.createMany.mockResolvedValue({ count: 2 });

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 1 });

    expect(response.status).toBe(200);
    expect(response.body.message).toBe('Free trial lesson accepted');
    expect(response.body.data).toEqual(
      expect.objectContaining({
        id: 'booking-1',
        isTrialLesson: true,
        totalAmount: 0,
        payment: null,
      })
    );
    expect(stripePaymentIntentCreate).not.toHaveBeenCalled();
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
  });

  test('accepts and charges one revised recurring occurrence without aggregating its siblings', async () => {
    const booking = buildPendingAcceptanceBooking({
      version: 3,
      totalAmount: 75,
      recurringType: 'WEEKLY',
      recurringGroupId: 'series-1',
      payment: { amount: 75 },
      priceOffers: [{ id: 'offer-1', status: 'ACCEPTED' }],
    });
    const arranged = arrangeAcceptancePayment({ booking });

    const firstResponse = await request(app)
      .patch('/api/v1/bookings/booking-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 3 });
    const repeatedResponse = await request(app)
      .patch('/api/v1/bookings/booking-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 3 });

    expect(firstResponse.status).toBe(200);
    expect(firstResponse.body.outcome).toBe('ACCEPTED');
    expect(repeatedResponse.status).toBe(200);
    expect(repeatedResponse.body.outcome).toBe('ACCEPTED');
    expect(arranged.booking.status).toBe('ACCEPTED');
    expect(arranged.booking.payment).toEqual(
      expect.objectContaining({
        status: 'PAID',
        amount: 75,
        platformFeeAmount: 11.25,
        tutorPayoutAmount: 63.75,
        payoutStatus: 'PENDING',
        payoutPendingAt: expect.any(Date),
      })
    );
    expect(stripePaymentIntentCreate).toHaveBeenCalledTimes(1);
    expect(stripePaymentIntentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 7500,
        currency: 'aud',
        confirm: true,
        off_session: true,
        error_on_requires_action: true,
        metadata: expect.objectContaining({
          bookingId: 'booking-1',
          paymentId: 'payment-1',
          acceptanceAttempt: '1',
        }),
      }),
      { idempotencyKey: 'accept-booking-1:create:1' }
    );
    expect(prisma.bookingStatusHistory.create).toHaveBeenCalledTimes(1);
    expect(prisma.notification.createMany).toHaveBeenCalledTimes(1);
  });

  test('returns 202 and keeps the booking pending while Stripe is processing', async () => {
    const arranged = arrangeAcceptancePayment({ intentStatus: 'processing' });

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 1 });

    expect(response.status).toBe(202);
    expect(response.body.outcome).toBe('PAYMENT_PROCESSING');
    expect(arranged.booking.status).toBe('PENDING');
    expect(arranged.booking.payment.status).toBe('PROCESSING');
    expect(prisma.bookingStatusHistory.create).not.toHaveBeenCalled();
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });

  test('keeps the request pending and returns a structured error when no method is usable', async () => {
    const booking = buildPendingAcceptanceBooking({
      learner: { stripeDefaultPaymentMethodId: null },
      payment: { stripePaymentMethodId: null },
    });
    const arranged = arrangeAcceptancePayment({ booking });

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 1 });

    expect(response.status).toBe(402);
    expect(response.body).toEqual(
      expect.objectContaining({
        code: 'PAYMENT_METHOD_REQUIRED',
        action: 'UPDATE_PAYMENT_METHOD',
        link: '/bookings/booking-1/payment?returnTo=%2Fbookings%2Fbooking-1',
      })
    );
    expect(arranged.booking.status).toBe('PENDING');
    expect(arranged.booking.payment.status).toBe('PENDING');
    expect(stripePaymentIntentCreate).not.toHaveBeenCalled();
    expect(notifyOrRefresh).toHaveBeenCalledWith(
      learnerUser.id,
      'payment',
      'Payment Method Required',
      expect.any(String),
      '/bookings/booking-1/payment?returnTo=%2Fbookings%2Fbooking-1',
      prisma
    );
  });

  test('marks a declined card recoverable without accepting or allocating earnings', async () => {
    const arranged = arrangeAcceptancePayment({ intentStatus: 'requires_payment_method' });

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 1 });

    expect(response.status).toBe(402);
    expect(response.body.code).toBe('PAYMENT_FAILED');
    expect(response.body.action).toBe('UPDATE_PAYMENT_METHOD');
    expect(response.body.message).toBe(
      'The payment method was declined. Please choose another method or contact your bank.'
    );
    expect(response.body.message).not.toContain('Your card was declined');
    expect(arranged.booking.status).toBe('PENDING');
    expect(arranged.booking.payment).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        platformFeeAmount: null,
        tutorPayoutAmount: null,
        payoutStatus: null,
      })
    );
    expect(prisma.bookingStatusHistory.create).not.toHaveBeenCalled();
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
    expect(arranged.booking.payment.attempts).toEqual([
      expect.objectContaining({
        sequence: 1,
        source: 'ACCEPTANCE',
        outcome: 'FAILED',
        providerCode: 'card_declined',
        safeFailureReason:
          'The payment method was declined. Please choose another method or contact your bank.',
      }),
    ]);
  });

  test('lets the owning learner retry a failed acceptance and charges the same booking once', async () => {
    const arranged = arrangeAcceptancePayment({
      intentStatus: 'requires_payment_method',
      retryIntentStatus: 'succeeded',
    });

    const failed = await request(app)
      .patch('/api/v1/bookings/booking-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 1 });
    expect(failed.status).toBe(402);

    prisma.user.findUnique.mockResolvedValue(learnerUser);
    const retried = await request(app)
      .post('/api/v1/payments/bookings/booking-1/retry')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ expectedVersion: 1 });

    expect(retried.status).toBe(200);
    expect(retried.body.outcome).toBe('ACCEPTED');
    expect(retried.body.data.status).toBe('ACCEPTED');
    expect(retried.body.data.payment.status).toBe('PAID');
    expect(retried.body.data.payment).not.toHaveProperty('stripePaymentIntentId');
    expect(retried.body.data.payment).not.toHaveProperty('stripePaymentMethodId');
    expect(retried.body.data.payment.attempts[1]).not.toHaveProperty('providerCode');
    expect(arranged.booking.status).toBe('ACCEPTED');
    expect(arranged.booking.payment.status).toBe('PAID');
    expect(arranged.booking.payment.attempts).toEqual([
      expect.objectContaining({
        sequence: 2,
        source: 'RETRY',
        outcome: 'SUCCEEDED',
      }),
      expect.objectContaining({
        sequence: 1,
        source: 'ACCEPTANCE',
        outcome: 'FAILED',
      }),
    ]);
    expect(stripePaymentIntentCreate).toHaveBeenCalledTimes(1);
    expect(stripePaymentIntentConfirm).toHaveBeenCalledTimes(1);
    expect(prisma.bookingStatusHistory.create).toHaveBeenCalledTimes(1);

    const repeated = await request(app)
      .post('/api/v1/payments/bookings/booking-1/retry')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ expectedVersion: 1 });

    expect(repeated.status).toBe(200);
    expect(repeated.body.outcome).toBe('ACCEPTED');
    expect(stripePaymentIntentConfirm).toHaveBeenCalledTimes(1);
    expect(prisma.bookingStatusHistory.create).toHaveBeenCalledTimes(1);
  });

  test('rejects retry before Stripe when the tutor slot is no longer available', async () => {
    const arranged = arrangeAcceptancePayment({ intentStatus: 'requires_payment_method' });
    const failed = await request(app)
      .patch('/api/v1/bookings/booking-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 1 });
    expect(failed.status).toBe(402);

    prisma.user.findUnique.mockResolvedValue(learnerUser);
    prisma.booking.findMany.mockResolvedValue([
      {
        id: 'accepted-conflict',
        status: 'ACCEPTED',
        scheduledAt: arranged.booking.scheduledAt,
        duration: arranged.booking.duration,
        payment: { status: 'PAID' },
      },
    ]);
    stripePaymentMethodRetrieve.mockClear();
    stripePaymentIntentConfirm.mockClear();
    const attemptsBeforeRetry = arranged.booking.payment.attempts.length;

    const response = await request(app)
      .post('/api/v1/payments/bookings/booking-1/retry')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ expectedVersion: 1 });

    expect(response.status).toBe(409);
    expect(response.body).toEqual(
      expect.objectContaining({
        code: 'SLOT_UNAVAILABLE',
        action: 'CHOOSE_ANOTHER_TIME',
        link: '/bookings/booking-1?action=change-time',
      })
    );
    expect(arranged.booking.payment.status).toBe('FAILED');
    expect(arranged.booking.payment.attempts).toHaveLength(attemptsBeforeRetry);
    expect(stripePaymentMethodRetrieve).not.toHaveBeenCalled();
    expect(stripePaymentIntentConfirm).not.toHaveBeenCalled();
  });

  test('returns slot recovery before Stripe when the failed booking time has expired', async () => {
    const arranged = arrangeAcceptancePayment({ intentStatus: 'requires_payment_method' });
    const failed = await request(app)
      .patch('/api/v1/bookings/booking-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 1 });
    expect(failed.status).toBe(402);

    arranged.booking.scheduledAt = new Date('2020-05-07T10:00:00.000Z');
    prisma.user.findUnique.mockResolvedValue(learnerUser);
    stripePaymentMethodRetrieve.mockClear();
    stripePaymentIntentConfirm.mockClear();
    prisma.paymentAttempt.create.mockClear();

    const response = await request(app)
      .post('/api/v1/payments/bookings/booking-1/retry')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ expectedVersion: 1 });

    expect(response.status).toBe(409);
    expect(response.body).toEqual(
      expect.objectContaining({
        code: 'SLOT_UNAVAILABLE',
        action: 'CHOOSE_ANOTHER_TIME',
      })
    );
    expect(prisma.paymentAttempt.create).not.toHaveBeenCalled();
    expect(stripePaymentMethodRetrieve).not.toHaveBeenCalled();
    expect(stripePaymentIntentConfirm).not.toHaveBeenCalled();
    expect(arranged.booking.payment.status).toBe('FAILED');
  });

  test('records a failed retry when the provider is unavailable before submission', async () => {
    const arranged = arrangeAcceptancePayment({ intentStatus: 'requires_payment_method' });
    const failed = await request(app)
      .patch('/api/v1/bookings/booking-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 1 });
    expect(failed.status).toBe(402);

    prisma.user.findUnique.mockResolvedValue(learnerUser);
    stripeConfigured = false;
    stripePaymentIntentConfirm.mockClear();

    const response = await request(app)
      .post('/api/v1/payments/bookings/booking-1/retry')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ expectedVersion: 1 });

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    expect(arranged.booking.payment.status).toBe('FAILED');
    expect(arranged.booking.payment.attempts[0]).toEqual(
      expect.objectContaining({
        sequence: 2,
        source: 'RETRY',
        outcome: 'FAILED',
        providerCode: 'provider_unavailable',
        safeFailureReason: 'Payment processing is temporarily unavailable. Please try again later.',
      })
    );
    expect(stripePaymentIntentConfirm).not.toHaveBeenCalled();
  });

  test('denies a retry by another learner before mutation or provider access', async () => {
    const arranged = arrangeAcceptancePayment({ intentStatus: 'requires_payment_method' });
    const failed = await request(app)
      .patch('/api/v1/bookings/booking-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 1 });
    expect(failed.status).toBe(402);

    prisma.user.findUnique.mockResolvedValue(otherLearnerUser);
    prisma.$transaction.mockClear();
    stripePaymentMethodRetrieve.mockClear();
    stripePaymentIntentConfirm.mockClear();
    prisma.payment.updateMany.mockClear();

    const response = await request(app)
      .post('/api/v1/payments/bookings/booking-1/retry')
      .set('Authorization', `Bearer ${createAccessToken(otherLearnerUser)}`)
      .send({ expectedVersion: 1 });

    expect(response.status).toBe(404);
    expect(response.body.message).toBe('Booking not found');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(stripePaymentMethodRetrieve).not.toHaveBeenCalled();
    expect(stripePaymentIntentConfirm).not.toHaveBeenCalled();
    expect(arranged.booking.status).toBe('PENDING');
  });

  test('hides a retry from non-learners before mutation or provider access', async () => {
    const arranged = arrangeAcceptancePayment({ intentStatus: 'requires_payment_method' });
    const failed = await request(app)
      .patch('/api/v1/bookings/booking-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 1 });
    expect(failed.status).toBe(402);

    prisma.user.findUnique.mockResolvedValue(tutorUser);
    prisma.$transaction.mockClear();
    prisma.payment.updateMany.mockClear();
    stripePaymentMethodRetrieve.mockClear();
    stripePaymentIntentConfirm.mockClear();

    const response = await request(app)
      .post('/api/v1/payments/bookings/booking-1/retry')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 1 });

    expect(response.status).toBe(404);
    expect(response.body.message).toBe('Booking not found');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(stripePaymentMethodRetrieve).not.toHaveBeenCalled();
    expect(stripePaymentIntentConfirm).not.toHaveBeenCalled();
    expect(arranged.booking.status).toBe('PENDING');
  });

  test('rejects a retry when the booking version no longer matches its acceptance authorization', async () => {
    const arranged = arrangeAcceptancePayment({ intentStatus: 'requires_payment_method' });
    const failed = await request(app)
      .patch('/api/v1/bookings/booking-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 1 });
    expect(failed.status).toBe(402);

    arranged.booking.version = 2;
    prisma.user.findUnique.mockResolvedValue(learnerUser);
    prisma.payment.updateMany.mockClear();
    prisma.paymentAttempt.create.mockClear();
    stripePaymentMethodRetrieve.mockClear();
    stripePaymentIntentConfirm.mockClear();

    const response = await request(app)
      .post('/api/v1/payments/bookings/booking-1/retry')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ expectedVersion: 2 });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('BOOKING_CHANGED');
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(prisma.paymentAttempt.create).not.toHaveBeenCalled();
    expect(stripePaymentMethodRetrieve).not.toHaveBeenCalled();
    expect(stripePaymentIntentConfirm).not.toHaveBeenCalled();
    expect(arranged.booking.payment.status).toBe('FAILED');
  });

  test('ignores a late success webhook from an older attempt while a newer retry is processing', async () => {
    const arranged = arrangeAcceptancePayment({
      intentStatus: 'requires_payment_method',
      retryIntentStatus: 'processing',
    });
    const failed = await request(app)
      .patch('/api/v1/bookings/booking-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 1 });
    expect(failed.status).toBe(402);

    const firstIntentParams = stripePaymentIntentCreate.mock.calls[0][0];
    prisma.user.findUnique.mockResolvedValue(learnerUser);
    const retry = await request(app)
      .post('/api/v1/payments/bookings/booking-1/retry')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ expectedVersion: 1 });
    expect(retry.status).toBe(202);
    expect(arranged.booking.payment.acceptanceAttemptCount).toBe(2);

    stripeWebhookConstructEvent.mockReturnValue({
      id: 'evt_late_success_attempt_1',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_booking_1',
          status: 'succeeded',
          amount: firstIntentParams.amount,
          currency: firstIntentParams.currency,
          customer: firstIntentParams.customer,
          payment_method: firstIntentParams.payment_method,
          metadata: firstIntentParams.metadata,
        },
      },
    });

    const response = await request(app)
      .post('/api/v1/payments/stripe/webhook')
      .set('stripe-signature', 'signed')
      .set('content-type', 'application/json')
      .send('{}');

    expect(response.status).toBe(200);
    expect(arranged.booking.status).toBe('PENDING');
    expect(arranged.booking.payment.status).toBe('PROCESSING');
    expect(arranged.booking.payment.attempts[0]).toEqual(
      expect.objectContaining({ sequence: 2, outcome: 'PROCESSING' })
    );
    expect(prisma.bookingStatusHistory.create).not.toHaveBeenCalled();
  });

  test('deduplicates a success webhook and ignores a later failure for the paid attempt', async () => {
    const arranged = arrangeAcceptancePayment({ intentStatus: 'processing' });
    const acceptanceResponse = await request(app)
      .patch('/api/v1/bookings/booking-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 1 });
    expect(acceptanceResponse.status).toBe(202);

    const intentParams = stripePaymentIntentCreate.mock.calls[0][0];
    const succeededIntent = {
      id: 'pi_booking_1',
      status: 'succeeded',
      amount: intentParams.amount,
      currency: intentParams.currency,
      customer: intentParams.customer,
      payment_method: intentParams.payment_method,
      metadata: intentParams.metadata,
    };
    const seenEventIds = new Set();
    prisma.stripeWebhookEvent.create.mockImplementation(async ({ data }) => {
      if (seenEventIds.has(data.eventId)) {
        const error = new Error('Duplicate Stripe event');
        error.code = 'P2002';
        throw error;
      }
      seenEventIds.add(data.eventId);
      return data;
    });
    const successEvent = {
      id: 'evt_success_1',
      type: 'payment_intent.succeeded',
      data: { object: succeededIntent },
    };
    const lateFailureEvent = {
      id: 'evt_failure_late',
      type: 'payment_intent.payment_failed',
      data: {
        object: {
          ...succeededIntent,
          status: 'requires_payment_method',
          last_payment_error: { message: 'Late failure' },
        },
      },
    };
    stripeWebhookConstructEvent
      .mockReturnValueOnce(successEvent)
      .mockReturnValueOnce(successEvent)
      .mockReturnValueOnce(lateFailureEvent);
    const webhook = () =>
      request(app)
        .post('/api/v1/payments/stripe/webhook')
        .set('stripe-signature', 'signed')
        .set('content-type', 'application/json')
        .send('{}');

    const success = await webhook();
    const duplicate = await webhook();
    const lateFailure = await webhook();

    expect(success.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(lateFailure.status).toBe(200);
    expect(arranged.booking.status).toBe('ACCEPTED');
    expect(arranged.booking.payment.status).toBe('PAID');
    expect(prisma.bookingStatusHistory.create).toHaveBeenCalledTimes(1);
    expect(prisma.notification.createMany).toHaveBeenCalledTimes(1);
  });

  test('issues and records the snapshotted 50 percent refund for a late learner cancellation', async () => {
    const lateBooking = {
      ...acceptedFutureBooking,
      scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
      cancellationCutoffHours: 24,
      lateCancellationRefundPercent: 50,
      isTrialLesson: false,
      currency: 'AUD',
      payment: {
        id: 'payment-1',
        status: 'PAID',
        amount: 80,
        currency: 'AUD',
        platformFeePercent: 15,
        platformFeeAmount: 12,
        tutorPayoutAmount: 68,
        payoutStatus: 'PENDING',
        stripePaymentIntentId: 'pi_paid_booking',
      },
    };
    stripeConfigured = true;
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.booking.findUnique
      .mockResolvedValueOnce(lateBooking)
      .mockResolvedValueOnce(lateBooking);
    prisma.booking.update.mockResolvedValueOnce({
      ...lateBooking,
      status: 'CANCELLED',
      payment: {
        ...lateBooking.payment,
        status: 'PARTIALLY_REFUNDED',
        refundAmount: 40,
      },
    });

    const response = await request(app)
      .post('/api/v1/bookings/booking-1/cancel')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ reason: 'Schedule changed' });

    expect(response.status).toBe(200);
    expect(response.body.refund).toEqual({ percent: 50, amount: 40, currency: 'AUD' });
    expect(stripeRefundCreate).toHaveBeenCalledWith({
      payment_intent: 'pi_paid_booking',
      amount: 4000,
    });
    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'payment-1' },
        data: expect.objectContaining({
          status: 'PARTIALLY_REFUNDED',
          refundAmount: 40,
          refundedAt: expect.any(Date),
          platformFeePercent: 15,
          platformFeeAmount: 6,
          tutorPayoutAmount: 34,
          payoutStatus: 'ELIGIBLE',
          payoutEligibleAt: expect.any(Date),
        }),
      })
    );
    expect(prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'CANCELLED',
          cancellationOutcome: expect.objectContaining({
            retainedAmount: 40,
            platformFeeAmount: 6,
            tutorPayoutAmount: 34,
          }),
        }),
      })
    );
  });

  test('holds positive tutor earnings for 48 hours when the tutor completes a paid lesson', async () => {
    const completedAtBooking = {
      ...acceptedFutureBooking,
      status: 'ACCEPTED',
      scheduledAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      payment: {
        id: 'payment-complete-1',
        status: 'PAID',
        payoutStatus: 'PENDING',
        tutorPayoutAmount: 85,
      },
    };
    prisma.user.findUnique.mockResolvedValueOnce(tutorUser);
    prisma.tutorProfile.findUnique.mockResolvedValue({ id: 'tutor-profile-1' });
    prisma.booking.findUnique.mockResolvedValueOnce(completedAtBooking);
    prisma.payment.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.booking.update.mockImplementation(({ data }) =>
      Promise.resolve({
        ...completedAtBooking,
        status: data.status,
        completedAt: data.completedAt,
        payment: {
          ...completedAtBooking.payment,
          payoutStatus: 'PENDING',
          payoutEligibleAt: null,
        },
      })
    );
    prisma.tutorProfile.update.mockResolvedValueOnce({ id: 'tutor-profile-1' });

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/complete')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 1 });

    expect(response.status).toBe(200);
    expect(prisma.payment.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'payment-complete-1',
        payoutStatus: 'PENDING',
      },
      data: {
        payoutStatus: 'PENDING',
        payoutEligibleAt: null,
      },
    });
    expect(prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          completionReviewStatus: 'AWAITING_LEARNER',
          completionReviewDueAt: expect.any(Date),
        }),
      })
    );
  });

  test('lets the learner confirm completion early without initiating an immediate payout', async () => {
    const reviewDueAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const completedBooking = {
      ...acceptedFutureBooking,
      status: 'COMPLETED',
      completionReviewStatus: 'AWAITING_LEARNER',
      completionReviewDueAt: reviewDueAt,
      payment: {
        id: 'payment-confirm-1',
        status: 'PAID',
        payoutStatus: 'PENDING',
        tutorPayoutAmount: 85,
      },
    };
    const confirmedBooking = {
      ...completedBooking,
      version: 2,
      completionReviewStatus: 'CLEARED',
      completionReviewResolvedAt: new Date(),
      completionReviewResolvedById: learnerUser.id,
      completionReviewResolutionNote: 'Learner confirmed that the lesson was completed.',
      completionResolution: 'LEARNER_CONFIRMED',
      payment: {
        ...completedBooking.payment,
        payoutStatus: 'ELIGIBLE',
      },
    };

    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.booking.findUnique
      .mockResolvedValueOnce(completedBooking)
      .mockResolvedValueOnce(confirmedBooking);
    prisma.booking.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.payment.updateMany.mockResolvedValueOnce({ count: 1 });

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/completion-review/confirm')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ expectedVersion: 1 });

    expect(response.status).toBe(200);
    expect(prisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'booking-1',
          learnerId: learnerUser.id,
          version: 1,
          completionReviewStatus: 'AWAITING_LEARNER',
        }),
        data: expect.objectContaining({
          completionReviewStatus: 'CLEARED',
          completionResolution: 'LEARNER_CONFIRMED',
          completionReviewResolvedById: learnerUser.id,
        }),
      })
    );
    expect(prisma.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'payment-confirm-1', payoutStatus: 'PENDING' },
        data: expect.objectContaining({ payoutStatus: 'ELIGIBLE' }),
      })
    );
    expect(stripePaymentIntentCreate).not.toHaveBeenCalled();
    expect(response.body.data.completionResolution).toBe('LEARNER_CONFIRMED');
  });

  test('records a free-trial confirmation without creating an earning or payout', async () => {
    const completedTrial = {
      ...acceptedFutureBooking,
      isTrialLesson: true,
      totalAmount: 0,
      status: 'COMPLETED',
      completionReviewStatus: 'AWAITING_LEARNER',
      completionReviewDueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      payment: null,
    };
    const confirmedTrial = {
      ...completedTrial,
      version: 2,
      completionReviewStatus: 'CLEARED',
      completionResolution: 'LEARNER_CONFIRMED',
      completionReviewResolvedAt: new Date(),
    };

    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.booking.findUnique
      .mockResolvedValueOnce(completedTrial)
      .mockResolvedValueOnce(confirmedTrial);
    prisma.booking.updateMany.mockResolvedValueOnce({ count: 1 });

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/completion-review/confirm')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ expectedVersion: 1 });

    expect(response.status).toBe(200);
    expect(response.body.message).toMatch(/No earning or payout was created/i);
    expect(response.body.data.completionResolution).toBe('LEARNER_CONFIRMED');
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(stripePaymentIntentCreate).not.toHaveBeenCalled();
  });

  test('lets the assigned tutor mark a started paid lesson as not completed and requests one full refund', async () => {
    const payment = {
      id: 'payment-not-completed-1',
      bookingId: 'booking-1',
      status: 'PAID',
      amount: 100,
      refundAmount: 0,
      currency: 'AUD',
      platformFeePercent: 15,
      platformFeeAmount: 15,
      tutorPayoutAmount: 85,
      payoutStatus: 'PENDING',
      stripePaymentIntentId: 'pi_not_completed_1',
      refund: null,
    };
    const startedBooking = {
      ...acceptedFutureBooking,
      scheduledAt: new Date(Date.now() - 30 * 60 * 1000),
      totalAmount: 100,
      currency: 'AUD',
      isTrialLesson: false,
      payment,
    };
    let attemptRecord;
    let refundRecord;

    stripeConfigured = true;
    stripeRefundCreate.mockResolvedValue({ id: 're_not_completed_1', status: 'succeeded' });
    prisma.user.findUnique.mockResolvedValueOnce(tutorUser);
    prisma.tutorProfile.findUnique.mockResolvedValue({ id: 'tutor-profile-1' });
    prisma.booking.findUnique
      .mockResolvedValueOnce(startedBooking)
      .mockResolvedValueOnce(startedBooking)
      .mockImplementation(async () => ({
        ...startedBooking,
        status: 'NOT_COMPLETED',
        version: 2,
        completionReviewStatus: 'RESOLVED_LEARNER',
        completionResolution: 'TUTOR_REPORTED_NOT_COMPLETED',
        payment: { ...payment, status: 'REFUNDED', refund: refundRecord },
      }));
    prisma.booking.update.mockImplementation(async ({ data }) => ({
      ...startedBooking,
      ...data,
      version: 2,
      status: 'NOT_COMPLETED',
      completionReviewStatus: 'RESOLVED_LEARNER',
      completionResolution: 'TUTOR_REPORTED_NOT_COMPLETED',
    }));
    prisma.paymentRefund.findUnique.mockImplementation(async ({ where }) => {
      if (where.paymentId) return null;
      return refundRecord
        ? {
            ...refundRecord,
            attempts: [attemptRecord],
            payment: { ...payment, booking: startedBooking },
          }
        : null;
    });
    prisma.paymentRefund.create.mockImplementation(async ({ data }) => {
      attemptRecord = {
        id: 'refund-attempt-1',
        refundId: data.id,
        ...data.attempts.create,
      };
      refundRecord = {
        id: data.id,
        paymentId: data.paymentId,
        source: data.source,
        amount: data.amount,
        currency: data.currency,
        status: data.status,
        attemptCount: data.attemptCount,
        resolutionNote: data.resolutionNote,
        attempts: [attemptRecord],
      };
      return refundRecord;
    });
    prisma.paymentRefundAttempt.findUnique.mockImplementation(async () => attemptRecord);
    prisma.paymentRefundAttempt.update.mockImplementation(async ({ data }) => {
      attemptRecord = { ...attemptRecord, ...data };
      return attemptRecord;
    });
    prisma.paymentRefund.update.mockImplementation(async ({ data }) => {
      refundRecord = { ...refundRecord, ...data };
      return refundRecord;
    });

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/not-completed')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ reason: 'I had a medical emergency.', expectedVersion: 1 });

    expect(response.status).toBe(200);
    expect(prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'booking-1', status: 'ACCEPTED', version: 1 },
        data: expect.objectContaining({
          status: 'NOT_COMPLETED',
          completionReviewStatus: 'RESOLVED_LEARNER',
          completionResolution: 'TUTOR_REPORTED_NOT_COMPLETED',
          completionReviewResolutionNote: 'I had a medical emergency.',
        }),
      })
    );
    expect(stripeRefundCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: 'pi_not_completed_1',
        amount: 10000,
        metadata: expect.objectContaining({
          bookingId: 'booking-1',
          source: 'TUTOR_NON_COMPLETION',
        }),
      }),
      { idempotencyKey: expect.stringMatching(/^pay08_refund_.+_attempt_1$/) }
    );
    expect(prisma.payment.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: 'payment-not-completed-1' },
        data: expect.objectContaining({
          status: 'REFUNDED',
          refundAmount: 100,
          tutorPayoutAmount: 0,
          payoutStatus: null,
        }),
      })
    );
    expect(response.body.data.status).toBe('NOT_COMPLETED');
    expect(response.body.refund.status).toBe('SUCCEEDED');
  });

  test('marks a started free trial as not completed without creating a refund or earning', async () => {
    const startedTrial = {
      ...acceptedFutureBooking,
      scheduledAt: new Date(Date.now() - 30 * 60 * 1000),
      totalAmount: 0,
      isTrialLesson: true,
      payment: null,
    };
    const finalTrial = {
      ...startedTrial,
      status: 'NOT_COMPLETED',
      version: 2,
      completionReviewStatus: 'RESOLVED_LEARNER',
      completionResolution: 'TUTOR_REPORTED_NOT_COMPLETED',
    };

    prisma.user.findUnique.mockResolvedValueOnce(tutorUser);
    prisma.tutorProfile.findUnique.mockResolvedValue({ id: 'tutor-profile-1' });
    prisma.booking.findUnique
      .mockResolvedValueOnce(startedTrial)
      .mockResolvedValueOnce(startedTrial)
      .mockResolvedValueOnce(finalTrial);
    prisma.booking.update.mockResolvedValueOnce(finalTrial);

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/not-completed')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ reason: 'An emergency ended the trial early.', expectedVersion: 1 });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('NOT_COMPLETED');
    expect(response.body.refund).toBeNull();
    expect(prisma.paymentRefund.create).not.toHaveBeenCalled();
    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(stripeRefundCreate).not.toHaveBeenCalled();
  });

  test('does not let an unassigned tutor mark another tutor\'s lesson as not completed', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(tutorUser);
    prisma.tutorProfile.findUnique.mockResolvedValue({ id: 'another-tutor-profile' });
    prisma.booking.findUnique.mockResolvedValueOnce({
      ...acceptedFutureBooking,
      scheduledAt: new Date(Date.now() - 30 * 60 * 1000),
    });

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/not-completed')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ reason: 'I could not finish the lesson.', expectedVersion: 1 });

    expect(response.status).toBe(404);
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(prisma.paymentRefund.create).not.toHaveBeenCalled();
    expect(stripeRefundCreate).not.toHaveBeenCalled();
  });

  test('does not let a suspended tutor force a learner refund', async () => {
    const suspendedTutor = { ...tutorUser, status: 'SUSPENDED' };
    prisma.user.findUnique.mockResolvedValueOnce(suspendedTutor);

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/not-completed')
      .set('Authorization', `Bearer ${createAccessToken(suspendedTutor)}`)
      .send({ reason: 'I could not finish the lesson.', expectedVersion: 1 });

    expect(response.status).toBe(403);
    expect(prisma.booking.findUnique).not.toHaveBeenCalled();
    expect(prisma.paymentRefund.create).not.toHaveBeenCalled();
    expect(stripeRefundCreate).not.toHaveBeenCalled();
  });

  test('does not let a suspended learner decide a completion review', async () => {
    const suspendedLearner = { ...learnerUser, status: 'SUSPENDED' };
    prisma.user.findUnique.mockResolvedValueOnce(suspendedLearner);

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/completion-review/confirm')
      .set('Authorization', `Bearer ${createAccessToken(suspendedLearner)}`)
      .send({ expectedVersion: 1 });

    expect(response.status).toBe(403);
    expect(prisma.booking.findUnique).not.toHaveBeenCalled();
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
  });

  test('lets the learner dispute completion during the 48-hour window and pauses payout', async () => {
    const reviewDueAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const completedBooking = {
      ...acceptedFutureBooking,
      status: 'COMPLETED',
      completionReviewStatus: 'AWAITING_LEARNER',
      completionReviewDueAt: reviewDueAt,
      payment: {
        id: 'payment-dispute-1',
        status: 'PAID',
        payoutStatus: 'PENDING',
        tutorPayoutAmount: 85,
      },
    };
    const disputedBooking = {
      ...completedBooking,
      completionReviewStatus: 'DISPUTED',
      completionDisputedAt: new Date(),
      completionDisputeReason: 'The tutor did not attend.',
    };

    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.booking.findUnique
      .mockResolvedValueOnce(completedBooking)
      .mockResolvedValueOnce(disputedBooking);
    prisma.booking.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.payment.updateMany.mockResolvedValueOnce({ count: 1 });

    const response = await request(app)
      .post('/api/v1/bookings/booking-1/completion-dispute')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ reason: 'The tutor did not attend.', expectedVersion: 1 });

    expect(response.status).toBe(200);
    expect(prisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          completionReviewStatus: 'DISPUTED',
          completionDisputeReason: 'The tutor did not attend.',
        }),
      })
    );
    expect(prisma.payment.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'payment-dispute-1',
        payoutStatus: { in: ['PENDING', 'ELIGIBLE'] },
      },
      data: {
        payoutStatus: 'DISPUTED',
        payoutEligibleAt: null,
        payoutFailedAt: null,
        payoutFailureReason: null,
      },
    });
    expect(notifyAdmin).toHaveBeenCalledWith(
      'payment',
      'Completion dispute requires review',
      expect.any(String),
      '/admin/payouts'
    );
  });

  test('does not rewrite a terminal payout record through normal cancellation', async () => {
    const terminalPayoutBooking = {
      ...acceptedFutureBooking,
      scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
      payment: {
        id: 'payment-terminal-1',
        status: 'PAID',
        amount: 100,
        payoutStatus: 'PAID',
        payoutAt: new Date(),
        tutorPayoutAmount: 85,
      },
    };
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.booking.findUnique.mockResolvedValueOnce(terminalPayoutBooking);

    const response = await request(app)
      .post('/api/v1/bookings/booking-1/cancel')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ reason: 'Schedule changed' });

    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/terminal payout record/i);
    expect(stripeRefundCreate).not.toHaveBeenCalled();
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });

  test('lets a learner replace an expired failed-payment time and clears stale acceptance', async () => {
    const failedPayment = {
      ...buildPendingAcceptanceBooking().payment,
      status: 'FAILED',
      failureReason: 'The payment method was declined.',
      failedAt: new Date(),
      acceptanceAttemptCount: 1,
      acceptanceMode: 'TUTOR_ACCEPT',
      acceptanceAuthorizedById: tutorUser.id,
      acceptanceAuthorizedAt: new Date(),
      acceptanceBookingVersion: 1,
      acceptanceMeetingLink: 'https://meet.example/session',
    };
    const pendingBooking = {
      ...acceptedFutureBooking,
      status: 'PENDING',
      version: 1,
      scheduledAt: new Date('2020-05-07T10:00:00.000Z'),
      negotiationStatus: 'NONE',
      payment: failedPayment,
      priceOffers: [],
      rescheduleRequests: [],
    };
    const changedAt = new Date('2027-05-07T11:00:00.000Z');
    const historyEntry = {
      id: 'requested-time-change-1',
      bookingId: pendingBooking.id,
      learnerId: learnerUser.id,
      tutorId: pendingBooking.tutorId,
      currentScheduledAt: pendingBooking.scheduledAt,
      proposedScheduledAt: changedAt,
      reason: 'Class timetable changed',
      status: 'ACCEPTED',
      createdAt: new Date(),
    };

    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.booking.findUnique
      .mockResolvedValueOnce(pendingBooking)
      .mockResolvedValueOnce(pendingBooking);
    prisma.booking.findMany.mockResolvedValueOnce([]);
    prisma.tutorProfile.findUnique.mockResolvedValueOnce(tutorAvailability);
    prisma.booking.update.mockResolvedValueOnce({
      ...pendingBooking,
      scheduledAt: changedAt,
      version: 2,
      rescheduleRequests: [historyEntry],
    });

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/requested-time')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({
        scheduledAt: changedAt.toISOString(),
        expectedVersion: 1,
        reason: 'Class timetable changed',
      });

    expect(response.status).toBe(200);
    expect(response.body.message).toBe('Requested time changed');
    expect(response.body.data).toEqual(
      expect.objectContaining({
        id: 'booking-1',
        status: 'PENDING',
        version: 2,
      })
    );
    expect(prisma.booking.update).toHaveBeenCalledWith({
      where: {
        id: 'booking-1',
        status: 'PENDING',
        version: 1,
      },
      data: expect.objectContaining({
        scheduledAt: changedAt,
        version: { increment: 1 },
        payment: {
          update: {
            status: 'PENDING',
            failedAt: null,
            failureReason: null,
            acceptanceMode: null,
            acceptanceAuthorizedById: null,
            acceptanceAuthorizedAt: null,
            acceptanceBookingVersion: null,
            acceptanceMeetingLink: null,
          },
        },
        rescheduleRequests: {
          create: expect.objectContaining({
            currentScheduledAt: pendingBooking.scheduledAt,
            proposedScheduledAt: changedAt,
            status: 'ACCEPTED',
          }),
        },
      }),
      include: expect.any(Object),
    });
    expect(notifyOrRefresh).toHaveBeenCalledWith(
      'tutor-user-1',
      'booking',
      'Requested Time Changed',
      expect.stringContaining('changed the requested time'),
      '/bookings/booking-1'
    );
  });

  test('rejects a pending requested-time change when the new slot overlaps another booking', async () => {
    const pendingBooking = {
      ...acceptedFutureBooking,
      status: 'PENDING',
      version: 1,
    };

    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.booking.findUnique
      .mockResolvedValueOnce(pendingBooking)
      .mockResolvedValueOnce(pendingBooking);
    prisma.booking.findMany.mockResolvedValueOnce([
      {
        id: 'other-booking',
        scheduledAt: new Date('2027-05-07T11:00:00.000Z'),
        duration: 60,
      },
    ]);

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/requested-time')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({
        scheduledAt: '2027-05-07T11:30:00.000Z',
        expectedVersion: 1,
      });

    expect(response.status).toBe(409);
    expect(response.body.message).toBe('This time slot has already been booked');
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(notifyOrRefresh).not.toHaveBeenCalled();
  });

  test.each([
    ['a past time', '2020-05-07T11:00:00.000Z', 'Proposed time must be in the future', false],
    [
      'a time outside tutor availability',
      '2027-05-07T14:00:00.000Z',
      "Booking time 14:00-15:00 is outside tutor's availability. Available slots: 09:00-13:00",
      true,
    ],
    [
      'a time off the scheduling grid',
      '2027-05-07T11:15:00.000Z',
      'Start time must be on the hour or half-hour.',
      true,
    ],
  ])('keeps the original pending time when the learner selects %s', async (_label, proposedAt, message, needsAvailability) => {
    const pendingBooking = {
      ...acceptedFutureBooking,
      status: 'PENDING',
      version: 1,
    };

    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.booking.findUnique
      .mockResolvedValueOnce(pendingBooking)
      .mockResolvedValueOnce(pendingBooking);
    if (needsAvailability) {
      prisma.booking.findMany.mockResolvedValueOnce([]);
      prisma.tutorProfile.findUnique.mockResolvedValueOnce(tutorAvailability);
    }

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/requested-time')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({
        scheduledAt: proposedAt,
        expectedVersion: 1,
      });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe(message);
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(notifyOrRefresh).not.toHaveBeenCalled();
  });

  test('rejects a learner time change if the tutor accepted the request first', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.booking.findUnique
      .mockResolvedValueOnce(acceptedFutureBooking)
      .mockResolvedValueOnce(acceptedFutureBooking);

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/requested-time')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({
        scheduledAt: '2027-05-07T11:00:00.000Z',
        expectedVersion: 1,
      });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('BOOKING_CHANGED');
    expect(response.body.message).toBe(
      'This request is no longer pending. Refresh to see its latest status.'
    );
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  test('does not reveal a pending booking when another learner tries to change its requested time', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.booking.findUnique.mockResolvedValueOnce({
      ...acceptedFutureBooking,
      learnerId: 'another-learner',
      status: 'PENDING',
      version: 1,
    });

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/requested-time')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({
        scheduledAt: '2027-05-07T11:00:00.000Z',
        expectedVersion: 1,
      });

    expect(response.status).toBe(404);
    expect(response.body.message).toBe('Booking not found');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  test('rejects a stale tutor acceptance after the learner changes the requested time', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(tutorUser);
    prisma.tutorProfile.findUnique.mockResolvedValueOnce({ id: 'tutor-profile-1' });
    prisma.booking.findUnique.mockResolvedValueOnce({
      ...acceptedFutureBooking,
      status: 'PENDING',
      version: 2,
      scheduledAt: new Date('2027-05-07T11:00:00.000Z'),
    });

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 1 });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('BOOKING_CHANGED');
    expect(response.body.message).toBe(
      'The booking changed before it could be accepted. Refresh to see the latest request.'
    );
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(notifyOrRefresh).not.toHaveBeenCalled();
  });

  test('rejects booking creation when the tutor time slot is already taken', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.tutorProfile.findFirst.mockResolvedValueOnce({
      id: 'tutor-profile-1',
      userId: 'tutor-user-1',
      status: 'ACTIVE',
      hourlyRate: '80.00',
      currency: 'AUD',
      preferredMeetingTool: 'ZOOM',
      user: {
        id: 'tutor-user-1',
        firstName: 'Tutor',
        lastName: 'Example',
        avatar: null,
        email: 'tutor@example.com',
      },
      subjects: [
        {
          subjectId: 'subject-1',
          subject: { name: 'Mathematics' },
        },
      ],
    });
    prisma.booking.count.mockResolvedValueOnce(0);
    prisma.booking.findMany.mockResolvedValueOnce([
      {
        id: 'existing-booking',
        scheduledAt: '2027-05-07T10:00:00.000Z',
        duration: 60,
      },
    ]);

    const response = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({
        tutorId: 'tutor-profile-1',
        subjectId: 'subject-1',
        scheduledAt: '2027-05-07T10:30:00.000Z',
        duration: 60,
        sessionType: 'ONLINE',
        cancellationPolicyAcknowledgement: { cutoffHours: 24, lateRefundPercent: 0 },
      });

    expect(response.status).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('This time slot has already been booked');
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  test('returns payment method unavailable data when Stripe is not configured', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce(learnerUser)
      .mockResolvedValueOnce({
        stripeCustomerId: null,
        stripeDefaultPaymentMethodId: null,
      });

    const response = await request(app)
      .get('/api/v1/payments/method')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toEqual({
      hasPaymentMethod: false,
      paymentMethod: null,
      paymentMethods: [],
      unavailable: true,
    });
  });

  test('rejects setup intent creation when Stripe is not configured', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);

    const response = await request(app)
      .post('/api/v1/payments/setup-intent')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({});

    expect(response.status).toBe(503);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Payment setup is currently unavailable');
  });

  test('rejects default payment method updates when Stripe is not configured', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce(learnerUser)
      .mockResolvedValueOnce({
        stripeCustomerId: 'local_customer_learner-1',
      });
    prisma.user.update.mockResolvedValueOnce({
      id: learnerUser.id,
      stripeDefaultPaymentMethodId: 'pm_local_1',
    });

    const response = await request(app)
      .patch('/api/v1/payments/method/default')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ paymentMethodId: 'pm_local_1' });

    expect(response.status).toBe(503);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Payment setup is currently unavailable');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('returns Stripe unavailable before checking for a customer record', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce(learnerUser)
      .mockResolvedValueOnce({
        stripeCustomerId: null,
      });

    const response = await request(app)
      .patch('/api/v1/payments/method/default')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ paymentMethodId: 'pm_local_1' });

    expect(response.status).toBe(503);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Payment setup is currently unavailable');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('saves an owned successful setup intent as the replacement default and returns safe metadata', async () => {
    stripeConfigured = true;
    prisma.user.findUnique
      .mockResolvedValueOnce(learnerUser)
      .mockResolvedValueOnce({
        id: learnerUser.id,
        stripeCustomerId: 'cus_learner_1',
      });
    stripeSetupIntentRetrieve.mockResolvedValueOnce({
      id: 'seti_learner_1',
      status: 'succeeded',
      customer: 'cus_learner_1',
      payment_method: ownedPaymentMethod.id,
      metadata: { userId: learnerUser.id },
    });
    stripePaymentMethodRetrieve.mockResolvedValueOnce(ownedPaymentMethod);
    prisma.user.update.mockResolvedValueOnce({
      id: learnerUser.id,
      stripeCustomerId: 'cus_learner_1',
      stripeDefaultPaymentMethodId: ownedPaymentMethod.id,
    });

    const response = await request(app)
      .post('/api/v1/payments/complete-setup-intent')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ setupIntentId: 'seti_learner_1' });

    expect(response.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: learnerUser.id },
      data: {
        stripeCustomerId: 'cus_learner_1',
        stripeDefaultPaymentMethodId: ownedPaymentMethod.id,
      },
      select: {
        id: true,
        stripeCustomerId: true,
        stripeDefaultPaymentMethodId: true,
      },
    });
    expect(response.body.data.paymentMethod).toEqual({
      id: ownedPaymentMethod.id,
      type: 'card',
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2030,
      billingName: 'Learner Example',
    });
    expect(response.body.data.paymentMethod).not.toHaveProperty('customer');
    expect(response.body.data.paymentMethod).not.toHaveProperty('card');
  });

  test('does not save a setup intent that belongs to another learner', async () => {
    stripeConfigured = true;
    prisma.user.findUnique
      .mockResolvedValueOnce(learnerUser)
      .mockResolvedValueOnce({
        id: learnerUser.id,
        stripeCustomerId: 'cus_learner_1',
      });
    stripeSetupIntentRetrieve.mockResolvedValueOnce({
      id: 'seti_other_learner',
      status: 'succeeded',
      customer: 'cus_other_learner',
      payment_method: 'pm_other_learner',
      metadata: { userId: 'learner-2' },
    });

    const response = await request(app)
      .post('/api/v1/payments/complete-setup-intent')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ setupIntentId: 'seti_other_learner' });

    expect(response.status).toBe(404);
    expect(response.body.message).toBe('Payment method setup not found');
    expect(stripePaymentMethodRetrieve).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('does not save an incomplete setup intent', async () => {
    stripeConfigured = true;
    prisma.user.findUnique
      .mockResolvedValueOnce(learnerUser)
      .mockResolvedValueOnce({
        id: learnerUser.id,
        stripeCustomerId: 'cus_learner_1',
      });
    stripeSetupIntentRetrieve.mockResolvedValueOnce({
      id: 'seti_incomplete',
      status: 'requires_payment_method',
      customer: 'cus_learner_1',
      payment_method: null,
      metadata: { userId: learnerUser.id },
    });

    const response = await request(app)
      .post('/api/v1/payments/complete-setup-intent')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ setupIntentId: 'seti_incomplete' });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Payment method setup is not complete yet');
    expect(stripePaymentMethodRetrieve).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('denies deletion of a payment method that is not owned by the learner', async () => {
    stripeConfigured = true;
    prisma.user.findUnique
      .mockResolvedValueOnce(learnerUser)
      .mockResolvedValueOnce({
        id: learnerUser.id,
        stripeCustomerId: 'cus_learner_1',
        stripeDefaultPaymentMethodId: ownedPaymentMethod.id,
      });
    stripePaymentMethodList.mockResolvedValueOnce({ data: [ownedPaymentMethod] });

    const response = await request(app)
      .delete('/api/v1/payments/method/pm_other_learner')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`);

    expect(response.status).toBe(404);
    expect(response.body.message).toBe('Payment method not found');
    expect(stripePaymentMethodDetach).not.toHaveBeenCalled();
    expect(prisma.booking.count).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('deletes an owned payment method without changing a different default', async () => {
    stripeConfigured = true;
    const defaultPaymentMethod = {
      ...ownedPaymentMethod,
      id: 'pm_learner_default',
      card: { ...ownedPaymentMethod.card, last4: '1111' },
    };
    prisma.user.findUnique
      .mockResolvedValueOnce(learnerUser)
      .mockResolvedValueOnce({
        id: learnerUser.id,
        stripeCustomerId: 'cus_learner_1',
        stripeDefaultPaymentMethodId: defaultPaymentMethod.id,
      });
    stripePaymentMethodList.mockResolvedValueOnce({
      data: [defaultPaymentMethod, ownedPaymentMethod],
    });
    prisma.booking.count.mockResolvedValueOnce(0);
    stripePaymentMethodDetach.mockResolvedValueOnce(ownedPaymentMethod);
    prisma.user.update.mockResolvedValueOnce({
      id: learnerUser.id,
      stripeDefaultPaymentMethodId: defaultPaymentMethod.id,
    });

    const response = await request(app)
      .delete(`/api/v1/payments/method/${ownedPaymentMethod.id}`)
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`);

    expect(response.status).toBe(200);
    expect(stripePaymentMethodDetach).toHaveBeenCalledWith(ownedPaymentMethod.id);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: learnerUser.id },
      data: { stripeDefaultPaymentMethodId: defaultPaymentMethod.id },
    });
  });

  test('does not detach the last default method while active bookings still need it', async () => {
    stripeConfigured = true;
    prisma.user.findUnique
      .mockResolvedValueOnce(learnerUser)
      .mockResolvedValueOnce({
        id: learnerUser.id,
        stripeCustomerId: 'cus_learner_1',
        stripeDefaultPaymentMethodId: ownedPaymentMethod.id,
      });
    stripePaymentMethodList.mockResolvedValueOnce({ data: [ownedPaymentMethod] });
    prisma.booking.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);

    const response = await request(app)
      .delete(`/api/v1/payments/method/${ownedPaymentMethod.id}`)
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`);

    expect(response.status).toBe(400);
    expect(response.body.message).toBe(
      'You need to keep at least one payment method while bookings are still waiting for payment'
    );
    expect(stripePaymentMethodDetach).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('allows a learner to propose a new time for an accepted future booking', async () => {
    const proposedAt = '2027-05-07T11:00:00.000Z';
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.booking.findUnique.mockResolvedValueOnce({
      ...acceptedFutureBooking,
      rescheduleRequests: [],
    }).mockResolvedValueOnce({
      ...acceptedFutureBooking,
      rescheduleRequests: [],
    });
    prisma.booking.findMany.mockResolvedValueOnce([]);
    prisma.tutorProfile.findUnique.mockResolvedValueOnce(tutorAvailability);
    prisma.rescheduleRequest.create.mockResolvedValueOnce({
      id: 'reschedule-request-1',
      bookingId: acceptedFutureBooking.id,
      learnerId: learnerUser.id,
      tutorId: 'tutor-profile-1',
      currentScheduledAt: acceptedFutureBooking.scheduledAt,
      proposedScheduledAt: new Date(proposedAt),
      reason: 'Work shift changed',
      status: 'PENDING',
    });

    const response = await request(app)
      .post('/api/v1/bookings/booking-1/reschedule-requests')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({
        scheduledAt: proposedAt,
        reason: 'Work shift changed',
        expectedVersion: 1,
      });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.message).toBe('Reschedule request sent');
    expect(prisma.rescheduleRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bookingId: 'booking-1',
        learnerId: learnerUser.id,
        tutorId: 'tutor-profile-1',
        proposedScheduledAt: new Date(proposedAt),
        reason: 'Work shift changed',
        proposedBy: 'LEARNER',
      }),
      include: expect.any(Object),
    });
    expect(notifyOrRefresh).toHaveBeenCalledWith(
      'tutor-user-1',
      'booking',
      'Reschedule Proposal',
      expect.stringContaining('proposed moving Mathematics'),
      '/bookings/booking-1'
    );
  });

  test('requires learner proposals for accepted bookings to use published tutor availability', async () => {
    const proposedAt = '2027-05-07T15:00:00.000Z';
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.booking.findUnique
      .mockResolvedValueOnce({ ...acceptedFutureBooking, rescheduleRequests: [] })
      .mockResolvedValueOnce({ ...acceptedFutureBooking, rescheduleRequests: [] });
    prisma.booking.findMany.mockResolvedValueOnce([]);
    prisma.tutorProfile.findUnique.mockResolvedValueOnce(tutorAvailability);

    const response = await request(app)
      .post('/api/v1/bookings/booking-1/reschedule-requests')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({
        scheduledAt: proposedAt,
        reason: 'Could we meet later?',
        expectedVersion: 1,
      });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe(
      "Booking time 15:00-16:00 is outside tutor's availability. Available slots: 09:00-13:00"
    );
    expect(prisma.rescheduleRequest.create).not.toHaveBeenCalled();
    expect(notifyOrRefresh).not.toHaveBeenCalled();
  });

  test('rejects a learner reschedule proposal when the proposed slot overlaps another booking', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.booking.findUnique.mockResolvedValueOnce({
      ...acceptedFutureBooking,
      rescheduleRequests: [],
    }).mockResolvedValueOnce({
      ...acceptedFutureBooking,
      rescheduleRequests: [],
    });
    prisma.booking.findMany.mockResolvedValueOnce([
      {
        id: 'existing-booking',
        scheduledAt: new Date('2027-05-07T11:00:00.000Z'),
        duration: 60,
      },
    ]);

    const response = await request(app)
      .post('/api/v1/bookings/booking-1/reschedule-requests')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({
        scheduledAt: '2027-05-07T11:30:00.000Z',
        reason: 'Work shift changed',
        expectedVersion: 1,
      });

    expect(response.status).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('This time slot has already been booked');
    expect(prisma.rescheduleRequest.create).not.toHaveBeenCalled();
    expect(notifyOrRefresh).not.toHaveBeenCalled();
  });

  test('allows a tutor to propose any free time for an accepted booking', async () => {
    // Published availability ends at 13:00, but tutors may make an exception.
    const proposedAt = '2027-05-07T15:00:00.000Z';
    const bookingWithRequests = { ...acceptedFutureBooking, rescheduleRequests: [] };
    prisma.user.findUnique.mockResolvedValueOnce(tutorUser);
    prisma.booking.findUnique
      .mockResolvedValueOnce(bookingWithRequests)
      .mockResolvedValueOnce(bookingWithRequests);
    prisma.booking.findMany.mockResolvedValueOnce([]);
    prisma.tutorProfile.findUnique.mockResolvedValueOnce(tutorAvailability);
    prisma.rescheduleRequest.create.mockResolvedValueOnce({
      id: 'tutor-reschedule-request',
      bookingId: acceptedFutureBooking.id,
      proposedScheduledAt: new Date(proposedAt),
      proposedBy: 'TUTOR',
      status: 'PENDING',
    });

    const response = await request(app)
      .post('/api/v1/bookings/booking-1/reschedule-requests')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ scheduledAt: proposedAt, reason: 'Training conflict', expectedVersion: 1 });

    expect(response.status).toBe(201);
    expect(prisma.rescheduleRequest.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ proposedBy: 'TUTOR' }),
    }));
    expect(notifyOrRefresh).toHaveBeenCalledWith(
      learnerUser.id,
      'booking',
      'Reschedule Proposal',
      expect.stringContaining('Tutor proposed moving Mathematics'),
      '/bookings/booking-1'
    );
  });

  test('blocks a tutor accepted-booking proposal that overlaps another lesson', async () => {
    const bookingWithRequests = { ...acceptedFutureBooking, rescheduleRequests: [] };
    prisma.user.findUnique.mockResolvedValueOnce(tutorUser);
    prisma.booking.findUnique
      .mockResolvedValueOnce(bookingWithRequests)
      .mockResolvedValueOnce(bookingWithRequests);
    prisma.booking.findMany.mockResolvedValueOnce([
      {
        id: 'existing-booking',
        scheduledAt: new Date('2027-05-07T11:00:00.000Z'),
        duration: 60,
      },
    ]);

    const response = await request(app)
      .post('/api/v1/bookings/booking-1/reschedule-requests')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({
        scheduledAt: '2027-05-07T11:30:00.000Z',
        reason: 'Could we meet later?',
        expectedVersion: 1,
      });

    expect(response.status).toBe(409);
    expect(response.body.message).toBe('This time slot has already been booked');
    expect(prisma.rescheduleRequest.create).not.toHaveBeenCalled();
    expect(notifyOrRefresh).not.toHaveBeenCalled();
  });

  test('keeps history when either participant replaces a pending proposal', async () => {
    const existingProposal = {
      id: 'old-proposal',
      bookingId: acceptedFutureBooking.id,
      proposedBy: 'TUTOR',
      status: 'PENDING',
    };
    const bookingWithProposal = {
      ...acceptedFutureBooking,
      version: 2,
      rescheduleRequests: [existingProposal],
    };
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.booking.findUnique
      .mockResolvedValueOnce(bookingWithProposal)
      .mockResolvedValueOnce(bookingWithProposal);
    prisma.booking.findMany.mockResolvedValueOnce([]);
    prisma.tutorProfile.findUnique.mockResolvedValueOnce(tutorAvailability);
    prisma.rescheduleRequest.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.rescheduleRequest.create.mockResolvedValueOnce({
      id: 'replacement-proposal',
      bookingId: acceptedFutureBooking.id,
      proposedScheduledAt: new Date('2027-05-07T11:00:00.000Z'),
      proposedBy: 'LEARNER',
      status: 'PENDING',
    });

    const response = await request(app)
      .post('/api/v1/bookings/booking-1/reschedule-requests')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({
        scheduledAt: '2027-05-07T11:00:00.000Z',
        reason: 'Could we use this time instead?',
        expectedVersion: 2,
      });

    expect(response.status).toBe(201);
    expect(prisma.rescheduleRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'old-proposal', bookingId: 'booking-1', status: 'PENDING' },
      data: {
        status: 'COUNTERED',
        decisionReason: 'Replaced by a newer reschedule proposal.',
        decidedById: learnerUser.id,
        decidedAt: expect.any(Date),
      },
    });
    expect(prisma.rescheduleRequest.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ proposedBy: 'LEARNER' }),
    }));
  });

  describe('reschedule proposals during a Sydney DST fall-back overlap (AC4)', () => {
    const sydneyTutorAvailability = {
      id: 'tutor-profile-1',
      user: { timezone: 'Australia/Sydney' },
      availability: [
        {
          dayOfWeek: 0,
          startTime: '01:00',
          endTime: '04:00',
        },
      ],
    };

    test('does not flag a conflict for back-to-back bookings that both read "2:00 am" locally', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
      prisma.booking.findUnique.mockResolvedValueOnce({
        ...acceptedFutureBooking,
        rescheduleRequests: [],
      }).mockResolvedValueOnce({
        ...acceptedFutureBooking,
        rescheduleRequests: [],
      });
      prisma.booking.findMany.mockResolvedValueOnce([
        {
          id: 'existing-booking',
          scheduledAt: new Date('2028-04-01T15:00:00.000Z'),
          duration: 60,
        },
      ]);
      prisma.tutorProfile.findUnique.mockResolvedValueOnce(sydneyTutorAvailability);
      prisma.rescheduleRequest.create.mockResolvedValueOnce({
        id: 'reschedule-request-1',
        bookingId: acceptedFutureBooking.id,
        learnerId: learnerUser.id,
        tutorId: 'tutor-profile-1',
        currentScheduledAt: acceptedFutureBooking.scheduledAt,
        proposedScheduledAt: new Date('2028-04-01T16:00:00.000Z'),
        reason: 'Prefer the later slot',
        status: 'PENDING',
      });

      const response = await request(app)
        .post('/api/v1/bookings/booking-1/reschedule-requests')
        .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
        .send({
          scheduledAt: '2028-04-01T16:00:00.000Z',
          reason: 'Prefer the later slot',
          expectedVersion: 1,
        });

      expect(response.status).toBe(201);
      expect(prisma.rescheduleRequest.create).toHaveBeenCalled();
    });

    test('flags a real conflict between overlapping instants that read as different local times', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
      prisma.booking.findUnique.mockResolvedValueOnce({
        ...acceptedFutureBooking,
        rescheduleRequests: [],
      }).mockResolvedValueOnce({
        ...acceptedFutureBooking,
        rescheduleRequests: [],
      });
      prisma.booking.findMany.mockResolvedValueOnce([
        {
          id: 'existing-booking',
          scheduledAt: new Date('2028-04-01T15:30:00.000Z'),
          duration: 60,
        },
      ]);

      const response = await request(app)
        .post('/api/v1/bookings/booking-1/reschedule-requests')
        .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
        .send({
          scheduledAt: '2028-04-01T16:00:00.000Z',
          reason: 'Prefer the later slot',
          expectedVersion: 1,
        });

      expect(response.status).toBe(409);
      expect(response.body.message).toBe('This time slot has already been booked');
      expect(prisma.rescheduleRequest.create).not.toHaveBeenCalled();
    });
  });

  test('allows a tutor to accept a learner reschedule proposal and updates the booking time', async () => {
    const proposedAt = new Date('2027-05-07T11:00:00.000Z');
    prisma.user.findUnique.mockResolvedValueOnce(tutorUser);
    prisma.tutorProfile.findUnique.mockResolvedValueOnce(tutorAvailability);
    const pendingRequest = {
      id: 'reschedule-request-1',
      bookingId: acceptedFutureBooking.id,
      learnerId: learnerUser.id,
      tutorId: 'tutor-profile-1',
      currentScheduledAt: acceptedFutureBooking.scheduledAt,
      proposedScheduledAt: proposedAt,
      reason: 'Work shift changed',
      proposedBy: 'LEARNER',
      status: 'PENDING',
      booking: acceptedFutureBooking,
    };
    prisma.rescheduleRequest.findUnique
      .mockResolvedValueOnce(pendingRequest)
      .mockResolvedValueOnce(pendingRequest);
    prisma.booking.findMany.mockResolvedValueOnce([]);
    prisma.rescheduleRequest.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.booking.update.mockResolvedValueOnce({
      ...acceptedFutureBooking,
      scheduledAt: proposedAt,
      rescheduleRequests: [],
    });

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/reschedule-requests/reschedule-request-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 1 });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.message).toBe('Reschedule request accepted');
    expect(prisma.booking.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'booking-1', status: 'ACCEPTED', version: 1 },
      data: expect.objectContaining({
        scheduledAt: proposedAt,
        version: { increment: 1 },
      }),
      include: expect.any(Object),
    }));
    expect(prisma.rescheduleRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'reschedule-request-1', bookingId: 'booking-1', status: 'PENDING' },
      data: expect.objectContaining({
        status: 'ACCEPTED',
        decidedById: tutorUser.id,
        decidedAt: expect.any(Date),
      }),
    });
    expect(notifyOrRefresh).toHaveBeenCalledWith(
      learnerUser.id,
      'booking',
      'Reschedule Accepted',
      expect.stringContaining('by mutual agreement'),
      '/bookings/booking-1'
    );
  });

  test('allows a tutor to decline a learner reschedule proposal without updating the booking', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(tutorUser);
    const pendingRequest = {
      id: 'reschedule-request-1',
      bookingId: acceptedFutureBooking.id,
      learnerId: learnerUser.id,
      tutorId: 'tutor-profile-1',
      proposedScheduledAt: new Date('2027-05-07T11:00:00.000Z'),
      reason: 'Work shift changed',
      proposedBy: 'LEARNER',
      status: 'PENDING',
      booking: acceptedFutureBooking,
    };
    prisma.rescheduleRequest.findUnique
      .mockResolvedValueOnce(pendingRequest)
      .mockResolvedValueOnce(pendingRequest);
    prisma.booking.findUnique.mockResolvedValueOnce(acceptedFutureBooking);
    prisma.rescheduleRequest.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.booking.update.mockResolvedValueOnce({ ...acceptedFutureBooking, version: 2 });

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/reschedule-requests/reschedule-request-1/decline')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({
        reason: 'That time no longer works',
        expectedVersion: 1,
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.message).toBe('Reschedule request declined');
    expect(prisma.booking.update).toHaveBeenCalledWith({
      where: { id: 'booking-1', status: 'ACCEPTED', version: 1 },
      data: { version: { increment: 1 } },
    });
    expect(prisma.booking.update.mock.calls[0][0].data).not.toHaveProperty('scheduledAt');
    expect(prisma.rescheduleRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'reschedule-request-1', bookingId: 'booking-1', status: 'PENDING' },
      data: {
        status: 'DECLINED',
        decisionReason: 'That time no longer works',
        decidedById: tutorUser.id,
        decidedAt: expect.any(Date),
      },
    });
    expect(notifyOrRefresh).toHaveBeenCalledWith(
      learnerUser.id,
      'booking',
      'Reschedule Declined',
      expect.stringContaining('That time no longer works'),
      '/bookings/booking-1'
    );
  });

  test('lets the learner accept a tutor proposal without changing commercial snapshots', async () => {
    // Acceptance must preserve the tutor's valid exception outside 09:00-13:00.
    const proposedAt = new Date('2027-05-07T15:00:00.000Z');
    const bookingWithSnapshots = {
      ...acceptedFutureBooking,
      version: 4,
      duration: 90,
      hourlyRate: 72,
      totalAmount: 108,
      currency: 'AUD',
      cancellationCutoffHours: 48,
      lateCancellationRefundPercent: 50,
      payment: { id: 'payment-1', status: 'PAID', amount: 108, currency: 'AUD' },
    };
    const tutorProposal = {
      id: 'tutor-reschedule-request',
      bookingId: bookingWithSnapshots.id,
      learnerId: learnerUser.id,
      tutorId: 'tutor-profile-1',
      currentScheduledAt: bookingWithSnapshots.scheduledAt,
      proposedScheduledAt: proposedAt,
      reason: 'Training conflict',
      proposedBy: 'TUTOR',
      status: 'PENDING',
      booking: bookingWithSnapshots,
    };
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.rescheduleRequest.findUnique
      .mockResolvedValueOnce(tutorProposal)
      .mockResolvedValueOnce(tutorProposal);
    prisma.booking.findMany.mockResolvedValueOnce([]);
    prisma.tutorProfile.findUnique.mockResolvedValueOnce(tutorAvailability);
    prisma.rescheduleRequest.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.booking.update.mockResolvedValueOnce({
      ...bookingWithSnapshots,
      version: 5,
      scheduledAt: proposedAt,
      rescheduleRequests: [],
    });

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/reschedule-requests/tutor-reschedule-request/accept')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ expectedVersion: 4 });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      subject: 'Mathematics',
      duration: 90,
      hourlyRate: 72,
      totalAmount: 108,
      currency: 'AUD',
      cancellationCutoffHours: 48,
      lateCancellationRefundPercent: 50,
    });
    expect(response.body.data.scheduledAt).toBe(proposedAt.toISOString());
    expect(prisma.rescheduleRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ decidedById: learnerUser.id, status: 'ACCEPTED' }),
    }));
  });

  test('keeps an unavailable proposal pending and prompts both participants to choose again', async () => {
    const proposedAt = new Date('2027-05-07T11:00:00.000Z');
    const pendingRequest = {
      id: 'reschedule-request-1',
      bookingId: acceptedFutureBooking.id,
      proposedScheduledAt: proposedAt,
      proposedBy: 'LEARNER',
      status: 'PENDING',
      booking: acceptedFutureBooking,
    };
    prisma.user.findUnique.mockResolvedValueOnce(tutorUser);
    prisma.rescheduleRequest.findUnique
      .mockResolvedValueOnce(pendingRequest)
      .mockResolvedValueOnce(pendingRequest);
    prisma.booking.findMany.mockResolvedValueOnce([
      { id: 'new-conflict', scheduledAt: proposedAt, duration: 60 },
    ]);

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/reschedule-requests/reschedule-request-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 1 });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('RESCHEDULE_SLOT_UNAVAILABLE');
    expect(prisma.rescheduleRequest.updateMany).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(notifyOrRefresh).toHaveBeenCalledTimes(2);
    expect(notifyOrRefresh).toHaveBeenCalledWith(
      learnerUser.id,
      'booking',
      'Choose Another Lesson Time',
      expect.stringContaining('original lesson time is unchanged'),
      '/bookings/booking-1'
    );
    expect(notifyOrRefresh).toHaveBeenCalledWith(
      tutorUser.id,
      'booking',
      'Choose Another Lesson Time',
      expect.stringContaining('please choose another time'),
      '/bookings/booking-1'
    );
  });

  test('denies a second response without another schedule change or notification', async () => {
    const resolvedRequest = {
      id: 'reschedule-request-1',
      bookingId: acceptedFutureBooking.id,
      proposedBy: 'LEARNER',
      status: 'ACCEPTED',
      booking: { ...acceptedFutureBooking, version: 2 },
    };
    prisma.user.findUnique.mockResolvedValueOnce(tutorUser);
    prisma.rescheduleRequest.findUnique
      .mockResolvedValueOnce(resolvedRequest)
      .mockResolvedValueOnce(resolvedRequest);

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/reschedule-requests/reschedule-request-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 2 });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('BOOKING_CHANGED');
    expect(prisma.rescheduleRequest.updateMany).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(notifyOrRefresh).not.toHaveBeenCalled();
  });

  test('allows a tutor to propose a new time for a pending learner request', async () => {
    // Tutor availability is 09:00-13:00, but tutors may deliberately propose
    // another conflict-free time when negotiating a pending request.
    const proposedAt = new Date('2027-05-07T15:00:00.000Z');
    const pendingBooking = {
      ...acceptedFutureBooking,
      status: 'PENDING',
      negotiationStatus: 'NONE',
      rescheduleRequests: [],
    };
    const updatedBooking = {
      ...pendingBooking,
      scheduledAt: proposedAt,
      version: 2,
      negotiationStatus: 'TIME_PROPOSED_BY_TUTOR',
      rescheduleRequests: [
        {
          id: 'proposal-1',
          proposedBy: 'TUTOR',
          status: 'PENDING',
          currentScheduledAt: pendingBooking.scheduledAt,
          proposedScheduledAt: proposedAt,
        },
      ],
    };

    prisma.user.findUnique.mockResolvedValueOnce(tutorUser);
    prisma.tutorProfile.findUnique
      .mockResolvedValueOnce({ id: 'tutor-profile-1' })
      .mockResolvedValueOnce(tutorAvailability);
    prisma.booking.findUnique
      .mockResolvedValueOnce(pendingBooking)
      .mockResolvedValueOnce(pendingBooking);
    prisma.booking.findMany.mockResolvedValueOnce([]);
    prisma.booking.update.mockResolvedValueOnce(updatedBooking);

    const response = await request(app)
      .post('/api/v1/bookings/booking-1/time-proposals')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({
        scheduledAt: proposedAt.toISOString(),
        expectedVersion: 1,
        reason: 'Could we meet one hour later?',
      });

    expect(response.status).toBe(201);
    expect(response.body.data.negotiationStatus).toBe('TIME_PROPOSED_BY_TUTOR');
    expect(prisma.booking.update).toHaveBeenCalledWith({
      where: { id: 'booking-1', status: 'PENDING', version: 1 },
      data: expect.objectContaining({
        scheduledAt: proposedAt,
        negotiationStatus: 'TIME_PROPOSED_BY_TUTOR',
        version: { increment: 1 },
        rescheduleRequests: expect.objectContaining({
          create: expect.objectContaining({
            proposedBy: 'TUTOR',
            status: 'PENDING',
            proposedScheduledAt: proposedAt,
          }),
        }),
      }),
      include: expect.any(Object),
    });
    expect(notifyOrRefresh).toHaveBeenCalledWith(
      learnerUser.id,
      'booking',
      'New Time Proposed by Tutor',
      expect.stringContaining('proposed moving Mathematics'),
      '/bookings/booking-1'
    );
  });

  test('blocks a tutor proposal that overlaps another lesson', async () => {
    const pendingBooking = {
      ...acceptedFutureBooking,
      status: 'PENDING',
      negotiationStatus: 'NONE',
      rescheduleRequests: [],
    };

    prisma.user.findUnique.mockResolvedValueOnce(tutorUser);
    prisma.tutorProfile.findUnique.mockResolvedValueOnce({ id: 'tutor-profile-1' });
    prisma.booking.findUnique
      .mockResolvedValueOnce(pendingBooking)
      .mockResolvedValueOnce(pendingBooking);
    prisma.booking.findMany.mockResolvedValueOnce([
      {
        id: 'confirmed-booking-2',
        scheduledAt: new Date('2027-05-07T15:00:00.000Z'),
        duration: 60,
      },
    ]);

    const response = await request(app)
      .post('/api/v1/bookings/booking-1/time-proposals')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({
        scheduledAt: '2027-05-07T15:30:00.000Z',
        expectedVersion: 1,
      });

    expect(response.status).toBe(409);
    expect(response.body.message).toBe('This time slot has already been booked');
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(notifyOrRefresh).not.toHaveBeenCalled();
  });

  test('records a learner counter-proposal and supersedes the tutor proposal', async () => {
    const tutorProposal = {
      id: 'proposal-1',
      proposedBy: 'TUTOR',
      status: 'PENDING',
    };
    const pendingBooking = {
      ...acceptedFutureBooking,
      status: 'PENDING',
      version: 2,
      negotiationStatus: 'TIME_PROPOSED_BY_TUTOR',
      rescheduleRequests: [tutorProposal],
    };
    const counterAt = new Date('2027-05-07T12:00:00.000Z');

    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.booking.findUnique
      .mockResolvedValueOnce(pendingBooking)
      .mockResolvedValueOnce(pendingBooking);
    prisma.booking.findMany.mockResolvedValueOnce([]);
    prisma.tutorProfile.findUnique.mockResolvedValueOnce(tutorAvailability);
    prisma.booking.update.mockResolvedValueOnce({
      ...pendingBooking,
      scheduledAt: counterAt,
      version: 3,
      negotiationStatus: 'TIME_PROPOSED_BY_LEARNER',
    });

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/requested-time')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({
        scheduledAt: counterAt.toISOString(),
        expectedVersion: 2,
        reason: 'Noon works better for me',
      });

    expect(response.status).toBe(200);
    expect(response.body.message).toBe('Different time proposed');
    expect(prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          negotiationStatus: 'TIME_PROPOSED_BY_LEARNER',
          rescheduleRequests: expect.objectContaining({
            updateMany: expect.objectContaining({
              data: expect.objectContaining({ status: 'COUNTERED' }),
            }),
            create: expect.objectContaining({
              proposedBy: 'LEARNER',
              status: 'PENDING',
            }),
          }),
        }),
      })
    );
  });

  test('lets the tutor accept a learner counter-proposal and closes negotiation', async () => {
    let pendingBooking = {
      ...acceptedFutureBooking,
      status: 'PENDING',
      version: 3,
      negotiationStatus: 'TIME_PROPOSED_BY_LEARNER',
      isTrialLesson: true,
      totalAmount: 0,
      currency: 'AUD',
      payment: null,
      priceOffers: [],
      statusHistory: [{ status: 'PENDING' }],
      rescheduleRequests: [
        { id: 'proposal-2', proposedBy: 'LEARNER', status: 'PENDING' },
      ],
    };
    const acceptedBooking = {
      ...pendingBooking,
      status: 'ACCEPTED',
      version: 4,
      negotiationStatus: 'NONE',
    };

    prisma.user.findUnique.mockResolvedValueOnce(tutorUser);
    prisma.tutorProfile.findUnique.mockResolvedValue({
      ...tutorAvailability,
      userId: tutorUser.id,
      status: 'ACTIVE',
      user: { id: tutorUser.id, status: 'ACTIVE', timezone: 'UTC' },
    });
    prisma.bookingPriceOffer.findFirst.mockResolvedValue(null);
    prisma.booking.findUnique.mockImplementation(async () => pendingBooking);
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.booking.update.mockImplementation(async () => {
      pendingBooking = acceptedBooking;
      return acceptedBooking;
    });
    prisma.bookingStatusHistory.create.mockResolvedValue({ id: 'history-counter-accepted' });
    prisma.notification.createMany.mockResolvedValue({ count: 2 });

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 3 });

    expect(response.status).toBe(200);
    expect(response.body.data.negotiationStatus).toBe('NONE');
    expect(prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'booking-1', status: 'PENDING', version: 3 },
        data: expect.objectContaining({
          status: 'ACCEPTED',
          negotiationStatus: 'NONE',
          rescheduleRequests: expect.objectContaining({
            updateMany: expect.objectContaining({
              data: expect.objectContaining({ status: 'ACCEPTED' }),
            }),
          }),
        }),
      })
    );
    expect(prisma.notification.createMany).toHaveBeenCalledTimes(1);
    expect(stripePaymentIntentCreate).not.toHaveBeenCalled();
  });

  test('revalidates a learner proposal under the tutor lock before accepting it', async () => {
    const pendingBooking = {
      ...acceptedFutureBooking,
      status: 'PENDING',
      version: 3,
      negotiationStatus: 'TIME_PROPOSED_BY_LEARNER',
      isTrialLesson: true,
      totalAmount: 0,
      currency: 'AUD',
      payment: null,
      priceOffers: [],
      rescheduleRequests: [
        { id: 'proposal-2', proposedBy: 'LEARNER', status: 'PENDING' },
      ],
    };

    prisma.user.findUnique.mockResolvedValueOnce(tutorUser);
    prisma.tutorProfile.findUnique.mockResolvedValue({
      ...tutorAvailability,
      userId: tutorUser.id,
      status: 'ACTIVE',
      user: { id: tutorUser.id, status: 'ACTIVE', timezone: 'UTC' },
    });
    prisma.bookingPriceOffer.findFirst.mockResolvedValue(null);
    prisma.booking.findUnique.mockResolvedValue(pendingBooking);
    prisma.booking.findMany.mockResolvedValueOnce([
      {
        id: 'newly-confirmed-booking',
        status: 'ACCEPTED',
        scheduledAt: pendingBooking.scheduledAt,
        duration: pendingBooking.duration,
      },
    ]);

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 3 });

    expect(response.status).toBe(409);
    expect(response.body.message).toContain('already being accepted or has been accepted');
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(stripePaymentIntentCreate).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(notifyOrRefresh).not.toHaveBeenCalled();
  });

  test('lets the learner accept the tutor proposal and charges exactly once', async () => {
    const activeProposal = {
      id: 'proposal-1',
      proposedBy: 'TUTOR',
      status: 'PENDING',
    };
    const pendingBooking = buildPendingAcceptanceBooking({
      version: 2,
      negotiationStatus: 'TIME_PROPOSED_BY_TUTOR',
      scheduledAt: new Date('2027-05-07T15:00:00.000Z'),
      totalAmount: 80,
      payment: { amount: 80 },
      rescheduleRequests: [activeProposal],
    });
    const arranged = arrangeAcceptancePayment({ booking: pendingBooking });
    prisma.user.findUnique.mockResolvedValue(learnerUser);

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/time-proposals/accept')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ expectedVersion: 2 });

    expect(response.status).toBe(200);
    expect(response.body.message).toBe('Proposed time accepted and booking confirmed');
    expect(response.body.data.status).toBe('ACCEPTED');
    expect(response.body.data.payment.status).toBe('PAID');
    expect(arranged.booking.negotiationStatus).toBe('NONE');
    expect(prisma.booking.updateMany).toHaveBeenCalledTimes(1);
    expect(stripePaymentIntentCreate).toHaveBeenCalledTimes(1);
    expect(prisma.rescheduleRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ proposedBy: 'TUTOR', status: 'PENDING' }),
        data: expect.objectContaining({ status: 'ACCEPTED' }),
      })
    );
    expect(prisma.notification.createMany).toHaveBeenCalledTimes(1);
  });

  test('rejecting a tutor proposal cancels the request and notifies both parties', async () => {
    const pendingBooking = {
      ...acceptedFutureBooking,
      status: 'PENDING',
      version: 2,
      negotiationStatus: 'TIME_PROPOSED_BY_TUTOR',
      payment: { id: 'payment-1', status: 'PENDING' },
      rescheduleRequests: [
        { id: 'proposal-1', proposedBy: 'TUTOR', status: 'PENDING' },
      ],
    };
    const cancelledBooking = {
      ...pendingBooking,
      status: 'CANCELLED',
      version: 3,
      negotiationStatus: 'NONE',
    };

    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.booking.findUnique
      .mockResolvedValueOnce(pendingBooking)
      .mockResolvedValueOnce(pendingBooking);
    prisma.booking.update.mockResolvedValueOnce(cancelledBooking);

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/time-proposals/reject')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ expectedVersion: 2, reason: 'That time will not work' });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('CANCELLED');
    expect(prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'CANCELLED',
          negotiationStatus: 'NONE',
          rescheduleRequests: expect.objectContaining({
            updateMany: expect.objectContaining({
              data: expect.objectContaining({ status: 'DECLINED' }),
            }),
          }),
        }),
      })
    );
    expect(notifyOrRefresh).toHaveBeenCalledTimes(2);
  });

  test('rejects an unauthorized negotiation response without mutation', async () => {
    const pendingBooking = {
      ...acceptedFutureBooking,
      learnerId: 'another-learner',
      status: 'PENDING',
      version: 3,
      negotiationStatus: 'TIME_PROPOSED_BY_TUTOR',
      rescheduleRequests: [
        { id: 'proposal-1', proposedBy: 'TUTOR', status: 'PENDING' },
      ],
    };
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.booking.findUnique.mockResolvedValueOnce(pendingBooking);

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/time-proposals/accept')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ expectedVersion: 2 });

    expect(response.status).toBe(404);
    expect(response.body.message).toBe('Booking not found');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(notifyOrRefresh).not.toHaveBeenCalled();
  });

  test('rejects a stale tutor counter-proposal after the learner changes the request', async () => {
    const changedBooking = {
      ...acceptedFutureBooking,
      status: 'PENDING',
      version: 3,
      negotiationStatus: 'TIME_PROPOSED_BY_LEARNER',
      rescheduleRequests: [
        { id: 'proposal-2', proposedBy: 'LEARNER', status: 'PENDING' },
      ],
    };

    prisma.user.findUnique.mockResolvedValueOnce(tutorUser);
    prisma.tutorProfile.findUnique.mockResolvedValueOnce({ id: 'tutor-profile-1' });
    prisma.booking.findUnique
      .mockResolvedValueOnce(changedBooking)
      .mockResolvedValueOnce(changedBooking);

    const response = await request(app)
      .post('/api/v1/bookings/booking-1/time-proposals')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({
        scheduledAt: '2027-05-07T12:00:00.000Z',
        expectedVersion: 2,
      });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('BOOKING_CHANGED');
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
    expect(notifyOrRefresh).not.toHaveBeenCalled();
  });
});

// PAY-05 AC4: a paid booking must not be charged while the assigned tutor
// cannot receive money, but free trial acceptance stays available.
describe('paid acceptance requires tutor payout readiness', () => {
  const notPayoutReady = () => {
    prisma.tutorPayoutAccount.findUnique.mockResolvedValue({ isPayoutReady: false });
  };

  test('blocks a tutor accepting a paid booking and points them at payout setup', async () => {
    arrangeAcceptancePayment();
    notPayoutReady();

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 1 });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('TUTOR_PAYOUT_SETUP_INCOMPLETE');
    expect(response.body.action).toBe('COMPLETE_PAYOUT_SETUP');
    expect(response.body.link).toBe('/tutor/payouts?returnTo=%2Fbookings%2Fbooking-1');
    // Nothing may be claimed or charged for a blocked acceptance.
    expect(stripePaymentIntentCreate).not.toHaveBeenCalled();
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(prisma.paymentAttempt.create).not.toHaveBeenCalled();
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
  });

  test('still lets a tutor without payout setup accept a free trial lesson', async () => {
    let trialBooking = {
      ...acceptedFutureBooking,
      status: 'PENDING',
      version: 1,
      isTrialLesson: true,
      totalAmount: 0,
      currency: 'AUD',
      payment: null,
      priceOffers: [],
      rescheduleRequests: [],
      statusHistory: [{ status: 'PENDING' }],
    };
    stripeConfigured = true;
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    notPayoutReady();
    prisma.user.findUnique.mockResolvedValueOnce(tutorUser);
    prisma.tutorProfile.findUnique.mockResolvedValue({
      ...tutorAvailability,
      userId: tutorUser.id,
      status: 'ACTIVE',
      user: { id: tutorUser.id, status: 'ACTIVE', timezone: 'UTC' },
    });
    prisma.bookingPriceOffer.findFirst.mockResolvedValue(null);
    prisma.booking.findUnique.mockImplementation(async () => trialBooking);
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.booking.update.mockImplementation(async () => {
      trialBooking = {
        ...trialBooking,
        version: trialBooking.version + 1,
        status: 'ACCEPTED',
        negotiationStatus: 'NONE',
        rescheduleRequests: [],
      };
      return trialBooking;
    });
    prisma.bookingStatusHistory.create.mockResolvedValue({ id: 'history-trial-accepted' });
    prisma.notification.createMany.mockResolvedValue({ count: 2 });

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 1 });

    expect(response.status).toBe(200);
    expect(response.body.message).toBe('Free trial lesson accepted');
    expect(stripePaymentIntentCreate).not.toHaveBeenCalled();
  });

  test('blocks the learner accepting a tutor proposed time without leaking payout details', async () => {
    const pendingBooking = buildPendingAcceptanceBooking({
      version: 2,
      negotiationStatus: 'TIME_PROPOSED_BY_TUTOR',
      scheduledAt: new Date('2027-05-07T15:00:00.000Z'),
      totalAmount: 80,
      payment: { amount: 80 },
      rescheduleRequests: [{ id: 'proposal-1', proposedBy: 'TUTOR', status: 'PENDING' }],
    });
    arrangeAcceptancePayment({ booking: pendingBooking });
    prisma.user.findUnique.mockResolvedValue(learnerUser);
    notPayoutReady();

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/time-proposals/accept')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ expectedVersion: 2 });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('TUTOR_PAYOUT_SETUP_INCOMPLETE');
    // The learner gets no tutor-only link and no hint about payouts.
    expect(response.body.action).toBeUndefined();
    expect(response.body.link).toBeUndefined();
    expect(response.body.message.toLowerCase()).not.toContain('payout');
    expect(response.body.message.toLowerCase()).not.toContain('stripe');
    expect(stripePaymentIntentCreate).not.toHaveBeenCalled();
  });

  test('blocks a learner payment retry without burning an attempt', async () => {
    const failedBooking = buildPendingAcceptanceBooking({
      version: 4,
      payment: {
        status: 'FAILED',
        acceptanceAttemptCount: 1,
        acceptanceMode: 'TUTOR_ACCEPT',
        acceptanceBookingVersion: 4,
        stripeCustomerId: 'cus_learner_1',
        stripePaymentMethodId: ownedPaymentMethod.id,
      },
    });
    arrangeAcceptancePayment({ booking: failedBooking });
    prisma.user.findUnique.mockResolvedValue(learnerUser);
    notPayoutReady();

    const response = await request(app)
      .post('/api/v1/payments/bookings/booking-1/retry')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ expectedVersion: 4 });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('TUTOR_PAYOUT_SETUP_INCOMPLETE');
    expect(response.body.link).toBeUndefined();
    expect(prisma.paymentAttempt.create).not.toHaveBeenCalled();
    expect(stripePaymentIntentConfirm).not.toHaveBeenCalled();
  });

  test('still settles a charge already in flight when readiness is lost mid-payment', async () => {
    // The tutor was ready when this charge was submitted. Money is already with
    // the provider, so reconciliation must not be blocked after the fact.
    const processingBooking = buildPendingAcceptanceBooking({
      payment: {
        status: 'PROCESSING',
        acceptanceAttemptCount: 1,
        acceptanceMode: 'TUTOR_ACCEPT',
        stripeCustomerId: 'cus_learner_1',
        stripePaymentMethodId: ownedPaymentMethod.id,
        stripePaymentIntentId: 'pi_booking_1',
      },
    });
    arrangeAcceptancePayment({ booking: processingBooking });
    notPayoutReady();

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 1 });

    expect(response.body.code).not.toBe('TUTOR_PAYOUT_SETUP_INCOMPLETE');
  });

  test('charges normally once the tutor is payout ready', async () => {
    arrangeAcceptancePayment();
    prisma.tutorPayoutAccount.findUnique.mockResolvedValue({ isPayoutReady: true });

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 1 });

    expect(response.status).toBe(200);
    expect(response.body.data.payment.status).toBe('PAID');
    expect(stripePaymentIntentCreate).toHaveBeenCalledTimes(1);
  });

  test('reports a provider misconfiguration as itself rather than a payout prompt', async () => {
    arrangeAcceptancePayment();
    notPayoutReady();
    // Stripe key present but no webhook secret: a platform problem the tutor
    // cannot fix by onboarding.
    delete process.env.STRIPE_WEBHOOK_SECRET;

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 1 });

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
  });
});
