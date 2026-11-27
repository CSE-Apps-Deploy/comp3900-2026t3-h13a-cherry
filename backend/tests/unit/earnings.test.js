const {
  buildEarningPreview,
  calculateEarning,
  serializeEarningCalculation,
} = require('../../src/utils/earnings');

describe('tutor earning calculations', () => {
  test('shows the standard 15 percent calculation', () => {
    expect(serializeEarningCalculation(calculateEarning({ amount: '100.00' }))).toEqual({
      originalAmount: '100.00',
      refundAmount: '0.00',
      grossAmount: '100.00',
      commissionPercent: '15.00',
      commissionAmount: '15.00',
      netAmount: '85.00',
    });
  });

  test('applies commission only after a partial refund', () => {
    expect(
      serializeEarningCalculation(
        calculateEarning({ amount: '80.00', refundAmount: '40.00' })
      )
    ).toEqual({
      originalAmount: '80.00',
      refundAmount: '40.00',
      grossAmount: '40.00',
      commissionPercent: '15.00',
      commissionAmount: '6.00',
      netAmount: '34.00',
    });
  });

  test('returns zero commission and net after a full refund', () => {
    expect(calculateEarning({ amount: '100.00', refundAmount: '100.00' })).toEqual(
      expect.objectContaining({
        grossAmount: 0,
        commissionAmount: 0,
        netAmount: 0,
      })
    );
  });

  test('uses the lesson commission snapshot instead of the current default', () => {
    expect(
      calculateEarning({
        amount: '100.00',
        commissionPercent: '12.50',
      })
    ).toEqual(
      expect.objectContaining({
        commissionPercent: 12.5,
        commissionAmount: 12.5,
        netAmount: 87.5,
      })
    );
  });

  test('rounds commission to the nearest cent from integer minor units', () => {
    expect(
      calculateEarning({
        amount: '10.03',
        commissionPercent: '15.00',
      })
    ).toEqual(
      expect.objectContaining({
        commissionAmount: 1.5,
        netAmount: 8.53,
      })
    );
  });

  test('describes free trials as non-payable instead of fabricating an earning', () => {
    expect(buildEarningPreview({ amount: 0, isTrialLesson: true })).toEqual({
      isTrialLesson: true,
      currency: 'AUD',
      message: 'Free trial — no commission or payout.',
    });
  });
});
