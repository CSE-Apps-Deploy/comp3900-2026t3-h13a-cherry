import React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({
  router: {
    push: vi.fn(),
    replace: vi.fn(),
  },
  logout: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => mocks.router,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('../../../../lib/api-entry', () => {
  const pendingRequest = () => new Promise(() => {});

  return {
    adminApi: {
      getDashboard: vi.fn(pendingRequest),
      getUsers: vi.fn(pendingRequest),
      getPendingTutors: vi.fn(pendingRequest),
      getAnalytics: vi.fn(pendingRequest),
      getBookings: vi.fn(pendingRequest),
      getReviews: vi.fn(pendingRequest),
      getActions: vi.fn(pendingRequest),
    },
    subjectApi: {
      getAll: vi.fn(pendingRequest),
    },
  };
});

vi.mock('../../../../lib/store', () => ({
  useAuthStore: () => ({
    user: { id: 'admin-1', role: 'ADMIN' },
    logout: mocks.logout,
  }),
}));

import AdminAnalyticsPage from '../analytics/page';
import AdminDashboardPage from '../dashboard/page';
import AdminOperationsPage from '../operations/page';
import AdminTutorsPage from '../tutors/page';
import AdminUsersPage from '../users/page';

const renderPage = (Page) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <Page />
    </QueryClientProvider>
  );
};

describe('admin page header actions', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  test.each([
    ['Analytics', AdminAnalyticsPage],
    ['Admin Operations', AdminOperationsPage],
    ['Tutor Review', AdminTutorsPage],
    ['User Management', AdminUsersPage],
  ])('omits duplicate actions from %s', (heading, Page) => {
    renderPage(Page);

    expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Back' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Log out' })).toBeNull();
  });

  test('omits the old page-level Log out action from the main dashboard', () => {
    renderPage(AdminDashboardPage);

    expect(screen.getByRole('heading', { name: 'Admin Dashboard' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Log out' })).toBeNull();
  });
});
