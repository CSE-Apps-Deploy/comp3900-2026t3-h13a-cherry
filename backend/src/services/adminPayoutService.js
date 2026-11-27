const { prisma } = require('../config/database');
const { getStripe, isStripeConfigured } = require('../config/stripe');
const { assertMatchingPaymentEnvironment } = require('../config/paymentEnvironment');
const logger = require('../config/logger');
const { AppError } = require('../middleware/errorHandler');
const { notifyOrRefresh } = require('./notificationService');
const { promoteMatureCompletionPayouts } = require('./completionReviewService');
const { serializeRefund } = require('./refundService');
const { toMinorUnits } = require('../utils/earnings');

const PAYOUT_CANDIDATE_STATUSES = ['ELIGIBLE', 'FAILED'];
const DEFAULT_PAGE_SIZE = 20;
const payoutBookingResolutionWhere = {
  OR: [
    { status: 'CANCELLED' },
    { status: 'COMPLETED', completionReviewStatus: 'CLEARED' },
  ],
};

const payoutCandidateInclude = {
  booking: {
    include: {
      learner: { select: { id: true, firstName: true, lastName: true, email: true } },
      tutorProfile: {
        include: {
          user: { select: { id: true, firstName: true, lastName: true, email: true } },
          payoutAccount: true,
        },
      },
    },
  },
};

