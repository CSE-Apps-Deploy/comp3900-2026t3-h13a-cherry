import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ProfilePage from '../../app/(app)/profile/page';
import { authApi } from '../../lib/api-entry';
vi.mock('next/link', () => ({ default: ({ children, ...props }) => <a {...props}>{children}</a> }));
vi.mock('../../lib/api-entry', () => ({ authApi: { changePassword: vi.fn() }, paymentApi: { getSavedMethod: vi.fn().mockResolvedValue({ data: { data: { paymentMethod: null } } }) }, userApi: {} }));
const { user } = vi.hoisted(() => ({ user: { id: 'learner', role: 'LEARNER', firstName: 'Test', lastName: 'Learner', timezone: 'UTC' } }));
vi.mock('../../lib/store', () => ({ useAuthStore: () => ({ user, fetchMe: vi.fn(), setAuth: vi.fn() }) }));
vi.mock('react-hot-toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function openForm() {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ProfilePage /></QueryClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Security', exact: true }));
  return { password: document.querySelector('input[name=newPassword]'), confirmation: document.querySelector('input[name=confirmPassword]'), current: document.querySelector('input[name=currentPassword]') };
}
test('profile password requirements update as the new password changes', () => {
  const { password } = openForm();
  expect(screen.getByRole('list', { name: 'Password requirements' })).toBeTruthy();
  expect(screen.getAllByRole('listitem', { name: /: not met$/ })).toHaveLength(5);
  fireEvent.change(password, { target: { value: 'Abc1' } });
  expect(screen.getAllByRole('listitem', { name: /: met$/ })).toHaveLength(3);
  fireEvent.change(password, { target: { value: 'Abcdef1!' } });
  expect(screen.getAllByRole('listitem', { name: /: met$/ })).toHaveLength(5);
});
test('profile confirmation mismatch appears live and updates when either field changes', () => {
  const { password, confirmation } = openForm();
  fireEvent.change(password, { target: { value: 'Abcdef1!' } });
  fireEvent.change(confirmation, { target: { value: 'Abcdef2!' } });
  const error = screen.getByText("Passwords don't match", { exact: true });
  expect(error.classList.contains('error-text')).toBe(true);
  expect(confirmation.getAttribute('aria-describedby')).toBe(error.id);
  fireEvent.change(confirmation, { target: { value: 'Abcdef1!' } });
  expect(screen.queryByText("Passwords don't match", { exact: true })).toBeNull();
  fireEvent.change(password, { target: { value: 'Abcdef3!' } });
  expect(screen.getByText("Passwords don't match", { exact: true })).toBeTruthy();
});
test('profile blocks a weak password without a duplicate warning and submits matching valid passwords', async () => {
  const { password, confirmation, current } = openForm();
  fireEvent.change(current, { target: { value: 'LocalDemo1!' } });
  fireEvent.change(password, { target: { value: 'abcdefgh' } });
  fireEvent.change(confirmation, { target: { value: 'abcdefgh' } });
  fireEvent.click(screen.getByRole('button', { name: 'Change Password', exact: true }));
  await waitFor(() => expect(password.getAttribute('aria-invalid')).toBe('true'));
  expect(authApi.changePassword).not.toHaveBeenCalled();
  expect(screen.queryByText(/Password must include/)).toBeNull();
  authApi.changePassword.mockResolvedValueOnce({ data: { user: { id: 'learner' }, accessToken: 'access', refreshToken: 'refresh' } });
  fireEvent.change(password, { target: { value: 'Abcdef1!' } });
  fireEvent.change(confirmation, { target: { value: 'Abcdef1!' } });
  fireEvent.click(screen.getByRole('button', { name: 'Change Password', exact: true }));
  await waitFor(() => expect(authApi.changePassword).toHaveBeenCalledWith({ currentPassword: 'LocalDemo1!', newPassword: 'Abcdef1!', confirmPassword: 'Abcdef1!' }));
});


