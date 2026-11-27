const express = require('express');
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');
const { isValidNewPassword } = require('../utils/passwords');
const { passwordResetLimit } = require('../middleware/passwordResetLimit');
const {
    forgotPassword,
    validateResetLink,
    resetPassword,
} = require('../controllers/passwordResetController');

const router = express.Router();
router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});
const tokenRule = () =>
    body('token')
        .isString()
        .matches(/^[a-f0-9]{64}$/i)
        .withMessage('This reset link is invalid. Request a new link.');
router.post(
    '/forgot-password',
    passwordResetLimit,
    body('email').isString().trim().isEmail().withMessage('Enter a valid email address.'),
    validate,
    forgotPassword
);
router.post(
    '/reset-password/validate',
    passwordResetLimit,
    tokenRule(),
    validate,
    validateResetLink
);
router.post(
    '/reset-password',
    passwordResetLimit,
    tokenRule(),
    body('password')
        .custom(isValidNewPassword)
        .withMessage(
            'Use 8-20 characters, including uppercase, lowercase, a number and a supported special character.'
        ),
    body('confirmPassword').isString().notEmpty().withMessage('Confirm your new password.'),
    validate,
    resetPassword
);
module.exports = router;