const transferReceiptInclude = {
  tutorProfile: {
    include: {
      user: { select: { id: true, firstName: true, lastName: true, email: true } },
      payoutAccount: true,
    },
  },
  items: {
    include: {
      payment: {
        include: {
          booking: {
            select: {
              id: true,
              subject: true,
              scheduledAt: true,
              completedAt: true,
              learner: { select: { id: true, firstName: true, lastName: true } },
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  },
};

const refundOverviewInclude = {
  payment: {
    include: {
      booking: {
        include: {
          learner: { select: { id: true, firstName: true, lastName: true, email: true } },
          tutorProfile: {
            include: {
              user: { select: { id: true, firstName: true, lastName: true, email: true } },
            },
          },
        },
      },
    },
  },
};

const groupKey = (payment) =>
  `${payment.booking.tutorId}:${String(payment.currency || 'AUD').toUpperCase()}`;

const groupPayoutCandidates = (payments) => {
  const groups = new Map();

  payments.forEach((payment) => {
    const key = groupKey(payment);
    const currency = String(payment.currency || 'AUD').toUpperCase();
    const amountMinor = toMinorUnits(payment.tutorPayoutAmount);
    const current = groups.get(key) || {
      key,
      tutorProfileId: payment.booking.tutorId,
      tutor: payment.booking.tutorProfile,
      payoutAccount: payment.booking.tutorProfile?.payoutAccount || null,
      currency,
      amountMinor: 0,
      payments: [],
    };

    current.amountMinor += amountMinor;
    current.payments.push(payment);
    groups.set(key, current);
  });

  return [...groups.values()].map((group) => ({
    ...group,
    amount: (group.amountMinor / 100).toFixed(2),
    paymentCount: group.payments.length,
  }));
};

const serializeCandidatePayment = (payment) => ({
  id: payment.id,
  ...(String(payment.stripePaymentIntentId || '').startsWith('fake_') ? { isTestPayment: true } : {}),
  amount: Number(payment.tutorPayoutAmount || 0).toFixed(2),
  currency: String(payment.currency || 'AUD').toUpperCase(),
  payoutStatus: payment.payoutStatus,
  payoutEligibleAt: payment.payoutEligibleAt || null,
  payoutFailureReason: payment.payoutFailureReason || null,
  lesson: {
    id: payment.booking.id,
    subject: payment.booking.subject,
    scheduledAt: payment.booking.scheduledAt,
    completedAt: payment.booking.completedAt || null,
    learner: payment.booking.learner,
  },
});

const serializeCandidateGroup = (group, { openDisputeCount = 0 } = {}) => ({
  key: group.key,
  tutor: {
    id: group.tutorProfileId,
    firstName: group.tutor?.user?.firstName || '',
    lastName: group.tutor?.user?.lastName || '',
    email: group.tutor?.user?.email || '',
  },
  currency: group.currency,
  amount: group.amount,
  paymentCount: group.paymentCount,
  openDisputeCount,
  payoutAccountReady: Boolean(group.payoutAccount?.isPayoutReady),
  payoutAccountStatus: group.payoutAccount?.status || 'NOT_STARTED',
  payments: group.payments.map(serializeCandidatePayment),
});

const serializeTransfer = (transfer) => ({
  id: transfer.id,
  ...((String(transfer.providerTransferId || '').startsWith('fake_') || (transfer.items || []).some((item) => String(item.payment?.stripePaymentIntentId || '').startsWith('fake_'))) ? { isTestPayment: true } : {}),
  status: transfer.status,
  amount: Number(transfer.amount || 0).toFixed(2),
  currency: String(transfer.currency || 'AUD').toUpperCase(),
  providerTransferId: transfer.providerTransferId || null,
  failureReason: transfer.failureReason || null,
  attemptedAt: transfer.attemptedAt,
  completedAt: transfer.completedAt || null,
  tutor: {
    id: transfer.tutorProfileId,
    firstName: transfer.tutorProfile?.user?.firstName || '',
    lastName: transfer.tutorProfile?.user?.lastName || '',
    email: transfer.tutorProfile?.user?.email || '',
  },
  lessons: (transfer.items || []).map((item) => ({
    paymentId: item.paymentId,
    amount: Number(item.amount || 0).toFixed(2),
    bookingId: item.payment?.booking?.id || null,
    subject: item.payment?.booking?.subject || 'Lesson',
    scheduledAt: item.payment?.booking?.scheduledAt || null,
    completedAt: item.payment?.booking?.completedAt || null,
    learner: item.payment?.booking?.learner || null,
  })),
});

const serializeRun = (run) => ({
  id: run.id,
  status: run.status,
  paymentCount: run.paymentCount,
  transferCount: run.transferCount,
  successfulTransferCount: run.successfulTransferCount,
  failedTransferCount: run.failedTransferCount,
  startedAt: run.startedAt,
  completedAt: run.completedAt || null,
  initiatedBy: run.initiatedByAdmin
    ? {
        id: run.initiatedByAdmin.id,
        firstName: run.initiatedByAdmin.firstName,
        lastName: run.initiatedByAdmin.lastName,
        role: run.initiatedByAdmin.role,
      }
    : null,
  transfers: (run.transfers || []).map(serializeTransfer),
});

const getPayoutOverview = async () => {
  await promoteMatureCompletionPayouts();

  const [
    candidatePayments,
    disputedBookings,
    actionableRefunds,
    recentCompletedRefunds,
    processingPayments,
  ] = await Promise.all([
    prisma.payment.findMany({
      where: {
        payoutStatus: { in: PAYOUT_CANDIDATE_STATUSES },
        tutorPayoutAmount: { gt: 0 },
        booking: { is: payoutBookingResolutionWhere },
      },
      include: payoutCandidateInclude,
      orderBy: [{ payoutEligibleAt: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.booking.findMany({
      where: { status: 'COMPLETED', completionReviewStatus: 'DISPUTED' },
      include: {
        learner: { select: { id: true, firstName: true, lastName: true, email: true } },
        tutorProfile: {
          include: {
            user: { select: { id: true, firstName: true, lastName: true, email: true } },
          },
        },
        payment: true,
      },
      orderBy: { completionDisputedAt: 'asc' },
    }),
    prisma.paymentRefund.findMany({
      where: { status: { in: ['PROCESSING', 'FAILED'] } },
      include: refundOverviewInclude,
      orderBy: { requestedAt: 'asc' },
    }),
    prisma.paymentRefund.findMany({
      where: { status: 'SUCCEEDED' },
      include: refundOverviewInclude,
      orderBy: { requestedAt: 'desc' },
      take: 20,
    }),
    prisma.payment.count({ where: { payoutStatus: 'PROCESSING' } }),
  ]);

  const refunds = [...actionableRefunds, ...recentCompletedRefunds].sort(
    (left, right) => new Date(right.requestedAt).getTime() - new Date(left.requestedAt).getTime()
  );

  const allGroups = groupPayoutCandidates(candidatePayments);
  const disputeCountByTutor = disputedBookings.reduce((counts, booking) => {
    const tutorProfileId = booking.tutorId;
    counts.set(tutorProfileId, (counts.get(tutorProfileId) || 0) + 1);
    return counts;
  }, new Map());
  const readyGroups = allGroups.filter(
    (group) => group.payoutAccount?.isPayoutReady && group.amountMinor > 0
  );
  const blockedGroups = allGroups.filter(
    (group) => !group.payoutAccount?.isPayoutReady || group.amountMinor <= 0
  );

  return {
    providerConfigured: isStripeConfigured(),
    readyGroups: readyGroups.map((group) =>
      serializeCandidateGroup(group, {
        openDisputeCount: disputeCountByTutor.get(group.tutorProfileId) || 0,
      })
    ),
    blockedGroups: blockedGroups.map((group) =>
      serializeCandidateGroup(group, {
        openDisputeCount: disputeCountByTutor.get(group.tutorProfileId) || 0,
      })
    ),
    disputed: disputedBookings.map((booking) => ({
      id: booking.id,
      ...(String(booking.payment?.stripePaymentIntentId || '').startsWith('fake_') ? { isTestPayment: true } : {}),
      bookingId: booking.id,
      version: booking.version,
      paymentId: booking.payment?.id || null,
      amount: Number(booking.payment?.tutorPayoutAmount || 0).toFixed(2),
      currency: String(booking.payment?.currency || booking.currency || 'AUD').toUpperCase(),
      payoutStatus: booking.payment?.payoutStatus || null,
      isTrialLesson: Boolean(booking.isTrialLesson),
      refundQuote: {
        amount: booking.isTrialLesson
          ? '0.00'
          : Math.max(
              0,
              Number(booking.payment?.amount || 0) - Number(booking.payment?.refundAmount || 0)
            ).toFixed(2),
        currency: String(booking.payment?.currency || booking.currency || 'AUD').toUpperCase(),
      },
      lesson: {
        id: booking.id,
        subject: booking.subject,
        scheduledAt: booking.scheduledAt,
        completedAt: booking.completedAt || null,
        learner: booking.learner,
      },
      dispute: {
        reason: booking.completionDisputeReason || null,
        disputedAt: booking.completionDisputedAt || null,
      },
      tutor: {
        id: booking.tutorId,
        firstName: booking.tutorProfile?.user?.firstName || '',
        lastName: booking.tutorProfile?.user?.lastName || '',
        email: booking.tutorProfile?.user?.email || '',
      },
    })),
    refunds: refunds.map((refund) => {
      const booking = refund.payment?.booking;
      return {
        ...serializeRefund(refund),
        ...(String(refund.payment?.stripePaymentIntentId || '').startsWith('fake_') ? { isTestPayment: true } : {}),
        bookingId: booking?.id || null,
        lesson: booking
          ? {
              id: booking.id,
              subject: booking.subject,
              scheduledAt: booking.scheduledAt,
              learner: booking.learner,
            }
          : null,
        tutor: booking
          ? {
              id: booking.tutorId,
              firstName: booking.tutorProfile?.user?.firstName || '',
              lastName: booking.tutorProfile?.user?.lastName || '',
              email: booking.tutorProfile?.user?.email || '',
            }
          : null,
        canRetry: refund.status === 'FAILED' || refund.status === 'PROCESSING',
      };
    }),
    counts: {
      readyTransfers: readyGroups.length,
      readyPayments: readyGroups.reduce((sum, group) => sum + group.paymentCount, 0),
      blockedTransfers: blockedGroups.length,
      disputedPayments: disputedBookings.length,
      processingPayments,
      refundsProcessing: actionableRefunds.filter((refund) => refund.status === 'PROCESSING').length,
      refundsFailed: actionableRefunds.filter((refund) => refund.status === 'FAILED').length,
    },
  };
};

const createPayoutRunClaim = async (adminId, { tutorProfileId } = {}) =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('tutorconnect_admin_payout_run'))`;

    const payments = await tx.payment.findMany({
      where: {
        payoutStatus: { in: PAYOUT_CANDIDATE_STATUSES },
        tutorPayoutAmount: { gt: 0 },
        booking: {
          is: {
            ...payoutBookingResolutionWhere,
            ...(tutorProfileId ? { tutorId: tutorProfileId } : {}),
            tutorProfile: { is: { payoutAccount: { is: { isPayoutReady: true } } } },
          },
        },
      },
      include: payoutCandidateInclude,
      orderBy: [{ payoutEligibleAt: 'asc' }, { createdAt: 'asc' }],
    });

    payments.forEach(assertMatchingPaymentEnvironment);
    const groups = groupPayoutCandidates(payments).filter((group) => group.amountMinor > 0);
    if (!groups.length) {
      throw new AppError(
        tutorProfileId
          ? 'This tutor has no eligible payouts with a ready payout account.'
          : 'There are no eligible payouts with a ready tutor account.',
        409
      );
    }

    const run = await tx.payoutRun.create({
      data: {
        initiatedByAdminId: adminId,
        paymentCount: payments.length,
        transferCount: groups.length,
      },
    });

    const transfers = [];
    for (const group of groups) {
      const transfer = await tx.payoutTransfer.create({
        data: {
          payoutRunId: run.id,
          tutorProfileId: group.tutorProfileId,
          amount: group.amount,
          currency: group.currency,
          idempotencyKey: `payout-run:${run.id}:tutor:${group.tutorProfileId}:currency:${group.currency}`,
          items: {
            create: group.payments.map((payment) => ({
              paymentId: payment.id,
              amount: Number(payment.tutorPayoutAmount || 0).toFixed(2),
            })),
          },
        },
        include: transferReceiptInclude,
      });

      const claimed = await tx.payment.updateMany({
        where: {
          id: { in: group.payments.map((payment) => payment.id) },
          payoutStatus: { in: PAYOUT_CANDIDATE_STATUSES },
        },
        data: {
          payoutStatus: 'PROCESSING',
          payoutFailedAt: null,
          payoutFailureReason: null,
        },
      });

      if (Number(claimed?.count || 0) !== group.payments.length) {
        throw new AppError('Payout records changed while the run was being created. Please retry.', 409);
      }
      transfers.push(transfer);
    }

    return { ...run, transfers };
  });

const safeTransferFailure = (error) => {
  const code = String(error?.code || error?.raw?.code || '').trim();
  if (code === 'balance_insufficient') {
    return 'The platform Stripe balance is not yet available for this transfer. Retry it in a later payout run.';
  }
  if (code === 'account_invalid' || code === 'destination_account_invalid') {
    return 'The tutor payout account could not receive this transfer. Review the connected account in Stripe.';
  }
  return code
    ? `Stripe could not create this transfer (${code}). It can be retried in a later payout run.`
    : 'Stripe could not create this transfer. It can be retried in a later payout run.';
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

const notifyTutorOfTransfer = async (transfer, succeeded) => {
  const userId = transfer.tutorProfile?.user?.id;
  if (!userId) return;
  try {
    await notifyOrRefresh(
      userId,
      'payment',
      succeeded ? 'Earnings transferred' : 'Earnings transfer delayed',
      succeeded
        ? `${transfer.currency} ${Number(transfer.amount).toFixed(2)} was transferred to your connected Stripe balance.`
        : `${transfer.currency} ${Number(transfer.amount).toFixed(2)} could not be transferred yet. TutorConnect will retry it.`,
      '/tutor/payouts'
    );
  } catch (error) {
    logger.warn(`Could not send payout notification for transfer ${transfer.id}:`, error);
  }
};

const executeTransfer = async (transfer) => {
  const stripeAccountId = transfer.tutorProfile?.payoutAccount?.stripeAccountId;
  const paymentIds = transfer.items.map((item) => item.paymentId);
  const now = new Date();

  if (!stripeAccountId || !transfer.tutorProfile?.payoutAccount?.isPayoutReady) {
    const failureReason = 'The tutor payout account is not ready to receive transfers.';
    const failed = await prisma.$transaction(async (tx) => {
      const updated = await tx.payoutTransfer.update({
        where: { id: transfer.id },
        data: { status: 'FAILED', failureReason, completedAt: now },
        include: transferReceiptInclude,
      });
      await tx.payment.updateMany({
        where: { id: { in: paymentIds }, payoutStatus: 'PROCESSING' },
        data: { payoutStatus: 'FAILED', payoutFailedAt: now, payoutFailureReason: failureReason },
      });
      return updated;
    });
    await notifyTutorOfTransfer(failed, false);
    return failed;
  }

  let providerTransfer = null;
  try {
    (transfer.items || []).forEach((item) => assertMatchingPaymentEnvironment(item.payment));
    providerTransfer = await getStripe().transfers.create(
      {
        amount: toMinorUnits(transfer.amount),
        currency: String(transfer.currency).toLowerCase(),
        destination: stripeAccountId,
        metadata: {
          payoutRunId: transfer.payoutRunId,
          payoutTransferId: transfer.id,
          tutorProfileId: transfer.tutorProfileId,
          platform: 'tutorconnect',
        },
      },
      { idempotencyKey: transfer.idempotencyKey }
    );
    const completedAt = new Date();
    const succeeded = await prisma.$transaction(async (tx) => {
      const updated = await tx.payoutTransfer.update({
        where: { id: transfer.id },
        data: {
          status: 'SUCCEEDED',
          providerTransferId: providerTransfer.id,
          failureReason: null,
          completedAt,
        },
        include: transferReceiptInclude,
      });
      await tx.payment.updateMany({
        where: { id: { in: paymentIds }, payoutStatus: 'PROCESSING' },
        data: {
          payoutStatus: 'PAID',
          payoutAt: completedAt,
          payoutFailedAt: null,
          payoutFailureReason: null,
        },
      });
      return updated;
    });
    await notifyTutorOfTransfer(succeeded, true);
    return succeeded;
  } catch (error) {
    // Once Stripe returned a transfer object, the provider side is definitive.
    // A following database error must leave the claim PROCESSING so replaying
    // the same idempotency key can reconcile it without paying twice.
    if (providerTransfer) {
      logger.error(`Could not persist successful payout transfer ${transfer.id}:`, error);
      throw error;
    }

    if (isIndeterminateProviderError(error)) {
      const failureReason =
        'Stripe did not return a definitive transfer result. The same transfer will be reconciled safely on the next admin payout action.';
      logger.warn(`Stripe transfer result is indeterminate for payout transfer ${transfer.id}:`, error);
      return prisma.payoutTransfer.update({
        where: { id: transfer.id },
        data: { status: 'PROCESSING', failureReason },
        include: transferReceiptInclude,
      });
    }

    const failureReason = safeTransferFailure(error);
    logger.error(`Stripe transfer failed for payout transfer ${transfer.id}:`, error);
    const failedAt = new Date();
    const failed = await prisma.$transaction(async (tx) => {
      const updated = await tx.payoutTransfer.update({
        where: { id: transfer.id },
        data: { status: 'FAILED', failureReason, completedAt: failedAt },
        include: transferReceiptInclude,
      });
      await tx.payment.updateMany({
        where: { id: { in: paymentIds }, payoutStatus: 'PROCESSING' },
        data: { payoutStatus: 'FAILED', payoutFailedAt: failedAt, payoutFailureReason: failureReason },
      });
      return updated;
    });
    await notifyTutorOfTransfer(failed, false);
    return failed;
  }
};

const finalizeRun = async (runId, transfers) => {
  const successfulTransferCount = transfers.filter((transfer) => transfer.status === 'SUCCEEDED').length;
  const failedTransferCount = transfers.filter((transfer) => transfer.status === 'FAILED').length;
  const processingTransferCount = transfers.filter((transfer) => transfer.status === 'PROCESSING').length;
  const status =
    processingTransferCount > 0
      ? 'PROCESSING'
      : successfulTransferCount === transfers.length
      ? 'COMPLETED'
      : failedTransferCount === transfers.length
        ? 'FAILED'
        : 'PARTIALLY_FAILED';

  return prisma.payoutRun.update({
    where: { id: runId },
    data: {
      status,
      successfulTransferCount,
      failedTransferCount,
      completedAt: processingTransferCount > 0 ? null : new Date(),
    },
    include: {
      initiatedByAdmin: { select: { id: true, firstName: true, lastName: true, role: true } },
      transfers: { include: transferReceiptInclude, orderBy: { createdAt: 'asc' } },
    },
  });
};

const resumeInterruptedPayoutRuns = async ({ tutorProfileId } = {}) => {
  const interruptedRuns = await prisma.payoutRun.findMany({
    where: {
      status: 'PROCESSING',
      ...(tutorProfileId
        ? { transfers: { some: { tutorProfileId, status: 'PROCESSING' } } }
        : {}),
    },
    include: {
      transfers: {
        where: { status: 'PROCESSING' },
        include: transferReceiptInclude,
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  const completedRuns = [];
  for (const run of interruptedRuns) {
    await Promise.all(run.transfers.map(executeTransfer));
    const allTransfers = await prisma.payoutTransfer.findMany({
      where: { payoutRunId: run.id },
      include: transferReceiptInclude,
      orderBy: { createdAt: 'asc' },
    });
    completedRuns.push(await finalizeRun(run.id, allTransfers));
  }
  return completedRuns;
};

const processPayoutRun = async (admin, { tutorProfileId } = {}) => {
  if (!isStripeConfigured()) {
    throw new AppError('Stripe transfers are currently unavailable.', 503);
  }

  const resumedRuns = await resumeInterruptedPayoutRuns({ tutorProfileId });
  if (resumedRuns.length) {
    const resumedRun = resumedRuns[resumedRuns.length - 1];
    await prisma.adminAction.create({
      data: {
        adminId: admin.id,
        action: 'PAYOUT_RUN_RECOVERED',
        description: `Recovered interrupted payout run ${resumedRun.id}.`,
        metadata: { payoutRunId: resumedRun.id, status: resumedRun.status },
      },
    });
    return serializeRun(resumedRun);
  }

  await promoteMatureCompletionPayouts();
  const claimedRun = await createPayoutRunClaim(admin.id, { tutorProfileId });
  const completedTransfers = await Promise.all(claimedRun.transfers.map(executeTransfer));
  const completedRun = await finalizeRun(claimedRun.id, completedTransfers);

  await prisma.adminAction.create({
    data: {
      adminId: admin.id,
      action: tutorProfileId ? 'TUTOR_PAYOUT_RUN_PROCESSED' : 'PAYOUT_RUN_PROCESSED',
      description: tutorProfileId
        ? `Processed payout run ${completedRun.id} for tutor ${tutorProfileId}.`
        : `Processed payout run ${completedRun.id}.`,
      metadata: {
        payoutRunId: completedRun.id,
        ...(tutorProfileId ? { tutorProfileId } : {}),
        status: completedRun.status,
        paymentCount: completedRun.paymentCount,
        transferCount: completedRun.transferCount,
        successfulTransferCount: completedRun.successfulTransferCount,
        failedTransferCount: completedRun.failedTransferCount,
      },
    },
  });

  return serializeRun(completedRun);
};

const getPayoutRuns = async ({ page = 1, limit = DEFAULT_PAGE_SIZE } = {}) => {
  const normalizedPage = Math.max(1, Number(page) || 1);
  const normalizedLimit = Math.min(100, Math.max(1, Number(limit) || DEFAULT_PAGE_SIZE));
  const [runs, total] = await Promise.all([
    prisma.payoutRun.findMany({
      include: {
        initiatedByAdmin: { select: { id: true, firstName: true, lastName: true, role: true } },
        transfers: { include: transferReceiptInclude, orderBy: { createdAt: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (normalizedPage - 1) * normalizedLimit,
      take: normalizedLimit,
    }),
    prisma.payoutRun.count(),
  ]);

  return {
    runs: runs.map(serializeRun),
    pagination: {
      page: normalizedPage,
      limit: normalizedLimit,
      total,
      totalPages: Math.ceil(total / normalizedLimit),
    },
  };
};

module.exports = {
  PAYOUT_CANDIDATE_STATUSES,
  getPayoutOverview,
  getPayoutRuns,
  processPayoutRun,
  groupPayoutCandidates,
  serializeRun,
  safeTransferFailure,
  isIndeterminateProviderError,
  resumeInterruptedPayoutRuns,
};
