const express = require('express');
const { body, query } = require('express-validator');

const tutorController = require('../controllers/tutorController');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { authorize, authorizeActiveTutor, authorizeActiveUser } = require('../middleware/rbac');
const { upload } = require('../middleware/upload');
const { validate } = require('../middleware/validate');

const router = express.Router();

router.get(
  '/',
  optionalAuth,
  query('page').optional().custom((value, { req }) => {
    const page = Number(value);
    const offset = (page - 1) * Number(req.query.limit ?? 12);
    return typeof value === 'string' && /^\d+$/.test(value) && page >= 1 &&
      Number.isSafeInteger(page) && Number.isSafeInteger(offset) && offset <= 2147483647;
  }).withMessage('Page must be a positive integer within the supported range'),
  query('limit').optional().custom((value) =>
    typeof value === 'string' && /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 100
  ).withMessage('Limit must be an integer between 1 and 100'),
  validate,
  tutorController.searchTutors
);
router.get('/:id', optionalAuth, tutorController.getTutorProfile);
router.get('/:id/availability', optionalAuth, tutorController.getTutorAvailability);

router.use(authenticate);

router.get('/:id/verification-files/:filename', authorizeActiveUser, tutorController.downloadVerificationFile);

router.get('/me/profile', authorize('TUTOR'), tutorController.getMyProfile);
router.put(
  '/me/application',
  authorize('TUTOR'),
  upload.array('verificationFiles', 5),
  tutorController.updateApplication
);
router.put('/me/profile', authorize('TUTOR'), authorizeActiveTutor, tutorController.updateProfile);
router.put(
  '/me/cancellation-policy',
  authorize('TUTOR'),
  authorizeActiveTutor,
  body('cutoffHours')
    .custom((value) => [12, 24, 48].includes(Number(value)))
    .withMessage('Cancellation cutoff must be 12, 24, or 48 hours'),
  body('lateRefundPercent')
    .custom((value) => [0, 50].includes(Number(value)))
    .withMessage('Late refund percentage must be 0 or 50'),
  validate,
  tutorController.updateCancellationPolicy
);
router.put('/me/availability', authorize('TUTOR'), authorizeActiveTutor, tutorController.updateAvailability);
router.put(
  '/me/availability/current-week',
  authorize('TUTOR'),
  authorizeActiveTutor,
  tutorController.updateCurrentWeekAvailability
);
router.delete(
  '/me/availability/current-week',
  authorize('TUTOR'),
  authorizeActiveTutor,
  tutorController.clearCurrentWeekAvailability
);
router.post('/me/subjects', authorize('TUTOR'), authorizeActiveTutor, tutorController.addSubject);
router.patch('/me/subjects/:subjectId/rate', authorize('TUTOR'), authorizeActiveTutor, tutorController.updateSubjectRate);
router.delete('/me/subjects/:subjectId', authorize('TUTOR'), authorizeActiveTutor, tutorController.removeSubject);

module.exports = router;
