import { describe, test, expect } from 'vitest';
import { getCalendarDays, groupCalendarBookings } from '../lesson-calendar';

describe('CAL-01 timezone-aware schedule', () => {
    test('a UTC evening lesson is placed on the next Sydney calendar day', () => {
        const grouped = groupCalendarBookings(
            [
                { id: 'accepted', status: 'ACCEPTED', scheduledAt: '2026-10-12T14:30:00Z' },
                { id: 'cancelled', status: 'CANCELLED', scheduledAt: '2026-10-12T14:30:00Z' },
            ],
            'Australia/Sydney'
        );
        expect(grouped['2026-10-13'].map((booking) => booking.id)).toEqual(['accepted']);
        expect(grouped['2026-10-12']).toBeUndefined();
    });
});

test('month navigation includes dates across the previous month and preserves local week dates', () => {
    const month = getCalendarDays(new Date('2026-10-12T00:00:00Z'), 'month', 'Australia/Sydney');
    expect(month[0].key).toBe('2026-09-28');
    expect(month[41].key).toBe('2026-11-08');
    const week = getCalendarDays(new Date('2026-10-12T00:00:00Z'), 'week', 'Australia/Sydney');
    expect(week.map((day) => day.key)).toEqual([
        '2026-10-12',
        '2026-10-13',
        '2026-10-14',
        '2026-10-15',
        '2026-10-16',
        '2026-10-17',
        '2026-10-18',
    ]);
});
