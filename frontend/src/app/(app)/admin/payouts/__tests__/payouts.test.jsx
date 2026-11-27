import React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({
  getPayoutOverview: vi.fn(),
  getPayoutRuns: vi.fn(),
  processPayoutRun: vi.fn(),
  processTutorPayoutRun: vi.fn(),
  clearCompletionDispute: vi.fn(),
  refundCompletionDispute: vi.fn(),
  retryCompletionRefund: vi.fn(),
}));

vi.mock('../../../../../lib/api-entry', () => ({
  adminApi: mocks,
}));

import AdminPayoutsPage from '../page';

const overview = {
  providerConfigured: true,
  counts: {
    readyTransfers: 1,
    readyPayments: 2,
    blockedTransfers: 0,
    disputedPayments: 1,
    processingPayments: 0,
  },
  readyGroups: [
    {
      key: 'tutor-1:AUD',
      tutor: { id: 'tutor-1', firstName: 'Taylor', lastName: 'Tutor', email: 'tutor@example.com' },
      currency: 'AUD',
      amount: '85.00',
      paymentCount: 2,
      openDisputeCount: 1,
      payments: [
        {
          id: 'payment-1',
          amount: '50.00',
          currency: 'AUD',
          payoutStatus: 'ELIGIBLE',
          lesson: {
            id: 'booking-1',
            subject: 'Mathematics',
            scheduledAt: '2026-07-30T00:00:00.000Z',
            learner: { firstName: 'Lee', lastName: 'Learner' },
          },
        },
        {
          id: 'payment-2',
          amount: '35.00',
          currency: 'AUD',
          payoutStatus: 'ELIGIBLE',
          lesson: {
            id: 'booking-2',
            subject: 'Physics',
            scheduledAt: '2026-07-31T00:00:00.000Z',
            learner: { firstName: 'Lee', lastName: 'Learner' },
          },
        },
      ],
    },
  ],
  blockedGroups: [],
  disputed: [
    {
      id: 'payment-disputed',
      bookingId: 'booking-disputed',
      version: 7,
      amount: '42.50',
      currency: 'AUD',
      isTrialLesson: false,
      refundQuote: { amount: '50.00', currency: 'AUD' },
      lesson: {
        id: 'booking-disputed',
        subject: 'Chemistry',
        learner: { firstName: 'Alex', lastName: 'Learner' },
      },
      tutor: { firstName: 'Taylor', lastName: 'Tutor' },
      dispute: { reason: 'The tutor did not attend.', disputedAt: '2026-08-01T00:00:00.000Z' },
    },
  ],
  refunds: [
    {
      id: 'refund-failed',
      source: 'ADMIN_COMPLETION_DISPUTE',
      amount: '50.00',
      currency: 'AUD',
      status: 'FAILED',
      requestedAt: '2026-08-02T00:00:00.000Z',
      failureReason: 'Stripe could not confirm this refund.',
      canRetry: true,
      lesson: {
        id: 'booking-refunded',
        subject: 'Biology',
        learner: { firstName: 'Alex', lastName: 'Learner' },
      },
    },
  ],
};

