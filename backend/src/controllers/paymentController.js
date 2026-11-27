const { prisma } = require('../config/database');
const { getStripe, isStripeConfigured } = require('../config/stripe');
const { AppError } = require('../middleware/errorHandler');
const {
  finalizeSuccessfulPaymentIntent,
  finalizeFailedPaymentIntent,
  recordWebhookEvent,
  retryFailedPayment,
} = require('../services/paymentAcceptanceService');
const {
  getPayoutAccountForTutor,
  createOnboardingLink,
  applyAccountUpdatedEvent,
} = require('../services/payoutAccountService');
const { promoteMatureCompletionPayouts } = require('../services/completionReviewService');
const { applyRefundWebhookEvent, serializeRefund } = require('../services/refundService');
const { serializePayment } = require('../utils/paymentSerialization');
const { serializePayoutAccount } = require('../utils/payoutSerialization');
const {
  DEFAULT_PLATFORM_FEE_PERCENT,
  calculateEarning,
  formatMoney,
  formatPercent,
  serializeEarningCalculation,
  toMinorUnits,
} = require('../utils/earnings');

const buildCustomerName = (user) =>
  `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || user?.email || 'TutorConnect User';

const getStripeObjectId = (value) => {
  if (typeof value === 'string') return value;
  if (value?.id) return String(value.id);
  return null;
};

const mapSavedPaymentMethod = (paymentMethod) => {
  if (!paymentMethod) return null;

  const card = paymentMethod.card || null;

  return {
    id: paymentMethod.id,
    type: paymentMethod.type || null,
    brand: card?.brand || null,
    last4: card?.last4 || null,
    expMonth: card?.exp_month || null,
    expYear: card?.exp_year || null,
    billingName: paymentMethod.billing_details?.name || null,
    ...(paymentMethod.isTestPayment ? { isTestPayment: true } : {}),
  };
};

const pendingPaymentStatuses = ['PENDING', 'FAILED', 'PROCESSING'];
const editablePaymentStatuses = ['PENDING', 'FAILED'];
const earningPaymentStatuses = ['PAID', 'COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
const paymentProcessingError = () =>
  new AppError('Payment is currently processing; its payment method cannot be changed', 409);

const earningSelect = {
  id: true,
  stripePaymentIntentId: true,
  amount: true,
  currency: true,
  status: true,
  platformFeePercent: true,
  platformFeeAmount: true,
  tutorPayoutAmount: true,
  payoutStatus: true,
  payoutPendingAt: true,
  payoutEligibleAt: true,
  payoutAt: true,
  payoutFailedAt: true,
  payoutFailureReason: true,
  paidAt: true,
  refundAmount: true,
  refundedAt: true,
  refund: true,
  booking: {
    select: {
      id: true,
      subject: true,
      status: true,
      scheduledAt: true,
      completedAt: true,
      cancelledAt: true,
      cancellationOutcome: true,
      isTrialLesson: true,
      completionReviewStatus: true,
      completionReviewDueAt: true,
      completionDisputedAt: true,
      completionReviewResolvedAt: true,
      completionResolution: true,
    },
  },
};

const getAuditableEarningCalculation = (payment) => {
  const calculated = calculateEarning({
    amount: payment.amount,
    refundAmount: payment.refundAmount,
    commissionPercent: payment.platformFeePercent ?? DEFAULT_PLATFORM_FEE_PERCENT,
  });

  const commissionAmount =
    payment.platformFeeAmount == null
      ? calculated.commissionAmount
      : Number(payment.platformFeeAmount);
  const netAmount =
    payment.tutorPayoutAmount == null
      ? calculated.grossAmount - commissionAmount
      : Number(payment.tutorPayoutAmount);

  return {
    ...calculated,
    commissionAmount,
    netAmount,
  };
};

const serializeEarningRecord = (payment) => {
  const calculation = getAuditableEarningCalculation(payment);
  const cancellationOutcome = payment.booking?.cancellationOutcome || null;

  return {
    id: payment.id,
    ...(String(payment.stripePaymentIntentId || '').startsWith('fake_') ? { isTestPayment: true } : {}),
    currency: String(payment.currency || 'AUD').toUpperCase(),
    paymentStatus: payment.status,
    payoutStatus: payment.payoutStatus || null,
    isPayable: calculation.netAmount > 0,
    calculation: serializeEarningCalculation(calculation),
    statusTimestamps: {
      pendingAt: payment.payoutPendingAt || payment.paidAt || null,
      eligibleAt: payment.payoutEligibleAt || null,
      paidAt: payment.payoutAt || null,
      failedAt: payment.payoutFailedAt || null,
      disputedAt: payment.booking.completionDisputedAt || null,
    },
    payoutFailureReason: payment.payoutFailureReason || null,
    completionReview: {
      status: payment.booking.completionReviewStatus || null,
      dueAt: payment.booking.completionReviewDueAt || null,
      disputedAt: payment.booking.completionDisputedAt || null,
      resolvedAt: payment.booking.completionReviewResolvedAt || null,
      resolution: payment.booking.completionResolution || null,
    },
    refund: serializeRefund(payment.refund),
    lesson: {
      id: payment.booking.id,
      subject: payment.booking.subject,
      status: payment.booking.status,
      scheduledAt: payment.booking.scheduledAt,
      completedAt: payment.booking.completedAt || null,
      href: `/bookings/${payment.booking.id}`,
    },
    cancellation: payment.booking.cancelledAt
      ? {
          cancelledAt: payment.booking.cancelledAt,
          outcomeType:
            payment.booking.status === 'NOT_COMPLETED' ? 'POST_LESSON_RESOLUTION' : 'CANCELLATION',
          refundPercent:
            cancellationOutcome?.refundPercent == null
              ? null
              : Number(cancellationOutcome.refundPercent),
          refundAmount: formatMoney(calculation.refundAmount),
          retainedAmount: formatMoney(calculation.grossAmount),
          href:
            payment.booking.status === 'NOT_COMPLETED'
              ? `/bookings/${payment.booking.id}#post-lesson-resolution`
              : `/bookings/${payment.booking.id}#cancellation-outcome`,
        }
      : null,
  };
};

