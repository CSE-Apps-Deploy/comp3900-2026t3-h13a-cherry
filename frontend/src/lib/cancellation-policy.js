export const DEFAULT_CANCELLATION_POLICY = Object.freeze({
  cutoffHours: 24,
  lateRefundPercent: 0,
});

export const CANCELLATION_CUTOFF_OPTIONS = Object.freeze([12, 24, 48]);
export const LATE_REFUND_OPTIONS = Object.freeze([0, 50]);

export function normalizeCancellationPolicy(source = {}) {
  const policy = source?.cancellationPolicy || source || {};
  const cutoffHours = Number(policy.cutoffHours ?? source?.cancellationCutoffHours);
  const lateRefundPercent = Number(
    policy.lateRefundPercent ?? source?.lateCancellationRefundPercent
  );

  return {
    cutoffHours: CANCELLATION_CUTOFF_OPTIONS.includes(cutoffHours)
      ? cutoffHours
      : DEFAULT_CANCELLATION_POLICY.cutoffHours,
    lateRefundPercent: LATE_REFUND_OPTIONS.includes(lateRefundPercent)
      ? lateRefundPercent
      : DEFAULT_CANCELLATION_POLICY.lateRefundPercent,
  };
}

export function getCancellationPolicyCopy(source) {
  const policy = normalizeCancellationPolicy(source);
  return {
    ...policy,
    cutoffText: `Cancel at least ${policy.cutoffHours} hours before the lesson for a full refund.`,
    lateRefundText:
      policy.lateRefundPercent === 0
        ? 'Later cancellations are not refunded.'
        : `Later cancellations receive a ${policy.lateRefundPercent}% refund.`,
  };
}

export function getCancellationState(
  booking,
  { isLearner = false, isTutor = false, now = new Date() } = {}
) {
  if (!booking || !['UNPAID', 'PENDING', 'ACCEPTED'].includes(booking.status)) {
    return { canCancel: false, blockedReason: '', refundPercent: 0 };
  }

  if (isTutor) {
    return { canCancel: true, blockedReason: '', refundPercent: 100 };
  }

  if (!isLearner) {
    return { canCancel: false, blockedReason: '', refundPercent: 0 };
  }

  const scheduledAt = new Date(booking.scheduledAt);
  if (Number.isNaN(scheduledAt.getTime()) || scheduledAt <= now) {
    return {
      canCancel: false,
      blockedReason: 'Bookings cannot be cancelled after the lesson has started.',
      refundPercent: 0,
    };
  }

  const paymentStatus = String(booking.payment?.status || 'PENDING').toUpperCase();
  const isPaid = !booking.isTrialLesson && ['PAID', 'COMPLETED'].includes(paymentStatus);
  if (!isPaid) {
    return { canCancel: true, blockedReason: '', refundPercent: 0 };
  }

  if (booking.status !== 'ACCEPTED') {
    return { canCancel: true, blockedReason: '', refundPercent: 100 };
  }

  const policy = normalizeCancellationPolicy(booking);
  const hoursUntilStart = (scheduledAt.getTime() - now.getTime()) / (60 * 60 * 1000);
  return {
    canCancel: true,
    blockedReason: '',
    refundPercent:
      hoursUntilStart >= policy.cutoffHours ? 100 : policy.lateRefundPercent,
  };
}
