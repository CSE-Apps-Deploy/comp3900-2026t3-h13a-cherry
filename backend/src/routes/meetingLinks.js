const express = require('express');
const { body } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { authorizeActiveTutor } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { getMeetingLink, updateMeetingLink } = require('../controllers/meetingLinkController');

const router = express.Router();
router.get('/:id/meeting-link', authenticate, getMeetingLink);
router.patch(
    '/:id/meeting-link',
    authenticate,
    authorizeActiveTutor,
    body('meetingLink')
        .isString()
        .isLength({ min: 1, max: 2048 })
        .withMessage('A meeting URL is required.'),
    body('expectedVersion').isInt({ min: 1 }).withMessage('Booking version is required.'),
    validate,
    updateMeetingLink
);
module.exports = router;
