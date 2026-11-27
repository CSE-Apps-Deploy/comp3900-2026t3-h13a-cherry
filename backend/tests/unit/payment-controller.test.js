const prisma = {
  user: { findUnique: vi.fn(), update: vi.fn() },
  booking: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), count: vi.fn() },
  payment: { update: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  $transaction: vi.fn(),
};

const stripe = {
  paymentMethods: { list: vi.fn(), retrieve: vi.fn(), detach: vi.fn() },
  customers: { create: vi.fn() },
  setupIntents: { create: vi.fn(), retrieve: vi.fn() },
  webhooks: { constructEvent: vi.fn() },
};
let stripeConfigured = true;

const finalizeSuccessfulPaymentIntent = vi.fn();
const finalizeFailedPaymentIntent = vi.fn();
const recordWebhookEvent = vi.fn();
const retryFailedPayment = vi.fn();
const getPayoutAccountForTutor = vi.fn();
const createOnboardingLink = vi.fn();
const applyAccountUpdatedEvent = vi.fn();
const promoteMatureCompletionPayouts = vi.fn();
const applyRefundWebhookEvent = vi.fn();
const serializeRefund = vi.fn((refund) => refund || null);

const databasePath = require.resolve('../../src/config/database');
const stripePath = require.resolve('../../src/config/stripe');
const acceptancePath = require.resolve('../../src/services/paymentAcceptanceService');
const payoutPath = require.resolve('../../src/services/payoutAccountService');
const completionPath = require.resolve('../../src/services/completionReviewService');
const refundPath = require.resolve('../../src/services/refundService');
const controllerPath = require.resolve('../../src/controllers/paymentController');

for (const modulePath of [
  databasePath,
  stripePath,
  acceptancePath,
  payoutPath,
  completionPath,
  refundPath,
  controllerPath,
]) {
  delete require.cache[modulePath];
}

require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: { prisma },
};
require.cache[stripePath] = {
  id: stripePath,
  filename: stripePath,
  loaded: true,
  exports: { getStripe: () => stripe, isStripeConfigured: () => stripeConfigured },
};
require.cache[acceptancePath] = {
  id: acceptancePath,
  filename: acceptancePath,
  loaded: true,
  exports: {
    finalizeSuccessfulPaymentIntent,
    finalizeFailedPaymentIntent,
    recordWebhookEvent,
    retryFailedPayment,
  },
};
require.cache[payoutPath] = {
  id: payoutPath,
  filename: payoutPath,
  loaded: true,
  exports: { getPayoutAccountForTutor, createOnboardingLink, applyAccountUpdatedEvent },
};
require.cache[completionPath] = {
  id: completionPath,
  filename: completionPath,
  loaded: true,
  exports: { promoteMatureCompletionPayouts },
};
require.cache[refundPath] = {
  id: refundPath,
  filename: refundPath,
  loaded: true,
  exports: { applyRefundWebhookEvent, serializeRefund },
};

const controller = require('../../src/controllers/paymentController');

const makeResponse = () => {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.send = vi.fn(() => res);
  return res;
};

const request = (overrides = {}) => ({
  user: { id: 'learner-1', role: 'LEARNER' },
  params: {},
  query: {},
  body: {},
  headers: {},
  ...overrides,
});

const learner = (overrides = {}) => ({
  id: 'learner-1',
  email: 'learner@example.com',
  firstName: 'Lee',
  lastName: 'Learner',
  role: 'LEARNER',
  stripeCustomerId: 'cus_1',
  stripeDefaultPaymentMethodId: 'pm_1',
  ...overrides,
});

const card = (id = 'pm_1', overrides = {}) => ({
  id,
  type: 'card',
  customer: 'cus_1',
  card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
  billing_details: { name: 'Lee Learner' },
  ...overrides,
});

const booking = (overrides = {}) => ({
  id: 'booking-1',
  learnerId: 'learner-1',
  status: 'PENDING',
  recurringGroupId: null,
  payment: { id: 'payment-1', bookingId: 'booking-1', status: 'PENDING' },
  tutorProfile: { userId: 'tutor-user-1' },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  stripeConfigured = true;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  stripe.paymentMethods.list.mockResolvedValue({ data: [card()] });
  prisma.$transaction.mockImplementation(async (operations) => Promise.all(operations));
  promoteMatureCompletionPayouts.mockResolvedValue(undefined);
});

