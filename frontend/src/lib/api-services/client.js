import axios from 'axios';
import { clearAuthStorage, getAuthSessionVersion, getSessionUserId, getStoredUser } from '../auth-storage';

const API_URL = (process.env.NEXT_PUBLIC_API_URL || '/api/v1').replace(/\/$/, '');

const assertResponseSession = (config) => {
  if (config?._authUserId !== undefined && (
    config._authUserId !== (getStoredUser()?.id || null) ||
    config._authSessionVersion !== getAuthSessionVersion()
  )) {
    throw new axios.CanceledError('Account changed while the request was in progress.');
  }
};

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

api.interceptors.request.use(
  (config) => {
    const publicAuth = /\/auth\/(login|register|verify-email|resend-verification|refresh-token|forgot-password|reset-password)(?:[/?]|$)/.test(config.url || '');
    if (!publicAuth && getSessionUserId() !== (getStoredUser()?.id || null)) {
      throw new axios.CanceledError('Account changed. Sign in again before continuing.');
    }
    config._authUserId = getStoredUser()?.id || null;
    config._authSessionVersion = getAuthSessionVersion();
    const token = localStorage.getItem('accessToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

api.interceptors.response.use(
  (response) => {
    assertResponseSession(response.config);
    return response;
  },
  async (error) => {
    const originalRequest = error.config;
    assertResponseSession(originalRequest);
    const requestUrl = originalRequest?.url || '';
    const isAuthEndpoint = /\/auth\/(login|register|verify-email|resend-verification|refresh-token)/.test(
      requestUrl
    );

    if (error.response?.status === 401 && !originalRequest._retry && !isAuthEndpoint) {
      originalRequest._retry = true;

      const refreshToken = localStorage.getItem('refreshToken');
      if (!refreshToken) {
        clearAuthStorage();
        window.location.href = '/login';
        return Promise.reject(error);
      }

      try {
        const response = await axios.post(`${API_URL}/auth/refresh-token`, {
          refreshToken,
        });
        assertResponseSession(originalRequest);
        if (localStorage.getItem('refreshToken') !== refreshToken) {
          throw new axios.CanceledError('The login changed while the token was refreshing.');
        }
        const accessToken = response.data.accessToken;
        const newRefreshToken = response.data.refreshToken;

        localStorage.setItem('accessToken', accessToken);
        localStorage.setItem('refreshToken', newRefreshToken);

        originalRequest.headers.Authorization = `Bearer ${accessToken}`;

        return api(originalRequest);
      } catch (refreshError) {
        if (axios.isCancel(refreshError)) return Promise.reject(refreshError);
        assertResponseSession(originalRequest);
        if (localStorage.getItem('refreshToken') !== refreshToken) {
          return Promise.reject(new axios.CanceledError('The login changed while the token was refreshing.'));
        }
        clearAuthStorage();
        window.location.href = '/login';
        return Promise.reject(error);
      }
    }

    return Promise.reject(error);
  }
);

export default api;
