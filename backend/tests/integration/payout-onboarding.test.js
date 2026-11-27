const request = require('supertest');

const prisma = {
  user: {
    findUnique: vi.fn(),
  },
  tutorProfile: {
    findUnique: vi.fn(),
  },
  tutorPayoutAccount: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  payment: {
    findMany: vi.fn(),
    count: vi.fn(),
  },
  stripeWebhookEvent: {
    create: vi.fn(),
  },
  notification: {
    findFirst: vi.fn(),
    create: vi.fn(),
  },
  $transaction: vi.fn((callback) => callback(prisma)),
  $executeRaw: vi.fn(),
};

const notify = vi.fn();
const notifyOrRefresh = vi.fn();
const notifyAdmin = vi.fn();
const stripeAccountsCreate = vi.fn();
const stripeAccountsRetrieve = vi.fn();
const stripeAccountLinksCreate = vi.fn();
const stripeWebhookConstructEvent = vi.fn();
let stripeConfigured = true;

const databaseModulePath = require.resolve('../../src/config/database');
const notificationServiceModulePath = require.resolve('../../src/services/notificationService');
const stripeModulePath = require.resolve('../../src/config/stripe');
const appModulePath = require.resolve('../../src/app');

delete require.cache[databaseModulePath];
delete require.cache[notificationServiceModulePath];
delete require.cache[stripeModulePath];
delete require.cache[appModulePath];

require.cache[databaseModulePath] = {
  id: databaseModulePath,
  filename: databaseModulePath,
  loaded: true,
  exports: { prisma },
};

require.cache[notificationServiceModulePath] = {
  id: notificationServiceModulePath,
  filename: notificationServiceModulePath,
  loaded: true,
  exports: { notify, notifyOrRefresh, notifyAdmin },
};

require.cache[stripeModulePath] = {
  id: stripeModulePath,
  filename: stripeModulePath,
  loaded: true,
  exports: {
    isStripeConfigured: () => stripeConfigured,
    getStripe: () => ({
      accounts: { create: stripeAccountsCreate, retrieve: stripeAccountsRetrieve },
      accountLinks: { create: stripeAccountLinksCreate },
      webhooks: { constructEvent: stripeWebhookConstructEvent },
    }),
  },
};

const app = require('../../src/app');
const { createAccessToken } = require('../../src/utils/tokens');

const activeTutor = {
  id: 'tutor-user-1',
  email: 'tutor@example.com',
  role: 'TUTOR',
  status: 'ACTIVE',
  tutorProfile: {
    id: 'tutor-profile-1',
    status: 'ACTIVE',
    applicationSubmitted: true,
    isVerified: true,
  },
};

const pendingTutor = {
  ...activeTutor,
  id: 'tutor-user-2',
  email: 'pending@example.com',
  tutorProfile: { ...activeTutor.tutorProfile, id: 'tutor-profile-2', status: 'PENDING' },
};

const learner = {
  id: 'learner-1',
  email: 'learner@example.com',
  role: 'LEARNER',
  status: 'ACTIVE',
  tutorProfile: null,
};

const admin = {
  id: 'admin-1',
  email: 'admin@example.com',
  role: 'ADMIN',
  status: 'ACTIVE',
  tutorProfile: null,
};

const systemAdmin = { ...admin, id: 'admin-2', role: 'SYSTEM_ADMIN' };