const buildEarningSummaries = (payments) => {
  const summaries = new Map();

  payments.forEach((payment) => {
    const currency = String(payment.currency || 'AUD').toUpperCase();
    const calculation = getAuditableEarningCalculation(payment);
    const summary = summaries.get(currency) || {
      currency,
      grossMinor: 0,
      commissionMinor: 0,
      netMinor: 0,
      byStatusMinor: {
        PENDING: 0,
        ELIGIBLE: 0,
        PROCESSING: 0,
        DISPUTED: 0,
        PAID: 0,
        FAILED: 0,
      },
    };

    summary.grossMinor += toMinorUnits(calculation.grossAmount);
    summary.commissionMinor += toMinorUnits(calculation.commissionAmount);
    summary.netMinor += toMinorUnits(calculation.netAmount);
    if (payment.payoutStatus && summary.byStatusMinor[payment.payoutStatus] != null) {
      summary.byStatusMinor[payment.payoutStatus] += toMinorUnits(calculation.netAmount);
    }
    summaries.set(currency, summary);
  });

  return [...summaries.values()]
    .sort((left, right) => left.currency.localeCompare(right.currency))
    .map((summary) => ({
      currency: summary.currency,
      grossAmount: (summary.grossMinor / 100).toFixed(2),
      commissionAmount: (summary.commissionMinor / 100).toFixed(2),
      netAmount: (summary.netMinor / 100).toFixed(2),
      byStatus: Object.fromEntries(
        Object.entries(summary.byStatusMinor).map(([status, amount]) => [
          status,
          (amount / 100).toFixed(2),
        ])
      ),
    }));
};

