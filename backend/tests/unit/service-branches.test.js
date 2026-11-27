const {
  assertRefundablePayment,
  findExistingProviderRefund,
  getRefundAmounts,
  isCapturedPayment,
  isIndeterminateProviderError: isIndeterminateRefundError,
  mapProviderRefundStatus,
  providerRefundMatchesClaim,
  safeRefundFailure,
  serializeRefund,
} = require('../../src/services/refundService');
const {
  groupPayoutCandidates,
  isIndeterminateProviderError: isIndeterminateTransferError,
  safeTransferFailure,
  serializeRun,
} = require('../../src/services/adminPayoutService');
const { serializePayment, serializePaymentAttempt } = require('../../src/utils/paymentSerialization');
const {
  buildEarningPreview,
  calculateEarning,
  formatMoney,
  formatPercent,
  fromMinorUnits,
  toMinorUnits,
} = require('../../src/utils/earnings');

describe('refund pure-function branches', () => {
  test('serializes absent and default-valued refunds', () => {
    expect(serializeRefund(null)).toBeNull();
    expect(serializeRefund({ id: 'refund-1', amount: null, currency: '', attemptCount: null })).toEqual(
      expect.objectContaining({
        amount: '0.00',
        currency: 'AUD',
        failureReason: null,
        failedAt: null,
        completedAt: null,
        attemptCount: 0,
      })
    );
  });

  test.each([
    ['PAID', true],
    ['completed', true],
    ['PARTIALLY_REFUNDED', true],
    ['PENDING', false],
    [null, false],
  ])('recognizes captured payment status %s', (status, expected) => {
    expect(isCapturedPayment(status === null ? null : { status })).toBe(expected);
  });

  test('clamps invalid and excessive refund amounts', () => {
    expect(getRefundAmounts()).toEqual({
      originalAmount: 0,
      alreadyRefunded: 0,
      outstandingAmount: 0,
    });
    expect(getRefundAmounts({ amount: 100, refundAmount: -20 })).toEqual({
      originalAmount: 100,
      alreadyRefunded: 0,
      outstandingAmount: 100,
    });
    expect(getRefundAmounts({ amount: 100, refundAmount: 120 })).toEqual({
      originalAmount: 100,
      alreadyRefunded: 100,
      outstandingAmount: 0,
    });
  });

  test.each([
    [null, 'captured payment'],
    [{ status: 'PENDING' }, 'captured payment'],
    [{ status: 'PAID', payoutStatus: 'PROCESSING', amount: 10 }, 'already being paid'],
    [{ status: 'PAID', payoutStatus: 'PAID', amount: 10 }, 'already being paid'],
    [{ status: 'PAID', amount: 10, refundAmount: 10 }, 'fully refunded'],
  ])('rejects non-refundable payment states', (payment, message) => {
    expect(() => assertRefundablePayment(payment)).toThrow(message);
  });

  test('returns refundable outstanding amounts', () => {
    expect(assertRefundablePayment({ status: 'PAID', amount: 10, refundAmount: 2 })).toEqual({
      originalAmount: 10,
      alreadyRefunded: 2,
      outstandingAmount: 8,
    });
  });

  test.each([
    ['succeeded', 'SUCCEEDED'],
    ['failed', 'FAILED'],
    ['canceled', 'FAILED'],
    ['pending', 'PROCESSING'],
    [null, 'PROCESSING'],
  ])('maps provider refund state %s', (status, expected) => {
    expect(mapProviderRefundStatus(status)).toBe(expected);
  });

  test.each([
    [{ code: 'charge_already_refunded' }, 'already been refunded'],
    [{ raw: { code: 'balance_insufficient' } }, 'balance cannot cover'],
    [{ code: 'card_declined' }, 'card_declined'],
    [{}, 'could not process'],
  ])('creates a safe refund failure', (error, message) => {
    expect(safeRefundFailure(error)).toContain(message);
  });

  test.each([
    [{ type: 'StripeConnectionError' }, true],
    [{ rawType: 'StripeAPIError' }, true],
    [{ statusCode: 500 }, true],
    [{ status: 503 }, true],
    [{ errno: 'etimedout' }, true],
    [{ code: 'ECONNRESET' }, true],
    [{ code: 'EPIPE' }, true],
    [{ code: 'ENOTFOUND' }, true],
    [{ code: 'card_declined', statusCode: 402 }, false],
  ])('classifies refund provider errors', (error, expected) => {
    expect(isIndeterminateRefundError(error)).toBe(expected);
  });

  test('checks every provider refund claim field', () => {
    const refund = {
      id: 'refund-1',
      paymentId: 'payment-1',
      source: 'ADMIN_COMPLETION_DISPUTE',
      amount: 10,
      currency: 'AUD',
      payment: { bookingId: 'booking-1', stripePaymentIntentId: 'pi_1' },
    };
    const attempt = { id: 'attempt-1', providerRefundId: null };
    const provider = {
      id: 're_1',
      payment_intent: { id: 'pi_1' },
      amount: 1000,
      currency: 'aud',
      metadata: {
        paymentRefundId: 'refund-1',
        paymentRefundAttemptId: 'attempt-1',
        paymentId: 'payment-1',
        bookingId: 'booking-1',
        source: 'ADMIN_COMPLETION_DISPUTE',
      },
    };

    expect(providerRefundMatchesClaim(provider, refund, attempt)).toBe(true);
    const invalidProviders = [
      null,
      { ...provider, id: '' },
      { ...provider, metadata: { ...provider.metadata, paymentRefundId: 'wrong' } },
      { ...provider, metadata: { ...provider.metadata, paymentRefundAttemptId: 'wrong' } },
      { ...provider, metadata: { ...provider.metadata, paymentId: 'wrong' } },
      { ...provider, metadata: { ...provider.metadata, bookingId: 'wrong' } },
      { ...provider, metadata: { ...provider.metadata, source: 'wrong' } },
      { ...provider, payment_intent: 'pi_wrong' },
      { ...provider, amount: 999 },
      { ...provider, currency: 'usd' },
    ];
    for (const invalid of invalidProviders) {
      expect(providerRefundMatchesClaim(invalid, refund, attempt)).toBe(false);
    }
    expect(providerRefundMatchesClaim(provider, refund, null)).toBe(false);
    expect(
      providerRefundMatchesClaim(provider, refund, { ...attempt, providerRefundId: 're_other' })
    ).toBe(false);
  });

  test('finds the strongest matching refund across provider pages', async () => {
    const refund = {
      id: 'refund-1',
      paymentId: 'payment-1',
      source: 'ADMIN_COMPLETION_DISPUTE',
      amount: 10,
      currency: 'AUD',
      attemptCount: 2,
      payment: { bookingId: 'booking-1', stripePaymentIntentId: 'pi_1' },
      attempts: [
        { id: 'attempt-1', sequence: 1 },
        { id: 'attempt-2', sequence: 2 },
      ],
    };
    const provider = (id, attemptId, status) => ({
      id,
      status,
      payment_intent: 'pi_1',
      amount: 1000,
      currency: 'aud',
      metadata: {
        paymentRefundId: 'refund-1',
        paymentRefundAttemptId: attemptId,
        paymentId: 'payment-1',
        bookingId: 'booking-1',
        source: 'ADMIN_COMPLETION_DISPUTE',
      },
    });
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        data: [provider('re_failed_old', 'attempt-1', 'failed')],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [provider('re_processing', 'attempt-2', 'pending')],
        has_more: false,
      });

    const match = await findExistingProviderRefund({ refunds: { list } }, refund);

    expect(match.providerRefund.id).toBe('re_processing');
    expect(list).toHaveBeenLastCalledWith(
      expect.objectContaining({ starting_after: 're_failed_old' })
    );
  });

  test('returns null for malformed empty provider pages', async () => {
    const refund = {
      payment: { stripePaymentIntentId: 'pi_1' },
      attempts: [],
    };
    const list = vi.fn().mockResolvedValue({ data: null, has_more: true });
    await expect(findExistingProviderRefund({ refunds: { list } }, refund)).resolves.toBeNull();
  });
});

