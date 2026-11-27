import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import LoginPage from '../../app/(auth)/login/page';
import { authApi } from '../../lib/api-entry';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
vi.mock('next/navigation', () => ({ useRouter: vi.fn() }));
vi.mock('next/link', () => ({ default: ({ children, ...props }) => <a {...props}>{children}</a> }));
vi.mock('../../lib/api-entry', () => ({ authApi: { login: vi.fn() } }));
vi.mock('../../lib/store', () => ({ useAuthStore: () => ({ setAuth: vi.fn() }) }));
vi.mock('react-hot-toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
test.each([
  ['This account is not active. Please contact support.', false],
  ['Please verify your email before logging in.', true],
])('login handles rejection: %s', async (message, verification) => {
  const push = vi.fn();useRouter.mockReturnValue({ push });
  authApi.login.mockRejectedValue({ response: { status: 403, data: { message } } });
  render(<LoginPage />);
  fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'learner@example.com' } });
  fireEvent.change(screen.getByPlaceholderText('Enter your password'), { target: { value: 'LocalDemo1!' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign In', exact: true }));
  if (verification) await waitFor(() => expect(push).toHaveBeenCalledWith('/verify-email?email=learner%40example.com'));
  else { await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message));expect(push).not.toHaveBeenCalled(); }
});

