const request = require('supertest');

const prisma = {
  user: {
    findUnique: vi.fn(),
  },
  subject: {
    findFirst: vi.fn(),
    upsert: vi.fn(),
  },
  subjectRequest: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  tutorSubject: {
    upsert: vi.fn(),
  },
  notification: {
    create: vi.fn(),
  },
};

prisma.$transaction = vi.fn(async (callback) => callback(prisma));

const databaseModulePath = require.resolve('../../src/config/database');
const appModulePath = require.resolve('../../src/app');

delete require.cache[databaseModulePath];
delete require.cache[appModulePath];

require.cache[databaseModulePath] = {
  id: databaseModulePath,
  filename: databaseModulePath,
  loaded: true,
  exports: { prisma },
};

const app = require('../../src/app');
const { createAccessToken } = require('../../src/utils/tokens');

const learnerUser = {
  id: 'learner-1',
  email: 'learner@example.com',
  timezone: 'UTC',
  role: 'LEARNER',
  status: 'ACTIVE',
  tutorProfile: null,
};

const activeTutorUser = {
  id: 'tutor-user-1',
  email: 'tutor@example.com',
  timezone: 'UTC',
  role: 'TUTOR',
  status: 'ACTIVE',
  tutorProfile: {
    id: 'tutor-profile-1',
    status: 'ACTIVE',
    applicationSubmitted: true,
    isVerified: true,
  },
};

const pendingTutorUser = {
  ...activeTutorUser,
  id: 'pending-tutor-user',
  email: 'pending@example.com',
  tutorProfile: {
    ...activeTutorUser.tutorProfile,
    id: 'pending-tutor-profile',
    status: 'PENDING',
  },
};

const accessTokenFor = (user) => createAccessToken(user);

beforeEach(() => {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
});

