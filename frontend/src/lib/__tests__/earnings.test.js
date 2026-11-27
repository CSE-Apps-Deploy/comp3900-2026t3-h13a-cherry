import { describe, expect, test } from 'vitest';
import {
  calculateClientEarningPreview,
  getEarningStatusView,
  getPrimarySummary,
} from '../earnings';

describe('earnings display helpers', () => {
  test('previews the transparent 15 percent calculation in cents', () => {
    expect(calculateClientEarningPreview({ amount: '100.00' })).toEqual({
      currency: 'AUD',
      grossAmount: '100.00',
      commissionPercent: '15.00',
      commissionAmount: '15.00',
      netAmount: '85.00',
    });
  });

  test('updates subject-rate estimates using consistent fractional-cent rounding', () => {
    expect(calculateClientEarningPreview({ amount: '10.03' })).toEqual(
      expect.objectContaining({ commissionAmount: '1.50', netAmount: '8.53' })
    );
    expect(calculateClientEarningPreview({ amount: '10.05' })).toEqual(
      expect.objectContaining({ commissionAmount: '1.51', netAmount: '8.54' })
    );
  });

  test('provides textual state and timestamp metadata for each payout status', () => {
    expect(getEarningStatusView({ isPayable: true, payoutStatus: 'PENDING' })).toEqual(
      expect.objectContaining({ label: 'Pending', timestampKey: 'pendingAt' })
    );
    expect(getEarningStatusView({ isPayable: true, payoutStatus: 'ELIGIBLE' })).toEqual(
      expect.objectContaining({ label: 'Eligible', timestampKey: 'eligibleAt' })
    );
    expect(getEarningStatusView({ isPayable: true, payoutStatus: 'PROCESSING' })).toEqual(
      expect.objectContaining({ label: 'Processing' })
    );
    expect(getEarningStatusView({ isPayable: true, payoutStatus: 'DISPUTED' })).toEqual(
      expect.objectContaining({ label: 'Under review', timestampKey: 'disputedAt' })
    );
    expect(getEarningStatusView({ isPayable: true, payoutStatus: 'PAID' })).toEqual(
      expect.objectContaining({ label: 'Paid', timestampKey: 'paidAt' })
    );
    expect(getEarningStatusView({ isPayable: true, payoutStatus: 'FAILED' })).toEqual(
      expect.objectContaining({ label: 'Failed', timestampKey: 'failedAt' })
    );
  });

  test('labels a fully refunded record as having no payout due', () => {
    expect(getEarningStatusView({ isPayable: false, payoutStatus: null })).toEqual(
      expect.objectContaining({ label: 'No payout due' })
    );
  });

  test('returns a safe zero summary when no records exist', () => {
    expect(getPrimarySummary([], 'AUD')).toEqual(
      expect.objectContaining({
        currency: 'AUD',
        grossAmount: '0.00',
        commissionAmount: '0.00',
        netAmount: '0.00',
      })
    );
  });
});
