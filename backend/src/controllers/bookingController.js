const { createHash, randomUUID } = require('crypto');

const { prisma } = require('../config/database');
const { getStripe, isStripeConfigured } = require('../config/stripe');
const { assertMatchingPaymentEnvironment } = require('../config/paymentEnvironment');
const logger = require('../config/logger');
const { AppError } = require('../middleware/errorHandler');
const { notify, notifyOrRefresh, notifyAdmin } = require('../services/notificationService');
const {
  ACCEPTANCE_MODES,
  acceptBooking: acceptBookingWithPayment,
} = require('../services/paymentAcceptanceService');
const {
  validateBookingTime,
  formatLessonTimeForUser,
  getTimeInTimezone,
  normalizeTimezone,
} = require('../utils/timezone');
const { timeToMinutes, isAlignedMinutes, isValidDurationMinutes } = require('../utils/slots');
const {
  cancellationPoliciesMatch,
  getCancellationRefundPercent,
  getEffectiveCancellationPolicy,
} = require('../utils/cancellationPolicy');
const { serializePayment } = require('../utils/paymentSerialization');
const {
  DEFAULT_PLATFORM_FEE_PERCENT,
  buildEarningPreview,
  calculateEarning,
} = require('../utils/earnings');
const {
  COMPLETION_REVIEW_HOURS,
  getCompletionReviewDueAt,
  getLessonEndAt,
  promoteMatureCompletionPayouts,
} = require('../services/completionReviewService');
const {
  REFUND_SOURCES,
  createRefundClaim,
  serializeRefund,
  submitRefund,
} = require('../services/refundService');

