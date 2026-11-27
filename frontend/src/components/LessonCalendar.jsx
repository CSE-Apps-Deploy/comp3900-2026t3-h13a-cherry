'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { TestPaymentBadge } from './PaymentTestNotice';
import SessionLinkCard from './SessionLinkCard';
import { calendarStatuses, isArchivedLesson } from '../lib/lesson-lifecycle';
import { getCalendarDays, groupCalendarBookings, moveCalendarAnchor } from '../lib/lesson-calendar';
import { formatDateTimeWithYear, formatDuration, getTimezoneName, getUserTimezone } from '../lib/formatters';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function LessonCalendar({ bookings = [], user, initialDate }) {
    const timezone = getUserTimezone(user);
    const [anchor, setAnchor] = useState(() => initialDate || new Date());
    const [view, setView] = useState('month');
    const [selectedId, setSelectedId] = useState(null);
    const [now, setNow] = useState(() => new Date());
    const selected =
        bookings.find((booking) => booking.id === selectedId && calendarStatuses.includes(booking.status)) ||
        null;
    useEffect(() => {
        if (window.matchMedia?.('(max-width: 767px)').matches) setView('list');
        const timer = setInterval(() => setNow(new Date()), 15000);
        return () => clearInterval(timer);
    }, []);
    const days = useMemo(() => getCalendarDays(anchor, view, timezone), [anchor, view, timezone]);
    const grouped = useMemo(() => groupCalendarBookings(bookings, timezone), [bookings, timezone]);
    const otherParticipant = (booking) => {
        const person = user?.role === 'TUTOR' ? booking.learner : booking.tutorProfile?.user;
        return `${person?.firstName || ''} ${person?.lastName || ''}`.trim() || 'Participant';
    };
    const timeLabel = (value) =>
        new Intl.DateTimeFormat('en-AU', {
            timeZone: timezone,
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).format(new Date(value));
    const dateLabel = (value) =>
        new Intl.DateTimeFormat('en-AU', {
            timeZone: timezone,
            month: 'short',
            day: 'numeric',
        }).format(value);
    const title =
        view === 'week'
            ? `${dateLabel(days[0].value)} - ${dateLabel(days[6].value)}`
            : new Intl.DateTimeFormat('en-AU', {
                  timeZone: timezone,
                  year: 'numeric',
                  month: 'long',
              }).format(anchor);
    const eventButton = (booking) => (
        <button
            key={booking.id}
            type="button"
            onClick={() => setSelectedId(booking.id)}
            className={`block w-full rounded-lg border-l-2 px-2 py-2 text-left text-xs ${isArchivedLesson(booking, now) ? 'border-gray-300 bg-gray-50 text-gray-600 hover:bg-gray-100' : 'border-primary-500 bg-primary-50 text-primary-800 hover:bg-primary-100'}`}
        >
            <span className="block font-semibold">
                {timeLabel(booking.scheduledAt)} {booking.subject}<TestPaymentBadge isTestPayment={booking.payment?.isTestPayment} />
            </span>
            <span className="block text-[11px]">{getTimezoneName(booking.scheduledAt, timezone)}</span>
            <span className="block">with {otherParticipant(booking)}</span>
            {isArchivedLesson(booking, now) && (
                <span className="mt-1 block text-[11px] font-medium">Archived · Read only</span>
            )}
        </button>
    );
    return (
        <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="text-xl font-semibold text-gray-900">Lesson Calendar</h1>
                    <p className="text-sm text-gray-500">
                        {title} · {getTimezoneName(anchor, timezone)}
                    </p>
                    <p className="mt-1 text-xs text-gray-500">
                        Times shown in your time zone: {timezone}. Offsets follow each lesson date.
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <button
                        className="btn-secondary btn-sm"
                        onClick={() => {
                            setAnchor(moveCalendarAnchor(anchor, view, -1, timezone));
                            setSelectedId(null);
                        }}
                        aria-label="Previous period"
                    >
                        Previous
                    </button>
                    <button
                        className="btn-secondary btn-sm"
                        onClick={() => {
                            setAnchor(new Date());
                            setSelectedId(null);
                        }}
                    >
                        Today
                    </button>
                    <button
                        className="btn-secondary btn-sm"
                        onClick={() => {
                            setAnchor(moveCalendarAnchor(anchor, view, 1, timezone));
                            setSelectedId(null);
                        }}
                        aria-label="Next period"
                    >
                        Next
                    </button>
                </div>
            </div>
            <div role="group" aria-label="Calendar view" className="flex gap-2">
                {['month', 'week', 'list'].map((mode) => (
                    <button
                        key={mode}
                        type="button"
                        aria-pressed={view === mode}
                        className={view === mode ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
                        onClick={() => setView(mode)}
                    >
                        {mode[0].toUpperCase() + mode.slice(1)}
                    </button>
                ))}
            </div>
            {view === 'list' ? (
                <div className="space-y-3">
                    {days
                        .filter((day) => grouped[day.key]?.length)
                        .map((day) => (
                            <section
                                key={day.key}
                                className="space-y-2 rounded-2xl border border-gray-200 bg-white p-4"
                            >
                                <h2 className="font-semibold text-gray-800">
                                    {dateLabel(day.value)}
                                </h2>
                                {grouped[day.key].map(eventButton)}
                            </section>
                        ))}
                </div>
            ) : (
                <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white">
                    <div className="grid min-w-[700px] grid-cols-7">
                        {DAY_LABELS.map((day) => (
                            <div
                                key={day}
                                className="border-b border-gray-200 p-3 text-center text-sm font-semibold text-gray-600"
                            >
                                {day}
                            </div>
                        ))}
                        {days.map((day) => (
                            <section
                                key={day.key}
                                aria-label={day.key}
                                className={`min-h-[130px] space-y-2 border-b border-r border-gray-100 p-2 ${day.inMonth ? '' : 'bg-gray-50'}`}
                            >
                                <h2
                                    className={`text-sm ${day.inMonth ? 'text-gray-700' : 'text-gray-400'}`}
                                >
                                    {view === 'week' ? dateLabel(day.value) : day.day}
                                </h2>
                                {(grouped[day.key] || []).map(eventButton)}
                            </section>
                        ))}
                    </div>
                </div>
            )}
            {!days.some((day) => grouped[day.key]?.length) && (
                <p className="py-6 text-center text-sm text-gray-500">
                    No lessons in this period.
                </p>
            )}
            {selected && (
                <section className="space-y-4" aria-label="Selected lesson">
                    <div className="rounded-2xl border border-gray-200 bg-white p-5 space-y-2">
                        <div className="flex items-center justify-between gap-3">
                            <h2 className="text-lg font-semibold text-gray-900">
                                {selected.subject}<TestPaymentBadge isTestPayment={selected.payment?.isTestPayment} />
                            </h2>
                            <button
                                type="button"
                                className="btn-secondary btn-sm"
                                onClick={() => setSelectedId(null)}
                            >
                                Close
                            </button>
                        </div>
                        <p className="text-sm text-gray-600">
                            {formatDateTimeWithYear(selected.scheduledAt, timezone)} ·{' '}
                            {formatDuration(selected.duration)}
                        </p>
                        <p className="text-sm text-gray-600">with {otherParticipant(selected)}</p>
                        {isArchivedLesson(selected, now) && (
                            <p className="rounded-lg bg-gray-50 p-3 text-sm text-gray-600">
                                Archived lesson · Session details are read-only.
                            </p>
                        )}
                        <Link
                            href={`/bookings/${selected.id}?returnTo=${encodeURIComponent('/calendar')}`}
                            className="btn-secondary btn-sm"
                        >
                            View booking
                        </Link>
                    </div>
                    <SessionLinkCard booking={selected} user={user} />
                </section>
            )}
        </div>
    );
}
