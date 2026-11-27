const { prisma } = require('../config/database');
const { getStripe, isStripeConfigured } = require('../config/stripe');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../config/logger');
const { notifyOrRefresh } = require('./notificationService');
const { createWebhookReceipt, recordWebhookEvent } = require('./paymentAcceptanceService');
const {
  PAYOUT_ACCOUNT_STATUS,
  PAYOUT_SETUP_PATH,
  derivePayoutReadiness,
} = require('../utils/payoutReadiness');

// Express accounts cannot change country after creation, so this is fixed per
// deployment rather than per tutor.
const CONNECT_COUNTRY = String(process.env.STRIPE_CONNECT_COUNTRY || 'AU').toUpperCase();

// Guards against a React Query refetch storm turning into provider rate limits.
// The genuine return-from-provider case passes force and bypasses it.
const REFRESH_THROTTLE_MS = 15_000;

const frontendUrl = () =>
  String(process.env.FRONTEND_URL || 'http://localhost:8080').replace(/\/+$/, '');

const NON_PUBLIC_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

/**
 * The provider rejects a business URL it cannot resolve, so a local dev host
 * must be omitted rather than sent. Redirect URLs are unaffected: those accept
 * localhost, which is what makes the hosted flow testable locally at all.
 */
const publicBusinessUrl = () => {
  try {
    const { hostname } = new URL(frontendUrl());
    if (NON_PUBLIC_HOSTNAMES.has(hostname) || hostname.endsWith('.local')) return null;
    return frontendUrl();
  } catch {
    return null;
  }
};

const providerUnavailableError = () =>
  new AppError('Payout setup is currently unavailable. Please try again later.', 503, {
    code: 'PAYMENT_PROVIDER_UNAVAILABLE',
  });

const isMissingAccountError = (error) =>
  error?.code === 'resource_missing' ||
  error?.statusCode === 404 ||
  error?.raw?.code === 'resource_missing';

/**
 * Create or reuse the tutor's connected account (AC1).
 *
 * Three independent layers stop a double-click producing two provider accounts:
 * the provider idempotency key, the tutorProfileId unique index, and the P2002
 * reuse branch below.
 */
const ensurePayoutAccount = async (tutorProfileId) => {
  if (!isStripeConfigured()) throw providerUnavailableError();

  const existing = await prisma.tutorPayoutAccount.findUnique({ where: { tutorProfileId } });
  if (existing) return existing;

  const profile = await prisma.tutorProfile.findUnique({
    where: { id: tutorProfileId },
    include: { user: { select: { id: true, email: true } } },
  });
  if (!profile) throw new AppError('Tutor profile not found', 404);

  const businessUrl = publicBusinessUrl();
  let account;
  try {
    account = await getStripe().accounts.create(
      {
        type: 'express',
        country: CONNECT_COUNTRY,
        email: profile.user?.email || undefined,
        business_profile: {
          ...(businessUrl ? { url: businessUrl } : {}),
          product_description: 'Tutoring lessons delivered through TutorConnect',
        },
        // Transfers only. PAY-05 does not move money: charges still settle to
        // the platform account, and this capability is what drives the payout
        // requirements and payouts_enabled that readiness is derived from.
        capabilities: { transfers: { requested: true } },
        metadata: {
          tutorProfileId,
          userId: profile.userId,
          platform: 'tutorconnect',
        },
      },
      { idempotencyKey: `payout-account:${tutorProfileId}` }
    );
  } catch (error) {
    logger.error(`Failed to create payout account for tutor ${tutorProfileId}:`, error);
    throw providerUnavailableError();
  }

  const readiness = derivePayoutReadiness(account);
  const now = new Date();

  try {
    return await prisma.tutorPayoutAccount.create({
      data: {
        tutorProfileId,
        stripeAccountId: account.id,
        country: account.country || CONNECT_COUNTRY,
        lastSyncedAt: now,
        onboardingStartedAt: now,
        ...readiness,
      },
    });
  } catch (error) {
    // A concurrent first click won the unique index; reuse the winner rather
    // than surfacing a conflict the tutor cannot act on.
    if (error?.code === 'P2002') {
      return prisma.tutorPayoutAccount.findUnique({ where: { tutorProfileId } });
    }
    throw error;
  }
};

/**
 * Mint a fresh provider-hosted onboarding URL (AC1 start, AC3 resume).
 *
 * Account links are single-use and expire in minutes, so the URL is never
 * persisted. The same account_onboarding link type serves both start and
 * resume; for an already-complete account the provider short-circuits to
 * return_url, which is the honest behaviour for AC2.
 */
const createOnboardingLink = async (tutorProfileId) => {
  const payoutAccount = await ensurePayoutAccount(tutorProfileId);
  if (!payoutAccount) throw providerUnavailableError();

  const base = frontendUrl();
  let link;
  try {
    link = await getStripe().accountLinks.create({
      account: payoutAccount.stripeAccountId,
      type: 'account_onboarding',
      refresh_url: `${base}${PAYOUT_SETUP_PATH}?refresh=1`,
      return_url: `${base}${PAYOUT_SETUP_PATH}?return=1`,
      collection_options: { fields: 'currently_due' },
    });
  } catch (error) {
    logger.error(`Failed to create onboarding link for tutor ${tutorProfileId}:`, error);
    throw providerUnavailableError();
  }

  if (!payoutAccount.onboardingStartedAt) {
    await prisma.tutorPayoutAccount.update({
      where: { id: payoutAccount.id },
      data: { onboardingStartedAt: new Date() },
    });
  }

  return {
    url: link.url,
    expiresAt: link.expires_at ? new Date(link.expires_at * 1000) : null,
  };
};