const bookingInclude = {
  learner: {
    select: { id: true, firstName: true, lastName: true, avatar: true, email: true, timezone: true },
  },
  tutorProfile: {
    include: {
      user: { select: { id: true, firstName: true, lastName: true, avatar: true, email: true, timezone: true } },
    },
  },
  review: {
    select: {
      id: true,
      learnerId: true,
      rating: true,
      comment: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  payment: {
    include: {
      attempts: { orderBy: { sequence: 'desc' } },
      refund: true,
    },
  },
  priceOffers: { orderBy: { createdAt: 'desc' } },
  statusHistory: { orderBy: { createdAt: 'desc' } },
  rescheduleRequests: {
    orderBy: { createdAt: 'desc' },
    include: {
      learner: { select: { id: true, firstName: true, lastName: true, avatar: true, email: true, timezone: true } },
      tutor: {
        include: {
          user: { select: { id: true, firstName: true, lastName: true, avatar: true, email: true, timezone: true } },
        },
      },
      decidedBy: { select: { id: true, firstName: true, lastName: true, role: true } },
    },
  },
};

const CANCELLABLE_STATUSES = ['UNPAID', 'PENDING', 'ACCEPTED'];
const TERMINAL_BOOKING_STATUSES = ['CANCELLED', 'DECLINED', 'COMPLETED', 'NOT_COMPLETED'];
const OPEN_PAYMENT_STATUSES = ['PENDING', 'FAILED'];
const PAYABLE_PAYMENT_STATUSES = [...OPEN_PAYMENT_STATUSES, 'PROCESSING'];
const PAYMENT_PROCESSING_LEASE_MS = 2 * 60 * 1000;

const isPaidPaymentStatus = (status) =>
  ['PAID', 'COMPLETED', 'PARTIALLY_REFUNDED'].includes(String(status || '').toUpperCase());
const isPaymentProcessing = (booking) =>
  String(booking?.payment?.status || '').toUpperCase() === 'PROCESSING';
const assertPaymentNotProcessing = (
  booking,
  message = 'This booking cannot be changed while payment is processing'
) => {
  if (isPaymentProcessing(booking)) throw new AppError(message, 409);
};
const isChargePaidBooking = (booking) =>
  !booking?.isTrialLesson && isPaidPaymentStatus(booking?.payment?.status);

const serializePriceOffer = (offer) => {
  if (!offer) return offer;
  const originalTotal = Number(offer.originalTotal || 0);
  const proposedTotal = Number(offer.proposedTotal || 0);
  const difference = Math.round((proposedTotal - originalTotal + Number.EPSILON) * 100) / 100;

  return {
    ...offer,
    difference,
    direction: difference < 0 ? 'DECREASE' : difference > 0 ? 'INCREASE' : 'UNCHANGED',
  };
};

const serializeBooking = (booking, options = {}) => {
  if (!booking) return booking;

  const priceOffers = (booking.priceOffers || []).map(serializePriceOffer);

  const serialized = {
    ...booking,
    payment: serializePayment(booking.payment, options),
    priceOffers,
    activePriceOffer: priceOffers.find((offer) => offer.status === 'PENDING') || null,
    cancellationPolicy: getEffectiveCancellationPolicy(booking),
  };

  if (booking.recurringSeries?.bookings) {
    serialized.recurringSeries = {
      ...booking.recurringSeries,
      bookings: booking.recurringSeries.bookings.map((item) =>
        serializeBooking(item, options)
      ),
    };
  }

  return serialized;
};

const toMoney = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const isAdminRole = (role) => role === 'ADMIN' || role === 'SYSTEM_ADMIN';
const isFutureBooking = (booking) => new Date(booking?.scheduledAt || 0) > new Date();
const hasStarted = (booking) => new Date(booking?.scheduledAt || 0) <= new Date();
const getPendingPriceOffer = (booking) =>
  booking?.priceOffers?.find((offer) => offer.status === 'PENDING') || null;
const hasPendingSeriesPriceOffer = (booking) =>
  Boolean(
    getPendingPriceOffer(booking) ||
      booking?.seriesHasPendingPriceOffer ||
      booking?.recurringSeries?.seriesHasPendingPriceOffer ||
      booking?.recurringSeries?.bookings?.some((item) => getPendingPriceOffer(item))
  );
const hasStartedSeriesPayment = (booking) =>
  Boolean(
    booking?.seriesPriceOfferLocked ||
      booking?.recurringSeries?.seriesPriceOfferLocked
  );
const hasOpenPayment = (booking) =>
  OPEN_PAYMENT_STATUSES.includes(String(booking?.payment?.status || '').toUpperCase());
const hasPricePaymentStarted = (booking) =>
  ['ACCEPTED', 'COMPLETED'].includes(String(booking?.status || '').toUpperCase()) ||
  (
    booking?.status === 'PENDING' &&
    !booking?.isTrialLesson &&
    !hasOpenPayment(booking)
  );

const hasCurrentFailedAcceptance = (booking) =>
  Boolean(
    booking?.payment?.status === 'FAILED' &&
      booking.payment.acceptanceAuthorizedById &&
      booking.payment.acceptanceMode &&
      Number(booking.payment.acceptanceBookingVersion) === Number(booking.version)
  );

const failedPaymentAuthorizationReset = (booking, extra = {}) => ({
  ...extra,
  ...(booking?.payment?.status === 'FAILED'
    ? {
        status: 'PENDING',
        failedAt: null,
        failureReason: null,
        acceptanceMode: null,
        acceptanceAuthorizedById: null,
        acceptanceAuthorizedAt: null,
        acceptanceBookingVersion: null,
        acceptanceMeetingLink: null,
      }
    : {}),
});

const getTutorProfileForUser = async (user) =>
  user?.role === 'TUTOR'
    ? prisma.tutorProfile.findUnique({ where: { userId: user.id } })
    : null;

const getBookingActorContext = async (booking, user) => {
  const tutorProfile = await getTutorProfileForUser(user);
  const isLearner = booking?.learnerId === user.id;
  const isTutor = Boolean(tutorProfile && booking?.tutorId === tutorProfile.id);
  const isAdmin = isAdminRole(user.role);
  return { tutorProfile, isLearner, isTutor, isAdmin };
};

const getBookingActionPolicy = (booking, context) => {
  const status = booking?.status;
  const terminal = TERMINAL_BOOKING_STATUSES.includes(status);
  const future = isFutureBooking(booking);
  const pendingRescheduleRequest = booking?.rescheduleRequests?.find((request) => request.status === 'PENDING') || null;
  const tutorProposedTime = booking?.negotiationStatus === 'TIME_PROPOSED_BY_TUTOR';
  const learnerProposedTime = booking?.negotiationStatus === 'TIME_PROPOSED_BY_LEARNER';
  const pendingPriceOffer = getPendingPriceOffer(booking);
  const seriesPendingPriceOffer = hasPendingSeriesPriceOffer(booking);
  const seriesPriceOfferLocked = hasStartedSeriesPayment(booking);
  const paymentProcessing = isPaymentProcessing(booking);
  const awaitingLearnerRetry = hasCurrentFailedAcceptance(booking);
  const priceOfferEligible =
    status === 'PENDING' &&
    future &&
    !booking?.isTrialLesson &&
    hasOpenPayment(booking) &&
    String(booking?.negotiationStatus || 'NONE') === 'NONE' &&
    !seriesPriceOfferLocked;

  return {
    canWithdraw:
      context.isLearner && ['UNPAID', 'PENDING'].includes(status) && !paymentProcessing,
    canCancel:
      !terminal &&
      CANCELLABLE_STATUSES.includes(status) &&
      (
        (context.isLearner && (['UNPAID', 'PENDING'].includes(status) || (status === 'ACCEPTED' && future))) ||
        (context.isTutor && status === 'ACCEPTED' && future) ||
        context.isAdmin
      ) && !paymentProcessing,
    canAccept:
      context.isTutor &&
      status === 'PENDING' &&
      !tutorProposedTime &&
      !seriesPendingPriceOffer &&
      !paymentProcessing &&
      !awaitingLearnerRetry,
    canDecline: context.isTutor && status === 'PENDING' && !paymentProcessing,
    canProposePendingTime:
      context.isTutor && status === 'PENDING' && future && !tutorProposedTime && !pendingPriceOffer && !paymentProcessing,
    canAcceptPendingTimeProposal:
      context.isLearner && status === 'PENDING' && tutorProposedTime && future && !seriesPendingPriceOffer && !paymentProcessing,
    canRejectPendingTimeProposal:
      context.isLearner && status === 'PENDING' && tutorProposedTime && !paymentProcessing,
    canCounterProposePendingTime:
      context.isLearner && status === 'PENDING' && tutorProposedTime && future && !pendingPriceOffer && !paymentProcessing,
    isAwaitingLearnerTimeResponse: tutorProposedTime,
    isAwaitingTutorTimeResponse: learnerProposedTime,
    canProposePriceOffer: context.isTutor && priceOfferEligible && !pendingPriceOffer && !paymentProcessing,
    canRespondPriceOffer: context.isLearner && priceOfferEligible && Boolean(pendingPriceOffer) && !paymentProcessing,
    canWithdrawPriceOffer:
      context.isTutor && status === 'PENDING' && Boolean(pendingPriceOffer) && !paymentProcessing,
    isAwaitingLearnerPriceResponse: Boolean(pendingPriceOffer),
    hasPendingSeriesPriceOffer: seriesPendingPriceOffer,
    canReschedule: false,
    canProposeReschedule:
      (context.isLearner || context.isTutor) && status === 'ACCEPTED' && future,
    canRespondReschedule:
      status === 'ACCEPTED' &&
      future &&
      Boolean(pendingRescheduleRequest) &&
      (
        (context.isLearner && pendingRescheduleRequest.proposedBy === 'TUTOR') ||
        (context.isTutor && pendingRescheduleRequest.proposedBy === 'LEARNER')
      ),
    canComplete: context.isTutor && status === 'ACCEPTED' && getLessonEndAt(booking) <= new Date(),
    canMarkNotCompleted:
      context.isTutor && status === 'ACCEPTED' && hasStarted(booking) && !paymentProcessing,
    canConfirmCompletion:
      context.isLearner &&
      status === 'COMPLETED' &&
      booking?.completionReviewStatus === 'AWAITING_LEARNER' &&
      new Date(booking?.completionReviewDueAt || 0) > new Date(),
    canDisputeCompletion:
      context.isLearner &&
      status === 'COMPLETED' &&
      booking?.completionReviewStatus === 'AWAITING_LEARNER' &&
      new Date(booking?.completionReviewDueAt || 0) > new Date(),
    canPay: false,
    canRetryPayment:
      context.isLearner &&
      status === 'PENDING' &&
      future &&
      awaitingLearnerRetry &&
      !seriesPendingPriceOffer &&
      !paymentProcessing,
    isAwaitingLearnerPaymentRetry: awaitingLearnerRetry,
    isPaymentProcessing: paymentProcessing,
  };
};

const decorateBookingForUser = async (booking, user) => {
  if (!booking) return booking;
  const context = await getBookingActorContext(booking, user);
  const availableActions = getBookingActionPolicy(booking, context);
  const decorateTutorEarningPreview = (target) =>
    context.isTutor
      ? {
          ...target,
          earningPreview: buildEarningPreview({
            amount: target.totalAmount,
            currency: target.currency,
            isTrialLesson: target.isTrialLesson,
          }),
          priceOffers: (target.priceOffers || []).map((offer) => ({
            ...offer,
            earningPreview: buildEarningPreview({
              amount: offer.proposedTotal,
              currency: offer.currency || target.currency,
            }),
          })),
        }
      : target;
  const decoratedBooking = decorateTutorEarningPreview(booking);

  return {
    ...decoratedBooking,
    availableActions,
    recurringSeries: booking.recurringSeries
      ? {
        ...booking.recurringSeries,
        bookings: booking.recurringSeries.bookings.map((seriesBooking) => ({
          ...decorateTutorEarningPreview(seriesBooking),
          availableActions: getBookingActionPolicy(seriesBooking, context),
        })),
      }
      : booking.recurringSeries,
  };
};

const decorateBookingsForUser = async (bookings, user) =>
  Promise.all(bookings.map((booking) => decorateBookingForUser(booking, user)));

const buildRecurringSeries = (bookings) => {
  if (!bookings.length) return null;

  const sortedBookings = [...bookings].sort(
    (left, right) => new Date(left.scheduledAt) - new Date(right.scheduledAt)
  );
  const totalAmount = sortedBookings.reduce(
    (sum, booking) => sum + Number(booking.totalAmount || 0),
    0
  );
  const chargeableAmount = sortedBookings
    .filter((booking) => !isPaidPaymentStatus(booking.payment?.status))
    .reduce((sum, booking) => sum + Number(booking.totalAmount || 0), 0);
  const paidCount = sortedBookings.filter((booking) => isPaidPaymentStatus(booking.payment?.status)).length;
  const pendingPaymentCount = sortedBookings.filter(
    (booking) => ['PENDING', 'FAILED'].includes(String(booking.payment?.status || 'PENDING').toUpperCase())
  ).length;
  const seriesHasPendingPriceOffer = sortedBookings.some((booking) => getPendingPriceOffer(booking));
  const seriesPriceOfferLocked = sortedBookings.some(hasPricePaymentStarted);

  return {
    recurringGroupId: sortedBookings[0].recurringGroupId,
    recurringType: sortedBookings[0].recurringType,
    totalSessions: sortedBookings.length,
    paidCount,
    pendingPaymentCount,
    seriesHasPendingPriceOffer,
    seriesPriceOfferLocked,
    totalAmount,
    chargeableAmount,
    currency: sortedBookings[0].currency || 'AUD',
    firstScheduledAt: sortedBookings[0].scheduledAt,
    lastScheduledAt: sortedBookings[sortedBookings.length - 1].scheduledAt,
    bookings: sortedBookings.map((booking) => ({
      id: booking.id,
      subject: booking.subject,
      status: booking.status,
      scheduledAt: booking.scheduledAt,
      version: booking.version,
      negotiationStatus: booking.negotiationStatus,
      recurringGroupId: booking.recurringGroupId,
      duration: booking.duration,
      totalAmount: booking.totalAmount,
      isTrialLesson: Boolean(booking.isTrialLesson),
      currency: booking.currency,
      cancellationReason: booking.cancellationReason || null,
      declineReason: booking.declineReason || null,
      completedAt: booking.completedAt || null,
      completionReviewStatus: booking.completionReviewStatus || null,
      completionReviewDueAt: booking.completionReviewDueAt || null,
      completionDisputedAt: booking.completionDisputedAt || null,
      completionDisputeReason: booking.completionDisputeReason || null,
      completionReviewResolvedAt: booking.completionReviewResolvedAt || null,
      completionReviewResolutionNote: booking.completionReviewResolutionNote || null,
      completionResolution: booking.completionResolution || null,
      cancellationCutoffHours: booking.cancellationCutoffHours,
      lateCancellationRefundPercent: booking.lateCancellationRefundPercent,
      cancellationPolicy: getEffectiveCancellationPolicy(booking),
      latestRescheduleReason:
        booking.statusHistory?.find((entry) => entry.status === 'RESCHEDULED')?.reason || null,
      payment: booking.payment || null,
      priceOffers: booking.priceOffers || [],
      rescheduleRequests: booking.rescheduleRequests || [],
      seriesHasPendingPriceOffer,
      seriesPriceOfferLocked,
    })),
  };
};

const attachRecurringSeries = async (bookings, baseWhere = {}) => {
  const recurringGroupIds = [
    ...new Set(
      bookings
        .map((booking) => booking.recurringGroupId)
        .filter(Boolean)
    ),
  ];

  if (!recurringGroupIds.length) return bookings;

  const seriesBookings = await prisma.booking.findMany({
    where: {
      ...baseWhere,
      recurringGroupId: { in: recurringGroupIds },
    },
    include: {
      review: {
        select: {
          id: true,
          learnerId: true,
          rating: true,
          comment: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      payment: {
        include: {
          attempts: { orderBy: { sequence: 'desc' } },
          refund: true,
        },
      },
      priceOffers: { orderBy: { createdAt: 'desc' } },
      statusHistory: { orderBy: { createdAt: 'desc' } },
      rescheduleRequests: { orderBy: { createdAt: 'desc' } },
    },
    orderBy: { scheduledAt: 'asc' },
  });

  const seriesByGroup = seriesBookings.reduce((accumulator, booking) => {
    if (!accumulator[booking.recurringGroupId]) accumulator[booking.recurringGroupId] = [];
    accumulator[booking.recurringGroupId].push(booking);
    return accumulator;
  }, {});

  return bookings.map((booking) => {
    if (!booking.recurringGroupId) return booking;

    const groupedBookings = seriesByGroup[booking.recurringGroupId] || [];
    const seriesReview = groupedBookings.find((seriesBooking) => seriesBooking.review)?.review || null;

    return {
      ...booking,
      review: seriesReview || booking.review || null,
      recurringSeries: buildRecurringSeries(groupedBookings),
    };
  });
};

const ensureTutorSlotIsAvailable = async (tutorId, scheduledAt, duration, options = {}) => {
  const db = options.client || prisma;
  const requestedStart = new Date(scheduledAt);
  if (Number.isNaN(requestedStart.getTime())) {
    throw new AppError('Valid date-time required', 400);
  }

  const requestedEnd = new Date(requestedStart.getTime() + duration * 60 * 1000);
  const lookupStart = new Date(requestedStart.getTime() - 8 * 60 * 60 * 1000);
  const ignoreBookingId = options.ignoreBookingId || null;
  const blockingStatuses = options.blockingStatuses || null;
  const existingBookings = await db.booking.findMany({
    where: {
      tutorId,
      status: blockingStatuses
        ? { in: blockingStatuses }
        : { notIn: ['CANCELLED', 'DECLINED', 'NOT_COMPLETED'] },
      ...(ignoreBookingId ? { id: { not: ignoreBookingId } } : {}),
      scheduledAt: {
        gte: lookupStart,
        lt: requestedEnd,
      },
    },
    select: {
      id: true,
      scheduledAt: true,
      duration: true,
    },
  });

  const hasOverlap = existingBookings.some((booking) => {
    const existingStart = new Date(booking.scheduledAt);
    const existingEnd = new Date(existingStart.getTime() + Number(booking.duration || 0) * 60 * 1000);
    return existingStart < requestedEnd && existingEnd > requestedStart;
  });

  if (hasOverlap) {
    throw new AppError('This time slot has already been booked', 409);
  }
};

const validateTutorAvailabilityWithTimezone = async (tutorId, scheduledAt, duration, options = {}) => {
  const db = options.client || prisma;
  const tutorProfile = await db.tutorProfile.findUnique({
    where: { id: tutorId },
    include: {
      availability: { orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] },
      user: { select: { timezone: true } },
    },
  });

  if (!tutorProfile) {
    throw new AppError('Tutor not found', 404);
  }

  const tutorTimezone = tutorProfile.user?.timezone || 'UTC';
  const slots = tutorProfile.availability || [];

  if (!slots.length) {
    throw new AppError('Tutor has no availability set', 400);
  }

  const validation = validateBookingTime(new Date(scheduledAt), tutorTimezone, slots, duration);

  if (!validation.isValid) {
    throw new AppError(validation.message, 400);
  }

  return {
    isValid: true,
    tutorTimezone,
    tutorLocalTime: validation.tutorLocalTime,
  };
};

const ensureFutureAcceptedBooking = (booking, { messagePrefix = 'Only confirmed future bookings can be rescheduled' } = {}) => {
  if (!booking) {
    throw new AppError('Booking not found', 404);
  }

  if (booking.status !== 'ACCEPTED') {
    throw new AppError(messagePrefix, 400);
  }

  if (new Date(booking.scheduledAt) <= new Date()) {
    throw new AppError('Bookings that have already started cannot be rescheduled', 400);
  }
};

const validateProposedRescheduleTime = async (booking, scheduledAt, options = {}) => {
  const proposedTime = new Date(scheduledAt);
  if (Number.isNaN(proposedTime.getTime())) {
    throw new AppError('Valid date-time required', 400);
  }

  if (proposedTime <= new Date()) {
    throw new AppError('Proposed time must be in the future', 400);
  }

  await ensureTutorSlotIsAvailable(booking.tutorId, scheduledAt, booking.duration, {
    ignoreBookingId: booking.id,
    client: options.client,
    blockingStatuses: options.blockingStatuses,
  });

  const availability = await validateTutorAvailabilityWithTimezone(
    booking.tutorId,
    scheduledAt,
    booking.duration,
    { client: options.client }
  );
  const localStartMinutes = timeToMinutes(availability.tutorLocalTime);
  if (
    !isAlignedMinutes(localStartMinutes) ||
    proposedTime.getUTCSeconds() !== 0 ||
    proposedTime.getUTCMilliseconds() !== 0
  ) {
    throw new AppError('Start time must be on the hour or half-hour.', 400);
  }
};

const validateTutorProposedTime = async (booking, scheduledAt, options = {}) => {
  const db = options.client || prisma;
  const proposedTime = new Date(scheduledAt);
  if (Number.isNaN(proposedTime.getTime())) {
    throw new AppError('Valid date-time required', 400);
  }
  if (proposedTime <= new Date()) {
    throw new AppError('Proposed time must be in the future', 400);
  }

  await ensureTutorSlotIsAvailable(booking.tutorId, scheduledAt, booking.duration, {
    ignoreBookingId: booking.id,
    client: db,
    blockingStatuses: options.blockingStatuses,
  });

  const tutorProfile = await db.tutorProfile.findUnique({
    where: { id: booking.tutorId },
    include: { user: { select: { timezone: true } } },
  });
  if (!tutorProfile) throw new AppError('Tutor not found', 404);

  const tutorTimezone = normalizeTimezone(tutorProfile.user?.timezone);
  const localStartMinutes = timeToMinutes(getTimeInTimezone(proposedTime, tutorTimezone));
  if (
    !isAlignedMinutes(localStartMinutes) ||
    proposedTime.getUTCSeconds() !== 0 ||
    proposedTime.getUTCMilliseconds() !== 0
  ) {
    throw new AppError('Start time must be on the hour or half-hour.', 400);
  }
};

const bookingChangedError = (message = 'This booking request changed. Refresh to see the latest details.') => {
  const error = new AppError(message, 409);
  error.errorCode = 'BOOKING_CHANGED';
  return error;
};

const pendingPriceOfferError = (
  message = 'The price offer must be answered or withdrawn before you can continue.'
) => {
  const error = new AppError(message, 409);
  error.errorCode = 'PRICE_OFFER_PENDING';
  return error;
};

const parsePriceOfferTotal = (value) => {
  const normalized = typeof value === 'number' ? String(value) : String(value || '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new AppError('Enter a positive price in AUD with no more than two decimal places.', 400);
  }

  const proposedTotal = Number(normalized);
  if (!Number.isFinite(proposedTotal) || proposedTotal <= 0 || proposedTotal > 99999999.99) {
    throw new AppError('Enter a price between AUD 0.01 and AUD 99,999,999.99.', 400);
  }
  return toMoney(proposedTotal);
};

const assertPriceOfferBookingEligibility = (booking) => {
  if (booking.status !== 'PENDING') {
    throw new AppError('You can only change the price of a pending booking.', 400);
  }
  if (!isFutureBooking(booking)) {
    throw new AppError('You can’t change the price after the lesson has started.', 400);
  }
  if (booking.isTrialLesson) {
    throw new AppError('You can’t change the price of a free trial lesson.', 400);
  }
  if (!booking.payment || !hasOpenPayment(booking)) {
    throw new AppError('You can’t change the lesson price after payment has started.', 409);
  }
  if (String(booking.negotiationStatus || 'NONE') !== 'NONE') {
    throw new AppError('Finish the pending time change before sending a price offer.', 409);
  }
};

const assertRecurringSeriesEligibleForPriceOffer = async (booking, client = prisma) => {
  if (!booking.recurringGroupId) return;

  const seriesBookings = await client.booking.findMany({
    where: {
      recurringGroupId: booking.recurringGroupId,
      learnerId: booking.learnerId,
      tutorId: booking.tutorId,
    },
    include: { payment: true },
  });
  const seriesPaymentStarted = seriesBookings.some(hasPricePaymentStarted);
  if (seriesPaymentStarted) {
    throw new AppError(
      'You can’t change a lesson price after any session in this series has been accepted or payment has started.',
      409
    );
  }
};

const findPendingPriceOfferForCharge = async (booking, client = prisma) => {
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
  return client.bookingPriceOffer.findFirst({ where });
};

const assertNoPendingPriceOfferForCharge = async (booking, client = prisma) => {
  const pendingOffer = await findPendingPriceOfferForCharge(booking, client);
  if (pendingOffer) throw pendingPriceOfferError();
};

const loadDecoratedBookingForUser = async (bookingId, user) => {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: bookingInclude,
  });
  if (!booking) throw new AppError('Booking not found', 404);

  const context = await getBookingActorContext(booking, user);
  if (!context.isLearner && !context.isTutor && !context.isAdmin) {
    throw new AppError('Booking not found', 404);
  }
  const recurringSeriesBaseWhere = context.isLearner
    ? { learnerId: user.id }
    : context.isTutor
      ? { tutorId: context.tutorProfile.id }
      : {};
  const [bookingWithSeries] = await attachRecurringSeries([booking], recurringSeriesBaseWhere);
  return serializeBooking(await decorateBookingForUser(bookingWithSeries, user), {
    isAdmin: context.isAdmin,
  });
};

const findOverlappingTutorBookings = async ({
  tutorId,
  scheduledAt,
  duration,
  excludeBookingId = null,
  statuses = [],
}) => {
  const requestedStart = new Date(scheduledAt);
  if (Number.isNaN(requestedStart.getTime())) {
    throw new AppError('Valid date-time required', 400);
  }

  const requestedEnd = new Date(requestedStart.getTime() + duration * 60 * 1000);
  const lookupStart = new Date(requestedStart.getTime() - 8 * 60 * 60 * 1000);
  const candidates = await prisma.booking.findMany({
    where: {
      tutorId,
      ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
      ...(statuses.length ? { status: { in: statuses } } : {}),
      scheduledAt: {
        gte: lookupStart,
        lt: requestedEnd,
      },
    },
    include: {
      payment: true,
      learner: true,
    },
  });

  return candidates.filter((booking) => {
    const existingStart = new Date(booking.scheduledAt);
    const existingEnd = new Date(existingStart.getTime() + Number(booking.duration || 0) * 60 * 1000);
    return existingStart < requestedEnd && existingEnd > requestedStart;
  });
};

const getPayableSeriesBookingsForLearner = async (booking, learnerId, client = prisma) => {
  if (!booking.recurringGroupId) {
    return ['PENDING', 'ACCEPTED'].includes(booking.status) &&
      PAYABLE_PAYMENT_STATUSES.includes(String(booking.payment?.status || 'PENDING').toUpperCase())
      ? [booking]
      : [];
  }

  return client.booking.findMany({
    where: {
      recurringGroupId: booking.recurringGroupId,
      learnerId,
      tutorId: booking.tutorId,
      status: { in: ['PENDING', 'ACCEPTED'] },
      payment: {
        is: {
          status: { in: PAYABLE_PAYMENT_STATUSES },
        },
      },
    },
    include: {
      payment: true,
      learner: true,
    },
    orderBy: { scheduledAt: 'asc' },
  });
};

const getSelectedPaymentDetails = (payableBookings, learner) => ({
  stripePaymentMethodId:
    payableBookings.find((item) => item.payment?.stripePaymentMethodId)?.payment?.stripePaymentMethodId ||
    learner?.stripeDefaultPaymentMethodId,
  stripeCustomerId:
    payableBookings.find((item) => item.payment?.stripeCustomerId)?.payment?.stripeCustomerId ||
    learner?.stripeCustomerId,
});

const reservePayableBookings = async (
  booking,
  payableBookings,
  { idempotencyKey, stripeCustomerId, stripePaymentMethodId }
) => {
  const reservedAt = new Date();
  const attemptToken = randomUUID();

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking.tutorId}))`;
      await assertNoPendingPriceOfferForCharge(booking, tx);

      const reservedBookings = [];
      for (const targetBooking of payableBookings) {
        if (!targetBooking.payment?.id) {
          throw new AppError('Payment record not found for this booking', 409);
        }

        const currentStatus = String(targetBooking.payment.status || '').toUpperCase();
        const existingAttemptKey = targetBooking.payment.stripeIdempotencyKey || null;
        if (currentStatus === 'PROCESSING') {
          const processedAt = targetBooking.payment.processedAt
            ? new Date(targetBooking.payment.processedAt)
            : null;
          const isFreshAttempt =
            processedAt &&
            !Number.isNaN(processedAt.getTime()) &&
            reservedAt.getTime() - processedAt.getTime() < PAYMENT_PROCESSING_LEASE_MS;
          if (isFreshAttempt || (existingAttemptKey && existingAttemptKey !== idempotencyKey)) {
            const conflict = new AppError('Payment is already processing', 409);
            conflict.errorCode = 'PAYMENT_ALREADY_PROCESSING';
            throw conflict;
          }
        }

        const reservedPayment = await tx.payment.update({
          where: {
            id: targetBooking.payment.id,
            status: currentStatus === 'PROCESSING'
              ? 'PROCESSING'
              : { in: OPEN_PAYMENT_STATUSES },
            ...(currentStatus === 'PROCESSING'
              ? {
                paymentAttemptToken: targetBooking.payment.paymentAttemptToken || null,
                processedAt: targetBooking.payment.processedAt || null,
              }
              : {
                stripeCustomerId: targetBooking.payment.stripeCustomerId || null,
                stripePaymentMethodId: targetBooking.payment.stripePaymentMethodId || null,
                ...(targetBooking.payment.updatedAt
                  ? { updatedAt: targetBooking.payment.updatedAt }
                  : {}),
              }),
          },
          data: {
            status: 'PROCESSING',
            processedAt: reservedAt,
            failedAt: null,
            failureReason: null,
            stripeCustomerId,
            stripePaymentMethodId,
            stripeIdempotencyKey: idempotencyKey,
            paymentAttemptToken: attemptToken,
          },
        });
        reservedBookings.push({
          ...targetBooking,
          payment: { ...targetBooking.payment, ...reservedPayment },
        });
      }

      return { reservedBookings, attemptToken };
    });
  } catch (error) {
    if (error?.code === 'P2025') {
      const conflict = new AppError('Payment is already processing or has been completed', 409);
      conflict.errorCode = 'PAYMENT_ALREADY_PROCESSING';
      throw conflict;
    }
    throw error;
  }
};

const getPaymentIdempotencyKey = ({ booking, payableBookings, stripePaymentMethodId }) => {
  const paymentFingerprint = payableBookings
    .map((item) => `${item.payment?.id || item.id}:${toMoney(item.totalAmount).toFixed(2)}`)
    .sort()
    .join('|');
  const digest = createHash('sha256')
    .update([
      booking.recurringGroupId || booking.id,
      String(booking.currency || booking.payment?.currency || 'AUD').toUpperCase(),
      stripePaymentMethodId,
      paymentFingerprint,
    ].join('|'))
    .digest('hex');
  return `booking-charge-${digest}`;
};

const chargePayableBookings = async ({ booking, payableBookings, stripeCustomerId, stripePaymentMethodId }) => {
  if (!payableBookings.length) {
    return {
      paymentStatus: isPaidPaymentStatus(booking.payment?.status) ? 'PAID' : booking.payment?.status || 'PENDING',
      updated: booking,
      updatedBookings: [booking],
    };
  }

  if (!stripeCustomerId || !stripePaymentMethodId) {
    throw new AppError('Learner must save a payment method before this booking can be accepted', 400);
  }

  const idempotencyKey = getPaymentIdempotencyKey({
    booking,
    payableBookings,
    stripePaymentMethodId,
  });
  const reservation = await reservePayableBookings(booking, payableBookings, {
    idempotencyKey,
    stripeCustomerId,
    stripePaymentMethodId,
  });
  const { reservedBookings, attemptToken } = reservation;

  const stripe = isStripeConfigured() ? getStripe() : null;
  const totalAmount = reservedBookings.reduce((sum, item) => sum + Number(item.totalAmount || 0), 0);
  let paymentStatus = 'PROCESSING';
  let paymentIntent = null;
  let failureReason = null;

  try {
    if (!stripe) {
      throw new AppError('Payment processing is currently unavailable', 503);
    } else {
      paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(totalAmount * 100),
        currency: String(
          booking.currency || booking.payment?.currency || payableBookings[0]?.currency || 'AUD'
        ).toLowerCase(),
        customer: stripeCustomerId,
        payment_method: stripePaymentMethodId,
        confirm: true,
        off_session: true,
        metadata: {
          bookingId: booking.id,
          learnerId: booking.learnerId,
          recurringGroupId: booking.recurringGroupId || '',
          bookingCount: String(reservedBookings.length),
        },
      }, { idempotencyKey });

      if (paymentIntent.status === 'succeeded') {
        paymentStatus = 'PAID';
      } else if (paymentIntent.status === 'requires_payment_method') {
        paymentStatus = 'FAILED';
        failureReason = 'Payment method was declined';
      }
    }
  } catch (error) {
    paymentIntent = error?.raw?.payment_intent || null;
    const failedIntentStatuses = ['requires_payment_method', 'requires_action', 'canceled'];
    if (!paymentIntent || !['succeeded', ...failedIntentStatuses].includes(paymentIntent.status)) {
      const conflict = new AppError(
        'Payment confirmation is still pending. Please wait before retrying.',
        409
      );
      conflict.errorCode = 'PAYMENT_CONFIRMATION_PENDING';
      throw conflict;
    }
    paymentStatus = paymentIntent.status === 'succeeded' ? 'PAID' : 'FAILED';
    failureReason = paymentStatus === 'FAILED'
      ? error?.raw?.message || error?.message || 'Stripe payment could not be processed'
      : null;
  }

  const processedAt = new Date();
  let updatedBookings;
  try {
    updatedBookings = await prisma.$transaction(async (tx) => {
      const results = [];
      for (const targetBooking of reservedBookings) {
        await tx.payment.update({
          where: {
            id: targetBooking.payment.id,
            status: 'PROCESSING',
            paymentAttemptToken: attemptToken,
          },
          data: { paymentAttemptToken: attemptToken },
        });
        results.push(await tx.booking.update({
          where: { id: targetBooking.id },
          data: {
            payment: targetBooking.payment
              ? {
                update: {
                  status: paymentStatus,
                  stripeCustomerId,
                  stripePaymentMethodId,
                  stripePaymentIntentId: paymentIntent?.id || targetBooking.payment.stripePaymentIntentId,
                  stripeIdempotencyKey: idempotencyKey,
                  paymentAttemptToken: attemptToken,
                  processedAt,
                  paidAt: paymentStatus === 'PAID' ? processedAt : null,
                  failedAt: paymentStatus === 'FAILED' ? processedAt : null,
                  failureReason,
                },
              }
              : {
                create: {
                  userId: targetBooking.learnerId,
                  amount: targetBooking.totalAmount,
                  currency: targetBooking.currency || 'AUD',
                  status: paymentStatus,
                  stripeCustomerId,
                  stripePaymentMethodId,
                  stripePaymentIntentId: paymentIntent?.id || null,
                  stripeIdempotencyKey: idempotencyKey,
                  paymentAttemptToken: attemptToken,
                  processedAt,
                  paidAt: paymentStatus === 'PAID' ? processedAt : null,
                  failedAt: paymentStatus === 'FAILED' ? processedAt : null,
                  failureReason,
                  description: `${targetBooking.subject} session payment`,
                },
              },
          },
          include: bookingInclude,
        }));
      }
      return results;
    });
  } catch (error) {
    if (error?.code === 'P2025') {
      const conflict = new AppError('A newer payment recovery attempt is already in progress', 409);
      conflict.errorCode = 'PAYMENT_ATTEMPT_SUPERSEDED';
      throw conflict;
    }
    throw error;
  }

  return {
    paymentStatus,
    failureReason,
    updated: updatedBookings.find((item) => item.id === booking.id) || booking,
    updatedBookings,
  };
};

const syncRecurringLearnerNotification = async (booking) => {
  if (!booking?.recurringGroupId) return;

  const seriesBookings = await prisma.booking.findMany({
    where: {
      recurringGroupId: booking.recurringGroupId,
      learnerId: booking.learnerId,
    },
    select: {
      id: true,
      status: true,
      scheduledAt: true,
    },
    orderBy: {
      scheduledAt: 'asc',
    },
  });

  if (!seriesBookings.length) return;

  const counts = seriesBookings.reduce((summary, seriesBooking) => {
    const status = String(seriesBooking.status || 'PENDING').toUpperCase();
    summary[status] = (summary[status] || 0) + 1;
    return summary;
  }, {});

  const acceptedCount = (counts.ACCEPTED || 0) + (counts.COMPLETED || 0);
  const declinedCount = counts.DECLINED || 0;
  const cancelledCount = counts.CANCELLED || 0;
  const pendingCount = counts.PENDING || 0;
  const rootBookingId = seriesBookings[0].id;
  const parts = [];

  if (acceptedCount > 0) parts.push(`${acceptedCount} accepted`);
  if (declinedCount > 0) parts.push(`${declinedCount} declined`);
  if (cancelledCount > 0) parts.push(`${cancelledCount} cancelled`);
  if (pendingCount > 0) parts.push(`${pendingCount} pending`);

  const message = parts.length
    ? `Your recurring booking was updated: ${parts.join(' · ')}.`
    : 'Your recurring booking was updated.';

  await notifyOrRefresh(
    booking.learnerId,
    'booking',
    'Recurring Booking Updated',
    message,
    `/bookings/${rootBookingId}`
  );
};

exports.createBooking = async (req, res) => {
  const {
    tutorId,
    subject,
    subjectId,
    scheduledAt,
    duration,
    sessionType,
    notes,
    recurringType = 'ONE_OFF',
    recurringGroupId,
    meetingTool,
    useTrialLesson = false,
    cancellationPolicyAcknowledgement,
  } = req.body;

  if (req.user.role !== 'LEARNER') {
    throw new AppError('Only learners can create bookings', 403);
  }

  const tutorProfile = await prisma.tutorProfile.findFirst({
    where: { OR: [{ id: tutorId }, { userId: tutorId }], status: 'ACTIVE' },
    include: {
      user: true,
      subjects: {
        include: { subject: true },
      },
    },
  });

  if (!tutorProfile) throw new AppError('Tutor not found or not active', 404);
  if (tutorProfile.userId === req.user.id) throw new AppError('You cannot book yourself', 400);

  const effectiveCancellationPolicy = getEffectiveCancellationPolicy(tutorProfile);
  if (!cancellationPoliciesMatch(cancellationPolicyAcknowledgement, effectiveCancellationPolicy)) {
    throw new AppError(
      'Cancellation policy has changed. Please review and acknowledge the updated policy.',
      409
    );
  }

  let bookingSubject = typeof subject === 'string' ? subject.trim() : '';
  let selectedSubject = null;
  if (subjectId) {
    selectedSubject = tutorProfile.subjects.find((item) => item.subjectId === subjectId);
    if (!selectedSubject) {
      throw new AppError('Selected subject is not offered by this tutor', 400);
    }
    bookingSubject = selectedSubject.subject.name;
  }

  if (!bookingSubject) throw new AppError('Subject required', 400);

  const parsedDuration = parseInt(duration, 10);

  const bookingTutorTimezone = normalizeTimezone(tutorProfile.user?.timezone);
  const requestedStartDate = new Date(scheduledAt);
  if (Number.isNaN(requestedStartDate.getTime())) {
    throw new AppError('Valid date-time required', 400);
  }
  if (!isValidDurationMinutes(parsedDuration)) {
    throw new AppError('Duration must be a multiple of 30 minutes between 30 and 480.', 400);
  }
  const startLocalMinutes = timeToMinutes(getTimeInTimezone(requestedStartDate, bookingTutorTimezone));
  const startIsOnGrid =
    isAlignedMinutes(startLocalMinutes) &&
    requestedStartDate.getUTCSeconds() === 0 &&
    requestedStartDate.getUTCMilliseconds() === 0;
  if (!startIsOnGrid) {
    throw new AppError('Start time must be on the hour or half-hour.', 400);
  }

  const durationHours = parsedDuration / 60;
  const rate = parseFloat(selectedSubject?.hourlyRate ?? tutorProfile.hourlyRate);
  const totalAmount = rate * durationHours;
  const shouldNotifyTutorForRecurringRequest = recurringGroupId
    ? (await prisma.booking.count({
      where: {
        learnerId: req.user.id,
        tutorId: tutorProfile.id,
        recurringGroupId,
      },
    })) === 0
    : true;

  // Get learner timezone
  const learner = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      timezone: true,
      stripeCustomerId: true,
      stripeDefaultPaymentMethodId: true,
    },
  });
  const learnerTimezone = learner?.timezone || 'UTC';

  // Check overlapping bookings
  const booking = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tutorProfile.id}))`;
    await ensureTutorSlotIsAvailable(tutorProfile.id, scheduledAt, parsedDuration, { client: tx });

    const tzValidation = await validateTutorAvailabilityWithTimezone(
      tutorProfile.id,
      scheduledAt,
      parsedDuration,
      learnerTimezone
    );

    let isTrialLesson = false;
    if (useTrialLesson === true) {
      const trialLessonLimit = Number(tutorProfile.trialLessonLimit || 0);
      if (trialLessonLimit <= 0) {
        throw new AppError('This tutor does not currently offer trial lessons', 400);
      }
      const claimedTrialLessons = await tx.booking.count({
        where: {
          learnerId: req.user.id,
          tutorId: tutorProfile.id,
          isTrialLesson: true,
          status: { notIn: ['CANCELLED', 'DECLINED', 'NOT_COMPLETED'] },
        },
      });
      if (claimedTrialLessons >= trialLessonLimit) {
        throw new AppError('You have already used your trial lesson allowance with this tutor', 409);
      }
      isTrialLesson = true;
    }

    return tx.booking.create({
      data: {
        learnerId: req.user.id,
        tutorId: tutorProfile.id,
        subject: bookingSubject,
        scheduledAt: new Date(scheduledAt),
        duration: parsedDuration,
        sessionType: sessionType || 'ONLINE',
        hourlyRate: rate,
        totalAmount: isTrialLesson ? 0 : totalAmount,
        isTrialLesson,
        cancellationCutoffHours: effectiveCancellationPolicy.cutoffHours,
        lateCancellationRefundPercent: effectiveCancellationPolicy.lateRefundPercent,
        currency: tutorProfile.currency || 'AUD',
        notes,
        status: 'PENDING',
        recurringType: recurringType || 'ONE_OFF',
        recurringGroupId: recurringGroupId || null,
        meetingTool: meetingTool || tutorProfile.preferredMeetingTool || null,
        learnerTimezone,
        tutorTimezone: tzValidation.tutorTimezone,
        ...(isTrialLesson
          ? {}
          : {
            payment: {
              create: {
                userId: req.user.id,
                amount: totalAmount,
                currency: tutorProfile.currency || 'AUD',
                status: 'PENDING',
                stripeCustomerId: learner?.stripeCustomerId || null,
                stripePaymentMethodId: learner?.stripeDefaultPaymentMethodId || null,
                stripeIdempotencyKey: `pay03_accept_${randomUUID()}`,
                payoutStatus: null,
                description: `${bookingSubject} session booking payment`,
              },
            },
          }),
        statusHistory: {
          create: { status: 'PENDING' },
        },
      },
      include: bookingInclude,
    });
  });

  if (shouldNotifyTutorForRecurringRequest) {
    await notify(
      tutorProfile.userId,
      'booking',
      recurringGroupId ? 'New Recurring Booking Request' : 'New Booking Request',
      recurringGroupId
        ? 'Please review the new recurring booking request.'
        : `New booking request for ${formatLessonTimeForUser(booking.scheduledAt, booking.tutorProfile.user.timezone)}.`,
      `/bookings/${booking.id}`
    );
  }

  res.status(201).json({
    success: true,
    message: 'Booking request sent successfully',
    data: serializeBooking(booking),
  });
};
exports.getMyBookings = async (req, res) => {
  await promoteMatureCompletionPayouts();
  const { status, page = 1, limit = 10 } = req.query;
  const parsedPage = parseInt(page, 10) || 1;
  const parsedLimit = parseInt(limit, 10) || 10;
  const skip = (parsedPage - 1) * parsedLimit;

  const where = {
    learnerId: req.user.id,
    ...(status && { status }),
  };

  const [bookings, total] = await Promise.all([
    prisma.booking.findMany({
      where,
      include: bookingInclude,
      orderBy: { scheduledAt: 'desc' },
      skip,
      take: parsedLimit,
    }),
    prisma.booking.count({ where }),
  ]);

  const bookingsWithSeries = await decorateBookingsForUser(
    await attachRecurringSeries(bookings, { learnerId: req.user.id }),
    req.user
  );

  res.json({
    success: true,
    data: {
      bookings: bookingsWithSeries.map(serializeBooking),
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        total,
        totalPages: Math.ceil(total / parsedLimit),
      },
    },
  });
};