const getTargetBookingsForPaymentSetup = async (booking, learnerId) => {
  if (!booking.recurringGroupId) {
    return editablePaymentStatuses.includes(String(booking.payment?.status || '').toUpperCase())
      ? [booking]
      : [];
  }

  const targetBookings = await prisma.booking.findMany({
    where: {
      recurringGroupId: booking.recurringGroupId,
      learnerId,
      status: { in: ['PENDING', 'ACCEPTED'] },
      payment: {
        is: {
          status: { in: pendingPaymentStatuses },
        },
      },
    },
    include: {
      payment: true,
      tutorProfile: { select: { userId: true } },
    },
    orderBy: { scheduledAt: 'asc' },
  });

  if (targetBookings.some((targetBooking) => targetBooking.payment?.status === 'PROCESSING')) {
    return [];
  }
  return targetBookings.filter((targetBooking) =>
    editablePaymentStatuses.includes(String(targetBooking.payment?.status || '').toUpperCase())
  );
};

const getStripeCustomerMethods = async (stripe, stripeCustomerId, stripeDefaultPaymentMethodId) => {
  if (!stripeCustomerId) {
    return [];
  }

  const response = await stripe.paymentMethods.list({
    customer: stripeCustomerId,
    type: 'card',
  });

  const methods = (response?.data || []).map(mapSavedPaymentMethod).filter(Boolean);

  return methods.sort((a, b) => {
    if (a.id === stripeDefaultPaymentMethodId) return -1;
    if (b.id === stripeDefaultPaymentMethodId) return 1;
    return 0;
  });
};

const bookingPendingUpdate = (booking, reason) =>
  booking.status === 'UNPAID'
    ? {
        status: 'PENDING',
        statusHistory: {
          create: {
            status: 'PENDING',
            reason,
          },
        },
      }
    : {};

exports.getSavedPaymentMethod = async (req, res) => {
  if (req.user.role !== 'LEARNER') {
    throw new AppError('Only learners can view payment methods', 403);
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      stripeCustomerId: true,
      stripeDefaultPaymentMethodId: true,
    },
  });

  if (!user) {
    throw new AppError('User not found', 404);
  }

  if (!isStripeConfigured()) {
    res.json({
      success: true,
      data: {
        hasPaymentMethod: false,
        paymentMethod: null,
        paymentMethods: [],
        unavailable: true,
      },
    });
    return;
  }

  if (!user.stripeCustomerId || !user.stripeDefaultPaymentMethodId) {
    res.json({
      success: true,
      data: {
        hasPaymentMethod: false,
        paymentMethod: null,
        paymentMethods: [],
      },
    });
    return;
  }

  const stripe = getStripe();

  try {
    const paymentMethod = await stripe.paymentMethods.retrieve(user.stripeDefaultPaymentMethodId);
    const paymentMethods = await getStripeCustomerMethods(
      stripe,
      user.stripeCustomerId,
      user.stripeDefaultPaymentMethodId
    );

    res.json({
      success: true,
      data: {
        hasPaymentMethod: true,
        paymentMethod: mapSavedPaymentMethod(paymentMethod),
        paymentMethods,
        defaultPaymentMethodId: user.stripeDefaultPaymentMethodId,
      },
    });
  } catch (error) {
    res.json({
      success: true,
      data: {
        hasPaymentMethod: false,
        paymentMethod: null,
        paymentMethods: [],
        unavailable: true,
      },
    });
  }
};

exports.setDefaultPaymentMethod = async (req, res) => {
  if (req.user.role !== 'LEARNER') {
    throw new AppError('Only learners can update payment methods', 403);
  }

  const { paymentMethodId } = req.body;

  if (!paymentMethodId) {
    throw new AppError('Payment method ID is required', 400);
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      stripeCustomerId: true,
    },
  });

  if (!isStripeConfigured()) {
    throw new AppError('Payment setup is currently unavailable', 503);
  }

  if (!user?.stripeCustomerId) {
    throw new AppError('Stripe customer not found', 404);
  }

  const stripe = getStripe();
  const paymentMethods = await getStripeCustomerMethods(stripe, user.stripeCustomerId, paymentMethodId);
  const exists = paymentMethods.some((method) => method.id === paymentMethodId);

  if (!exists) {
    throw new AppError('Payment method not found', 404);
  }

  await prisma.user.update({
    where: { id: req.user.id },
    data: {
      stripeDefaultPaymentMethodId: paymentMethodId,
    },
  });

  res.json({
    success: true,
    message: 'Default payment method updated',
  });
};