describe('saved payment method branches', () => {
  test('only lets learners view payment methods', async () => {
    await expect(
      controller.getSavedPaymentMethod(
        request({ user: { id: 'tutor-1', role: 'TUTOR' } }),
        makeResponse()
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  test('rejects a missing learner record', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(controller.getSavedPaymentMethod(request(), makeResponse())).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  test('reports unavailable Stripe and absent payment methods', async () => {
    prisma.user.findUnique.mockResolvedValue(learner());
    stripeConfigured = false;
    const unavailable = makeResponse();
    await controller.getSavedPaymentMethod(request(), unavailable);
    expect(unavailable.json.mock.calls[0][0].data.unavailable).toBe(true);

    stripeConfigured = true;
    prisma.user.findUnique.mockResolvedValue(learner({ stripeCustomerId: null }));
    const absent = makeResponse();
    await controller.getSavedPaymentMethod(request(), absent);
    expect(absent.json.mock.calls[0][0].data.hasPaymentMethod).toBe(false);
  });

  test('maps and sorts the default card first', async () => {
    prisma.user.findUnique.mockResolvedValue(learner({ stripeDefaultPaymentMethodId: 'pm_2' }));
    stripe.paymentMethods.retrieve.mockResolvedValue(card('pm_2', { card: null, billing_details: null }));
    stripe.paymentMethods.list.mockResolvedValue({ data: [card('pm_1'), card('pm_2')] });
    const res = makeResponse();

    await controller.getSavedPaymentMethod(request(), res);

    expect(res.json.mock.calls[0][0].data.paymentMethods.map((method) => method.id)).toEqual([
      'pm_2',
      'pm_1',
    ]);
    expect(res.json.mock.calls[0][0].data.paymentMethod.brand).toBeNull();
  });

  test('returns an unavailable shape after a provider lookup error', async () => {
    prisma.user.findUnique.mockResolvedValue(learner());
    stripe.paymentMethods.retrieve.mockRejectedValue(new Error('outage'));
    const res = makeResponse();
    await controller.getSavedPaymentMethod(request(), res);
    expect(res.json.mock.calls[0][0].data.unavailable).toBe(true);
  });

  test.each([
    [{ user: { id: 'tutor-1', role: 'TUTOR' }, body: { paymentMethodId: 'pm_1' } }, 403],
    [{ body: {} }, 400],
  ])('rejects invalid default-card requests', async (overrides, statusCode) => {
    await expect(
      controller.setDefaultPaymentMethod(request(overrides), makeResponse())
    ).rejects.toMatchObject({ statusCode });
  });

  test('rejects unavailable, missing-customer, and unowned default cards', async () => {
    prisma.user.findUnique.mockResolvedValue(learner());
    stripeConfigured = false;
    await expect(
      controller.setDefaultPaymentMethod(
        request({ body: { paymentMethodId: 'pm_1' } }),
        makeResponse()
      )
    ).rejects.toMatchObject({ statusCode: 503 });

    stripeConfigured = true;
    prisma.user.findUnique.mockResolvedValue(learner({ stripeCustomerId: null }));
    await expect(
      controller.setDefaultPaymentMethod(
        request({ body: { paymentMethodId: 'pm_1' } }),
        makeResponse()
      )
    ).rejects.toMatchObject({ statusCode: 404 });

    prisma.user.findUnique.mockResolvedValue(learner());
    stripe.paymentMethods.list.mockResolvedValue({ data: [] });
    await expect(
      controller.setDefaultPaymentMethod(
        request({ body: { paymentMethodId: 'pm_missing' } }),
        makeResponse()
      )
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test('sets an owned default card', async () => {
    prisma.user.findUnique.mockResolvedValue(learner());
    prisma.user.update.mockResolvedValue({});
    const res = makeResponse();
    await controller.setDefaultPaymentMethod(
      request({ body: { paymentMethodId: 'pm_1' } }),
      res
    );
    expect(res.json.mock.calls[0][0].message).toContain('updated');
  });
});

describe('setup intent branches', () => {
  test('creates a customer using email fallback and then a setup intent', async () => {
    prisma.user.findUnique.mockResolvedValue(
      learner({ firstName: '', lastName: '', stripeCustomerId: null })
    );
    stripe.customers.create.mockResolvedValue({ id: 'cus_new' });
    prisma.user.update.mockResolvedValue({});
    stripe.setupIntents.create.mockResolvedValue({ id: 'seti_1', client_secret: 'secret' });
    const res = makeResponse();

    await controller.createSetupIntent(request(), res);

    expect(stripe.customers.create.mock.calls[0][0].name).toBe('learner@example.com');
    expect(res.json.mock.calls[0][0].data.setupIntentId).toBe('seti_1');
  });

  test('reuses an existing customer and supports the generic name fallback', async () => {
    prisma.user.findUnique.mockResolvedValue(
      learner({ firstName: '', lastName: '', email: '', stripeCustomerId: 'cus_1' })
    );
    stripe.setupIntents.create.mockResolvedValue({ id: 'seti_1', client_secret: 'secret' });
    await controller.createSetupIntent(request(), makeResponse());
    expect(stripe.customers.create).not.toHaveBeenCalled();
  });

  test.each([
    [{ user: { id: 'tutor-1', role: 'TUTOR' } }, 403],
    [{}, 503],
  ])('rejects unavailable setup intent creation', async (overrides, statusCode) => {
    if (statusCode === 503) stripeConfigured = false;
    await expect(controller.createSetupIntent(request(overrides), makeResponse())).rejects.toMatchObject({
      statusCode,
    });
  });

  test('rejects setup intent creation for a deleted user', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(controller.createSetupIntent(request(), makeResponse())).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  test('completes setup without saving a default or attaching a booking', async () => {
    prisma.user.findUnique.mockResolvedValue(learner());
    stripe.setupIntents.retrieve.mockResolvedValue({
      id: 'seti_1',
      status: 'succeeded',
      customer: { id: 'cus_1' },
      payment_method: { id: 'pm_1' },
      metadata: { userId: 'learner-1' },
    });
    stripe.paymentMethods.retrieve.mockResolvedValue(card());
    const res = makeResponse();

    await controller.completeSetupIntent(
      request({ body: { setupIntentId: 'seti_1', saveAsDefault: false } }),
      res
    );

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ savedAsDefault: false, bookingId: null, user: null })
    );
  });

  test.each([
    [{ user: { id: 'tutor-1', role: 'TUTOR' }, body: { setupIntentId: 'seti_1' } }, 403],
    [{ body: {} }, 400],
  ])('rejects invalid setup completion input', async (overrides, statusCode) => {
    await expect(controller.completeSetupIntent(request(overrides), makeResponse())).rejects.toMatchObject({
      statusCode,
    });
  });

  test('rejects missing setup ownership and incomplete setup states', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(
      controller.completeSetupIntent(request({ body: { setupIntentId: 'seti_1' } }), makeResponse())
    ).rejects.toMatchObject({ statusCode: 404 });

    prisma.user.findUnique.mockResolvedValue(learner());
    stripe.setupIntents.retrieve.mockRejectedValueOnce(new Error('missing'));
    await expect(
      controller.completeSetupIntent(request({ body: { setupIntentId: 'seti_1' } }), makeResponse())
    ).rejects.toMatchObject({ statusCode: 404 });

    stripe.setupIntents.retrieve.mockResolvedValueOnce(null);
    await expect(
      controller.completeSetupIntent(request({ body: { setupIntentId: 'seti_1' } }), makeResponse())
    ).rejects.toMatchObject({ statusCode: 404 });

    stripe.setupIntents.retrieve.mockResolvedValueOnce({
      customer: 'cus_other',
      payment_method: 'pm_1',
      metadata: { userId: 'learner-1' },
      status: 'succeeded',
    });
    await expect(
      controller.completeSetupIntent(request({ body: { setupIntentId: 'seti_1' } }), makeResponse())
    ).rejects.toMatchObject({ statusCode: 404 });

    stripe.setupIntents.retrieve.mockResolvedValueOnce({
      customer: 'cus_1',
      payment_method: null,
      metadata: { userId: 'learner-1' },
      status: 'processing',
    });
    await expect(
      controller.completeSetupIntent(request({ body: { setupIntentId: 'seti_1' } }), makeResponse())
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('rejects unverifiable and wrongly attached payment methods', async () => {
    prisma.user.findUnique.mockResolvedValue(learner());
    stripe.setupIntents.retrieve.mockResolvedValue({
      customer: 'cus_1',
      payment_method: 'pm_1',
      metadata: { userId: 'learner-1' },
      status: 'succeeded',
    });
    stripe.paymentMethods.retrieve.mockRejectedValueOnce(new Error('outage'));
    await expect(
      controller.completeSetupIntent(request({ body: { setupIntentId: 'seti_1' } }), makeResponse())
    ).rejects.toMatchObject({ statusCode: 400 });

    stripe.paymentMethods.retrieve.mockResolvedValueOnce(card('pm_1', { customer: 'cus_other' }));
    await expect(
      controller.completeSetupIntent(request({ body: { setupIntentId: 'seti_1' } }), makeResponse())
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('payout, retry, and webhook branches', () => {
  test('returns both retry payment response outcomes and fallback booking data', async () => {
    retryFailedPayment.mockResolvedValueOnce({
      outcome: 'PAYMENT_PROCESSING',
      booking: booking({ version: 2 }),
    });
    prisma.booking.findUnique.mockResolvedValueOnce(null);
    const processing = makeResponse();
    await controller.retryBookingPayment(
      request({ params: { bookingId: 'booking-1' }, body: { expectedVersion: '1' } }),
      processing
    );
    expect(processing.status).toHaveBeenCalledWith(202);

    retryFailedPayment.mockResolvedValueOnce({ outcome: 'ACCEPTED', booking: booking() });
    prisma.booking.findUnique.mockResolvedValueOnce(booking({ status: 'ACCEPTED' }));
    const accepted = makeResponse();
    await controller.retryBookingPayment(
      request({ params: { bookingId: 'booking-1' }, body: { expectedVersion: 1 } }),
      accepted
    );
    expect(accepted.status).toHaveBeenCalledWith(200);
    expect(accepted.json.mock.calls[0][0].data.payment.status).toBe('PAID');
  });

  test.each([
    ['true', true],
    ['1', true],
    ['false', false],
  ])('passes payout refresh=%s as %s', async (refreshValue, expected) => {
    getPayoutAccountForTutor.mockResolvedValue(null);
    const res = makeResponse();
    await controller.getPayoutAccount(
      request({
        user: { id: 'tutor-user-1', role: 'TUTOR', tutorProfile: { id: 'tutor-1' } },
        query: { refresh: refreshValue },
      }),
      res
    );
    expect(getPayoutAccountForTutor).toHaveBeenCalledWith('tutor-1', { refresh: expected });
  });

  test('reports unavailable payout setup and creates onboarding links', async () => {
    stripeConfigured = false;
    const unavailable = makeResponse();
    await controller.getPayoutAccount(request(), unavailable);
    expect(unavailable.json.mock.calls[0][0].data.providerConfigured).toBe(false);

    stripeConfigured = true;
    createOnboardingLink.mockResolvedValue({ url: 'https://stripe.test/onboard', expiresAt: 123 });
    const onboarding = makeResponse();
    await controller.createPayoutOnboardingLink(
      request({ user: { tutorProfile: { id: 'tutor-1' } } }),
      onboarding
    );
    expect(onboarding.status).toHaveBeenCalledWith(201);
  });

  test('handles provider and verification webhook failures', async () => {
    stripeConfigured = false;
    const unavailable = makeResponse();
    await controller.handleStripeWebhook(request(), unavailable);
    expect(unavailable.status).toHaveBeenCalledWith(503);

    stripeConfigured = true;
    const noSecret = makeResponse();
    await controller.handleStripeWebhook(request(), noSecret);
    expect(noSecret.status).toHaveBeenCalledWith(503);

    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    const noSignature = makeResponse();
    await controller.handleStripeWebhook(request(), noSignature);
    expect(noSignature.status).toHaveBeenCalledWith(400);

    stripe.webhooks.constructEvent.mockImplementationOnce(() => {
      throw new Error('bad signature');
    });
    const invalid = makeResponse();
    await controller.handleStripeWebhook(
      request({ headers: { 'stripe-signature': 'bad' } }),
      invalid
    );
    expect(invalid.status).toHaveBeenCalledWith(400);
  });

  test.each([
    ['setup_intent.succeeded', recordWebhookEvent],
    ['payment_intent.succeeded', finalizeSuccessfulPaymentIntent],
    ['account.updated', applyAccountUpdatedEvent],
    ['refund.created', applyRefundWebhookEvent],
    ['refund.updated', applyRefundWebhookEvent],
    ['refund.failed', applyRefundWebhookEvent],
    ['customer.created', recordWebhookEvent],
  ])('handles the %s webhook', async (type, handler) => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    const event = { id: `evt_${type}`, type, data: { object: { id: 'object-1' } } };
    stripe.webhooks.constructEvent.mockReturnValue(event);
    const res = makeResponse();

    await controller.handleStripeWebhook(
      request({ headers: { 'stripe-signature': 'valid' }, body: Buffer.from('{}') }),
      res
    );

    expect(handler).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  test.each([undefined, 'Card declined'])('handles failed payment webhooks', async (message) => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    const paymentIntent = {
      id: 'pi_1',
      ...(message ? { last_payment_error: { message } } : {}),
    };
    stripe.webhooks.constructEvent.mockReturnValue({
      id: 'evt_failed',
      type: 'payment_intent.payment_failed',
      data: { object: paymentIntent },
    });

    await controller.handleStripeWebhook(
      request({ headers: { 'stripe-signature': 'valid' } }),
      makeResponse()
    );

    expect(finalizeFailedPaymentIntent).toHaveBeenCalledWith(
      paymentIntent,
      message || 'Stripe payment failed',
      expect.any(Object)
    );
  });
});