exports.getTutorBookings = async (req, res) => {
  await promoteMatureCompletionPayouts();
  const { status, page = 1, limit = 10 } = req.query;

  const tutorProfile = await prisma.tutorProfile.findUnique({
    where: { userId: req.user.id },
  });
  if (!tutorProfile) throw new AppError('Tutor profile not found', 404);

  const parsedPage = parseInt(page, 10) || 1;
  const parsedLimit = parseInt(limit, 10) || 10;
  const skip = (parsedPage - 1) * parsedLimit;
  const where = {
    tutorId: tutorProfile.id,
    ...(status && { status }),
  };

  const [bookings, total] = await Promise.all([
    prisma.booking.findMany({
      where,
      include: bookingInclude,
      orderBy: { scheduledAt: 'desc' },
      skip,
      take: parsedLimit,
    }),
    prisma.booking.count({ where }),
  ]);

  const bookingsWithSeries = await decorateBookingsForUser(
    await attachRecurringSeries(bookings, {
      tutorId: tutorProfile.id,
    }),
    req.user
  );

  res.json({
    success: true,
    data: {
      bookings: bookingsWithSeries.map(serializeBooking),
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        total,
        totalPages: Math.ceil(total / parsedLimit),
      },
    },
  });
};

exports.getBooking = async (req, res) => {
  await promoteMatureCompletionPayouts();
  const booking = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: bookingInclude,
  });

  if (!booking) throw new AppError('Booking not found', 404);

  const context = await getBookingActorContext(booking, req.user);

  if (!context.isLearner && !context.isTutor && !context.isAdmin) {
    throw new AppError('Booking not found', 404);
  }

  const recurringSeriesBaseWhere = context.isLearner
    ? { learnerId: req.user.id }
    : context.isTutor
      ? { tutorId: context.tutorProfile.id }
      : {};
  const [bookingWithSeries] = await attachRecurringSeries([booking], recurringSeriesBaseWhere);
  const decoratedBooking = await decorateBookingForUser(bookingWithSeries, req.user);

  res.json({
    success: true,
    data: serializeBooking(decoratedBooking, { isAdmin: context.isAdmin }),
  });
};

