const { prisma } = require('../config/database');
const { getStripe, isStripeConfigured } = require('../config/stripe');
const { getPaymentEnvironment, assertMatchingPaymentEnvironment } = require('../config/paymentEnvironment');
const { AppError } = require('../middleware/errorHandler');
const {
  validateBookingTime,
  getTimeInTimezone,
  normalizeTimezone,
} = require('../utils/timezone');
const { timeToMinutes, isAlignedMinutes } = require('../utils/slots');
const { serializePayment } = require('../utils/paymentSerialization');
const { payoutSetupRequiredError } = require('../utils/payoutReadiness');
const {
  DEFAULT_PLATFORM_FEE_PERCENT,
  calculateEarning,
} = require('../utils/earnings');
const { notifyOrRefresh } = require('./notificationService');

const ACCEPTANCE_MODES = Object.freeze({
  TUTOR: 'TUTOR_ACCEPT',
  LEARNER_TUTOR_TIME: 'LEARNER_ACCEPT_TUTOR_TIME',
});
const SUPPORTED_CURRENCIES = new Set(
  String(process.env.PAYMENT_SUPPORTED_CURRENCIES || 'AUD,USD,GBP,EUR')
    .split(',')
    .map((currency) => currency.trim().toUpperCase())
    .filter(Boolean)
);
const PAID_STATUSES = new Set(['PAID', 'COMPLETED', 'PARTIALLY_REFUNDED']);
const TERMINAL_BOOKING_STATUSES = new Set([
  'DECLINED',
  'CANCELLED',
  'COMPLETED',
  'NOT_COMPLETED',
]);

const hasCurrentAcceptanceAuthorization = (booking) =>
  Boolean(
    booking?.payment?.acceptanceMode &&
      booking.payment.acceptanceAuthorizedById &&
      Number(booking.payment.acceptanceBookingVersion) === Number(booking.version)
  );

const acceptanceBookingInclude = {
  payment: {
    include: {
      attempts: { orderBy: { sequence: 'desc' } },
    },
  },
  learner: true,
  tutorProfile: { include: { user: true } },
  priceOffers: { orderBy: { createdAt: 'desc' } },
  rescheduleRequests: { orderBy: { createdAt: 'desc' } },
  statusHistory: { orderBy: { createdAt: 'desc' } },
};

const getStripeObjectId = (value) => {
  if (typeof value === 'string') return value;
  if (value?.id) return String(value.id);
  return null;
};

const toMoney = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const toMinorUnits = (value) => Math.round(toMoney(value) * 100);
const isWebhookConfigured = () => getPaymentEnvironment().isTestPayment || Boolean(String(process.env.STRIPE_WEBHOOK_SECRET || '').trim());
const paymentMethodLink = (bookingId) => {
  const returnTo = `/bookings/${bookingId}`;
  return `/bookings/${bookingId}/payment?returnTo=${encodeURIComponent(returnTo)}`;
};

const paymentError = (message, statusCode, code, bookingId, withAction = false) =>
  new AppError(message, statusCode, {
    code,
    ...(withAction
      ? { action: 'UPDATE_PAYMENT_METHOD', link: paymentMethodLink(bookingId) }
      : {}),
  });

const slotUnavailableError = (bookingId) =>
  new AppError(
    'This lesson time is no longer available. No payment was collected; please choose another time.',
    409,
    {
      code: 'SLOT_UNAVAILABLE',
      action: 'CHOOSE_ANOTHER_TIME',
      link: `/bookings/${bookingId}?action=change-time`,
    }
  );

const bookingChangedError = (bookingId, message) =>
  paymentError(
    message || 'This booking request changed. Refresh to see the latest details.',
    409,
    'BOOKING_CHANGED',
    bookingId
  );

/**
 * PAY-05 AC4. Block a paid booking from being charged when the assigned tutor
 * cannot receive money yet. Free trial acceptance never reaches this because
 * callers return early on isTrialLesson.
 *
 * Readiness is a persisted boolean, so this stays one indexed lookup with no
 * provider round-trip on the acceptance path.
 */
const assertTutorPayoutReady = async (booking, actor, database = prisma) => {
  // Without a usable provider there is no payout account to complete, and
  // acceptance already fails later with PAYMENT_PROVIDER_UNAVAILABLE. Returning
  // early keeps a platform misconfiguration reported as itself rather than as a
  // payout-setup prompt the tutor cannot act on.
  if (!isStripeConfigured() || !isWebhookConfigured()) return;

  const payoutAccount = await database.tutorPayoutAccount?.findUnique?.({
    where: { tutorProfileId: booking.tutorId },
    select: { isPayoutReady: true, stripeAccountId: true },
  });
  assertMatchingPaymentEnvironment(payoutAccount);
  if (payoutAccount?.isPayoutReady) return;

  throw payoutSetupRequiredError({ bookingId: booking.id, actorRole: actor?.role });
};

const findPendingPriceOffer = async (booking, database = prisma) => {
  if (booking.priceOffers?.some((offer) => offer.status === 'PENDING')) {
    return true;
  }
  if (!database.bookingPriceOffer?.findFirst) return false;
  const where = booking.recurringGroupId
    ? {
        status: 'PENDING',
        booking: {
          is: {
            recurringGroupId: booking.recurringGroupId,
            learnerId: booking.learnerId,
            tutorId: booking.tutorId,
          },
        },
      }
    : { bookingId: booking.id, status: 'PENDING' };
  return Boolean(await database.bookingPriceOffer.findFirst({ where, select: { id: true } }));
};

const assertNoPendingPriceOffer = async (booking, database = prisma) => {
  if (await findPendingPriceOffer(booking, database)) {
    const error = new AppError(
      'Resolve the pending price offer before accepting this booking.',
      409
    );
    error.errorCode = 'PRICE_OFFER_PENDING';
    throw error;
  }
};

const providerUnavailableError = (bookingId) =>
  paymentError(
    'Payment processing is currently unavailable. Please try again later.',
    503,
    'PAYMENT_PROVIDER_UNAVAILABLE',
    bookingId
  );

const getProviderFailureCode = (error, paymentIntent) =>
  String(
    error?.decline_code ||
      error?.raw?.decline_code ||
      error?.code ||
      error?.raw?.code ||
      paymentIntent?.last_payment_error?.decline_code ||
      paymentIntent?.last_payment_error?.code ||
      paymentIntent?.status ||
      'payment_failed'
  ).toLowerCase();

const getSafePaymentFailure = (error, paymentIntent) => {
  const providerCode = getProviderFailureCode(error, paymentIntent);
  if (['expired_card'].includes(providerCode)) {
    return {
      providerCode,
      reason: 'The saved card has expired. Please choose another payment method and try again.',
    };
  }
  if (['insufficient_funds'].includes(providerCode)) {
    return {
      providerCode,
      reason:
        'The payment method has insufficient funds. Please choose another method or try again later.',
    };
  }
  if (
    [
      'authentication_required',
      'payment_intent_authentication_failure',
      'requires_action',
    ].includes(providerCode)
  ) {
    return {
      providerCode,
      reason:
        'The payment method requires additional authentication. Please choose or add another method.',
    };
  }
  if (
    [
      'card_declined',
      'do_not_honor',
      'generic_decline',
      'incorrect_cvc',
      'payment_method_customer_mismatch',
      'payment_method_not_available',
      'payment_method_provider_decline',
      'payment_method_unactivated',
      'payment_method_unexpected_state',
      'requires_payment_method',
    ].includes(providerCode)
  ) {
    return {
      providerCode,
      reason:
        'The payment method was declined. Please choose another method or contact your bank.',
    };
  }
  return {
    providerCode,
    reason:
      'Payment could not be completed. Please choose another payment method and try again.',
  };
};

