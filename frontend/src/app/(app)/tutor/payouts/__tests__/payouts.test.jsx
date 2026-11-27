import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({
  search: '',
  getEarnings: vi.fn(),
  getPayoutAccount: vi.fn(),
  createPayoutOnboardingLink: vi.fn(),
  errorToast: vi.fn(),
  user: { id: 'tutor-user-1', role: 'TUTOR', timezone: 'Australia/Sydney' },
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(mocks.search),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('../../../../../lib/api-entry', () => ({
  paymentApi: {
    getEarnings: mocks.getEarnings,
    getPayoutAccount: mocks.getPayoutAccount,
    createPayoutOnboardingLink: mocks.createPayoutOnboardingLink,
  },
}));

vi.mock('../../../../../lib/store', () => ({
  useAuthStore: (selector) => selector({ user: mocks.user }),
}));

vi.mock('react-hot-toast', () => ({
  default: {
    error: mocks.errorToast,
  },
}));

import TutorPayoutsPage from '../page';

const earningRecord = (status, overrides = {}) => ({
  id: `payment-${status || 'refunded'}`,
  currency: 'AUD',
  paymentStatus: status ? 'PAID' : 'REFUNDED',
  payoutStatus: status,
  isPayable: Boolean(status),
  calculation: {
    originalAmount: '100.00',
    refundAmount: status ? '0.00' : '100.00',
    grossAmount: status ? '100.00' : '0.00',
    commissionPercent: '15.00',
    commissionAmount: status ? '15.00' : '0.00',
    netAmount: status ? '85.00' : '0.00',
  },
  statusTimestamps: {
    pendingAt: '2026-07-25T00:00:00.000Z',
    eligibleAt: status === 'ELIGIBLE' ? '2026-07-26T00:00:00.000Z' : null,
    paidAt: status === 'PAID' ? '2026-07-27T00:00:00.000Z' : null,
    failedAt: status === 'FAILED' ? '2026-07-28T00:00:00.000Z' : null,
  },
  payoutFailureReason:
    status === 'FAILED' ? 'The payout account could not receive this transfer.' : null,
  lesson: {
    id: `booking-${status || 'refunded'}`,
    subject: `Lesson ${status || 'refunded'}`,
    status: status ? 'COMPLETED' : 'CANCELLED',
    scheduledAt: '2026-07-24T00:00:00.000Z',
    completedAt: '2026-07-24T01:00:00.000Z',
    href: `/bookings/booking-${status || 'refunded'}`,
  },
  cancellation: status
    ? null
    : {
        cancelledAt: '2026-07-24T00:00:00.000Z',
        refundPercent: 100,
        refundAmount: '100.00',
        retainedAmount: '0.00',
        href: '/bookings/booking-refunded#cancellation-outcome',
      },
  ...overrides,
});

const earningsResponse = (records) => ({
  data: {
    data: {
      commissionPolicy: { percent: '15.00', tutorPercent: '85.00' },
      summaries: [
        {
          currency: 'AUD',
          grossAmount: '400.00',
          commissionAmount: '60.00',
          netAmount: '340.00',
          byStatus: {
            PENDING: '85.00',
            ELIGIBLE: '85.00',
            PAID: '85.00',
            FAILED: '85.00',
          },
        },
      ],
      records,
      pagination: { page: 1, limit: 20, total: records.length, totalPages: 1 },
    },
  },
});

const renderPage = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TutorPayoutsPage />
    </QueryClientProvider>
  );
};

describe('Earnings & payouts page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.search = '';
    mocks.getPayoutAccount.mockResolvedValue({
      data: {
        data: {
          status: 'READY',
          isPayoutReady: true,
          lastSyncedAt: '2026-07-29T00:00:00.000Z',
        },
      },
    });
    mocks.createPayoutOnboardingLink.mockResolvedValue({
      data: { data: { url: 'https://connect.example.test' } },
    });
  });

  afterEach(() => {
    cleanup();
  });

  test('makes the 15 percent cut prominent and renders all payout states with timestamps', async () => {
    mocks.getEarnings.mockResolvedValue(
      earningsResponse([
        earningRecord('PENDING'),
        earningRecord('ELIGIBLE'),
        earningRecord('PAID'),
        earningRecord('FAILED'),
        earningRecord(null),
      ])
    );

    renderPage();

    expect(
      await screen.findByRole('heading', { name: 'The TutorConnect commission is 15%' })
    ).toBeTruthy();
    expect(screen.getByText(/AUD 100.00 gross − AUD 15.00 commission = AUD 85.00 net to you/)).toBeTruthy();
    expect(await screen.findByText('Lesson PENDING')).toBeTruthy();
    expect(screen.getAllByText('Pending').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Eligible').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Paid').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Failed').length).toBeGreaterThan(0);
    expect(screen.getByText('No payout due')).toBeTruthy();
    expect(screen.getByText(/The payout account could not receive this transfer/)).toBeTruthy();
    expect(screen.getAllByText(/TutorConnect commission \(15%\)/).length).toBeGreaterThan(0);
  });

  test('shows refund arithmetic and links to the auditable cancellation outcome', async () => {
    mocks.getEarnings.mockResolvedValue(earningsResponse([earningRecord(null)]));

    renderPage();

    expect(await screen.findByText('Refund-adjusted earning')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'View cancellation outcome' });
    expect(link.getAttribute('href')).toBe('/bookings/booking-refunded#cancellation-outcome');
  });

  test('explains why an empty ledger contains no free trials', async () => {
    const response = earningsResponse([]);
    response.data.data.summaries = [];
    mocks.getEarnings.mockResolvedValue(response);

    renderPage();

    expect(await screen.findByText('No payable lesson records yet')).toBeTruthy();
    expect(screen.getByText(/Completed free trials are intentionally excluded/)).toBeTruthy();
  });

  test('offers a retry when earnings cannot be loaded', async () => {
    mocks.getEarnings.mockRejectedValue(new Error('network'));

    renderPage();

    expect(await screen.findByText('We couldn’t load your earnings.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    await waitFor(() => expect(mocks.getEarnings).toHaveBeenCalled());
  });
});
