const express = require('express');
const { body } = require('express-validator');

const bookingController = require('../controllers/bookingController');
const { authenticate } = require('../middleware/auth');
const { authorize, authorizeActiveTutor, authorizeActiveUser } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');

const router = express.Router();

router.use(authenticate);

const bookingRules = [
  body('tutorId').notEmpty().withMessage('Tutor ID required'),
  body('subject').custom((value, { req }) => {
    const subject = typeof value === 'string' ? value.trim() : '';
    const subjectId = typeof req.body.subjectId === 'string' ? req.body.subjectId.trim() : '';

    if (!subject && !subjectId) {
      throw new Error('Subject required');
    }

    return true;
  }),
  body('subjectId').custom((value) => {
    if (value === undefined || value === null || value === '') return true;
    if (typeof value !== 'string') throw new Error('Subject ID must be a string');
    return true;
  }),
  body('scheduledAt').isISO8601().withMessage('Valid date-time required'),
  body('duration').isInt({ min: 30, max: 480 }).withMessage('Duration must be 30-480 minutes'),
  body('sessionType').isIn(['ONLINE', 'IN_PERSON', 'HYBRID']).withMessage('Invalid session type'),
  body('recurringType')
    .optional()
    .isIn(['ONE_OFF', 'WEEKLY', 'FORTNIGHTLY', 'MONTHLY'])
    .withMessage('Invalid recurring type'),
  body('recurringGroupId')
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1, max: 120 })
    .withMessage('Invalid recurring group ID'),
  body('meetingTool')
    .optional()
    .isIn(['GOOGLE_MEET', 'ZOOM', 'MICROSOFT_TEAMS', 'SKYPE', 'OTHER'])
    .withMessage('Invalid meeting tool'),
  body('useTrialLesson')
    .optional()
    .isBoolean()
    .withMessage('Trial lesson selection must be true or false'),
  body('cancellationPolicyAcknowledgement')
    .isObject()
    .withMessage('Cancellation policy acknowledgement is required'),
  body('cancellationPolicyAcknowledgement.cutoffHours')
    .custom((value) => [12, 24, 48].includes(Number(value)))
    .withMessage('Acknowledged cancellation cutoff must be 12, 24, or 48 hours'),
  body('cancellationPolicyAcknowledgement.lateRefundPercent')
    .custom((value) => [0, 50].includes(Number(value)))
    .withMessage('Acknowledged late refund percentage must be 0 or 50'),
];

