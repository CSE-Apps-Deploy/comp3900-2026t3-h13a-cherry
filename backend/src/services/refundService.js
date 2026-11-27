const { randomUUID } = require('crypto');

const { prisma } = require('../config/database');
const { getStripe, isStripeConfigured } = require('../config/stripe');
const { assertMatchingPaymentEnvironment } = require('../config/paymentEnvironment');
const logger = require('../config/logger');
const { AppError } = require('../middleware/errorHandler');
const { createWebhookReceipt } = require('./paymentAcceptanceService');
const { toMinorUnits } = require('../utils/earnings');

const REFUND_SOURCES = Object.freeze({
  TUTOR_NON_COMPLETION: 'TUTOR_NON_COMPLETION',
  ADMIN_COMPLETION_DISPUTE: 'ADMIN_COMPLETION_DISPUTE',
});

const CAPTURED_PAYMENT_STATUSES = new Set(['PAID', 'COMPLETED', 'PARTIALLY_REFUNDED']);
const BLOCKING_PAYOUT_STATUSES = new Set(['PROCESSING', 'PAID']);

const refundInclude = {
  attempts: { orderBy: { sequence: 'desc' } },
  payment: {
    include: {
      booking: {
        include: {
          learner: { select: { id: true, firstName: true, lastName: true } },
          tutorProfile: {
            include: {
              user: { select: { id: true, firstName: true, lastName: true } },
            },
          },
        },
      },
    },
  },
};

const toMoney = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const serializeRefund = (refund) => {
  if (!refund) return null;
  return {
    id: refund.id,
    source: refund.source,
    amount: toMoney(refund.amount).toFixed(2),
    currency: String(refund.currency || 'AUD').toUpperCase(),
    status: refund.status,
    resolutionNote: refund.resolutionNote,
    failureReason: refund.failureReason || null,
    requestedAt: refund.requestedAt,
    failedAt: refund.failedAt || null,
    completedAt: refund.completedAt || null,
    attemptCount: Number(refund.attemptCount || 0),
  };
};

const isCapturedPayment = (payment) =>
  CAPTURED_PAYMENT_STATUSES.has(String(payment?.status || '').toUpperCase());

const getRefundAmounts = (payment) => {
  const originalAmount = toMoney(payment?.amount);
  const alreadyRefunded = Math.min(originalAmount, Math.max(0, toMoney(payment?.refundAmount)));
  return {
    originalAmount,
    alreadyRefunded,
    outstandingAmount: toMoney(originalAmount - alreadyRefunded),
  };
};

const assertRefundablePayment = (payment) => {
  if (!payment || !isCapturedPayment(payment)) {
    throw new AppError('This lesson does not have a captured payment to refund.', 409);
  }
  if (BLOCKING_PAYOUT_STATUSES.has(String(payment.payoutStatus || '').toUpperCase())) {
    throw new AppError(
      'This tutor earning is already being paid or has been paid. The refund cannot be approved.',
      409
    );
  }

  const amounts = getRefundAmounts(payment);
  if (amounts.outstandingAmount <= 0) {
    throw new AppError('This lesson payment has already been fully refunded.', 409);
  }
  return amounts;
};

/**
 * Reserve the one permitted PAY-08 refund while the caller holds the booking
 * advisory lock. This removes the earning from payout eligibility before any
 * provider request can occur.
 */
