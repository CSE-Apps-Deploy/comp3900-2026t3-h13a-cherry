import axios from 'axios';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import api from '../api-services/client';
import { useAuthStore } from '../store';
import { clearAuthStorage } from '../auth-storage';

const learner = { id: 'learner-a', firstName: 'Alex', role: 'LEARNER' };
const tutor = { id: 'tutor-b', firstName: 'Mina', role: 'TUTOR' };
const originalAdapter = api.defaults.adapter;
const originalAxiosAdapter = axios.defaults.adapter;
const ok = (config, data = {}) => ({ config, status: 200, statusText: 'OK', headers: {}, data });

beforeEach(() => {
  clearAuthStorage();
  useAuthStore.getState().setAuth({ user: learner, accessToken: 'access-a', refreshToken: 'refresh-a' });
});
afterEach(() => {
  api.defaults.adapter = originalAdapter;
  axios.defaults.adapter = originalAxiosAdapter;
  clearAuthStorage();
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null });
});

test('an old tab cannot send a private request using another account credentials', async () => {
  const transport = vi.fn(async (config) => ok(config));
  api.defaults.adapter = transport;
  localStorage.setItem('user', JSON.stringify(tutor));
  localStorage.setItem('accessToken', 'access-b');
  localStorage.setItem('refreshToken', 'refresh-b');
  await expect(api.get('/bookings/my-bookings')).rejects.toMatchObject({ code: 'ERR_CANCELED' });
  expect(transport).not.toHaveBeenCalled();
  expect(localStorage.getItem('accessToken')).toBe('access-b');
});


test.each([
  ['another account', tutor],
  ['the same account', { ...learner, firstName: 'Updated' }],
])('a late account response cannot replace a newer login to %s', async (_scenario, user) => {
  let complete;
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  api.defaults.adapter = (config) => new Promise((resolve) => {
    complete = () => resolve(ok(config, { user: learner }));
    ready();
  });
  const pending = useAuthStore.getState().fetchMe();
  await started;
  useAuthStore.getState().setAuth({ user, accessToken: 'access-b', refreshToken: 'refresh-b' });
  complete();
  await pending;
  expect(useAuthStore.getState().user).toEqual(user);
  expect(JSON.parse(localStorage.getItem('user'))).toEqual(user);
  expect(localStorage.getItem('accessToken')).toBe('access-b');
});


test('a late token refresh cannot overwrite a different account login', async () => {
  let complete;
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  let requests = 0;
  api.defaults.adapter = async (config) => {
    if (requests++ === 0) {
      throw new axios.AxiosError('Expired', 'ERR_BAD_REQUEST', config, null, { status: 401, config, data: {} });
    }
    return ok(config);
  };
  axios.defaults.adapter = (config) => new Promise((resolve) => {
    complete = () => resolve(ok(config, { accessToken: 'late-access-a', refreshToken: 'late-refresh-a' }));
    ready();
  });
  const pending = api.get('/auth/me');
  const rejected = expect(pending).rejects.toMatchObject({ code: 'ERR_CANCELED' });
  await started;
  useAuthStore.getState().setAuth({ user: tutor, accessToken: 'access-b', refreshToken: 'refresh-b' });
  complete();
  await rejected;
  expect(localStorage.getItem('accessToken')).toBe('access-b');
  expect(localStorage.getItem('refreshToken')).toBe('refresh-b');
  expect(JSON.parse(localStorage.getItem('user')).id).toBe(tutor.id);
  expect(requests).toBe(1);
});


test.each([
  ['another account', tutor, 'access-b', 'refresh-b'],
  ['the same account', learner, 'new-access-a', 'new-refresh-a'],
  ['the same account with unchanged tokens', learner, 'access-a', 'refresh-a'],
])('a late sign-out cannot delete a newer login to %s', async (_scenario, user, accessToken, refreshToken) => {
  let complete;
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  api.defaults.adapter = (config) => new Promise((resolve) => {
    complete = () => resolve(ok(config));
    ready();
  });
  const pending = useAuthStore.getState().logout();
  await started;
  useAuthStore.getState().setAuth({ user, accessToken, refreshToken });
  complete();
  await pending;
  expect(useAuthStore.getState().user?.id).toBe(user.id);
  expect(localStorage.getItem('accessToken')).toBe(accessToken);
  expect(localStorage.getItem('refreshToken')).toBe(refreshToken);
});


test('a late sign-out preserves a newer same-account login from another tab', async () => {
  let complete;
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  api.defaults.adapter = (config) => new Promise((resolve) => {
    complete = () => resolve(ok(config));
    ready();
  });
  const pending = useAuthStore.getState().logout();
  await started;
  vi.resetModules();
  const { useAuthStore: otherTab } = await import('../store');
  otherTab.getState().setAuth({ user: learner, accessToken: 'other-tab-access', refreshToken: 'other-tab-refresh' });
  complete();
  await pending;
  expect(localStorage.getItem('accessToken')).toBe('other-tab-access');
  expect(localStorage.getItem('refreshToken')).toBe('other-tab-refresh');
  expect(useAuthStore.getState().user?.id).toBe(learner.id);
});

test('a normal refresh keeps its new tokens after loading the account', async () => {
  let requests = 0;
  api.defaults.adapter = async (config) => {
    if (requests++ === 0) {
      throw new axios.AxiosError('Expired', 'ERR_BAD_REQUEST', config, null, { status: 401, config, data: {} });
    }
    expect(config.headers.Authorization).toBe('Bearer refreshed-access-a');
    return ok(config, { user: learner });
  };
  axios.defaults.adapter = async (config) => ok(config, { accessToken: 'refreshed-access-a', refreshToken: 'refreshed-refresh-a' });
  await useAuthStore.getState().fetchMe();
  expect(localStorage.getItem('accessToken')).toBe('refreshed-access-a');
  expect(localStorage.getItem('refreshToken')).toBe('refreshed-refresh-a');
  expect(useAuthStore.getState().accessToken).toBe('refreshed-access-a');
});


test('updating the current profile preserves tokens refreshed by its request', async () => {
  let requests = 0;
  api.defaults.adapter = async (config) => {
    if (requests++ === 0) {
      throw new axios.AxiosError('Expired', 'ERR_BAD_REQUEST', config, null, { status: 401, config, data: {} });
    }
    return ok(config, { user: { ...learner, firstName: 'Updated' } });
  };
  axios.defaults.adapter = async (config) => ok(config, { accessToken: 'refreshed-access-a', refreshToken: 'refreshed-refresh-a' });
  const response = await api.put('/users/me', { firstName: 'Updated' });
  useAuthStore.getState().setUser(response.data.user);
  expect(localStorage.getItem('accessToken')).toBe('refreshed-access-a');
  expect(localStorage.getItem('refreshToken')).toBe('refreshed-refresh-a');
});
