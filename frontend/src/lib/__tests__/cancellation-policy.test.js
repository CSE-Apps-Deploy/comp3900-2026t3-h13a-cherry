import { describe, expect, test } from 'vitest';

import {
  getCancellationPolicyCopy,
  getCancellationState,
  normalizeCancellationPolicy,
} from '../cancellation-policy';

describe('cancellation policy helpers', () => {
  test('normalizes missing values to the platform default', () => {
    expect(normalizeCancellationPolicy()).toEqual({ cutoffHours: 24, lateRefundPercent: 0 });
  });

  test('formats complete plain-language terms for both late-refund choices', () => {
    expect(getCancellationPolicyCopy({ cutoffHours: 12, lateRefundPercent: 0 })).toEqual(
      expect.objectContaining({
        cutoffText: 'Cancel at least 12 hours before the lesson for a full refund.',
        lateRefundText: 'Later cancellations are not refunded.',
      })
    );
    expect(
      getCancellationPolicyCopy({ cutoffHours: 48, lateRefundPercent: 50 }).lateRefundText
    ).toBe('Later cancellations receive a 50% refund.');
  });

  test('uses the booking snapshot and includes the exact cutoff in the full-refund window', () => {
    const booking = {
      status: 'ACCEPTED',
      scheduledAt: '2027-05-02T10:00:00.000Z',
      cancellationCutoffHours: 24,
      lateCancellationRefundPercent: 50,
      payment: { status: 'PAID' },
    };

    expect(
      getCancellationState(booking, {
        isLearner: true,
        now: new Date('2027-05-01T10:00:00.000Z'),
      }).refundPercent
    ).toBe(100);
    expect(
      getCancellationState(booking, {
        isLearner: true,
        now: new Date('2027-05-01T11:00:00.000Z'),
      }).refundPercent
    ).toBe(50);
  });

  test('blocks learner cancellation after start but fully refunds unconfirmed paid requests', () => {
    expect(
      getCancellationState(
        {
          status: 'ACCEPTED',
          scheduledAt: '2027-05-01T09:00:00.000Z',
          payment: { status: 'PAID' },
        },
        { isLearner: true, now: new Date('2027-05-01T10:00:00.000Z') }
      ).canCancel
    ).toBe(false);

    expect(
      getCancellationState(
        {
          status: 'PENDING',
          scheduledAt: '2027-05-02T10:00:00.000Z',
          payment: { status: 'PAID' },
        },
        { isLearner: true, now: new Date('2027-05-01T10:00:00.000Z') }
      ).refundPercent
    ).toBe(100);
  });
});