exports.createSetupIntent = async (req, res) => {
  if (req.user.role !== 'LEARNER') {
    throw new AppError('Only learners can save payment methods', 403);
  }

  if (!isStripeConfigured()) {
    throw new AppError('Payment setup is currently unavailable', 503);
  }

  const stripe = getStripe();

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
  });

  if (!user) {
    throw new AppError('User not found', 404);
  }

  let stripeCustomerId = user.stripeCustomerId;

  if (!stripeCustomerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      name: buildCustomerName(user),
      metadata: {
        userId: user.id,
        role: user.role,
      },
    });

    stripeCustomerId = customer.id;

    await prisma.user.update({
      where: { id: user.id },
      data: { stripeCustomerId },
    });
  }

  const setupIntent = await stripe.setupIntents.create({
    customer: stripeCustomerId,
    payment_method_types: ['card'],
    usage: 'off_session',
    metadata: {
      userId: user.id,
    },
  });

  res.json({
    success: true,
    data: {
      clientSecret: setupIntent.client_secret,
      setupIntentId: setupIntent.id,
      ...(setupIntent.isTestPayment ? { isTestPayment: true } : {}),
    },
  });
};

exports.completeSetupIntent = async (req, res) => {
  if (req.user.role !== 'LEARNER') {
    throw new AppError('Only learners can save payment methods', 403);
  }

  const { setupIntentId, bookingId, saveAsDefault = true } = req.body;

  if (!setupIntentId) {
    throw new AppError('Setup intent ID is required', 400);
  }

  if (!isStripeConfigured()) {
    throw new AppError('Payment setup is currently unavailable', 503);
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      id: true,
      stripeCustomerId: true,
    },
  });

  if (!user?.stripeCustomerId) {
    throw new AppError('Payment method setup not found', 404);
  }

  const stripe = getStripe();
  let setupIntent;

  try {
    setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
  } catch {
    throw new AppError('Payment method setup not found', 404);
  }

  if (!setupIntent) {
    throw new AppError('Payment method setup not found', 404);
  }

  const stripeCustomerId = getStripeObjectId(setupIntent.customer);
  const stripePaymentMethodId = getStripeObjectId(setupIntent.payment_method);
  const setupOwnerId = setupIntent.metadata?.userId || null;

  if (stripeCustomerId !== user.stripeCustomerId || setupOwnerId !== req.user.id) {
    throw new AppError('Payment method setup not found', 404);
  }

  if (setupIntent.status !== 'succeeded' || !stripePaymentMethodId) {
    throw new AppError('Payment method setup is not complete yet', 400);
  }

  let paymentMethod;

  try {
    paymentMethod = await stripe.paymentMethods.retrieve(stripePaymentMethodId);
  } catch {
    throw new AppError('Payment method setup could not be verified. Please try again.', 400);
  }

  if (getStripeObjectId(paymentMethod?.customer) !== stripeCustomerId) {
    throw new AppError('Payment method setup not found', 404);
  }

  let booking = null;

  if (bookingId) {
    booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        payment: true,
        tutorProfile: { select: { userId: true } },
      },
    });

    if (!booking || booking.learnerId !== req.user.id) {
      throw new AppError('Booking not found', 404);
    }

    if (!booking.payment) {
      throw new AppError('Payment record not found for this booking', 404);
    }
  }

  let updatedUser = null;

  if (saveAsDefault) {
    updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        stripeCustomerId,
        stripeDefaultPaymentMethodId: stripePaymentMethodId,
      },
      select: {
        id: true,
        stripeCustomerId: true,
        stripeDefaultPaymentMethodId: true,
      },
    });
  }

  if (booking) {
    const targetBookings = await getTargetBookingsForPaymentSetup(booking, req.user.id);

    if (!targetBookings.length && booking.payment.status === 'PROCESSING') {
      throw paymentProcessingError();
    }

    try {
      await prisma.$transaction(
        targetBookings
          .filter((targetBooking) => targetBooking.payment)
          .flatMap((targetBooking) => [
            prisma.payment.update({
              where: {
                id: targetBooking.payment.id,
                status: { in: editablePaymentStatuses },
              },
              data: {
                stripeCustomerId,
                stripePaymentMethodId,
                stripeSetupIntentId: setupIntent.id,
              },
            }),
            ...(targetBooking.status === 'UNPAID'
              ? [
                  prisma.booking.update({
                    where: { id: targetBooking.id },
                    data: bookingPendingUpdate(targetBooking, 'Payment method saved'),
                  }),
                ]
              : []),
          ])
      );
    } catch (error) {
      if (error?.code === 'P2025') throw paymentProcessingError();
      throw error;
    }
  }

  res.json({
    success: true,
    message: 'Payment method saved successfully',
    data: {
      user: updatedUser ? { id: updatedUser.id } : null,
      paymentMethod: mapSavedPaymentMethod(paymentMethod),
      savedAsDefault: Boolean(saveAsDefault),
      bookingId: bookingId || null,
    },
  });
};

