import api from './client';

export const messageApi = {
  getConversations: () => api.get('/messages/conversations'),
  createConversation: (userId) => api.post('/messages/conversations', { userId }),
  openSupportConversation: () => api.post('/messages/support/open'),
  getMessages: (conversationId, params) =>
    api.get(`/messages/conversations/${conversationId}`, { params }),
  sendMessage: (conversationId, data) =>
    api.post(`/messages/conversations/${conversationId}`, data, {
      headers:
        typeof FormData !== 'undefined' && data instanceof FormData
          ? { 'Content-Type': 'multipart/form-data' }
          : undefined,
    }),
  downloadAttachment: (messageId) =>
    api.get(`/messages/attachments/${messageId}`, { responseType: 'blob' }),
  markAsRead: (conversationId) => api.patch(`/messages/conversations/${conversationId}/read`),
  closeConversation: (conversationId) => api.patch(`/messages/conversations/${conversationId}/close`),
  getUnreadCount: () => api.get('/messages/unread-count'),
};
