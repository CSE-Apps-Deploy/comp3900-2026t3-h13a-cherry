import React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import PostLessonResolutionPanel from '../PostLessonResolutionPanel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PostLessonResolutionPanel', () => {
  test('identifies a simulated refund without claiming Stripe returned real funds', () => {
    render(
      <PostLessonResolutionPanel
        booking={{
          completionReviewStatus: 'RESOLVED_LEARNER',
          completionResolution: 'ADMIN_REFUNDED_LEARNER',
          payment: { isTestPayment: true, refund: { status: 'SUCCEEDED', amount: '100.00', currency: 'AUD' } },
        }}
        isLearner
        timeZone="Australia/Sydney"
      />
    );
    expect(screen.getByText(/Simulated refund completed/i)).toBeTruthy();
    expect(screen.getByText(/No real money was moved/i)).toBeTruthy();
    expect(screen.queryByText(/Stripe confirmed the full refund/i)).toBeNull();
  });

  test('shows both learner actions and explains the awaiting review window', () => {
    const onConfirm = vi.fn();
    const onDispute = vi.fn();

    render(
      <PostLessonResolutionPanel
        booking={{
          completionReviewStatus: 'AWAITING_LEARNER',
          completionReviewDueAt: '2026-08-07T10:00:00.000Z',
          availableActions: {
            canConfirmCompletion: true,
            canDisputeCompletion: true,
          },
        }}
        isLearner
        timeZone="Australia/Sydney"
        onConfirm={onConfirm}
        onDispute={onDispute}
      />
    );

    expect(screen.getByText('48-hour completion review')).toBeTruthy();
    expect(
      screen.getByText(/No action is required if the lesson was completed/i)
    ).toBeTruthy();
    expect(screen.getByText(/confirm now to complete the review early/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /confirm lesson completed/i }));
    fireEvent.click(screen.getByRole('button', { name: /report lesson not completed/i }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onDispute).toHaveBeenCalledTimes(1);
  });

  test('renders a cleared review as a read-only final outcome', () => {
    render(
      <PostLessonResolutionPanel
        booking={{
          completionReviewStatus: 'CLEARED',
          completionResolution: 'WINDOW_EXPIRED',
          completionReviewResolvedAt: '2026-08-07T10:00:00.000Z',
        }}
        isLearner
        timeZone="Australia/Sydney"
      />
    );

    expect(screen.getByText('Completion review closed')).toBeTruthy();
    expect(screen.getByText(/No issue was reported within 48 hours/i)).toBeTruthy();
    expect(screen.getByText(/Finalised/i)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('explains that a free-trial review has no financial effects', () => {
    render(
      <PostLessonResolutionPanel
        booking={{
          isTrialLesson: true,
          completionReviewStatus: 'CLEARED',
          completionResolution: 'LEARNER_CONFIRMED',
          completionReviewResolvedAt: '2026-08-07T10:00:00.000Z',
        }}
        isLearner
        timeZone="Australia/Sydney"
      />
    );

    expect(screen.getByText(/free trial was completed/i)).toBeTruthy();
    expect(screen.getByText(/no earning or payout was created/i)).toBeTruthy();
    expect(screen.queryByText(/eligible for a future payout/i)).toBeNull();
  });

  test.each([
    [
      'PROCESSING',
      'Refund processing',
      /processing or reconciling the full refund/i,
    ],
    [
      'SUCCEEDED',
      'Refund completed',
      /Stripe confirmed the full refund to the learner’s original payment method/i,
    ],
    [
      'FAILED',
      'Refund needs attention',
      /administrator can retry it safely/i,
    ],
  ])('shows the learner refund when its status is %s', (status, label, description) => {
    render(
      <PostLessonResolutionPanel
        booking={{
          completionReviewStatus: 'RESOLVED_LEARNER',
          completionResolution: 'ADMIN_REFUNDED_LEARNER',
          completionReviewResolvedAt: '2026-08-05T10:00:00.000Z',
          payment: {
            refund: {
              status,
              amount: '50.00',
              currency: 'AUD',
              failureReason:
                status === 'FAILED' ? 'The refund could not be confirmed by Stripe.' : null,
            },
          },
        }}
        isLearner
        timeZone="Australia/Sydney"
      />
    );

    expect(screen.getByText('Final lesson outcome')).toBeTruthy();
    expect(screen.getByText(new RegExp(label, 'i'))).toBeTruthy();
    expect(screen.getByText(/AUD 50\.00/i)).toBeTruthy();
    expect(screen.getByText(description)).toBeTruthy();

    if (status === 'FAILED') {
      expect(screen.getByText('The refund could not be confirmed by Stripe.')).toBeTruthy();
    }
    expect(screen.queryByRole('button')).toBeNull();
  });
});
