require('express-async-errors');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const directory = path.resolve(__dirname, '../../uploads/configured-storage-test');
process.env.UPLOAD_DIR = directory;
const databasePath = require.resolve('../../src/config/database');
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: { prisma: {} } };
const app = require('../../src/app');
beforeAll(() => { fs.mkdirSync(path.join(directory, 'avatars'), { recursive: true }); fs.writeFileSync(path.join(directory, 'avatars/persisted.png'), Buffer.from('saved image')); });
afterAll(() => { fs.unlinkSync(path.join(directory, 'avatars/persisted.png')); fs.rmdirSync(path.join(directory, 'avatars')); fs.rmdirSync(directory); delete process.env.UPLOAD_DIR; });
test('public avatar reads use the configured persistent upload directory', async () => {
  const response = await request(app).get('/uploads/avatars/persisted.png');
  expect(response.status).toBe(200);
});