const readyProviderAccount = (overrides = {}) => ({
  id: 'acct_tutor_1',
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

const storedAccount = (overrides = {}) => ({
  id: 'payout-1',
  tutorProfileId: 'tutor-profile-1',
  stripeAccountId: 'acct_tutor_1',
  country: 'AU',
  status: 'ONBOARDING_INCOMPLETE',
  isPayoutReady: false,
  detailsSubmitted: false,
  chargesEnabled: false,
  payoutsEnabled: false,
  transfersCapability: 'pending',
  disabledReason: null,
  currentlyDueCount: 0,
  pastDueCount: 0,
  eventuallyDueCount: 0,
  pendingVerificationCount: 0,
  onboardingStartedAt: new Date('2026-07-25T00:00:00.000Z'),
  onboardingCompletedAt: null,
  lastSyncedAt: null,
  lastEventCreatedAt: null,
  ...overrides,
});

const authAs = (user) => {
  prisma.user.findUnique.mockResolvedValue(user);
  return `Bearer ${createAccessToken(user)}`;
};

const getPayoutAccount = (user, query = '') =>
  request(app)
    .get(`/api/v1/payments/payout-account${query}`)
    .set('Authorization', authAs(user));

const startOnboarding = (user) =>
  request(app)
    .post('/api/v1/payments/payout-account/onboarding-link')
    .set('Authorization', authAs(user));

const getEarnings = (user, query = '') =>
  request(app)
    .get(`/api/v1/payments/earnings${query}`)
    .set('Authorization', authAs(user));

beforeEach(() => {
  vi.resetAllMocks();
  stripeConfigured = true;
  process.env.FRONTEND_URL = 'https://tutorconnect.test';
  prisma.$transaction.mockImplementation((input) =>
    typeof input === 'function' ? input(prisma) : Promise.all(input)
  );
  prisma.tutorPayoutAccount.update.mockImplementation(({ where, data }) =>
    Promise.resolve({ ...storedAccount(), id: where.id, ...data })
  );
});

describe('viewing tutor earnings', () => {
  const paidEarning = (overrides = {}) => ({
    id: 'payment-earning-1',
    amount: 100,
    currency: 'AUD',
    status: 'PAID',
    platformFeePercent: 15,
    platformFeeAmount: 15,
    tutorPayoutAmount: 85,
    payoutStatus: 'PENDING',
    payoutPendingAt: new Date('2026-07-30T01:00:00.000Z'),
    payoutEligibleAt: null,
    payoutAt: null,
    payoutFailedAt: null,
    payoutFailureReason: null,
    paidAt: new Date('2026-07-30T01:00:00.000Z'),
    refundAmount: 0,
    refundedAt: null,
    booking: {
      id: 'booking-earning-1',
      subject: 'Mathematics',
      status: 'ACCEPTED',
      scheduledAt: new Date('2026-08-01T01:00:00.000Z'),
      completedAt: null,
      cancelledAt: null,
      cancellationOutcome: null,
      isTrialLesson: false,
    },
    ...overrides,
  });

  test('returns auditable calculations, summaries, statuses and timestamps', async () => {
    const records = [
      paidEarning(),
      paidEarning({
        id: 'payment-eligible',
        payoutStatus: 'ELIGIBLE',
        payoutEligibleAt: new Date('2026-07-30T03:00:00.000Z'),
        booking: {
          ...paidEarning().booking,
          id: 'booking-eligible',
          status: 'COMPLETED',
          completedAt: new Date('2026-07-30T03:00:00.000Z'),
        },
      }),
      paidEarning({
        id: 'payment-paid',
        payoutStatus: 'PAID',
        payoutAt: new Date('2026-07-30T04:00:00.000Z'),
        booking: { ...paidEarning().booking, id: 'booking-paid' },
      }),
      paidEarning({
        id: 'payment-failed',
        payoutStatus: 'FAILED',
        payoutFailedAt: new Date('2026-07-30T05:00:00.000Z'),
        payoutFailureReason: 'The payout account could not receive this transfer.',
        booking: { ...paidEarning().booking, id: 'booking-failed' },
      }),
    ];
    prisma.payment.findMany.mockResolvedValue(records);
    prisma.payment.count.mockResolvedValue(records.length);

    const response = await getEarnings(activeTutor);

    expect(response.status).toBe(200);
    expect(response.body.data.commissionPolicy).toEqual({
      percent: '15.00',
      tutorPercent: '85.00',
    });
    expect(response.body.data.summaries).toEqual([
      {
        currency: 'AUD',
        grossAmount: '400.00',
        commissionAmount: '60.00',
        netAmount: '340.00',
        byStatus: {
          PENDING: '85.00',
          ELIGIBLE: '85.00',
          PROCESSING: '0.00',
          DISPUTED: '0.00',
          PAID: '85.00',
          FAILED: '85.00',
        },
      },
    ]);
    expect(response.body.data.records[0]).toEqual(
      expect.objectContaining({
        payoutStatus: 'PENDING',
        calculation: {
          originalAmount: '100.00',
          refundAmount: '0.00',
          grossAmount: '100.00',
          commissionPercent: '15.00',
          commissionAmount: '15.00',
          netAmount: '85.00',
        },
        statusTimestamps: expect.objectContaining({
          pendingAt: '2026-07-30T01:00:00.000Z',
        }),
      })
    );
    expect(response.body.data.records.map((record) => record.payoutStatus)).toEqual([
      'PENDING',
      'ELIGIBLE',
      'PAID',
      'FAILED',
    ]);
  });

  test('keeps a full refund visible with no payout due and links its outcome', async () => {
    const refunded = paidEarning({
      status: 'REFUNDED',
      refundAmount: 100,
      platformFeeAmount: 0,
      tutorPayoutAmount: 0,
      payoutStatus: null,
      booking: {
        ...paidEarning().booking,
        status: 'CANCELLED',
        cancelledAt: new Date('2026-07-30T02:00:00.000Z'),
        cancellationOutcome: { refundPercent: 100 },
      },
    });
    prisma.payment.findMany.mockResolvedValue([refunded]);
    prisma.payment.count.mockResolvedValue(1);

    const response = await getEarnings(activeTutor);

    expect(response.status).toBe(200);
    expect(response.body.data.records[0]).toEqual(
      expect.objectContaining({
        payoutStatus: null,
        isPayable: false,
        calculation: expect.objectContaining({
          grossAmount: '0.00',
          commissionAmount: '0.00',
          netAmount: '0.00',
        }),
        cancellation: expect.objectContaining({
          refundPercent: 100,
          href: '/bookings/booking-earning-1#cancellation-outcome',
        }),
      })
    );
  });

  test('scopes pagination, totals and records to the authenticated tutor', async () => {
    prisma.payment.findMany.mockResolvedValue([]);
    prisma.payment.count.mockResolvedValue(0);

    const response = await getEarnings(activeTutor, '?page=2&limit=1&payoutStatus=ELIGIBLE');

    expect(response.status).toBe(200);
    const recordQuery = prisma.payment.findMany.mock.calls.find(
      ([input]) => input.take === 1
    )[0];
    expect(recordQuery).toEqual(
      expect.objectContaining({
        skip: 1,
        take: 1,
        where: {
          status: { in: ['PAID', 'COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
          payoutStatus: 'ELIGIBLE',
          booking: {
            is: {
              tutorId: 'tutor-profile-1',
              isTrialLesson: false,
            },
          },
        },
      })
    );
    expect(response.body.data.pagination).toEqual({
      page: 2,
      limit: 1,
      total: 0,
      totalPages: 0,
    });
  });

  test('denies non-tutors, inactive tutors and attempted cross-tutor identifiers', async () => {
    expect((await getEarnings(learner)).status).toBe(403);
    expect((await getEarnings(admin)).status).toBe(403);
    expect((await getEarnings(pendingTutor)).status).toBe(403);

    const crossTutorAttempt = await getEarnings(
      activeTutor,
      '?tutorProfileId=tutor-profile-2'
    );
    expect(crossTutorAttempt.status).toBe(400);
    expect(prisma.payment.findMany).not.toHaveBeenCalled();
  });
});

describe('starting payout onboarding', () => {
  test('creates a connected account and returns a provider hosted link', async () => {
    prisma.tutorPayoutAccount.findUnique.mockResolvedValue(null);
    prisma.tutorProfile.findUnique.mockResolvedValue({
      id: 'tutor-profile-1',
      userId: activeTutor.id,
      user: { id: activeTutor.id, email: activeTutor.email },
    });
    stripeAccountsCreate.mockResolvedValue(
      readyProviderAccount({ details_submitted: false, payouts_enabled: false })
    );
    prisma.tutorPayoutAccount.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'payout-1', ...data })
    );
    stripeAccountLinksCreate.mockResolvedValue({
      url: 'https://connect.stripe.test/setup/acct_tutor_1',
      expires_at: 1785000000,
    });

    const response = await startOnboarding(activeTutor);

    expect(response.status).toBe(201);
    expect(response.body.data.url).toBe('https://connect.stripe.test/setup/acct_tutor_1');

    const [accountParams, accountOptions] = stripeAccountsCreate.mock.calls[0];
    expect(accountParams).toEqual(
      expect.objectContaining({
        type: 'express',
        country: 'AU',
        capabilities: { transfers: { requested: true } },
        metadata: expect.objectContaining({ tutorProfileId: 'tutor-profile-1' }),
      })
    );
    expect(accountOptions.idempotencyKey).toBe('payout-account:tutor-profile-1');
    expect(stripeAccountLinksCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        account: 'acct_tutor_1',
        type: 'account_onboarding',
        refresh_url: 'https://tutorconnect.test/tutor/payouts?refresh=1',
        return_url: 'https://tutorconnect.test/tutor/payouts?return=1',
      })
    );
  });

  test('omits a local development business url the provider would reject', async () => {
    // FRONTEND_URL is localhost in dev; sending it as business_profile[url]
    // fails the whole account creation with "Not a valid URL".
    process.env.FRONTEND_URL = 'https://localhost:8443';
    prisma.tutorPayoutAccount.findUnique.mockResolvedValue(null);
    prisma.tutorProfile.findUnique.mockResolvedValue({
      id: 'tutor-profile-1',
      userId: activeTutor.id,
      user: { id: activeTutor.id, email: activeTutor.email },
    });
    stripeAccountsCreate.mockResolvedValue(readyProviderAccount());
    prisma.tutorPayoutAccount.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'payout-1', ...data })
    );
    stripeAccountLinksCreate.mockResolvedValue({ url: 'https://connect.stripe.test/x', expires_at: 1 });

    const response = await startOnboarding(activeTutor);

    expect(response.status).toBe(201);
    const [accountParams] = stripeAccountsCreate.mock.calls[0];
    expect(accountParams.business_profile).not.toHaveProperty('url');
    expect(accountParams.business_profile.product_description).toBeTruthy();
    // Redirect urls still use localhost; the provider accepts those.
    expect(stripeAccountLinksCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        return_url: 'https://localhost:8443/tutor/payouts?return=1',
      })
    );
  });

  test('sends a publicly resolvable business url when one is configured', async () => {
    process.env.FRONTEND_URL = 'https://tutorconnect.example.com';
    prisma.tutorPayoutAccount.findUnique.mockResolvedValue(null);
    prisma.tutorProfile.findUnique.mockResolvedValue({
      id: 'tutor-profile-1',
      userId: activeTutor.id,
      user: { id: activeTutor.id, email: activeTutor.email },
    });
    stripeAccountsCreate.mockResolvedValue(readyProviderAccount());
    prisma.tutorPayoutAccount.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'payout-1', ...data })
    );
    stripeAccountLinksCreate.mockResolvedValue({ url: 'https://connect.stripe.test/x', expires_at: 1 });

    await startOnboarding(activeTutor);

    expect(stripeAccountsCreate.mock.calls[0][0].business_profile.url).toBe(
      'https://tutorconnect.example.com'
    );
  });

  test('reuses an existing connected account instead of creating a second one', async () => {
    prisma.tutorPayoutAccount.findUnique.mockResolvedValue(storedAccount());
    stripeAccountLinksCreate.mockResolvedValue({
      url: 'https://connect.stripe.test/resume/acct_tutor_1',
      expires_at: 1785000000,
    });

    const response = await startOnboarding(activeTutor);

    expect(response.status).toBe(201);
    expect(stripeAccountsCreate).not.toHaveBeenCalled();
    expect(prisma.tutorPayoutAccount.create).not.toHaveBeenCalled();
    expect(stripeAccountLinksCreate).toHaveBeenCalledWith(
      expect.objectContaining({ account: 'acct_tutor_1' })
    );
  });

  test('resolves a concurrent first click to the account that won the unique index', async () => {
    const winner = storedAccount();
    prisma.tutorPayoutAccount.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    prisma.tutorProfile.findUnique.mockResolvedValue({
      id: 'tutor-profile-1',
      userId: activeTutor.id,
      user: { id: activeTutor.id, email: activeTutor.email },
    });
    stripeAccountsCreate.mockResolvedValue(readyProviderAccount());
    prisma.tutorPayoutAccount.create.mockRejectedValue({ code: 'P2002' });
    stripeAccountLinksCreate.mockResolvedValue({ url: 'https://connect.stripe.test/x', expires_at: 1 });

    const response = await startOnboarding(activeTutor);

    expect(response.status).toBe(201);
    expect(stripeAccountLinksCreate).toHaveBeenCalledWith(
      expect.objectContaining({ account: winner.stripeAccountId })
    );
  });
});

