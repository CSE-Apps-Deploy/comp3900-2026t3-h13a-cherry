export const canChangePendingRequestedTime = (
  booking,
  { isLearner = false, isRecurring = false, now = new Date() } = {}
) => {
  const failedPaymentRecovery =
    String(booking?.payment?.status || '').toUpperCase() === 'FAILED' &&
    Boolean(booking?.availableActions?.isAwaitingLearnerPaymentRetry);

  return Boolean(
    isLearner &&
    (!isRecurring || failedPaymentRecovery) &&
    booking?.status === 'PENDING' &&
    String(booking?.payment?.status || '').toUpperCase() !== 'PROCESSING' &&
    !booking?.activePriceOffer &&
    !(booking?.priceOffers || []).some((offer) => offer.status === 'PENDING') &&
    (new Date(booking?.scheduledAt || 0) > now || failedPaymentRecovery)
  );
};

export const canTutorChooseAnyFreeTime = (
  booking,
  { isTutor = false, now = new Date() } = {}
) =>
  Boolean(
    isTutor &&
    ['PENDING', 'ACCEPTED'].includes(booking?.status) &&
    new Date(booking?.scheduledAt || 0) > now
  );

export const getRequestedTimeHistory = (booking) =>
  (booking?.rescheduleRequests || [])
    .filter((request) => request.status === 'ACCEPTED')
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));

export const getActiveTimeProposal = (booking) =>
  (booking?.rescheduleRequests || []).find((request) => request.status === 'PENDING') || null;

export const getTimeNegotiationHistory = (booking) =>
  [...(booking?.rescheduleRequests || [])].sort(
    (left, right) => new Date(right.createdAt) - new Date(left.createdAt)
  );

export const getNegotiationStatusLabel = (booking) => {
  if (booking?.negotiationStatus === 'TIME_PROPOSED_BY_TUTOR') {
    return 'Time Proposed by Tutor';
  }
  if (booking?.negotiationStatus === 'TIME_PROPOSED_BY_LEARNER') {
    return 'Time Proposed by Learner';
  }
  return null;
};
