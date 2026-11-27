const DEFAULT_CANCELLATION_POLICY = Object.freeze({
  cutoffHours: 24,
  lateRefundPercent: 0,
});

const ALLOWED_CANCELLATION_CUTOFF_HOURS = Object.freeze([12, 24, 48]);
const ALLOWED_LATE_REFUND_PERCENTS = Object.freeze([0, 50]);

const getEffectiveCancellationPolicy = (source = {}) => {
  const cutoffHours = Number(source?.cancellationCutoffHours ?? source?.cutoffHours);
  const lateRefundPercent = Number(
    source?.lateCancellationRefundPercent ?? source?.lateRefundPercent
  );

  return {
    cutoffHours: ALLOWED_CANCELLATION_CUTOFF_HOURS.includes(cutoffHours)
      ? cutoffHours
      : DEFAULT_CANCELLATION_POLICY.cutoffHours,
    lateRefundPercent: ALLOWED_LATE_REFUND_PERCENTS.includes(lateRefundPercent)
      ? lateRefundPercent
      : DEFAULT_CANCELLATION_POLICY.lateRefundPercent,
  };
};

const cancellationPoliciesMatch = (left, right) => {
  const normalizedLeft = getEffectiveCancellationPolicy(left);
  const normalizedRight = getEffectiveCancellationPolicy(right);

  return (
    normalizedLeft.cutoffHours === normalizedRight.cutoffHours &&
    normalizedLeft.lateRefundPercent === normalizedRight.lateRefundPercent
  );
};

const getCancellationRefundPercent = ({ booking, isTutor = false, now = new Date() }) => {
  if (isTutor || booking?.status !== 'ACCEPTED') return 100;

  const scheduledAt = new Date(booking?.scheduledAt);
  const hoursUntilStart = (scheduledAt.getTime() - now.getTime()) / (60 * 60 * 1000);
  const policy = getEffectiveCancellationPolicy(booking);

  return hoursUntilStart >= policy.cutoffHours ? 100 : policy.lateRefundPercent;
};

module.exports = {
  ALLOWED_CANCELLATION_CUTOFF_HOURS,
  ALLOWED_LATE_REFUND_PERCENTS,
  DEFAULT_CANCELLATION_POLICY,
  cancellationPoliciesMatch,
  getCancellationRefundPercent,
  getEffectiveCancellationPolicy,
};
