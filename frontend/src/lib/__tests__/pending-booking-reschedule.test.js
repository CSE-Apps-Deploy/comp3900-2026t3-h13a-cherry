import { describe, expect, test } from 'vitest';

import {
  canChangePendingRequestedTime,
  canTutorChooseAnyFreeTime,
  getActiveTimeProposal,
  getNegotiationStatusLabel,
  getRequestedTimeHistory,
  getTimeNegotiationHistory,
} from '../pending-booking-reschedule';

const now = new Date('2027-05-07T09:00:00.000Z');
const pendingBooking = {
  id: 'booking-1',
  status: 'PENDING',
  scheduledAt: '2027-05-07T10:00:00.000Z',
};

describe('pending requested-time helpers', () => {
  test('allows only the learner to change a future one-off pending request', () => {
    expect(
      canChangePendingRequestedTime(pendingBooking, {
        isLearner: true,
        now,
      })
    ).toBe(true);
    expect(
      canChangePendingRequestedTime(pendingBooking, {
        isLearner: false,
        now,
      })
    ).toBe(false);
    expect(
      canChangePendingRequestedTime(pendingBooking, {
        isLearner: true,
        isRecurring: true,
        now,
      })
    ).toBe(false);
  });

  test.each(['ACCEPTED', 'CANCELLED', 'COMPLETED', 'DECLINED'])(
    'hides the action for %s bookings',
    (status) => {
      expect(
        canChangePendingRequestedTime(
          { ...pendingBooking, status },
          { isLearner: true, now }
        )
      ).toBe(false);
    }
  );

  test('hides the action after the requested lesson has started', () => {
    expect(
      canChangePendingRequestedTime(
        { ...pendingBooking, scheduledAt: now.toISOString() },
        { isLearner: true, now }
      )
    ).toBe(false);
  });

  test('allows an expired recurring occurrence to choose a new time after payment failure', () => {
    expect(
      canChangePendingRequestedTime(
        {
          ...pendingBooking,
          scheduledAt: '2027-05-07T08:00:00.000Z',
          payment: { status: 'FAILED' },
          availableActions: { isAwaitingLearnerPaymentRetry: true },
        },
        { isLearner: true, isRecurring: true, now }
      )
    ).toBe(true);
  });

  test('hides the action while a lesson price offer awaits a response', () => {
    expect(
      canChangePendingRequestedTime(
        {
          ...pendingBooking,
          priceOffers: [{ id: 'offer-1', status: 'PENDING' }],
        },
        { isLearner: true, now }
      )
    ).toBe(false);
  });

  test('hides the action while acceptance payment is processing', () => {
    expect(
      canChangePendingRequestedTime(
        {
          ...pendingBooking,
          payment: { status: 'PROCESSING' },
        },
        { isLearner: true, now }
      )
    ).toBe(false);
  });

  test('allows tutors to choose any free time for future pending and accepted bookings', () => {
    expect(canTutorChooseAnyFreeTime(pendingBooking, { isTutor: true, now })).toBe(true);
    expect(
      canTutorChooseAnyFreeTime(
        { ...pendingBooking, status: 'ACCEPTED' },
        { isTutor: true, now }
      )
    ).toBe(true);
    expect(
      canTutorChooseAnyFreeTime(
        { ...pendingBooking, status: 'ACCEPTED' },
        { isTutor: false, now }
      )
    ).toBe(false);
    expect(
      canTutorChooseAnyFreeTime(
        { ...pendingBooking, status: 'ACCEPTED', scheduledAt: now.toISOString() },
        { isTutor: true, now }
      )
    ).toBe(false);
  });

  test('returns applied time changes newest first and excludes pending proposals', () => {
    const history = getRequestedTimeHistory({
      rescheduleRequests: [
        { id: 'older', status: 'ACCEPTED', createdAt: '2027-05-01T10:00:00.000Z' },
        { id: 'pending', status: 'PENDING', createdAt: '2027-05-03T10:00:00.000Z' },
        { id: 'newer', status: 'ACCEPTED', createdAt: '2027-05-02T10:00:00.000Z' },
      ],
    });

    expect(history.map((entry) => entry.id)).toEqual(['newer', 'older']);
  });

  test('returns the active proposal and full negotiation history newest first', () => {
    const booking = {
      rescheduleRequests: [
        { id: 'accepted', status: 'ACCEPTED', createdAt: '2027-05-01T10:00:00.000Z' },
        { id: 'countered', status: 'COUNTERED', createdAt: '2027-05-02T10:00:00.000Z' },
        { id: 'active', status: 'PENDING', createdAt: '2027-05-03T10:00:00.000Z' },
      ],
    };

    expect(getActiveTimeProposal(booking)?.id).toBe('active');
    expect(getTimeNegotiationHistory(booking).map((entry) => entry.id)).toEqual([
      'active',
      'countered',
      'accepted',
    ]);
  });

  test('formats the pending negotiation status for either proposer', () => {
    expect(
      getNegotiationStatusLabel({ negotiationStatus: 'TIME_PROPOSED_BY_TUTOR' })
    ).toBe('Time Proposed by Tutor');
    expect(
      getNegotiationStatusLabel({ negotiationStatus: 'TIME_PROPOSED_BY_LEARNER' })
    ).toBe('Time Proposed by Learner');
    expect(getNegotiationStatusLabel({ negotiationStatus: 'NONE' })).toBeNull();
  });
});
