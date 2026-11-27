import { calendarStatuses } from '../lesson-lifecycle';
import api from './client';
import { bookingApi } from './booking';

export const sessionLinkApi = {
    get: (id) => api.get(`/bookings/${id}/meeting-link`),
    update: (id, data) => api.patch(`/bookings/${id}/meeting-link`, data),
};

export const passwordResetApi = {
    request: (email) => api.post('/auth/forgot-password', { email }),
    validate: (token) => api.post('/auth/reset-password/validate', { token }),
    reset: (data) => api.post('/auth/reset-password', data),
};

export async function getCalendarBookings(role) {
    const getBookings = role === 'TUTOR' ? bookingApi.getTutorBookings : bookingApi.getMyBookings;
    const bookings = [];
    for (const status of calendarStatuses) {
        let page = 1;
        let totalPages = 1;
        do {
            const response = await getBookings({ status, page, limit: 100 });
            const data = response.data.data;
            bookings.push(...data.bookings);
            totalPages = Number(data.pagination?.totalPages) || 1;
            page += 1;
        } while (page <= totalPages);
    }
    return bookings;
}
