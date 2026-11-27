import { describe, expect, test } from 'vitest';

import {
  getTrialLessonAllocation,
  shouldClaimNextTrialLesson,
} from '../trial-lessons';

describe('trial lesson booking helpers', () => {
  test('allocates the remaining allowance to the earliest bookings in a series', () => {
    expect(
      getTrialLessonAllocation({
        bookingCount: 5,
        trialLessonsRemaining: 2,
        useTrialLesson: true,
      })
    ).toEqual({
      trialLessonCount: 2,
      paidLessonCount: 3,
    });
  });

  test('keeps every booking paid when the learner leaves the toggle off', () => {
    expect(
      getTrialLessonAllocation({
        bookingCount: 3,
        trialLessonsRemaining: 2,
        useTrialLesson: false,
      })
    ).toEqual({
      trialLessonCount: 0,
      paidLessonCount: 3,
    });
  });

  test('only claims another trial while allowance remains', () => {
    expect(shouldClaimNextTrialLesson(1)).toBe(true);
    expect(shouldClaimNextTrialLesson(0)).toBe(false);
  });
});
