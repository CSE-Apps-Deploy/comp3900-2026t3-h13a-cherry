import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import PasswordResetForm from '../PasswordResetForm';
import { passwordResetApi } from '../../lib/api-services/sprint1';

afterEach(cleanup);

vi.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams('token=' + 'a'.repeat(64)),
}));
vi.mock('next/link', () => ({ default: ({ children, ...props }) => <a {...props}>{children}</a> }));
vi.mock('../../lib/api-services/sprint1', () => ({
    passwordResetApi: {
        validate: vi
            .fn()
            .mockRejectedValue({
                response: {
                    status: 410,
                    data: { message: 'This reset link has expired. Request a new link.' },
                },
            }),
        reset: vi.fn(),
    },
}));

test('an expired reset link displays a clear message and a new-link action', async () => {
    render(<PasswordResetForm />);
    expect(
        await screen.findByText('This reset link has expired. Request a new link.')
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Request a new link' }).getAttribute('href')).toBe(
        '/forgot-password'
    );
    expect(screen.queryByRole('button', { name: 'Reset password' })).toBeNull();
});


test('the reset form shows live requirements and independently reveals each password field', async () => {
    passwordResetApi.validate.mockResolvedValueOnce({ data: { success: true } });
    render(<PasswordResetForm />);
    const password = await screen.findByLabelText('New password', { exact: true });
    const confirmation = screen.getByLabelText('Confirm new password', { exact: true });
    expect(screen.getByRole('list', { name: 'Password requirements' })).toBeTruthy();
    fireEvent.change(password, { target: { value: 'Abcdef1!' } });
    expect(screen.getAllByRole('listitem', { name: /: met$/ })).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Show new password', exact: true }));
    expect(password.getAttribute('type')).toBe('text');
    expect(confirmation.getAttribute('type')).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'Show confirmed password', exact: true }));
    expect(confirmation.getAttribute('type')).toBe('text');
});


test('confirmation mismatch is shown live and disappears when either field matches', async () => {
    passwordResetApi.validate.mockResolvedValueOnce({ data: { success: true } });
    render(<PasswordResetForm />);
    const password = await screen.findByLabelText('New password', { exact: true });
    const confirmation = screen.getByLabelText('Confirm new password', { exact: true });
    fireEvent.change(password, { target: { value: 'Abcdef1!' } });
    fireEvent.change(confirmation, { target: { value: 'Abcdef2!' } });
    const message = screen.getByText("Passwords don't match", { exact: true });
    expect(message.classList.contains('error-text')).toBe(true);
    expect(confirmation.getAttribute('aria-describedby')).toBe(message.id);
    fireEvent.change(confirmation, { target: { value: 'Abcdef1!' } });
    expect(screen.queryByText("Passwords don't match", { exact: true })).toBeNull();
    fireEvent.change(password, { target: { value: 'Abcdef3!' } });
    expect(screen.getByText("Passwords don't match", { exact: true })).toBeTruthy();
    fireEvent.change(password, { target: { value: 'Abcdef1!' } });
    expect(screen.queryByText("Passwords don't match", { exact: true })).toBeNull();
});

test('invalid password stays blocked without a duplicate warning line', async () => {
    passwordResetApi.validate.mockResolvedValueOnce({ data: { success: true } });
    passwordResetApi.reset.mockClear();
    render(<PasswordResetForm />);
    const password = await screen.findByLabelText('New password', { exact: true });
    const confirmation = screen.getByLabelText('Confirm new password', { exact: true });
    fireEvent.change(password, { target: { value: 'short' } });
    fireEvent.change(confirmation, { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset password', exact: true }));
    await waitFor(() => expect(document.activeElement).toBe(password));
    expect(screen.queryByText('Password must be 8-20 characters', { exact: true })).toBeNull();
    expect(screen.getAllByRole('listitem', { name: /: not met$/ })).toHaveLength(4);
    expect(passwordResetApi.reset).not.toHaveBeenCalled();
});
