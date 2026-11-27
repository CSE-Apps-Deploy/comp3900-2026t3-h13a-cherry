const databaseModulePath = require.resolve('../../src/config/database');
const stripeModulePath = require.resolve('../../src/config/stripe');
const loggerModulePath = require.resolve('../../src/config/logger');
const paymentAcceptanceModulePath = require.resolve('../../src/services/paymentAcceptanceService');
const serviceModulePath = require.resolve('../../src/services/refundService');

const prisma = {
  payment: { update: vi.fn() },
  paymentRefund: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  paymentRefundAttempt: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  $executeRaw: vi.fn(),
  $transaction: vi.fn(),
};
const stripeRefundCreate = vi.fn();
const stripeRefundList = vi.fn();
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
let stripeConfigured = true;

for (const modulePath of [
  databaseModulePath,
  stripeModulePath,
  loggerModulePath,
  paymentAcceptanceModulePath,
  serviceModulePath,
]) {
  delete require.cache[modulePath];
}

require.cache[databaseModulePath] = {
  id: databaseModulePath,
  filename: databaseModulePath,
  loaded: true,
  exports: { prisma },
};
require.cache[stripeModulePath] = {
  id: stripeModulePath,
  filename: stripeModulePath,
  loaded: true,
  exports: {
    isStripeConfigured: () => stripeConfigured,
    getStripe: () => ({
      refunds: { create: stripeRefundCreate, list: stripeRefundList },
    }),
  },
};
require.cache[loggerModulePath] = {
  id: loggerModulePath,
  filename: loggerModulePath,
  loaded: true,
  exports: logger,
};
require.cache[paymentAcceptanceModulePath] = {
  id: paymentAcceptanceModulePath,
  filename: paymentAcceptanceModulePath,
  loaded: true,
  exports: { createWebhookReceipt: vi.fn() },
};

const {
  REFUND_SOURCES,
  applyRefundWebhookEvent,
  claimRefundAttempt,
  createRefundClaim,
  mapProviderRefundStatus,
  safeRefundFailure,
  submitRefund,
} = require('../../src/services/refundService');

const payment = {
  id: 'payment-1',
  bookingId: 'booking-1',
  status: 'PAID',
  amount: 100,
  refundAmount: 0,
  currency: 'AUD',
  platformFeeAmount: 15,
  tutorPayoutAmount: 85,
  payoutStatus: 'DISPUTED',
  stripePaymentIntentId: 'pi_original_1',
};

const processingRefund = () => ({
  id: 'refund-1',
  paymentId: payment.id,
  source: REFUND_SOURCES.ADMIN_COMPLETION_DISPUTE,
  amount: 100,
  currency: 'AUD',
  status: 'PROCESSING',
  attemptCount: 1,
  resolutionNote: 'The evidence supports the learner.',
  attempts: [
    {
      id: 'refund-attempt-1',
      refundId: 'refund-1',
      sequence: 1,
      status: 'PROCESSING',
      idempotencyKey: 'pay08_refund_refund-1_attempt_1',
    },
  ],
  payment: {
    ...payment,
    booking: { id: 'booking-1' },
  },
});

beforeEach(() => {
  vi.resetAllMocks();
  stripeConfigured = true;
  prisma.$transaction.mockImplementation((callback) => callback(prisma));
  stripeRefundList.mockResolvedValue({ data: [], has_more: false });
});

