import { describe, expect, it } from 'vitest';

import {
  formatPaymentStatus,
  formatPayoutStatus,
  formatSavedMethod,
  getPaymentStatusClass,
  getPayoutStatusClass,
} from '../payment-display.js';

describe('payment display helpers', () => {
  it('converts payment status values to readable labels', () => {
    expect(formatPaymentStatus('PROCESSING')).toBe('Processing');
    expect(formatPaymentStatus('FAILED')).toBe('Payment Failed');
    expect(formatPaymentStatus('REFUNDED')).toBe('Refunded');
    expect(formatPaymentStatus('PARTIALLY_REFUNDED')).toBe('Partially Refunded');
    expect(formatPaymentStatus('PAID')).toBe('Paid');
    expect(formatPaymentStatus('COMPLETED')).toBe('Paid');
  });

  it('uses clear colours for important payment statuses', () => {
    expect(getPaymentStatusClass('PROCESSING')).toContain('blue');
    expect(getPaymentStatusClass('FAILED')).toContain('red');
    expect(getPaymentStatusClass('PAID')).toContain('emerald');
    expect(getPaymentStatusClass('REFUNDED')).toContain('gray');
    expect(getPaymentStatusClass('PARTIALLY_REFUNDED')).toContain('gray');
  });

  it('converts payout status values to readable labels', () => {
    expect(formatPayoutStatus('READY')).toBe('Ready for payouts');
    expect(formatPayoutStatus('ONBOARDING_INCOMPLETE')).toBe('Setup incomplete');
    expect(formatPayoutStatus('PENDING_VERIFICATION')).toBe('Under review');
    expect(formatPayoutStatus('RESTRICTED')).toBe('On hold');
    expect(formatPayoutStatus('NOT_STARTED')).toBe('Not set up');
    expect(formatPayoutStatus('UNAVAILABLE')).toBe('Unavailable');
  });

  it('uses clear colours for payout readiness states', () => {
    expect(getPayoutStatusClass('READY')).toContain('emerald');
    expect(getPayoutStatusClass('ONBOARDING_INCOMPLETE')).toContain('amber');
    expect(getPayoutStatusClass('PENDING_VERIFICATION')).toContain('sky');
    expect(getPayoutStatusClass('RESTRICTED')).toContain('red');
    expect(getPayoutStatusClass('NOT_STARTED')).toContain('gray');
  });

  it('formats saved card details without exposing full card numbers', () => {
    expect(formatSavedMethod({ brand: 'visa', last4: '1111' })).toBe('Visa ending in 1111');
    expect(formatSavedMethod({ brand: 'mastercard', last4: '4444' })).toBe('Mastercard ending in 4444');
  });

  it('shows a safe fallback when no card is saved', () => {
    expect(formatSavedMethod(null)).toBe('No payment method saved');
    expect(formatSavedMethod({ brand: 'visa' })).toBe('No payment method saved');
  });
});
