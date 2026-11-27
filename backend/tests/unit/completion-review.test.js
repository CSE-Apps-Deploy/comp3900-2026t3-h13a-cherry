const {
  COMPLETION_REVIEW_HOURS,
  getCompletionReviewDueAt,
  getLessonEndAt,
  promoteMatureCompletionPayouts,
  repairLegacyCompletionReviews,
  startCompletionReviewWorker,
} = require('../../src/services/completionReviewService');

describe('completion review policy', () => {
  test('uses the scheduled lesson end and a 48-hour learner review window', () => {
    const scheduledAt = new Date('2026-08-01T10:00:00.000Z');
    const completedAt = new Date('2026-08-01T11:05:00.000Z');

    expect(COMPLETION_REVIEW_HOURS).toBe(48);
    expect(getLessonEndAt({ scheduledAt, duration: 90 }).toISOString()).toBe(
      '2026-08-01T11:30:00.000Z'
    );
    expect(getCompletionReviewDueAt(completedAt).toISOString()).toBe(
      '2026-08-03T11:05:00.000Z'
    );
    expect(getLessonEndAt()).toEqual(new Date(0));
    expect(getLessonEndAt({ scheduledAt })).toEqual(scheduledAt);
  });

  test('clears expired undisputed reviews before making their payments eligible', async () => {
    const calls = [];
    const database = {
      booking: {
        updateMany: vi.fn(async (input) => {
          calls.push(['booking', input]);
          return { count: 2 };
        }),
      },
      payment: {
        updateMany: vi.fn(async (input) => {
          calls.push(['payment', input]);
          return { count: 2 };
        }),
      },
      $transaction: vi.fn((callback) => callback(database)),
    };
    const now = new Date('2026-08-04T00:00:00.000Z');

    await expect(promoteMatureCompletionPayouts({ database, now })).resolves.toEqual({
      clearedBookingCount: 2,
      eligiblePaymentCount: 2,
    });
    expect(calls.map(([kind]) => kind)).toEqual(['booking', 'payment']);
    expect(database.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          completionReviewStatus: 'AWAITING_LEARNER',
          completionReviewDueAt: { lte: now },
        }),
        data: expect.objectContaining({
          completionReviewStatus: 'CLEARED',
          completionResolution: 'WINDOW_EXPIRED',
          version: { increment: 1 },
        }),
      })
    );
    expect(database.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ payoutStatus: 'PENDING' }),
        data: { payoutStatus: 'ELIGIBLE', payoutEligibleAt: now },
      })
    );
  });

  test('repairs legacy completed lessons when deployment uses db push', async () => {
    const database = {
      booking: {
        updateMany: vi
          .fn()
          .mockResolvedValueOnce({ count: 2 })
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 3 }),
      },
      payment: { updateMany: vi.fn().mockResolvedValueOnce({ count: 2 }) },
      $transaction: vi.fn((callback) => callback(database)),
    };
    const now = new Date('2026-08-05T00:00:00.000Z');

    await expect(repairLegacyCompletionReviews({ database, now })).resolves.toEqual({
      repairedReviewCount: 2,
      repairedDueAtCount: 1,
      repairedResolutionCount: 3,
      eligiblePaymentCount: 2,
    });
    expect(database.booking.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          status: 'COMPLETED',
          completionReviewStatus: null,
        },
        data: expect.objectContaining({
          completionReviewStatus: 'CLEARED',
          completionReviewDueAt: now,
          completionResolution: 'LEGACY_CLEARED',
          completionReviewResolvedAt: now,
          version: { increment: 1 },
        }),
      })
    );
    expect(database.booking.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        status: 'COMPLETED',
        completionReviewStatus: 'CLEARED',
        completionReviewDueAt: null,
      },
      data: {
        completionReviewDueAt: now,
        completionReviewResolvedAt: now,
        version: { increment: 1 },
      },
    });
    expect(database.booking.updateMany).toHaveBeenNthCalledWith(3, {
      where: {
        status: 'COMPLETED',
        completionReviewStatus: 'CLEARED',
        completionResolution: null,
      },
      data: { completionResolution: 'LEGACY_CLEARED' },
    });
    expect(database.payment.updateMany).toHaveBeenCalledWith({
      where: {
        payoutStatus: 'PENDING',
        tutorPayoutAmount: { gt: 0 },
        booking: {
          is: {
            status: 'COMPLETED',
            completionReviewStatus: 'CLEARED',
            completionReviewDueAt: { lte: now },
          },
        },
      },
      data: { payoutStatus: 'ELIGIBLE', payoutEligibleAt: now },
    });
  });

  test('runs expiry promotion immediately and on schedule without overlapping work', async () => {
    vi.useFakeTimers();
    let releaseFirstRun;
    const firstRun = new Promise((resolve) => {
      releaseFirstRun = resolve;
    });
    const database = {
      booking: {
        updateMany: vi
          .fn()
          .mockImplementationOnce(() => firstRun)
          .mockResolvedValue({ count: 0 }),
      },
      payment: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      $transaction: vi.fn((callback) => callback(database)),
    };

    try {
      const stop = startCompletionReviewWorker({ database, intervalMs: 1000 });
      await Promise.resolve();

      expect(database.booking.updateMany).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3000);
      expect(database.booking.updateMany).toHaveBeenCalledTimes(1);

      releaseFirstRun({ count: 0 });
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1000);

      expect(database.booking.updateMany).toHaveBeenCalledTimes(2);
      stop();
      await vi.advanceTimersByTimeAsync(2000);
      expect(database.booking.updateMany).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('returns zero counts when completion storage is unavailable', async () => {
    await expect(promoteMatureCompletionPayouts({ database: {} })).resolves.toEqual({
      clearedBookingCount: 0,
      eligiblePaymentCount: 0,
    });
    await expect(repairLegacyCompletionReviews({ database: {} })).resolves.toEqual({
      repairedReviewCount: 0,
      repairedDueAtCount: 0,
      repairedResolutionCount: 0,
      eligiblePaymentCount: 0,
    });
  });

  test('works without transaction support and normalises missing database counts', async () => {
    const database = {
      booking: { updateMany: vi.fn().mockResolvedValue(undefined) },
      payment: { updateMany: vi.fn().mockResolvedValue(null) },
    };

    await expect(promoteMatureCompletionPayouts({ database })).resolves.toEqual({
      clearedBookingCount: 0,
      eligiblePaymentCount: 0,
    });
    await expect(repairLegacyCompletionReviews({ database })).resolves.toEqual({
      repairedReviewCount: 0,
      repairedDueAtCount: 0,
      repairedResolutionCount: 0,
      eligiblePaymentCount: 0,
    });
  });

  test('keeps the worker alive after a failed promotion', async () => {
    vi.useFakeTimers();
    const database = {
      booking: { updateMany: vi.fn().mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValue({ count: 0 }) },
      payment: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };

    try {
      const stop = startCompletionReviewWorker({ database, intervalMs: 0 });
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(database.booking.updateMany).toHaveBeenCalledTimes(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