exports.createPriceOffer = async (req, res) => {
  const proposedTotal = parsePriceOfferTotal(req.body.proposedTotal);
  const requestedVersion = Number(req.body.expectedVersion);
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  const tutorProfile = await prisma.tutorProfile.findUnique({ where: { userId: req.user.id } });
  if (!tutorProfile) throw new AppError('Tutor profile not found', 404);

  const initialBooking = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: bookingInclude,
  });
  if (!initialBooking || initialBooking.tutorId !== tutorProfile.id) {
    throw new AppError('Booking not found', 404);
  }

  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tutorProfile.id}))`;
      const booking = await tx.booking.findUnique({
        where: { id: initialBooking.id },
        include: bookingInclude,
      });
      if (!booking || booking.tutorId !== tutorProfile.id) {
        throw new AppError('Booking not found', 404);
      }
      if (booking.version !== requestedVersion) throw bookingChangedError();
      assertPriceOfferBookingEligibility(booking);
      await assertRecurringSeriesEligibleForPriceOffer(booking, tx);

      if (getPendingPriceOffer(booking)) {
        throw pendingPriceOfferError('Wait for the learner to respond to the current price offer before sending another one.');
      }

      const currentTotal = toMoney(booking.totalAmount);
      if (proposedTotal === currentTotal) {
        throw new AppError('The new price must be different from the current lesson price.', 400);
      }
      if (String(booking.currency || 'AUD').toUpperCase() !== 'AUD') {
        throw new AppError('Price offers are currently available only in AUD.', 400);
      }

      const updatedBooking = await tx.booking.update({
        where: {
          id: booking.id,
          status: 'PENDING',
          version: requestedVersion,
        },
        data: {
          version: { increment: 1 },
          ...(booking.payment?.status === 'FAILED'
            ? {
                payment: {
                  update: failedPaymentAuthorizationReset(booking),
                },
              }
            : {}),
          priceOffers: {
            create: {
              originalTotal: currentTotal,
              proposedTotal,
              currency: booking.currency || 'AUD',
              reason: reason || null,
              createdById: req.user.id,
            },
          },
        },
        include: bookingInclude,
      });
      const direction = proposedTotal < currentTotal ? 'lower' : 'higher';
      await notifyOrRefresh(
        updatedBooking.learnerId,
        'booking',
        'Lesson Price Proposed',
        `Your tutor proposed a ${direction} price of AUD ${proposedTotal.toFixed(2)} for ${updatedBooking.subject} on ${formatLessonTimeForUser(updatedBooking.scheduledAt, updatedBooking.learner?.timezone)}.`,
        `/bookings/${updatedBooking.id}`,
        tx
      );
      return updatedBooking;
    });
  } catch (error) {
    if (error?.code === 'P2025' || error?.code === 'P2002') throw bookingChangedError();
    throw error;
  }

  res.status(201).json({
    success: true,
    message: 'Price offer sent to the learner.',
    data: await loadDecoratedBookingForUser(updated.id, req.user),
  });
};

const respondToPriceOffer = async (req, res, decision) => {
  const requestedVersion = Number(req.body.expectedVersion);
  const offerId = req.params.offerId;
  const tutorProfile =
    decision === 'WITHDRAWN'
      ? await prisma.tutorProfile.findUnique({ where: { userId: req.user.id } })
      : null;
  if (decision === 'WITHDRAWN' && !tutorProfile) {
    throw new AppError('Tutor profile not found', 404);
  }

  const initialBooking = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: bookingInclude,
  });
  const ownsBooking =
    decision === 'WITHDRAWN'
      ? initialBooking?.tutorId === tutorProfile.id
      : initialBooking?.learnerId === req.user.id;
  if (!initialBooking || !ownsBooking) throw new AppError('Booking not found', 404);

  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${initialBooking.tutorId}))`;
      const booking = await tx.booking.findUnique({
        where: { id: initialBooking.id },
        include: bookingInclude,
      });
      const stillOwnsBooking =
        decision === 'WITHDRAWN'
          ? booking?.tutorId === tutorProfile.id
          : booking?.learnerId === req.user.id;
      if (!booking || !stillOwnsBooking) throw new AppError('Booking not found', 404);
      if (booking.version !== requestedVersion) throw bookingChangedError();
      assertPriceOfferBookingEligibility(booking);
      if (decision === 'ACCEPTED') {
        await assertRecurringSeriesEligibleForPriceOffer(booking, tx);
      }

      const offer = booking.priceOffers?.find((item) => item.id === offerId);
      if (!offer || offer.status !== 'PENDING') {
        throw bookingChangedError('This price offer has already been answered or withdrawn. Refresh to see the latest details.');
      }

      const decidedAt = new Date();
      const offerUpdate =
        decision === 'WITHDRAWN'
          ? {
            status: 'WITHDRAWN',
            withdrawnById: req.user.id,
            withdrawnAt: decidedAt,
          }
          : {
            status: decision,
            respondedById: req.user.id,
            respondedAt: decidedAt,
          };

      if (decision === 'ACCEPTED') {
        await tx.bookingPriceOffer.updateMany({
          where: {
            bookingId: booking.id,
            status: 'ACCEPTED',
            id: { not: offer.id },
          },
          data: { status: 'SUPERSEDED' },
        });
      }

      const updatedBooking = await tx.booking.update({
        where: {
          id: booking.id,
          status: 'PENDING',
          version: requestedVersion,
        },
        data: {
          version: { increment: 1 },
          ...(decision === 'ACCEPTED' || booking.payment?.status === 'FAILED'
            ? {
                ...(decision === 'ACCEPTED'
                  ? { totalAmount: offer.proposedTotal }
                  : {}),
                payment: {
                  update: failedPaymentAuthorizationReset(
                    booking,
                    decision === 'ACCEPTED' ? { amount: offer.proposedTotal } : {}
                  ),
                },
              }
            : {}),
          priceOffers: {
            update: {
              where: { id: offer.id },
              data: offerUpdate,
            },
          },
        },
        include: bookingInclude,
      });
      if (decision === 'WITHDRAWN') {
        await notifyOrRefresh(
          updatedBooking.learnerId,
          'booking',
          'Lesson Price Offer Withdrawn',
          `Your tutor withdrew the price offer for ${updatedBooking.subject}. Your lesson price has not changed.`,
          `/bookings/${updatedBooking.id}`,
          tx
        );
      } else {
        const accepted = decision === 'ACCEPTED';
        const learnerName = updatedBooking.learner.firstName;
        await notifyOrRefresh(
          updatedBooking.tutorProfile.userId,
          'booking',
          accepted ? 'Lesson Price Accepted' : 'Lesson Price Rejected',
          accepted
            ? `${learnerName} accepted your new price for ${updatedBooking.subject}.`
            : `${learnerName} chose to keep the current price for ${updatedBooking.subject}.`,
          `/bookings/${updatedBooking.id}`,
          tx
        );
      }
      return updatedBooking;
    });
  } catch (error) {
    if (error?.code === 'P2025') throw bookingChangedError();
    throw error;
  }

  const message =
    decision === 'ACCEPTED'
      ? 'New price accepted. The tutor still needs to accept the booking.'
      : decision === 'REJECTED'
        ? 'Current lesson price kept.'
        : 'Price offer withdrawn.';
  res.json({
    success: true,
    message,
    data: await loadDecoratedBookingForUser(updated.id, req.user),
  });
};

exports.acceptPriceOffer = async (req, res) => respondToPriceOffer(req, res, 'ACCEPTED');
exports.rejectPriceOffer = async (req, res) => respondToPriceOffer(req, res, 'REJECTED');
exports.withdrawPriceOffer = async (req, res) => respondToPriceOffer(req, res, 'WITHDRAWN');

const calculateCancellationOutcome = (booking, actorRole, now = new Date()) => {
  const paidAmount = toMoney(booking.payment?.amount || booking.totalAmount || 0);
  const paid = isChargePaidBooking(booking);
  const policy = getEffectiveCancellationPolicy(booking);
  const cutoffAt = new Date(
    new Date(booking.scheduledAt).getTime() - policy.cutoffHours * 60 * 60 * 1000
  );
  const refundPercent = paid
    ? getCancellationRefundPercent({
      booking,
      isTutor: actorRole === 'TUTOR' || actorRole === 'ADMIN',
      now,
    })
    : 0;

  const refundAmount = paid ? toMoney((paidAmount * refundPercent) / 100) : 0;
  const earning = calculateEarning({
    amount: paid ? paidAmount : 0,
    refundAmount,
    commissionPercent:
      booking.payment?.platformFeePercent ?? DEFAULT_PLATFORM_FEE_PERCENT,
  });

  return {
    actorRole,
    cutoffAt: cutoffAt.toISOString(),
    evaluatedAt: now.toISOString(),
    refundPercent,
    refundAmount: earning.refundAmount,
    retainedAmount: earning.grossAmount,
    platformFeePercent: earning.commissionPercent,
    platformFeeAmount: earning.commissionAmount,
    tutorPayoutAmount: earning.netAmount,
    paymentStatus: !booking.payment
      ? undefined
      : !paid
        ? 'CANCELLED'
        : refundAmount >= paidAmount
          ? 'REFUNDED'
          : refundAmount > 0
            ? 'PARTIALLY_REFUNDED'
            : booking.payment.status,
  };
};

const refundPaymentIntent = async ({ booking, refundAmount }) => {
  if (refundAmount <= 0 || !isChargePaidBooking(booking)) return;
  assertMatchingPaymentEnvironment(booking.payment);
  const stripe = isStripeConfigured() ? getStripe() : null;
  if (!stripe) return;
  if (!booking.payment?.stripePaymentIntentId) {
    throw new AppError('Stripe payment intent ID not found', 404);
  }

  try {
    await stripe.refunds.create({
      payment_intent: booking.payment.stripePaymentIntentId,
      amount: Math.round(refundAmount * 100),
    });
  } catch (err) {
    if (err.type === 'StripeInvalidRequestError' && err.code === 'charge_already_refunded') return;
    throw err;
  }
};

