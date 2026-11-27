import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SessionLinkCard from '../SessionLinkCard';
import { sessionLinkApi } from '../../lib/api-services/sprint1';

afterEach(cleanup);

vi.mock('../../lib/api-services/sprint1', () => ({
    sessionLinkApi: {
        get: vi
            .fn()
            .mockResolvedValue({
                data: { data: { policy: { joinEarlyMinutes: 15, meetingLinkEditCutoffMinutes: 15, missingLinkWarningHours: 24 } } },
            }),
        update: vi.fn(),
    },
}));

test('a learner can open the saved meeting in a new tab near lesson time', async () => {
    const booking = {
        id: 'lesson',
        status: 'ACCEPTED',
        policy: { joinEarlyMinutes: 15, meetingLinkEditCutoffMinutes: 15, missingLinkWarningHours: 24 },
        meetingLink: 'https://meet.google.com/abc-defg-hij',
        scheduledAt: new Date(Date.now() + 10 * 60000).toISOString(),
        duration: 60,
        learnerId: 'learner',
        tutorId: 'tutor',
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
        <QueryClientProvider client={client}>
            <SessionLinkCard booking={booking} user={{ id: 'learner', role: 'LEARNER' }} />
        </QueryClientProvider>
    );
    const link = await screen.findByRole('link', { name: 'Join lesson' });
    expect(link.getAttribute('href')).toBe('https://meet.google.com/abc-defg-hij');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(screen.queryByRole('button', { name: 'Save link' })).toBeNull();
    client.clear();
});

test('returning to a lesson refreshes its link before offering the join action', async () => {
    const booking = {
        id: 'updated-lesson',
        status: 'ACCEPTED',
        policy: { joinEarlyMinutes: 15, meetingLinkEditCutoffMinutes: 15, missingLinkWarningHours: 24 },
        meetingLink: 'https://meet.google.com/old-link',
        scheduledAt: new Date(Date.now() + 10 * 60000).toISOString(),
        duration: 60,
    };
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: 60000 } },
    });
    client.setQueryData(['sessionLink', 'learner', booking.id, booking.version, booking.scheduledAt, booking.status], { data: { data: booking } });
    let completeFetch;
    sessionLinkApi.get.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                completeFetch = resolve;
            })
    );
    render(
        <QueryClientProvider client={client}>
            <SessionLinkCard booking={booking} user={{ id: 'learner', role: 'LEARNER' }} />
        </QueryClientProvider>
    );
    expect(screen.queryByRole('link', { name: 'Join lesson' })).toBeNull();
    await waitFor(() => expect(completeFetch).toBeTypeOf('function'));
    await act(async () =>
        completeFetch({
            data: { data: { ...booking, meetingLink: 'https://teams.microsoft.com/l/new-link' } },
        })
    );
    const link = await screen.findByRole('link', { name: 'Join lesson' });
    expect(link.getAttribute('href')).toBe('https://teams.microsoft.com/l/new-link');
    client.clear();
});

test.each([
    [
        'joining',
        'https://meet.google.com/abc-defg-hij',
        /Joining opens 5 minutes before the lesson/,
    ],
    ['missing-link', null, /starts within 12 hours and has no meeting link/],
])('the %s message displays the server timing policy', async (id, meetingLink, message) => {
    sessionLinkApi.get.mockResolvedValueOnce({
        data: { data: { policy: { joinEarlyMinutes: 5, missingLinkWarningHours: 12 } } },
    });
    const booking = {
        id,
        status: 'ACCEPTED',
        meetingLink,
        scheduledAt: new Date(Date.now() + 6 * 3600000).toISOString(),
        duration: 60,
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
        <QueryClientProvider client={client}>
            <SessionLinkCard booking={booking} user={{ id: 'learner', role: 'LEARNER' }} />
        </QueryClientProvider>
    );
    expect(await screen.findByText(message)).toBeTruthy();
    client.clear();
});

test('an open session card refreshes its joining time when the booking is rescheduled', async () => {
    const booking = {
        id: 'rescheduled-lesson',
        version: 1,
        status: 'ACCEPTED',
        policy: { joinEarlyMinutes: 15, meetingLinkEditCutoffMinutes: 15, missingLinkWarningHours: 24 },
        meetingLink: 'https://meet.google.com/abc-defg-hij',
        scheduledAt: '2027-10-18T00:30:00Z',
        duration: 60,
    };
    const user = { id: 'learner', role: 'LEARNER', timezone: 'Australia/Sydney' };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const moved = { ...booking, version: 2, scheduledAt: '2027-10-18T02:30:00Z' };
    let completeFetch;
    sessionLinkApi.get.mockResolvedValueOnce({ data: { data: booking } });
    sessionLinkApi.get.mockImplementationOnce(
        () => new Promise((resolve) => { completeFetch = resolve; })
    );
    const view = (lesson) => (
        <QueryClientProvider client={client}>
            <SessionLinkCard booking={lesson} user={user} />
        </QueryClientProvider>
    );
    try {
        const { rerender } = render(view(booking));
        expect(await screen.findByText(/Joining opens.*11:15/)).toBeTruthy();
        rerender(view(moved));
        expect(screen.queryByText(/Joining opens.*11:15/)).toBeNull();
        await waitFor(() => expect(completeFetch).toBeTypeOf('function'));
        await act(async () => completeFetch({ data: { data: moved } }));
        expect(await screen.findByText(/Joining opens.*01:15 pm/)).toBeTruthy();
    } finally {
        client.clear();
    }
});
test.each([
    [30, true, false],
    [15, false, false],
    [-120, false, true],
])('tutor editing respects the cutoff and history state at %s minutes', async (minutes, editable, archived) => {
    const booking = {
        id: 'editing-cutoff', status: 'ACCEPTED', tutorId: 'profile', version: 1,
        scheduledAt: new Date(Date.now() + minutes * 60000).toISOString(), duration: 60,
        meetingLink: 'https://meet.google.com/abc-defg-hij',
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
        <QueryClientProvider client={client}>
            <SessionLinkCard booking={booking} user={{ id: 'tutor', role: 'TUTOR', tutorProfile: { id: 'profile' } }} />
        </QueryClientProvider>
    );
    try {
        await screen.findByText(booking.meetingLink);
        if (editable) expect(await screen.findByRole('button', { name: 'Save link' })).toBeTruthy();
        else {
            await screen.findByText(archived ? 'Archived lesson · Read only' : /Meeting link editing is closed/);
            expect(screen.queryByRole('button', { name: 'Save link' })).toBeNull();
            expect(screen.queryByLabelText('Meeting URL')).toBeNull();
        }
    } finally { client.clear(); }
});
