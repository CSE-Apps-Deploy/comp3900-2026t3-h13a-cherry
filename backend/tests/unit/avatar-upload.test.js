require('express-async-errors');
const express = require('express');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const { createAccessToken } = require('../../src/utils/tokens');
let user;
const prisma = { user: {
  findUnique: async () => user,
  update: async ({ data }) => { user = { ...user, ...data }; return user; },
} };
const dbPath = require.resolve('../../src/config/database');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma } };
const { errorHandler } = require('../../src/middleware/errorHandler');
const app = express();
app.use('/api/v1/users', require('../../src/routes/users'));
app.use('/api/v1/auth', require('../../src/routes/auth'));
app.use('/uploads', express.static(path.resolve(__dirname, '../../uploads')));
app.use(errorHandler);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
beforeEach(() => { user = { id: 'avatar-user', email: 'avatar@example.com', firstName: 'Avatar', role: 'LEARNER', status: 'ACTIVE', avatar: null }; });
afterEach(() => {
  if (user.avatar) {
    const target = path.resolve(__dirname, '../../' + user.avatar);
    const root = path.resolve(__dirname, '../../uploads/avatars') + path.sep;
    if (target.startsWith(root) && fs.existsSync(target)) fs.unlinkSync(target);
  }
});
test('a signed-in user uploads an avatar and sees it in their saved profile', async () => {
  const token = createAccessToken(user);
  const uploaded = await request(app).post('/api/v1/users/me/avatar')
    .set('Authorization', 'Bearer ' + token).attach('avatar', png, 'portrait.png');
  expect(uploaded.status).toBe(200);
  const me = await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer ' + token);
  expect(me.body.user.avatar).toMatch(/^\/uploads\/avatars\/.+\.png$/);
  expect((await request(app).get(me.body.user.avatar)).status).toBe(200);
});


test('documents cannot be uploaded as an avatar', async () => {
  const response = await request(app).post('/api/v1/users/me/avatar')
    .set('Authorization', 'Bearer ' + createAccessToken(user))
    .attach('avatar', Buffer.from('test document'), 'avatar.txt');
  expect(response.status).toBe(400);
});

test('avatar upload requires authentication and an image', async () => {
  expect((await request(app).post('/api/v1/users/me/avatar').attach('avatar', png, 'portrait.png')).status).toBe(401);
  expect((await request(app).post('/api/v1/users/me/avatar').set('Authorization', 'Bearer ' + createAccessToken(user))).status).toBe(400);
});