describe('payout and payment serialization branches', () => {
  test('groups default-valued candidates and reuses an existing group', () => {
    const base = {
      booking: { tutorId: 'tutor-1', tutorProfile: null },
      tutorPayoutAmount: '1.25',
    };
    const groups = groupPayoutCandidates([base, { ...base, tutorPayoutAmount: '2.75' }]);
    expect(groups[0]).toEqual(
      expect.objectContaining({ currency: 'AUD', amount: '4.00', paymentCount: 2 })
    );
  });

  test('serializes complete and default-valued payout runs', () => {
    const run = {
      id: 'run-1',
      status: 'COMPLETED',
      paymentCount: 1,
      transferCount: 1,
      successfulTransferCount: 1,
      failedTransferCount: 0,
      startedAt: new Date(),
      completedAt: new Date(),
      initiatedByAdmin: { id: 'admin-1', firstName: 'Ada', lastName: 'Admin', role: 'ADMIN' },
      transfers: [
        {
          id: 'transfer-1',
          tutorProfileId: 'tutor-1',
          status: 'SUCCEEDED',
          amount: 12,
          currency: 'aud',
          providerTransferId: 'tr_1',
          failureReason: '',
          attemptedAt: new Date(),
          completedAt: new Date(),
          tutorProfile: { user: { firstName: 'Taylor', lastName: 'Tutor', email: 't@example.com' } },
          items: [
            {
              paymentId: 'payment-1',
              amount: 12,
              payment: {
                booking: {
                  id: 'booking-1',
                  subject: 'Maths',
                  scheduledAt: new Date(),
                  completedAt: new Date(),
                  learner: { id: 'learner-1' },
                },
              },
            },
          ],
        },
      ],
    };
    expect(serializeRun(run).transfers[0].lessons[0].subject).toBe('Maths');

    const defaults = serializeRun({
      ...run,
      completedAt: null,
      initiatedByAdmin: null,
      transfers: [
        {
          id: 'transfer-2',
          tutorProfileId: 'tutor-2',
          amount: null,
          currency: '',
          tutorProfile: null,
          items: [{ paymentId: 'payment-2', amount: null, payment: null }],
        },
      ],
    });
    expect(defaults.initiatedBy).toBeNull();
    expect(defaults.transfers[0]).toEqual(
      expect.objectContaining({ currency: 'AUD', providerTransferId: null, completedAt: null })
    );
    expect(defaults.transfers[0].lessons[0]).toEqual(
      expect.objectContaining({ bookingId: null, subject: 'Lesson', learner: null })
    );
    expect(serializeRun({ ...run, transfers: undefined }).transfers).toEqual([]);
  });

  test.each([
    [{ code: 'balance_insufficient' }, 'balance'],
    [{ raw: { code: 'account_invalid' } }, 'could not receive'],
    [{}, 'could not create'],
  ])('creates safe transfer failures', (error, message) => {
    expect(safeTransferFailure(error)).toContain(message);
  });

  test.each([
    [{ type: 'StripeConnectionError' }, true],
    [{ rawType: 'StripeAPIError' }, true],
    [{ statusCode: 500 }, true],
    [{ status: 503 }, true],
    [{ errno: 'etimedout' }, true],
    [{ code: 'ECONNRESET' }, true],
    [{ code: 'card_declined', statusCode: 402 }, false],
  ])('classifies transfer provider errors', (error, expected) => {
    expect(isIndeterminateTransferError(error)).toBe(expected);
  });

  test('serializes absent/default payment data', () => {
    expect(serializePayment(null)).toBeNull();
    expect(serializePaymentAttempt(null)).toBeNull();
    const payment = serializePayment({
      id: 'payment-1',
      currency: 'nzd',
      refund: {
        id: 'refund-1',
        amount: null,
        currency: '',
        attemptCount: null,
      },
      attempts: [
        { id: 'later', sequence: 2 },
        { id: 'earlier', sequence: null, safeFailureReason: 'Declined', providerCode: 'x' },
      ],
    });
    expect(payment.refund).toEqual(
      expect.objectContaining({ amount: '0.00', currency: 'NZD', attemptCount: 0 })
    );
    expect(payment.attempts.map((attempt) => attempt.id)).toEqual(['later', 'earlier']);
    expect(payment.attempts[1]).not.toHaveProperty('providerCode');
  });
});

describe('earning calculation fallback branches', () => {
  test('handles malformed, negative, rounded, and default amounts', () => {
    expect(toMinorUnits('not-money')).toBe(0);
    expect(toMinorUnits('-1.235')).toBe(-124);
    expect(toMinorUnits('1')).toBe(100);
    expect(fromMinorUnits()).toBe(0);
    expect(formatMoney()).toBe('0.00');
    expect(formatPercent()).toBe('0.00');
    expect(calculateEarning()).toEqual(expect.objectContaining({ originalAmount: 0 }));
    expect(calculateEarning({ amount: 100, commissionPercent: 200 }).commissionPercent).toBe(100);
    expect(calculateEarning({ amount: 100, commissionPercent: -5 }).commissionPercent).toBe(0);
  });

  test('uses currency fallbacks in earning previews', () => {
    expect(buildEarningPreview({ amount: 10, currency: '' }).currency).toBe('AUD');
    expect(buildEarningPreview({ isTrialLesson: true, currency: 'nzd' }).currency).toBe('NZD');
  });
});