const createRefundClaim = async (
  tx,
  { payment, initiatedById, source, resolutionNote }
) => {
  if (!payment) assertRefundablePayment(payment);
  const existing = await tx.paymentRefund.findUnique({
    where: { paymentId: payment.id },
    include: { attempts: { orderBy: { sequence: 'desc' } } },
  });
  if (existing) return existing;
  const amounts = assertRefundablePayment(payment);
  const refundId = randomUUID();

  const refund = await tx.paymentRefund.create({
    data: {
      id: refundId,
      paymentId: payment.id,
      initiatedById,
      source,
      amount: amounts.outstandingAmount,
      currency: String(payment.currency || 'AUD').toUpperCase(),
      status: 'PROCESSING',
      attemptCount: 1,
      resolutionNote,
      attempts: {
        create: {
          sequence: 1,
          status: 'PROCESSING',
          idempotencyKey: `pay08_refund_${refundId}_attempt_1`,
        },
      },
    },
    include: { attempts: { orderBy: { sequence: 'desc' } } },
  });

  await tx.payment.update({
    where: { id: payment.id },
    data: {
      // refundAmount represents the final financial decision. refundedAt and
      // Payment.status remain provider-confirmed fields.
      refundAmount: amounts.originalAmount,
      refundedAt: null,
      platformFeeAmount: 0,
      tutorPayoutAmount: 0,
      payoutStatus: null,
      payoutEligibleAt: null,
      payoutAt: null,
      payoutFailedAt: null,
      payoutFailureReason: null,
    },
  });

  return refund;
};

const mapProviderRefundStatus = (status) => {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'succeeded') return 'SUCCEEDED';
  if (normalized === 'failed' || normalized === 'canceled') return 'FAILED';
  return 'PROCESSING';
};

const getStripeObjectId = (value) => {
  if (typeof value === 'string') return value;
  if (value?.id) return String(value.id);
  return null;
};

const providerRefundMatchesClaim = (providerRefund, refund, attempt) => {
  const metadata = providerRefund?.metadata || {};
  return Boolean(
    providerRefund?.id &&
      attempt?.id &&
      metadata.paymentRefundId === refund.id &&
      metadata.paymentRefundAttemptId === attempt.id &&
      metadata.paymentId === refund.paymentId &&
      metadata.bookingId === String(refund.payment?.bookingId || refund.payment?.booking?.id || '') &&
      metadata.source === refund.source &&
      getStripeObjectId(providerRefund.payment_intent) === refund.payment?.stripePaymentIntentId &&
      Number(providerRefund.amount) === toMinorUnits(refund.amount) &&
      String(providerRefund.currency || '').toUpperCase() ===
        String(refund.currency || '').toUpperCase() &&
      (!attempt.providerRefundId || attempt.providerRefundId === providerRefund.id)
  );
};