const overlaps = (left, right) => {
  const leftStart = new Date(left.scheduledAt);
  const leftEnd = new Date(leftStart.getTime() + Number(left.duration || 0) * 60 * 1000);
  const rightStart = new Date(right.scheduledAt);
  const rightEnd = new Date(rightStart.getTime() + Number(right.duration || 0) * 60 * 1000);
  return leftStart < rightEnd && leftEnd > rightStart;
};

const findAcceptanceBlockers = async (database, booking) => {
  const requestedStart = new Date(booking.scheduledAt);
  const requestedEnd = new Date(
    requestedStart.getTime() + Number(booking.duration || 0) * 60 * 1000
  );
  const lookupStart = new Date(requestedStart.getTime() - 8 * 60 * 60 * 1000);
  const candidates = await database.booking.findMany({
    where: {
      tutorId: booking.tutorId,
      id: { not: booking.id },
      status: { in: ['PENDING', 'ACCEPTED', 'COMPLETED'] },
      scheduledAt: { gte: lookupStart, lt: requestedEnd },
    },
    include: { payment: true },
  });

  return candidates.filter(
    (candidate) =>
      overlaps(booking, candidate) &&
      (['ACCEPTED', 'COMPLETED'].includes(candidate.status) ||
        (candidate.status === 'PENDING' && candidate.payment?.status === 'PROCESSING'))
  );
};

const assertNoAcceptanceConflict = async (database, booking) => {
  if ((await findAcceptanceBlockers(database, booking)).length > 0) {
    throw new AppError(
      'Another session is already being accepted or has been accepted for this time slot.',
      409
    );
  }
};

const assertTimeStillValid = async (
  database,
  booking,
  mode,
  { requireCurrentAvailability = false } = {}
) => {
  const proposedTime = new Date(booking.scheduledAt);
  if (Number.isNaN(proposedTime.getTime()) || proposedTime <= new Date()) {
    throw bookingChangedError(booking.id, 'The requested lesson time is no longer valid.');
  }
  await assertNoAcceptanceConflict(database, booking);

  const tutorProfile = await database.tutorProfile.findUnique({
    where: { id: booking.tutorId },
    include: {
      user: { select: { timezone: true, status: true } },
      ...(mode === ACCEPTANCE_MODES.TUTOR || requireCurrentAvailability
        ? { availability: { orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] } }
        : {}),
    },
  });
  if (
    !tutorProfile ||
    (tutorProfile.status && tutorProfile.status !== 'ACTIVE') ||
    (tutorProfile.user?.status && tutorProfile.user.status !== 'ACTIVE')
  ) {
    throw new AppError('The assigned tutor is no longer active.', 403);
  }

  const tutorTimezone = normalizeTimezone(tutorProfile.user?.timezone);
  if (mode === ACCEPTANCE_MODES.TUTOR || requireCurrentAvailability) {
    const slots = tutorProfile.availability || [];
    if (!slots.length) throw new AppError('Tutor has no availability set', 400);
    const validation = validateBookingTime(
      proposedTime,
      tutorTimezone,
      slots,
      Number(booking.duration)
    );
    if (!validation.isValid) throw new AppError(validation.message, 400);
  }

  const localStartMinutes = timeToMinutes(getTimeInTimezone(proposedTime, tutorTimezone));
  if (
    !isAlignedMinutes(localStartMinutes) ||
    proposedTime.getUTCSeconds() !== 0 ||
    proposedTime.getUTCMilliseconds() !== 0
  ) {
    throw new AppError('Start time must be on the hour or half-hour.', 400);
  }
};

const getActiveTutor = async (actor, booking, database = prisma) => {
  const tutorProfile = await database.tutorProfile.findUnique({
    where: { id: booking.tutorId },
    include: { user: { select: { id: true, status: true } } },
  });
  if (!tutorProfile) throw new AppError('Tutor profile not found', 404);
  const profileStatus = String(tutorProfile.status || '').toUpperCase();
  const persistedUserStatus = String(tutorProfile.user?.status || '').toUpperCase();
  const actorStatus = String(actor?.status || '').toUpperCase();
  if (
    (profileStatus && profileStatus !== 'ACTIVE') ||
    (persistedUserStatus && persistedUserStatus !== 'ACTIVE') ||
    (actorStatus && actorStatus !== 'ACTIVE')
  ) {
    throw new AppError('Your tutor account must be active before accepting bookings.', 403);
  }
  return tutorProfile;
};

const assertActorAndTransition = async (
  booking,
  actor,
  mode,
  expectedVersion,
  database = prisma
) => {
  if (mode === ACCEPTANCE_MODES.TUTOR) {
    if (
      actor?.role !== 'TUTOR' ||
      (booking.tutorProfile?.userId && booking.tutorProfile.userId !== actor.id)
    ) {
      throw new AppError('Booking not found', 404);
    }
    if (booking.negotiationStatus === 'TIME_PROPOSED_BY_TUTOR') {
      throw new AppError('You cannot accept your own proposed time. The learner must respond first.', 409);
    }
  } else if (mode === ACCEPTANCE_MODES.LEARNER_TUTOR_TIME) {
    const hasTutorProposal = booking.rescheduleRequests?.some(
      (proposal) => proposal.status === 'PENDING' && proposal.proposedBy === 'TUTOR'
    );
    if (actor?.role !== 'LEARNER' || booking.learnerId !== actor.id) {
      throw new AppError('Booking not found', 404);
    }
    if (booking.negotiationStatus !== 'TIME_PROPOSED_BY_TUTOR' || !hasTutorProposal) {
      throw new AppError('There is no tutor time proposal awaiting your response.', 409);
    }
  } else {
    throw new AppError('Unsupported booking acceptance mode', 500);
  }
  const tutorProfile = await getActiveTutor(actor, booking, database);
  if (
    mode === ACCEPTANCE_MODES.TUTOR &&
    (tutorProfile.userId || booking.tutorProfile?.userId) !== actor.id
  ) {
    throw new AppError('Booking not found', 404);
  }

  if (booking.status === 'ACCEPTED' && (booking.isTrialLesson || PAID_STATUSES.has(booking.payment?.status))) {
    return { tutorProfile, alreadyAccepted: true };
  }
  if (booking.status !== 'PENDING') throw new AppError('Booking is not pending', 400);
  if (booking.version !== expectedVersion) {
    throw bookingChangedError(
      booking.id,
      'The booking changed before it could be accepted. Refresh to see the latest request.'
    );
  }
  return { tutorProfile, alreadyAccepted: false };
};

const assertValidPrice = (booking) => {
  const payment = booking?.payment;
  const bookingAmount = toMoney(booking?.totalAmount);
  const paymentAmount = toMoney(payment?.amount);
  const bookingCurrency = String(booking?.currency || '').toUpperCase();
  const paymentCurrency = String(payment?.currency || '').toUpperCase();
  if (
    !payment ||
    !Number.isFinite(bookingAmount) ||
    bookingAmount <= 0 ||
    paymentAmount !== bookingAmount ||
    !bookingCurrency ||
    paymentCurrency !== bookingCurrency ||
    !SUPPORTED_CURRENCIES.has(bookingCurrency)
  ) {
    throw paymentError(
      'The booking price or currency is invalid. Refresh the request before accepting it.',
      422,
      'INVALID_BOOKING_PRICE',
      booking?.id
    );
  }
};

