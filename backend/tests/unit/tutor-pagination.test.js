require('express-async-errors');
const express = require('express');
const request = require('supertest');
const prisma = { tutorProfile: { findMany: vi.fn(), count: vi.fn() } };
const databasePath = require.resolve('../../src/config/database');
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: { prisma } };
const { errorHandler } = require('../../src/middleware/errorHandler');
const app = express();
app.use('/tutors', require('../../src/routes/tutors'));
app.use(errorHandler);

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tutorProfile.findMany.mockResolvedValue([]);
  prisma.tutorProfile.count.mockResolvedValue(0);
});

test('rejects a non-numeric page with a safe client error', async () => {
  const response = await request(app).get('/tutors?page=abc');
  expect(response.status).toBe(400);
  expect(response.body.message).toBe('Validation failed');
  expect(response.body.errors).toContainEqual({ field: 'page', message: expect.any(String) });
  expect(JSON.stringify(response.body)).not.toMatch(/prisma|findMany|NaN|\/app\//i);
});


afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

test('hides unexpected database errors in production responses', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  prisma.tutorProfile.findMany.mockRejectedValueOnce(
    new Error('Invalid prisma.tutorProfile.findMany invocation at /app/src/controllers/tutorController.js')
  );
  const response = await request(app).get('/tutors');
  expect(response.status).toBe(500);
  expect(response.body).toEqual({ success: false, message: 'Internal Server Error' });
});


test.each([
  'page=0', 'page=-1', 'page=1.5', 'page=1abc', 'page=', 'page=NaN',
  'page=Infinity', 'page=9007199254740992', 'page=2147483647&limit=100',
  'page[]=1', 'page[x]=1', 'page=1&page=2',
  'limit=abc', 'limit=0', 'limit=-1', 'limit=1.5', 'limit=101', 'limit=',
  'limit[]=12', 'limit[x]=12',
])('rejects invalid pagination %s', async (query) => {
  const response = await request(app).get('/tutors?' + query);
  expect(response.status).toBe(400);
  expect(response.body.success).toBe(false);
  expect(JSON.stringify(response.body)).not.toMatch(/prisma|findMany|NaN|\/app\//i);
});

test('retains defaults and normal pagination metadata', async () => {
  let response = await request(app).get('/tutors');
  expect(response.status).toBe(200);
  expect(response.body.data.pagination).toEqual({ page: 1, limit: 12, total: 0, totalPages: 0 });
  prisma.tutorProfile.count.mockResolvedValueOnce(5);
  response = await request(app).get('/tutors?page=2&limit=2');
  expect(response.status).toBe(200);
  expect(response.body.data.pagination).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3 });
});

test('a valid page beyond the results returns an empty list', async () => {
  const response = await request(app).get('/tutors?page=99999&limit=12');
  expect(response.status).toBe(200);
  expect(response.body.data.tutors).toEqual([]);
});