router.post('/', authorize('LEARNER'), bookingRules, validate, bookingController.createBooking);
router.get('/my-bookings', bookingController.getMyBookings);
router.get('/tutor/requests', authorize('TUTOR'), authorizeActiveTutor, bookingController.getTutorBookings);
router.get('/:id', bookingController.getBooking);
router.post(
  '/:id/price-offers',
  authorize('TUTOR'),
  authorizeActiveTutor,
  body('proposedTotal')
    .custom((value) => /^\d+(?:\.\d{1,2})?$/.test(String(value ?? '').trim()) && Number(value) > 0)
    .withMessage('Proposed total must be a positive amount with at most two decimal places'),
  body('reason').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }).withMessage('Reason is too long'),
  body('expectedVersion').isInt({ min: 1 }).withMessage('Booking version is required'),
  validate,
  bookingController.createPriceOffer
);
router.patch(
  '/:id/price-offers/:offerId/accept',
  authorize('LEARNER'),
  body('expectedVersion').isInt({ min: 1 }).withMessage('Booking version is required'),
  validate,
  bookingController.acceptPriceOffer
);
router.patch(
  '/:id/price-offers/:offerId/reject',
  authorize('LEARNER'),
  body('expectedVersion').isInt({ min: 1 }).withMessage('Booking version is required'),
  validate,
  bookingController.rejectPriceOffer
);
router.patch(
  '/:id/price-offers/:offerId/withdraw',
  authorize('TUTOR'),
  authorizeActiveTutor,
  body('expectedVersion').isInt({ min: 1 }).withMessage('Booking version is required'),
  validate,
  bookingController.withdrawPriceOffer
);
router.post(
  '/:id/cancel',
  body('reason').isString().trim().isLength({ min: 1, max: 1000 }).withMessage('Cancellation reason is required'),
  validate,
  bookingController.cancelBooking
);
router.patch(
  '/:id/accept',
  authorize('TUTOR'),
  authorizeActiveTutor,
  body('expectedVersion').isInt({ min: 1 }).withMessage('Booking version is required'),
  validate,
  bookingController.acceptBooking
);
router.patch(
  '/:id/decline',
  authorize('TUTOR'),
  authorizeActiveTutor,
  body('expectedVersion').isInt({ min: 1 }).withMessage('Booking version is required'),
  validate,
  bookingController.declineBooking
);
router.patch(
  '/:id/requested-time',
  authorize('LEARNER'),
  body('scheduledAt').isISO8601().withMessage('Valid date-time required'),
  body('expectedVersion').isInt({ min: 1 }).withMessage('Booking version is required'),
  body('reason').optional().isString().trim().isLength({ max: 1000 }).withMessage('Reason is too long'),
  validate,
  bookingController.changeRequestedTime
);
router.post(
  '/:id/time-proposals',
  authorize('TUTOR'),
  authorizeActiveTutor,
  body('scheduledAt').isISO8601().withMessage('Valid date-time required'),
  body('expectedVersion').isInt({ min: 1 }).withMessage('Booking version is required'),
  body('reason').optional().isString().trim().isLength({ max: 1000 }).withMessage('Reason is too long'),
  validate,
  bookingController.proposePendingBookingTime
);
router.patch(
  '/:id/time-proposals/accept',
  authorize('LEARNER'),
  body('expectedVersion').isInt({ min: 1 }).withMessage('Booking version is required'),
  validate,
  bookingController.acceptPendingBookingTimeProposal
);
router.patch(
  '/:id/time-proposals/reject',
  authorize('LEARNER'),
  body('expectedVersion').isInt({ min: 1 }).withMessage('Booking version is required'),
  body('reason').optional().isString().trim().isLength({ max: 1000 }).withMessage('Reason is too long'),
  validate,
  bookingController.rejectPendingBookingTimeProposal
);
router.post(
  '/:id/reschedule-requests',
  authorize('LEARNER', 'TUTOR'),
  body('scheduledAt').isISO8601().withMessage('Valid date-time required'),
  body('reason').isString().trim().isLength({ min: 1, max: 1000 }).withMessage('Reason is required'),
  body('expectedVersion').isInt({ min: 1 }).withMessage('Booking version is required'),
  validate,
  bookingController.proposeReschedule
);
router.patch(
  '/:id/reschedule-requests/:requestId/accept',
  authorize('LEARNER', 'TUTOR'),
  body('expectedVersion').isInt({ min: 1 }).withMessage('Booking version is required'),
  validate,
  bookingController.acceptRescheduleRequest
);
router.patch(
  '/:id/reschedule-requests/:requestId/decline',
  authorize('LEARNER', 'TUTOR'),
  body('reason').optional().isString().trim().isLength({ max: 1000 }).withMessage('Reason is too long'),
  body('expectedVersion').isInt({ min: 1 }).withMessage('Booking version is required'),
  validate,
  bookingController.declineRescheduleRequest
);
router.patch(
  '/:id/complete',
  authorize('TUTOR'),
  authorizeActiveTutor,
  body('expectedVersion').isInt({ min: 1 }).withMessage('Booking version is required'),
  validate,
  bookingController.completeBooking
);
router.patch(
  '/:id/not-completed',
  authorize('TUTOR'),
  authorizeActiveTutor,
  body('reason')
    .isString()
    .trim()
    .isLength({ min: 1, max: 1000 })
    .withMessage('A reason is required and must be 1000 characters or fewer'),
  body('expectedVersion').isInt({ min: 1 }).withMessage('Booking version is required'),
  validate,
  bookingController.markBookingNotCompleted
);
router.patch(
  '/:id/completion-review/confirm',
  authorize('LEARNER'),
  authorizeActiveUser,
  body('expectedVersion').isInt({ min: 1 }).withMessage('Booking version is required'),
  validate,
  bookingController.confirmBookingCompletion
);
router.post(
  '/:id/completion-dispute',
  authorize('LEARNER'),
  authorizeActiveUser,
  body('reason')
    .isString()
    .trim()
    .isLength({ min: 1, max: 1000 })
    .withMessage('A reason is required and must be 1000 characters or fewer'),
  body('expectedVersion').isInt({ min: 1 }).withMessage('Booking version is required'),
  validate,
  bookingController.disputeBookingCompletion
);

module.exports = router;