const getEffectivePaymentDetails = (booking) => ({
  stripeCustomerId: booking?.payment?.stripeCustomerId || booking?.learner?.stripeCustomerId || null,
  stripePaymentMethodId:
    booking?.payment?.stripePaymentMethodId ||
    booking?.learner?.stripeDefaultPaymentMethodId ||
    null,
});

const promptLearnerForPaymentMethod = async (booking, message, database = prisma) => {
  await notifyOrRefresh(
    booking.learnerId,
    'payment',
    'Payment Method Required',
    message,
    paymentMethodLink(booking.id),
    database
  );
};

const failCurrentAttempt = async (
  database,
  payment,
  { reason, providerCode = null, completedAt = new Date() }
) => {
  if (!payment?.id || Number(payment.acceptanceAttemptCount || 0) < 1) return;
  await database.paymentAttempt.updateMany({
    where: {
      paymentId: payment.id,
      sequence: Number(payment.acceptanceAttemptCount),
      outcome: 'PROCESSING',
    },
    data: {
      outcome: 'FAILED',
      providerCode,
      safeFailureReason: reason,
      completedAt,
    },
  });
};

const throwPaymentMethodRequired = async (booking, message, markFailed = false) => {
  const prompt =
    message ||
    'Please add or replace your saved payment method before retrying this payment.';
  if (markFailed && booking.payment?.id) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking.tutorId}))`;
      const updated = await tx.payment.updateMany({
        where: { id: booking.payment.id, status: { in: ['PENDING', 'PROCESSING', 'FAILED'] } },
        data: {
          status: 'FAILED',
          processedAt: new Date(),
          failedAt: new Date(),
          failureReason: prompt,
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
          paidAt: null,
        },
      });
      if (updated.count) {
        await failCurrentAttempt(tx, booking.payment, {
          reason: prompt,
          providerCode: 'payment_method_not_available',
        });
        await promptLearnerForPaymentMethod(booking, prompt, tx);
      }
    });
  } else {
    await promptLearnerForPaymentMethod(booking, prompt);
  }
  throw paymentError(prompt, 402, 'PAYMENT_METHOD_REQUIRED', booking.id, true);
};

const validateSavedPaymentMethod = async (booking) => {
  const details = getEffectivePaymentDetails(booking);
  if (!details.stripeCustomerId || !details.stripePaymentMethodId) {
    await throwPaymentMethodRequired(booking);
  }
  if (!booking.learner?.stripeCustomerId || details.stripeCustomerId !== booking.learner.stripeCustomerId) {
    await throwPaymentMethodRequired(
      booking,
      'The saved payment method is no longer usable. Please add or select another method.',
      true
    );
  }
  if (!isStripeConfigured() || !isWebhookConfigured()) throw providerUnavailableError(booking.id);

  const stripe = getStripe();
  let paymentMethod;
  try {
    paymentMethod = await stripe.paymentMethods.retrieve(details.stripePaymentMethodId);
  } catch (error) {
    if (
      error?.type === 'StripeInvalidRequestError' ||
      error?.code === 'resource_missing' ||
      error?.statusCode === 404
    ) {
      await throwPaymentMethodRequired(
        booking,
        'The saved payment method is no longer usable. Please add or select another method.',
        true
      );
    }
    throw providerUnavailableError(booking.id);
  }
  if (getStripeObjectId(paymentMethod?.customer) !== details.stripeCustomerId) {
    await throwPaymentMethodRequired(
      booking,
      'The saved payment method is no longer usable. Please add or select another method.',
      true
    );
  }
  return { stripe, ...details };
};

const acceptedNotificationData = (booking, mode) => {
  const learnerMessage = booking.isTrialLesson
    ? 'Your free trial lesson request has been accepted.'
    : 'Your lesson request has been accepted and payment has been confirmed.';
  const tutorMessage = booking.isTrialLesson
    ? 'You accepted this free trial lesson request.'
    : mode === ACCEPTANCE_MODES.LEARNER_TUTOR_TIME
      ? 'The learner accepted your proposed time and payment was confirmed.'
      : 'You accepted this lesson request and its payment was confirmed.';
  return [
    {
      userId: booking.learnerId,
      type: 'booking',
      title: 'Booking Accepted',
      message: learnerMessage,
      read: false,
      timestamp: new Date(),
      link: `/bookings/${booking.id}`,
    },
    {
      userId: booking.tutorProfile.userId,
      type: 'booking',
      title: 'Booking Accepted',
      message: tutorMessage,
      read: false,
      timestamp: new Date(),
      link: `/bookings/${booking.id}`,
    },
  ];
};

const acceptanceTransitionData = (booking, mode, meetingLink) => ({
  status: 'ACCEPTED',
  version: { increment: 1 },
  negotiationStatus: 'NONE',
  ...(meetingLink ? { meetingLink } : {}),
  ...(mode === ACCEPTANCE_MODES.LEARNER_TUTOR_TIME
    ? {
        rescheduleRequests: {
          updateMany: {
            where: { status: 'PENDING', proposedBy: 'TUTOR' },
            data: {
              status: 'ACCEPTED',
              decisionReason: 'Learner accepted the tutor proposed time.',
              decidedAt: new Date(),
            },
          },
        },
      }
    : {
        rescheduleRequests: {
          updateMany: {
            where: { status: 'PENDING' },
            data: {
              status: 'ACCEPTED',
              decisionReason:
                booking.negotiationStatus === 'TIME_PROPOSED_BY_LEARNER'
                  ? 'Tutor accepted the learner proposed time.'
                  : 'Tutor accepted the booking request.',
              decidedAt: new Date(),
            },
          },
        },
      }),
});

const declineOverlappingPendingBookings = async (tx, acceptedBooking, actorId = null) => {
  const requestedStart = new Date(acceptedBooking.scheduledAt);
  const requestedEnd = new Date(
    requestedStart.getTime() + Number(acceptedBooking.duration || 0) * 60 * 1000
  );
  const lookupStart = new Date(requestedStart.getTime() - 8 * 60 * 60 * 1000);
  const candidates = await tx.booking.findMany({
    where: {
      tutorId: acceptedBooking.tutorId,
      id: { not: acceptedBooking.id },
      status: 'PENDING',
      scheduledAt: { gte: lookupStart, lt: requestedEnd },
    },
    include: { payment: true },
  });
  const reason = 'This time slot is no longer available because another learner confirmed it first.';

  for (const candidate of candidates.filter((item) => overlaps(acceptedBooking, item))) {
    if (
      candidate.payment?.status === 'PROCESSING' ||
      (candidate.payment?.status === 'FAILED' &&
        hasCurrentAcceptanceAuthorization(candidate))
    ) {
      continue;
    }
    const updated = await tx.booking.updateMany({
      where: { id: candidate.id, status: 'PENDING' },
      data: {
        status: 'DECLINED',
        version: { increment: 1 },
        negotiationStatus: 'NONE',
        declineReason: reason,
      },
    });
    if (!updated.count) continue;
    await tx.rescheduleRequest.updateMany({
      where: { bookingId: candidate.id, status: 'PENDING' },
      data: { status: 'CANCELLED', decisionReason: reason, decidedAt: new Date() },
    });
    await tx.bookingPriceOffer.updateMany({
      where: { bookingId: candidate.id, status: 'PENDING' },
      data: {
        status: 'CANCELLED',
        respondedById: actorId,
        respondedAt: new Date(),
      },
    });
    if (candidate.payment) {
      await tx.payment.updateMany({
        where: { id: candidate.payment.id, status: { in: ['PENDING', 'FAILED'] } },
        data: {
          status: 'CANCELLED',
          processedAt: new Date(),
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
          paidAt: null,
        },
      });
    }
    await tx.bookingStatusHistory.create({
      data: { bookingId: candidate.id, status: 'DECLINED', reason },
    });
    await tx.notification.create({
      data: {
        userId: candidate.learnerId,
        type: 'booking',
        title: 'Booking Declined',
        message: reason,
        read: false,
        timestamp: new Date(),
        link: `/bookings/${candidate.id}`,
      },
    });
  }
};

const claimPaymentForAcceptance = async ({
  booking,
  expectedVersion,
  actor,
  mode,
  paymentDetails,
  meetingLink,
}) =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking.tutorId}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking.learnerId}))`;
    const latest = await tx.booking.findUnique({
      where: { id: booking.id },
      include: acceptanceBookingInclude,
    });
    if (!latest) throw new AppError('Booking not found', 404);
    const transition = await assertActorAndTransition(
      latest,
      actor,
      mode,
      expectedVersion,
      tx
    );
    if (transition.alreadyAccepted) {
      return { outcome: 'ACCEPTED', booking: latest, claimed: false };
    }
    await assertNoPendingPriceOffer(latest, tx);
    assertValidPrice(latest);
    await assertTimeStillValid(tx, latest, mode);

    if (latest.payment.status === 'PROCESSING') {
      return { outcome: 'PAYMENT_PROCESSING', booking: latest, claimed: false };
    }
    if (latest.payment.status === 'FAILED') {
      throw paymentError(
        latest.payment.failureReason ||
          'The learner must replace their payment method before this request can be accepted.',
        402,
        'PAYMENT_FAILED',
        latest.id,
        true
      );
    }
    if (latest.payment.status !== 'PENDING') {
      throw new AppError('This booking payment can no longer be processed', 409);
    }

    const currentDetails = getEffectivePaymentDetails(latest);
    if (
      currentDetails.stripeCustomerId !== paymentDetails.stripeCustomerId ||
      currentDetails.stripePaymentMethodId !== paymentDetails.stripePaymentMethodId
    ) {
      throw bookingChangedError(
        latest.id,
        'The learner changed the saved payment method. Retry acceptance using the latest method.'
      );
    }

    const stripeIdempotencyKey =
      latest.payment.stripeIdempotencyKey || `pay03_accept_${latest.payment.id}`;
    const processingStartedAt = new Date();
    const attemptSequence = Number(latest.payment.acceptanceAttemptCount || 0) + 1;
    const claimed = await tx.payment.updateMany({
      where: { id: latest.payment.id, status: 'PENDING' },
      data: {
        status: 'PROCESSING',
        stripeCustomerId: paymentDetails.stripeCustomerId,
        stripePaymentMethodId: paymentDetails.stripePaymentMethodId,
        stripeIdempotencyKey,
        acceptanceAttemptCount: { increment: 1 },
        acceptanceMode: mode,
        acceptanceAuthorizedById: actor.id,
        acceptanceAuthorizedAt: processingStartedAt,
        acceptanceBookingVersion: latest.version,
        acceptanceMeetingLink: meetingLink || null,
        processingStartedAt,
        processedAt: null,
        failedAt: null,
        failureReason: null,
        platformFeePercent: null,
        platformFeeAmount: null,
        tutorPayoutAmount: null,
        payoutStatus: null,
        payoutPendingAt: null,
        payoutEligibleAt: null,
        payoutAt: null,
        payoutFailedAt: null,
        payoutFailureReason: null,
      },
    });
    if (!claimed.count) {
      const current = await tx.booking.findUnique({
        where: { id: latest.id },
        include: acceptanceBookingInclude,
      });
      return {
        outcome:
          current?.status === 'ACCEPTED' && PAID_STATUSES.has(current.payment?.status)
            ? 'ACCEPTED'
            : 'PAYMENT_PROCESSING',
        booking: current || latest,
        claimed: false,
      };
    }

    const attempt = await tx.paymentAttempt.create({
      data: {
        paymentId: latest.payment.id,
        sequence: attemptSequence,
        source: 'ACCEPTANCE',
        outcome: 'PROCESSING',
        initiatedByUserId: actor.id,
        initiatedByRole: actor.role,
        bookingVersion: latest.version,
        acceptanceMode: mode,
        startedAt: processingStartedAt,
      },
    });

    return {
      outcome: 'PAYMENT_PROCESSING',
      claimed: true,
      booking: {
        ...latest,
        payment: {
          ...latest.payment,
          status: 'PROCESSING',
          stripeCustomerId: paymentDetails.stripeCustomerId,
          stripePaymentMethodId: paymentDetails.stripePaymentMethodId,
          stripeIdempotencyKey,
          acceptanceAttemptCount: attemptSequence,
          acceptanceMode: mode,
          acceptanceAuthorizedById: actor.id,
          acceptanceAuthorizedAt: processingStartedAt,
          acceptanceBookingVersion: latest.version,
          acceptanceMeetingLink: meetingLink || null,
          processingStartedAt,
          attempts: [attempt, ...(latest.payment.attempts || [])],
        },
      },
    };
  });

