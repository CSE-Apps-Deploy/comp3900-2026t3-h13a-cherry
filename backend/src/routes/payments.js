const express = require('express');
const { body, query } = require('express-validator');

const paymentController = require('../controllers/paymentController');
const { authenticate } = require('../middleware/auth');
const { authorizeActiveTutor } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { getPaymentEnvironment } = require('../config/paymentEnvironment');

const router = express.Router();

router.use(authenticate);

router.get('/config', (_req, res) => {
  res.json({ success: true, data: getPaymentEnvironment() });
});

router.get(
  '/earnings',
  authorizeActiveTutor,
  query('page').optional().isInt({ min: 1 }).withMessage('page must be a positive integer'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('limit must be between 1 and 100'),
  query('payoutStatus')
    .optional()
    .isIn(['PENDING', 'ELIGIBLE', 'PROCESSING', 'DISPUTED', 'PAID', 'FAILED'])
    .withMessage('payoutStatus is invalid'),
  query('tutorId').not().exists().withMessage('Tutor identifiers are not accepted'),
  query('tutorProfileId').not().exists().withMessage('Tutor identifiers are not accepted'),
  query('userId').not().exists().withMessage('Tutor identifiers are not accepted'),
  validate,
  paymentController.getTutorEarnings
);

// PAY-05 payout onboarding. authorizeActiveTutor is the whole access rule: it
// requires an ACTIVE tutor profile and, unlike authorize(), has no elevated
// role bypass, so learners, unapproved tutors and admins are all denied (AC5).
router.get(
  '/payout-account',
  authorizeActiveTutor,
  query('refresh').optional().isBoolean().withMessage('refresh must be a boolean'),
  validate,
  paymentController.getPayoutAccount
);
router.post(
  '/payout-account/onboarding-link',
  authorizeActiveTutor,
  paymentController.createPayoutOnboardingLink
);

router.get('/method', paymentController.getSavedPaymentMethod);
router.patch('/method/default', paymentController.setDefaultPaymentMethod);
router.delete('/method', paymentController.deleteSavedPaymentMethod);
router.delete('/method/:paymentMethodId', paymentController.deleteSavedPaymentMethod);
router.post('/setup-intent', paymentController.createSetupIntent);
router.post('/complete-setup-intent', paymentController.completeSetupIntent);
router.post('/bookings/:bookingId/use-saved-method', paymentController.useSavedMethodForBooking);
router.post(
  '/bookings/:bookingId/retry',
  body('expectedVersion').isInt({ min: 1 }).withMessage('Booking version is required'),
  validate,
  paymentController.retryBookingPayment
);

module.exports = router;
