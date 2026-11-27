require('express-async-errors');
const request = require('supertest');
const path = require('path');
const fs = require('fs');
const { createAccessToken } = require('../../src/utils/tokens');
const filename = '11111111-2222-4333-8444-555555555555.txt';
const owner = { id: 'document-owner', email: 'owner@example.com', role: 'TUTOR', status: 'ACTIVE', timezone: 'UTC' };
const users = [owner, { id: 'admin', role: 'ADMIN', status: 'ACTIVE' }, { id: 'other', role: 'LEARNER', status: 'ACTIVE' }];
const profile = { id: 'profile', userId: owner.id, status: 'ACTIVE', trialLessonLimit: 0, user: owner, subjects: [], availability: [],
    certifications: [{ kind: 'file', url: '/uploads/documents/' + filename, originalName: 'cv.txt' }, { kind: 'qualification', text: 'Public qualification' }] };
const prisma = { user: { findUnique: async ({ where }) => users.find(x => x.id === where.id) },
    tutorProfile: { findFirst: async () => profile, findMany: async () => [profile], count: async () => 1, findUnique: async ({ where }) => where.userId === owner.id || where.id === 'profile' ? profile : null },
    booking: { count: async () => 0 } };
const databasePath = require.resolve('../../src/config/database');
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: { prisma } };
const app = require('../../src/app');

test('public tutor details and search omit verification file URLs but keep public qualifications', async () => {
    const details = await request(app).get('/api/v1/tutors/profile');
    expect(details.status).toBe(200);
    expect(details.body.data.certifications).toEqual([{ kind: 'qualification', text: 'Public qualification' }]);
    const search = await request(app).get('/api/v1/tutors');
    expect(search.body.data.tutors[0].certifications).toEqual([{ kind: 'qualification', text: 'Public qualification' }]);
});


const documentPath = path.resolve(__dirname, '../../uploads/documents', filename);
beforeAll(() => { fs.mkdirSync(path.dirname(documentPath), { recursive: true }); fs.writeFileSync(documentPath, 'private test CV'); });
afterAll(() => { if (fs.existsSync(documentPath)) fs.unlinkSync(documentPath); });
test('verification files are downloadable by the owner and administrators only', async () => {
    const url = '/api/v1/tutors/profile/verification-files/' + filename;
    expect((await request(app).get(url)).status).toBe(401);
    expect((await request(app).get(url).set('Authorization', 'Bearer ' + createAccessToken(users[2]))).status).toBe(403);
    for (const actor of users.slice(0, 2)) {
        const response = await request(app).get(url).set('Authorization', 'Bearer ' + createAccessToken(actor));
        expect(response.status).toBe(200);
        expect(response.headers['content-disposition']).toContain('cv.txt');
    }
    expect((await request(app).get('/uploads/documents/' + filename)).status).toBe(404);
});