describe('PAY-08 refund service', () => {
  test('reserves the full outstanding learner payment and removes every tutor payout field', async () => {
    let createdRefund;
    prisma.paymentRefund.findUnique.mockResolvedValueOnce(null);
    prisma.paymentRefund.create.mockImplementation(async ({ data }) => {
      createdRefund = {
        ...data,
        attempts: [
          {
            id: 'refund-attempt-created',
            refundId: data.id,
            ...data.attempts.create,
          },
        ],
      };
      return createdRefund;
    });
    prisma.payment.update.mockResolvedValueOnce({ id: payment.id });

    const result = await createRefundClaim(prisma, {
      payment,
      initiatedById: 'admin-1',
      source: REFUND_SOURCES.ADMIN_COMPLETION_DISPUTE,
      resolutionNote: 'The evidence supports the learner.',
    });

    expect(result.amount).toBe(100);
    expect(result.status).toBe('PROCESSING');
    expect(result.attemptCount).toBe(1);
    expect(result.attempts[0].idempotencyKey).toBe(
      `pay08_refund_${result.id}_attempt_1`
    );
    expect(prisma.payment.update).toHaveBeenCalledWith({
      where: { id: payment.id },
      data: {
        refundAmount: 100,
        refundedAt: null,
        platformFeeAmount: 0,
        tutorPayoutAmount: 0,
        payoutStatus: null,
        payoutEligibleAt: null,
        payoutAt: null,
        payoutFailedAt: null,
        payoutFailureReason: null,
      },
    });
  });

  test('submits an exact Stripe refund with the persisted attempt idempotency key', async () => {
    const refund = processingRefund();
    prisma.paymentRefund.findUnique.mockResolvedValue(refund);
    prisma.paymentRefundAttempt.findUnique.mockResolvedValue(refund.attempts[0]);
    prisma.paymentRefundAttempt.update.mockResolvedValue({
      ...refund.attempts[0],
      status: 'SUCCEEDED',
    });
    prisma.paymentRefund.update.mockImplementation(async ({ data }) => ({
      ...refund,
      ...data,
    }));
    prisma.payment.update.mockResolvedValue({ id: payment.id, status: 'REFUNDED' });
    stripeRefundCreate.mockResolvedValue({ id: 're_provider_1', status: 'succeeded' });

    const result = await submitRefund(refund.id);

    expect(stripeRefundList).toHaveBeenCalledWith({
      payment_intent: payment.stripePaymentIntentId,
      limit: 100,
    });
    expect(stripeRefundCreate).toHaveBeenCalledWith(
      {
        payment_intent: payment.stripePaymentIntentId,
        amount: 10000,
        metadata: {
          paymentRefundId: refund.id,
          paymentRefundAttemptId: refund.attempts[0].id,
          paymentId: payment.id,
          bookingId: 'booking-1',
          source: REFUND_SOURCES.ADMIN_COMPLETION_DISPUTE,
          platform: 'tutorconnect',
        },
      },
      { idempotencyKey: refund.attempts[0].idempotencyKey }
    );
    expect(prisma.paymentRefundAttempt.update).toHaveBeenCalledWith({
      where: { id: refund.attempts[0].id },
      data: { providerRequestStartedAt: expect.any(Date) },
    });
    expect(result.status).toBe('SUCCEEDED');
    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: payment.id },
        data: expect.objectContaining({
          status: 'REFUNDED',
          refundAmount: 100,
          refundedAt: expect.any(Date),
          tutorPayoutAmount: 0,
          payoutStatus: null,
        }),
      })
    );
  });

  test('reconciles an existing provider refund without sending a second create request', async () => {
    const refund = processingRefund();
    const attempt = refund.attempts[0];
    const providerRefund = {
      id: 're_existing_current',
      status: 'succeeded',
      payment_intent: payment.stripePaymentIntentId,
      amount: 10000,
      currency: 'aud',
      metadata: {
        paymentRefundId: refund.id,
        paymentRefundAttemptId: attempt.id,
        paymentId: payment.id,
        bookingId: 'booking-1',
        source: refund.source,
      },
    };
    stripeRefundList.mockResolvedValue({ data: [providerRefund], has_more: false });
    prisma.paymentRefund.findUnique.mockResolvedValue(refund);
    prisma.paymentRefundAttempt.findUnique.mockResolvedValue(attempt);
    prisma.paymentRefundAttempt.update.mockResolvedValue({ ...attempt, status: 'SUCCEEDED' });
    prisma.paymentRefund.update.mockImplementation(async ({ data }) => ({ ...refund, ...data }));
    prisma.payment.update.mockResolvedValue({ id: payment.id, status: 'REFUNDED' });

    const result = await submitRefund(refund.id);

    expect(result.status).toBe('SUCCEEDED');
    expect(stripeRefundCreate).not.toHaveBeenCalled();
    expect(prisma.paymentRefundAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: attempt.id },
        data: expect.objectContaining({
          status: 'SUCCEEDED',
          providerRefundId: providerRefund.id,
        }),
      })
    );
    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REFUNDED' }) })
    );
  });

  test('reconciles a successful older provider attempt as the definitive outcome', async () => {
    const olderAttempt = {
      id: 'refund-attempt-1',
      refundId: 'refund-1',
      sequence: 1,
      status: 'PROCESSING',
      idempotencyKey: 'pay08_refund_refund-1_attempt_1',
    };
    const currentAttempt = {
      id: 'refund-attempt-2',
      refundId: 'refund-1',
      sequence: 2,
      status: 'PROCESSING',
      idempotencyKey: 'pay08_refund_refund-1_attempt_2',
    };
    const refund = {
      ...processingRefund(),
      attemptCount: 2,
      attempts: [currentAttempt, olderAttempt],
    };
    const providerRefund = {
      id: 're_existing_old',
      status: 'succeeded',
      payment_intent: payment.stripePaymentIntentId,
      amount: 10000,
      currency: 'aud',
      metadata: {
        paymentRefundId: refund.id,
        paymentRefundAttemptId: olderAttempt.id,
        paymentId: payment.id,
        bookingId: 'booking-1',
        source: refund.source,
      },
    };
    stripeRefundList.mockResolvedValue({ data: [providerRefund], has_more: false });
    prisma.paymentRefund.findUnique.mockResolvedValue(refund);
    prisma.paymentRefundAttempt.findUnique.mockImplementation(async ({ where }) =>
      where.id === olderAttempt.id ? olderAttempt : currentAttempt
    );
    prisma.paymentRefundAttempt.update.mockResolvedValue({
      ...olderAttempt,
      status: 'SUCCEEDED',
    });
    prisma.paymentRefund.update.mockImplementation(async ({ data }) => ({ ...refund, ...data }));
    prisma.payment.update.mockResolvedValue({ id: payment.id, status: 'REFUNDED' });

    const result = await submitRefund(refund.id);

    expect(result.status).toBe('SUCCEEDED');
    expect(stripeRefundCreate).not.toHaveBeenCalled();
    expect(prisma.paymentRefundAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: olderAttempt.id } })
    );
    expect(prisma.paymentRefund.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SUCCEEDED' }) })
    );
  });

  test('does not send a refund when provider history cannot be reconciled', async () => {
    const refund = processingRefund();
    const attempt = refund.attempts[0];
    const listFailure = { type: 'StripeConnectionError' };
    stripeRefundList.mockRejectedValue(listFailure);
    prisma.paymentRefund.findUnique.mockResolvedValue(refund);
    prisma.paymentRefundAttempt.findUnique.mockResolvedValue(attempt);
    prisma.paymentRefundAttempt.update.mockResolvedValue(attempt);
    prisma.paymentRefund.update.mockImplementation(async ({ data }) => ({ ...refund, ...data }));

    const result = await submitRefund(refund.id);

    expect(result.status).toBe('FAILED');
    expect(result.failureReason).toMatch(/history could not be reconciled/i);
    expect(stripeRefundCreate).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });

  test('fails safely without contacting Stripe when the original payment reference is missing', async () => {
    const refund = processingRefund();
    refund.payment.stripePaymentIntentId = null;
    const attempt = refund.attempts[0];
    prisma.paymentRefund.findUnique.mockResolvedValue(refund);
    prisma.paymentRefundAttempt.findUnique.mockResolvedValue(attempt);
    prisma.paymentRefundAttempt.update.mockResolvedValue({ ...attempt, status: 'FAILED' });
    prisma.paymentRefund.update.mockImplementation(async ({ data }) => ({
      ...refund,
      ...data,
    }));

    const result = await submitRefund(refund.id);

    expect(result.status).toBe('FAILED');
    expect(result.failureReason).toMatch(/payment reference is missing/i);
    expect(stripeRefundList).not.toHaveBeenCalled();
    expect(stripeRefundCreate).not.toHaveBeenCalled();
  });

  test('re-reads a concurrently started provider request before failing reconciliation', async () => {
    const refund = processingRefund();
    const currentAttempt = {
      ...refund.attempts[0],
      providerRequestStartedAt: new Date('2026-08-05T01:00:00.000Z'),
    };
    stripeRefundList.mockRejectedValue({ type: 'StripeConnectionError' });
    prisma.paymentRefund.findUnique.mockResolvedValue(refund);
    prisma.paymentRefundAttempt.findUnique.mockResolvedValue(currentAttempt);
    prisma.paymentRefundAttempt.update.mockResolvedValue(currentAttempt);
    prisma.paymentRefund.update.mockImplementation(async ({ data }) => ({ ...refund, ...data }));

    const result = await submitRefund(refund.id);

    expect(result.status).toBe('PROCESSING');
    expect(result.failureReason).toMatch(/after a provider request started/i);
    expect(stripeRefundCreate).not.toHaveBeenCalled();
    expect(prisma.paymentRefundAttempt.create).not.toHaveBeenCalled();
  });

  test('keeps an indeterminate provider result processing so replay uses the same key', async () => {
    const refund = processingRefund();
    prisma.paymentRefund.findUnique.mockResolvedValue(refund);
    prisma.paymentRefundAttempt.findUnique.mockResolvedValue(refund.attempts[0]);
    prisma.paymentRefund.update.mockImplementation(async ({ data }) => ({
      ...refund,
      ...data,
    }));
    prisma.paymentRefundAttempt.update.mockResolvedValue(refund.attempts[0]);
    stripeRefundCreate.mockRejectedValue({ type: 'StripeConnectionError' });

    const result = await submitRefund(refund.id);

    expect(result.status).toBe('PROCESSING');
    expect(result.failureReason).toMatch(/same request key/i);
    expect(stripeRefundCreate).toHaveBeenCalledWith(
      expect.any(Object),
      { idempotencyKey: 'pay08_refund_refund-1_attempt_1' }
    );
    expect(prisma.paymentRefundAttempt.create).not.toHaveBeenCalled();
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });

  test('creates a new auditable idempotency key only after a definitive failed attempt', async () => {
    const failedRefund = {
      ...processingRefund(),
      status: 'FAILED',
      attempts: [
        {
          ...processingRefund().attempts[0],
          status: 'FAILED',
        },
      ],
    };
    const retryAttempt = {
      id: 'refund-attempt-2',
      refundId: failedRefund.id,
      sequence: 2,
      status: 'PROCESSING',
      idempotencyKey: 'pay08_refund_refund-1_attempt_2',
    };
    prisma.paymentRefund.findUnique.mockResolvedValueOnce(failedRefund);
    prisma.paymentRefundAttempt.create.mockResolvedValueOnce(retryAttempt);
    prisma.paymentRefund.update.mockResolvedValueOnce({
      ...failedRefund,
      status: 'PROCESSING',
      attemptCount: 2,
      attempts: [retryAttempt, ...failedRefund.attempts],
    });

    const result = await claimRefundAttempt(failedRefund.id);

    expect(prisma.paymentRefundAttempt.create).toHaveBeenCalledWith({
      data: {
        refundId: failedRefund.id,
        sequence: 2,
        status: 'PROCESSING',
        idempotencyKey: 'pay08_refund_refund-1_attempt_2',
      },
    });
    expect(result.attemptCount).toBe(2);
    expect(result.attempts[0].idempotencyKey).toBe('pay08_refund_refund-1_attempt_2');
  });

  test('accepts a confirmed success from an older attempt but ignores its later failure state', async () => {
    const refund = {
      ...processingRefund(),
      attemptCount: 2,
    };
    const olderAttempt = {
      ...refund.attempts[0],
      sequence: 1,
      refund: { ...refund, payment: refund.payment },
    };
    prisma.paymentRefundAttempt.findUnique.mockResolvedValue(olderAttempt);
    prisma.paymentRefund.findUnique.mockResolvedValue(refund);
    prisma.paymentRefundAttempt.findUnique.mockResolvedValue(olderAttempt);
    prisma.paymentRefundAttempt.update.mockResolvedValue({
      ...olderAttempt,
      status: 'SUCCEEDED',
    });
    prisma.paymentRefund.update.mockImplementation(async ({ data }) => ({
      ...refund,
      ...data,
    }));
    prisma.payment.update.mockResolvedValue({ id: payment.id, status: 'REFUNDED' });

    const success = await applyRefundWebhookEvent({
      id: 'evt_old_refund_success',
      type: 'refund.updated',
      data: {
        object: {
          id: 're_provider_old',
          status: 'succeeded',
          payment_intent: payment.stripePaymentIntentId,
          amount: 10000,
          currency: 'aud',
          metadata: {
            paymentRefundId: refund.id,
            paymentRefundAttemptId: olderAttempt.id,
            paymentId: payment.id,
            bookingId: 'booking-1',
            source: refund.source,
          },
        },
      },
    });

    expect(success.outcome).toBe('APPLIED');
    expect(success.refund.status).toBe('SUCCEEDED');
    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REFUNDED' }) })
    );

    vi.clearAllMocks();
    prisma.$transaction.mockImplementation((callback) => callback(prisma));
    const succeededRefund = { ...refund, status: 'SUCCEEDED' };
    const failedOldAttempt = {
      ...olderAttempt,
      status: 'PROCESSING',
      refund: { ...succeededRefund, payment: refund.payment },
    };
    prisma.paymentRefundAttempt.findUnique.mockResolvedValue(failedOldAttempt);
    prisma.paymentRefund.findUnique.mockResolvedValue(succeededRefund);
    prisma.paymentRefundAttempt.findUnique.mockResolvedValue(failedOldAttempt);
    prisma.paymentRefundAttempt.update.mockResolvedValue({
      ...failedOldAttempt,
      status: 'FAILED',
    });

    const failure = await applyRefundWebhookEvent({
      id: 'evt_old_refund_failure',
      type: 'refund.failed',
      data: {
        object: {
          id: 're_provider_old',
          status: 'failed',
          payment_intent: payment.stripePaymentIntentId,
          amount: 10000,
          currency: 'aud',
          failure_reason: 'provider_failure',
          metadata: {
            paymentRefundId: refund.id,
            paymentRefundAttemptId: failedOldAttempt.id,
            paymentId: payment.id,
            bookingId: 'booking-1',
            source: refund.source,
          },
        },
      },
    });

    expect(failure.outcome).toBe('APPLIED');
    expect(failure.refund.status).toBe('SUCCEEDED');
    expect(prisma.paymentRefund.update).not.toHaveBeenCalled();
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });

  test('ignores a webhook whose provider amount does not match the refund claim', async () => {
    const refund = processingRefund();
    const attempt = {
      ...refund.attempts[0],
      refund: { ...refund, payment: refund.payment },
    };
    prisma.paymentRefundAttempt.findUnique.mockResolvedValue(attempt);

    const result = await applyRefundWebhookEvent({
      id: 'evt_mismatched_refund',
      type: 'refund.updated',
      data: {
        object: {
          id: 're_wrong_amount',
          status: 'succeeded',
          payment_intent: payment.stripePaymentIntentId,
          amount: 9999,
          currency: 'aud',
          metadata: {
            paymentRefundId: refund.id,
            paymentRefundAttemptId: attempt.id,
            paymentId: payment.id,
            bookingId: 'booking-1',
            source: refund.source,
          },
        },
      },
    });

    expect(result).toEqual({ outcome: 'IGNORED' });
    expect(prisma.paymentRefundAttempt.update).not.toHaveBeenCalled();
    expect(prisma.paymentRefund.update).not.toHaveBeenCalled();
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });

  test('normalises provider statuses and exposes only safe failure messages', () => {
    expect(mapProviderRefundStatus('succeeded')).toBe('SUCCEEDED');
    expect(mapProviderRefundStatus('failed')).toBe('FAILED');
    expect(mapProviderRefundStatus('pending')).toBe('PROCESSING');
    expect(safeRefundFailure({ code: 'balance_insufficient' })).toMatch(/Stripe balance/i);
    expect(safeRefundFailure({ code: 'secret_internal_detail' })).not.toContain(
      'internal detail'
    );
  });
});