// The single write path for readiness, shared by the webhook and the refresh.
const applyAccountSnapshot = async (payoutAccount, account, options = {}, database = prisma) => {
  const readiness = derivePayoutReadiness(account);
  const now = new Date();

  return database.tutorPayoutAccount.update({
    where: { id: payoutAccount.id },
    data: {
      ...readiness,
      country: account?.country || payoutAccount.country,
      lastSyncedAt: now,
      ...(options.eventCreatedAt ? { lastEventCreatedAt: options.eventCreatedAt } : {}),
      // Kept as a historical fact: losing readiness later must not erase that
      // the tutor once completed onboarding.
      ...(readiness.isPayoutReady && !payoutAccount.onboardingCompletedAt
        ? { onboardingCompletedAt: now }
        : {}),
    },
  });
};

const markAccountMissing = (payoutAccount) =>
  prisma.tutorPayoutAccount.update({
    where: { id: payoutAccount.id },
    data: {
      status: PAYOUT_ACCOUNT_STATUS.RESTRICTED,
      isPayoutReady: false,
      payoutsEnabled: false,
      chargesEnabled: false,
      transfersCapability: 'inactive',
      disabledReason: 'account_missing',
      lastSyncedAt: new Date(),
    },
  });

/**
 * Re-read readiness from the provider (AC2/AC3).
 *
 * A read must never fail the payout page, so provider outages fall back to the
 * last known state rather than throwing.
 */
const refreshPayoutAccount = async (tutorProfileId, { force = false } = {}) => {
  const payoutAccount = await prisma.tutorPayoutAccount.findUnique({ where: { tutorProfileId } });
  if (!payoutAccount) return null;
  if (!isStripeConfigured()) return payoutAccount;

  const age = Date.now() - new Date(payoutAccount.lastSyncedAt || 0).getTime();
  if (!force && age < REFRESH_THROTTLE_MS) return payoutAccount;

  let account;
  try {
    account = await getStripe().accounts.retrieve(payoutAccount.stripeAccountId);
  } catch (error) {
    if (isMissingAccountError(error)) return markAccountMissing(payoutAccount);
    logger.warn(`Could not refresh payout account for tutor ${tutorProfileId}:`, error);
    return payoutAccount;
  }

  return applyAccountSnapshot(payoutAccount, account);
};

const getPayoutAccountForTutor = async (tutorProfileId, { refresh = false } = {}) => {
  if (refresh) return refreshPayoutAccount(tutorProfileId, { force: true });
  return prisma.tutorPayoutAccount.findUnique({ where: { tutorProfileId } });
};

const notifyPayoutReady = async (tutorProfileId) => {
  try {
    const profile = await prisma.tutorProfile.findUnique({
      where: { id: tutorProfileId },
      select: { userId: true },
    });
    if (!profile?.userId) return;
    await notifyOrRefresh(
      profile.userId,
      'payment',
      'Payouts enabled',
      'Your payout setup is complete. You can now accept paid bookings.',
      PAYOUT_SETUP_PATH
    );
  } catch (error) {
    // A notification failure must never roll back a readiness update.
    logger.warn(`Could not notify tutor ${tutorProfileId} of payout readiness:`, error);
  }
};

/**
 * Apply an account.updated event.
 *
 * The tutor is resolved by the provider-authoritative account id, never by
 * event metadata, which is mutable from the provider dashboard. The receipt
 * insert and the readiness write share one transaction, so a replayed event id
 * hits the webhook-ledger primary key and rolls the whole thing back.
 */
const applyAccountUpdatedEvent = async (event) => {
  const account = event?.data?.object;
  const stripeAccountId = account?.id || event?.account || null;
  if (!stripeAccountId) return recordWebhookEvent(event);

  const payoutAccount = await prisma.tutorPayoutAccount.findUnique({
    where: { stripeAccountId },
  });
  if (!payoutAccount) {
    // Unknown account (another environment sharing the endpoint, or a deleted
    // row). Still record the receipt so the ledger stays complete.
    await recordWebhookEvent(event);
    return { outcome: 'IGNORED' };
  }

  const eventCreatedAt = event?.created ? new Date(event.created * 1000) : null;
  if (
    eventCreatedAt &&
    payoutAccount.lastEventCreatedAt &&
    eventCreatedAt <= new Date(payoutAccount.lastEventCreatedAt)
  ) {
    // Provider delivery is not ordered; a stale event must not un-ready a tutor
    // who has just finished onboarding.
    await recordWebhookEvent(event);
    return { outcome: 'STALE_EVENT' };
  }

  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      await createWebhookReceipt(tx, event);
      return applyAccountSnapshot(payoutAccount, account, { eventCreatedAt }, tx);
    });
  } catch (error) {
    if (error?.code === 'P2002') return { outcome: 'DUPLICATE_EVENT' };
    throw error;
  }

  if (updated?.isPayoutReady && !payoutAccount.isPayoutReady) {
    await notifyPayoutReady(payoutAccount.tutorProfileId);
  }

  return { outcome: 'APPLIED', payoutAccount: updated };
};

module.exports = {
  CONNECT_COUNTRY,
  REFRESH_THROTTLE_MS,
  ensurePayoutAccount,
  createOnboardingLink,
  refreshPayoutAccount,
  getPayoutAccountForTutor,
  applyAccountUpdatedEvent,
};
