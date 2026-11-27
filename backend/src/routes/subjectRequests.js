const express = require('express');
const { body, query } = require('express-validator');

const subjectRequestController = require('../controllers/subjectRequestController');
const { authenticate } = require('../middleware/auth');
const { authorize, authorizeActiveTutor } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');

const router = express.Router();

router.use(authenticate);

router.get(
  '/',
  authorize('LEARNER', 'TUTOR'),
  query('status')
    .optional()
    .isIn(['OPEN', 'ACCEPTED', 'CANCELLED'])
    .withMessage('Invalid subject request status'),
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('Limit must be between 1 and 50'),
  validate,
  subjectRequestController.listSubjectRequests
);

router.post(
  '/',
  authorize('LEARNER'),
  body('subjectName')
    .isString()
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Subject name must be between 2 and 100 characters'),
  body('category')
    .isString()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Category is required'),
  body('description')
    .isString()
    .trim()
    .isLength({ min: 10, max: 1000 })
    .withMessage('Description must be between 10 and 1000 characters'),
  validate,
  subjectRequestController.createSubjectRequest
);

router.patch(
  '/:id/cancel',
  authorize('LEARNER'),
  subjectRequestController.cancelSubjectRequest
);

router.patch(
  '/:id/accept',
  authorize('TUTOR'),
  authorizeActiveTutor,
  body('hourlyRate')
    .custom((value) => /^\d+(\.\d{1,2})?$/.test(String(value ?? '').trim()) && Number(value) > 0)
    .withMessage('Hourly rate must be a positive AUD amount with up to two decimal places'),
  validate,
  subjectRequestController.acceptSubjectRequest
);

module.exports = router;
