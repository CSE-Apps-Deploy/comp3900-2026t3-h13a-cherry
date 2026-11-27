const { AppError } = require('../middleware/errorHandler');

function parseMeetingLink(value) {
    if (typeof value !== 'string' || value.length > 2048) {
        throw new AppError('Enter a valid HTTPS meeting link.', 400);
    }
    let url;
    try {
        url = new URL(value.trim());
    } catch {
        throw new AppError('Enter a valid HTTPS meeting link.', 400);
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) {
        throw new AppError(
            'Meeting links must use HTTPS without credentials or a custom port.',
            400
        );
    }
    const host = url.hostname.toLowerCase();
    let meetingTool = null;
    if (host === 'meet.google.com') meetingTool = 'GOOGLE_MEET';
    if (host === 'zoom.us' || host.endsWith('.zoom.us')) meetingTool = 'ZOOM';
    if (['teams.microsoft.com', 'teams.live.com', 'teams.cloud.microsoft'].includes(host))
        meetingTool = 'MICROSOFT_TEAMS';
    if (!meetingTool || url.pathname === '/') {
        throw new AppError('Use a Zoom, Microsoft Teams or Google Meet meeting link.', 400);
    }
    return { meetingLink: url.href, meetingTool };
}

module.exports = { parseMeetingLink };
