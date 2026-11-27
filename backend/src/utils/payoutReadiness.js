const { AppError } = require('../middleware/errorHandler');

const PAYOUT_ACCOUNT_STATUS = Object.freeze({
  NOT_STARTED: 'NOT_STARTED',
  ONBOARDING_INCOMPLETE: 'ONBOARDING_INCOMPLETE',
  PENDING_VERIFICATION: 'PENDING_VERIFICATION',
  RESTRICTED: 'RESTRICTED',
  READY: 'READY',
});

const PAYOUT_SETUP_CODE = 'TUTOR_PAYOUT_SETUP_INCOMPLETE';
const PAYOUT_SETUP_PATH = '/tutor/payouts';

const countRequirements = (value) => (Array.isArray(value) ? value.length : 0);

// Maps a provider account object onto the columns of tutor_payout_accounts.
// Only booleans, counts and a deadline are taken; the requirement field names
// themselves identify specific identity documents and are never read out.
const derivePayoutReadiness = (account) => {
  const requirements = account?.requirements || {};
  const transfersCapability = account?.capabilities?.transfers || null;
  const detailsSubmitted = Boolean(account?.details_submitted);
  const chargesEnabled = Boolean(account?.charges_enabled);
  const payoutsEnabled = Boolean(account?.payouts_enabled);
  const disabledReason = requirements.disabled_reason || null;
  const currentlyDueCount = countRequirements(requirements.currently_due);
  const pastDueCount = countRequirements(requirements.past_due);
  const eventuallyDueCount = countRequirements(requirements.eventually_due);
  const pendingVerificationCount = countRequirements(requirements.pending_verification);

  const isPayoutReady =
    detailsSubmitted &&
    payoutsEnabled &&
    transfersCapability === 'active' &&
    !disabledReason &&
    pastDueCount === 0 &&
    currentlyDueCount === 0;

  let status;
  if (isPayoutReady) {
    status = PAYOUT_ACCOUNT_STATUS.READY;
  } else if (disabledReason || pastDueCount > 0) {
    status = PAYOUT_ACCOUNT_STATUS.RESTRICTED;
  } else if (!detailsSubmitted || currentlyDueCount > 0) {
    status = PAYOUT_ACCOUNT_STATUS.ONBOARDING_INCOMPLETE;
  } else {
    status = PAYOUT_ACCOUNT_STATUS.PENDING_VERIFICATION;
  }

  return {
    status,
    isPayoutReady,
    detailsSubmitted,
    chargesEnabled,
    payoutsEnabled,
    transfersCapability,
    disabledReason,
    currentlyDueCount,
    pastDueCount,
    eventuallyDueCount,
    pendingVerificationCount,
    requirementsDueAt: requirements.current_deadline
      ? new Date(requirements.current_deadline * 1000)
      : null,
    defaultCurrency: account?.default_currency
      ? String(account.default_currency).toUpperCase()
      : null,
  };
};

const payoutSetupLink = (bookingId) =>
  bookingId
    ? `${PAYOUT_SETUP_PATH}?returnTo=${encodeURIComponent(`/bookings/${bookingId}`)}`
    : PAYOUT_SETUP_PATH;

// One error code for every blocked charge path; the actor's role selects the
// copy. The learner variants carry no action or link on purpose: /tutor/payouts
// is tutor-only, and naming the requirement would disclose the tutor's payout
// state to the learner.
const payoutSetupRequiredError = ({ bookingId, actorRole } = {}) =>
  actorRole === 'TUTOR'
    ? new AppError(
        'Finish your payout setup before accepting paid bookings. Free trial lessons are unaffected.',
        409,
        {
          code: PAYOUT_SETUP_CODE,
          action: 'COMPLETE_PAYOUT_SETUP',
          link: payoutSetupLink(bookingId),
        }
      )
    : new AppError(
        'This tutor is finishing their account setup, so this booking cannot be confirmed yet. Please try again shortly.',
        409,
        { code: PAYOUT_SETUP_CODE }
      );

module.exports = {
  PAYOUT_ACCOUNT_STATUS,
  PAYOUT_SETUP_CODE,
  PAYOUT_SETUP_PATH,
  derivePayoutReadiness,
  payoutSetupLink,
  payoutSetupRequiredError,
};
