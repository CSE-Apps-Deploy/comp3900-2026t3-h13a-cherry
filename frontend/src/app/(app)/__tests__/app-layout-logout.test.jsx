import React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render as renderView, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({
  pathname: '/dashboard',
  router: {
    push: vi.fn(),
    replace: vi.fn(),
  },
  authState: {
    isLoading: false,
    user: { id: 'learner-1', role: 'LEARNER' },
    accessToken: 'access-token',
    initializeAuth: vi.fn(),
    logout: vi.fn(),
  },
  messageState: {
    unreadCount: 0,
    setUnreadCount: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => mocks.router,
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('../../../lib/store', () => ({
  useAuthStore: (selector) => selector(mocks.authState),
  useMessageStore: (selector) => selector(mocks.messageState),
}));

vi.mock('../../../lib/api-entry', () => ({
  paymentApi: {
    getConfig: vi.fn(async () => ({ data: { data: { provider: 'stripe', isTestPayment: false } } })),
  },
  messageApi: {
    getUnreadCount: vi.fn(() => new Promise(() => {})),
  },
}));

vi.mock('../../../components/notificationBox', () => ({
  default: () => <div data-testid="notification-box" />,
}));

vi.mock('../../../components/TimezoneConfirmBanner', () => ({
  default: () => null,
}));

import AppLayout from '../layout';

const render = (ui) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderView(ui, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
};

const authenticatedViews = [
  ['learner', '/dashboard', { id: 'learner-1', role: 'LEARNER' }],
  [
    'tutor',
    '/tutor/dashboard',
    {
      id: 'tutor-1',
      role: 'TUTOR',
      tutorProfile: { status: 'ACTIVE', applicationSubmitted: true },
    },
  ],
  [
    'restricted tutor',
    '/tutor/review',
    {
      id: 'tutor-2',
      role: 'TUTOR',
      tutorProfile: { status: 'PENDING', applicationSubmitted: true },
    },
  ],
  ['admin', '/admin/dashboard', { id: 'admin-1', role: 'ADMIN' }],
];

describe('authenticated layout logout action', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mocks.authState.accessToken = 'access-token';
  });

  test.each(authenticatedViews)(
    'shows one red-outline logout button in the %s header',
    async (_role, pathname, user) => {
      mocks.pathname = pathname;
      mocks.authState.user = user;

      render(<AppLayout><div>Page content</div></AppLayout>);

      const logoutButton = await screen.findByRole('button', { name: 'Log out' });
      expect(screen.getAllByRole('button', { name: 'Log out' })).toHaveLength(1);
      expect(logoutButton.closest('header')).toBeTruthy();
      expect(logoutButton.className).toContain('border-red-500');
      expect(logoutButton.className).toContain('text-red-600');
    }
  );

  test('logs out and redirects to the login page', async () => {
    mocks.pathname = '/dashboard';
    mocks.authState.user = { id: 'learner-1', role: 'LEARNER' };
    mocks.authState.logout.mockResolvedValueOnce();

    render(<AppLayout><div>Page content</div></AppLayout>);

    fireEvent.click(await screen.findByRole('button', { name: 'Log out' }));

    await waitFor(() => expect(mocks.authState.logout).toHaveBeenCalledTimes(1));
    expect(mocks.router.replace).toHaveBeenCalledWith('/login');
  });

  test('keeps the header controls accessible at tablet widths', async () => {
    mocks.pathname = '/dashboard';
    mocks.authState.user = { id: 'learner-1', role: 'LEARNER' };

    render(<AppLayout><div>Page content</div></AppLayout>);

    await screen.findByRole('button', { name: 'Log out' });
    const desktopHomeLabel = document.querySelector('header nav a[href="/dashboard"] span');
    expect(desktopHomeLabel?.className).toContain('hidden');
    expect(desktopHomeLabel?.className).toContain('xl:inline');
  });

  test('shows the earnings destination only in active tutor navigation', async () => {
    mocks.pathname = '/dashboard';
    mocks.authState.user = { id: 'learner-1', role: 'LEARNER' };

    const { rerender } = render(<AppLayout><div>Page content</div></AppLayout>);
    await screen.findByRole('button', { name: 'Log out' });
    expect(document.querySelector('a[href="/tutor/payouts"]')).toBeNull();

    mocks.pathname = '/tutor/dashboard';
    mocks.authState.user = {
      id: 'tutor-1',
      role: 'TUTOR',
      tutorProfile: { status: 'ACTIVE', applicationSubmitted: true },
    };
    rerender(<AppLayout><div>Page content</div></AppLayout>);

    expect(document.querySelector('a[href="/tutor/payouts"]')).toBeTruthy();
  });

  test('does not show logout while browsing as a guest', async () => {
    mocks.pathname = '/search';
    mocks.authState.user = null;
    mocks.authState.accessToken = null;

    render(<AppLayout><div>Guest content</div></AppLayout>);

    expect(await screen.findByText('Guest content')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Log out' })).toBeNull();
  });
});
