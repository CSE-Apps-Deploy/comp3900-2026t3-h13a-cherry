import api from './client';

export const adminApi = {
  getDashboard: () => api.get('/admin/dashboard'),
  getAnalytics: (params) => api.get('/admin/analytics', { params }),
  getUsers: (params) => api.get('/admin/users', { params }),
  getUser: (id) => api.get(`/admin/users/${id}`),
  updateUserStatus: (id, data) => api.patch(`/admin/users/${id}/status`, data),
  getPendingTutors: (params) => api.get('/admin/tutors/pending', { params }),
  approveTutor: (id) => api.patch(`/admin/tutors/${id}/approve`),
  rejectTutor: (id, reason) =>
    api.patch(`/admin/tutors/${id}/reject`, typeof reason === 'object' ? reason : { reason }),
  returnTutor: (id, feedback) =>
    api.patch(`/admin/tutors/${id}/return`, typeof feedback === 'object' ? feedback : { feedback }),
  getBookings: (params) => api.get('/admin/bookings', { params }),
  getPayoutOverview: () => api.get('/admin/payouts'),
  getPayoutRuns: (params) => api.get('/admin/payout-runs', { params }),
  processPayoutRun: () => api.post('/admin/payout-runs'),
  processTutorPayoutRun: (tutorProfileId) =>
    api.post(`/admin/payout-runs/tutors/${tutorProfileId}`),
  clearCompletionDispute: (bookingId, note, expectedVersion) =>
    api.patch(`/admin/bookings/${bookingId}/completion-dispute/clear`, {
      note,
      expectedVersion,
    }),
  refundCompletionDispute: (bookingId, note, expectedVersion) =>
    api.patch(`/admin/bookings/${bookingId}/completion-dispute/refund`, {
      note,
      expectedVersion,
    }),
  retryCompletionRefund: (refundId) => api.post(`/admin/refunds/${refundId}/retry`),
  getReviews: (params) => api.get('/admin/reviews', { params }),
  deleteReview: (id) => api.delete(`/admin/reviews/${id}`),
  getActions: (params) => api.get('/admin/actions', { params }),
  createSubject: (data) => api.post('/admin/subjects', data),
  updateSubject: (id, data) => api.put(`/admin/subjects/${id}`, data),
  deleteSubject: (id) => api.delete(`/admin/subjects/${id}`),
};