const renderPage = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AdminPayoutsPage />
    </QueryClientProvider>
  );
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('admin payouts page', () => {
  test('marks a simulated refund record independently of the current payment environment', async () => {
    mocks.getPayoutOverview.mockResolvedValue({ data: { data: {
      ...overview, readyGroups: [], disputed: [],
      refunds: [{ ...overview.refunds[0], status: 'SUCCEEDED', failureReason: null, canRetry: false, isTestPayment: true }],
    } } });
    mocks.getPayoutRuns.mockResolvedValue({ data: { data: { runs: [] } } });
    renderPage();
    expect(await screen.findByText('Test payment')).toBeTruthy();
    expect(screen.getByText('Biology')).toBeTruthy();
  });

  test('previews combined tutor transfers and processes all eligible payouts', async () => {
    mocks.getPayoutOverview.mockResolvedValue({ data: { data: overview } });
    mocks.getPayoutRuns.mockResolvedValue({
      data: { data: { runs: [], pagination: { page: 1, totalPages: 0 } } },
    });
    mocks.processPayoutRun.mockResolvedValue({
      data: { message: 'All eligible tutor transfers were completed.', data: { id: 'run-1' } },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderPage();

    expect(await screen.findByText('Taylor Tutor')).toBeTruthy();
    expect(screen.getByText('Mathematics')).toBeTruthy();
    expect(screen.getByText('Physics')).toBeTruthy();
    expect(screen.getByText(/The tutor did not attend/)).toBeTruthy();
    expect(screen.getByText(/1 other open lesson dispute for this tutor/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /process all eligible payouts/i }));
    await waitFor(() => expect(mocks.processPayoutRun).toHaveBeenCalledTimes(1));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/1 combined Stripe transfer/i));
  });

  test('processes only the tutor selected by the administrator', async () => {
    mocks.getPayoutOverview.mockResolvedValue({ data: { data: overview } });
    mocks.getPayoutRuns.mockResolvedValue({
      data: { data: { runs: [], pagination: { page: 1, totalPages: 0 } } },
    });
    mocks.processTutorPayoutRun.mockResolvedValue({
      data: { message: 'The selected tutor payout was completed.', data: { id: 'run-2' } },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /pay taylor tutor/i }));

    await waitFor(() =>
      expect(mocks.processTutorPayoutRun).toHaveBeenCalledWith('tutor-1')
    );
    expect(mocks.processPayoutRun).not.toHaveBeenCalled();
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringMatching(/Other tutors will not be processed/i)
    );
  });

  test('approves the tutor earning with the resolution note and booking version', async () => {
    mocks.getPayoutOverview.mockResolvedValue({ data: { data: overview } });
    mocks.getPayoutRuns.mockResolvedValue({
      data: { data: { runs: [], pagination: { page: 1, totalPages: 0 } } },
    });
    mocks.clearCompletionDispute.mockResolvedValue({
      data: { message: 'Tutor earning approved.' },
    });
    vi.spyOn(window, 'prompt').mockReturnValue('  Attendance evidence reviewed.  ');
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderPage();

    fireEvent.click(
      await screen.findByRole('button', { name: /approve tutor earning/i })
    );

    await waitFor(() =>
      expect(mocks.clearCompletionDispute).toHaveBeenCalledWith(
        'booking-disputed',
        'Attendance evidence reviewed.',
        7
      )
    );
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringMatching(/tutor’s favour/i)
    );
    expect(mocks.refundCompletionDispute).not.toHaveBeenCalled();
  });

  test('refunds the learner using the quoted full amount and booking version', async () => {
    mocks.getPayoutOverview.mockResolvedValue({ data: { data: overview } });
    mocks.getPayoutRuns.mockResolvedValue({
      data: { data: { runs: [], pagination: { page: 1, totalPages: 0 } } },
    });
    mocks.refundCompletionDispute.mockResolvedValue({
      data: { message: 'Learner refund requested.' },
    });
    vi.spyOn(window, 'prompt').mockReturnValue('  Learner evidence accepted.  ');
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderPage();

    expect(await screen.findByText('Learner refund if approved')).toBeTruthy();
    expect(screen.getAllByText('$50.00').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /refund learner/i }));

    await waitFor(() =>
      expect(mocks.refundCompletionDispute).toHaveBeenCalledWith(
        'booking-disputed',
        'Learner evidence accepted.',
        7
      )
    );
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringMatching(/Refund \$50\.00 to the learner’s original payment method/i)
    );
    expect(mocks.clearCompletionDispute).not.toHaveBeenCalled();
  });

  test('shows a failed refund and retries it only after confirmation', async () => {
    mocks.getPayoutOverview.mockResolvedValue({ data: { data: overview } });
    mocks.getPayoutRuns.mockResolvedValue({
      data: { data: { runs: [], pagination: { page: 1, totalPages: 0 } } },
    });
    mocks.retryCompletionRefund.mockResolvedValue({
      data: { message: 'Refund retry submitted.' },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderPage();

    expect(await screen.findByText('Post-lesson learner refunds')).toBeTruthy();
    expect(await screen.findByText('Stripe could not confirm this refund.')).toBeTruthy();
    expect(screen.getByText('FAILED')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /retry refund/i }));

    await waitFor(() =>
      expect(mocks.retryCompletionRefund).toHaveBeenCalledWith('refund-failed')
    );
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringMatching(/saved Stripe request/i)
    );
  });
});