describe('viewing payout readiness', () => {
  test('shows a ready to receive payouts state once the provider confirms everything', async () => {
    prisma.tutorPayoutAccount.findUnique.mockResolvedValue(storedAccount());
    stripeAccountsRetrieve.mockResolvedValue(readyProviderAccount());

    const response = await getPayoutAccount(activeTutor, '?refresh=true');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(
      expect.objectContaining({
        status: 'READY',
        isPayoutReady: true,
        outstandingRequirementCount: 0,
      })
    );
    expect(prisma.tutorPayoutAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isPayoutReady: true,
          onboardingCompletedAt: expect.any(Date),
        }),
      })
    );
  });

  test('reports incomplete onboarding as a count without naming the documents required', async () => {
    prisma.tutorPayoutAccount.findUnique.mockResolvedValue(storedAccount());
    stripeAccountsRetrieve.mockResolvedValue(
      readyProviderAccount({
        details_submitted: false,
        payouts_enabled: false,
        capabilities: { transfers: 'pending' },
        requirements: {
          disabled_reason: null,
          currently_due: ['individual.id_number', 'external_account'],
          past_due: [],
          eventually_due: [],
          pending_verification: [],
        },
      })
    );

    const response = await getPayoutAccount(activeTutor, '?refresh=true');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(
      expect.objectContaining({
        status: 'ONBOARDING_INCOMPLETE',
        isPayoutReady: false,
        outstandingRequirementCount: 2,
      })
    );
    const body = JSON.stringify(response.body);
    expect(body).not.toContain('individual.id_number');
    expect(body).not.toContain('external_account');
    expect(body).not.toContain('acct_');
  });

  test('reports a restricted account without echoing the provider disabled reason', async () => {
    prisma.tutorPayoutAccount.findUnique.mockResolvedValue(storedAccount());
    stripeAccountsRetrieve.mockResolvedValue(
      readyProviderAccount({
        payouts_enabled: false,
        requirements: {
          disabled_reason: 'requirements.past_due',
          currently_due: [],
          past_due: ['external_account'],
          eventually_due: [],
          pending_verification: [],
        },
      })
    );

    const response = await getPayoutAccount(activeTutor, '?refresh=true');

    expect(response.body.data).toEqual(
      expect.objectContaining({ status: 'RESTRICTED', hasPastDueRequirements: true })
    );
    expect(JSON.stringify(response.body)).not.toContain('requirements.past_due');
  });

  test('returns a not started shape when the tutor has never begun setup', async () => {
    prisma.tutorPayoutAccount.findUnique.mockResolvedValue(null);

    const response = await getPayoutAccount(activeTutor);

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('NOT_STARTED');
    expect(response.body.data.isPayoutReady).toBe(false);
  });

  test('falls back to the last known state when the account is gone at the provider', async () => {
    prisma.tutorPayoutAccount.findUnique.mockResolvedValue(storedAccount({ isPayoutReady: true }));
    stripeAccountsRetrieve.mockRejectedValue({ code: 'resource_missing' });

    const response = await getPayoutAccount(activeTutor, '?refresh=true');

    expect(response.status).toBe(200);
    expect(prisma.tutorPayoutAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isPayoutReady: false, disabledReason: 'account_missing' }),
      })
    );
  });

  test('serves last known readiness rather than failing during a provider outage', async () => {
    prisma.tutorPayoutAccount.findUnique.mockResolvedValue(storedAccount({ isPayoutReady: true }));
    stripeAccountsRetrieve.mockRejectedValue(new Error('gateway timeout'));

    const response = await getPayoutAccount(activeTutor, '?refresh=true');

    expect(response.status).toBe(200);
    expect(response.body.data.isPayoutReady).toBe(true);
  });
});

