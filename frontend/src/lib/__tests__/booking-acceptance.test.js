import { describe, expect, test } from 'vitest';

import { bookingApi } from '../api-services/booking';
import {
  ACCEPTANCE_OUTCOMES,
  getAcceptanceErrorDetails,
  getAcceptanceOutcome,
  getTutorBookingActionHint,
  hasProcessingPayment,
  summarizeAcceptanceResults,
} from '../booking-acceptance';

describe('booking acceptance helpers', () => {
  test('does not expose the removed learner-triggered payment endpoint', () => {
    expect(bookingApi.pay).toBeUndefined();
  });

  test('normalizes confirmed and processing acceptance responses', () => {
    expect(getAcceptanceOutcome({ status: 200, data: { outcome: 'ACCEPTED' } })).toBe(
      ACCEPTANCE_OUTCOMES.ACCEPTED
    );
    expect(getAcceptanceOutcome({ status: 202, data: { outcome: 'PAYMENT_PROCESSING' } })).toBe(
      ACCEPTANCE_OUTCOMES.PAYMENT_PROCESSING
    );
    expect(
      getAcceptanceOutcome({
        status: 200,
        data: { data: { booking: { payment: { status: 'PROCESSING' } } } },
      })
    ).toBe(ACCEPTANCE_OUTCOMES.PAYMENT_PROCESSING);
  });

  test('preserves structured payment recovery details', () => {
    const details = getAcceptanceErrorDetails({
      response: {
        status: 402,
        data: {
          code: 'PAYMENT_METHOD_REQUIRED',
          action: 'UPDATE_PAYMENT_METHOD',
          link: '/bookings/b1/payment',
        },
      },
    });

    expect(details).toMatchObject({
      code: 'PAYMENT_METHOD_REQUIRED',
      action: 'UPDATE_PAYMENT_METHOD',
      link: '/bookings/b1/payment',
      requiresPaymentMethod: true,
    });
  });

  test('counts accepted, processing, failed, and payment-method failures independently', () => {
    const summary = summarizeAcceptanceResults([
      { status: 'fulfilled', value: { status: 200, data: { outcome: 'ACCEPTED' } } },
      {
        status: 'fulfilled',
        value: { status: 202, data: { outcome: 'PAYMENT_PROCESSING' } },
      },
      {
        status: 'rejected',
        reason: { response: { data: { code: 'PAYMENT_FAILED' } } },
      },
      { status: 'rejected', reason: new Error('network error') },
    ]);

    expect(summary).toEqual({
      acceptedCount: 1,
      processingCount: 1,
      failedCount: 2,
      paymentMethodFailureCount: 1,
      payoutSetupFailureCount: 0,
    });
  });

  test('counts payout setup failures separately so a bulk accept can say so once', () => {
    const payoutFailure = {
      status: 'rejected',
      reason: { response: { data: { code: 'TUTOR_PAYOUT_SETUP_INCOMPLETE' } } },
    };
    const summary = summarizeAcceptanceResults([
      { status: 'fulfilled', value: { status: 200, data: { outcome: 'ACCEPTED' } } },
      payoutFailure,
      payoutFailure,
    ]);

    expect(summary.payoutSetupFailureCount).toBe(2);
    expect(summary.paymentMethodFailureCount).toBe(0);
    expect(summary.acceptedCount).toBe(1);
  });

  test('gives the tutor an actionable payout setup link', () => {
    const details = getAcceptanceErrorDetails({
      response: {
        status: 409,
        data: {
          code: 'TUTOR_PAYOUT_SETUP_INCOMPLETE',
          action: 'COMPLETE_PAYOUT_SETUP',
          link: '/tutor/payouts?returnTo=%2Fbookings%2Fb1',
          message: 'Finish your payout setup before accepting paid bookings.',
        },
      },
    });

    expect(details).toMatchObject({
      code: 'TUTOR_PAYOUT_SETUP_INCOMPLETE',
      action: 'COMPLETE_PAYOUT_SETUP',
      link: '/tutor/payouts?returnTo=%2Fbookings%2Fb1',
      requiresPayoutSetup: true,
      requiresPaymentMethod: false,
    });
    // The server tailors this copy per actor, so it must survive unchanged.
    expect(details.message).toBe('Finish your payout setup before accepting paid bookings.');
  });

  test('keeps the neutral server copy for a learner and offers no tutor-only link', () => {
    const details = getAcceptanceErrorDetails({
      response: {
        status: 409,
        data: {
          code: 'TUTOR_PAYOUT_SETUP_INCOMPLETE',
          message: 'This tutor is finishing their account setup.',
        },
      },
    });

    expect(details.requiresPayoutSetup).toBe(true);
    expect(details.action).toBeNull();
    expect(details.link).toBeNull();
    expect(details.message).toBe('This tutor is finishing their account setup.');
    expect(details.message.toLowerCase()).not.toContain('payout');
  });

  test('detects processing on an occurrence or elsewhere in its recurring series', () => {
    expect(hasProcessingPayment({ payment: { status: 'PROCESSING' } })).toBe(true);
    expect(
      hasProcessingPayment({
        payment: { status: 'PENDING' },
        recurringSeries: {
          bookings: [{ payment: { status: 'PROCESSING' } }],
        },
      })
    ).toBe(true);
    expect(hasProcessingPayment({ payment: { status: 'PENDING' } })).toBe(false);
  });
});


test('a tutor waiting for a price response is told why booking acceptance is unavailable', () => {
  const hint = getTutorBookingActionHint({ status: 'PENDING', availableActions: { canAccept: false, canDecline: true, hasPendingSeriesPriceOffer: true } });
  expect(hint).toBe('Waiting for the learner to respond to the price offer. Booking acceptance becomes available after the offer is resolved.');
  expect(getTutorBookingActionHint({ status: 'PENDING', availableActions: { canAccept: true, canDecline: true } })).toBe('Tutors can accept or decline pending requests here.');
});
