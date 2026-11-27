import api from './client';

export const bookingApi = {
  create: (data) => api.post('/bookings', data),
  getMyBookings: (params) => api.get('/bookings/my-bookings', { params }),
  getTutorBookings: (params) => api.get('/bookings/tutor/requests', { params }),
  getById: (id) => api.get(`/bookings/${id}`),
  cancel: (id, reason) => api.post(`/bookings/${id}/cancel`, { reason }),
  accept: (id, data) => api.patch(`/bookings/${id}/accept`, data),
  decline: (id, reason, expectedVersion) =>
    api.patch(`/bookings/${id}/decline`, { reason, ...(expectedVersion ? { expectedVersion } : {}) }),
  changeRequestedTime: (id, data) => api.patch(`/bookings/${id}/requested-time`, data),
  proposePendingTime: (id, data) => api.post(`/bookings/${id}/time-proposals`, data),
  acceptPendingTimeProposal: (id, data) => api.patch(`/bookings/${id}/time-proposals/accept`, data),
  rejectPendingTimeProposal: (id, data) => api.patch(`/bookings/${id}/time-proposals/reject`, data),
  proposePriceOffer: (id, data) => api.post(`/bookings/${id}/price-offers`, data),
  acceptPriceOffer: (id, offerId, data) =>
    api.patch(`/bookings/${id}/price-offers/${offerId}/accept`, data),
  rejectPriceOffer: (id, offerId, data) =>
    api.patch(`/bookings/${id}/price-offers/${offerId}/reject`, data),
  withdrawPriceOffer: (id, offerId, data) =>
    api.patch(`/bookings/${id}/price-offers/${offerId}/withdraw`, data),
  proposeReschedule: (id, data) => api.post(`/bookings/${id}/reschedule-requests`, data),
  acceptRescheduleRequest: (id, requestId, expectedVersion) =>
    api.patch(`/bookings/${id}/reschedule-requests/${requestId}/accept`, { expectedVersion }),
  declineRescheduleRequest: (id, requestId, reason, expectedVersion) =>
    api.patch(`/bookings/${id}/reschedule-requests/${requestId}/decline`, { reason, expectedVersion }),
  complete: (id, expectedVersion) =>
    api.patch(`/bookings/${id}/complete`, { expectedVersion }),
  markNotCompleted: (id, reason, expectedVersion) =>
    api.patch(`/bookings/${id}/not-completed`, { reason, expectedVersion }),
  confirmCompletion: (id, expectedVersion) =>
    api.patch(`/bookings/${id}/completion-review/confirm`, { expectedVersion }),
  disputeCompletion: (id, reason, expectedVersion) =>
    api.post(`/bookings/${id}/completion-dispute`, { reason, expectedVersion }),
};