const claimPaymentForRetry = async ({ booking, expectedVersion, actor }) =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking.tutorId}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking.learnerId}))`;
    const latest = await tx.booking.findUnique({
      where: { id: booking.id },
      include: acceptanceBookingInclude,
    });
    if (!latest || actor?.role !== 'LEARNER' || latest.learnerId !== actor.id) {
      throw new AppError('Booking not found', 404);
    }
    if (
      latest.status === 'ACCEPTED' &&
      PAID_STATUSES.has(latest.payment?.status)
    ) {
      return { outcome: 'ACCEPTED', booking: latest, claimed: false };
    }
    if (latest.isTrialLesson || !latest.payment) {
      throw new AppError('This booking does not have a recoverable payment', 409);
    }
    if (latest.status !== 'PENDING') {
      throw bookingChangedError(
        latest.id,
        'This booking is no longer pending and cannot be retried.'
      );
    }
    if (latest.version !== expectedVersion) {
      throw bookingChangedError(
        latest.id,
        'The booking changed before payment could be retried. Refresh and review it.'
      );
    }
    if (latest.payment.status === 'PROCESSING') {
      return { outcome: 'PAYMENT_PROCESSING', booking: latest, claimed: false };
    }
    if (latest.payment.status !== 'FAILED') {
      throw new AppError('This booking payment is not ready to retry', 409, {
        code: 'PAYMENT_NOT_RETRYABLE',
      });
    }
    if (
      !Object.values(ACCEPTANCE_MODES).includes(latest.payment.acceptanceMode) ||
      !hasCurrentAcceptanceAuthorization(latest)
    ) {
      throw bookingChangedError(
        latest.id,
        'The booking changed after the failed payment. The tutor must accept the updated request.'
      );
    }

    await assertNoPendingPriceOffer(latest, tx);
    assertValidPrice(latest);
    try {
      await assertTimeStillValid(tx, latest, latest.payment.acceptanceMode, {
        requireCurrentAvailability: true,
      });
    } catch (error) {
      if ([400, 409].includes(Number(error?.statusCode))) {
        throw slotUnavailableError(latest.id);
      }
      throw error;
    }

    const paymentDetails = getEffectivePaymentDetails(latest);
    if (
      !paymentDetails.stripeCustomerId ||
      !paymentDetails.stripePaymentMethodId ||
      !latest.learner?.stripeCustomerId ||
      paymentDetails.stripeCustomerId !== latest.learner.stripeCustomerId
    ) {
      throw paymentError(
        'Please add or choose a usable payment method before retrying.',
        402,
        'PAYMENT_METHOD_REQUIRED',
        latest.id,
        true
      );
    }

    const processingStartedAt = new Date();
    const attemptSequence = Number(latest.payment.acceptanceAttemptCount || 0) + 1;
    const claimed = await tx.payment.updateMany({
      where: { id: latest.payment.id, status: 'FAILED' },
      data: {
        status: 'PROCESSING',
        stripeCustomerId: paymentDetails.stripeCustomerId,
        stripePaymentMethodId: paymentDetails.stripePaymentMethodId,
        acceptanceAttemptCount: { increment: 1 },
        processingStartedAt,
        processedAt: null,
        failedAt: null,
        failureReason: null,
        platformFeePercent: null,
        platformFeeAmount: null,
        tutorPayoutAmount: null,
        payoutStatus: null,
        payoutPendingAt: null,
        payoutEligibleAt: null,
        payoutAt: null,
        payoutFailedAt: null,
        payoutFailureReason: null,
        paidAt: null,
      },
    });
    if (!claimed.count) {
      const current = await tx.booking.findUnique({
        where: { id: latest.id },
        include: acceptanceBookingInclude,
      });
      return {
        outcome:
          current?.status === 'ACCEPTED' && PAID_STATUSES.has(current.payment?.status)
            ? 'ACCEPTED'
            : 'PAYMENT_PROCESSING',
        booking: current || latest,
        claimed: false,
      };
    }

    const attempt = await tx.paymentAttempt.create({
      data: {
        paymentId: latest.payment.id,
        sequence: attemptSequence,
        source: 'RETRY',
        outcome: 'PROCESSING',
        initiatedByUserId: actor.id,
        initiatedByRole: actor.role,
        bookingVersion: latest.version,
        acceptanceMode: latest.payment.acceptanceMode,
        startedAt: processingStartedAt,
      },
    });

    return {
      outcome: 'PAYMENT_PROCESSING',
      claimed: true,
      booking: {
        ...latest,
        payment: {
          ...latest.payment,
          status: 'PROCESSING',
          stripeCustomerId: paymentDetails.stripeCustomerId,
          stripePaymentMethodId: paymentDetails.stripePaymentMethodId,
          acceptanceAttemptCount: attemptSequence,
          processingStartedAt,
          processedAt: null,
          failedAt: null,
          failureReason: null,
          attempts: [attempt, ...(latest.payment.attempts || [])],
        },
      },
    };
  });

const buildIntentMetadata = (booking, mode, meetingLink, existing = {}) => ({
  ...existing,
  bookingId: booking.id,
  paymentId: booking.payment.id,
  learnerId: booking.learnerId,
  acceptanceAttempt: String(booking.payment.acceptanceAttemptCount),
  paymentAttemptId: booking.payment.attempts?.[0]?.id || existing.paymentAttemptId || '',
  acceptanceMode: mode,
  expectedVersion: String(booking.version),
  meetingLink: meetingLink || existing.meetingLink || '',
});

const paymentWithBooking = (booking) => ({
  ...booking.payment,
  bookingId: booking.payment.bookingId || booking.id,
  booking,
});

const validateIntentAgainstPayment = (paymentIntent, payment) => {
  if (!paymentIntent || !payment?.booking) return false;
  const metadata = paymentIntent.metadata || {};
  const mode = metadata.acceptanceMode;
  const attempt = Number(metadata.acceptanceAttempt);
  const ledgerAttempt = metadata.paymentAttemptId
    ? payment.attempts?.find((item) => item.id === metadata.paymentAttemptId)
    : null;
  return Boolean(
    paymentIntent.id &&
      Number(payment.acceptanceAttemptCount || 0) > 0 &&
      Number.isInteger(attempt) &&
      attempt > 0 &&
      attempt <= Number(payment.acceptanceAttemptCount || 0) &&
      (!metadata.paymentAttemptId ||
        (ledgerAttempt && Number(ledgerAttempt.sequence) === attempt)) &&
      Object.values(ACCEPTANCE_MODES).includes(mode) &&
      (!payment.stripePaymentIntentId || payment.stripePaymentIntentId === paymentIntent.id) &&
      metadata.bookingId === payment.bookingId &&
      metadata.paymentId === payment.id &&
      metadata.learnerId === payment.userId &&
      getStripeObjectId(paymentIntent.customer) === payment.stripeCustomerId &&
      Number(paymentIntent.amount) === toMinorUnits(payment.amount) &&
      String(paymentIntent.currency || '').toUpperCase() ===
        String(payment.currency || payment.booking.currency || '').toUpperCase()
  );
};

const isCurrentPaymentAttempt = (paymentIntent, payment) =>
  Number(paymentIntent?.metadata?.acceptanceAttempt) ===
    Number(payment?.acceptanceAttemptCount || 0) &&
  (!paymentIntent?.metadata?.paymentAttemptId ||
    payment.attempts?.some(
      (attempt) =>
        attempt.id === paymentIntent.metadata.paymentAttemptId &&
        Number(attempt.sequence) === Number(payment.acceptanceAttemptCount || 0)
    ));

const createWebhookReceipt = async (tx, event) => {
  if (!event?.id) return;
  await tx.stripeWebhookEvent.create({
    data: {
      eventId: event.id,
      type: event.type,
      objectId: getStripeObjectId(event.data?.object),
      processedAt: new Date(),
    },
  });
};

const recordWebhookEvent = async (event) => {
  if (!event?.id) return { outcome: 'IGNORED' };
  try {
    await prisma.$transaction((tx) => createWebhookReceipt(tx, event));
    return { outcome: 'RECORDED' };
  } catch (error) {
    if (error?.code === 'P2002') return { outcome: 'DUPLICATE_EVENT' };
    throw error;
  }
};

const assertFinalTransition = async (booking, mode, database = prisma) => {
  await assertNoPendingPriceOffer(booking, database);
  if (mode === ACCEPTANCE_MODES.TUTOR) {
    if (booking.negotiationStatus === 'TIME_PROPOSED_BY_TUTOR') {
      throw bookingChangedError(booking.id, 'The learner has not accepted the tutor proposed time.');
    }
    return;
  }
  const hasTutorProposal = booking.rescheduleRequests?.some(
    (proposal) => proposal.status === 'PENDING' && proposal.proposedBy === 'TUTOR'
  );
  if (booking.negotiationStatus !== 'TIME_PROPOSED_BY_TUTOR' || !hasTutorProposal) {
    throw bookingChangedError(booking.id, 'The tutor time proposal is no longer pending.');
  }
};

const finalizeSuccessfulPaymentIntent = async (paymentIntent, options = {}) => {
  const paymentId = options.paymentId || paymentIntent?.metadata?.paymentId;
  if (!paymentId || paymentIntent?.status !== 'succeeded') {
    if (options.webhookEvent) await recordWebhookEvent(options.webhookEvent);
    return { outcome: 'IGNORED', newlyAccepted: false };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      await createWebhookReceipt(tx, options.webhookEvent);
      let payment = await tx.payment.findUnique({
        where: { id: paymentId },
        include: {
          attempts: { orderBy: { sequence: 'desc' } },
          booking: { include: acceptanceBookingInclude },
        },
      });
      if (!payment?.booking || !validateIntentAgainstPayment(paymentIntent, payment)) {
        return { outcome: 'IGNORED', newlyAccepted: false };
      }
      if (!isCurrentPaymentAttempt(paymentIntent, payment)) {
        return { outcome: 'IGNORED', newlyAccepted: false };
      }

      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${payment.booking.tutorId}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${payment.booking.learnerId}))`;
      payment = await tx.payment.findUnique({
        where: { id: paymentId },
        include: {
          attempts: { orderBy: { sequence: 'desc' } },
          booking: { include: acceptanceBookingInclude },
        },
      });
      if (!payment?.booking || !validateIntentAgainstPayment(paymentIntent, payment)) {
        return { outcome: 'IGNORED', newlyAccepted: false };
      }
      if (!isCurrentPaymentAttempt(paymentIntent, payment)) {
        return { outcome: 'IGNORED', newlyAccepted: false };
      }

      const booking = payment.booking;
      if (payment.status === 'PAID' && booking.status === 'ACCEPTED') {
        return { outcome: 'ACCEPTED', newlyAccepted: false, booking };
      }
      if (TERMINAL_BOOKING_STATUSES.has(booking.status) || booking.status !== 'PENDING') {
        return { outcome: 'IGNORED', newlyAccepted: false, booking };
      }

      const mode = paymentIntent.metadata.acceptanceMode;
      await assertFinalTransition(booking, mode, tx);
      await assertTimeStillValid(tx, booking, mode);

      const earning = calculateEarning({
        amount: payment.amount,
        commissionPercent: DEFAULT_PLATFORM_FEE_PERCENT,
      });
      const processedAt = new Date();
      const paymentUpdate = await tx.payment.updateMany({
        where: { id: payment.id, status: { in: ['PENDING', 'PROCESSING', 'FAILED'] } },
        data: {
          status: 'PAID',
          stripePaymentIntentId: paymentIntent.id,
          processedAt,
          paidAt: processedAt,
          failedAt: null,
          failureReason: null,
          processingStartedAt: null,
          platformFeePercent: earning.commissionPercent,
          platformFeeAmount: earning.commissionAmount,
          tutorPayoutAmount: earning.netAmount,
          payoutStatus: 'PENDING',
          payoutPendingAt: processedAt,
          payoutEligibleAt: null,
          payoutAt: null,
          payoutFailedAt: null,
          payoutFailureReason: null,
        },
      });
      if (!paymentUpdate.count) {
        return { outcome: 'IGNORED', newlyAccepted: false, booking };
      }
      const attemptWhere = paymentIntent.metadata?.paymentAttemptId
        ? { id: paymentIntent.metadata.paymentAttemptId, paymentId: payment.id }
        : {
            paymentId: payment.id,
            sequence: Number(paymentIntent.metadata?.acceptanceAttempt),
          };
      await tx.paymentAttempt.updateMany({
        where: { ...attemptWhere, outcome: 'PROCESSING' },
        data: {
          outcome: 'SUCCEEDED',
          providerCode: null,
          safeFailureReason: null,
          completedAt: processedAt,
        },
      });

      const meetingLink = options.meetingLink || paymentIntent.metadata?.meetingLink || undefined;
      const bookingUpdate = await tx.booking.updateMany({
        where: { id: booking.id, status: 'PENDING' },
        data: {
          status: 'ACCEPTED',
          version: { increment: 1 },
          negotiationStatus: 'NONE',
          ...(meetingLink ? { meetingLink } : {}),
        },
      });
      if (!bookingUpdate.count) {
        throw bookingChangedError(booking.id, 'Booking changed before payment could be finalized.');
      }

      if (mode === ACCEPTANCE_MODES.LEARNER_TUTOR_TIME) {
        await tx.rescheduleRequest.updateMany({
          where: { bookingId: booking.id, status: 'PENDING', proposedBy: 'TUTOR' },
          data: {
            status: 'ACCEPTED',
            decisionReason: 'Learner accepted the tutor proposed time.',
            decidedAt: new Date(),
          },
        });
      } else {
        await tx.rescheduleRequest.updateMany({
          where: { bookingId: booking.id, status: 'PENDING' },
          data: {
            status: 'ACCEPTED',
            decisionReason:
              booking.negotiationStatus === 'TIME_PROPOSED_BY_LEARNER'
                ? 'Tutor accepted the learner proposed time.'
                : 'Tutor accepted the booking request.',
            decidedAt: new Date(),
          },
        });
      }
      await tx.bookingStatusHistory.create({
        data: {
          bookingId: booking.id,
          status: 'ACCEPTED',
          reason:
            mode === ACCEPTANCE_MODES.LEARNER_TUTOR_TIME
              ? 'Learner accepted the tutor proposed time.'
              : null,
        },
      });
      await tx.notification.createMany({ data: acceptedNotificationData(booking, mode) });
      await declineOverlappingPendingBookings(
        tx,
        { ...booking, status: 'ACCEPTED', version: booking.version + 1 },
        booking.tutorProfile.userId
      );

      return {
        outcome: 'ACCEPTED',
        newlyAccepted: true,
        booking: { ...booking, status: 'ACCEPTED', version: booking.version + 1 },
      };
    });
  } catch (error) {
    if (options.webhookEvent && error?.code === 'P2002') {
      return { outcome: 'DUPLICATE_EVENT', newlyAccepted: false };
    }
    throw error;
  }
};

