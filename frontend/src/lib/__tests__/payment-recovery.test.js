import { describe, expect, test, vi } from 'vitest';

import {
  getPaymentRecoveryError,
  isProcessingRetryResponse,
  saveMethodAndMaybeRetry,
} from '../payment-recovery';

describe('failed payment recovery helpers', () => {
  test('saves the replacement method before starting the learner retry', async () => {
    const calls = [];
    const response = { status: 200, data: { outcome: 'ACCEPTED' } };
    const saveMethod = vi.fn(async () => calls.push('save'));
    const retryPayment = vi.fn(async () => {
      calls.push('retry');
      return response;
    });

    await expect(
      saveMethodAndMaybeRetry({ saveMethod, retryPayment, shouldRetry: true })
    ).resolves.toBe(response);
    expect(calls).toEqual(['save', 'retry']);
  });

  test('does not charge while only setting up a pending booking method', async () => {
    const saveMethod = vi.fn().mockResolvedValue(undefined);
    const retryPayment = vi.fn();

    await expect(
      saveMethodAndMaybeRetry({ saveMethod, retryPayment, shouldRetry: false })
    ).resolves.toBeNull();
    expect(saveMethod).toHaveBeenCalledTimes(1);
    expect(retryPayment).not.toHaveBeenCalled();
  });

  test('normalizes processing and unavailable-slot responses', () => {
    expect(
      isProcessingRetryResponse({
        status: 202,
        data: { outcome: 'PAYMENT_PROCESSING' },
      })
    ).toBe(true);
    expect(
      getPaymentRecoveryError({
        response: {
          data: {
            code: 'SLOT_UNAVAILABLE',
            action: 'CHOOSE_ANOTHER_TIME',
            link: '/bookings/b1?action=change-time',
            message: 'Choose another time.',
          },
        },
      })
    ).toEqual({
      code: 'SLOT_UNAVAILABLE',
      action: 'CHOOSE_ANOTHER_TIME',
      link: '/bookings/b1?action=change-time',
      message: 'Choose another time.',
    });
  });
});
