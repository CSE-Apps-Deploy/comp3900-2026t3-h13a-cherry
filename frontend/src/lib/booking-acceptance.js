export const ACCEPTANCE_OUTCOMES = {
  ACCEPTED: 'ACCEPTED',
  PAYMENT_PROCESSING: 'PAYMENT_PROCESSING',
};

const normalizeOutcome = (value) => {
  const candidate = typeof value === 'string' ? value : value?.outcome || value?.status || value?.type;
  const normalized = String(candidate || '').toUpperCase();
  if (normalized === ACCEPTANCE_OUTCOMES.ACCEPTED) return ACCEPTANCE_OUTCOMES.ACCEPTED;
  if (['PAYMENT_PROCESSING', 'PROCESSING'].includes(normalized)) {
    return ACCEPTANCE_OUTCOMES.PAYMENT_PROCESSING;
  }
  return null;
};

export const getAcceptanceOutcome = (response) => {
  const body = response?.data || response || {};
  const payload = body?.data || {};
  const explicit =
    normalizeOutcome(response?.outcome) ||
    normalizeOutcome(body?.outcome) ||
    normalizeOutcome(payload?.outcome);
  if (explicit) return explicit;
  if (Number(response?.status) === 202) return ACCEPTANCE_OUTCOMES.PAYMENT_PROCESSING;

  const booking = payload?.booking || payload;
  if (String(booking?.payment?.status || '').toUpperCase() === 'PROCESSING') {
    return ACCEPTANCE_OUTCOMES.PAYMENT_PROCESSING;
  }
  return ACCEPTANCE_OUTCOMES.ACCEPTED;
};

export const PAYOUT_SETUP_CODE = 'TUTOR_PAYOUT_SETUP_INCOMPLETE';

// PAYOUT_SETUP_CODE is deliberately absent from ERROR_MESSAGES below: the server
// already tailors this message to the actor, and a client override would show
// the tutor's wording ("finish your payout setup") to a learner.
const ERROR_MESSAGES = {
  PAYMENT_METHOD_REQUIRED:
    'The learner needs to add or replace their payment method before this request can be accepted.',
  PAYMENT_FAILED:
    'Payment failed. The booking is still pending and the learner has been asked to replace their payment method.',
  INVALID_BOOKING_PRICE:
    'This booking has an invalid price and cannot be accepted. Please contact support.',
  PAYMENT_PROVIDER_UNAVAILABLE:
    'The payment provider is temporarily unavailable. The booking remains pending; please try again later.',
  BOOKING_CHANGED:
    'This booking changed before it could be accepted. Review the latest details and try again.',
};

export const getAcceptanceErrorDetails = (error) => {
  const body = error?.response?.data || error?.data || error || {};
  const nested = body?.error && typeof body.error === 'object' ? body.error : {};
  const actionValue = body?.action || nested?.action || null;
  const action =
    typeof actionValue === 'string' ? actionValue : actionValue?.type || actionValue?.action || null;
  const code = String(body?.code || nested?.code || '').toUpperCase();
  return {
    code,
    action,
    link:
      body?.link ||
      body?.href ||
      nested?.link ||
      nested?.href ||
      (typeof actionValue === 'object' ? actionValue?.link || actionValue?.href : null) ||
      null,
    message:
      ERROR_MESSAGES[code] ||
      body?.message ||
      nested?.message ||
      error?.message ||
      'Failed to accept this booking.',
    requiresPaymentMethod: code === 'PAYMENT_METHOD_REQUIRED' || code === 'PAYMENT_FAILED',
    requiresPayoutSetup: code === PAYOUT_SETUP_CODE,
  };
};

export const summarizeAcceptanceResults = (settledResults = []) =>
  settledResults.reduce(
    (summary, result) => {
      if (result?.status !== 'fulfilled') {
        summary.failedCount += 1;
        const details = getAcceptanceErrorDetails(result?.reason);
        if (details.requiresPaymentMethod) {
          summary.paymentMethodFailureCount += 1;
        }
        if (details.requiresPayoutSetup) {
          summary.payoutSetupFailureCount += 1;
        }
        return summary;
      }
      if (getAcceptanceOutcome(result.value) === ACCEPTANCE_OUTCOMES.PAYMENT_PROCESSING) {
        summary.processingCount += 1;
      } else {
        summary.acceptedCount += 1;
      }
      return summary;
    },
    {
      acceptedCount: 0,
      processingCount: 0,
      failedCount: 0,
      paymentMethodFailureCount: 0,
      payoutSetupFailureCount: 0,
    }
  );

export const hasProcessingPayment = (booking) => {
  if (String(booking?.payment?.status || '').toUpperCase() === 'PROCESSING') return true;
  return Boolean(
    booking?.recurringSeries?.bookings?.some(
      (entry) => String(entry?.payment?.status || '').toUpperCase() === 'PROCESSING'
    )
  );
};


export const getTutorBookingActionHint = (booking) => {
  const actions = booking?.availableActions || {};
  if (booking?.status === 'PENDING' && actions.hasPendingSeriesPriceOffer) {
    return 'Waiting for the learner to respond to the price offer. Booking acceptance becomes available after the offer is resolved.';
  }
  return actions.canAccept || actions.canDecline
    ? 'Tutors can accept or decline pending requests here.'
    : 'Only currently valid booking actions are shown here.';
};