const finalizeFailedPaymentIntent = async (paymentIntent, _failureReason, options = {}) => {
  const paymentId = options.paymentId || paymentIntent?.metadata?.paymentId;
  const safeFailure =
    options.safeFailure || getSafePaymentFailure(options.providerError, paymentIntent);
  const message = safeFailure.reason;
  if (!paymentId) {
    if (options.webhookEvent) await recordWebhookEvent(options.webhookEvent);
    return { outcome: 'IGNORED' };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      await createWebhookReceipt(tx, options.webhookEvent);
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
        include: {
          attempts: { orderBy: { sequence: 'desc' } },
          booking: true,
        },
      });
      if (!payment?.booking) return { outcome: 'IGNORED' };
      if (!options.skipProviderValidation && !validateIntentAgainstPayment(paymentIntent, payment)) {
        return { outcome: 'IGNORED' };
      }
      if (options.webhookEvent && !isCurrentPaymentAttempt(paymentIntent, payment)) {
        return { outcome: 'IGNORED' };
      }
      if (payment.status === 'PAID' || payment.booking.status === 'ACCEPTED') {
        return { outcome: 'ACCEPTED' };
      }

      const updated = await tx.payment.updateMany({
        where: { id: payment.id, status: 'PROCESSING' },
        data: {
          status: 'FAILED',
          stripePaymentIntentId: paymentIntent?.id || payment.stripePaymentIntentId,
          processedAt: new Date(),
          failedAt: new Date(),
          failureReason: message,
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
          paidAt: null,
        },
      });
      if (updated.count) {
        const attemptWhere = paymentIntent?.metadata?.paymentAttemptId
          ? { id: paymentIntent.metadata.paymentAttemptId, paymentId: payment.id }
          : {
              paymentId: payment.id,
              sequence: Number(
                paymentIntent?.metadata?.acceptanceAttempt ||
                  payment.acceptanceAttemptCount
              ),
            };
        await tx.paymentAttempt.updateMany({
          where: { ...attemptWhere, outcome: 'PROCESSING' },
          data: {
            outcome: 'FAILED',
            providerCode: safeFailure.providerCode,
            safeFailureReason: message,
            completedAt: new Date(),
          },
        });
        await promptLearnerForPaymentMethod(payment.booking, message, tx);
      }
      return { outcome: updated.count ? 'PAYMENT_FAILED' : 'IGNORED' };
    });
  } catch (error) {
    if (options.webhookEvent && error?.code === 'P2002') {
      return { outcome: 'DUPLICATE_EVENT' };
    }
    throw error;
  }
};

