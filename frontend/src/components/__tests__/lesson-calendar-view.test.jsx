import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import LessonCalendar from '../LessonCalendar';

afterEach(cleanup);

vi.mock('../SessionLinkCard', () => ({
    default: ({ booking }) => <div>Session link for {booking.subject}</div>,
}));
vi.mock('next/link', () => ({ default: ({ children, ...props }) => <a {...props}>{children}</a> }));

test('calendar entry shows local start time and participant and opens booking actions', () => {
    const user = { id: 'learner', role: 'LEARNER', timezone: 'Australia/Sydney' };
    const booking = {
        id: 'lesson',
        status: 'ACCEPTED',
        scheduledAt: '2026-10-12T22:30:00Z',
        duration: 60,
        subject: 'Maths',
        tutorProfile: { user: { firstName: 'Alex', lastName: 'Tutor' } },
    };
    render(
        <LessonCalendar
            bookings={[booking]}
            user={user}
            initialDate={new Date('2026-10-12T00:00:00Z')}
        />
    );
    const entry = screen.getByRole('button', { name: /Maths.*Alex Tutor/ });
    expect(entry.textContent).toContain('09:30');
    fireEvent.click(entry);
    expect(screen.getByRole('link', { name: 'View booking' }).getAttribute('href')).toBe(
        '/bookings/lesson?returnTo=%2Fcalendar'
    );
    expect(screen.getByText('Session link for Maths')).toBeTruthy();
});

test('an open lesson summary follows the updated booking data after rescheduling', () => {
    const user = { id: 'learner', role: 'LEARNER', timezone: 'Australia/Sydney' };
    const booking = {
        id: 'lesson',
        status: 'ACCEPTED',
        scheduledAt: '2026-10-12T22:30:00Z',
        duration: 60,
        subject: 'Maths',
        tutorProfile: { user: { firstName: 'Alex', lastName: 'Tutor' } },
    };
    const { rerender } = render(
        <LessonCalendar
            bookings={[booking]}
            user={user}
            initialDate={new Date('2026-10-12T00:00:00Z')}
        />
    );
    fireEvent.click(screen.getByRole('button', { name: /Maths.*Alex Tutor/ }));
    const changed = {
        ...booking,
        subject: 'Algebra',
        scheduledAt: '2026-10-14T00:30:00Z',
        tutorProfile: { user: { firstName: 'Sam', lastName: 'Tutor' } },
    };
    rerender(
        <LessonCalendar
            bookings={[changed]}
            user={user}
            initialDate={new Date('2026-10-12T00:00:00Z')}
        />
    );
    const summary = screen.getByRole('region', { name: 'Selected lesson' });
    expect(within(summary).getByRole('heading', { name: 'Algebra' })).toBeTruthy();
    expect(summary.textContent).toContain('14 Oct 2026');
    expect(summary.textContent).toContain('11:30');
    expect(summary.textContent).toContain('Sam Tutor');
    rerender(
        <LessonCalendar
            bookings={[{ ...changed, status: 'CANCELLED' }]}
            user={user}
            initialDate={new Date('2026-10-12T00:00:00Z')}
        />
    );
    expect(screen.queryByRole('region', { name: 'Selected lesson' })).toBeNull();
});

test.each([
    ['Australia/Sydney', 'Sydney (GMT+11)', '09:30'],
    ['America/Los_Angeles', 'Los Angeles (GMT-7)', '15:30'],
])('calendar labels each lesson in the viewer timezone %s', (timezone, zoneLabel, localTime) => {
    render(
        <LessonCalendar
            bookings={[{
                id: 'timezone-lesson', status: 'ACCEPTED', subject: 'Algebra', duration: 60,
                scheduledAt: '2026-10-26T22:30:00Z',
                tutorProfile: { user: { firstName: 'Alex', lastName: 'Tutor' } },
            }]}
            user={{ id: 'learner', role: 'LEARNER', timezone }}
            initialDate={new Date('2026-10-26T00:00:00Z')}
        />
    );
    const entry = screen.getByRole('button', { name: /Algebra.*Alex Tutor/ });
    expect(entry.textContent).toContain(localTime);
    expect(entry.textContent).toContain(zoneLabel);
    expect(screen.getByText(/Times shown in your time zone/).textContent).toContain(timezone);
});
test('completed lessons remain available as read-only calendar history', () => {
    render(
        <LessonCalendar
            bookings={[{
                id: 'completed-lesson', status: 'COMPLETED', subject: 'Completed Maths',
                scheduledAt: '2026-10-12T22:30:00Z', duration: 60,
                tutorProfile: { user: { firstName: 'Alex', lastName: 'Tutor' } },
            }]}
            user={{ id: 'learner', role: 'LEARNER', timezone: 'Australia/Sydney' }}
            initialDate={new Date('2026-10-12T00:00:00Z')}
        />
    );
    const entry = screen.getByRole('button', { name: /Completed Maths.*Read only/ });
    fireEvent.click(entry);
    expect(within(screen.getByRole('region', { name: 'Selected lesson' }))
        .getByText('Archived lesson · Session details are read-only.')).toBeTruthy();
});
