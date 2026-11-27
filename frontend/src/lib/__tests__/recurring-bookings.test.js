import { describe, test, expect } from 'vitest';
import {
  isRecurringBooking,
  getRecurringSeriesBookings,
  getRecurringSessionCount,
  getBookingDisplayStatus,
  getDisplayStatusLabel,
  getRecurringStatusSummary,
  matchesBookingDisplayStatus,
  needsPaymentSetup,
  getSeriesTotalAmount,
} from '../recurring-bookings';

const booking = (overrides = {}) => ({
  status: 'PENDING',
  totalAmount: 50,
  payment: { status: 'PENDING' },
  ...overrides,
});

describe('recurring booking helpers', () => {
  test('detects recurring bookings and uses the series session count', () => {
    const recurring = booking({ recurringGroupId: 'g1', recurringSeries: { totalSessions: 8, bookings: [] } });

    expect(isRecurringBooking(null)).toBe(false);
    expect(isRecurringBooking(booking({ recurringType: 'ONE_OFF' }))).toBe(false);
    expect(isRecurringBooking(recurring)).toBe(true);
    expect(getRecurringSessionCount(recurring)).toBe(8);
  });

  test('falls back to one session when a recurring booking has no series details', () => {
    expect(getRecurringSessionCount(booking({ recurringGroupId: 'g1' }))).toBe(1);
  });

  test('sorts series bookings and sums their amounts', () => {
    const recurring = booking({
      recurringGroupId: 'g1',
      recurringSeries: {
        bookings: [
          booking({ id: 'b2', scheduledAt: '2024-06-10T10:00:00Z', totalAmount: 20 }),
          booking({ id: 'b1', scheduledAt: '2024-06-03T10:00:00Z', totalAmount: 30 }),
        ],
      },
    });

    const sorted = getRecurringSeriesBookings(recurring);
    expect(sorted.map((item) => item.id)).toEqual(['b1', 'b2']);
    expect(getSeriesTotalAmount(sorted)).toBe(50);
  });

  test('requires payment setup only for pending normal bookings with a recoverable ledger', () => {
    expect(needsPaymentSetup(booking({ status: 'PENDING', payment: { status: 'PENDING' } }))).toBe(true);
    expect(needsPaymentSetup(booking({ status: 'PENDING', payment: { status: 'FAILED' } }))).toBe(true);
    expect(needsPaymentSetup(booking({ status: 'ACCEPTED', payment: { status: 'PENDING' } }))).toBe(false);
    expect(needsPaymentSetup(booking({ status: 'ACCEPTED', payment: { status: 'PAID' } }))).toBe(false);
    expect(needsPaymentSetup(booking({ status: 'COMPLETED' }))).toBe(false);
  });

  test('does not request payment setup for trials or bookings without a payment ledger', () => {
    expect(needsPaymentSetup(booking({ status: 'PENDING', payment: null }))).toBe(false);
    expect(needsPaymentSetup(booking({ isTrialLesson: true, payment: null }))).toBe(false);
  });

  test('keeps pending booking status after a payment method is saved', () => {
    expect(getBookingDisplayStatus(booking({ status: 'PENDING', payment: { status: 'PENDING' } }))).toBe('PENDING');
    expect(getBookingDisplayStatus(booking({ status: 'ACCEPTED', payment: { status: 'PENDING' } }))).toBe('ACCEPTED');
  });

  test('shows payment processing separately while the booking remains pending', () => {
    const processing = booking({ status: 'PENDING', payment: { status: 'PROCESSING' } });

    expect(getBookingDisplayStatus(processing)).toBe('PENDING');
    expect(getDisplayStatusLabel(processing)).toBe('Payment processing');
    expect(needsPaymentSetup(processing)).toBe(false);
  });

  test('labels proposed times', () => {
    expect(
      getDisplayStatusLabel(booking({ negotiationStatus: 'TIME_PROPOSED_BY_TUTOR' }))
    ).toBe('Time Proposed by Tutor');
    expect(
      getDisplayStatusLabel(booking({ negotiationStatus: 'TIME_PROPOSED_BY_LEARNER' }))
    ).toBe('Time Proposed by Learner');
  });

  test('keeps mixed terminal occurrence outcomes visible in their matching filters', () => {
    const mixed = booking({
      recurringGroupId: 'g1',
      recurringSeries: {
        bookings: [
          booking({ id: 'completed', status: 'COMPLETED', scheduledAt: '2026-07-01T10:00:00Z' }),
          booking({ id: 'not-completed', status: 'NOT_COMPLETED', scheduledAt: '2026-07-08T10:00:00Z' }),
        ],
      },
    });

    expect(getRecurringStatusSummary(mixed)).toEqual(
      expect.objectContaining({
        status: 'MIXED',
        acceptedCount: 0,
        completedCount: 1,
        notCompletedCount: 1,
      })
    );
    expect(getDisplayStatusLabel(mixed)).toBe('Mixed outcomes');
    expect(matchesBookingDisplayStatus(mixed, 'COMPLETED')).toBe(true);
    expect(matchesBookingDisplayStatus(mixed, 'NOT_COMPLETED')).toBe(true);
    expect(matchesBookingDisplayStatus(mixed, 'ACCEPTED')).toBe(false);
  });
});