const persistIntentReference = async (paymentId, paymentIntent) => {
  if (!paymentIntent?.id) return;
  await prisma.payment.updateMany({
    where: { id: paymentId, status: 'PROCESSING' },
    data: { stripePaymentIntentId: paymentIntent.id },
  });
};

const clearInvalidIntentReference = async (booking, intentId) => {
  const cleared = await prisma.payment.updateMany({
    where: { id: booking.payment.id, status: 'PROCESSING', stripePaymentIntentId: intentId },
    data: { stripePaymentIntentId: null },
  });
  if (!cleared.count) throw bookingChangedError(booking.id);
  booking.payment.stripePaymentIntentId = null;
};

const confirmPaymentIntentForAttempt = async ({ stripe, booking, mode, meetingLink }) => {
  const metadata = buildIntentMetadata(
    booking,
    mode,
    meetingLink,
    booking.payment.intentMetadata || {}
  );
  await stripe.paymentIntents.update(
    booking.payment.stripePaymentIntentId,
    { metadata },
    {
      idempotencyKey: `${booking.payment.stripeIdempotencyKey}:metadata:${booking.payment.acceptanceAttemptCount}`,
    }
  );
  return stripe.paymentIntents.confirm(
    booking.payment.stripePaymentIntentId,
    {
      payment_method: booking.payment.stripePaymentMethodId,
      payment_method_types: ['card'],
      off_session: true,
      error_on_requires_action: true,
    },
    {
      idempotencyKey: `${booking.payment.stripeIdempotencyKey}:confirm:${booking.payment.acceptanceAttemptCount}`,
    }
  );
};