const findExistingProviderRefund = async (stripe, refund) => {
  const matches = [];
  let startingAfter;

  do {
    const page = await stripe.refunds.list({
      payment_intent: refund.payment.stripePaymentIntentId,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    const providerRefunds = Array.isArray(page?.data) ? page.data : [];
    for (const providerRefund of providerRefunds) {
      const attempt = (refund.attempts || []).find(
        (candidate) =>
          candidate.id === providerRefund?.metadata?.paymentRefundAttemptId ||
          candidate.providerRefundId === providerRefund?.id
      );
      if (attempt && providerRefundMatchesClaim(providerRefund, refund, attempt)) {
        matches.push({ providerRefund, attempt });
      }
    }

    const lastId = providerRefunds.at(-1)?.id;
    if (!page?.has_more || !lastId || lastId === startingAfter) break;
    startingAfter = lastId;
  } while (true);

  const statusPriority = { SUCCEEDED: 3, PROCESSING: 2, FAILED: 1 };
  const actionableMatches = matches.filter(
    ({ providerRefund, attempt }) =>
      mapProviderRefundStatus(providerRefund.status) !== 'FAILED' ||
      Number(attempt.sequence) === Number(refund.attemptCount)
  );
  return actionableMatches.sort((left, right) => {
    const statusDifference =
      statusPriority[mapProviderRefundStatus(right.providerRefund.status)] -
      statusPriority[mapProviderRefundStatus(left.providerRefund.status)];
    if (statusDifference) return statusDifference;
    const leftCurrent = Number(left.attempt.sequence) === Number(refund.attemptCount) ? 1 : 0;
    const rightCurrent = Number(right.attempt.sequence) === Number(refund.attemptCount) ? 1 : 0;
    return rightCurrent - leftCurrent;
  })[0] || null;
};

const safeRefundFailure = (error) => {
  const code = String(error?.code || error?.raw?.code || '').trim();
  if (code === 'charge_already_refunded') {
    return 'Stripe reports that the original payment has already been refunded.';
  }
  if (code === 'balance_insufficient') {
    return 'The platform Stripe balance cannot cover this refund yet. An administrator can retry it.';
  }
  return code
    ? `Stripe could not process the refund (${code}). It can be retried safely.`
    : 'Stripe could not process the refund. It can be retried safely.';
};

const isIndeterminateProviderError = (error) => {
  const type = String(error?.type || error?.rawType || '');
  const code = String(error?.code || error?.errno || '').toUpperCase();
  const statusCode = Number(error?.statusCode || error?.status || 0);
  return (
    type === 'StripeConnectionError' ||
    type === 'StripeAPIError' ||
    statusCode >= 500 ||
    ['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ENOTFOUND'].includes(code)
  );
};

const applyRefundState = async (
  database,
  refund,
  attempt,
  providerRefund,
  nextStatus,
  failureReason = null
) => {
  if (typeof database.$executeRaw === 'function') {
    await database.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${refund.id}))`;
  }
  const now = new Date();
  const [currentRefund, currentAttempt] = await Promise.all([
    database.paymentRefund.findUnique({ where: { id: refund.id } }),
    database.paymentRefundAttempt.findUnique({ where: { id: attempt.id } }),
  ]);
  if (!currentRefund || !currentAttempt) return currentRefund;
  const resolvedState =
    typeof nextStatus === 'function'
      ? nextStatus({ currentRefund, currentAttempt })
      : { status: nextStatus, failureReason };
  const resolvedNextStatus = resolvedState.status;
  const resolvedFailureReason = resolvedState.failureReason || null;
  if (currentRefund.status === 'SUCCEEDED' || currentAttempt.status === 'SUCCEEDED') {
    return currentRefund;
  }
  if (currentAttempt.status === 'FAILED' && resolvedNextStatus !== 'SUCCEEDED') {
    return currentRefund;
  }
  if (
    resolvedNextStatus === 'PROCESSING' &&
    Number(currentRefund.attemptCount) !== Number(attempt.sequence)
  ) {
    return currentRefund;
  }

  await database.paymentRefundAttempt.update({
    where: { id: attempt.id },
    data: {
      status: resolvedNextStatus,
      ...(providerRefund?.id ? { providerRefundId: providerRefund.id } : {}),
      providerStatus: providerRefund?.status || null,
      failureReason: resolvedNextStatus === 'SUCCEEDED' ? null : resolvedFailureReason,
      failedAt: resolvedNextStatus === 'FAILED' ? now : null,
      completedAt: resolvedNextStatus === 'SUCCEEDED' ? now : null,
    },
  });

  // A confirmed provider success is definitive even if it belongs to an
  // earlier attempt. Conversely, an older failure remains in the audit trail
  // and cannot overwrite a newer attempt or an already-successful refund.
  if (
    resolvedNextStatus !== 'SUCCEEDED' &&
    (currentRefund.status === 'SUCCEEDED' ||
      Number(currentRefund.attemptCount) !== Number(attempt.sequence))
  ) {
    return currentRefund;
  }

  const updated = await database.paymentRefund.update({
    where: { id: refund.id },
    data: {
      status: resolvedNextStatus,
      failureReason: resolvedNextStatus === 'SUCCEEDED' ? null : resolvedFailureReason,
      failedAt: resolvedNextStatus === 'FAILED' ? now : null,
      completedAt: resolvedNextStatus === 'SUCCEEDED' ? now : null,
    },
  });

  if (resolvedNextStatus === 'SUCCEEDED') {
    await database.payment.update({
      where: { id: refund.paymentId },
      data: {
        status: 'REFUNDED',
        refundAmount: toMoney(refund.payment.amount),
        refundedAt: now,
        platformFeeAmount: 0,
        tutorPayoutAmount: 0,
        payoutStatus: null,
        payoutEligibleAt: null,
        payoutAt: null,
        payoutFailedAt: null,
        payoutFailureReason: null,
      },
    });
  }

  return updated;
};

const failRefund = async (refund, attempt, failureReason) =>
  prisma.$transaction((tx) =>
    applyRefundState(tx, refund, attempt, null, 'FAILED', failureReason)
  );

const claimRefundAttempt = async (refundId) =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${refundId}))`;
    const refund = await tx.paymentRefund.findUnique({
      where: { id: refundId },
      include: refundInclude,
    });
    if (!refund) throw new AppError('Refund record not found.', 404);
    if (refund.status === 'SUCCEEDED') return refund;

    const latestAttempt = refund.attempts?.[0] || null;
    if (refund.status === 'PROCESSING' && latestAttempt) return refund;

    const sequence = Number(refund.attemptCount || 0) + 1;
    await tx.paymentRefundAttempt.create({
      data: {
        refundId: refund.id,
        sequence,
        status: 'PROCESSING',
        idempotencyKey: `pay08_refund_${refund.id}_attempt_${sequence}`,
      },
    });
    const updated = await tx.paymentRefund.update({
      where: { id: refund.id },
      data: {
        status: 'PROCESSING',
        attemptCount: sequence,
        failureReason: null,
        failedAt: null,
      },
      include: refundInclude,
    });
    return updated;
  });

