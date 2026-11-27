const prisma = {
  $transaction: vi.fn(),
  user: {
    count: vi.fn(),
    groupBy: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  tutorProfile: {
    count: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  booking: {
    count: vi.fn(),
    groupBy: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  payment: {
    aggregate: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  paymentRefund: { findUnique: vi.fn() },
  adminAction: {
    create: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  },
  subject: {
    create: vi.fn(),
    update: vi.fn(),
    findUnique: vi.fn(),
    delete: vi.fn(),
  },
};

const notify = vi.fn();
const notifyAdmin = vi.fn();
const getPayoutOverview = vi.fn();
const getPayoutRuns = vi.fn();
const processPayoutRun = vi.fn();
const submitRefund = vi.fn();
const serializeRefund = vi.fn((refund) => refund);

const databaseModulePath = require.resolve('../../src/config/database');
const notificationModulePath = require.resolve('../../src/services/notificationService');
const adminPayoutModulePath = require.resolve('../../src/services/adminPayoutService');
const refundModulePath = require.resolve('../../src/services/refundService');
const controllerModulePath = require.resolve('../../src/controllers/adminController');

for (const modulePath of [
  databaseModulePath,
  notificationModulePath,
  adminPayoutModulePath,
  refundModulePath,
  controllerModulePath,
]) {
  delete require.cache[modulePath];
}

require.cache[databaseModulePath] = {
  id: databaseModulePath,
  filename: databaseModulePath,
  loaded: true,
  exports: { prisma },
};

require.cache[notificationModulePath] = {
  id: notificationModulePath,
  filename: notificationModulePath,
  loaded: true,
  exports: { notify, notifyAdmin, notifyOrRefresh: vi.fn() },
};
require.cache[adminPayoutModulePath] = {
  id: adminPayoutModulePath,
  filename: adminPayoutModulePath,
  loaded: true,
  exports: { getPayoutOverview, getPayoutRuns, processPayoutRun },
};
require.cache[refundModulePath] = {
  id: refundModulePath,
  filename: refundModulePath,
  loaded: true,
  exports: {
    REFUND_SOURCES: { ADMIN_COMPLETION_DISPUTE: 'ADMIN_COMPLETION_DISPUTE' },
    createRefundClaim: vi.fn(),
    submitRefund,
    serializeRefund,
  },
};

const controller = require('../../src/controllers/adminController');

const makeResponse = () => {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
};

const adminRequest = (overrides = {}) => ({
  user: { id: 'admin-1', role: 'ADMIN' },
  params: {},
  query: {},
  body: {},
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('admin controller reporting', () => {
  test('builds the dashboard overview', async () => {
    prisma.user.count.mockResolvedValueOnce(12).mockResolvedValueOnce(3);
    prisma.tutorProfile.count.mockResolvedValueOnce(5).mockResolvedValueOnce(2);
    prisma.booking.count
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(6);
    prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 425.5 } });
    prisma.user.groupBy.mockResolvedValue([
      { role: 'LEARNER', _count: { role: 7 } },
      { role: 'TUTOR', _count: { role: 5 } },
    ]);
    prisma.booking.findMany.mockResolvedValue([{ id: 'booking-1' }]);
    const res = makeResponse();

    await controller.getDashboard(adminRequest(), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ totalUsers: 12, totalRevenue: 425.5 }),
      })
    );
  });

  test('builds analytics timelines and tutor revenue', async () => {
    const createdAt = new Date('2026-08-10T04:00:00.000Z');
    prisma.booking.groupBy
      .mockResolvedValueOnce([{ status: 'COMPLETED', _count: { status: 2 } }])
      .mockResolvedValueOnce([{ subject: 'Maths', _count: { subject: 3 } }]);
    prisma.user.findMany.mockResolvedValue([
      { role: 'LEARNER', createdAt },
      { role: 'TUTOR', createdAt },
    ]);
    prisma.tutorProfile.findMany.mockResolvedValue([
      { id: 'tutor-1', bookings: [{ totalAmount: '20.50' }, { totalAmount: null }] },
    ]);
    prisma.payment.findMany.mockResolvedValue([
      { amount: '9.50', createdAt },
      { amount: 10, createdAt },
    ]);
    const res = makeResponse();

    await controller.getAnalytics(adminRequest({ query: { period: '7' } }), res);

    const data = res.json.mock.calls[0][0].data;
    expect(data.bookingsByStatusMap).toEqual({ COMPLETED: 2 });
    expect(data.newUsersTimeline).toEqual([{ date: '2026-08-10', count: 2 }]);
    expect(data.topTutors[0].revenue).toBe(20.5);
    expect(data.revenueTimeline[0].revenue).toBe(19.5);
  });

  test('uses reporting defaults when no activity exists', async () => {
    prisma.user.count.mockResolvedValue(0);
    prisma.tutorProfile.count.mockResolvedValue(0);
    prisma.booking.count.mockResolvedValue(0);
    prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: null } });
    prisma.user.groupBy.mockResolvedValue([]);
    prisma.booking.findMany.mockResolvedValue([]);
    const dashboardRes = makeResponse();

    await controller.getDashboard(adminRequest(), dashboardRes);
    expect(dashboardRes.json.mock.calls[0][0].data.totalRevenue).toBe(0);

    prisma.booking.groupBy.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([]);
    prisma.tutorProfile.findMany.mockResolvedValue([]);
    prisma.payment.findMany.mockResolvedValue([]);
    const analyticsRes = makeResponse();
    await controller.getAnalytics(adminRequest({ query: {} }), analyticsRes);
    expect(analyticsRes.json.mock.calls[0][0].data.topTutors).toEqual([]);
  });

  test('lists filtered users with pagination', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'learner-1' }]);
    prisma.user.count.mockResolvedValue(21);
    const res = makeResponse();

    await controller.getUsers(
      adminRequest({
        query: { role: 'LEARNER', status: 'ACTIVE', search: '  lee  ', page: '2', limit: '10' },
      }),
      res
    );

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 10 })
    );
    expect(res.json.mock.calls[0][0].data.pagination).toEqual({
      page: 2,
      limit: 10,
      total: 21,
      totalPages: 3,
    });
  });

  test('lists users without optional filters', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.count.mockResolvedValue(0);

    await controller.getUsers(adminRequest(), makeResponse());

    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({});
  });

  test('returns a user without exposing their password', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'learner-1',
      email: 'lee@example.com',
      password: 'secret-hash',
    });
    const res = makeResponse();

    await controller.getUser(adminRequest({ params: { id: 'learner-1' } }), res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { id: 'learner-1', email: 'lee@example.com' },
    });
  });

  test('rejects a missing user', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      controller.getUser(adminRequest({ params: { id: 'missing' } }), makeResponse())
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('admin controller moderation', () => {
  test('updates a regular user status and records the action', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'learner-1',
      role: 'LEARNER',
      status: 'ACTIVE',
    });
    prisma.user.update.mockResolvedValue({});
    prisma.adminAction.create.mockResolvedValue({ id: 'action-1' });
    const res = makeResponse();

    await controller.updateUserStatus(
      adminRequest({
        params: { id: 'learner-1' },
        body: { status: 'SUSPENDED', reason: 'Repeated abuse' },
      }),
      res
    );

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'learner-1' },
      data: { status: 'SUSPENDED' },
    });
    expect(notify).toHaveBeenCalledOnce();
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: 'User status updated to SUSPENDED',
    });
  });

  test('uses a default description for a status change', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'learner-1',
      role: 'LEARNER',
      status: 'SUSPENDED',
    });
    prisma.user.update.mockResolvedValue({});
    prisma.adminAction.create.mockResolvedValue({});

    await controller.updateUserStatus(
      adminRequest({ params: { id: 'learner-1' }, body: { status: 'ACTIVE' } }),
      makeResponse()
    );

    expect(prisma.adminAction.create.mock.calls[0][0].data.description).toBe(
      'Status changed to ACTIVE'
    );
  });

  test.each([
    [{ status: 'UNKNOWN' }, null, 400],
    [{ status: 'ACTIVE' }, null, 404],
    [{ status: 'ACTIVE' }, { id: 'system-1', role: 'SYSTEM_ADMIN', status: 'ACTIVE' }, 403],
  ])('rejects unsafe status changes', async (body, target, statusCode) => {
    prisma.user.findUnique.mockResolvedValue(target);

    await expect(
      controller.updateUserStatus(
        adminRequest({ params: { id: 'target-1' }, body }),
        makeResponse()
      )
    ).rejects.toMatchObject({ statusCode });
  });

  test('lists submitted tutor applications', async () => {
    prisma.tutorProfile.findMany.mockResolvedValue([{ id: 'tutor-1' }]);
    prisma.tutorProfile.count.mockResolvedValue(1);
    const res = makeResponse();

    await controller.getPendingTutors(
      adminRequest({ query: { status: '', page: 'bad', limit: '0' } }),
      res
    );

    expect(res.json.mock.calls[0][0].data.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 1,
      totalPages: 1,
    });
  });

  test.each([
    ['approveTutor', {}, 'Tutor approved successfully'],
    ['rejectTutor', { reason: 'Insufficient evidence' }, 'Tutor profile rejected'],
    ['returnTutor', { feedback: ' Please upload a clearer certificate. ' }, 'Profile returned to tutor for changes'],
  ])('handles %s', async (method, body, message) => {
    prisma.tutorProfile.findFirst.mockResolvedValue({
      id: 'tutor-profile-1',
      userId: 'tutor-user-1',
      status: 'PENDING',
    });
    prisma.tutorProfile.update.mockResolvedValue({});
    prisma.adminAction.create.mockResolvedValue({});
    const res = makeResponse();

    await controller[method](
      adminRequest({ params: { id: 'tutor-profile-1' }, body }),
      res
    );

    expect(notify).toHaveBeenCalledOnce();
    expect(res.json).toHaveBeenCalledWith({ success: true, message });
  });

  test('requires feedback before returning an application', async () => {
    await expect(
      controller.returnTutor(adminRequest({ body: { feedback: ' ' } }), makeResponse())
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test.each(['approveTutor', 'rejectTutor', 'returnTutor'])(
    '%s rejects an unknown tutor',
    async (method) => {
      prisma.tutorProfile.findFirst.mockResolvedValue(null);
      const body = method === 'returnTutor' ? { feedback: 'Needs changes' } : {};

      await expect(
        controller[method](adminRequest({ params: { id: 'missing' }, body }), makeResponse())
      ).rejects.toMatchObject({ statusCode: 404 });
    }
  );
});

describe('admin controller lists and subjects', () => {
  test('lists bookings and serializes an absent payment', async () => {
    prisma.booking.findMany.mockResolvedValue([{ id: 'booking-1', payment: null }]);
    prisma.booking.count.mockResolvedValue(1);
    const res = makeResponse();

    await controller.getBookings(
      adminRequest({ query: { status: 'PENDING', page: '1', limit: '5' } }),
      res
    );

    expect(res.json.mock.calls[0][0].data.bookings).toEqual([
      { id: 'booking-1', payment: null },
    ]);
  });

  test('lists bookings with default filters and pagination', async () => {
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.booking.count.mockResolvedValue(0);

    await controller.getBookings(adminRequest(), makeResponse());

    expect(prisma.booking.findMany.mock.calls[0][0]).toEqual(
      expect.objectContaining({ where: {}, skip: 0, take: 20 })
    );
  });

  test('wraps payout reports and both payout-run outcomes', async () => {
    getPayoutOverview.mockResolvedValue({ readyGroups: [] });
    getPayoutRuns.mockResolvedValue({ runs: [] });
    const overviewRes = makeResponse();
    await controller.getPayoutOverview(adminRequest(), overviewRes);
    expect(overviewRes.json.mock.calls[0][0].data.readyGroups).toEqual([]);

    const runsRes = makeResponse();
    await controller.getPayoutRuns(
      adminRequest({ query: { page: '2', limit: '5' } }),
      runsRes
    );
    expect(getPayoutRuns).toHaveBeenCalledWith({ page: '2', limit: '5' });

    processPayoutRun.mockResolvedValueOnce({ status: 'COMPLETED' });
    const completedRes = makeResponse();
    await controller.processPayoutRun(adminRequest(), completedRes);
    expect(completedRes.json.mock.calls[0][0].message).toContain('All eligible');

    processPayoutRun.mockResolvedValueOnce({ status: 'NEEDS_ATTENTION' });
    const attentionRes = makeResponse();
    await controller.processPayoutRun(adminRequest(), attentionRes);
    expect(attentionRes.json.mock.calls[0][0].message).toContain('need attention');

    processPayoutRun.mockResolvedValueOnce({ status: 'COMPLETED' });
    const tutorCompletedRes = makeResponse();
    await controller.processTutorPayoutRun(
      adminRequest({ params: { tutorProfileId: 'tutor-profile-1' } }),
      tutorCompletedRes
    );
    expect(processPayoutRun).toHaveBeenLastCalledWith(
      expect.any(Object),
      { tutorProfileId: 'tutor-profile-1' }
    );

    processPayoutRun.mockResolvedValueOnce({ status: 'FAILED' });
    const tutorFailedRes = makeResponse();
    await controller.processTutorPayoutRun(
      adminRequest({ params: { tutorProfileId: 'tutor-profile-1' } }),
      tutorFailedRes
    );
    expect(tutorFailedRes.json.mock.calls[0][0].message).toContain('need attention');
  });

  test.each([
    ['SUCCEEDED', 200, 'confirmed'],
    ['FAILED', 202, 'failed'],
    ['PROCESSING', 202, 'processing'],
  ])('retries a %s completion refund', async (status, responseStatus, message) => {
    const refund = {
      id: 'refund-1',
      status: 'FAILED',
      payment: { bookingId: 'booking-1', booking: { learnerId: 'learner-1' } },
    };
    prisma.paymentRefund.findUnique.mockResolvedValue(refund);
    submitRefund.mockResolvedValue({ ...refund, status });
    prisma.adminAction.create.mockResolvedValue({});
    const res = makeResponse();

    await controller.retryCompletionRefund(
      adminRequest({ params: { refundId: 'refund-1' } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(responseStatus);
    expect(res.json.mock.calls[0][0].message).toContain(message);
  });

  test.each([
    [null, 404],
    [{ id: 'refund-1', status: 'SUCCEEDED' }, 409],
  ])('rejects a refund that cannot be retried', async (refund, statusCode) => {
    prisma.paymentRefund.findUnique.mockResolvedValue(refund);
    await expect(
      controller.retryCompletionRefund(
        adminRequest({ params: { refundId: 'refund-1' } }),
        makeResponse()
      )
    ).rejects.toMatchObject({ statusCode });
  });

  test('lists audit actions with pagination', async () => {
    prisma.adminAction.findMany.mockResolvedValue([{ id: 'action-1' }]);
    prisma.adminAction.count.mockResolvedValue(6);
    const res = makeResponse();

    await controller.getAdminActions(adminRequest({ query: { page: '2', limit: '5' } }), res);

    expect(res.json.mock.calls[0][0].data.pagination).toEqual({
      page: 2,
      limit: 5,
      total: 6,
      totalPages: 2,
    });
  });

  test('creates, updates, and deletes subjects', async () => {
    prisma.subject.create.mockResolvedValue({ id: 'subject-1', name: 'Astronomy' });
    prisma.subject.update.mockResolvedValue({ id: 'subject-1', name: 'Space Science' });
    prisma.subject.findUnique.mockResolvedValue({ id: 'subject-1', name: 'Space Science' });
    prisma.subject.delete.mockResolvedValue({});
    prisma.adminAction.create.mockResolvedValue({});

    const createRes = makeResponse();
    await controller.createSubject(
      adminRequest({ body: { name: 'Astronomy', category: 'Science', description: 'Stars' } }),
      createRes
    );
    expect(createRes.status).toHaveBeenCalledWith(201);

    const updateRes = makeResponse();
    await controller.updateSubject(
      adminRequest({
        params: { id: 'subject-1' },
        body: { name: 'Space Science', category: 'Science', description: '' },
      }),
      updateRes
    );
    expect(updateRes.json.mock.calls[0][0].data.name).toBe('Space Science');

    prisma.subject.update.mockResolvedValue({ id: 'subject-1', name: 'Space Science' });
    await controller.updateSubject(
      adminRequest({ params: { id: 'subject-1' }, body: {} }),
      makeResponse()
    );
    expect(prisma.subject.update).toHaveBeenLastCalledWith({
      where: { id: 'subject-1' },
      data: {},
    });

    const deleteRes = makeResponse();
    await controller.deleteSubject(
      adminRequest({ params: { id: 'subject-1' } }),
      deleteRes
    );
    expect(deleteRes.json).toHaveBeenCalledWith({ success: true, message: 'Subject deleted' });
  });

  test('does not delete an unknown subject', async () => {
    prisma.subject.findUnique.mockResolvedValue(null);

    await expect(
      controller.deleteSubject(adminRequest({ params: { id: 'missing' } }), makeResponse())
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('admin completion dispute clearing', () => {
  const disputedBooking = (overrides = {}) => ({
    id: 'booking-1',
    learnerId: 'learner-1',
    tutorId: 'tutor-1',
    subject: 'Maths',
    status: 'COMPLETED',
    version: 3,
    completionReviewStatus: 'DISPUTED',
    isTrialLesson: false,
    payment: { id: 'payment-1', tutorPayoutAmount: 40 },
    learner: { id: 'learner-1' },
    tutorProfile: { user: { id: 'tutor-user-1' } },
    ...overrides,
  });

  test.each([
    [{ body: { expectedVersion: 3, note: ' ' } }, null, 400],
    [{ body: { expectedVersion: 3, note: 'Resolved' } }, null, 404],
    [
      { body: { expectedVersion: 3, note: 'Resolved' } },
      disputedBooking({ completionReviewStatus: 'CLEARED' }),
      409,
    ],
    [
      { body: { expectedVersion: 2, note: 'Resolved' } },
      disputedBooking(),
      409,
    ],
  ])('rejects an invalid dispute-clear request', async (request, booking, statusCode) => {
    prisma.booking.findUnique.mockResolvedValue(booking);

    await expect(
      controller.clearCompletionDispute(
        adminRequest({ params: { id: 'booking-1' }, ...request }),
        makeResponse()
      )
    ).rejects.toMatchObject({ statusCode });
  });

  test('rejects a dispute that changes during the transaction', async () => {
    prisma.booking.findUnique.mockResolvedValue(disputedBooking());
    prisma.booking.updateMany.mockResolvedValue({ count: 0 });
    prisma.$transaction.mockImplementation((callback) => callback(prisma));

    await expect(
      controller.clearCompletionDispute(
        adminRequest({
          params: { id: 'booking-1' },
          body: { expectedVersion: 3, note: 'Resolved' },
        }),
        makeResponse()
      )
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test('rejects an earning that changes during the transaction', async () => {
    prisma.booking.findUnique.mockResolvedValue(disputedBooking());
    prisma.booking.updateMany.mockResolvedValue({ count: 1 });
    prisma.payment.updateMany.mockResolvedValue({ count: 0 });
    prisma.$transaction.mockImplementation((callback) => callback(prisma));

    await expect(
      controller.clearCompletionDispute(
        adminRequest({
          params: { id: 'booking-1' },
          body: { expectedVersion: 3, note: 'Resolved' },
        }),
        makeResponse()
      )
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test.each([
    [false, { id: 'payment-1', tutorPayoutAmount: 40 }, 'approved for payout'],
    [true, null, 'No earning or payout'],
  ])('clears paid and trial disputes', async (isTrialLesson, payment, message) => {
    prisma.booking.findUnique.mockResolvedValue(disputedBooking({ isTrialLesson, payment }));
    prisma.booking.updateMany.mockResolvedValue({ count: 1 });
    prisma.payment.updateMany.mockResolvedValue({ count: 1 });
    prisma.adminAction.create.mockResolvedValue({});
    prisma.$transaction.mockImplementation((callback) => callback(prisma));
    const res = makeResponse();

    await controller.clearCompletionDispute(
      adminRequest({
        params: { id: 'booking-1' },
        body: { expectedVersion: 3, note: ' Resolved fairly ' },
      }),
      res
    );

    expect(res.json.mock.calls[0][0].message).toContain(message);
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
