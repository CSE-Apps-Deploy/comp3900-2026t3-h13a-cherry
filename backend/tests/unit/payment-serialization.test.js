const { serializePayment } = require('../../src/utils/paymentSerialization');

describe('payment serialization', () => {
  const payment = {
    id: 'payment-1',
    status: 'FAILED',
    failureReason: 'The payment method was declined.',
    stripeCustomerId: 'cus_secret',
    stripePaymentMethodId: 'pm_secret',
    stripePaymentIntentId: 'pi_secret',
    stripeIdempotencyKey: 'secret-key',
    acceptanceAuthorizedById: 'tutor-1',
    acceptanceBookingVersion: 2,
    payoutStatus: 'FAILED',
    payoutPendingAt: new Date('2026-07-24T01:00:00.000Z'),
    payoutEligibleAt: new Date('2026-07-24T02:00:00.000Z'),
    payoutAt: null,
    payoutFailedAt: new Date('2026-07-24T03:00:00.000Z'),
    payoutFailureReason: 'The tutor payout account is restricted.',
    refund: {
      id: 'refund-1',
      source: 'ADMIN_COMPLETION_DISPUTE',
      amount: 100,
      currency: 'aud',
      status: 'PROCESSING',
      resolutionNote: 'Internal administrator evidence summary.',
      failureReason: null,
      requestedAt: new Date('2026-07-24T04:00:00.000Z'),
      attemptCount: 1,
      attempts: [
        {
          providerRefundId: 're_secret',
          idempotencyKey: 'pay08_secret_key',
        },
      ],
    },
    attempts: [
      {
        id: 'attempt-1',
        sequence: 1,
        source: 'ACCEPTANCE',
        outcome: 'FAILED',
        initiatedByRole: 'TUTOR',
        providerCode: 'card_declined',
        safeFailureReason: 'The payment method was declined.',
        startedAt: new Date('2026-07-24T01:00:00.000Z'),
        completedAt: new Date('2026-07-24T01:00:01.000Z'),
      },
    ],
  };

  test('returns sanitized attempt history to booking participants', () => {
    const result = serializePayment(payment);

    expect(result).not.toHaveProperty('stripeCustomerId');
    expect(result).not.toHaveProperty('stripePaymentMethodId');
    expect(result).not.toHaveProperty('stripePaymentIntentId');
    expect(result).not.toHaveProperty('stripeIdempotencyKey');
    expect(result).not.toHaveProperty('acceptanceAuthorizedById');
    expect(result).not.toHaveProperty('payoutStatus');
    expect(result).not.toHaveProperty('payoutFailedAt');
    expect(result).not.toHaveProperty('payoutFailureReason');
    expect(result.attempts[0]).toEqual(
      expect.objectContaining({
        number: 1,
        outcome: 'FAILED',
        failureReason: 'The payment method was declined.',
      })
    );
    expect(result.attempts[0]).not.toHaveProperty('providerCode');
    expect(result.refund).toEqual(
      expect.objectContaining({
        id: 'refund-1',
        source: 'ADMIN_COMPLETION_DISPUTE',
        amount: '100.00',
        currency: 'AUD',
        status: 'PROCESSING',
      })
    );
    expect(result.refund).not.toHaveProperty('resolutionNote');
    expect(result.refund).not.toHaveProperty('attempts');
    expect(result.refund).not.toHaveProperty('providerRefundId');
    expect(result.refund).not.toHaveProperty('idempotencyKey');
  });

  test('adds only the non-sensitive provider code for admins', () => {
    const result = serializePayment(payment, { isAdmin: true });

    expect(result.attempts[0].providerCode).toBe('card_declined');
    expect(result.refund.resolutionNote).toBe('Internal administrator evidence summary.');
  });
});
