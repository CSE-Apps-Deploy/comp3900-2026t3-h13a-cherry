// src/lib/store.js - Zustand Global State Store
import { create } from 'zustand';
import { authApi } from './api-entry';
import {
  clearAuthStorage,
  beginAuthSession,
  getAuthSessionVersion,
  getStoredUser,
  getStoredValue,
  saveAuthToStorage,
  STORAGE_KEYS,
} from './auth-storage';
// ==================== AUTH STORE ====================
export const useAuthStore = create((set, get) => ({
  user: getStoredUser(),
  accessToken: getStoredValue(STORAGE_KEYS.ACCESS_TOKEN),
  refreshToken: getStoredValue(STORAGE_KEYS.REFRESH_TOKEN),
  isLoading: false,

  setAuth: ({ user, accessToken, refreshToken }) => {
    beginAuthSession({ user, accessToken, refreshToken });
    set({ user, accessToken, refreshToken });
  },

  setUser: (user) => {
    const accessToken = getStoredValue(STORAGE_KEYS.ACCESS_TOKEN);
    const refreshToken = getStoredValue(STORAGE_KEYS.REFRESH_TOKEN);
    saveAuthToStorage({ user, accessToken, refreshToken });
    set({ user, accessToken, refreshToken });
  },

  initializeAuth: async () => {
    const { accessToken, user, fetchMe, logout } = get();
    if (!accessToken) return null;

    if (user) {
      fetchMe().catch(() => {});
      return user;
    }

    const currentUser = await fetchMe();
    if (!currentUser) await logout();
    return currentUser;
  },

  logout: async () => {
    const sessionVersion = getAuthSessionVersion();
    const userId = get().user?.id || null;
    const refreshToken = getStoredValue(STORAGE_KEYS.REFRESH_TOKEN);
    try {
      if (refreshToken) await authApi.logout(refreshToken);
    } catch {
      // Ignore errors
    }
    if (sessionVersion !== getAuthSessionVersion() || userId !== (get().user?.id || null) || userId !== (getStoredUser()?.id || null)) return;
    clearAuthStorage();
    set({ user: null, accessToken: null, refreshToken: null });
  },

  fetchMe: async () => {
    try {
      set({ isLoading: true });
      const { data } = await authApi.getMe();
      const nextUser = data.user;
      const accessToken = getStoredValue(STORAGE_KEYS.ACCESS_TOKEN);
      const refreshToken = getStoredValue(STORAGE_KEYS.REFRESH_TOKEN);
      saveAuthToStorage({ user: nextUser, accessToken, refreshToken });
      set({ user: nextUser, accessToken, refreshToken, isLoading: false });
      return nextUser;
    } catch {
      set({ isLoading: false });
      return null;
    }
  },

  isAuthenticated: () => !!get().accessToken,
  hasRole: (role) => get().user?.role === role,
  isTutor: () => get().user?.role === 'TUTOR',
  isLearner: () => get().user?.role === 'LEARNER',
  isAdmin: () => get().user?.role === 'ADMIN',
}));

export const useMessageStore = create((set) => ({
  unreadCount: 0,
  setUnreadCount: (count) => set({ unreadCount: count }),
  incrementUnread: () => set((state) => ({ unreadCount: state.unreadCount + 1 })),
  clearUnread: () => set({ unreadCount: 0 }),
}));
