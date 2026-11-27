const INTERNAL_PAYMENT_FIELDS = [
  'stripePaymentId',
  'stripeSessionId',
  'stripeCustomerId',
  'stripePaymentMethodId',
  'stripeSetupIntentId',
  'stripePaymentIntentId',
  'stripeIdempotencyKey',
  'acceptanceAttemptCount',
  'processingStartedAt',
  'paymentAttemptToken',
  'acceptanceMode',
  'acceptanceAuthorizedById',
  'acceptanceAuthorizedAt',
  'acceptanceBookingVersion',
  'acceptanceMeetingLink',
  'payoutStatus',
  'payoutPendingAt',
  'payoutEligibleAt',
  'payoutAt',
  'payoutFailedAt',
  'payoutFailureReason',
];

const serializePaymentAttempt = (attempt, { isAdmin = false } = {}) => {
  if (!attempt) return attempt;
  return {
    id: attempt.id,
    number: attempt.sequence,
    source: attempt.source,
    outcome: attempt.outcome,
    initiatedByRole: attempt.initiatedByRole || null,
    attemptedAt: attempt.startedAt,
    completedAt: attempt.completedAt || null,
    ...(attempt.safeFailureReason ? { failureReason: attempt.safeFailureReason } : {}),
    ...(isAdmin && attempt.providerCode ? { providerCode: attempt.providerCode } : {}),
  };
};

const serializePayment = (payment, options = {}) => {
  if (!payment) return payment;
  const serialized = { ...payment };
  if ([payment.stripeCustomerId, payment.stripePaymentIntentId].some((id) => String(id || '').startsWith('fake_'))) {
    serialized.isTestPayment = true;
  }
  const refund = payment.refund || null;
  INTERNAL_PAYMENT_FIELDS.forEach((field) => delete serialized[field]);
  serialized.refund = refund
    ? {
        id: refund.id,
        source: refund.source,
        amount: Number(refund.amount || 0).toFixed(2),
        currency: String(refund.currency || payment.currency || 'AUD').toUpperCase(),
        status: refund.status,
        failureReason: refund.failureReason || null,
        requestedAt: refund.requestedAt,
        failedAt: refund.failedAt || null,
        completedAt: refund.completedAt || null,
        attemptCount: Number(refund.attemptCount || 0),
        ...(options.isAdmin ? { resolutionNote: refund.resolutionNote } : {}),
      }
    : null;
  serialized.attempts = (payment.attempts || [])
    .map((attempt) => serializePaymentAttempt(attempt, options))
    .sort((left, right) => Number(right.number || 0) - Number(left.number || 0));
  return serialized;
};

module.exports = {
  serializePayment,
  serializePaymentAttempt,
};
