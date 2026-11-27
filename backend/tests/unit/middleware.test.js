const {
  AppError,
  ValidationError,
  notFound,
  errorHandler,
} = require('../../src/middleware/errorHandler');
const {
  authorize,
  authorizeOwner,
  authorizeActiveUser,
  authorizeActiveTutor,
} = require('../../src/middleware/rbac');

const makeResponse = () => {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
};

describe('error middleware', () => {
  test('creates structured application and validation errors', () => {
    const error = new AppError('Try another action', 409, {
      code: 'CONFLICT',
      action: 'retry',
      link: '/help',
    });
    expect(error).toMatchObject({
      statusCode: 409,
      isOperational: true,
      errorCode: 'CONFLICT',
      action: 'retry',
      link: '/help',
    });

    const validation = new ValidationError([{ field: 'email' }]);
    expect(validation).toMatchObject({ statusCode: 400, errors: [{ field: 'email' }] });
  });

  test('turns an unmatched request into a 404 error', () => {
    const next = vi.fn();
    notFound({ method: 'GET', originalUrl: '/missing' }, null, next);
    expect(next.mock.calls[0][0]).toMatchObject({
      statusCode: 404,
      message: 'Route not found: GET /missing',
    });
  });

  test.each([
    [{ code: 'P2002', meta: { target: ['email'] } }, 409, 'email'],
    [{ code: 'P2002' }, 409, 'field'],
    [{ code: 'P2025' }, 404, 'Record not found'],
    [{ code: 'P2003' }, 400, 'Referenced record not found'],
  ])('maps database errors to safe responses', (error, status, message) => {
    const res = makeResponse();
    errorHandler(error, {}, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.json.mock.calls[0][0].message).toContain(message);
  });

  test('includes operational metadata and a development stack', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const error = new ValidationError([{ field: 'name' }]);
    error.errorCode = 'INVALID';
    error.action = 'edit';
    error.link = '/form';
    error.statusCode = 500;
    const res = makeResponse();

    errorHandler(error, {}, res, vi.fn());

    expect(res.json.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        code: 'INVALID',
        action: 'edit',
        link: '/form',
        errors: [{ field: 'name' }],
        stack: expect.any(String),
      })
    );
    process.env.NODE_ENV = previousNodeEnv;
  });

  test('uses safe defaults for an empty error', () => {
    const res = makeResponse();
    errorHandler({}, {}, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json.mock.calls[0][0].message).toBe('Internal Server Error');
  });
});

describe('role-based access middleware', () => {
  test('authorizes an allowed role and every system administrator', () => {
    const next = vi.fn();
    authorize('ADMIN')({ user: { role: 'ADMIN' } }, {}, next);
    authorize('LEARNER')({ user: { role: 'SYSTEM_ADMIN' } }, {}, next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  test.each([
    [undefined, 401],
    [{ role: 'LEARNER' }, 403],
  ])('rejects unauthorized roles', (user, statusCode) => {
    expect(() => authorize('ADMIN')({ user }, {}, vi.fn())).toThrow(
      expect.objectContaining({ statusCode })
    );
  });

  test('authorizes owners by route or body parameter and elevated roles', () => {
    const next = vi.fn();
    authorizeOwner()(
      { user: { id: 'user-1', role: 'LEARNER' }, params: { userId: 'user-1' }, body: {} },
      {},
      next
    );
    authorizeOwner('ownerId')(
      { user: { id: 'user-1', role: 'LEARNER' }, params: {}, body: { ownerId: 'user-1' } },
      {},
      next
    );
    authorizeOwner()(
      { user: { id: 'admin-1', role: 'ADMIN' }, params: { userId: 'other' }, body: {} },
      {},
      next
    );
    expect(next).toHaveBeenCalledTimes(3);
  });

  test.each([
    [{ user: undefined, params: {}, body: {} }, 401],
    [
      {
        user: { id: 'user-1', role: 'LEARNER' },
        params: { userId: 'other' },
        body: {},
      },
      403,
    ],
  ])('rejects invalid owner access', (req, statusCode) => {
    expect(() => authorizeOwner()(req, {}, vi.fn())).toThrow(
      expect.objectContaining({ statusCode })
    );
  });

  test('requires an active user', () => {
    const next = vi.fn();
    authorizeActiveUser({ user: { status: 'active' } }, {}, next);
    expect(next).toHaveBeenCalledOnce();
    expect(() => authorizeActiveUser({}, {}, vi.fn())).toThrow(
      expect.objectContaining({ statusCode: 401 })
    );
    expect(() =>
      authorizeActiveUser({ user: { status: 'SUSPENDED' } }, {}, vi.fn())
    ).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  test('requires an active approved tutor', () => {
    const next = vi.fn();
    authorizeActiveTutor(
      {
        user: {
          role: 'TUTOR',
          status: 'ACTIVE',
          tutorProfile: { status: 'active' },
        },
      },
      {},
      next
    );
    expect(next).toHaveBeenCalledOnce();

    for (const req of [
      {},
      { user: { role: 'LEARNER', status: 'ACTIVE' } },
      { user: { role: 'TUTOR', status: 'SUSPENDED' } },
      { user: { role: 'TUTOR', status: 'ACTIVE' } },
    ]) {
      expect(() => authorizeActiveTutor(req, {}, vi.fn())).toThrow(
        expect.objectContaining({ statusCode: expect.any(Number) })
      );
    }
  });
});