describe('subject request API integration tests', () => {
  test('requires authentication', async () => {
    const response = await request(app).get('/api/v1/subject-requests');

    expect(response.status).toBe(401);
  });

  test('creates a learner subject request with a canonical existing category', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.subject.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ category: 'Computing' });
    prisma.subjectRequest.findFirst.mockResolvedValueOnce(null);
    prisma.subjectRequest.create.mockResolvedValueOnce({
      id: 'request-1',
      learnerId: learnerUser.id,
      subjectName: 'Rust Programming',
      category: 'Computing',
      description: 'I want to learn ownership and async Rust.',
      status: 'OPEN',
      resolvedSubject: null,
      acceptedTutor: null,
    });

    const response = await request(app)
      .post('/api/v1/subject-requests')
      .set('Authorization', `Bearer ${accessTokenFor(learnerUser)}`)
      .send({
        subjectName: '  Rust Programming  ',
        category: 'computing',
        description: 'I want to learn ownership and async Rust.',
      });

    expect(response.status).toBe(201);
    expect(response.body.data.status).toBe('OPEN');
    expect(prisma.subjectRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          learnerId: learnerUser.id,
          subjectName: 'Rust Programming',
          category: 'Computing',
        }),
      })
    );
  });

  test('rejects a request when the subject already exists case-insensitively', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.subject.findFirst
      .mockResolvedValueOnce({ id: 'subject-1', name: 'Mathematics' })
      .mockResolvedValueOnce({ category: 'Mathematics' });
    prisma.subjectRequest.findFirst.mockResolvedValueOnce(null);

    const response = await request(app)
      .post('/api/v1/subject-requests')
      .set('Authorization', `Bearer ${accessTokenFor(learnerUser)}`)
      .send({
        subjectName: 'mathematics',
        category: 'Mathematics',
        description: 'I need help with a specialised mathematics topic.',
      });

    expect(response.status).toBe(409);
    expect(response.body.message).toContain('already exists');
    expect(prisma.subjectRequest.create).not.toHaveBeenCalled();
  });

  test('rejects a duplicate open request from the same learner', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.subject.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ category: 'Computing' });
    prisma.subjectRequest.findFirst.mockResolvedValueOnce({ id: 'existing-request' });

    const response = await request(app)
      .post('/api/v1/subject-requests')
      .set('Authorization', `Bearer ${accessTokenFor(learnerUser)}`)
      .send({
        subjectName: 'Rust Programming',
        category: 'Computing',
        description: 'I want to learn ownership and async Rust.',
      });

    expect(response.status).toBe(409);
    expect(response.body.message).toContain('already have an open request');
  });

  test('validates request fields before creating a subject request', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);

    const response = await request(app)
      .post('/api/v1/subject-requests')
      .set('Authorization', `Bearer ${accessTokenFor(learnerUser)}`)
      .send({
        subjectName: 'R',
        category: '',
        description: 'Short',
      });

    expect(response.status).toBe(400);
    expect(response.body.errors).toHaveLength(3);
    expect(prisma.subjectRequest.create).not.toHaveBeenCalled();
  });

  test('paginates a learner history within the authenticated learner scope', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.subjectRequest.findMany.mockResolvedValueOnce([]);
    prisma.subjectRequest.count.mockResolvedValueOnce(7);

    const response = await request(app)
      .get('/api/v1/subject-requests?status=CANCELLED&page=2&limit=5')
      .set('Authorization', `Bearer ${accessTokenFor(learnerUser)}`);

    expect(response.status).toBe(200);
    expect(response.body.data.pagination).toEqual({
      page: 2,
      limit: 5,
      total: 7,
      totalPages: 2,
    });
    expect(prisma.subjectRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { learnerId: learnerUser.id, status: 'CANCELLED' },
        skip: 5,
        take: 5,
      })
    );
  });

  test('lists open requests for tutors without querying learner identity', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(activeTutorUser);
    prisma.subjectRequest.findMany.mockResolvedValueOnce([
      {
        id: 'request-1',
        subjectName: 'Rust Programming',
        category: 'Computing',
        description: 'I want to learn ownership and async Rust.',
        status: 'OPEN',
        acceptedTutor: null,
        resolvedSubject: null,
      },
    ]);
    prisma.subjectRequest.count.mockResolvedValueOnce(1);

    const response = await request(app)
      .get('/api/v1/subject-requests?status=OPEN')
      .set('Authorization', `Bearer ${accessTokenFor(activeTutorUser)}`);

    expect(response.status).toBe(200);
    expect(response.body.data.subjectRequests[0]).not.toHaveProperty('learner');
    expect(response.body.data.subjectRequests[0]).not.toHaveProperty('learnerId');
    expect(prisma.subjectRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { status: 'OPEN' },
            { status: 'ACCEPTED', acceptedTutorId: activeTutorUser.tutorProfile.id },
          ],
          status: 'OPEN',
        },
      })
    );
    const include = prisma.subjectRequest.findMany.mock.calls[0][0].include;
    expect(include).not.toHaveProperty('learner');
  });

  test('blocks unapproved tutors from viewing the board', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(pendingTutorUser);

    const response = await request(app)
      .get('/api/v1/subject-requests')
      .set('Authorization', `Bearer ${accessTokenFor(pendingTutorUser)}`);

    expect(response.status).toBe(403);
    expect(prisma.subjectRequest.findMany).not.toHaveBeenCalled();
  });

  test('lets the owner cancel an open request', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.subjectRequest.findUnique
      .mockResolvedValueOnce({ id: 'request-1', learnerId: learnerUser.id, status: 'OPEN' })
      .mockResolvedValueOnce({ id: 'request-1', learnerId: learnerUser.id, status: 'CANCELLED' });
    prisma.subjectRequest.updateMany.mockResolvedValueOnce({ count: 1 });

    const response = await request(app)
      .patch('/api/v1/subject-requests/request-1/cancel')
      .set('Authorization', `Bearer ${accessTokenFor(learnerUser)}`);

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('CANCELLED');
    expect(prisma.subjectRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'request-1', learnerId: learnerUser.id, status: 'OPEN' },
      })
    );
  });

  test('prevents a learner from cancelling another learner request', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.subjectRequest.findUnique.mockResolvedValueOnce({
      id: 'request-2',
      learnerId: 'learner-2',
      status: 'OPEN',
    });

    const response = await request(app)
      .patch('/api/v1/subject-requests/request-2/cancel')
      .set('Authorization', `Bearer ${accessTokenFor(learnerUser)}`);

    expect(response.status).toBe(403);
    expect(prisma.subjectRequest.updateMany).not.toHaveBeenCalled();
  });

  test('atomically accepts a request, creates the subject, adds it to the tutor, and notifies the learner', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(activeTutorUser);
    prisma.subjectRequest.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.subjectRequest.findUnique.mockResolvedValueOnce({
      id: 'request-1',
      learnerId: learnerUser.id,
      subjectName: 'Rust Programming',
      category: 'Computing',
      description: 'I want to learn ownership and async Rust.',
      status: 'ACCEPTED',
    });
    prisma.subject.findFirst.mockResolvedValueOnce(null);
    prisma.subject.upsert.mockResolvedValueOnce({
      id: 'subject-rust',
      name: 'Rust Programming',
      category: 'Computing',
    });
    prisma.tutorSubject.upsert.mockResolvedValueOnce({ id: 'tutor-subject-1' });
    prisma.subjectRequest.update.mockResolvedValueOnce({
      id: 'request-1',
      learnerId: learnerUser.id,
      subjectName: 'Rust Programming',
      category: 'Computing',
      status: 'ACCEPTED',
      resolvedSubject: { id: 'subject-rust', name: 'Rust Programming', category: 'Computing' },
      acceptedTutor: {
        id: activeTutorUser.tutorProfile.id,
        user: { firstName: 'Taylor', lastName: 'Tutor' },
      },
    });
    prisma.notification.create.mockResolvedValueOnce({ id: 'notification-1' });

    const response = await request(app)
      .patch('/api/v1/subject-requests/request-1/accept')
      .set('Authorization', `Bearer ${accessTokenFor(activeTutorUser)}`)
      .send({ hourlyRate: '85.50' });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('ACCEPTED');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.subject.upsert).toHaveBeenCalledWith({
      where: { name: 'Rust Programming' },
      update: {},
      create: { name: 'Rust Programming', category: 'Computing', description: null },
    });
    expect(prisma.tutorSubject.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          tutorId: activeTutorUser.tutorProfile.id,
          subjectId: 'subject-rust',
          level: 'all',
          hourlyRate: '85.50',
        },
        update: { hourlyRate: '85.50' },
      })
    );
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: learnerUser.id,
          type: 'subject_request',
          link: `/tutors/${activeTutorUser.tutorProfile.id}?from=subject-requests`,
        }),
      })
    );
  });

  test('reuses a catalogue subject created after the learner submitted the request', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(activeTutorUser);
    prisma.subjectRequest.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.subjectRequest.findUnique.mockResolvedValueOnce({
      id: 'request-2',
      learnerId: learnerUser.id,
      subjectName: 'Rust Programming',
      category: 'Computing',
      description: 'I want to learn ownership and async Rust.',
      status: 'ACCEPTED',
    });
    prisma.subject.findFirst.mockResolvedValueOnce({
      id: 'subject-rust',
      name: 'Rust Programming',
      category: 'Computing',
    });
    prisma.tutorSubject.upsert.mockResolvedValueOnce({ id: 'tutor-subject-2' });
    prisma.subjectRequest.update.mockResolvedValueOnce({
      id: 'request-2',
      learnerId: learnerUser.id,
      subjectName: 'Rust Programming',
      status: 'ACCEPTED',
      resolvedSubject: { id: 'subject-rust', name: 'Rust Programming', category: 'Computing' },
      acceptedTutor: {
        id: activeTutorUser.tutorProfile.id,
        user: { firstName: 'Taylor', lastName: 'Tutor' },
      },
    });
    prisma.notification.create.mockResolvedValueOnce({ id: 'notification-2' });

    const response = await request(app)
      .patch('/api/v1/subject-requests/request-2/accept')
      .set('Authorization', `Bearer ${accessTokenFor(activeTutorUser)}`)
      .send({ hourlyRate: '72' });

    expect(response.status).toBe(200);
    expect(response.body.data).not.toHaveProperty('learnerId');
    expect(prisma.subject.upsert).not.toHaveBeenCalled();
    expect(prisma.tutorSubject.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ subjectId: 'subject-rust' }),
        update: { hourlyRate: '72.00' },
      })
    );
  });

  test('requires a valid hourly rate before claiming a subject request', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(activeTutorUser);

    const response = await request(app)
      .patch('/api/v1/subject-requests/request-1/accept')
      .set('Authorization', `Bearer ${accessTokenFor(activeTutorUser)}`)
      .send({ hourlyRate: '0' });

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('Validation failed');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.subjectRequest.updateMany).not.toHaveBeenCalled();
  });

  test('returns a conflict when another tutor already claimed the request', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(activeTutorUser);
    prisma.subjectRequest.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.subjectRequest.findUnique.mockResolvedValueOnce({ id: 'request-1' });

    const response = await request(app)
      .patch('/api/v1/subject-requests/request-1/accept')
      .set('Authorization', `Bearer ${accessTokenFor(activeTutorUser)}`)
      .send({ hourlyRate: '80.00' });

    expect(response.status).toBe(409);
    expect(response.body.message).toContain('already been claimed');
    expect(prisma.tutorSubject.upsert).not.toHaveBeenCalled();
  });
});