exports.cancelBooking = async (req, res) => {
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason) throw new AppError('Cancellation reason is required', 400);

  const booking = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: {
      tutorProfile: { include: { user: true } },
      learner: true,
      payment: true,
      rescheduleRequests: { where: { status: 'PENDING' } },
    },
  });

  if (!booking) throw new AppError('Booking not found', 404);

  const context = await getBookingActorContext(booking, req.user);
  const actions = getBookingActionPolicy(booking, context);
  if (!context.isLearner && !context.isTutor && !context.isAdmin) {
    throw new AppError('Booking not found', 404);
  }
  if (isPaymentProcessing(booking)) {
    throw new AppError('Wait for the current payment attempt to finish before cancelling', 409);
  }
  if (!actions.canCancel) {
    throw new AppError(`Cannot cancel a ${booking.status.toLowerCase()} booking`, 400);
  }
  if (['PAID', 'FAILED'].includes(booking.payment?.payoutStatus)) {
    throw new AppError(
      'This lesson already has a terminal payout record. Contact support before cancelling it.',
      409
    );
  }

  const actorRole = context.isAdmin ? 'ADMIN' : context.isTutor ? 'TUTOR' : 'LEARNER';
  const outcome = calculateCancellationOutcome(booking, actorRole);
  await refundPaymentIntent({ booking, refundAmount: outcome.refundAmount });

  const updated = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking.tutorId}))`;
    const currentBooking = await tx.booking.findUnique({
      where: { id: booking.id },
      include: { payment: true },
    });
    if (
      !currentBooking ||
      currentBooking.status !== booking.status ||
      currentBooking.version !== booking.version ||
      (currentBooking.payment?.status || null) !== (booking.payment?.status || null)
    ) {
      throw bookingChangedError('The booking or payment changed while cancellation was being processed.');
    }
    if (currentBooking.payment?.status === 'PROCESSING') {
      throw new AppError('Wait for the current payment attempt to finish before cancelling', 409);
    }

    const cancellationFinalizedAt = new Date();
    if (currentBooking.payment) {
      const terminalPayoutStatus = ['PAID', 'FAILED'].includes(
        currentBooking.payment.payoutStatus
      );
      await tx.payment.update({
        where: { id: currentBooking.payment.id },
        data: {
          status: outcome.paymentStatus,
          refundAmount: outcome.refundAmount,
          refundedAt: outcome.refundAmount > 0 ? cancellationFinalizedAt : null,
          platformFeePercent: outcome.platformFeePercent,
          platformFeeAmount: outcome.platformFeeAmount,
          tutorPayoutAmount: outcome.tutorPayoutAmount,
          ...(terminalPayoutStatus
            ? {}
            : {
                payoutStatus: outcome.tutorPayoutAmount > 0 ? 'ELIGIBLE' : null,
                payoutEligibleAt:
                  outcome.tutorPayoutAmount > 0 ? cancellationFinalizedAt : null,
                payoutAt: null,
                payoutFailedAt: null,
                payoutFailureReason: null,
              }),
        },
      });
    }

    const cancelled = await tx.booking.update({
      where: { id: booking.id, status: booking.status, version: booking.version },
      data: {
        status: 'CANCELLED',
        version: { increment: 1 },
        negotiationStatus: 'NONE',
        cancellationReason: reason,
        cancellationOutcome: outcome,
        cancelledAt: cancellationFinalizedAt,
        cancelledById: req.user.id,
        rescheduleRequests: {
          updateMany: {
            where: { status: 'PENDING' },
            data: {
              status: 'CANCELLED',
              decisionReason: 'Booking was cancelled.',
              decidedAt: new Date(),
            },
          },
        },
        priceOffers: {
          updateMany: {
            where: { status: 'PENDING' },
            data: {
              status: 'CANCELLED',
              respondedById: req.user.id,
              respondedAt: new Date(),
            },
          },
        },
        statusHistory: { create: { status: 'CANCELLED', reason } },
      },
      include: bookingInclude,
    });

    if (context.isAdmin) {
      await tx.adminAction.create({
        data: {
          adminId: req.user.id,
          targetUserId: booking.learnerId,
          action: 'BOOKING_EMERGENCY_CANCELLED',
          description: reason,
          metadata: {
            bookingId: booking.id,
            tutorUserId: booking.tutorProfile.userId,
            outcome,
          },
        },
      });
    }

    return cancelled;
  });

  const learnerMessage =
    actorRole === 'TUTOR'
      ? `Your tutor cancelled your session on ${formatLessonTimeForUser(updated.scheduledAt, updated.learner?.timezone)}: ${reason}`
      : actorRole === 'ADMIN'
        ? `Your booking was cancelled by an administrator: ${reason}`
        : `Your booking was cancelled. Refund outcome: ${outcome.refundPercent}% refund.`;

  const tutorMessage =
    actorRole === 'LEARNER'
      ? `A learner cancelled the session on ${formatLessonTimeForUser(updated.scheduledAt, updated.tutorProfile?.user?.timezone)}: ${reason}. Refund outcome: ${outcome.refundPercent}% refund.`
      : actorRole === 'ADMIN'
        ? `A booking was cancelled by an administrator: ${reason}`
        : `You cancelled this booking: ${reason}`;

  await Promise.all([
    notify(updated.learnerId, 'booking', 'Booking Cancelled', learnerMessage, `/bookings/${updated.id}`),
    notify(updated.tutorProfile.userId, 'booking', 'Booking Cancelled', tutorMessage, `/bookings/${updated.id}`),
  ]);

  const responseBooking = serializeBooking(await decorateBookingForUser(updated, req.user));

  res.json({
    success: true,
    message:
      outcome.refundAmount > 0
        ? `Booking cancelled. ${outcome.refundPercent}% refund initiated.`
        : 'Booking cancelled. No refund is due.',
    data: responseBooking,
    refund: {
      percent: outcome.refundPercent,
      amount: outcome.refundAmount,
      currency: booking.currency || booking.payment?.currency || 'AUD',
    },
    outcome,
  });
};

const legacyAcceptBooking = async (req, res) => {
  const { meetingLink, expectedVersion } = req.body;
  const requestedVersion = Number(expectedVersion);
  const tutorProfile = await prisma.tutorProfile.findUnique({ where: { userId: req.user.id } });
  if (!tutorProfile) throw new AppError('Tutor profile not found', 404);

  const booking = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: {
      payment: true,
      learner: true,
    },
  });
  if (!booking || booking.tutorId !== tutorProfile.id) throw new AppError('Booking not found', 404);
  if (booking.status !== 'PENDING') throw new AppError('Booking is not pending', 400);
  if (booking.version !== requestedVersion) {
    throw bookingChangedError('The learner changed the requested time. Refresh to see the updated request.');
  }
  if (booking.negotiationStatus === 'TIME_PROPOSED_BY_TUTOR') {
    throw new AppError('You cannot accept your own proposed time. The learner must respond first.', 409);
  }
  await assertNoPendingPriceOfferForCharge(booking);

  const payableBookings = await getPayableSeriesBookingsForLearner(booking, booking.learnerId);
  const selectedPaymentDetails = getSelectedPaymentDetails(payableBookings, booking.learner);

  if (
    payableBookings.length &&
    (!selectedPaymentDetails.stripeCustomerId || !selectedPaymentDetails.stripePaymentMethodId)
  ) {
    throw new AppError('Learner must save a payment method before this booking can be accepted', 400);
  }

  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tutorProfile.id}))`;
      const currentBooking = await tx.booking.findUnique({
        where: { id: booking.id },
        include: {
          payment: true,
          learner: true,
        },
      });
      if (!currentBooking || currentBooking.tutorId !== tutorProfile.id) {
        throw new AppError('Booking not found', 404);
      }
      if (
        currentBooking.status !== 'PENDING' ||
        currentBooking.version !== requestedVersion
      ) {
        throw bookingChangedError();
      }
      if (currentBooking.negotiationStatus === 'TIME_PROPOSED_BY_TUTOR') {
        throw new AppError('You cannot accept your own proposed time. The learner must respond first.', 409);
      }
      await assertNoPendingPriceOfferForCharge(currentBooking, tx);

      await validateProposedRescheduleTime(currentBooking, currentBooking.scheduledAt, {
        client: tx,
        blockingStatuses: ['ACCEPTED', 'COMPLETED'],
      });

      return tx.booking.update({
        where: {
          id: currentBooking.id,
          status: 'PENDING',
          version: requestedVersion,
        },
        data: {
          status: 'ACCEPTED',
          version: { increment: 1 },
          negotiationStatus: 'NONE',
          meetingLink,
          rescheduleRequests: {
            updateMany: {
              where: { status: 'PENDING' },
              data: {
                status: 'ACCEPTED',
                decisionReason: 'Tutor accepted the learner proposed time.',
                decidedAt: new Date(),
              },
            },
          },
          statusHistory: { create: { status: 'ACCEPTED' } },
        },
        include: bookingInclude,
      });
    });
  } catch (error) {
    if (error?.code === 'P2025') {
      throw bookingChangedError('The learner changed the requested time. Refresh to see the updated request.');
    }
    throw error;
  }

  const overlappingPendingBookings = await findOverlappingTutorBookings({
    tutorId: tutorProfile.id,
    scheduledAt: booking.scheduledAt,
    duration: booking.duration,
    excludeBookingId: booking.id,
    statuses: ['PENDING', 'UNPAID'],
  });

  const autoDeclinedBookings = [];
  for (const conflictingBooking of overlappingPendingBookings) {
    const declinedBooking = await prisma.booking.update({
      where: { id: conflictingBooking.id },
      data: {
        status: 'DECLINED',
        version: { increment: 1 },
        negotiationStatus: 'NONE',
        declineReason:
          'This time slot is no longer available because another learner confirmed it first.',
        rescheduleRequests: {
          updateMany: {
            where: { status: 'PENDING' },
            data: {
              status: 'CANCELLED',
              decisionReason: 'The requested time became unavailable.',
              decidedAt: new Date(),
            },
          },
        },
        priceOffers: {
          updateMany: {
            where: { status: 'PENDING' },
            data: {
              status: 'CANCELLED',
              respondedById: req.user.id,
              respondedAt: new Date(),
            },
          },
        },
        ...(isChargePaidBooking(conflictingBooking)
          ? {
            payment: {
              update: {
                status: 'REFUNDED',
                refundAmount: conflictingBooking.payment.amount,
                refundedAt: new Date(),
              },
            },
          }
          : conflictingBooking?.payment
            ? {
              payment: {
                update: {
                  status: 'CANCELLED',
                },
              },
            }
            : {}),
        statusHistory: {
          create: {
            status: 'DECLINED',
            reason:
              'This time slot is no longer available because another learner confirmed it first.',
          },
        },
      },
      include: bookingInclude,
    });
    autoDeclinedBookings.push(declinedBooking);
  }
  const paymentResult = await chargePayableBookings({
    booking: updated,
    payableBookings,
    stripeCustomerId: selectedPaymentDetails.stripeCustomerId,
    stripePaymentMethodId: selectedPaymentDetails.stripePaymentMethodId,
  });
  const responseBooking = paymentResult.updated || updated;

  if (booking.recurringGroupId) {
    await syncRecurringLearnerNotification(booking);
  } else {
    await notify(
      booking.learnerId,
      'booking',
      'Booking Accepted',
      responseBooking.isTrialLesson
        ? `Your free trial lesson on ${formatLessonTimeForUser(updated.scheduledAt, updated.learner?.timezone)} was accepted.`
        : paymentResult.paymentStatus === 'PAID'
          ? `Your session on ${formatLessonTimeForUser(updated.scheduledAt, updated.learner?.timezone)} was accepted and payment has been confirmed.`
          : paymentResult.paymentStatus === 'FAILED'
            ? `Your session on ${formatLessonTimeForUser(updated.scheduledAt, updated.learner?.timezone)} was accepted, but payment failed. Please update your payment method.`
            : `Your session on ${formatLessonTimeForUser(updated.scheduledAt, updated.learner?.timezone)} was accepted and payment is processing.`,
      `/bookings/${responseBooking.id}`
    );
  }

  if (booking.negotiationStatus === 'TIME_PROPOSED_BY_LEARNER') {
    await notifyOrRefresh(
      updated.tutorProfile.userId,
      'booking',
      'Learner Proposed Time Accepted',
      `You accepted ${updated.learner.firstName}'s proposed time for ${updated.subject}: ${formatLessonTimeForUser(updated.scheduledAt, updated.tutorProfile?.user?.timezone)}.`,
      `/bookings/${updated.id}`
    );
  }

  await Promise.all(
    autoDeclinedBookings.map((conflictingBooking) =>
      notify(
        conflictingBooking.learnerId,
        'booking',
        'Booking Declined',
        isChargePaidBooking(conflictingBooking)
          ? 'This request was declined because another learner confirmed the same time slot first. Your payment will be refunded.'
          : 'This request was declined because another learner confirmed the same time slot first.',
        `/bookings/${conflictingBooking.id}`
      )
    )
  );

  res.json({
    success: true,
    message:
      responseBooking.isTrialLesson
        ? 'Free trial lesson accepted'
        : paymentResult.paymentStatus === 'PAID'
          ? 'Session accepted and payment confirmed'
          : paymentResult.paymentStatus === 'FAILED'
            ? 'Session accepted but payment failed'
            : 'Session accepted and payment is processing',
    data: serializeBooking(responseBooking),
    affectedCount: 1,
    seriesBookings: (paymentResult.updatedBookings || [responseBooking]).map(serializeBooking),
  });
};

exports.acceptBooking = async (req, res) => {
  const result = await acceptBookingWithPayment({
    bookingId: req.params.id,
    expectedVersion: Number(req.body.expectedVersion),
    actor: req.user,
    meetingLink: req.body.meetingLink,
    mode: ACCEPTANCE_MODES.TUTOR,
  });
  const responseBooking = await loadDecoratedBookingForUser(req.params.id, req.user);
  const processing = result.outcome === 'PAYMENT_PROCESSING';
  const seriesBookings = responseBooking.recurringSeries?.bookings || [responseBooking];

  res.status(processing ? 202 : 200).json({
    success: true,
    outcome: result.outcome,
    message: processing
      ? 'Payment is processing; the booking remains pending'
      : responseBooking.isTrialLesson
        ? 'Free trial lesson accepted'
        : 'Session accepted and payment confirmed',
    data: responseBooking,
    affectedCount: 1,
    seriesBookings,
  });
};

const legacyDeclineBooking = async (req, res) => {
  const { reason, expectedVersion } = req.body;
  const requestedVersion = expectedVersion === undefined ? null : Number(expectedVersion);
  const tutorProfile = await prisma.tutorProfile.findUnique({ where: { userId: req.user.id } });
  if (!tutorProfile) throw new AppError('Tutor profile not found', 404);

  const booking = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: { payment: true, learner: true },
  });
  if (!booking || booking.tutorId !== tutorProfile.id) throw new AppError('Booking not found', 404);
  if (booking.status !== 'PENDING') throw new AppError('Booking is not pending', 400);
  if (requestedVersion !== null && booking.version !== requestedVersion) {
    throw bookingChangedError();
  }

  let updated;
  try {
    updated = await prisma.booking.update({
      where: {
        id: booking.id,
        status: 'PENDING',
        ...(requestedVersion !== null ? { version: requestedVersion } : {}),
      },
      data: {
        status: 'DECLINED',
        version: { increment: 1 },
        negotiationStatus: 'NONE',
        declineReason: reason,
        rescheduleRequests: {
          updateMany: {
            where: { status: 'PENDING' },
            data: {
              status: 'DECLINED',
              decisionReason: reason || 'Tutor declined the booking request.',
              decidedAt: new Date(),
            },
          },
        },
        priceOffers: {
          updateMany: {
            where: { status: 'PENDING' },
            data: {
              status: 'CANCELLED',
              respondedById: req.user.id,
              respondedAt: new Date(),
            },
          },
        },
      ...(isChargePaidBooking(booking)
        ? {
          payment: {
            update: {
              status: 'REFUNDED',
              refundAmount: booking.payment.amount,
              refundedAt: new Date(),
            },
          },
        }
        : booking?.payment
          ? {
            payment: {
              update: {
                status: 'CANCELLED',
              },
            },
          }
          : {}),
        statusHistory: { create: { status: 'DECLINED', reason } },
      },
      include: bookingInclude,
    });
  } catch (error) {
    if (error?.code === 'P2025') throw bookingChangedError();
    throw error;
  }

  res.json({
    success: true,
    message: isChargePaidBooking(booking)
      ? 'Session declined and payment refunded'
      : booking.isTrialLesson
        ? 'Trial lesson declined'
        : 'Session declined',
    data: serializeBooking(updated),
    affectedCount: 1,
    seriesBookings: [serializeBooking(updated)],
  });

  if (booking.recurringGroupId) {
    await syncRecurringLearnerNotification(booking);
  } else {
    await notify(
      booking.learnerId,
      'booking',
      'Booking Declined',
      reason ? `One session has been declined: ${reason}` : 'One session has been declined.',
      `/bookings/${updated.id}`
    );
  }


  if (booking.negotiationStatus === 'TIME_PROPOSED_BY_LEARNER') {
    await notifyOrRefresh(
      updated.tutorProfile?.userId || req.user.id,
      'booking',
      'Learner Proposed Time Declined',
      `You declined the learner's proposed time for ${booking.subject}.`,
      `/bookings/${updated.id}`
    );
  }
};

exports.declineBooking = async (req, res) => {
  const { reason, expectedVersion } = req.body;
  const requestedVersion = Number(expectedVersion);
  const tutorProfile = await prisma.tutorProfile.findUnique({ where: { userId: req.user.id } });
  if (!tutorProfile) throw new AppError('Tutor profile not found', 404);

  let originalNegotiationStatus = 'NONE';
  const updated = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tutorProfile.id}))`;
    const booking = await tx.booking.findUnique({
      where: { id: req.params.id },
      include: { payment: true, learner: true },
    });
    if (!booking || booking.tutorId !== tutorProfile.id) throw new AppError('Booking not found', 404);
    if (booking.status !== 'PENDING') throw new AppError('Booking is not pending', 400);
    if (booking.version !== requestedVersion) throw bookingChangedError();
    assertPaymentNotProcessing(
      booking,
      'This booking cannot be declined while its acceptance payment is processing'
    );
    if (isPaidPaymentStatus(booking.payment?.status)) {
      throw new AppError('A charged booking cannot be declined as a pending request', 409);
    }
    originalNegotiationStatus = booking.negotiationStatus;

    return tx.booking.update({
      where: { id: booking.id, status: 'PENDING', version: requestedVersion },
      data: {
        status: 'DECLINED',
        version: { increment: 1 },
        negotiationStatus: 'NONE',
        declineReason: reason,
        rescheduleRequests: {
          updateMany: {
            where: { status: 'PENDING' },
            data: {
              status: 'DECLINED',
              decisionReason: reason || 'Tutor declined the booking request.',
              decidedAt: new Date(),
            },
          },
        },
        priceOffers: {
          updateMany: {
            where: { status: 'PENDING' },
            data: { status: 'CANCELLED', respondedById: req.user.id, respondedAt: new Date() },
          },
        },
        ...(booking.payment
          ? {
              payment: {
                update: {
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
                  failedAt: null,
                  failureReason: null,
                },
              },
            }
          : {}),
        statusHistory: { create: { status: 'DECLINED', reason } },
      },
      include: bookingInclude,
    });
  });

  await notify(
    updated.learnerId,
    'booking',
    'Booking Declined',
    reason ? `One session has been declined: ${reason}` : 'One session has been declined.',
    `/bookings/${updated.id}`
  );
  if (updated.recurringGroupId) await syncRecurringLearnerNotification(updated);

  res.json({
    success: true,
    message: updated.isTrialLesson ? 'Trial lesson declined' : 'Session declined',
    data: serializeBooking(updated),
    affectedCount: 1,
    seriesBookings: [serializeBooking(updated)],
    negotiationClosed: originalNegotiationStatus !== 'NONE',
  });
};

exports.changeRequestedTime = async (req, res) => {
  const { scheduledAt, expectedVersion, reason } = req.body;
  const requestedVersion = Number(expectedVersion);
  const trimmedReason = typeof reason === 'string' ? reason.trim() : '';

  const initialBooking = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: {
      learner: true,
      tutorProfile: { include: { user: true } },
    },
  });

  if (!initialBooking || initialBooking.learnerId !== req.user.id) {
    throw new AppError('Booking not found', 404);
  }

  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${initialBooking.tutorId}))`;

      const booking = await tx.booking.findUnique({
        where: { id: initialBooking.id },
        include: {
          learner: true,
          tutorProfile: { include: { user: true } },
          payment: true,
          priceOffers: { where: { status: 'PENDING' } },
          rescheduleRequests: { where: { status: 'PENDING' } },
        },
      });

      if (!booking || booking.learnerId !== req.user.id) {
        throw new AppError('Booking not found', 404);
      }
      if (booking.status !== 'PENDING') {
        throw bookingChangedError('This request is no longer pending. Refresh to see its latest status.');
      }
      assertPaymentNotProcessing(booking);
      if (booking.version !== requestedVersion) {
        throw bookingChangedError('This request changed since you opened it. Refresh and try again.');
      }
      if (getPendingPriceOffer(booking)) {
        throw pendingPriceOfferError('Respond to the price offer before changing the lesson time.');
      }
      if (
        new Date(booking.scheduledAt) <= new Date() &&
        !hasCurrentFailedAcceptance(booking)
      ) {
        throw new AppError('Bookings that have already started cannot be changed', 400);
      }

      const proposedTime = new Date(scheduledAt);
      if (proposedTime.getTime() === new Date(booking.scheduledAt).getTime()) {
        throw new AppError('Please choose a different requested time', 400);
      }

      await validateProposedRescheduleTime(booking, scheduledAt, { client: tx });
      const isNegotiating = booking.negotiationStatus && booking.negotiationStatus !== 'NONE';

      return tx.booking.update({
        where: {
          id: booking.id,
          status: 'PENDING',
          version: requestedVersion,
        },
        data: {
          scheduledAt: proposedTime,
          version: { increment: 1 },
          negotiationStatus: isNegotiating ? 'TIME_PROPOSED_BY_LEARNER' : 'NONE',
          ...(booking.payment?.status === 'FAILED'
            ? {
                payment: {
                  update: failedPaymentAuthorizationReset(booking),
                },
              }
            : {}),
          rescheduleRequests: isNegotiating
            ? {
              updateMany: {
                where: { status: 'PENDING' },
                data: {
                  status: 'COUNTERED',
                  decisionReason:
                    booking.negotiationStatus === 'TIME_PROPOSED_BY_TUTOR'
                      ? 'Learner proposed a different time.'
                      : 'Learner replaced their previous proposal.',
                  decidedAt: new Date(),
                },
              },
              create: {
                learnerId: booking.learnerId,
                tutorId: booking.tutorId,
                currentScheduledAt: booking.scheduledAt,
                proposedScheduledAt: proposedTime,
                reason: trimmedReason,
                proposedBy: 'LEARNER',
                status: 'PENDING',
              },
            }
            : {
              create: {
                learnerId: booking.learnerId,
                tutorId: booking.tutorId,
                currentScheduledAt: booking.scheduledAt,
                proposedScheduledAt: proposedTime,
                reason: trimmedReason,
                proposedBy: 'LEARNER',
                status: 'ACCEPTED',
                decisionReason: 'Applied immediately while the booking request was pending.',
                decidedAt: new Date(),
              },
            },
        },
        include: bookingInclude,
      });
    });
  } catch (error) {
    if (error?.code === 'P2025') {
      throw bookingChangedError('This request changed while you were updating it. Refresh and try again.');
    }
    throw error;
  }

  const tutorTimezone = updated.tutorProfile?.user?.timezone;
  const wasNegotiating = initialBooking.negotiationStatus && initialBooking.negotiationStatus !== 'NONE';
  await notifyOrRefresh(
    updated.tutorProfile.userId,
    'booking',
    wasNegotiating ? 'New Time Proposed by Learner' : 'Requested Time Changed',
    `${updated.learner.firstName} ${wasNegotiating ? 'proposed a different time' : 'changed the requested time'} for ${updated.subject} from ${formatLessonTimeForUser(initialBooking.scheduledAt, tutorTimezone)} to ${formatLessonTimeForUser(updated.scheduledAt, tutorTimezone)}.`,
    `/bookings/${updated.id}`
  );

  res.json({
    success: true,
    message: wasNegotiating ? 'Different time proposed' : 'Requested time changed',
    data: serializeBooking(updated),
  });
};