const beginProviderRefundRequest = async (refund, attempt) =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${refund.id}))`;
    const [currentRefund, currentAttempt] = await Promise.all([
      tx.paymentRefund.findUnique({ where: { id: refund.id } }),
      tx.paymentRefundAttempt.findUnique({ where: { id: attempt.id } }),
    ]);
    if (!currentRefund || !currentAttempt) {
      throw new AppError('Refund attempt not found.', 404);
    }
    if (
      currentRefund.status !== 'PROCESSING' ||
      currentAttempt.status !== 'PROCESSING' ||
      Number(currentRefund.attemptCount) !== Number(currentAttempt.sequence)
    ) {
      return { shouldSubmit: false, refund: currentRefund };
    }

    const providerRequestStartedAt = currentAttempt.providerRequestStartedAt || new Date();
    if (!currentAttempt.providerRequestStartedAt) {
      await tx.paymentRefundAttempt.update({
        where: { id: currentAttempt.id },
        data: { providerRequestStartedAt },
      });
    }
    return { shouldSubmit: true, providerRequestStartedAt };
  });

const submitRefund = async (refundId) => {
  const refund = await claimRefundAttempt(refundId);
  assertMatchingPaymentEnvironment(refund.payment);
  if (refund.status === 'SUCCEEDED') return refund;
  const attempt = refund.attempts?.[0];
  if (!attempt) throw new AppError('Refund attempt not found.', 500);

  if (!isStripeConfigured()) {
    return failRefund(
      refund,
      attempt,
      'Stripe refunds are not configured. An administrator can retry after configuration is restored.'
    );
  }
  if (!refund.payment?.stripePaymentIntentId) {
    return failRefund(
      refund,
      attempt,
      'The original Stripe payment reference is missing. An administrator must review this refund.'
    );
  }

  const stripe = getStripe();
  try {
    const existing = await findExistingProviderRefund(stripe, refund);
    if (existing) {
      const nextStatus = mapProviderRefundStatus(existing.providerRefund.status);
      const failureReason =
        nextStatus === 'FAILED'
          ? existing.providerRefund.failure_reason ||
            'Stripe marked the refund as failed. It can be retried safely.'
          : null;
      return prisma.$transaction((tx) =>
        applyRefundState(
          tx,
          refund,
          existing.attempt,
          existing.providerRefund,
          nextStatus,
          failureReason
        )
      );
    }
  } catch (error) {
    logger.warn(`Could not reconcile Stripe refund ${refund.id}:`, error);
    return prisma.$transaction((tx) =>
      applyRefundState(
        tx,
        refund,
        attempt,
        null,
        ({ currentAttempt }) => {
          const providerRequestStarted = Boolean(currentAttempt.providerRequestStartedAt);
          return {
            status: providerRequestStarted ? 'PROCESSING' : 'FAILED',
            failureReason: providerRequestStarted
              ? 'Stripe refund history could not be reconciled after a provider request started. The same request will be reconciled safely when provider access is restored.'
              : 'Stripe refund history could not be reconciled. No new refund request was sent; retry is safe once provider access is restored.',
          };
        }
      )
    );
  }

  let providerRefund = null;
  try {
    const providerRequest = await beginProviderRefundRequest(refund, attempt);
    if (!providerRequest.shouldSubmit) return providerRequest.refund;
    attempt.providerRequestStartedAt = providerRequest.providerRequestStartedAt;

    providerRefund = await stripe.refunds.create(
      {
        payment_intent: refund.payment.stripePaymentIntentId,
        amount: toMinorUnits(refund.amount),
        metadata: {
          paymentRefundId: refund.id,
          paymentRefundAttemptId: attempt.id,
          paymentId: refund.paymentId,
          bookingId: refund.payment.booking?.id || '',
          source: refund.source,
          platform: 'tutorconnect',
        },
      },
      { idempotencyKey: attempt.idempotencyKey }
    );

    const nextStatus = mapProviderRefundStatus(providerRefund?.status);
    const failureReason =
      nextStatus === 'FAILED'
        ? providerRefund?.failure_reason || 'Stripe marked the refund as failed. It can be retried safely.'
        : null;
    return prisma.$transaction((tx) =>
      applyRefundState(tx, refund, attempt, providerRefund, nextStatus, failureReason)
    );
  } catch (error) {
    if (providerRefund) {
      logger.error(`Could not persist provider refund ${providerRefund.id}:`, error);
      throw error;
    }

    if (isIndeterminateProviderError(error)) {
      const failureReason =
        'Stripe did not return a definitive result. Retrying uses the same request key and cannot create a duplicate refund.';
      logger.warn(`Stripe refund result is indeterminate for refund ${refund.id}:`, error);
      return prisma.$transaction((tx) =>
        applyRefundState(tx, refund, attempt, null, 'PROCESSING', failureReason)
      );
    }

    logger.error(`Stripe refund failed for refund ${refund.id}:`, error);
    return failRefund(refund, attempt, safeRefundFailure(error));
  }
};

const applyRefundWebhookEvent = async (event) => {
  const providerRefund = event?.data?.object;
  if (!event?.id || !providerRefund) return { outcome: 'IGNORED' };

  try {
    return await prisma.$transaction(async (tx) => {
      await createWebhookReceipt(tx, event);
      const metadataAttemptId = providerRefund.metadata?.paymentRefundAttemptId || null;
      if (!metadataAttemptId) return { outcome: 'IGNORED' };
      const attempt = await tx.paymentRefundAttempt.findUnique({
        where: { id: metadataAttemptId },
        include: { refund: { include: { payment: true } } },
      });
      if (!attempt?.refund) return { outcome: 'IGNORED' };
      const refund = attempt.refund;
      if (!providerRefundMatchesClaim(providerRefund, refund, attempt)) {
        return { outcome: 'IGNORED' };
      }

      const nextStatus = mapProviderRefundStatus(providerRefund.status);
      const failureReason =
        nextStatus === 'FAILED'
          ? providerRefund.failure_reason || 'Stripe marked the refund as failed.'
          : null;
      const updated = await applyRefundState(
        tx,
        refund,
        attempt,
        providerRefund,
        nextStatus,
        failureReason
      );
      return { outcome: 'APPLIED', refund: updated };
    });
  } catch (error) {
    if (error?.code === 'P2002') return { outcome: 'DUPLICATE_EVENT' };
    throw error;
  }
};

module.exports = {
  REFUND_SOURCES,
  refundInclude,
  serializeRefund,
  isCapturedPayment,
  getRefundAmounts,
  assertRefundablePayment,
  createRefundClaim,
  claimRefundAttempt,
  submitRefund,
  applyRefundWebhookEvent,
  mapProviderRefundStatus,
  safeRefundFailure,
  isIndeterminateProviderError,
  providerRefundMatchesClaim,
  findExistingProviderRefund,
};
