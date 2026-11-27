export const calendarStatuses = ['ACCEPTED', 'COMPLETED', 'NOT_COMPLETED'];

export function isArchivedLesson(booking, now = new Date()) {
    const end = new Date(booking?.scheduledAt).getTime() + Number(booking?.duration || 0) * 60000;
    return ['COMPLETED', 'NOT_COMPLETED'].includes(booking?.status) ||
        (Number.isFinite(end) && new Date(now).getTime() >= end);
}