exports.proposePendingBookingTime = async (req, res) => {
  const { scheduledAt, expectedVersion, reason } = req.body;
  const requestedVersion = Number(expectedVersion);
  const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
  const tutorProfile = await prisma.tutorProfile.findUnique({ where: { userId: req.user.id } });
  if (!tutorProfile) throw new AppError('Tutor profile not found', 404);

  const initialBooking = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: {
      learner: true,
      tutorProfile: { include: { user: true } },
    },
  });
  if (!initialBooking || initialBooking.tutorId !== tutorProfile.id) {
    throw new AppError('Booking not found', 404);
  }

  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tutorProfile.id}))`;
      const booking = await tx.booking.findUnique({
        where: { id: initialBooking.id },
        include: {
          learner: true,
          tutorProfile: { include: { user: true } },
          payment: true,
          priceOffers: { where: { status: 'PENDING' } },
          rescheduleRequests: { where: { status: 'PENDING' } },
        },
      });

      if (!booking || booking.tutorId !== tutorProfile.id) {
        throw new AppError('Booking not found', 404);
      }
      if (booking.status !== 'PENDING') {
        throw bookingChangedError('This request is no longer pending. Refresh to see its latest status.');
      }
      assertPaymentNotProcessing(booking);
      if (booking.version !== requestedVersion) throw bookingChangedError();
      if (getPendingPriceOffer(booking)) {
        throw pendingPriceOfferError('Withdraw the price offer before suggesting a different lesson time.');
      }
      if (booking.negotiationStatus === 'TIME_PROPOSED_BY_TUTOR') {
        throw new AppError('The learner must respond before you propose another time.', 409);
      }
      if (new Date(booking.scheduledAt) <= new Date()) {
        throw new AppError('Bookings that have already started cannot be changed', 400);
      }

      const proposedTime = new Date(scheduledAt);
      if (proposedTime.getTime() === new Date(booking.scheduledAt).getTime()) {
        throw new AppError('Please choose a different proposed time', 400);
      }
      await validateTutorProposedTime(booking, scheduledAt, { client: tx });

      return tx.booking.update({
        where: {
          id: booking.id,
          status: 'PENDING',
          version: requestedVersion,
        },
        data: {
          scheduledAt: proposedTime,
          version: { increment: 1 },
          negotiationStatus: 'TIME_PROPOSED_BY_TUTOR',
          ...(booking.payment?.status === 'FAILED'
            ? {
                payment: {
                  update: failedPaymentAuthorizationReset(booking),
                },
              }
            : {}),
          rescheduleRequests: {
            updateMany: {
              where: { status: 'PENDING' },
              data: {
                status: 'COUNTERED',
                decisionReason: 'Tutor proposed a different time.',
                decidedAt: new Date(),
              },
            },
            create: {
              learnerId: booking.learnerId,
              tutorId: booking.tutorId,
              currentScheduledAt: booking.scheduledAt,
              proposedScheduledAt: proposedTime,
              reason: trimmedReason,
              proposedBy: 'TUTOR',
              status: 'PENDING',
            },
          },
        },
        include: bookingInclude,
      });
    });
  } catch (error) {
    if (error?.code === 'P2025') throw bookingChangedError();
    throw error;
  }

  await notifyOrRefresh(
    updated.learnerId,
    'booking',
    'New Time Proposed by Tutor',
    `Your tutor proposed moving ${updated.subject} from ${formatLessonTimeForUser(initialBooking.scheduledAt, updated.learner?.timezone)} to ${formatLessonTimeForUser(updated.scheduledAt, updated.learner?.timezone)}.`,
    `/bookings/${updated.id}`
  );

  res.status(201).json({
    success: true,
    message: 'New time proposed to learner',
    data: serializeBooking(updated),
  });
};

const legacyAcceptPendingBookingTimeProposal = async (req, res) => {
  const requestedVersion = Number(req.body.expectedVersion);
  const initialBooking = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: {
      payment: true,
      learner: true,
      tutorProfile: { include: { user: true } },
      rescheduleRequests: { where: { status: 'PENDING' } },
    },
  });

  if (!initialBooking || initialBooking.learnerId !== req.user.id) {
    throw new AppError('Booking not found', 404);
  }
  if (initialBooking.status !== 'PENDING') {
    throw bookingChangedError('This request is no longer pending. Refresh to see its latest status.');
  }
  if (
    initialBooking.negotiationStatus !== 'TIME_PROPOSED_BY_TUTOR' ||
    !initialBooking.rescheduleRequests.some((proposal) => proposal.proposedBy === 'TUTOR')
  ) {
    throw new AppError('There is no tutor time proposal awaiting your response.', 409);
  }
  if (initialBooking.version !== requestedVersion) throw bookingChangedError();
  await assertNoPendingPriceOfferForCharge(initialBooking);

  const payableBookings = await getPayableSeriesBookingsForLearner(
    initialBooking,
    initialBooking.learnerId
  );
  const selectedPaymentDetails = getSelectedPaymentDetails(payableBookings, initialBooking.learner);
  if (
    payableBookings.length &&
    (!selectedPaymentDetails.stripeCustomerId || !selectedPaymentDetails.stripePaymentMethodId)
  ) {
    throw new AppError('Learner must save a payment method before accepting this proposed time', 400);
  }

  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${initialBooking.tutorId}))`;
      const booking = await tx.booking.findUnique({
        where: { id: initialBooking.id },
        include: {
          payment: true,
          learner: true,
          tutorProfile: { include: { user: true } },
          rescheduleRequests: { where: { status: 'PENDING' } },
        },
      });

      if (!booking || booking.learnerId !== req.user.id) {
        throw new AppError('Booking not found', 404);
      }
      const activeTutorProposal = booking.rescheduleRequests.find(
        (proposal) => proposal.proposedBy === 'TUTOR'
      );
      if (
        booking.status !== 'PENDING' ||
        booking.version !== requestedVersion ||
        booking.negotiationStatus !== 'TIME_PROPOSED_BY_TUTOR' ||
        !activeTutorProposal
      ) {
        throw bookingChangedError();
      }
      assertPaymentNotProcessing(booking);
      await assertNoPendingPriceOfferForCharge(booking, tx);

      await validateTutorProposedTime(booking, booking.scheduledAt, {
        client: tx,
        blockingStatuses: ['ACCEPTED', 'COMPLETED'],
      });

      return tx.booking.update({
        where: {
          id: booking.id,
          status: 'PENDING',
          version: requestedVersion,
          negotiationStatus: 'TIME_PROPOSED_BY_TUTOR',
        },
        data: {
          status: 'ACCEPTED',
          version: { increment: 1 },
          negotiationStatus: 'NONE',
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
          statusHistory: {
            create: {
              status: 'ACCEPTED',
              reason: 'Learner accepted the tutor proposed time.',
            },
          },
        },
        include: bookingInclude,
      });
    });
  } catch (error) {
    if (error?.code === 'P2025') throw bookingChangedError();
    throw error;
  }

  const paymentResult = await chargePayableBookings({
    booking: updated,
    payableBookings,
    stripeCustomerId: selectedPaymentDetails.stripeCustomerId,
    stripePaymentMethodId: selectedPaymentDetails.stripePaymentMethodId,
  });
  const responseBooking = paymentResult.updated || updated;
  const learnerTime = formatLessonTimeForUser(responseBooking.scheduledAt, responseBooking.learner?.timezone);
  const tutorTime = formatLessonTimeForUser(
    responseBooking.scheduledAt,
    responseBooking.tutorProfile?.user?.timezone
  );

  await Promise.all([
    notifyOrRefresh(
      responseBooking.learnerId,
      'booking',
      'Booking Confirmed',
      `You accepted the tutor's proposed time for ${responseBooking.subject}: ${learnerTime}.`,
      `/bookings/${responseBooking.id}`
    ),
    notifyOrRefresh(
      responseBooking.tutorProfile.userId,
      'booking',
      'Proposed Time Accepted',
      `${responseBooking.learner.firstName} accepted your proposed time for ${responseBooking.subject}: ${tutorTime}.`,
      `/bookings/${responseBooking.id}`
    ),
  ]);

  res.json({
    success: true,
    message:
      responseBooking.isTrialLesson || paymentResult.paymentStatus === 'PAID'
        ? 'Proposed time accepted and booking confirmed'
        : paymentResult.paymentStatus === 'FAILED'
          ? 'Proposed time accepted but payment failed'
          : 'Proposed time accepted and payment is processing',
    data: responseBooking,
  });
};

exports.acceptPendingBookingTimeProposal = async (req, res) => {
  const result = await acceptBookingWithPayment({
    bookingId: req.params.id,
    expectedVersion: Number(req.body.expectedVersion),
    actor: req.user,
    mode: ACCEPTANCE_MODES.LEARNER_TUTOR_TIME,
  });
  const responseBooking = await loadDecoratedBookingForUser(req.params.id, req.user);
  const processing = result.outcome === 'PAYMENT_PROCESSING';

  res.status(processing ? 202 : 200).json({
    success: true,
    outcome: result.outcome,
    message: processing
      ? 'Payment is processing; the booking remains pending'
      : 'Proposed time accepted and booking confirmed',
    data: responseBooking,
  });
};

