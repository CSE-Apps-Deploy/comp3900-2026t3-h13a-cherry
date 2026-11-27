import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import Providers from '../providers/Provider';
import { useAuthStore } from '../../lib/store';
import { useQueryClient } from '@tanstack/react-query';
import { clearAuthStorage } from '../../lib/auth-storage';

const learner = { id: 'learner-a', firstName: 'Alex', role: 'LEARNER' };
const tutor = { id: 'tutor-b', firstName: 'Mina', role: 'TUTOR' };

function Account() {
  const user = useAuthStore((state) => state.user);
  return <p>Account: {user?.firstName}</p>;
}

afterEach(() => {
  cleanup();
  clearAuthStorage();
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null });
});

test('an account change in another tab blocks the old account page without deleting the new login', () => {
  useAuthStore.getState().setAuth({ user: learner, accessToken: 'access-a', refreshToken: 'refresh-a' });
  render(<Providers><Account /></Providers>);
  expect(screen.getByText('Account: Alex')).toBeTruthy();
  act(() => {
    localStorage.setItem('user', JSON.stringify(tutor));
    localStorage.setItem('accessToken', 'access-b');
    localStorage.setItem('refreshToken', 'refresh-b');
    window.dispatchEvent(new StorageEvent('storage', { key: 'user', storageArea: localStorage }));
  });
  expect(screen.queryByText('Account: Alex')).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain('Account changed in another tab');
  expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login');
  expect(JSON.parse(localStorage.getItem('user')).id).toBe(tutor.id);
  expect(localStorage.getItem('accessToken')).toBe('access-b');
});


test.each(['focus', 'pageshow'])('returning to an old page via %s checks the active account', (eventName) => {
  useAuthStore.getState().setAuth({ user: learner, accessToken: 'access-a', refreshToken: 'refresh-a' });
  render(<Providers><Account /></Providers>);
  act(() => {
    localStorage.setItem('user', JSON.stringify(tutor));
    window.dispatchEvent(new Event(eventName));
  });
  expect(screen.getByRole('alert').textContent).toContain('Account changed in another tab');
});

test('signing out elsewhere removes the protected page', () => {
  useAuthStore.getState().setAuth({ user: learner, accessToken: 'access-a', refreshToken: 'refresh-a' });
  render(<Providers><Account /></Providers>);
  act(() => {
    localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage }));
  });
  expect(screen.queryByText('Account: Alex')).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain('You signed out in another tab');
});

test('switching between two learner accounts clears private cached data', () => {
  let client;
  function CachedAccount() {
    client = useQueryClient();
    return <Account />;
  }
  useAuthStore.getState().setAuth({ user: learner, accessToken: 'access-a', refreshToken: 'refresh-a' });
  render(<Providers><CachedAccount /></Providers>);
  client.setQueryData(['my-bookings'], ['Alex private lesson']);
  act(() => {
    useAuthStore.getState().setAuth({ user: { id: 'learner-c', firstName: 'Jamie', role: 'LEARNER' }, accessToken: 'access-c', refreshToken: 'refresh-c' });
  });
  expect(client.getQueryData(['my-bookings'])).toBeUndefined();
  expect(screen.getByText('Account: Jamie')).toBeTruthy();
});
