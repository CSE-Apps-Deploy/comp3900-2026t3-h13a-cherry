'use client';

import { useQuery } from '@tanstack/react-query';
import LessonCalendar from '../../../components/LessonCalendar';
import { getCalendarBookings } from '../../../lib/api-services/sprint1';
import { useAuthStore } from '../../../lib/store';

export default function CalendarPage() {
    const user = useAuthStore((state) => state.user);
    const accessToken = useAuthStore((state) => state.accessToken);
    const canView = ['LEARNER', 'TUTOR'].includes(user?.role);
    const query = useQuery({
        queryKey: ['lessonCalendar', user?.id],
        queryFn: () => getCalendarBookings(user.role),
        enabled: Boolean(canView && accessToken),
        refetchInterval: 30000,
    });
    if (!canView)
        return (
            <p className="text-sm text-gray-500">
                The lesson calendar is available to learners and tutors.
            </p>
        );
    if (query.isLoading)
        return <p className="py-8 text-center text-sm text-gray-500">Loading lessons...</p>;
    if (query.isError)
        return (
            <div className="space-y-3">
                <p role="alert" className="error-text">
                    Unable to load your lessons.
                </p>
                <button className="btn-secondary btn-sm" onClick={() => query.refetch()}>
                    Retry
                </button>
            </div>
        );
    return <LessonCalendar bookings={query.data || []} user={user} />;
}
