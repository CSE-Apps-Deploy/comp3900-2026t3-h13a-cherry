const express = require('express');
const { body, param, query } = require('express-validator');
const adminController = require('../controllers/adminController');
const reviewController = require('../controllers/reviewController');
const { authenticate } = require('../middleware/auth');
const { authorize, authorizeActiveUser } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');

const router = express.Router();

router.use(authenticate, authorizeActiveUser, authorize('ADMIN', 'SYSTEM_ADMIN'));

router.get('/dashboard', adminController.getDashboard);
router.get('/analytics', adminController.getAnalytics);

router.get('/users', adminController.getUsers);
router.get('/users/:id', adminController.getUser);
router.patch(
  '/users/:id/status',
  body('status').isIn(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']).withMessage('Invalid status'),
  body('reason').optional().isString(),
  validate,
  adminController.updateUserStatus
);

router.get('/tutors/pending', adminController.getPendingTutors);
router.patch('/tutors/:id/approve', adminController.approveTutor);
router.patch(
  '/tutors/:id/reject',
  body('reason').optional().isString(),
  validate,
  adminController.rejectTutor
);
router.patch(
  '/tutors/:id/return',
  body('feedback').trim().notEmpty().withMessage('Feedback is required'),
  validate,
  adminController.returnTutor
);

router.get('/bookings', adminController.getBookings);
router.get('/payouts', adminController.getPayoutOverview);
router.get(
  '/payout-runs',
  query('page').optional().isInt({ min: 1 }).withMessage('page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('limit must be between 1 and 100'),
  validate,
  adminController.getPayoutRuns
);
router.post('/payout-runs', adminController.processPayoutRun);
router.post(
  '/payout-runs/tutors/:tutorProfileId',
  param('tutorProfileId').isUUID().withMessage('A valid tutor profile ID is required'),
  validate,
  adminController.processTutorPayoutRun
);
router.patch(
  '/bookings/:id/completion-dispute/clear',
  body('note').isString().trim().isLength({ min: 1, max: 1000 }).withMessage('A resolution note is required'),
  body('expectedVersion').isInt({ min: 1 }).withMessage('Booking version is required'),
  validate,
  adminController.clearCompletionDispute
);
router.patch(
  '/bookings/:id/completion-dispute/refund',
  body('note').isString().trim().isLength({ min: 1, max: 1000 }).withMessage('A resolution note is required'),
  body('expectedVersion').isInt({ min: 1 }).withMessage('Booking version is required'),
  validate,
  adminController.refundCompletionDispute
);
router.post(
  '/refunds/:refundId/retry',
  param('refundId').isUUID().withMessage('A valid refund ID is required'),
  validate,
  adminController.retryCompletionRefund
);
router.get('/reviews', reviewController.getAdminReviews);
router.delete('/reviews/:id', reviewController.deleteReview);
router.get('/actions', adminController.getAdminActions);
router.post(
  '/subjects',
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('category').trim().notEmpty().withMessage('Category is required'),
  body('description').optional().isString(),
  validate,
  adminController.createSubject
);
router.put(
  '/subjects/:id',
  body('name').optional().isString(),
  body('category').optional().isString(),
  body('description').optional({ nullable: true }).isString(),
  validate,
  adminController.updateSubject
);
router.delete('/subjects/:id', adminController.deleteSubject);

module.exports = router;
