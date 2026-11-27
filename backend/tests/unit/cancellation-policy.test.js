const {
  cancellationPoliciesMatch,
  getCancellationRefundPercent,
  getEffectiveCancellationPolicy,
} = require('../../src/utils/cancellationPolicy');

describe('cancellation policy helpers', () => {
  test('uses the platform default for missing or unsupported stored values', () => {
    expect(getEffectiveCancellationPolicy()).toEqual({ cutoffHours: 24, lateRefundPercent: 0 });
    expect(
      getEffectiveCancellationPolicy({
        cancellationCutoffHours: 36,
        lateCancellationRefundPercent: 25,
      })
    ).toEqual({ cutoffHours: 24, lateRefundPercent: 0 });
  });

  test('compares normalized acknowledged and stored policies', () => {
    expect(
      cancellationPoliciesMatch(
        { cutoffHours: 48, lateRefundPercent: 50 },
        { cancellationCutoffHours: 48, lateCancellationRefundPercent: 50 }
      )
    ).toBe(true);
  });

  test('treats the exact cutoff boundary as fully refundable', () => {
    const now = new Date('2027-05-01T10:00:00.000Z');
    expect(
      getCancellationRefundPercent({
        now,
        booking: {
          status: 'ACCEPTED',
          scheduledAt: new Date('2027-05-02T10:00:00.000Z'),
          cancellationCutoffHours: 24,
          lateCancellationRefundPercent: 50,
        },
      })
    ).toBe(100);
  });

  test('uses the snapshotted late refund and always fully refunds tutor cancellations', () => {
    const booking = {
      status: 'ACCEPTED',
      scheduledAt: new Date('2027-05-01T20:00:00.000Z'),
      cancellationCutoffHours: 24,
      lateCancellationRefundPercent: 50,
    };
    const now = new Date('2027-05-01T10:00:00.000Z');

    expect(getCancellationRefundPercent({ booking, now })).toBe(50);
    expect(getCancellationRefundPercent({ booking, now, isTutor: true })).toBe(100);
  });
});
