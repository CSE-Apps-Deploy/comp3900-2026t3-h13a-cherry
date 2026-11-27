import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, test, vi } from 'vitest';
import api from '../../lib/api-services/client';
import SearchPage from '../../app/(app)/search/page';

vi.mock('next/navigation', () => {
  const params = new URLSearchParams();
  return { useRouter: () => ({ push: vi.fn() }), useSearchParams: () => params };
});

const originalAdapter = api.defaults.adapter;
afterEach(() => { cleanup(); api.defaults.adapter = originalAdapter; });

test('the search box sends name keywords and displays matching tutors', async () => {
  const requests = [];
  api.defaults.adapter = async (config) => {
    requests.push(config);
    const tutors = config.params?.q === 'Mina' ? [{ id: 't1', user: { firstName: 'Mina', lastName: 'Parker' }, headline: 'Mathematics tutor', hourlyRate: 75, rating: 0, subjects: [] }] : [];
    return { config, status: 200, statusText: 'OK', headers: {}, data: config.url === '/subjects/categories' ? { data: [] } : { data: { tutors, pagination: { page: 1, total: tutors.length, totalPages: 1 } } } };
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><SearchPage /></QueryClientProvider>);
  fireEvent.change(screen.getByRole('textbox', { name: 'Name or subject' }), { target: { value: 'Mina' } });
  await waitFor(() => expect(screen.getByText('Mina Parker', { exact: true })).toBeTruthy());
  expect(requests.some(r => r.url === '/tutors' && r.params.q === 'Mina' && !r.params.subject)).toBe(true);
});