const createOrConfirmPaymentIntent = async ({ stripe, booking, mode, meetingLink }) => {
  const payment = booking.payment;
  const createIntent = () =>
    stripe.paymentIntents.create(
      {
        amount: toMinorUnits(payment.amount),
        currency: String(payment.currency).toLowerCase(),
        customer: payment.stripeCustomerId,
        payment_method: payment.stripePaymentMethodId,
        payment_method_types: ['card'],
        confirm: true,
        off_session: true,
        error_on_requires_action: true,
        metadata: buildIntentMetadata(booking, mode, meetingLink),
      },
      {
        idempotencyKey: `${payment.stripeIdempotencyKey}:create:${payment.acceptanceAttemptCount}`,
      }
    );

  if (!payment.stripePaymentIntentId) return createIntent();

  let existingIntent;
  try {
    existingIntent = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId);
  } catch (error) {
    if (error?.code !== 'resource_missing' && error?.statusCode !== 404) throw error;
    await clearInvalidIntentReference(booking, payment.stripePaymentIntentId);
    return createIntent();
  }

  if (!validateIntentAgainstPayment(existingIntent, paymentWithBooking(booking))) {
    if (['succeeded', 'processing', 'requires_capture'].includes(existingIntent?.status)) {
      throw providerUnavailableError(booking.id);
    }
    await clearInvalidIntentReference(booking, payment.stripePaymentIntentId);
    return createIntent();
  }
  if (['succeeded', 'processing', 'requires_capture'].includes(existingIntent.status)) {
    return existingIntent;
  }
  if (existingIntent.status === 'canceled') {
    await clearInvalidIntentReference(booking, payment.stripePaymentIntentId);
    return createIntent();
  }

  booking.payment.intentMetadata = existingIntent.metadata || {};
  return confirmPaymentIntentForAttempt({ stripe, booking, mode, meetingLink });
};

const isDefinitePaymentFailure = (error, paymentIntent) =>
  Boolean(
    ['requires_payment_method', 'requires_action', 'canceled'].includes(paymentIntent?.status) ||
      error?.type === 'StripeCardError' ||
      [
        'authentication_required',
        'card_declined',
        'expired_card',
        'incorrect_cvc',
        'payment_intent_authentication_failure',
        'payment_method_customer_mismatch',
        'payment_method_not_available',
        'payment_method_provider_decline',
        'payment_method_unexpected_state',
        'payment_method_unactivated',
        'resource_missing',
      ].includes(error?.code)
  );

const isProviderUnavailableError = (error) =>
  [
    'StripeAPIError',
    'StripeAuthenticationError',
    'StripePermissionError',
    'StripeInvalidRequestError',
    'StripeRateLimitError',
  ].includes(error?.type) ||
  [401, 403, 429, 500, 502, 503, 504].includes(Number(error?.statusCode));

const isDefinitelyUnsubmittedProviderError = (error, paymentIntent) =>
  !paymentIntent &&
  ['StripeAuthenticationError', 'StripePermissionError', 'StripeInvalidRequestError'].includes(
    error?.type
  );

const releaseUnsubmittedClaim = async (booking) => {
  const reason = 'Payment processing is temporarily unavailable. Please try again later.';
  await prisma.$transaction(async (tx) => {
    const released = await tx.payment.updateMany({
      where: {
        id: booking.payment.id,
        status: 'PROCESSING',
        acceptanceAttemptCount: booking.payment.acceptanceAttemptCount,
      },
      data: {
        status: 'FAILED',
        processedAt: new Date(),
        failedAt: new Date(),
        failureReason: reason,
        processingStartedAt: null,
      },
    });
    if (released.count) {
      await failCurrentAttempt(tx, booking.payment, {
        reason,
        providerCode: 'provider_unavailable',
      });
    }
  });
};

const processProviderResult = async ({ booking, paymentIntent, mode, meetingLink }) => {
  if (paymentIntent.status === 'succeeded') {
    const finalized = await finalizeSuccessfulPaymentIntent(paymentIntent, {
      paymentId: booking.payment.id,
      meetingLink,
    });
    return finalized.outcome === 'ACCEPTED'
      ? finalized
      : { outcome: 'PAYMENT_PROCESSING', newlyAccepted: false, booking };
  }
  if (['requires_payment_method', 'requires_action', 'canceled'].includes(paymentIntent.status)) {
    const safeFailure = getSafePaymentFailure(null, paymentIntent);
    await finalizeFailedPaymentIntent(paymentIntent, null, {
      paymentId: booking.payment.id,
      skipProviderValidation: true,
      safeFailure,
    });
    throw paymentError(safeFailure.reason, 402, 'PAYMENT_FAILED', booking.id, true);
  }
  return { outcome: 'PAYMENT_PROCESSING', newlyAccepted: false, booking };
};