exports.useSavedMethodForBooking = async (req, res) => {
  if (req.user.role !== 'LEARNER') {
    throw new AppError('Only learners can manage booking payment methods', 403);
  }

  if (!isStripeConfigured()) {
    throw new AppError('Payment setup is currently unavailable', 503);
  }

  const booking = await prisma.booking.findUnique({
    where: { id: req.params.bookingId },
    include: {
      payment: true,
      tutorProfile: { select: { userId: true } },
    },
  });

  if (!booking || booking.learnerId !== req.user.id) {
    throw new AppError('Booking not found', 404);
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      stripeCustomerId: true,
      stripeDefaultPaymentMethodId: true,
    },
  });

  if (!user?.stripeCustomerId || !user?.stripeDefaultPaymentMethodId) {
    throw new AppError('No saved payment method found', 400);
  }

  if (!booking.payment) {
    throw new AppError('Payment record not found for this booking', 404);
  }

  const targetBookings = await getTargetBookingsForPaymentSetup(booking, req.user.id);

  if (!targetBookings.length) {
    throw paymentProcessingError();
  }

  let transactionResult;
  try {
    transactionResult = await prisma.$transaction(
      targetBookings
        .filter((targetBooking) => targetBooking.payment)
        .flatMap((targetBooking) => [
          prisma.payment.update({
            where: {
              id: targetBooking.payment.id,
              status: { in: editablePaymentStatuses },
            },
            data: {
              stripeCustomerId: user.stripeCustomerId,
              stripePaymentMethodId: user.stripeDefaultPaymentMethodId,
            },
          }),
          ...(targetBooking.status === 'UNPAID'
            ? [
                prisma.booking.update({
                  where: { id: targetBooking.id },
                  data: bookingPendingUpdate(targetBooking, 'Saved payment method selected'),
                }),
              ]
            : []),
        ])
    );
  } catch (error) {
    if (error?.code === 'P2025') throw paymentProcessingError();
    throw error;
  }
  const updatedPayments = transactionResult.filter((item) => item && item.bookingId);

  res.json({
    success: true,
    message: booking.recurringGroupId
      ? 'Saved payment method selected for this recurring booking'
      : 'Saved payment method selected for this booking',
    data: serializePayment(updatedPayments[0]),
  });
};

exports.retryBookingPayment = async (req, res) => {
  const result = await retryFailedPayment({
    bookingId: req.params.bookingId,
    expectedVersion: Number(req.body.expectedVersion),
    actor: req.user,
  });
  const processing = result.outcome === 'PAYMENT_PROCESSING';
  const refreshed = await prisma.booking.findUnique({
    where: { id: req.params.bookingId },
    include: {
      payment: {
        include: {
          attempts: { orderBy: { sequence: 'desc' } },
        },
      },
    },
  });
  const source = refreshed || result.booking;
  const responseBooking = {
    id: source.id,
    status: result.outcome === 'ACCEPTED' ? 'ACCEPTED' : source.status,
    version: source.version,
    payment: serializePayment({
      ...source.payment,
      ...(result.outcome === 'ACCEPTED' ? { status: 'PAID' } : {}),
    }),
  };

  res.status(processing ? 202 : 200).json({
    success: true,
    outcome: result.outcome,
    message: processing
      ? 'Payment is processing; the booking remains pending'
      : 'Payment succeeded and the booking is accepted',
    data: responseBooking,
  });
};