exports.rejectPendingBookingTimeProposal = async (req, res) => {
  const requestedVersion = Number(req.body.expectedVersion);
  const reason =
    (typeof req.body.reason === 'string' && req.body.reason.trim()) ||
    "Learner rejected the tutor's proposed time.";

  const initialBooking = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: {
      payment: true,
      learner: true,
      tutorProfile: { include: { user: true } },
      rescheduleRequests: { where: { status: 'PENDING' } },
    },
  });
  if (!initialBooking || initialBooking.learnerId !== req.user.id) {
    throw new AppError('Booking not found', 404);
  }

  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${initialBooking.tutorId}))`;
      const booking = await tx.booking.findUnique({
        where: { id: initialBooking.id },
        include: {
          payment: true,
          learner: true,
          tutorProfile: { include: { user: true } },
          rescheduleRequests: { where: { status: 'PENDING' } },
        },
      });
      const activeTutorProposal = booking?.rescheduleRequests?.some(
        (proposal) => proposal.proposedBy === 'TUTOR'
      );
      if (!booking || booking.learnerId !== req.user.id) {
        throw new AppError('Booking not found', 404);
      }
      if (
        booking.status !== 'PENDING' ||
        booking.version !== requestedVersion ||
        booking.negotiationStatus !== 'TIME_PROPOSED_BY_TUTOR' ||
        !activeTutorProposal
      ) {
        throw bookingChangedError();
      }
      assertPaymentNotProcessing(booking);

      return tx.booking.update({
        where: {
          id: booking.id,
          status: 'PENDING',
          version: requestedVersion,
          negotiationStatus: 'TIME_PROPOSED_BY_TUTOR',
        },
        data: {
          status: 'CANCELLED',
          version: { increment: 1 },
          negotiationStatus: 'NONE',
          cancellationReason: reason,
          cancelledAt: new Date(),
          cancelledById: req.user.id,
          rescheduleRequests: {
            updateMany: {
              where: { status: 'PENDING', proposedBy: 'TUTOR' },
              data: {
                status: 'DECLINED',
                decisionReason: reason,
                decidedAt: new Date(),
              },
            },
          },
          priceOffers: {
            updateMany: {
              where: { status: 'PENDING' },
              data: {
                status: 'CANCELLED',
                respondedById: req.user.id,
                respondedAt: new Date(),
              },
            },
          },
          ...(booking.payment
            ? { payment: { update: { status: 'CANCELLED' } } }
            : {}),
          statusHistory: { create: { status: 'CANCELLED', reason } },
        },
        include: bookingInclude,
      });
    });
  } catch (error) {
    if (error?.code === 'P2025') throw bookingChangedError();
    throw error;
  }

  await Promise.all([
    notifyOrRefresh(
      updated.learnerId,
      'booking',
      'Booking Request Cancelled',
      `You rejected the proposed time for ${updated.subject}. The request has been cancelled.`,
      `/bookings/${updated.id}`
    ),
    notifyOrRefresh(
      updated.tutorProfile.userId,
      'booking',
      'Proposed Time Rejected',
      `${updated.learner.firstName} rejected your proposed time for ${updated.subject}. The request has been cancelled.`,
      `/bookings/${updated.id}`
    ),
  ]);

  res.json({
    success: true,
    message: 'Proposed time rejected and booking request cancelled',
    data: serializeBooking(updated),
  });
};

exports.rescheduleBooking = async (req, res) => {
  const { scheduledAt, reason } = req.body;
  const tutorProfile = await prisma.tutorProfile.findUnique({ where: { userId: req.user.id } });
  if (!tutorProfile) throw new AppError('Tutor profile not found', 404);

  const booking = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: {
      learner: true,
      payment: true,
    },
  });
  if (!booking || booking.tutorId !== tutorProfile.id) throw new AppError('Booking not found', 404);
  ensureFutureAcceptedBooking(booking, { messagePrefix: 'Only accepted bookings can be rescheduled' });

  const previousScheduledAt = booking.scheduledAt;
  await validateProposedRescheduleTime(booking, scheduledAt);

  const updated = await prisma.booking.update({
    where: { id: booking.id },
    data: {
      scheduledAt: new Date(scheduledAt),
      rescheduleRequests: {
        updateMany: {
          where: { status: 'PENDING' },
          data: {
            status: 'CANCELLED',
            decisionReason: 'Tutor rescheduled this booking directly.',
            decidedAt: new Date(),
          },
        },
      },
      statusHistory: {
        create: {
          status: 'RESCHEDULED',
          reason: reason || null,
        },
      },
    },
    include: bookingInclude,
  });

  const overlappingPendingBookings = await findOverlappingTutorBookings({
    tutorId: tutorProfile.id,
    scheduledAt,
    duration: booking.duration,
    excludeBookingId: booking.id,
    statuses: ['PENDING', 'UNPAID'],
  });

  const autoDeclinedBookings = [];
  for (const conflictingBooking of overlappingPendingBookings) {
    const declinedBooking = await prisma.booking.update({
      where: { id: conflictingBooking.id },
      data: {
        status: 'DECLINED',
        version: { increment: 1 },
        negotiationStatus: 'NONE',
        declineReason:
          'This time slot is no longer available because the tutor rescheduled another confirmed session into it.',
        rescheduleRequests: {
          updateMany: {
            where: { status: 'PENDING' },
            data: {
              status: 'CANCELLED',
              decisionReason: 'The requested time became unavailable.',
              decidedAt: new Date(),
            },
          },
        },
        priceOffers: {
          updateMany: {
            where: { status: 'PENDING' },
            data: {
              status: 'CANCELLED',
              respondedById: req.user.id,
              respondedAt: new Date(),
            },
          },
        },
        ...(isChargePaidBooking(conflictingBooking)
          ? {
            payment: {
              update: {
                status: 'REFUNDED',
                refundAmount: conflictingBooking.payment.amount,
                refundedAt: new Date(),
              },
            },
          }
          : conflictingBooking?.payment
            ? {
              payment: {
                update: {
                  status: 'CANCELLED',
                },
              },
            }
            : {}),
        statusHistory: {
          create: {
            status: 'DECLINED',
            reason:
              'This time slot is no longer available because the tutor rescheduled another confirmed session into it.',
          },
        },
      },
      include: bookingInclude,
    });
    autoDeclinedBookings.push(declinedBooking);
  }

  const learnerRescheduleTimezone = updated.learner?.timezone;
  const previousTimeLabel = formatLessonTimeForUser(previousScheduledAt, learnerRescheduleTimezone);
  const updatedTimeLabel = formatLessonTimeForUser(updated.scheduledAt, learnerRescheduleTimezone);
  const rescheduleMessage = reason
    ? `Your tutor moved this session from ${previousTimeLabel} to ${updatedTimeLabel}. Reason: ${reason}`
    : `Your tutor moved this session from ${previousTimeLabel} to ${updatedTimeLabel}.`;

  await notifyOrRefresh(
    booking.learnerId,
    'booking',
    'Booking Rescheduled',
    rescheduleMessage,
    `/bookings/${updated.id}`
  );

  await Promise.all(
    autoDeclinedBookings.map((conflictingBooking) =>
      notify(
        conflictingBooking.learnerId,
        'booking',
        'Booking Declined',
        isChargePaidBooking(conflictingBooking)
          ? 'This request was declined because the tutor rescheduled another confirmed session into the same time slot. Your payment will be refunded.'
          : 'This request was declined because the tutor rescheduled another confirmed session into the same time slot.',
        `/bookings/${conflictingBooking.id}`
      )
    )
  );

  res.json({
    success: true,
    message:
      autoDeclinedBookings.length > 0
        ? `Booking rescheduled. ${autoDeclinedBookings.length} conflicting request(s) were automatically declined.`
        : 'Booking rescheduled',
    data: serializeBooking(updated),
  });
};

exports.proposeReschedule = async (req, res) => {
  const { scheduledAt, reason } = req.body;
  const requestedVersion = Number(req.body.expectedVersion);
  const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
  if (!trimmedReason) {
    throw new AppError('Reason is required', 400);
  }

  const initialBooking = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: {
      learner: true,
      tutorProfile: { include: { user: true } },
      rescheduleRequests: {
        where: { status: 'PENDING' },
      },
    },
  });

  const isLearner = initialBooking?.learnerId === req.user.id;
  const isTutor = initialBooking?.tutorId === req.user.tutorProfile?.id;
  if (!initialBooking || (!isLearner && !isTutor)) {
    throw new AppError('Booking not found', 404);
  }
  if (isTutor && req.user.tutorProfile?.status !== 'ACTIVE') {
    throw new AppError('Your tutor account must be approved before using this feature.', 403);
  }
  if (initialBooking.version !== requestedVersion) throw bookingChangedError();

  let request;
  try {
    request = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${initialBooking.tutorId}))`;
      const booking = await tx.booking.findUnique({
        where: { id: initialBooking.id },
        include: {
          learner: true,
          tutorProfile: { include: { user: true } },
          rescheduleRequests: { where: { status: 'PENDING' } },
        },
      });

      const actorIsLearner = booking?.learnerId === req.user.id;
      const actorIsTutor = booking?.tutorId === req.user.tutorProfile?.id;
      if (!booking || (!actorIsLearner && !actorIsTutor)) {
        throw new AppError('Booking not found', 404);
      }
      ensureFutureAcceptedBooking(booking);
      if (booking.version !== requestedVersion) throw bookingChangedError();
      if (actorIsTutor) {
        await validateTutorProposedTime(booking, scheduledAt, { client: tx });
      } else {
        await validateProposedRescheduleTime(booking, scheduledAt, { client: tx });
      }

      const existingProposal = booking.rescheduleRequests[0] || null;
      if (existingProposal) {
        const superseded = await tx.rescheduleRequest.updateMany({
          where: { id: existingProposal.id, bookingId: booking.id, status: 'PENDING' },
          data: {
            status: 'COUNTERED',
            decisionReason: 'Replaced by a newer reschedule proposal.',
            decidedById: req.user.id,
            decidedAt: new Date(),
          },
        });
        if (superseded.count !== 1) throw bookingChangedError();
      }

      const created = await tx.rescheduleRequest.create({
        data: {
          bookingId: booking.id,
          learnerId: booking.learnerId,
          tutorId: booking.tutorId,
          currentScheduledAt: booking.scheduledAt,
          proposedScheduledAt: new Date(scheduledAt),
          reason: trimmedReason,
          proposedBy: actorIsLearner ? 'LEARNER' : 'TUTOR',
        },
        include: {
          learner: { select: { id: true, firstName: true, lastName: true, avatar: true, email: true, timezone: true } },
          tutor: {
            include: {
              user: { select: { id: true, firstName: true, lastName: true, avatar: true, email: true, timezone: true } },
            },
          },
        },
      });

      await tx.booking.update({
        where: { id: booking.id, status: 'ACCEPTED', version: requestedVersion },
        data: { version: { increment: 1 } },
      });
      return created;
    });
  } catch (error) {
    if (error?.code === 'P2025') throw bookingChangedError();
    throw error;
  }

  const recipientId = isLearner ? initialBooking.tutorProfile.userId : initialBooking.learnerId;
  const recipientTimezone = isLearner
    ? initialBooking.tutorProfile.user.timezone
    : initialBooking.learner.timezone;
  const proposerName = isLearner
    ? initialBooking.learner.firstName
    : initialBooking.tutorProfile.user.firstName;
  await notifyOrRefresh(
    recipientId,
    'booking',
    initialBooking.rescheduleRequests.length ? 'New Reschedule Time Proposed' : 'Reschedule Proposal',
    `${proposerName} proposed moving ${initialBooking.subject} from ${formatLessonTimeForUser(initialBooking.scheduledAt, recipientTimezone)} to ${formatLessonTimeForUser(request.proposedScheduledAt, recipientTimezone)}.`,
    `/bookings/${initialBooking.id}`
  );

  res.status(201).json({
    success: true,
    message: 'Reschedule request sent',
    data: request,
  });
};

exports.acceptRescheduleRequest = async (req, res) => {
  const requestedVersion = Number(req.body.expectedVersion);
  const initialRequest = await prisma.rescheduleRequest.findUnique({
    where: { id: req.params.requestId },
    include: {
      booking: {
        include: {
          learner: true,
          tutorProfile: { include: { user: true } },
        },
      },
    },
  });

  const initialBooking = initialRequest?.booking;
  const responderIsLearner = initialBooking?.learnerId === req.user.id;
  const responderIsTutor = initialBooking?.tutorId === req.user.tutorProfile?.id;
  const expectedResponder = initialRequest?.proposedBy === 'TUTOR' ? responderIsLearner : responderIsTutor;
  if (!initialRequest || initialRequest.bookingId !== req.params.id || !expectedResponder) {
    throw new AppError('Reschedule request not found', 404);
  }
  if (responderIsTutor && req.user.tutorProfile?.status !== 'ACTIVE') {
    throw new AppError('Your tutor account must be approved before using this feature.', 403);
  }

  const previousScheduledAt = initialBooking.scheduledAt;
  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${initialBooking.tutorId}))`;
      const request = await tx.rescheduleRequest.findUnique({
        where: { id: initialRequest.id },
        include: {
          booking: {
            include: {
              learner: true,
              tutorProfile: { include: { user: true } },
            },
          },
        },
      });
      const booking = request?.booking;
      const actorIsLearner = booking?.learnerId === req.user.id;
      const actorIsTutor = booking?.tutorId === req.user.tutorProfile?.id;
      const isCounterparty = request?.proposedBy === 'TUTOR' ? actorIsLearner : actorIsTutor;
      if (!request || request.bookingId !== req.params.id || !isCounterparty) {
        throw new AppError('Reschedule request not found', 404);
      }
      if (request.status !== 'PENDING' || booking.version !== requestedVersion) {
        throw bookingChangedError('This reschedule proposal has already been resolved. Refresh to see the latest booking.');
      }
      ensureFutureAcceptedBooking(booking);

      try {
        if (request.proposedBy === 'TUTOR') {
          await validateTutorProposedTime(booking, request.proposedScheduledAt, { client: tx });
        } else {
          await validateProposedRescheduleTime(booking, request.proposedScheduledAt, { client: tx });
        }
      } catch (error) {
        if ([400, 409].includes(error?.statusCode)) {
          const unavailable = new AppError(
            'That proposed time is no longer available. The original lesson time is unchanged; please choose another time.',
            409
          );
          unavailable.errorCode = 'RESCHEDULE_SLOT_UNAVAILABLE';
          throw unavailable;
        }
        throw error;
      }

      const decision = await tx.rescheduleRequest.updateMany({
        where: { id: request.id, bookingId: booking.id, status: 'PENDING' },
        data: {
          status: 'ACCEPTED',
          decisionReason: `${responderIsLearner ? 'Learner' : 'Tutor'} accepted the proposed time.`,
          decidedById: req.user.id,
          decidedAt: new Date(),
        },
      });
      if (decision.count !== 1) throw bookingChangedError();

      return tx.booking.update({
        where: { id: booking.id, status: 'ACCEPTED', version: requestedVersion },
        data: {
          scheduledAt: request.proposedScheduledAt,
          version: { increment: 1 },
          statusHistory: {
            create: {
              status: 'RESCHEDULED',
              reason: `${request.reason} (proposed by ${request.proposedBy.toLowerCase()}, accepted by ${responderIsLearner ? 'learner' : 'tutor'})`,
            },
          },
        },
        include: bookingInclude,
      });
    });
  } catch (error) {
    if (error?.errorCode === 'RESCHEDULE_SLOT_UNAVAILABLE') {
      const promptMessage = `The proposed time for ${initialBooking.subject} is no longer available. The original lesson time is unchanged; please choose another time.`;
      await Promise.all([
        notifyOrRefresh(initialBooking.learnerId, 'booking', 'Choose Another Lesson Time', promptMessage, `/bookings/${initialBooking.id}`),
        notifyOrRefresh(initialBooking.tutorProfile.userId, 'booking', 'Choose Another Lesson Time', promptMessage, `/bookings/${initialBooking.id}`),
      ]);
    }
    if (error?.code === 'P2025') throw bookingChangedError();
    throw error;
  }

  const learnerTimezone = initialBooking.learner?.timezone;
  const tutorTimezone = initialBooking.tutorProfile?.user?.timezone;
  await Promise.all([
    notifyOrRefresh(
      initialBooking.learnerId,
      'booking',
      'Reschedule Accepted',
      `${initialBooking.subject} moved from ${formatLessonTimeForUser(previousScheduledAt, learnerTimezone)} to ${formatLessonTimeForUser(updated.scheduledAt, learnerTimezone)} by mutual agreement.`,
      `/bookings/${initialBooking.id}`
    ),
    notifyOrRefresh(
      initialBooking.tutorProfile.userId,
      'booking',
      'Booking Rescheduled',
      `${initialBooking.subject} moved from ${formatLessonTimeForUser(previousScheduledAt, tutorTimezone)} to ${formatLessonTimeForUser(updated.scheduledAt, tutorTimezone)} by mutual agreement.`,
      `/bookings/${initialBooking.id}`
    ),
  ]);

  res.json({
    success: true,
    message: 'Reschedule request accepted',
    data: serializeBooking(updated),
  });
};

exports.declineRescheduleRequest = async (req, res) => {
  const { reason } = req.body;
  const requestedVersion = Number(req.body.expectedVersion);
  const initialRequest = await prisma.rescheduleRequest.findUnique({
    where: { id: req.params.requestId },
    include: {
      booking: {
        include: {
          learner: true,
          tutorProfile: { include: { user: true } },
        },
      },
    },
  });

  const initialBooking = initialRequest?.booking;
  const responderIsLearner = initialBooking?.learnerId === req.user.id;
  const responderIsTutor = initialBooking?.tutorId === req.user.tutorProfile?.id;
  const expectedResponder = initialRequest?.proposedBy === 'TUTOR' ? responderIsLearner : responderIsTutor;
  if (!initialRequest || initialRequest.bookingId !== req.params.id || !expectedResponder) {
    throw new AppError('Reschedule request not found', 404);
  }
  if (responderIsTutor && req.user.tutorProfile?.status !== 'ACTIVE') {
    throw new AppError('Your tutor account must be approved before using this feature.', 403);
  }

  const decisionReason = typeof reason === 'string' ? reason.trim() : '';
  let updatedRequest;
  try {
    updatedRequest = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${initialBooking.tutorId}))`;
      const request = await tx.rescheduleRequest.findUnique({ where: { id: initialRequest.id } });
      const booking = await tx.booking.findUnique({ where: { id: initialBooking.id } });
      if (
        !request ||
        request.bookingId !== req.params.id ||
        request.status !== 'PENDING' ||
        booking?.status !== 'ACCEPTED' ||
        booking.version !== requestedVersion
      ) {
        throw bookingChangedError('This reschedule proposal has already been resolved. Refresh to see the latest booking.');
      }
      const actorIsLearner = booking.learnerId === req.user.id;
      const actorIsTutor = booking.tutorId === req.user.tutorProfile?.id;
      const isCounterparty = request.proposedBy === 'TUTOR' ? actorIsLearner : actorIsTutor;
      if (!isCounterparty) throw new AppError('Reschedule request not found', 404);

      const decision = await tx.rescheduleRequest.updateMany({
        where: { id: request.id, bookingId: booking.id, status: 'PENDING' },
        data: {
          status: 'DECLINED',
          decisionReason: decisionReason || null,
          decidedById: req.user.id,
          decidedAt: new Date(),
        },
      });
      if (decision.count !== 1) throw bookingChangedError();
      await tx.booking.update({
        where: { id: booking.id, status: 'ACCEPTED', version: requestedVersion },
        data: { version: { increment: 1 } },
      });
      return { ...request, status: 'DECLINED', decisionReason: decisionReason || null, decidedById: req.user.id };
    });
  } catch (error) {
    if (error?.code === 'P2025') throw bookingChangedError();
    throw error;
  }

  const proposerId = initialRequest.proposedBy === 'TUTOR'
    ? initialBooking.tutorProfile.userId
    : initialBooking.learnerId;
  const responderLabel = responderIsLearner ? 'learner' : 'tutor';
  await notifyOrRefresh(
    proposerId,
    'booking',
    'Reschedule Declined',
    decisionReason
      ? `The ${responderLabel} declined the proposed time for ${initialBooking.subject}: ${decisionReason}`
      : `The ${responderLabel} declined the proposed time for ${initialBooking.subject}.`,
    `/bookings/${initialRequest.bookingId}`
  );

  res.json({
    success: true,
    message: 'Reschedule request declined',
    data: updatedRequest,
  });
};

