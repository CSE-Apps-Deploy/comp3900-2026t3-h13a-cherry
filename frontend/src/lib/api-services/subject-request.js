import api from './client';

export const subjectRequestApi = {
  list: (params) => api.get('/subject-requests', { params }),
  create: (data) => api.post('/subject-requests', data),
  cancel: (id) => api.patch(`/subject-requests/${id}/cancel`),
  accept: (id, hourlyRate) => api.patch(`/subject-requests/${id}/accept`, { hourlyRate }),
};
