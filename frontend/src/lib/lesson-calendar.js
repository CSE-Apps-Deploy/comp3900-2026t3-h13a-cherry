import { calendarStatuses } from './lesson-lifecycle';
import { getDatePartsInTimezone, zonedTimeToUtc } from './formatters';

const keyForParts = ({ year, month, day }) =>
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const localDate = (year, month, day) => {
    const value = new Date(Date.UTC(year, month - 1, day));
    return {
        year: value.getUTCFullYear(),
        month: value.getUTCMonth() + 1,
        day: value.getUTCDate(),
    };
};

export function groupCalendarBookings(bookings = [], timezone = 'UTC') {
    const grouped = {};
    for (const booking of [...bookings].sort(
        (a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt)
    )) {
        if (!calendarStatuses.includes(booking.status) || !booking.scheduledAt) continue;
        const parts = getDatePartsInTimezone(booking.scheduledAt, timezone);
        if (!parts) continue;
        const key = keyForParts(parts);
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(booking);
    }
    return grouped;
}

export function getCalendarDays(anchor = new Date(), view = 'month', timezone = 'UTC') {
    const parts = getDatePartsInTimezone(anchor, timezone);
    const first = localDate(parts.year, parts.month, 1);
    const firstWeekday = (new Date(Date.UTC(first.year, first.month - 1, 1)).getUTCDay() + 6) % 7;
    const startDay =
        view === 'week'
            ? parts.day - ((parts.dayOfWeek + 6) % 7)
            : view === 'list'
              ? 1
              : 1 - firstWeekday;
    const count =
        view === 'week'
            ? 7
            : view === 'list'
              ? new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate()
              : 42;
    return Array.from({ length: count }, (_, index) => {
        const date = localDate(parts.year, parts.month, startDay + index);
        return {
            ...date,
            key: keyForParts(date),
            inMonth: date.month === parts.month,
            value: zonedTimeToUtc({ ...date, hour: 12 }, timezone),
        };
    });
}

export function moveCalendarAnchor(anchor, view, direction, timezone = 'UTC') {
    const parts = getDatePartsInTimezone(anchor, timezone);
    const date =
        view === 'week'
            ? localDate(parts.year, parts.month, parts.day + direction * 7)
            : localDate(parts.year, parts.month + direction, 1);
    return zonedTimeToUtc({ ...date, hour: 12 }, timezone);
}