// PAY-06. Earnings are always addressed through the authenticated tutor. The
// route accepts no tutor identifier, preventing financial records or totals
// from becoming an addressable cross-tutor resource.
exports.getTutorEarnings = async (req, res) => {
  await promoteMatureCompletionPayouts();
  const page = Number.parseInt(req.query.page, 10) || 1;
  const limit = Number.parseInt(req.query.limit, 10) || 20;
  const skip = (page - 1) * limit;
  const payoutStatus = req.query.payoutStatus || null;
  const where = {
    status: { in: earningPaymentStatuses },
    ...(payoutStatus ? { payoutStatus } : {}),
    booking: {
      is: {
        tutorId: req.user.tutorProfile.id,
        isTrialLesson: false,
      },
    },
  };

  const [summaryPayments, records, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      select: earningSelect,
    }),
    prisma.payment.findMany({
      where,
      select: earningSelect,
      orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
      skip,
      take: limit,
    }),
    prisma.payment.count({ where }),
  ]);

  res.json({
    success: true,
    data: {
      commissionPolicy: {
        percent: formatPercent(DEFAULT_PLATFORM_FEE_PERCENT),
        tutorPercent: formatPercent(100 - DEFAULT_PLATFORM_FEE_PERCENT),
      },
      summaries: buildEarningSummaries(summaryPayments),
      records: records.map(serializeEarningRecord),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    },
  });
};

// PAY-05. The tutor is taken from the authenticated session only; no route,
// query or body field names a tutor or an account, so one tutor's payout
// account is not an addressable resource for anyone else (AC5).
exports.getPayoutAccount = async (req, res) => {
  if (!isStripeConfigured()) {
    res.json({
      success: true,
      data: { status: 'UNAVAILABLE', isPayoutReady: false, providerConfigured: false },
    });
    return;
  }

  const refresh = req.query.refresh === 'true' || req.query.refresh === '1';
  const payoutAccount = await getPayoutAccountForTutor(req.user.tutorProfile.id, { refresh });

  // A tutor with no account yet gets the NOT_STARTED shape rather than a 404,
  // so the client renders one shape with no error branch.
  res.json({ success: true, data: serializePayoutAccount(payoutAccount) });
};

exports.createPayoutOnboardingLink = async (req, res) => {
  const { url, expiresAt } = await createOnboardingLink(req.user.tutorProfile.id);

  res.status(201).json({
    success: true,
    message: 'Payout onboarding link created',
    data: { url, expiresAt },
  });
};

