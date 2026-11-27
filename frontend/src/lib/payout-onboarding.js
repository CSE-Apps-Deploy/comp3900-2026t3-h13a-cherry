export const PAYOUT_STATUS = {
  NOT_STARTED: 'NOT_STARTED',
  ONBOARDING_INCOMPLETE: 'ONBOARDING_INCOMPLETE',
  PENDING_VERIFICATION: 'PENDING_VERIFICATION',
  RESTRICTED: 'RESTRICTED',
  READY: 'READY',
  UNAVAILABLE: 'UNAVAILABLE',
};

export const isPayoutReady = (account) => Boolean(account?.isPayoutReady);

const pluralize = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

const STATUS_VIEWS = {
  [PAYOUT_STATUS.READY]: {
    tone: 'success',
    title: "You're ready to receive payouts",
    description:
      'Your payout details are verified. You can accept paid bookings as normal.',
    showCta: false,
  },
  [PAYOUT_STATUS.NOT_STARTED]: {
    tone: 'info',
    title: 'Set up payouts to accept paid bookings',
    description:
      'You still need to provide your payout details. Free trial lessons can be accepted without this.',
    ctaLabel: 'Start payout setup',
    showCta: true,
  },
  [PAYOUT_STATUS.ONBOARDING_INCOMPLETE]: {
    tone: 'warning',
    title: 'Payout setup is incomplete',
    description: 'Some details are still needed before you can receive payouts.',
    ctaLabel: 'Continue payout setup',
    showCta: true,
    showRequirementCount: true,
  },
  [PAYOUT_STATUS.PENDING_VERIFICATION]: {
    tone: 'info',
    title: "We're reviewing your details",
    description:
      'Your information has been submitted and is being verified. Nothing else is needed from you right now.',
    showCta: false,
  },
  [PAYOUT_STATUS.RESTRICTED]: {
    tone: 'failure',
    title: 'Payouts are on hold',
    description:
      'Additional information is needed before payouts can resume. Paid bookings cannot be accepted until this is resolved.',
    ctaLabel: 'Review payout setup',
    showCta: true,
    showRequirementCount: true,
  },
  [PAYOUT_STATUS.UNAVAILABLE]: {
    tone: 'warning',
    title: 'Payout setup is currently unavailable',
    description:
      'Payouts are not configured in this environment. Please try again later or contact support.',
    showCta: false,
  },
};

/**
 * Single source of truth for how a payout account renders. The page is a thin
 * renderer over this so the branching stays testable.
 */
export const getPayoutStatusView = (account) => {
  const status = account?.status || PAYOUT_STATUS.NOT_STARTED;
  const base = STATUS_VIEWS[status] || STATUS_VIEWS[PAYOUT_STATUS.NOT_STARTED];
  const outstanding = Number(account?.outstandingRequirementCount || 0);

  return {
    status,
    tone: base.tone,
    title: base.title,
    description:
      base.showRequirementCount && outstanding > 0
        ? `${base.description} ${pluralize(outstanding, 'item')} still needed.`
        : base.description,
    ctaLabel: base.ctaLabel || null,
    showCta: Boolean(base.showCta),
    outstandingRequirementCount: outstanding,
  };
};

const PANEL_CLASSES = {
  success: 'rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800',
  warning: 'rounded-lg border border-amber-200 bg-amber-50 text-amber-800',
  info: 'rounded-lg border border-sky-200 bg-sky-50 text-sky-800',
  failure: 'rounded-lg border border-red-200 bg-red-50 text-red-800',
};

export const getPayoutPanelClass = (tone) =>
  PANEL_CLASSES[tone] || 'rounded-lg border border-gray-200 bg-gray-50 text-gray-800';

// Only same-origin paths are safe to render as a "back to where you were" link.
export const isSafeReturnPath = (path) =>
  typeof path === 'string' && path.startsWith('/') && !path.startsWith('//');

/**
 * Interprets the query string the provider sends us back with.
 *
 * `return=1` is a genuine return from the hosted flow, so readiness must be
 * re-read from the provider rather than served from cache. `refresh=1` means
 * the single-use link expired mid-flow, so a fresh one is minted immediately
 * and the expiry never surfaces to the tutor.
 */
export const getPayoutReturnState = (searchParams) => {
  const get = (key) => searchParams?.get?.(key) ?? null;
  const returnTo = get('returnTo');

  return {
    shouldForceRefresh: get('return') === '1' || get('refresh') === '1',
    shouldAutoResume: get('refresh') === '1',
    returnTo: isSafeReturnPath(returnTo) ? returnTo : null,
  };
};
