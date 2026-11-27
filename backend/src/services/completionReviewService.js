const { prisma } = require('../config/database');
const logger = require('../config/logger');

const COMPLETION_REVIEW_HOURS = 48;
const COMPLETION_REVIEW_MS = COMPLETION_REVIEW_HOURS * 60 * 60 * 1000;
const COMPLETION_REVIEW_WORKER_INTERVAL_MS = 60 * 1000;

const getLessonEndAt = (booking) =>
  new Date(
    new Date(booking?.scheduledAt || 0).getTime() + Number(booking?.duration || 0) * 60 * 1000
  );

const getCompletionReviewDueAt = (completedAt) =>
  new Date(new Date(completedAt).getTime() + COMPLETION_REVIEW_MS);

/**
 * Normalise completed lessons created before completion-review tracking.
 *
 * TutorConnect currently deploys schema changes with `prisma db push`, which
 * creates the new fields but does not run SQL data backfills. Running this once
 * during startup preserves previously completed lessons without treating them
 * as newly reported completions or stranding their tutor earnings.
 */
const repairLegacyCompletionReviews = async (options = {}) => {
  const database = options.database || prisma;
  const now = options.now || new Date();

  if (!database.booking?.updateMany || !database.payment?.updateMany) {
    return {
      repairedReviewCount: 0,
      repairedDueAtCount: 0,
      repairedResolutionCount: 0,
      eligiblePaymentCount: 0,
    };
  }

  const run = async (tx) => {
    const repairedReviews = await tx.booking.updateMany({
      where: {
        status: 'COMPLETED',
        completionReviewStatus: null,
      },
      data: {
        completionReviewStatus: 'CLEARED',
        completionReviewDueAt: now,
        completionReviewResolvedAt: now,
        completionReviewResolutionNote:
          'Completion pre-dates learner review tracking.',
        completionResolution: 'LEGACY_CLEARED',
        version: { increment: 1 },
      },
    });

    const repairedDueAt = await tx.booking.updateMany({
      where: {
        status: 'COMPLETED',
        completionReviewStatus: 'CLEARED',
        completionReviewDueAt: null,
      },
      data: {
        completionReviewDueAt: now,
        completionReviewResolvedAt: now,
        version: { increment: 1 },
      },
    });

    const repairedResolutions = await tx.booking.updateMany({
      where: {
        status: 'COMPLETED',
        completionReviewStatus: 'CLEARED',
        completionResolution: null,
      },
      data: { completionResolution: 'LEGACY_CLEARED' },
    });

    const eligiblePayments = await tx.payment.updateMany({
      where: {
        payoutStatus: 'PENDING',
        tutorPayoutAmount: { gt: 0 },
        booking: {
          is: {
            status: 'COMPLETED',
            completionReviewStatus: 'CLEARED',
            completionReviewDueAt: { lte: now },
          },
        },
      },
      data: {
        payoutStatus: 'ELIGIBLE',
        payoutEligibleAt: now,
      },
    });

    return {
      repairedReviewCount: Number(repairedReviews?.count || 0),
      repairedDueAtCount: Number(repairedDueAt?.count || 0),
      repairedResolutionCount: Number(repairedResolutions?.count || 0),
      eligiblePaymentCount: Number(eligiblePayments?.count || 0),
    };
  };

  if (typeof database.$transaction !== 'function') return run(database);
  return database.$transaction(run);
};

/**
 * Move undisputed completed lessons out of their learner review window.
 *
 * The booking is cleared first in the same transaction. A learner dispute uses
 * the inverse AWAITING_LEARNER + future-deadline predicate, so the two paths
 * cannot both win even when they arrive at the boundary concurrently.
 */
const promoteMatureCompletionPayouts = async (options = {}) => {
  const database = options.database || prisma;
  const now = options.now || new Date();

  if (!database.booking?.updateMany || !database.payment?.updateMany) {
    return { clearedBookingCount: 0, eligiblePaymentCount: 0 };
  }

  const run = async (tx) => {
    const cleared = await tx.booking.updateMany({
      where: {
        status: 'COMPLETED',
        completionReviewStatus: 'AWAITING_LEARNER',
        completionReviewDueAt: { lte: now },
      },
      data: {
        completionReviewStatus: 'CLEARED',
        completionReviewResolvedAt: now,
        completionReviewResolutionNote: 'Learner review window expired without a dispute.',
        completionResolution: 'WINDOW_EXPIRED',
        version: { increment: 1 },
      },
    });

    const eligible = await tx.payment.updateMany({
      where: {
        payoutStatus: 'PENDING',
        tutorPayoutAmount: { gt: 0 },
        booking: {
          is: {
            status: 'COMPLETED',
            completionReviewStatus: 'CLEARED',
            completionReviewDueAt: { lte: now },
          },
        },
      },
      data: {
        payoutStatus: 'ELIGIBLE',
        payoutEligibleAt: now,
      },
    });

    return {
      clearedBookingCount: Number(cleared?.count || 0),
      eligiblePaymentCount: Number(eligible?.count || 0),
    };
  };

  if (typeof database.$transaction !== 'function') return run(database);
  return database.$transaction(run);
};

const startCompletionReviewWorker = (options = {}) => {
  const intervalMs = Math.max(
    1000,
    Number(options.intervalMs || COMPLETION_REVIEW_WORKER_INTERVAL_MS)
  );
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      await promoteMatureCompletionPayouts({ database: options.database || prisma });
    } catch (error) {
      logger.error('Could not advance expired completion reviews:', error);
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
};

module.exports = {
  COMPLETION_REVIEW_HOURS,
  COMPLETION_REVIEW_MS,
  COMPLETION_REVIEW_WORKER_INTERVAL_MS,
  getLessonEndAt,
  getCompletionReviewDueAt,
  repairLegacyCompletionReviews,
  promoteMatureCompletionPayouts,
  startCompletionReviewWorker,
};