exports.completeBooking = async (req, res) => {
  const expectedVersion = Number(req.body.expectedVersion);
  const tutorProfile = await prisma.tutorProfile.findUnique({ where: { userId: req.user.id } });
  if (!tutorProfile) throw new AppError('Tutor profile not found', 404);

  const booking = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: { payment: true },
  });
  if (!booking || booking.tutorId !== tutorProfile.id) throw new AppError('Booking not found', 404);
  if (booking.status !== 'ACCEPTED') throw new AppError('Booking must be accepted first', 400);
  if (booking.version !== expectedVersion) {
    throw bookingChangedError('The booking changed before it could be marked complete.');
  }
  if (getLessonEndAt(booking) > new Date()) {
    throw new AppError('Bookings cannot be completed before the scheduled end time', 400);
  }

  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      const completedAt = new Date();
      const completionReviewDueAt = getCompletionReviewDueAt(completedAt);
      if (booking.payment?.id && Number(booking.payment.tutorPayoutAmount || 0) > 0) {
        await tx.payment.updateMany({
          where: {
            id: booking.payment.id,
            payoutStatus: 'PENDING',
          },
          data: {
            payoutStatus: 'PENDING',
            payoutEligibleAt: null,
          },
        });
      }

      const completedBooking = await tx.booking.update({
        where: {
          id: req.params.id,
          status: 'ACCEPTED',
          version: expectedVersion,
        },
        data: {
          status: 'COMPLETED',
          version: { increment: 1 },
          completedAt,
          completionReviewStatus: 'AWAITING_LEARNER',
          completionReviewDueAt,
          completionDisputedAt: null,
          completionDisputeReason: null,
          completionReviewResolvedAt: null,
          completionReviewResolvedById: null,
          completionReviewResolutionNote: null,
          completionResolution: null,
          statusHistory: { create: { status: 'COMPLETED' } },
        },
        include: bookingInclude,
      });

      await tx.tutorProfile.update({
        where: { id: tutorProfile.id },
        data: { totalSessions: { increment: 1 } },
      });

      return completedBooking;
    });
  } catch (error) {
    if (error?.code === 'P2025') {
      throw bookingChangedError('The lesson outcome has already changed. Refresh to continue.');
    }
    throw error;
  }

  await notifyOrRefresh(
    booking.learnerId,
    'booking',
    'Lesson marked complete',
    `The tutor marked ${booking.subject} complete. Report a completion issue within ${COMPLETION_REVIEW_HOURS} hours if the lesson did not take place.`,
    `/bookings/${booking.id}`
  );

  res.json({
    success: true,
    message: `Booking marked as completed. The learner has ${COMPLETION_REVIEW_HOURS} hours to report an issue.`,
    data: serializeBooking(updated),
  });
};

exports.confirmBookingCompletion = async (req, res) => {
  const expectedVersion = Number(req.body.expectedVersion);
  const booking = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: { payment: true, tutorProfile: { select: { userId: true } } },
  });
  if (!booking || booking.learnerId !== req.user.id) throw new AppError('Booking not found', 404);
  if (booking.version !== expectedVersion) {
    throw bookingChangedError('The completion review changed. Refresh before confirming it.');
  }

  const confirmedAt = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const changed = await tx.booking.updateMany({
      where: {
        id: booking.id,
        learnerId: req.user.id,
        status: 'COMPLETED',
        version: expectedVersion,
        completionReviewStatus: 'AWAITING_LEARNER',
        completionReviewDueAt: { gt: confirmedAt },
      },
      data: {
        completionReviewStatus: 'CLEARED',
        completionReviewResolvedAt: confirmedAt,
        completionReviewResolvedById: req.user.id,
        completionReviewResolutionNote: 'Learner confirmed that the lesson was completed.',
        completionResolution: 'LEARNER_CONFIRMED',
        version: { increment: 1 },
      },
    });
    if (!changed.count) {
      throw new AppError('The completion review changed or the 48-hour window has closed.', 409);
    }

    if (booking.payment?.id && Number(booking.payment.tutorPayoutAmount || 0) > 0) {
      const paymentChanged = await tx.payment.updateMany({
        where: { id: booking.payment.id, payoutStatus: 'PENDING' },
        data: {
          payoutStatus: 'ELIGIBLE',
          payoutEligibleAt: confirmedAt,
          payoutFailedAt: null,
          payoutFailureReason: null,
        },
      });
      if (!paymentChanged.count) {
        throw new AppError('The tutor earning changed while completion was being confirmed.', 409);
      }
    }

    return tx.booking.findUnique({ where: { id: booking.id }, include: bookingInclude });
  });

  await notifyOrRefresh(
    booking.tutorProfile.userId,
    'payment',
    'Lesson completion confirmed',
    booking.isTrialLesson
      ? `The learner confirmed the free trial ${booking.subject}. The review is closed; no earning or payout was created.`
      : `The learner confirmed ${booking.subject}. Its earning is now eligible for a future payout run.`,
    `/bookings/${booking.id}`
  );

  res.json({
    success: true,
    message: booking.isTrialLesson
      ? 'Free trial completion confirmed. No earning or payout was created.'
      : 'Lesson confirmed. The tutor earning is now eligible for a future payout.',
    data: serializeBooking(updated),
  });
};

exports.markBookingNotCompleted = async (req, res) => {
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  const expectedVersion = Number(req.body.expectedVersion);
  if (!reason) throw new AppError('Please explain why the lesson was not completed.', 400);

  const tutorProfile = await prisma.tutorProfile.findUnique({ where: { userId: req.user.id } });
  if (!tutorProfile) throw new AppError('Tutor profile not found', 404);

  const initial = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: {
      learner: true,
      tutorProfile: { include: { user: true } },
      payment: { include: { refund: true } },
    },
  });
  if (!initial || initial.tutorId !== tutorProfile.id) throw new AppError('Booking not found', 404);
  if (initial.status !== 'ACCEPTED') {
    throw new AppError('Only an accepted lesson can be marked as not completed.', 409);
  }
  if (new Date(initial.scheduledAt) > new Date()) {
    throw new AppError('Use the cancellation action before the scheduled lesson starts.', 409);
  }
  if (initial.version !== expectedVersion) {
    throw bookingChangedError('The booking changed before it could be marked as not completed.');
  }

  let claim;
  try {
    claim = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${initial.id}))`;
      const booking = await tx.booking.findUnique({
        where: { id: initial.id },
        include: {
          learner: true,
          tutorProfile: { include: { user: true } },
          payment: { include: { refund: true } },
        },
      });
      if (
        !booking ||
        booking.tutorId !== tutorProfile.id ||
        booking.status !== 'ACCEPTED' ||
        booking.version !== expectedVersion
      ) {
        throw bookingChangedError('The lesson outcome has already changed.');
      }
      if (new Date(booking.scheduledAt) > new Date()) {
        throw new AppError('Use the cancellation action before the scheduled lesson starts.', 409);
      }

      const resolvedAt = new Date();
      const refund = booking.isTrialLesson
        ? null
        : await createRefundClaim(tx, {
            payment: booking.payment,
            initiatedById: req.user.id,
            source: REFUND_SOURCES.TUTOR_NON_COMPLETION,
            resolutionNote: reason,
          });
      const refundAmount = refund ? Number(refund.amount) : 0;
      const outcome = {
        type: 'TUTOR_NON_COMPLETION',
        actorRole: 'TUTOR',
        evaluatedAt: resolvedAt.toISOString(),
        refundPercent: refund ? 100 : 0,
        refundAmount,
        retainedAmount: 0,
        platformFeePercent:
          booking.payment?.platformFeePercent ?? DEFAULT_PLATFORM_FEE_PERCENT,
        platformFeeAmount: 0,
        tutorPayoutAmount: 0,
        paymentStatus: refund ? 'REFUND_PROCESSING' : undefined,
      };

      const updated = await tx.booking.update({
        where: { id: booking.id, status: 'ACCEPTED', version: expectedVersion },
        data: {
          status: 'NOT_COMPLETED',
          version: { increment: 1 },
          cancellationReason: reason,
          cancellationOutcome: outcome,
          cancelledAt: resolvedAt,
          cancelledById: req.user.id,
          completionReviewStatus: 'RESOLVED_LEARNER',
          completionReviewDueAt: null,
          completionDisputedAt: null,
          completionDisputeReason: null,
          completionReviewResolvedAt: resolvedAt,
          completionReviewResolvedById: req.user.id,
          completionReviewResolutionNote: reason,
          completionResolution: 'TUTOR_REPORTED_NOT_COMPLETED',
          statusHistory: { create: { status: 'NOT_COMPLETED', reason } },
        },
        include: bookingInclude,
      });
      return { booking: updated, refund };
    });
  } catch (error) {
    if (error?.code === 'P2025') {
      throw bookingChangedError('The lesson outcome has already changed. Refresh to continue.');
    }
    throw error;
  }

  let submittedRefund = claim.refund;
  if (claim.refund) {
    try {
      submittedRefund = await submitRefund(claim.refund.id);
    } catch (error) {
      logger.error(`Refund ${claim.refund.id} needs provider reconciliation:`, error);
      submittedRefund = {
        ...claim.refund,
        status: 'PROCESSING',
        failureReason:
          'Stripe may have received the refund request, but its final status still needs reconciliation.',
      };
    }
  }

  const updated = await prisma.booking.findUnique({
    where: { id: initial.id },
    include: bookingInclude,
  });
  const refundState = submittedRefund?.failureReason
    ? submittedRefund
    : updated?.payment?.refund || submittedRefund;
  const learnerMessage = !claim.refund
    ? `Your tutor reported that the free trial ${initial.subject} lesson was not completed.`
    : refundState?.status === 'FAILED'
      ? `Your tutor reported that ${initial.subject} was not completed. Your full ${initial.currency || 'AUD'} ${Number(claim.refund.amount).toFixed(2)} refund requires administrator attention before it can be sent.`
      : refundState?.status === 'SUCCEEDED'
        ? `Your tutor reported that ${initial.subject} was not completed. Stripe confirmed your full ${initial.currency || 'AUD'} ${Number(claim.refund.amount).toFixed(2)} refund to the original payment method.`
        : `Your tutor reported that ${initial.subject} was not completed. Your full ${initial.currency || 'AUD'} ${Number(claim.refund.amount).toFixed(2)} refund is being processed for the original payment method.`;
  const tutorMessage = !claim.refund
    ? 'The free trial was recorded as not completed. No payment or earning was created.'
    : refundState?.status === 'FAILED'
      ? `No tutor earning is payable for ${initial.subject}. The learner refund requires administrator attention.`
      : refundState?.status === 'SUCCEEDED'
        ? `No tutor earning is payable for ${initial.subject}. Stripe confirmed the learner’s full refund.`
        : `No tutor earning is payable for ${initial.subject}. The learner’s full refund is being processed.`;

  await Promise.all([
    notifyOrRefresh(
      initial.learnerId,
      'payment',
      'Lesson not completed',
      learnerMessage,
      `/bookings/${initial.id}`
    ),
    notifyOrRefresh(
      initial.tutorProfile.userId,
      'payment',
      'Lesson recorded as not completed',
      tutorMessage,
      `/bookings/${initial.id}`
    ),
  ]);

  const processing = refundState?.status === 'PROCESSING';
  const failed = refundState?.status === 'FAILED';
  res.status(processing || failed ? 202 : 200).json({
    success: true,
    message: !claim.refund
      ? 'Lesson marked as not completed. No financial transaction was required for this free trial.'
      : failed
        ? 'Lesson marked as not completed. The refund needs administrator attention before it can complete.'
        : processing
          ? 'Lesson marked as not completed. The full refund is processing.'
          : 'Lesson marked as not completed and the full refund was confirmed.',
    data: serializeBooking(updated || claim.booking),
    refund: serializeRefund(refundState),
  });
};

exports.disputeBookingCompletion = async (req, res) => {
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  const expectedVersion = Number(req.body.expectedVersion);
  if (!reason) throw new AppError('Please explain why the lesson was not completed.', 400);

  const booking = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: { payment: true, tutorProfile: { select: { userId: true } } },
  });
  if (!booking || booking.learnerId !== req.user.id) throw new AppError('Booking not found', 404);
  if (booking.status !== 'COMPLETED') {
    throw new AppError('Only a completed lesson can be disputed.', 400);
  }
  if (booking.version !== expectedVersion) {
    throw bookingChangedError('The completion review changed. Refresh before reporting it.');
  }
  if (booking.completionReviewStatus === 'DISPUTED') {
    throw new AppError('This completion has already been reported for review.', 409);
  }
  if (
    booking.completionReviewStatus !== 'AWAITING_LEARNER' ||
    !booking.completionReviewDueAt ||
    new Date(booking.completionReviewDueAt) <= new Date()
  ) {
    throw new AppError('The 48-hour completion review window has closed.', 409);
  }

  const disputedAt = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const changed = await tx.booking.updateMany({
      where: {
        id: booking.id,
        learnerId: req.user.id,
        status: 'COMPLETED',
        version: expectedVersion,
        completionReviewStatus: 'AWAITING_LEARNER',
        completionReviewDueAt: { gt: disputedAt },
      },
      data: {
        completionReviewStatus: 'DISPUTED',
        completionDisputedAt: disputedAt,
        completionDisputeReason: reason,
        version: { increment: 1 },
      },
    });
    if (!changed.count) {
      throw new AppError('The completion review changed or the 48-hour window has closed.', 409);
    }

    if (booking.payment?.id && Number(booking.payment.tutorPayoutAmount || 0) > 0) {
      const paymentChanged = await tx.payment.updateMany({
        where: { id: booking.payment.id, payoutStatus: { in: ['PENDING', 'ELIGIBLE'] } },
        data: {
          payoutStatus: 'DISPUTED',
          payoutEligibleAt: null,
          payoutFailedAt: null,
          payoutFailureReason: null,
        },
      });
      if (!paymentChanged.count) {
        throw new AppError('The tutor earning changed while the issue was being reported.', 409);
      }
    }

    return tx.booking.findUnique({ where: { id: booking.id }, include: bookingInclude });
  });

  await Promise.all([
    notifyOrRefresh(
      booking.tutorProfile.userId,
      'payment',
      'Lesson completion under review',
      `The learner reported that ${booking.subject} was not completed. Its payout is paused while support reviews it.`,
      `/bookings/${booking.id}`
    ),
    notifyAdmin(
      'payment',
      'Completion dispute requires review',
      `A learner reported that booking ${booking.id} was not completed.`,
      '/admin/payouts'
    ),
  ]);

  res.json({
    success: true,
    message: 'The completion issue was reported. This lesson has been removed from payouts pending admin review.',
    data: serializeBooking(updated),
  });
};

const legacyPayForBooking = async (req, res) => {
  const booking = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: {
      payment: true,
      learner: true,
    },
  });

  if (!booking || booking.learnerId !== req.user.id) {
    throw new AppError('Booking not found', 404);
  }
  if (booking.status !== 'ACCEPTED') {
    throw new AppError('Payment is collected only after the tutor accepts the booking', 409);
  }
  await assertNoPendingPriceOfferForCharge(booking);

  const payableBookings = await getPayableSeriesBookingsForLearner(booking, req.user.id);
  if (!payableBookings.length) {
    if (String(booking.payment?.status || '').toUpperCase() === 'PROCESSING') {
      const conflict = new AppError('Payment is already processing', 409);
      conflict.errorCode = 'PAYMENT_ALREADY_PROCESSING';
      throw conflict;
    }
    throw new AppError('This booking has already been paid', 400);
  }

  const selectedPaymentDetails = getSelectedPaymentDetails(payableBookings, booking.learner);

  if (!selectedPaymentDetails.stripeCustomerId || !selectedPaymentDetails.stripePaymentMethodId) {
    throw new AppError('Please save a payment method before paying for this booking', 400);
  }

  const paymentResult = await chargePayableBookings({
    booking,
    payableBookings,
    stripeCustomerId: selectedPaymentDetails.stripeCustomerId,
    stripePaymentMethodId: selectedPaymentDetails.stripePaymentMethodId,
  });
  const updated = paymentResult.updated;
  const updatedBookings = paymentResult.updatedBookings;
  const paymentStatus = paymentResult.paymentStatus;
  const isSeriesPayment = updatedBookings.length > 1;

  await notify(
    booking.learnerId,
    'payment',
    isSeriesPayment ? 'Recurring Booking Paid' : 'Booking Paid',
    paymentStatus === 'PAID'
      ? isSeriesPayment
        ? `${updatedBookings.length} sessions in your recurring booking have been paid successfully.`
        : 'Your booking has been paid successfully.'
      : 'We could not process your payment. Please update your payment method and try again.',
    `/bookings/${updated.id}`
  );

  res.json({
    success: true,
    message:
      paymentStatus === 'PAID'
        ? isSeriesPayment
          ? `${updatedBookings.length} sessions paid successfully`
          : 'Booking paid successfully'
        : 'Payment failed',
    data: serializeBooking(updated),
    affectedCount: updatedBookings.length,
    seriesBookings: updatedBookings.map(serializeBooking),
  });
};
