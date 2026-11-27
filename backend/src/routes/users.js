const { upload } = require('../middleware/upload');
const express = require('express');
const { updateMyProfile, uploadAvatar } = require('../controllers/userController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// profile update route for the current user
router.put('/me', authenticate, updateMyProfile);

router.post('/me/avatar', authenticate, upload.single('avatar'), uploadAvatar);

module.exports = router;
