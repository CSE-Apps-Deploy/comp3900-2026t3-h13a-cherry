import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({
  user: {
    id: 'learner-1',
    role: 'LEARNER',
  },
  search: 'subject=Quantum%20Computing',
  categories: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  cancel: vi.fn(),
  accept: vi.fn(),
  successToast: vi.fn(),
  errorToast: vi.fn(),
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

vi.mock('../../../../lib/store', () => ({
  useAuthStore: (selector) => selector({ user: mocks.user }),
}));

vi.mock('../../../../lib/api-entry', () => ({
  subjectApi: {
    getCategories: mocks.categories,
  },
  subjectRequestApi: {
    list: mocks.list,
    create: mocks.create,
    cancel: mocks.cancel,
    accept: mocks.accept,
  },
}));

vi.mock('react-hot-toast', () => ({
  default: {
    success: mocks.successToast,
    error: mocks.errorToast,
  },
}));

import { SubjectRequestsContent } from '../page';

const responseWith = (subjectRequests) => ({
  data: {
    data: {
      subjectRequests,
      pagination: { page: 1, limit: 10, total: subjectRequests.length, totalPages: 1 },
    },
  },
});

const renderPage = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <SubjectRequestsContent />
    </QueryClientProvider>
  );
};

describe('Subject Board page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = { id: 'learner-1', role: 'LEARNER' };
    mocks.search = 'subject=Quantum%20Computing';
    mocks.categories.mockResolvedValue({ data: { data: ['Computing', 'Science'] } });
    mocks.list.mockResolvedValue(responseWith([]));
    mocks.create.mockResolvedValue({ data: { data: { id: 'request-new' } } });
    mocks.cancel.mockResolvedValue({ data: { data: { id: 'request-1', status: 'CANCELLED' } } });
    mocks.accept.mockResolvedValue({ data: { data: { id: 'request-1', status: 'ACCEPTED' } } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test('renders the learner form with search prefill and links an accepted tutor', async () => {
    mocks.list.mockResolvedValue(
      responseWith([
        {
          id: 'request-accepted',
          subjectName: 'Quantum Computing',
          category: 'Computing',
          description: 'I want help understanding qubits and quantum algorithms.',
          status: 'ACCEPTED',
          createdAt: '2026-07-01T00:00:00.000Z',
          acceptedTutor: {
            id: 'tutor-profile-1',
            headline: 'Quantum computing tutor',
            user: { firstName: 'Taylor', lastName: 'Tutor', avatar: null },
          },
        },
      ])
    );

    renderPage();

    expect(screen.getByDisplayValue('Quantum Computing')).toBeTruthy();
    expect(screen.getByText('Request a missing subject')).toBeTruthy();
    expect(await screen.findByText('Taylor Tutor')).toBeTruthy();
    expect(screen.queryByText('Accept request')).toBeNull();
    expect(screen.getByRole('link', { name: 'View tutor and book' }).getAttribute('href')).toBe(
      '/tutors/tutor-profile-1?from=subject-requests'
    );
  });

  test('lets a learner cancel an open request', async () => {
    mocks.list.mockResolvedValue(
      responseWith([
        {
          id: 'request-1',
          subjectName: 'Rust Programming',
          category: 'Computing',
          description: 'I want help understanding ownership and async programming.',
          status: 'OPEN',
          createdAt: '2026-07-01T00:00:00.000Z',
          acceptedTutor: null,
        },
      ])
    );

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith('request-1'));
    expect(window.confirm).toHaveBeenCalled();
  });

  test('renders tutor-only actions and refreshes after a claim conflict', async () => {
    mocks.user = { id: 'tutor-user-1', role: 'TUTOR' };
    mocks.search = '';
    mocks.list.mockResolvedValue(
      responseWith([
        {
          id: 'request-1',
          subjectName: 'Rust Programming',
          category: 'Computing',
          description: 'I want help understanding ownership and async programming.',
          status: 'OPEN',
          createdAt: '2026-07-01T00:00:00.000Z',
          acceptedTutor: null,
        },
      ])
    );
    mocks.accept.mockRejectedValueOnce({
      response: { status: 409, data: { message: 'This subject request has already been claimed' } },
    });

    renderPage();

    expect(screen.queryByText('Request a missing subject')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Accept request' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Hourly rate (AUD)'), { target: { value: '85.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept and add subject' }));

    await waitFor(() => expect(mocks.accept).toHaveBeenCalledWith('request-1', '85.50'));
    await waitFor(() =>
      expect(mocks.errorToast).toHaveBeenCalledWith('This subject request has already been claimed')
    );
    await waitFor(() => expect(mocks.list.mock.calls.length).toBeGreaterThan(1));
  });
});