describe('payout account ownership', () => {
  test.each([
    ['a learner', () => learner],
    ['a tutor whose profile is not approved', () => pendingTutor],
    ['an administrator', () => admin],
    ['a system administrator', () => systemAdmin],
  ])('denies %s access to payout settings', async (_label, getUser) => {
    const user = getUser();

    const read = await getPayoutAccount(user);
    const start = await startOnboarding(user);

    expect(read.status).toBe(403);
    expect(start.status).toBe(403);
    expect(JSON.stringify(read.body)).not.toContain('acct_');
    expect(stripeAccountsCreate).not.toHaveBeenCalled();
    expect(stripeAccountLinksCreate).not.toHaveBeenCalled();
  });

  test('scopes the lookup to the caller rather than any supplied identifier', async () => {
    prisma.tutorPayoutAccount.findUnique.mockResolvedValue(null);

    await getPayoutAccount(activeTutor, '?tutorProfileId=tutor-profile-2');

    expect(prisma.tutorPayoutAccount.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tutorProfileId: 'tutor-profile-1' } })
    );
  });
});

describe('account.updated webhook', () => {
  const sendWebhook = () =>
    request(app)
      .post('/api/v1/payments/stripe/webhook')
      .set('stripe-signature', 'signed')
      .set('content-type', 'application/json')
      .send('{}');

  const accountEvent = (account, overrides = {}) => ({
    id: 'evt_account_1',
    type: 'account.updated',
    created: 1785000000,
    data: { object: account },
    ...overrides,
  });

  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  });

  test('applies readiness and notifies the tutor when onboarding completes', async () => {
    stripeWebhookConstructEvent.mockReturnValue(accountEvent(readyProviderAccount()));
    prisma.tutorPayoutAccount.findUnique.mockResolvedValue(storedAccount());
    prisma.tutorProfile.findUnique.mockResolvedValue({ userId: activeTutor.id });

    const response = await sendWebhook();

    expect(response.status).toBe(200);
    expect(prisma.tutorPayoutAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isPayoutReady: true, status: 'READY' }),
      })
    );
    expect(notifyOrRefresh).toHaveBeenCalledWith(
      activeTutor.id,
      'payment',
      'Payouts enabled',
      expect.any(String),
      '/tutor/payouts'
    );
  });

  test('ignores a replayed event without applying it twice', async () => {
    stripeWebhookConstructEvent.mockReturnValue(accountEvent(readyProviderAccount()));
    prisma.tutorPayoutAccount.findUnique.mockResolvedValue(storedAccount());
    prisma.tutorProfile.findUnique.mockResolvedValue({ userId: activeTutor.id });
    // The webhook ledger primary key rejects the second delivery.
    prisma.stripeWebhookEvent.create
      .mockResolvedValueOnce({ eventId: 'evt_account_1' })
      .mockRejectedValueOnce({ code: 'P2002' });

    const first = await sendWebhook();
    const replay = await sendWebhook();

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(prisma.tutorPayoutAccount.update).toHaveBeenCalledTimes(1);
  });

  test('drops an out of order event so it cannot un-ready a finished tutor', async () => {
    stripeWebhookConstructEvent.mockReturnValue(
      accountEvent(readyProviderAccount({ payouts_enabled: false }), { created: 1784000000 })
    );
    prisma.tutorPayoutAccount.findUnique.mockResolvedValue(
      storedAccount({
        isPayoutReady: true,
        lastEventCreatedAt: new Date(1785000000 * 1000),
      })
    );

    const response = await sendWebhook();

    expect(response.status).toBe(200);
    expect(prisma.tutorPayoutAccount.update).not.toHaveBeenCalled();
  });

  test('records but ignores an event for an account this platform does not know', async () => {
    stripeWebhookConstructEvent.mockReturnValue(
      accountEvent(readyProviderAccount({ id: 'acct_someone_else' }))
    );
    prisma.tutorPayoutAccount.findUnique.mockResolvedValue(null);

    const response = await sendWebhook();

    expect(response.status).toBe(200);
    expect(prisma.tutorPayoutAccount.update).not.toHaveBeenCalled();
    expect(prisma.stripeWebhookEvent.create).toHaveBeenCalled();
  });
});

describe('when the payment provider is not configured', () => {
  test('reports payout setup as unavailable instead of failing', async () => {
    stripeConfigured = false;

    const response = await getPayoutAccount(activeTutor);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      status: 'UNAVAILABLE',
      isPayoutReady: false,
      providerConfigured: false,
    });
  });

  test('refuses to start onboarding rather than pretending it began', async () => {
    stripeConfigured = false;

    const response = await startOnboarding(activeTutor);

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    expect(stripeAccountsCreate).not.toHaveBeenCalled();
  });
});
