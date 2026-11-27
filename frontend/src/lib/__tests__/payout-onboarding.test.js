import { describe, expect, test } from 'vitest';

import {
  PAYOUT_STATUS,
  getPayoutPanelClass,
  getPayoutReturnState,
  getPayoutStatusView,
  isPayoutReady,
  isSafeReturnPath,
} from '../payout-onboarding';

const searchParams = (query) => new URLSearchParams(query);

describe('getPayoutStatusView', () => {
  test('presents a ready account as done with nothing left to do', () => {
    const view = getPayoutStatusView({ status: PAYOUT_STATUS.READY, isPayoutReady: true });

    expect(view.tone).toBe('success');
    expect(view.title).toBe("You're ready to receive payouts");
    expect(view.showCta).toBe(false);
    expect(view.ctaLabel).toBeNull();
  });

  test('invites a tutor who has not started to begin setup', () => {
    const view = getPayoutStatusView({ status: PAYOUT_STATUS.NOT_STARTED });

    expect(view.tone).toBe('info');
    expect(view.showCta).toBe(true);
    expect(view.ctaLabel).toBe('Start payout setup');
  });

  test('tells a tutor how many items remain and offers to resume', () => {
    const view = getPayoutStatusView({
      status: PAYOUT_STATUS.ONBOARDING_INCOMPLETE,
      outstandingRequirementCount: 2,
    });

    expect(view.tone).toBe('warning');
    expect(view.showCta).toBe(true);
    expect(view.ctaLabel).toBe('Continue payout setup');
    expect(view.description).toContain('2 items still needed');
  });

  test('uses the singular form for a single outstanding item', () => {
    const view = getPayoutStatusView({
      status: PAYOUT_STATUS.ONBOARDING_INCOMPLETE,
      outstandingRequirementCount: 1,
    });

    expect(view.description).toContain('1 item still needed');
    expect(view.description).not.toContain('1 items');
  });

  test('omits the count when the provider has not named an outstanding item', () => {
    const view = getPayoutStatusView({
      status: PAYOUT_STATUS.ONBOARDING_INCOMPLETE,
      outstandingRequirementCount: 0,
    });

    expect(view.description).not.toMatch(/\d+ items? still needed/);
    expect(view.outstandingRequirementCount).toBe(0);
  });

  test('asks a tutor under review to wait rather than act', () => {
    const view = getPayoutStatusView({ status: PAYOUT_STATUS.PENDING_VERIFICATION });

    expect(view.tone).toBe('info');
    expect(view.showCta).toBe(false);
  });

  test('flags a restricted account as blocking and actionable', () => {
    const view = getPayoutStatusView({ status: PAYOUT_STATUS.RESTRICTED });

    expect(view.tone).toBe('failure');
    expect(view.showCta).toBe(true);
    expect(view.ctaLabel).toBe('Review payout setup');
  });

  test('explains an unconfigured provider without offering a dead button', () => {
    const view = getPayoutStatusView({ status: PAYOUT_STATUS.UNAVAILABLE });

    expect(view.tone).toBe('warning');
    expect(view.showCta).toBe(false);
  });

  test('falls back to not started for a missing or unknown account', () => {
    expect(getPayoutStatusView(null).status).toBe(PAYOUT_STATUS.NOT_STARTED);
    expect(getPayoutStatusView({ status: 'SOMETHING_NEW' }).showCta).toBe(true);
  });
});

describe('getPayoutPanelClass', () => {
  test('maps each tone to its themed panel', () => {
    expect(getPayoutPanelClass('success')).toContain('emerald');
    expect(getPayoutPanelClass('warning')).toContain('amber');
    expect(getPayoutPanelClass('info')).toContain('sky');
    expect(getPayoutPanelClass('failure')).toContain('red');
  });

  test('degrades to a neutral panel for an unknown tone', () => {
    expect(getPayoutPanelClass('nonsense')).toContain('gray');
  });
});

describe('getPayoutReturnState', () => {
  test('forces a provider re-read when the tutor returns from the hosted flow', () => {
    const state = getPayoutReturnState(searchParams('return=1'));

    expect(state.shouldForceRefresh).toBe(true);
    expect(state.shouldAutoResume).toBe(false);
  });

  test('resumes automatically when the single-use link expired mid-flow', () => {
    const state = getPayoutReturnState(searchParams('refresh=1'));

    expect(state.shouldForceRefresh).toBe(true);
    expect(state.shouldAutoResume).toBe(true);
  });

  test('does nothing special on a plain visit', () => {
    const state = getPayoutReturnState(searchParams(''));

    expect(state.shouldForceRefresh).toBe(false);
    expect(state.shouldAutoResume).toBe(false);
    expect(state.returnTo).toBeNull();
  });

  test('keeps a same-origin return path', () => {
    expect(getPayoutReturnState(searchParams('returnTo=/bookings/booking-1')).returnTo).toBe(
      '/bookings/booking-1'
    );
  });

  test.each([
    ['a protocol-relative url', 'returnTo=//evil.example.com'],
    ['an absolute url', 'returnTo=https://evil.example.com'],
  ])('drops %s so it cannot become an open redirect', (_label, query) => {
    expect(getPayoutReturnState(searchParams(query)).returnTo).toBeNull();
  });

  test('tolerates a missing search params object', () => {
    expect(getPayoutReturnState(null)).toEqual({
      shouldForceRefresh: false,
      shouldAutoResume: false,
      returnTo: null,
    });
  });
});

describe('isPayoutReady and isSafeReturnPath', () => {
  test('reads readiness straight off the account', () => {
    expect(isPayoutReady({ isPayoutReady: true })).toBe(true);
    expect(isPayoutReady({ isPayoutReady: false })).toBe(false);
    expect(isPayoutReady(null)).toBe(false);
  });

  test('accepts only same-origin paths', () => {
    expect(isSafeReturnPath('/bookings/1')).toBe(true);
    expect(isSafeReturnPath('//evil.example.com')).toBe(false);
    expect(isSafeReturnPath('https://evil.example.com')).toBe(false);
    expect(isSafeReturnPath(null)).toBe(false);
  });
});
