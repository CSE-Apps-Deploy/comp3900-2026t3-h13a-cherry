const STORAGE_KEYS = {
  USER: 'user',
  ACCESS_TOKEN: 'accessToken',
  REFRESH_TOKEN: 'refreshToken',
  SESSION_VERSION: 'authSessionVersion',
};

let sessionUserId = getStoredUser()?.id || null;
export function getAuthSessionVersion() {
  return Number(getStoredValue(STORAGE_KEYS.SESSION_VERSION)) || 0;
}

export function beginAuthSession(auth) {
  if (canUseStorage()) {
    localStorage.setItem(STORAGE_KEYS.SESSION_VERSION, String(getAuthSessionVersion() + 1));
  }
  saveAuthToStorage(auth);
}

export function getSessionUserId() {
  return sessionUserId;
}

function canUseStorage() {
  return typeof window !== 'undefined';
}

export function getStoredValue(key) {
  if (!canUseStorage()) return null;
  return localStorage.getItem(key);
}

export function getStoredUser() {
  const rawUser = getStoredValue(STORAGE_KEYS.USER);
  if (!rawUser || rawUser === 'undefined') return null;

  try {
    return JSON.parse(rawUser);
  } catch {
    return null;
  }
}

export function saveAuthToStorage({ user, accessToken, refreshToken }) {
  if (!canUseStorage()) return;

  sessionUserId = user?.id || null;
  if (user) localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(user));
  else localStorage.removeItem(STORAGE_KEYS.USER);

  if (accessToken) localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, accessToken);
  else localStorage.removeItem(STORAGE_KEYS.ACCESS_TOKEN);

  if (refreshToken) localStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, refreshToken);
  else localStorage.removeItem(STORAGE_KEYS.REFRESH_TOKEN);
}

export function clearAuthStorage() {
  if (!canUseStorage()) return;

  localStorage.setItem(STORAGE_KEYS.SESSION_VERSION, String(getAuthSessionVersion() + 1));
  sessionUserId = null;
  localStorage.removeItem(STORAGE_KEYS.USER);
  localStorage.removeItem(STORAGE_KEYS.ACCESS_TOKEN);
  localStorage.removeItem(STORAGE_KEYS.REFRESH_TOKEN);
}

export { STORAGE_KEYS };
