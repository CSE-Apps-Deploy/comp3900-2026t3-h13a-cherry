const { prisma } = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const { parseMeetingLink } = require('../utils/meetingLinks');
const { notify } = require('../services/notificationService');
const { sendMeetingLinkUpdatedEmail } = require('../services/emailService');
const logger = require('../config/logger');
const timing = require('../config/sprint1Timing');

const serializeSessionLink = (booking) => ({
    id: booking.id,
    status: booking.status,
    subject: booking.subject,
    scheduledAt: booking.scheduledAt,
    duration: booking.duration,
    version: booking.version,
    meetingLink: booking.meetingLink,
    meetingTool: booking.meetingTool,
    policy: {
        joinEarlyMinutes: timing.joinEarlyMinutes,
        meetingLinkEditCutoffMinutes: timing.meetingLinkEditCutoffMinutes,
        missingLinkWarningHours: timing.missingLinkWarningHours,
    },
});

async function getMeetingLink(req, res) {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    const isParticipant =
        booking &&
        (booking.learnerId === req.user.id || booking.tutorId === req.user.tutorProfile?.id);
    if (!isParticipant) throw new AppError('Booking not found', 404);
    res.json({ success: true, data: serializeSessionLink(booking) });
}

async function updateMeetingLink(req, res) {
    const values = parseMeetingLink(req.body.meetingLink);
    const expectedVersion = Number(req.body.expectedVersion);
    let linkChanged = false;
    const updated = await prisma.$transaction(async (tx) => {
        const booking = await tx.booking.findUnique({ where: { id: req.params.id } });
        if (!booking || booking.tutorId !== req.user.tutorProfile?.id) {
            throw new AppError('Booking not found', 404);
        }
        if (booking.status !== 'ACCEPTED')
            throw new AppError('Meeting links can only be edited for accepted bookings.', 400);
        const editClosesAt = new Date(booking.scheduledAt).getTime() -
            timing.meetingLinkEditCutoffMinutes * 60000;
        if (!Number.isFinite(editClosesAt) || Date.now() >= editClosesAt)
            throw new AppError(
                `Meeting link editing closes ${timing.meetingLinkEditCutoffMinutes} minutes before the lesson.`,
                400
            );
        if (booking.version !== expectedVersion)
            throw new AppError(
                'This booking changed. Refresh it before saving the meeting link.',
                409
            );
        if (
            booking.meetingLink === values.meetingLink &&
            booking.meetingTool === values.meetingTool
        )
            return booking;
        const result = await tx.booking.updateMany({
            where: {
                id: booking.id,
                tutorId: booking.tutorId,
                status: 'ACCEPTED',
                version: expectedVersion,
                scheduledAt: { gt: new Date(Date.now() + timing.meetingLinkEditCutoffMinutes * 60000) },
            },
            data: { ...values, version: { increment: 1 } },
        });
        if (!result.count)
            throw new AppError(
                'This booking changed. Refresh it before saving the meeting link.',
                409
            );
        linkChanged = true;
        await notify(
            booking.learnerId,
            'booking',
            'Session link updated',
            `The meeting link for ${booking.subject} has been updated.`,
            `/bookings/${booking.id}`,
            tx
        );
        return tx.booking.findUnique({ where: { id: booking.id } });
    });
    let emailNotification;
    if (linkChanged) {
        emailNotification = { delivered: false };
        try {
            const learner = await prisma.user.findUnique({
                where: { id: updated.learnerId },
                select: { email: true, timezone: true },
            });
            if (learner?.email) {
                emailNotification = await sendMeetingLinkUpdatedEmail({
                    email: learner.email,
                    timezone: learner.timezone,
                    subject: updated.subject,
                    scheduledAt: updated.scheduledAt,
                    duration: updated.duration,
                    meetingLink: updated.meetingLink,
                    bookingId: updated.id,
                });
            }
        } catch (error) {
            logger.warn('Meeting link saved, but its email notification could not be sent.', error.message);
        }
    }
    res.json({
        success: true,
        message: 'Meeting link saved.',
        data: serializeSessionLink(updated),
        ...(emailNotification ? { emailNotification } : {}),
    });
}

module.exports = { getMeetingLink, updateMeetingLink };
