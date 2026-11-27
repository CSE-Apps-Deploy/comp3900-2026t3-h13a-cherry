const {
  serializePayoutAccount,
  NOT_STARTED_PAYOUT_ACCOUNT,
} = require('../../src/utils/payoutSerialization');

// Locking the exact key set is the point of this test: a column added to
// tutor_payout_accounts later must not reach a client just because nobody
// remembered to blocklist it.
const ALLOWED_KEYS = [
  'status',
  'isPayoutReady',
  'detailsSubmitted',
  'payoutsEnabled',
  'chargesEnabled',
  'outstandingRequirementCount',
  'hasPastDueRequirements',
  'isUnderReview',
  'requirementsDueAt',
  'country',
  'defaultCurrency',
  'onboardingStartedAt',
  'onboardingCompletedAt',
  'lastSyncedAt',
  'providerConfigured',
];

describe('payout account serialization', () => {
  const account = {
    id: 'payout-1',
    tutorProfileId: 'tutor-profile-1',
    stripeAccountId: 'acct_secret',
    status: 'RESTRICTED',
    isPayoutReady: false,
    detailsSubmitted: true,
    chargesEnabled: false,
    payoutsEnabled: false,
    transfersCapability: 'inactive',
    disabledReason: 'rejected.fraud',
    currentlyDueCount: 2,
    pastDueCount: 1,
    eventuallyDueCount: 3,
    pendingVerificationCount: 1,
    requirementsDueAt: new Date('2026-08-01T00:00:00.000Z'),
    country: 'AU',
    defaultCurrency: 'AUD',
    onboardingStartedAt: new Date('2026-07-25T00:00:00.000Z'),
    onboardingCompletedAt: null,
    lastSyncedAt: new Date('2026-07-25T01:00:00.000Z'),
    lastEventCreatedAt: new Date('2026-07-25T01:00:00.000Z'),
  };

  test('exposes only the allowlisted readiness fields', () => {
    expect(Object.keys(serializePayoutAccount(account)).sort()).toEqual(
      [...ALLOWED_KEYS].sort()
    );
  });

  test('never leaks provider identifiers or compliance signals', () => {
    const result = serializePayoutAccount(account);

    expect(result).not.toHaveProperty('stripeAccountId');
    expect(result).not.toHaveProperty('disabledReason');
    expect(result).not.toHaveProperty('transfersCapability');
    expect(result).not.toHaveProperty('lastEventCreatedAt');
    expect(result).not.toHaveProperty('tutorProfileId');
    expect(result).not.toHaveProperty('id');
    expect(JSON.stringify(result)).not.toContain('acct_');
    expect(JSON.stringify(result)).not.toContain('rejected.fraud');
  });

  test('summarizes outstanding requirements as counts', () => {
    const result = serializePayoutAccount(account);

    expect(result.outstandingRequirementCount).toBe(3);
    expect(result.hasPastDueRequirements).toBe(true);
    expect(result.isUnderReview).toBe(true);
  });

  test('returns a not-started shape when the tutor has no account yet', () => {
    expect(serializePayoutAccount(null)).toEqual(NOT_STARTED_PAYOUT_ACCOUNT);
    expect(serializePayoutAccount(null).status).toBe('NOT_STARTED');
    expect(serializePayoutAccount(null).isPayoutReady).toBe(false);
  });

  test('does not hand back the shared frozen not-started object', () => {
    const result = serializePayoutAccount(null);
    result.status = 'MUTATED';

    expect(NOT_STARTED_PAYOUT_ACCOUNT.status).toBe('NOT_STARTED');
  });
});