const runProviderAttempt = async ({ booking, stripe, mode, meetingLink }) => {
  let paymentIntent;
  try {
    paymentIntent = await createOrConfirmPaymentIntent({ stripe, booking, mode, meetingLink });
    await persistIntentReference(booking.payment.id, paymentIntent);
  } catch (error) {
    if (error?.isOperational) throw error;
    paymentIntent = error?.raw?.payment_intent || error?.payment_intent || null;
    await persistIntentReference(booking.payment.id, paymentIntent);
    if (isDefinitePaymentFailure(error, paymentIntent)) {
      const safeFailure = getSafePaymentFailure(error, paymentIntent);
      await finalizeFailedPaymentIntent(paymentIntent, null, {
        paymentId: booking.payment.id,
        skipProviderValidation: true,
        providerError: error,
        safeFailure,
      });
      throw paymentError(safeFailure.reason, 402, 'PAYMENT_FAILED', booking.id, true);
    }
    if (isDefinitelyUnsubmittedProviderError(error, paymentIntent)) {
      await releaseUnsubmittedClaim(booking);
    }
    if (isProviderUnavailableError(error)) throw providerUnavailableError(booking.id);
    return { outcome: 'PAYMENT_PROCESSING', newlyAccepted: false, booking };
  }
  return processProviderResult({ booking, paymentIntent, mode, meetingLink });
};

const reconcileProcessingPayment = async ({ booking, mode, meetingLink }) => {
  if (!isStripeConfigured() || !isWebhookConfigured()) throw providerUnavailableError(booking.id);
  if (
    Number(booking.payment?.acceptanceAttemptCount || 0) < 1 ||
    !booking.payment?.stripeCustomerId ||
    !booking.payment?.stripePaymentMethodId ||
    !booking.payment?.stripeIdempotencyKey
  ) {
    throw providerUnavailableError(booking.id);
  }
  return runProviderAttempt({ booking, stripe: getStripe(), mode, meetingLink });
};

const acceptTrialBooking = async ({ booking, expectedVersion, actor, mode, meetingLink }) =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking.tutorId}))`;
    const latest = await tx.booking.findUnique({
      where: { id: booking.id },
      include: acceptanceBookingInclude,
    });
    if (!latest) throw new AppError('Booking not found', 404);
    const transition = await assertActorAndTransition(
      latest,
      actor,
      mode,
      expectedVersion,
      tx
    );
    if (transition.alreadyAccepted) {
      return { outcome: 'ACCEPTED', newlyAccepted: false, booking: latest };
    }
    await assertNoPendingPriceOffer(latest, tx);
    if (latest.payment) {
      throw paymentError(
        'Free trial bookings cannot have a payment record.',
        422,
        'INVALID_BOOKING_PRICE',
        latest.id
      );
    }
    if (toMoney(latest.totalAmount) !== 0) {
      throw paymentError(
        'Free trial bookings must have a zero total.',
        422,
        'INVALID_BOOKING_PRICE',
        latest.id
      );
    }
    await assertTimeStillValid(tx, latest, mode);

    const updated = await tx.booking.update({
      where: { id: latest.id, status: 'PENDING', version: expectedVersion },
      data: acceptanceTransitionData(latest, mode, meetingLink),
      include: acceptanceBookingInclude,
    });
    await tx.bookingStatusHistory.create({
      data: {
        bookingId: latest.id,
        status: 'ACCEPTED',
        reason:
          mode === ACCEPTANCE_MODES.LEARNER_TUTOR_TIME
            ? 'Learner accepted the tutor proposed time.'
            : null,
      },
    });
    await tx.notification.createMany({ data: acceptedNotificationData(latest, mode) });
    await declineOverlappingPendingBookings(tx, updated, latest.tutorProfile.userId);
    return { outcome: 'ACCEPTED', newlyAccepted: true, booking: updated };
  });

const acceptBooking = async ({ bookingId, expectedVersion, actor, meetingLink, mode }) => {
  const acceptanceMode = mode || ACCEPTANCE_MODES.TUTOR;
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: acceptanceBookingInclude,
  });
  if (!booking) throw new AppError('Booking not found', 404);
  const transition = await assertActorAndTransition(
    booking,
    actor,
    acceptanceMode,
    expectedVersion
  );
  if (transition.alreadyAccepted) {
    return { outcome: 'ACCEPTED', newlyAccepted: false, booking };
  }
  await assertNoPendingPriceOffer(booking);
  if (booking.isTrialLesson) {
    return acceptTrialBooking({
      booking,
      expectedVersion,
      actor,
      mode: acceptanceMode,
      meetingLink,
    });
  }

  assertValidPrice(booking);
  assertMatchingPaymentEnvironment(booking.payment);
  if (booking.payment.status === 'PROCESSING') {
    return reconcileProcessingPayment({ booking, mode: acceptanceMode, meetingLink });
  }
  if (booking.payment.status === 'FAILED') {
    throw paymentError(
      booking.payment.failureReason ||
        'The learner must replace their payment method before this request can be accepted.',
      402,
      'PAYMENT_FAILED',
      booking.id,
      true
    );
  }

  // A brand new charge is about to be claimed. Sitting here rather than earlier
  // means free trials, an in-flight PROCESSING charge and a FAILED payment all
  // keep their existing behaviour, and a blocked acceptance still takes no lock
  // and claims no payment.
  await assertTutorPayoutReady(booking, actor);

  const paymentDetails = await validateSavedPaymentMethod(booking);
  const claim = await claimPaymentForAcceptance({
    booking,
    expectedVersion,
    actor,
    mode: acceptanceMode,
    paymentDetails,
    meetingLink,
  });
  if (!claim.claimed) {
    if (claim.outcome === 'ACCEPTED') return claim;
    return reconcileProcessingPayment({
      booking: claim.booking,
      mode: acceptanceMode,
      meetingLink,
    });
  }
  return runProviderAttempt({
    booking: claim.booking,
    stripe: paymentDetails.stripe,
    mode: acceptanceMode,
    meetingLink,
  });
};

const retryFailedPayment = async ({ bookingId, expectedVersion, actor }) => {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: acceptanceBookingInclude,
  });
  if (!booking || actor?.role !== 'LEARNER' || booking.learnerId !== actor.id) {
    throw new AppError('Booking not found', 404);
  }
  if (
    booking.status === 'ACCEPTED' &&
    PAID_STATUSES.has(booking.payment?.status)
  ) {
    return { outcome: 'ACCEPTED', newlyAccepted: false, booking };
  }

  // Before the claim, so a blocked retry burns no attempt sequence and leaves
  // the payment out of PROCESSING with nothing to compensate.
  await assertTutorPayoutReady(booking, actor);

  const claim = await claimPaymentForRetry({
    booking,
    expectedVersion,
    actor,
  });
  if (!claim.claimed) return claim;

  let paymentDetails;
  try {
    paymentDetails = await validateSavedPaymentMethod(claim.booking);
  } catch (error) {
    if (error?.errorCode === 'PAYMENT_PROVIDER_UNAVAILABLE') {
      await releaseUnsubmittedClaim(claim.booking);
    }
    throw error;
  }

  return runProviderAttempt({
    booking: claim.booking,
    stripe: paymentDetails.stripe,
    mode: claim.booking.payment.acceptanceMode,
    meetingLink: claim.booking.payment.acceptanceMeetingLink || undefined,
  });
};

module.exports = {
  ACCEPTANCE_MODES,
  acceptBooking,
  retryFailedPayment,
  finalizeSuccessfulPaymentIntent,
  finalizeFailedPaymentIntent,
  createWebhookReceipt,
  recordWebhookEvent,
  serializePayment,
  paymentMethodLink,
};
