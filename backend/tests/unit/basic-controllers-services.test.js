const prisma = {
  user: {
    update: vi.fn(),
    findMany: vi.fn(),
  },
  notification: {
    create: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    createMany: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    updateMany: vi.fn(),
  },
};

const databaseModulePath = require.resolve('../../src/config/database');
const userControllerPath = require.resolve('../../src/controllers/userController');
const notificationControllerPath = require.resolve('../../src/controllers/notificationController');
const notificationServicePath = require.resolve('../../src/services/notificationService');

for (const modulePath of [
  databaseModulePath,
  userControllerPath,
  notificationControllerPath,
  notificationServicePath,
]) {
  delete require.cache[modulePath];
}

require.cache[databaseModulePath] = {
  id: databaseModulePath,
  filename: databaseModulePath,
  loaded: true,
  exports: { prisma },
};

const userController = require('../../src/controllers/userController');
const notificationController = require('../../src/controllers/notificationController');
const notificationService = require('../../src/services/notificationService');

const makeResponse = () => {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('user controller', () => {
  test('requires authentication before updating a profile', async () => {
    const res = makeResponse();

    await userController.updateMyProfile({ body: {} }, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('rejects an invalid timezone', async () => {
    await expect(
      userController.updateMyProfile(
        { user: { id: 'user-1' }, body: { timezone: 'Mars/Olympus' } },
        makeResponse()
      )
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('updates every supported profile field', async () => {
    prisma.user.update.mockResolvedValue({
      id: 'user-1',
      email: 'lee@example.com',
      firstName: 'Lee',
      lastName: 'Learner',
      bio: 'Updated bio',
      phone: '0400000000',
      timezone: 'Australia/Sydney',
      role: 'LEARNER',
      status: 'ACTIVE',
    });
    const res = makeResponse();

    await userController.updateMyProfile(
      {
        user: { id: 'user-1' },
        body: {
          firstName: 'Lee',
          lastName: 'Learner',
          bio: 'Updated bio',
          phone: '0400000000',
          timezone: ' Australia/Sydney ',
        },
      },
      res
    );

    expect(prisma.user.update.mock.calls[0][0].data).toEqual({
      firstName: 'Lee',
      lastName: 'Learner',
      bio: 'Updated bio',
      phone: '0400000000',
      timezone: 'Australia/Sydney',
    });
    expect(res.json.mock.calls[0][0].user.timezone).toBe('Australia/Sydney');
  });

  test('supports an empty partial profile update', async () => {
    prisma.user.update.mockResolvedValue({ id: 'user-1' });

    await userController.updateMyProfile(
      { user: { id: 'user-1' }, body: {} },
      makeResponse()
    );

    expect(prisma.user.update.mock.calls[0][0].data).toEqual({});
  });
});

describe('notification controller', () => {
  test.each([
    ['read', true],
    ['unread', false],
    ['anything', undefined],
  ])('lists %s notifications', async (status, expectedRead) => {
    prisma.notification.findMany.mockResolvedValue([{ id: 'notification-1' }]);
    prisma.notification.count.mockResolvedValue(11);
    const res = makeResponse();

    await notificationController.searchNotifications(
      {
        user: { id: 'user-1' },
        query: { status, type: 'booking', page: '2', limit: '5' },
      },
      res
    );

    const where = prisma.notification.findMany.mock.calls[0][0].where;
    expect(where.userId).toBe('user-1');
    if (expectedRead === undefined) expect(where).not.toHaveProperty('read');
    else expect(where.read).toBe(expectedRead);
    expect(res.json.mock.calls[0][0].data.pagination.totalPages).toBe(3);
  });

  test('requires IDs before marking notifications read', async () => {
    const res = makeResponse();

    await notificationController.markAsRead(
      { user: { id: 'user-1' }, query: {} },
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
  });

  test.each([
    ['all', { userId: 'user-1' }],
    ['one,two', { id: { in: ['one', 'two'] }, userId: 'user-1' }],
  ])('marks %s notifications read', async (ids, where) => {
    prisma.notification.updateMany.mockResolvedValue({ count: 2 });

    await notificationController.markAsRead(
      { user: { id: 'user-1' }, query: { ids } },
      makeResponse()
    );

    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where,
      data: { read: true },
    });
  });

  test('adds the development notification fixtures', async () => {
    prisma.notification.createMany.mockResolvedValue({ count: 20 });
    const res = makeResponse();

    await notificationController.addTestsData(
      { user: { id: 'user-1' } },
      res
    );

    expect(prisma.notification.createMany.mock.calls[0][0].data).toHaveLength(20);
    expect(res.json.mock.calls[0][0].message).toBe('Test notifications added');
  });
});

describe('notification service', () => {
  test('creates a notification', async () => {
    prisma.notification.create.mockResolvedValue({ id: 'notification-1' });

    await notificationService.notify('user-1', 'system', 'Title', 'Message', '/dashboard');

    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'user-1', read: false }),
    });
  });

  test('refreshes an existing matching notification', async () => {
    prisma.notification.findFirst.mockResolvedValue({ id: 'notification-1' });
    prisma.notification.update.mockResolvedValue({});

    await notificationService.notifyOrRefresh(
      'user-1',
      'payment',
      'Payment updated',
      'New state',
      '/payments'
    );

    expect(prisma.notification.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'notification-1' } })
    );
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('creates a notification when no matching item exists', async () => {
    prisma.notification.findFirst.mockResolvedValue(null);
    prisma.notification.create.mockResolvedValue({});

    await notificationService.notifyOrRefresh(
      'user-1',
      'payment',
      'Payment updated',
      'New state',
      '/payments'
    );

    expect(prisma.notification.create).toHaveBeenCalledOnce();
  });

  test('notifies every administrator', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'admin-1' }, { id: 'system-admin-1' }]);
    prisma.notification.createMany.mockResolvedValue({ count: 2 });

    await notificationService.notifyAdmin('system', 'Review required', 'Please review', '/admin');

    expect(prisma.notification.createMany.mock.calls[0][0].data).toHaveLength(2);
  });

  test('does nothing when no administrators exist', async () => {
    prisma.user.findMany.mockResolvedValue([]);

    await notificationService.notifyAdmin('system', 'Review required', 'Please review', '/admin');

    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });
});
