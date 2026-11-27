const { PAYOUT_ACCOUNT_STATUS } = require('./payoutReadiness');

// Allowlist-shaped rather than delete-shaped: a column added to
// tutor_payout_accounts later is excluded from the response by default instead
// of leaking until someone remembers to blocklist it.
//
// Never emitted, to any role: stripeAccountId, disabledReason (values such as
// rejected.fraud are compliance signals), transfersCapability,
// lastEventCreatedAt, tutorProfileId, id, and any requirement field name.
const NOT_STARTED_PAYOUT_ACCOUNT = Object.freeze({
  status: PAYOUT_ACCOUNT_STATUS.NOT_STARTED,
  isPayoutReady: false,
  detailsSubmitted: false,
  payoutsEnabled: false,
  chargesEnabled: false,
  outstandingRequirementCount: 0,
  hasPastDueRequirements: false,
  isUnderReview: false,
  requirementsDueAt: null,
  country: null,
  defaultCurrency: null,
  onboardingStartedAt: null,
  onboardingCompletedAt: null,
  lastSyncedAt: null,
  providerConfigured: true,
});

const serializePayoutAccount = (account) => {
  if (!account) return { ...NOT_STARTED_PAYOUT_ACCOUNT };

  return {
    status: account.status,
    isPayoutReady: Boolean(account.isPayoutReady),
    detailsSubmitted: Boolean(account.detailsSubmitted),
    payoutsEnabled: Boolean(account.payoutsEnabled),
    chargesEnabled: Boolean(account.chargesEnabled),
    outstandingRequirementCount:
      Number(account.currentlyDueCount || 0) + Number(account.pastDueCount || 0),
    hasPastDueRequirements: Number(account.pastDueCount || 0) > 0,
    isUnderReview: Number(account.pendingVerificationCount || 0) > 0,
    requirementsDueAt: account.requirementsDueAt || null,
    country: account.country || null,
    defaultCurrency: account.defaultCurrency || null,
    onboardingStartedAt: account.onboardingStartedAt || null,
    onboardingCompletedAt: account.onboardingCompletedAt || null,
    lastSyncedAt: account.lastSyncedAt || null,
    providerConfigured: true,
  };
};

module.exports = {
  serializePayoutAccount,
  NOT_STARTED_PAYOUT_ACCOUNT,
};
