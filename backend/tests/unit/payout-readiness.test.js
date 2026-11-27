const {
  PAYOUT_ACCOUNT_STATUS,
  PAYOUT_SETUP_CODE,
  derivePayoutReadiness,
  payoutSetupLink,
  payoutSetupRequiredError,
} = require('../../src/utils/payoutReadiness');

const readyAccount = (overrides = {}) => ({
  id: 'acct_ready',
  country: 'AU',
  default_currency: 'aud',
  details_submitted: true,
  charges_enabled: true,
  payouts_enabled: true,
  capabilities: { transfers: 'active' },
  requirements: {
    disabled_reason: null,
    currently_due: [],
    past_due: [],
    eventually_due: [],
    pending_verification: [],
  },
  ...overrides,
});

describe('derivePayoutReadiness', () => {
  test('marks a fully onboarded account as ready', () => {
    const result = derivePayoutReadiness(readyAccount());

    expect(result.isPayoutReady).toBe(true);
    expect(result.status).toBe(PAYOUT_ACCOUNT_STATUS.READY);
    expect(result.defaultCurrency).toBe('AUD');
  });

  test.each([
    ['details not submitted', { details_submitted: false }, PAYOUT_ACCOUNT_STATUS.ONBOARDING_INCOMPLETE],
    ['payouts disabled', { payouts_enabled: false }, PAYOUT_ACCOUNT_STATUS.PENDING_VERIFICATION],
    ['transfers pending', { capabilities: { transfers: 'pending' } }, PAYOUT_ACCOUNT_STATUS.PENDING_VERIFICATION],
    ['transfers inactive', { capabilities: { transfers: 'inactive' } }, PAYOUT_ACCOUNT_STATUS.PENDING_VERIFICATION],
    ['no capabilities at all', { capabilities: {} }, PAYOUT_ACCOUNT_STATUS.PENDING_VERIFICATION],
  ])('is not ready when %s', (_label, overrides, expectedStatus) => {
    const result = derivePayoutReadiness(readyAccount(overrides));

    expect(result.isPayoutReady).toBe(false);
    expect(result.status).toBe(expectedStatus);
  });

  test('treats currently due requirements as incomplete onboarding', () => {
    const result = derivePayoutReadiness(
      readyAccount({
        details_submitted: false,
        requirements: {
          currently_due: ['individual.id_number', 'external_account'],
          past_due: [],
          eventually_due: ['individual.verification.document'],
          pending_verification: [],
        },
      })
    );

    expect(result.status).toBe(PAYOUT_ACCOUNT_STATUS.ONBOARDING_INCOMPLETE);
    expect(result.isPayoutReady).toBe(false);
    expect(result.currentlyDueCount).toBe(2);
    expect(result.eventuallyDueCount).toBe(1);
  });

  test('counts requirements without retaining their field names', () => {
    const result = derivePayoutReadiness(
      readyAccount({
        requirements: { currently_due: ['individual.id_number'], past_due: [] },
      })
    );

    expect(result.currentlyDueCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain('individual.id_number');
  });

  test.each([
    ['a disabled reason', { requirements: { disabled_reason: 'rejected.fraud', currently_due: [], past_due: [] } }],
    ['past due requirements', { requirements: { disabled_reason: null, currently_due: [], past_due: ['external_account'] } }],
  ])('marks the account restricted for %s', (_label, overrides) => {
    const result = derivePayoutReadiness(readyAccount(overrides));

    expect(result.status).toBe(PAYOUT_ACCOUNT_STATUS.RESTRICTED);
    expect(result.isPayoutReady).toBe(false);
  });

  test('reports review state when everything is submitted but transfers are not active yet', () => {
    const result = derivePayoutReadiness(
      readyAccount({
        payouts_enabled: false,
        capabilities: { transfers: 'pending' },
        requirements: {
          currently_due: [],
          past_due: [],
          pending_verification: ['individual.verification.document'],
        },
      })
    );

    expect(result.status).toBe(PAYOUT_ACCOUNT_STATUS.PENDING_VERIFICATION);
    expect(result.pendingVerificationCount).toBe(1);
  });

  test('converts the requirements deadline from provider epoch seconds', () => {
    const result = derivePayoutReadiness(
      readyAccount({ requirements: { current_deadline: 1785000000, currently_due: [], past_due: [] } })
    );

    expect(result.requirementsDueAt).toEqual(new Date(1785000000 * 1000));
  });

  test('defaults safely for an empty account object', () => {
    const result = derivePayoutReadiness({});

    expect(result.isPayoutReady).toBe(false);
    expect(result.status).toBe(PAYOUT_ACCOUNT_STATUS.ONBOARDING_INCOMPLETE);
    expect(result.requirementsDueAt).toBeNull();
    expect(result.defaultCurrency).toBeNull();
  });
});

describe('payoutSetupRequiredError', () => {
  test('gives the tutor an actionable link back to the booking', () => {
    const error = payoutSetupRequiredError({ bookingId: 'booking-1', actorRole: 'TUTOR' });

    expect(error.statusCode).toBe(409);
    expect(error.errorCode).toBe(PAYOUT_SETUP_CODE);
    expect(error.action).toBe('COMPLETE_PAYOUT_SETUP');
    expect(error.link).toBe('/tutor/payouts?returnTo=%2Fbookings%2Fbooking-1');
    expect(error.message).toContain('Free trial lessons are unaffected');
  });

  test('never exposes payout details or a tutor-only link to a learner', () => {
    const error = payoutSetupRequiredError({ bookingId: 'booking-1', actorRole: 'LEARNER' });

    expect(error.statusCode).toBe(409);
    expect(error.errorCode).toBe(PAYOUT_SETUP_CODE);
    // errorHandler omits falsy action/link from the response body entirely.
    expect(error.action).toBeNull();
    expect(error.link).toBeNull();
    expect(error.message.toLowerCase()).not.toContain('payout');
    expect(error.message.toLowerCase()).not.toContain('stripe');
  });
});

describe('payoutSetupLink', () => {
  test('falls back to the bare settings path without a booking', () => {
    expect(payoutSetupLink()).toBe('/tutor/payouts');
  });
});
