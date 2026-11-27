import { test, expect, afterEach } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import PasswordRequirements from '../PasswordRequirements';

afterEach(cleanup);

test('password requirements report empty, partially met and fully met input', () => {
    const { rerender } = render(<PasswordRequirements password="" />);
    const requirements = screen.getByRole('list', { name: 'Password requirements' });
    expect(within(requirements).getAllByRole('listitem')).toHaveLength(5);
    expect(within(requirements).getAllByRole('listitem', { name: /: not met$/ })).toHaveLength(5);
    for (const item of within(requirements).getAllByRole('listitem')) {
        expect(item.classList.contains('text-red-600')).toBe(true);
        expect(item.textContent.startsWith('X')).toBe(true);
    }
    rerender(<PasswordRequirements password="Abc1" />);
    expect(within(requirements).getAllByRole('listitem', { name: /: met$/ })).toHaveLength(3);
    expect(within(requirements).getByRole('listitem', { name: '8-20 characters: not met' })).toBeTruthy();
    rerender(<PasswordRequirements password="Abcdef1!" />);
    expect(within(requirements).getAllByRole('listitem', { name: /: met$/ })).toHaveLength(5);
    for (const item of within(requirements).getAllByRole('listitem')) {
        expect(item.classList.contains('text-emerald-700')).toBe(true);
        expect(item.textContent.startsWith('√')).toBe(true);
    }
});