exports.deleteSavedPaymentMethod = async (req, res) => {
  if (req.user.role !== 'LEARNER') {
    throw new AppError('Only learners can delete payment methods', 403);
  }

  const paymentMethodId = req.params.paymentMethodId || req.body?.paymentMethodId || null;

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      id: true,
      stripeCustomerId: true,
      stripeDefaultPaymentMethodId: true,
    },
  });

  if (!user) {
    throw new AppError('User not found', 404);
  }

  const targetPaymentMethodId = paymentMethodId || user.stripeDefaultPaymentMethodId;

  if (!targetPaymentMethodId) {
    res.json({
      success: true,
      message: 'No saved payment method to delete',
    });
    return;
  }

  if (!isStripeConfigured()) {
    throw new AppError('Payment setup is currently unavailable', 503);
  }

  if (!user.stripeCustomerId) {
    throw new AppError('Payment method not found', 404);
  }

  const stripe = getStripe();
  const paymentMethods = await getStripeCustomerMethods(
    stripe,
    user.stripeCustomerId,
    user.stripeDefaultPaymentMethodId
  );
  const ownsTargetPaymentMethod = paymentMethods.some(
    (method) => method.id === targetPaymentMethodId
  );

  if (!ownsTargetPaymentMethod) {
    throw new AppError('Payment method not found', 404);
  }

  const remainingMethods = paymentMethods.filter(
    (method) => method.id !== targetPaymentMethodId
  );

  const paymentLinkedBookingCount = await prisma.booking.count({
    where: {
      learnerId: req.user.id,
      status: {
        in: ['PENDING', 'ACCEPTED'],
      },
      payment: {
        is: {
          stripePaymentMethodId: targetPaymentMethodId,
          status: {
            in: pendingPaymentStatuses,
          },
        },
      },
    },
  });

  if (paymentLinkedBookingCount > 0) {
    throw new AppError('This card is still linked to bookings waiting for payment', 400);
  }

  let activeDefaultBookingCount = 0;

  if (targetPaymentMethodId === user.stripeDefaultPaymentMethodId) {
    activeDefaultBookingCount = await prisma.booking.count({
      where: {
        learnerId: req.user.id,
        status: {
          in: ['PENDING', 'ACCEPTED'],
        },
        payment: {
          is: {
            OR: [
              { stripePaymentMethodId: null },
              { stripePaymentMethodId: targetPaymentMethodId },
            ],
            status: {
              in: pendingPaymentStatuses,
            },
          },
        },
      },
    });
  }

  if (activeDefaultBookingCount > 0 && remainingMethods.length === 0) {
    throw new AppError('You need to keep at least one payment method while bookings are still waiting for payment', 400);
  }

  try {
    await stripe.paymentMethods.detach(targetPaymentMethodId);
  } catch {
    throw new AppError('Could not delete payment method. Please try again.', 502);
  }

  const nextDefaultPaymentMethodId =
    targetPaymentMethodId === user.stripeDefaultPaymentMethodId
      ? remainingMethods[0]?.id || null
      : user.stripeDefaultPaymentMethodId;

  await prisma.user.update({
    where: { id: req.user.id },
    data: {
      stripeDefaultPaymentMethodId: nextDefaultPaymentMethodId,
    },
  });

  res.json({
    success: true,
    message: 'Saved payment method deleted',
    data: {
      defaultPaymentMethodId: nextDefaultPaymentMethodId,
    },
  });
};

exports.handleStripeWebhook = async (req, res) => {
  if (!isStripeConfigured()) {
    res.status(503).json({
      success: false,
      message: 'Stripe is not configured',
      code: 'PAYMENT_PROVIDER_UNAVAILABLE',
    });
    return;
  }

  const stripe = getStripe();
  const signature = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    res.status(503).json({
      success: false,
      message: 'Stripe webhook verification is not configured',
      code: 'PAYMENT_PROVIDER_UNAVAILABLE',
    });
    return;
  }
  if (!signature) {
    res.status(400).send('Webhook Error: Missing Stripe signature');
    return;
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch {
    res.status(400).send('Webhook Error: Invalid Stripe signature');
    return;
  }

  switch (event.type) {
    case 'setup_intent.succeeded': {
      await recordWebhookEvent(event);
      break;
    }

    case 'payment_intent.succeeded': {
      await finalizeSuccessfulPaymentIntent(event.data.object, { webhookEvent: event });
      break;
    }

    case 'payment_intent.payment_failed': {
      const paymentIntent = event.data.object;
      const failureMessage =
        paymentIntent.last_payment_error?.message || 'Stripe payment failed';
      await finalizeFailedPaymentIntent(paymentIntent, failureMessage, { webhookEvent: event });
      break;
    }

    case 'account.updated': {
      await applyAccountUpdatedEvent(event);
      break;
    }

    case 'refund.created':
    case 'refund.updated':
    case 'refund.failed': {
      await applyRefundWebhookEvent(event);
      break;
    }

    default:
      await recordWebhookEvent(event);
      break;
  }

  res.json({ received: true });
};
