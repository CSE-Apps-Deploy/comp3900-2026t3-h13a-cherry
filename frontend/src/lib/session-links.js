import { isArchivedLesson } from './lesson-lifecycle';

export function getSafeMeetingLink(value) {
    if (!value || typeof value !== 'string') return '';
    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase();
        const supported =
            host === 'meet.google.com' ||
            host === 'zoom.us' ||
            host.endsWith('.zoom.us') ||
            ['teams.microsoft.com', 'teams.live.com', 'teams.cloud.microsoft'].includes(host);
        return supported &&
            url.protocol === 'https:' &&
            !url.username &&
            !url.password &&
            !url.port &&
            url.pathname !== '/'
            ? url.href
            : '';
    } catch {
        return '';
    }
}

export function getSessionLinkState(booking, now = new Date()) {
    const start = new Date(booking?.scheduledAt).getTime();
    const current = new Date(now).getTime();
    const end = start + Number(booking?.duration || 0) * 60000;
    const isAccepted = booking?.status === 'ACCEPTED';
    const link = getSafeMeetingLink(booking?.meetingLink);
    const joinEarlyMinutes = booking?.policy?.joinEarlyMinutes;
    const missingLinkWarningHours = booking?.policy?.missingLinkWarningHours;
    const meetingLinkEditCutoffMinutes = booking?.policy?.meetingLinkEditCutoffMinutes;
    const hasEditPolicy = Number.isFinite(meetingLinkEditCutoffMinutes) && meetingLinkEditCutoffMinutes >= 0;
    const editClosesAt = hasEditPolicy ? new Date(start - meetingLinkEditCutoffMinutes * 60000) : null;
    const isArchived = isArchivedLesson(booking, now);
    const hasPolicy =
        Number.isFinite(joinEarlyMinutes) &&
        joinEarlyMinutes >= 0 &&
        Number.isFinite(missingLinkWarningHours) &&
        missingLinkWarningHours >= 0;
    return {
        link,
        isArchived,
        meetingLinkEditCutoffMinutes,
        editClosesAt,
        canEditLink: Boolean(isAccepted && !isArchived && hasEditPolicy && current < editClosesAt.getTime()),
        hasPolicy,
        joinEarlyMinutes,
        missingLinkWarningHours,
        joinOpensAt:
            hasPolicy && Number.isFinite(start) ? new Date(start - joinEarlyMinutes * 60000) : null,
        canJoin: Boolean(
            hasPolicy &&
            isAccepted &&
            link &&
            current >= start - joinEarlyMinutes * 60000 &&
            current < end
        ),
        missingLinkWarning: Boolean(
            hasPolicy &&
            isAccepted &&
            !link &&
            start - current <= missingLinkWarningHours * 60 * 60000 &&
            current < end
        ),
    };
}
