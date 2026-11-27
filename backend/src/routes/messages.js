const express = require('express');
const messageController = require('../controllers/messageController');
const { authenticate } = require('../middleware/auth');
const { uploadChatAttachment } = require('../middleware/upload');

const router = express.Router();

router.use(authenticate);

router.get('/conversations', messageController.getConversations);
router.post('/conversations', messageController.createOrGetConversation);
router.post('/support/open', messageController.openSupportConversation);
router.get('/attachments/:messageId', messageController.downloadAttachment);
router.get('/conversations/:conversationId', messageController.getConversationMessages);
router.post(
  '/conversations/:conversationId',
  uploadChatAttachment,
  messageController.sendMessage
);
router.patch('/conversations/:conversationId/read', messageController.markAsRead);
router.patch('/conversations/:conversationId/close', messageController.closeConversation);
router.get('/unread-count', messageController.getUnreadCount);

module.exports = router;
