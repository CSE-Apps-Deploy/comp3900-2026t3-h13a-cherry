const { createHash } = require('crypto');
const request = require('supertest');

const prisma = {
  user: {
    findUnique: vi.fn(),
  },
  tutorProfile: {
    findUnique: vi.fn(),
  },
  booking: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
  bookingPriceOffer: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  payment: {
    update: vi.fn(),
  },
  $transaction: vi.fn((input) =>
    typeof input === 'function' ? input(prisma) : Promise.all(input)
  ),
  $executeRaw: vi.fn(),
};

const notify = vi.fn();
const notifyOrRefresh = vi.fn();
const notifyAdmin = vi.fn();
const stripePaymentIntentCreate = vi.fn();

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
    isStripeConfigured: () => true,
    getStripe: () => ({
      refunds: { create: vi.fn() },
      setupIntents: { retrieve: vi.fn() },
      paymentMethods: {
        retrieve: vi.fn(),
        list: vi.fn(),
        detach: vi.fn(),
      },
      paymentIntents: { create: stripePaymentIntentCreate },
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

const otherLearnerUser = {
  id: 'learner-2',
  email: 'other-learner@example.com',
  role: 'LEARNER',
  status: 'ACTIVE',
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

const otherTutorUser = {
  id: 'tutor-user-2',
  email: 'other-tutor@example.com',
  role: 'TUTOR',
  status: 'ACTIVE',
  tutorProfile: {
    id: 'tutor-profile-2',
    status: 'ACTIVE',
    applicationSubmitted: true,
    isVerified: true,
  },
};

const tutorProfile = {
  id: 'tutor-profile-1',
  userId: tutorUser.id,
  status: 'ACTIVE',
};

const otherTutorProfile = {
  id: 'tutor-profile-2',
  userId: otherTutorUser.id,
  status: 'ACTIVE',
};

const makeOffer = (overrides = {}) => ({
  id: 'price-offer-1',
  bookingId: 'booking-1',
  createdById: tutorUser.id,
  respondedById: null,
  withdrawnById: null,
  originalTotal: 100,
  proposedTotal: 75,
  status: 'PENDING',
  reason: 'Loyalty discount',
  createdAt: new Date('2099-04-01T00:00:00.000Z'),
  respondedAt: null,
  withdrawnAt: null,
  ...overrides,
});

const makeBooking = (overrides = {}) => ({
  id: 'booking-1',
  learnerId: learnerUser.id,
  tutorId: tutorProfile.id,
  subject: 'Mathematics',
  status: 'PENDING',
  version: 1,
  scheduledAt: new Date('2099-05-07T10:00:00.000Z'),
  duration: 60,
  hourlyRate: 100,
  totalAmount: 100,
  isTrialLesson: false,
  currency: 'AUD',
  recurringType: 'ONE_OFF',
  recurringGroupId: null,
  negotiationStatus: 'NONE',
  learner: {
    ...learnerUser,
    firstName: 'Learner',
    lastName: 'Example',
    timezone: 'UTC',
    stripeCustomerId: 'cus_learner_1',
    stripeDefaultPaymentMethodId: 'pm_learner_1',
  },
  tutorProfile: {
    ...tutorProfile,
    user: {
      id: tutorUser.id,
      firstName: 'Tutor',
      lastName: 'Example',
      email: tutorUser.email,
      timezone: 'UTC',
    },
  },
  payment: {
    id: 'payment-1',
    status: 'PENDING',
    amount: 100,
    currency: 'AUD',
    stripeCustomerId: 'cus_learner_1',
    stripePaymentMethodId: 'pm_learner_1',
  },
  priceOffers: [],
  rescheduleRequests: [],
  statusHistory: [],
  ...overrides,
});

const setAuthenticatedUser = (user) => {
  prisma.user.findUnique.mockResolvedValue(user);
  if (user.role === 'TUTOR') {
    prisma.tutorProfile.findUnique.mockResolvedValue(
      user.id === tutorUser.id ? tutorProfile : otherTutorProfile
    );
  }
};

const findBookingUpdateData = () =>
  prisma.booking.update.mock.calls
    .map(([args]) => args?.data)
    .find((data) => data && Object.prototype.hasOwnProperty.call(data, 'version'));

const findOfferStatusMutation = () => {
  const directUpdate = prisma.bookingPriceOffer.update.mock.calls
    .map(([args]) => args?.data)
    .find((data) => data?.status);
  if (directUpdate) return directUpdate;

  for (const [args] of prisma.booking.update.mock.calls) {
    const relationUpdate = args?.data?.priceOffers?.update;
    const updateData = Array.isArray(relationUpdate)
      ? relationUpdate[0]?.data
      : relationUpdate?.data;
    if (updateData?.status) return updateData;
  }

  return null;
};

const expectNoAgreedPriceMutation = () => {
  for (const [args] of prisma.booking.update.mock.calls) {
    expect(args?.data).not.toHaveProperty('totalAmount');
    expect(args?.data?.payment?.update || {}).not.toHaveProperty('amount');
  }
};

beforeEach(() => {
  vi.resetAllMocks();
  prisma.$transaction.mockImplementation((input) =>
    typeof input === 'function' ? input(prisma) : Promise.all(input)
  );
  prisma.payment.update.mockImplementation(({ where, data }) =>
    Promise.resolve({ id: where.id, ...data, updatedAt: new Date() })
  );
  prisma.bookingPriceOffer.updateMany.mockResolvedValue({ count: 0 });
});

describe('pending booking price offer API', () => {
  test('includes price-offer history and the active offer in booking responses', async () => {
    const pendingOffer = makeOffer();
    setAuthenticatedUser(learnerUser);
    prisma.booking.findUnique.mockResolvedValue(
      makeBooking({ version: 2, priceOffers: [pendingOffer] })
    );

    const response = await request(app)
      .get('/api/v1/bookings/booking-1')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`);

    expect(response.status).toBe(200);
    expect(response.body.data.priceOffers).toEqual([
      expect.objectContaining({
        id: 'price-offer-1',
        status: 'PENDING',
        originalTotal: 100,
        proposedTotal: 75,
        difference: -25,
        direction: 'DECREASE',
      }),
    ]);
    expect(response.body.data.activePriceOffer).toEqual(
      expect.objectContaining({ id: 'price-offer-1', status: 'PENDING' })
    );
  });

  test.each([
    ['lower', 75, 'Loyalty discount'],
    ['higher', 120, 'Corrected lesson price'],
  ])('allows the assigned tutor to propose a %s total for a one-off lesson', async (_direction, proposedTotal, reason) => {
    const booking = makeBooking();
    const offer = makeOffer({
      proposedTotal,
      reason,
      originalTotal: booking.totalAmount,
    });
    const updatedBooking = makeBooking({
      version: 2,
      priceOffers: [offer],
    });

    setAuthenticatedUser(tutorUser);
    prisma.booking.findUnique
      .mockResolvedValueOnce(booking)
      .mockResolvedValueOnce(booking)
      .mockResolvedValueOnce(updatedBooking);
    prisma.bookingPriceOffer.create.mockResolvedValue(offer);
    prisma.booking.update.mockResolvedValue(updatedBooking);

    const response = await request(app)
      .post('/api/v1/bookings/booking-1/price-offers')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ proposedTotal, reason, expectedVersion: 1 });

    expect(response.status).toBe(201);
    expect(response.body.data).toEqual(
      expect.objectContaining({
        id: 'booking-1',
        status: 'PENDING',
        version: 2,
        totalAmount: 100,
        priceOffers: [expect.objectContaining({ proposedTotal, status: 'PENDING' })],
      })
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'booking-1',
          status: 'PENDING',
          version: 1,
        }),
        data: expect.objectContaining({
          version: { increment: 1 },
          priceOffers: {
            create: expect.objectContaining({
              originalTotal: 100,
              proposedTotal,
              currency: 'AUD',
              reason,
              createdById: tutorUser.id,
            }),
          },
        }),
      })
    );
    expectNoAgreedPriceMutation();
    expect(stripePaymentIntentCreate).not.toHaveBeenCalled();
  });

  test('does not reveal or mutate a booking assigned to a different tutor', async () => {
    setAuthenticatedUser(otherTutorUser);
    prisma.booking.findUnique.mockResolvedValue(makeBooking());

    const response = await request(app)
      .post('/api/v1/bookings/booking-1/price-offers')
      .set('Authorization', `Bearer ${createAccessToken(otherTutorUser)}`)
      .send({ proposedTotal: 80, expectedVersion: 1 });

    expect(response.status).toBe(404);
    expect(response.body.message).toBe('Booking not found');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.bookingPriceOffer.create).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  test.each([
    ['an accepted booking', { status: 'ACCEPTED' }, 400],
    ['a processing payment', { payment: { ...makeBooking().payment, status: 'PROCESSING' } }, 409],
    ['a paid payment', { payment: { ...makeBooking().payment, status: 'PAID' } }, 409],
  ])('rejects a price offer for %s', async (_label, overrides, expectedStatus) => {
    setAuthenticatedUser(tutorUser);
    prisma.booking.findUnique.mockResolvedValue(makeBooking(overrides));

    const response = await request(app)
      .post('/api/v1/bookings/booking-1/price-offers')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ proposedTotal: 80, expectedVersion: 1 });

    expect(response.status).toBe(expectedStatus);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.bookingPriceOffer.create).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  test('rejects price offers for a free trial occurrence', async () => {
    setAuthenticatedUser(tutorUser);
    prisma.booking.findUnique.mockResolvedValue(
      makeBooking({
        isTrialLesson: true,
        totalAmount: 0,
        payment: { ...makeBooking().payment, status: 'COMPLETED', amount: 0 },
      })
    );

    const response = await request(app)
      .post('/api/v1/bookings/booking-1/price-offers')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ proposedTotal: 25, expectedVersion: 1 });

    expect(response.status).toBe(400);
    expect(response.body.message.toLowerCase()).toContain('trial');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.bookingPriceOffer.create).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  test('allows a paid occurrence in a recurring series that also contains a free trial', async () => {
    const targetBooking = makeBooking({
      recurringType: 'WEEKLY',
      recurringGroupId: 'series-1',
    });
    const trialBooking = makeBooking({
      id: 'trial-booking',
      scheduledAt: new Date('2099-04-30T10:00:00.000Z'),
      recurringType: 'WEEKLY',
      recurringGroupId: 'series-1',
      isTrialLesson: true,
      totalAmount: 0,
      payment: { ...makeBooking().payment, id: 'trial-payment', status: 'COMPLETED', amount: 0 },
    });
    const offer = makeOffer({ proposedTotal: 85 });
    const updatedTarget = makeBooking({
      version: 2,
      recurringType: 'WEEKLY',
      recurringGroupId: 'series-1',
      priceOffers: [offer],
    });

    setAuthenticatedUser(tutorUser);
    prisma.booking.findUnique
      .mockResolvedValueOnce(targetBooking)
      .mockResolvedValueOnce(targetBooking)
      .mockResolvedValueOnce(updatedTarget);
    prisma.booking.findMany.mockResolvedValue([trialBooking, updatedTarget]);
    prisma.booking.update.mockResolvedValue(updatedTarget);

    const response = await request(app)
      .post('/api/v1/bookings/booking-1/price-offers')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ proposedTotal: 85, expectedVersion: 1 });

    expect(response.status).toBe(201);
    expect(response.body.data.priceOffers).toEqual([
      expect.objectContaining({ proposedTotal: 85, status: 'PENDING' }),
    ]);
    expect(prisma.booking.update).toHaveBeenCalledTimes(1);
    expect(stripePaymentIntentCreate).not.toHaveBeenCalled();
  });

  test('does not let a cancelled sibling lock price offers on remaining pending occurrences', async () => {
    const targetBooking = makeBooking({
      recurringType: 'WEEKLY',
      recurringGroupId: 'series-1',
    });
    const cancelledSibling = makeBooking({
      id: 'cancelled-booking',
      status: 'CANCELLED',
      scheduledAt: new Date('2099-05-14T10:00:00.000Z'),
      recurringType: 'WEEKLY',
      recurringGroupId: 'series-1',
      payment: { ...makeBooking().payment, id: 'cancelled-payment', status: 'CANCELLED' },
    });
    const offer = makeOffer({ proposedTotal: 90 });
    const updatedTarget = makeBooking({
      version: 2,
      recurringType: 'WEEKLY',
      recurringGroupId: 'series-1',
      priceOffers: [offer],
    });

    setAuthenticatedUser(tutorUser);
    prisma.booking.findUnique
      .mockResolvedValueOnce(targetBooking)
      .mockResolvedValueOnce(targetBooking)
      .mockResolvedValueOnce(updatedTarget);
    prisma.booking.findMany.mockResolvedValue([updatedTarget, cancelledSibling]);
    prisma.booking.update.mockResolvedValue(updatedTarget);

    const response = await request(app)
      .post('/api/v1/bookings/booking-1/price-offers')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ proposedTotal: 90, expectedVersion: 1 });

    expect(response.status).toBe(201);
    expect(response.body.data.recurringSeries.seriesPriceOfferLocked).toBe(false);
    expect(response.body.data.availableActions.canProposePriceOffer).toBe(false);
    expect(response.body.data.availableActions.canWithdrawPriceOffer).toBe(true);
    expect(stripePaymentIntentCreate).not.toHaveBeenCalled();
  });

  test('prevents a second offer while the occurrence has an unanswered offer', async () => {
    setAuthenticatedUser(tutorUser);
    prisma.booking.findUnique.mockResolvedValue(
      makeBooking({ priceOffers: [makeOffer()] })
    );

    const response = await request(app)
      .post('/api/v1/bookings/booking-1/price-offers')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ proposedTotal: 85, expectedVersion: 1 });

    expect(response.status).toBe(409);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.bookingPriceOffer.create).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  test('lets the tutor propose another price after an earlier offer was accepted', async () => {
    const acceptedOffer = makeOffer({
      status: 'ACCEPTED',
      proposedTotal: 75,
      respondedById: learnerUser.id,
      respondedAt: new Date('2099-04-02T00:00:00.000Z'),
    });
    const booking = makeBooking({
      version: 3,
      totalAmount: 75,
      payment: { ...makeBooking().payment, amount: 75 },
      priceOffers: [acceptedOffer],
    });
    const replacementOffer = makeOffer({
      id: 'price-offer-2',
      originalTotal: 75,
      proposedTotal: 90,
      reason: 'Correcting the lesson price',
      createdAt: new Date('2099-04-03T00:00:00.000Z'),
    });
    const updatedBooking = makeBooking({
      ...booking,
      version: 4,
      priceOffers: [replacementOffer, acceptedOffer],
    });

    setAuthenticatedUser(tutorUser);
    prisma.booking.findUnique
      .mockResolvedValueOnce(booking)
      .mockResolvedValueOnce(booking)
      .mockResolvedValueOnce(updatedBooking);
    prisma.booking.update.mockResolvedValue(updatedBooking);

    const response = await request(app)
      .post('/api/v1/bookings/booking-1/price-offers')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({
        proposedTotal: 90,
        reason: 'Correcting the lesson price',
        expectedVersion: 3,
      });

    expect(response.status).toBe(201);
    expect(response.body.data).toEqual(
      expect.objectContaining({
        version: 4,
        totalAmount: 75,
        payment: expect.objectContaining({ amount: 75, status: 'PENDING' }),
        priceOffers: expect.arrayContaining([
          expect.objectContaining({ id: 'price-offer-1', status: 'ACCEPTED' }),
          expect.objectContaining({
            id: 'price-offer-2',
            status: 'PENDING',
            originalTotal: 75,
            proposedTotal: 90,
          }),
        ]),
      })
    );
    expect(prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'booking-1', status: 'PENDING', version: 3 }),
        data: expect.objectContaining({
          version: { increment: 1 },
          priceOffers: {
            create: expect.objectContaining({
              originalTotal: 75,
              proposedTotal: 90,
              reason: 'Correcting the lesson price',
            }),
          },
        }),
      })
    );
    expect(prisma.bookingPriceOffer.updateMany).not.toHaveBeenCalled();
    expectNoAgreedPriceMutation();
    expect(stripePaymentIntentCreate).not.toHaveBeenCalled();
  });

  test('exposes another price adjustment to the tutor after an accepted offer', async () => {
    const acceptedOffer = makeOffer({
      status: 'ACCEPTED',
      proposedTotal: 75,
      respondedAt: new Date('2099-04-02T00:00:00.000Z'),
    });
    setAuthenticatedUser(tutorUser);
    prisma.booking.findUnique.mockResolvedValue(
      makeBooking({
        version: 3,
        totalAmount: 75,
        payment: { ...makeBooking().payment, amount: 75 },
        priceOffers: [acceptedOffer],
      })
    );

    const response = await request(app)
      .get('/api/v1/bookings/booking-1')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`);

    expect(response.status).toBe(200);
    expect(response.body.data.availableActions.canProposePriceOffer).toBe(true);
  });

  test('rejects a stale version when a tutor creates an offer', async () => {
    setAuthenticatedUser(tutorUser);
    prisma.booking.findUnique.mockResolvedValue(makeBooking({ version: 2 }));

    const response = await request(app)
      .post('/api/v1/bookings/booking-1/price-offers')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ proposedTotal: 80, expectedVersion: 1 });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('BOOKING_CHANGED');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.bookingPriceOffer.create).not.toHaveBeenCalled();
  });

  test('lets the owning learner accept an offer and atomically updates only that occurrence', async () => {
    const offer = makeOffer();
    const booking = makeBooking({ version: 2, priceOffers: [offer] });
    const acceptedOffer = makeOffer({
      status: 'ACCEPTED',
      respondedAt: new Date('2099-04-02T00:00:00.000Z'),
    });
    const updatedBooking = makeBooking({
      version: 3,
      totalAmount: 75,
      payment: { ...booking.payment, amount: 75 },
      priceOffers: [acceptedOffer],
    });

    setAuthenticatedUser(learnerUser);
    prisma.booking.findUnique
      .mockResolvedValueOnce(booking)
      .mockResolvedValueOnce(booking)
      .mockResolvedValueOnce(updatedBooking);
    prisma.bookingPriceOffer.findUnique.mockResolvedValue(offer);
    prisma.bookingPriceOffer.update.mockResolvedValue(acceptedOffer);
    prisma.booking.update.mockResolvedValue(updatedBooking);

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/price-offers/price-offer-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ expectedVersion: 2 });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(
      expect.objectContaining({
        id: 'booking-1',
        status: 'PENDING',
        version: 3,
        totalAmount: 75,
        payment: expect.objectContaining({ status: 'PENDING', amount: 75 }),
        priceOffers: [expect.objectContaining({ id: 'price-offer-1', status: 'ACCEPTED' })],
      })
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'booking-1',
          status: 'PENDING',
          version: 2,
        }),
        data: expect.objectContaining({
          totalAmount: 75,
          version: { increment: 1 },
          payment: {
            update: expect.objectContaining({ amount: 75 }),
          },
        }),
      })
    );
    expect(findOfferStatusMutation()).toEqual(
      expect.objectContaining({ status: 'ACCEPTED' })
    );
    expect(stripePaymentIntentCreate).not.toHaveBeenCalled();
  });

  test('accepting a replacement offer supersedes the previous agreement and applies the new total', async () => {
    const previousAcceptedOffer = makeOffer({
      status: 'ACCEPTED',
      proposedTotal: 75,
      respondedById: learnerUser.id,
      respondedAt: new Date('2099-04-02T00:00:00.000Z'),
    });
    const replacementOffer = makeOffer({
      id: 'price-offer-2',
      originalTotal: 75,
      proposedTotal: 90,
      reason: 'Corrected lesson price',
      createdAt: new Date('2099-04-03T00:00:00.000Z'),
    });
    const booking = makeBooking({
      version: 4,
      totalAmount: 75,
      payment: { ...makeBooking().payment, amount: 75 },
      priceOffers: [replacementOffer, previousAcceptedOffer],
    });
    const supersededOffer = {
      ...previousAcceptedOffer,
      status: 'SUPERSEDED',
    };
    const acceptedReplacement = {
      ...replacementOffer,
      status: 'ACCEPTED',
      respondedById: learnerUser.id,
      respondedAt: new Date('2099-04-04T00:00:00.000Z'),
    };
    const updatedBooking = makeBooking({
      ...booking,
      version: 5,
      totalAmount: 90,
      payment: { ...booking.payment, amount: 90 },
      priceOffers: [acceptedReplacement, supersededOffer],
    });

    setAuthenticatedUser(learnerUser);
    prisma.booking.findUnique
      .mockResolvedValueOnce(booking)
      .mockResolvedValueOnce(booking)
      .mockResolvedValueOnce(updatedBooking);
    prisma.bookingPriceOffer.updateMany.mockResolvedValue({ count: 1 });
    prisma.booking.update.mockResolvedValue(updatedBooking);

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/price-offers/price-offer-2/accept')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ expectedVersion: 4 });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(
      expect.objectContaining({
        version: 5,
        totalAmount: 90,
        payment: expect.objectContaining({ amount: 90, status: 'PENDING' }),
        priceOffers: expect.arrayContaining([
          expect.objectContaining({ id: 'price-offer-2', status: 'ACCEPTED' }),
          expect.objectContaining({ id: 'price-offer-1', status: 'SUPERSEDED' }),
        ]),
      })
    );
    expect(prisma.bookingPriceOffer.updateMany).toHaveBeenCalledWith({
      where: {
        bookingId: 'booking-1',
        status: 'ACCEPTED',
        id: { not: 'price-offer-2' },
      },
      data: { status: 'SUPERSEDED' },
    });
    expect(prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'booking-1', status: 'PENDING', version: 4 }),
        data: expect.objectContaining({
          version: { increment: 1 },
          totalAmount: 90,
          payment: { update: { amount: 90 } },
          priceOffers: {
            update: {
              where: { id: 'price-offer-2' },
              data: expect.objectContaining({ status: 'ACCEPTED' }),
            },
          },
        }),
      })
    );
    expect(stripePaymentIntentCreate).not.toHaveBeenCalled();
  });

  test('rejecting a replacement offer keeps the previous accepted price effective', async () => {
    const previousAcceptedOffer = makeOffer({
      status: 'ACCEPTED',
      proposedTotal: 75,
      respondedById: learnerUser.id,
      respondedAt: new Date('2099-04-02T00:00:00.000Z'),
    });
    const replacementOffer = makeOffer({
      id: 'price-offer-2',
      originalTotal: 75,
      proposedTotal: 90,
      createdAt: new Date('2099-04-03T00:00:00.000Z'),
    });
    const booking = makeBooking({
      version: 4,
      totalAmount: 75,
      payment: { ...makeBooking().payment, amount: 75 },
      priceOffers: [replacementOffer, previousAcceptedOffer],
    });
    const rejectedReplacement = {
      ...replacementOffer,
      status: 'REJECTED',
      respondedById: learnerUser.id,
      respondedAt: new Date('2099-04-04T00:00:00.000Z'),
    };
    const updatedBooking = makeBooking({
      ...booking,
      version: 5,
      priceOffers: [rejectedReplacement, previousAcceptedOffer],
    });

    setAuthenticatedUser(learnerUser);
    prisma.booking.findUnique
      .mockResolvedValueOnce(booking)
      .mockResolvedValueOnce(booking)
      .mockResolvedValueOnce(updatedBooking);
    prisma.booking.update.mockResolvedValue(updatedBooking);

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/price-offers/price-offer-2/reject')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ expectedVersion: 4 });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(
      expect.objectContaining({
        version: 5,
        totalAmount: 75,
        payment: expect.objectContaining({ amount: 75, status: 'PENDING' }),
        priceOffers: expect.arrayContaining([
          expect.objectContaining({ id: 'price-offer-2', status: 'REJECTED' }),
          expect.objectContaining({ id: 'price-offer-1', status: 'ACCEPTED' }),
        ]),
      })
    );
    expect(prisma.bookingPriceOffer.updateMany).not.toHaveBeenCalled();
    expectNoAgreedPriceMutation();
    expect(stripePaymentIntentCreate).not.toHaveBeenCalled();
  });

  test('requires verified webhook configuration before charging an accepted revised total', async () => {
    const acceptedOffer = makeOffer({
      status: 'ACCEPTED',
      respondedAt: new Date('2099-04-02T00:00:00.000Z'),
    });
    const pendingBooking = makeBooking({
      version: 3,
      totalAmount: 75,
      payment: { ...makeBooking().payment, amount: 75 },
      priceOffers: [acceptedOffer],
    });
    const acceptedBooking = makeBooking({
      ...pendingBooking,
      status: 'ACCEPTED',
      version: 4,
    });
    const paidBooking = makeBooking({
      ...acceptedBooking,
      payment: { ...acceptedBooking.payment, status: 'PAID', amount: 75 },
    });

    setAuthenticatedUser(tutorUser);
    prisma.tutorProfile.findUnique
      .mockResolvedValueOnce(tutorProfile)
      .mockResolvedValueOnce({
        ...tutorProfile,
        user: { timezone: 'UTC' },
        availability: [{ dayOfWeek: 4, startTime: '09:00', endTime: '13:00' }],
      });
    prisma.booking.findUnique
      .mockResolvedValueOnce(pendingBooking)
      .mockResolvedValueOnce(pendingBooking);
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.bookingPriceOffer.findFirst.mockResolvedValue(null);
    prisma.booking.update
      .mockResolvedValueOnce(acceptedBooking)
      .mockResolvedValueOnce(paidBooking);
    stripePaymentIntentCreate.mockResolvedValueOnce({
      id: 'pi_revised_price',
      status: 'succeeded',
    });

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 3 });

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    expect(stripePaymentIntentCreate).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  test('does not let another learner see or accept the offer', async () => {
    const offer = makeOffer();
    setAuthenticatedUser(otherLearnerUser);
    prisma.booking.findUnique.mockResolvedValue(
      makeBooking({ version: 2, priceOffers: [offer] })
    );
    prisma.bookingPriceOffer.findUnique.mockResolvedValue(offer);

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/price-offers/price-offer-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(otherLearnerUser)}`)
      .send({ expectedVersion: 2 });

    expect(response.status).toBe(404);
    expect(response.body.message).toBe('Booking not found');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.bookingPriceOffer.update).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  test('rejecting an offer records the decision without changing booking or payment totals', async () => {
    const offer = makeOffer();
    const booking = makeBooking({ version: 2, priceOffers: [offer] });
    const rejectedOffer = makeOffer({ status: 'REJECTED', respondedAt: new Date() });
    const updatedBooking = makeBooking({
      version: 3,
      priceOffers: [rejectedOffer],
    });

    setAuthenticatedUser(learnerUser);
    prisma.booking.findUnique
      .mockResolvedValueOnce(booking)
      .mockResolvedValueOnce(booking)
      .mockResolvedValueOnce(updatedBooking);
    prisma.bookingPriceOffer.findUnique.mockResolvedValue(offer);
    prisma.bookingPriceOffer.update.mockResolvedValue(rejectedOffer);
    prisma.booking.update.mockResolvedValue(updatedBooking);

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/price-offers/price-offer-1/reject')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ expectedVersion: 2 });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(
      expect.objectContaining({
        status: 'PENDING',
        version: 3,
        totalAmount: 100,
        payment: expect.objectContaining({ amount: 100, status: 'PENDING' }),
        priceOffers: [expect.objectContaining({ status: 'REJECTED' })],
      })
    );
    expect(findBookingUpdateData()).toEqual(
      expect.objectContaining({ version: { increment: 1 } })
    );
    expect(findOfferStatusMutation()).toEqual(
      expect.objectContaining({ status: 'REJECTED' })
    );
    expectNoAgreedPriceMutation();
    expect(stripePaymentIntentCreate).not.toHaveBeenCalled();
  });

  test('the assigned tutor can withdraw an unanswered offer without changing totals', async () => {
    const offer = makeOffer();
    const booking = makeBooking({ version: 2, priceOffers: [offer] });
    const withdrawnOffer = makeOffer({ status: 'WITHDRAWN', withdrawnAt: new Date() });
    const updatedBooking = makeBooking({
      version: 3,
      priceOffers: [withdrawnOffer],
    });

    setAuthenticatedUser(tutorUser);
    prisma.booking.findUnique
      .mockResolvedValueOnce(booking)
      .mockResolvedValueOnce(booking)
      .mockResolvedValueOnce(updatedBooking);
    prisma.bookingPriceOffer.findUnique.mockResolvedValue(offer);
    prisma.bookingPriceOffer.update.mockResolvedValue(withdrawnOffer);
    prisma.booking.update.mockResolvedValue(updatedBooking);

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/price-offers/price-offer-1/withdraw')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 2 });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(
      expect.objectContaining({
        status: 'PENDING',
        version: 3,
        totalAmount: 100,
        payment: expect.objectContaining({ amount: 100, status: 'PENDING' }),
        priceOffers: [expect.objectContaining({ status: 'WITHDRAWN' })],
      })
    );
    expect(findBookingUpdateData()).toEqual(
      expect.objectContaining({ version: { increment: 1 } })
    );
    expect(findOfferStatusMutation()).toEqual(
      expect.objectContaining({ status: 'WITHDRAWN' })
    );
    expectNoAgreedPriceMutation();
    expect(stripePaymentIntentCreate).not.toHaveBeenCalled();
  });

  test.each([
    ['stale', makeOffer(), 2],
    ['repeated', makeOffer({ status: 'ACCEPTED', respondedAt: new Date() }), 3],
  ])('rejects a %s learner response without changing the agreed price', async (_label, offer, expectedVersion) => {
    const booking = makeBooking({
      version: 3,
      totalAmount: 75,
      payment: { ...makeBooking().payment, amount: 75 },
      priceOffers: [offer],
    });

    setAuthenticatedUser(learnerUser);
    prisma.booking.findUnique.mockResolvedValue(booking);

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/price-offers/price-offer-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ expectedVersion });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('BOOKING_CHANGED');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.bookingPriceOffer.update).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(stripePaymentIntentCreate).not.toHaveBeenCalled();
  });

  test('accepting an offer on a recurring occurrence updates that dated booking only', async () => {
    const offer = makeOffer();
    const targetBooking = makeBooking({
      version: 2,
      recurringType: 'WEEKLY',
      recurringGroupId: 'series-1',
      priceOffers: [offer],
    });
    const siblingBooking = makeBooking({
      id: 'booking-2',
      version: 1,
      scheduledAt: new Date('2099-05-14T10:00:00.000Z'),
      recurringType: 'WEEKLY',
      recurringGroupId: 'series-1',
      payment: { ...makeBooking().payment, id: 'payment-2' },
    });
    const acceptedOffer = makeOffer({ status: 'ACCEPTED', respondedAt: new Date() });
    const updatedTarget = makeBooking({
      version: 3,
      totalAmount: 75,
      recurringType: 'WEEKLY',
      recurringGroupId: 'series-1',
      payment: { ...targetBooking.payment, amount: 75 },
      priceOffers: [acceptedOffer],
    });

    setAuthenticatedUser(learnerUser);
    prisma.booking.findUnique
      .mockResolvedValueOnce(targetBooking)
      .mockResolvedValueOnce(targetBooking)
      .mockResolvedValueOnce(updatedTarget);
    prisma.booking.findMany.mockResolvedValue([updatedTarget, siblingBooking]);
    prisma.bookingPriceOffer.findUnique.mockResolvedValue(offer);
    prisma.bookingPriceOffer.update.mockResolvedValue(acceptedOffer);
    prisma.booking.update.mockResolvedValue(updatedTarget);

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/price-offers/price-offer-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ expectedVersion: 2 });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(
      expect.objectContaining({
        id: 'booking-1',
        totalAmount: 75,
        recurringGroupId: 'series-1',
      })
    );
    expect(prisma.booking.update).toHaveBeenCalledTimes(1);
    expect(prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'booking-1' }),
        data: expect.not.objectContaining({ updateMany: expect.anything() }),
      })
    );
    expect(prisma.booking.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'booking-2' }) })
    );
    expect(siblingBooking.totalAmount).toBe(100);
    expect(siblingBooking.payment.amount).toBe(100);
    expect(stripePaymentIntentCreate).not.toHaveBeenCalled();
  });

  test('does not fall back to an aggregate recurring charge without webhook verification', async () => {
    const acceptedOffer = makeOffer({
      status: 'ACCEPTED',
      respondedAt: new Date('2099-04-02T00:00:00.000Z'),
    });
    const targetBooking = makeBooking({
      version: 3,
      totalAmount: 75,
      recurringType: 'WEEKLY',
      recurringGroupId: 'series-1',
      payment: { ...makeBooking().payment, amount: 75 },
      priceOffers: [acceptedOffer],
    });
    const siblingBooking = makeBooking({
      id: 'booking-2',
      scheduledAt: new Date('2099-05-14T10:00:00.000Z'),
      recurringType: 'WEEKLY',
      recurringGroupId: 'series-1',
      payment: { ...makeBooking().payment, id: 'payment-2', amount: 100 },
    });
    const acceptedTarget = makeBooking({
      ...targetBooking,
      status: 'ACCEPTED',
      version: 4,
    });
    const paidTarget = makeBooking({
      ...acceptedTarget,
      payment: { ...acceptedTarget.payment, status: 'PAID' },
    });
    const paidSibling = makeBooking({
      ...siblingBooking,
      payment: { ...siblingBooking.payment, status: 'PAID' },
    });

    setAuthenticatedUser(tutorUser);
    prisma.tutorProfile.findUnique
      .mockResolvedValueOnce(tutorProfile)
      .mockResolvedValueOnce({
        ...tutorProfile,
        user: { timezone: 'UTC' },
        availability: [{ dayOfWeek: 4, startTime: '09:00', endTime: '13:00' }],
      });
    prisma.booking.findUnique
      .mockResolvedValueOnce(targetBooking)
      .mockResolvedValueOnce(targetBooking);
    prisma.booking.findMany
      .mockResolvedValueOnce([targetBooking, siblingBooking])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([acceptedTarget, siblingBooking]);
    prisma.bookingPriceOffer.findFirst.mockResolvedValue(null);
    prisma.booking.update
      .mockResolvedValueOnce(acceptedTarget)
      .mockResolvedValueOnce(paidTarget)
      .mockResolvedValueOnce(paidSibling);
    stripePaymentIntentCreate.mockResolvedValueOnce({
      id: 'pi_revised_series',
      status: 'succeeded',
    });

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 3 });

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    expect(stripePaymentIntentCreate).not.toHaveBeenCalled();
    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(siblingBooking.totalAmount).toBe(100);
    expect(siblingBooking.payment.amount).toBe(100);
  });

  test('blocks tutor acceptance while any payable recurring occurrence has an unanswered offer', async () => {
    const activeOffer = makeOffer();
    const targetBooking = makeBooking({
      recurringType: 'WEEKLY',
      recurringGroupId: 'series-1',
    });
    const siblingWithOffer = makeBooking({
      id: 'booking-2',
      scheduledAt: new Date('2099-05-14T10:00:00.000Z'),
      recurringType: 'WEEKLY',
      recurringGroupId: 'series-1',
      payment: { ...makeBooking().payment, id: 'payment-2' },
      priceOffers: [makeOffer({ bookingId: 'booking-2' })],
    });

    setAuthenticatedUser(tutorUser);
    prisma.booking.findUnique.mockResolvedValue(targetBooking);
    prisma.booking.findMany.mockResolvedValue([targetBooking, siblingWithOffer]);
    prisma.bookingPriceOffer.findFirst.mockResolvedValue(activeOffer);

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/accept')
      .set('Authorization', `Bearer ${createAccessToken(tutorUser)}`)
      .send({ expectedVersion: 1 });

    expect(response.status).toBe(409);
    expect(response.body.message.toLowerCase()).toContain('price');
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(stripePaymentIntentCreate).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(notifyOrRefresh).not.toHaveBeenCalled();
  });

  test('removes the learner-triggered recurring payment endpoint', async () => {
    const acceptedBooking = makeBooking({
      status: 'ACCEPTED',
      recurringType: 'WEEKLY',
      recurringGroupId: 'series-1',
    });

    setAuthenticatedUser(learnerUser);
    prisma.booking.findUnique.mockResolvedValue(acceptedBooking);
    prisma.bookingPriceOffer.findFirst.mockResolvedValue(makeOffer({ bookingId: 'booking-2' }));

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/payment/pay')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`);

    expect(response.status).toBe(404);
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(stripePaymentIntentCreate).not.toHaveBeenCalled();
  });

  test('does not expose the removed manual charge endpoint to concurrent retries', async () => {
    const acceptedOffer = makeOffer({ status: 'ACCEPTED', respondedAt: new Date() });
    const acceptedBooking = makeBooking({
      status: 'ACCEPTED',
      version: 4,
      totalAmount: 75,
      payment: { ...makeBooking().payment, amount: 75 },
      priceOffers: [acceptedOffer],
    });
    const paidBooking = makeBooking({
      ...acceptedBooking,
      payment: { ...acceptedBooking.payment, status: 'PAID' },
    });
    let paymentReserved = false;

    setAuthenticatedUser(learnerUser);
    prisma.booking.findUnique.mockResolvedValue(acceptedBooking);
    prisma.bookingPriceOffer.findFirst.mockResolvedValue(null);
    prisma.payment.update.mockImplementation(async ({ where, data }) => {
      if (where.status?.in) {
        if (paymentReserved) {
          const error = new Error('Payment status changed');
          error.code = 'P2025';
          throw error;
        }
        paymentReserved = true;
      }
      return { id: where.id, ...data, updatedAt: new Date() };
    });
    prisma.booking.update.mockResolvedValue(paidBooking);
    stripePaymentIntentCreate.mockResolvedValue({ id: 'pi_once', status: 'succeeded' });

    const responses = await Promise.all([
      request(app)
        .patch('/api/v1/bookings/booking-1/payment/pay')
        .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`),
      request(app)
        .patch('/api/v1/bookings/booking-1/payment/pay')
        .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`),
    ]);

    expect(responses.map((response) => response.status)).toEqual([404, 404]);
    expect(stripePaymentIntentCreate).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  test('does not allow manual recovery of processing payments', async () => {
    const idempotencyKey = `booking-charge-${createHash('sha256')
      .update(['booking-1', 'AUD', 'pm_learner_1', 'payment-1:75.00'].join('|'))
      .digest('hex')}`;
    const acceptedBooking = makeBooking({
      status: 'ACCEPTED',
      version: 4,
      totalAmount: 75,
      payment: {
        ...makeBooking().payment,
        status: 'PROCESSING',
        amount: 75,
        processedAt: new Date(Date.now() - 5 * 60 * 1000),
        stripeIdempotencyKey: idempotencyKey,
      },
      priceOffers: [makeOffer({ status: 'ACCEPTED', respondedAt: new Date() })],
    });
    const paidBooking = makeBooking({
      ...acceptedBooking,
      payment: { ...acceptedBooking.payment, status: 'PAID' },
    });

    setAuthenticatedUser(learnerUser);
    prisma.booking.findUnique.mockResolvedValue(acceptedBooking);
    prisma.bookingPriceOffer.findFirst.mockResolvedValue(null);
    prisma.booking.update.mockResolvedValue(paidBooking);
    stripePaymentIntentCreate.mockResolvedValue({
      id: 'pi_recovered',
      status: 'succeeded',
    });

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/payment/pay')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`);

    expect(response.status).toBe(404);
    expect(stripePaymentIntentCreate).not.toHaveBeenCalled();
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });

  test('does not expose payment-worker leases through the removed manual endpoint', async () => {
    const acceptedBooking = makeBooking({
      status: 'ACCEPTED',
      totalAmount: 75,
      payment: {
        ...makeBooking().payment,
        status: 'PROCESSING',
        amount: 75,
        processedAt: new Date(Date.now() - 5 * 60 * 1000),
      },
    });
    let paymentUpdateCount = 0;

    setAuthenticatedUser(learnerUser);
    prisma.booking.findUnique.mockResolvedValue(acceptedBooking);
    prisma.bookingPriceOffer.findFirst.mockResolvedValue(null);
    prisma.payment.update.mockImplementation(async ({ where, data }) => {
      paymentUpdateCount += 1;
      if (where.paymentAttemptToken) {
        const error = new Error('Lease was reclaimed');
        error.code = 'P2025';
        throw error;
      }
      return { id: where.id, ...data, updatedAt: new Date() };
    });
    stripePaymentIntentCreate.mockResolvedValue({ id: 'pi_shared', status: 'succeeded' });

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/payment/pay')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`);

    expect(response.status).toBe(404);
    expect(paymentUpdateCount).toBe(0);
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  test('does not submit a manual charge with an unknown provider outcome', async () => {
    const acceptedBooking = makeBooking({ status: 'ACCEPTED', totalAmount: 75 });

    setAuthenticatedUser(learnerUser);
    prisma.booking.findUnique.mockResolvedValue(acceptedBooking);
    prisma.bookingPriceOffer.findFirst.mockResolvedValue(null);
    stripePaymentIntentCreate.mockRejectedValue(
      Object.assign(new Error('An identical request is still running'), {
        code: 'idempotency_key_in_use',
      })
    );

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/payment/pay')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`);

    expect(response.status).toBe(404);
    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  test('does not replace the payment method attached to a processing attempt', async () => {
    const processingBooking = makeBooking({
      status: 'ACCEPTED',
      payment: {
        ...makeBooking().payment,
        status: 'PROCESSING',
        processedAt: new Date(),
        stripeIdempotencyKey: 'booking-charge-existing',
      },
    });
    prisma.user.findUnique
      .mockResolvedValueOnce(learnerUser)
      .mockResolvedValueOnce({
        stripeCustomerId: 'cus_learner_1',
        stripeDefaultPaymentMethodId: 'pm_replacement',
      });
    prisma.booking.findUnique.mockResolvedValue(processingBooking);

    const response = await request(app)
      .post('/api/v1/payments/bookings/booking-1/use-saved-method')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`);

    expect(response.status).toBe(409);
    expect(response.body.message).toContain('cannot be changed');
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });

  test('rejects a payment-method race when the charge reserves the payment first', async () => {
    const pendingBooking = makeBooking({ status: 'ACCEPTED' });
    prisma.user.findUnique
      .mockResolvedValueOnce(learnerUser)
      .mockResolvedValueOnce({
        stripeCustomerId: 'cus_learner_1',
        stripeDefaultPaymentMethodId: 'pm_replacement',
      });
    prisma.booking.findUnique.mockResolvedValue(pendingBooking);
    prisma.payment.update.mockRejectedValue(
      Object.assign(new Error('Payment status changed'), { code: 'P2025' })
    );

    const response = await request(app)
      .post('/api/v1/payments/bookings/booking-1/use-saved-method')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`);

    expect(response.status).toBe(409);
    expect(response.body.message).toContain('cannot be changed');
    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'payment-1',
          status: { in: ['PENDING', 'FAILED'] },
        },
      })
    );
  });

  test('does not expose a manual charge race with payment-method replacement', async () => {
    const acceptedBooking = makeBooking({ status: 'ACCEPTED' });
    setAuthenticatedUser(learnerUser);
    prisma.booking.findUnique.mockResolvedValue(acceptedBooking);
    prisma.bookingPriceOffer.findFirst.mockResolvedValue(null);
    prisma.payment.update.mockRejectedValue(
      Object.assign(new Error('Payment method changed'), { code: 'P2025' })
    );

    const response = await request(app)
      .patch('/api/v1/bookings/booking-1/payment/pay')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`);

    expect(response.status).toBe(404);
    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(stripePaymentIntentCreate).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  test('blocks cancellation while a payment attempt is processing', async () => {
    const processingBooking = makeBooking({
      status: 'ACCEPTED',
      payment: { ...makeBooking().payment, status: 'PROCESSING', processedAt: new Date() },
    });
    setAuthenticatedUser(learnerUser);
    prisma.booking.findUnique.mockResolvedValue(processingBooking);

    const response = await request(app)
      .post('/api/v1/bookings/booking-1/cancel')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ reason: 'Cannot attend' });

    expect(response.status).toBe(409);
    expect(response.body.message).toContain('payment attempt');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  test('aborts cancellation if payment becomes processing before the locked update', async () => {
    const acceptedBooking = makeBooking({ status: 'ACCEPTED' });
    const processingBooking = makeBooking({
      ...acceptedBooking,
      payment: { ...acceptedBooking.payment, status: 'PROCESSING', processedAt: new Date() },
    });
    setAuthenticatedUser(learnerUser);
    prisma.booking.findUnique
      .mockResolvedValueOnce(acceptedBooking)
      .mockResolvedValueOnce(processingBooking);

    const response = await request(app)
      .post('/api/v1/bookings/booking-1/cancel')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ reason: 'Cannot attend' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('BOOKING_CHANGED');
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });
});
