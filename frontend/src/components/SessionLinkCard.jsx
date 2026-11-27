'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { sessionLinkApi } from '../lib/api-services/sprint1';
import { formatDateTimeWithYear, getUserTimezone } from '../lib/formatters';
import { getSessionLinkState } from '../lib/session-links';

export default function SessionLinkCard({ booking, user }) {
    const queryClient = useQueryClient();
    const [meetingLink, setMeetingLink] = useState(booking?.meetingLink || '');
    const [now, setNow] = useState(() => new Date());
    const isAccepted = booking?.status === 'ACCEPTED';
    const isHistory = ['COMPLETED', 'NOT_COMPLETED'].includes(booking?.status);
    const queryKey = [
        'sessionLink',
        user?.id,
        booking?.id,
        booking?.version,
        booking?.scheduledAt,
        booking?.status,
    ];
    const sessionQuery = useQuery({
        queryKey,
        queryFn: () => sessionLinkApi.get(booking.id),
        enabled: Boolean((isAccepted || isHistory) && booking?.id && user?.id),
        staleTime: 0,
        refetchOnMount: 'always',
        refetchInterval: 30000,
    });
    const session = { ...booking, ...sessionQuery.data?.data?.data };
    const state = getSessionLinkState(session, now);
    const isTutor = user?.role === 'TUTOR' &&
        booking?.tutorId === (user.tutorProfile?.id || user.tutorProfileId);
    const canEdit = isTutor && state.canEditLink;
    const timezone = getUserTimezone(user);
    useEffect(() => {
        setMeetingLink(session.meetingLink || '');
    }, [session.meetingLink]);
    useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), 15000);
        return () => clearInterval(timer);
    }, []);
    const saveLink = useMutation({
        mutationFn: () =>
            sessionLinkApi.update(booking.id, { meetingLink, expectedVersion: session.version }),
        onSuccess: async (response) => {
            queryClient.setQueryData(queryKey, response);
            if (response.data.emailNotification?.delivered === false)
                toast.error('Link saved, but the email notification could not be sent.');
            else toast.success('Meeting link saved.');
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: ['booking'] }),
                queryClient.invalidateQueries({ queryKey: ['lessonCalendar'] }),
            ]);
        },
        onError: (error) => {
            toast.error(error?.response?.data?.message || 'Unable to save meeting link.');
            if (error?.response?.status === 409) sessionQuery.refetch();
        },
    });
    if (!isAccepted && !isHistory) return null;
    return (
        <section
            className="rounded-2xl border border-gray-200 bg-white p-6 space-y-4"
            aria-label="Session link"
        >
            <div>
                <h2 className="text-lg font-semibold text-gray-900">Session link</h2>
                <p className="text-sm text-gray-500">Zoom, Microsoft Teams or Google Meet</p>
            </div>
            {state.isArchived ? (
                <p role="status" className="rounded-lg bg-gray-50 p-3 text-sm text-gray-600">
                    Archived lesson · Read only
                </p>
            ) : isTutor && state.editClosesAt && !state.canEditLink ? (
                <p role="status" className="text-sm text-gray-600">
                    Meeting link editing is closed. Editing stops {state.meetingLinkEditCutoffMinutes} minutes before the lesson.
                </p>
            ) : canEdit ? (
                <p className="text-sm text-gray-500">
                    Editing closes {state.meetingLinkEditCutoffMinutes} minutes before the lesson:{' '}
                    {formatDateTimeWithYear(state.editClosesAt, timezone)}
                </p>
            ) : null}
            {sessionQuery.isError && (
                <p role="alert" className="error-text">
                    Unable to load the latest meeting link. Please refresh.
                </p>
            )}
            {state.missingLinkWarning && (
                <p
                    role="alert"
                    className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
                >
                    This lesson starts within {state.missingLinkWarningHours} hours and has no
                    meeting link.{' '}
                    {state.canEditLink
                        ? (isTutor ? 'Add the link below.' : 'Please ask your tutor to add a link.')
                        : 'Please contact the other participant to arrange the lesson.'}
                </p>
            )}
            {state.link ? (
                <div className="space-y-2">
                    <p className="break-all text-sm text-gray-600">{state.link}</p>
                    {sessionQuery.isError ? null : sessionQuery.isFetching || !state.hasPolicy ? (
                        <p className="text-sm text-gray-500">Checking the latest meeting link...</p>
                    ) : state.canJoin ? (
                        <a
                            href={state.link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn-primary btn-sm"
                        >
                            Join lesson
                        </a>
                    ) : (
                        <p className="text-sm text-gray-500">
                            {now < state.joinOpensAt
                                ? `Joining opens ${state.joinEarlyMinutes} minutes before the lesson: ${formatDateTimeWithYear(state.joinOpensAt, timezone)}`
                                : 'The lesson joining window has ended.'}
                        </p>
                    )}
                </div>
            ) : (
                !state.missingLinkWarning && (
                    <p className="text-sm text-gray-500">
                        The tutor has not added a meeting link yet.
                    </p>
                )
            )}
            {canEdit && (
                <form
                    className="space-y-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        saveLink.mutate();
                    }}
                >
                    <div>
                        <label htmlFor={`meeting-link-${booking.id}`} className="label">
                            Meeting URL
                        </label>
                        <input
                            id={`meeting-link-${booking.id}`}
                            type="url"
                            required
                            maxLength={2048}
                            value={meetingLink}
                            onChange={(event) => setMeetingLink(event.target.value)}
                            className="input"
                            placeholder="https://meet.google.com/..."
                        />
                    </div>
                    <button
                        type="submit"
                        disabled={
                            saveLink.isPending || sessionQuery.isFetching || sessionQuery.isError
                        }
                        className="btn-primary btn-sm"
                    >
                        {saveLink.isPending ? 'Saving...' : 'Save link'}
                    </button>
                </form>
            )}
        </section>
    );
}
