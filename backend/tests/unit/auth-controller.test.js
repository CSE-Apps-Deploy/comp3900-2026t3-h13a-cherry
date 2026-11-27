const prisma = {
  user: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
};

const sendVerificationEmail = vi.fn();
const hashPassword = vi.fn(() => 'hashed-password');
const comparePassword = vi.fn(() => true);
const passwordNeedsRehash = vi.fn(() => false);
const { isValidNewPassword } = require('../../src/utils/passwords');
const createAccessToken = vi.fn(() => 'access-token');
const createRefreshToken = vi.fn(() => 'refresh-token');
const verifyRefreshToken = vi.fn(() => ({ id: 'user-1' }));

const databaseModulePath = require.resolve('../../src/config/database');
const emailModulePath = require.resolve('../../src/services/emailService');
const passwordModulePath = require.resolve('../../src/utils/passwords');
const tokenModulePath = require.resolve('../../src/utils/tokens');
const controllerModulePath = require.resolve('../../src/controllers/authController');

for (const modulePath of [
  databaseModulePath,
  emailModulePath,
  passwordModulePath,
  tokenModulePath,
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
require.cache[emailModulePath] = {
  id: emailModulePath,
  filename: emailModulePath,
  loaded: true,
  exports: { sendVerificationEmail },
};
require.cache[passwordModulePath] = {
  id: passwordModulePath,
  filename: passwordModulePath,
  loaded: true,
  exports: { hashPassword, comparePassword, passwordNeedsRehash, isValidNewPassword },
};
require.cache[tokenModulePath] = {
  id: tokenModulePath,
  filename: tokenModulePath,
  loaded: true,
  exports: { createAccessToken, createRefreshToken, verifyRefreshToken },
};

const controller = require('../../src/controllers/authController');

const makeResponse = () => {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
};

const makeRequest = (overrides = {}) => ({
  body: {},
  query: {},
  headers: {},
  socket: {},
  ...overrides,
});

const user = (overrides = {}) => ({
  id: 'user-1',
  email: 'learner@example.com',
  password: 'stored-hash',
  firstName: 'Lee',
  lastName: 'Learner',
  timezone: 'UTC',
  role: 'LEARNER',
  status: 'ACTIVE',
  isEmailVerified: true,
  tutorProfile: null,
  ...overrides,
});

const validRegistration = {
  email: ' NewUser@example.com ',
  password: 'Secure1!',
  firstName: ' New ',
  lastName: ' User ',
  role: 'LEARNER',
};

beforeEach(() => {
  vi.clearAllMocks();
  comparePassword.mockReturnValue(true);
  passwordNeedsRehash.mockReturnValue(false);
  verifyRefreshToken.mockReturnValue({ id: 'user-1' });
  sendVerificationEmail.mockResolvedValue({ deliveryMethod: 'log' });
  delete process.env.EMAIL_VERIFICATION_REQUIRED;
});

describe('auth registration branches', () => {
  test.each([
    [{}, 400],
    [{ ...validRegistration, role: 'ADMIN' }, 400],
    [{ ...validRegistration, isMinor: 'true' }, 400],
  ])('rejects invalid registration input', async (body, status) => {
    const res = makeResponse();

    await controller.register(makeRequest({ body }), res);

    expect(res.status).toHaveBeenCalledWith(status);
  });

  test('rejects an existing account', async () => {
    prisma.user.findUnique.mockResolvedValue(user());
    const res = makeResponse();

    await controller.register(makeRequest({ body: validRegistration }), res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  test('registers an adult learner and exposes local verification links', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue(user({
      id: 'new-user',
      email: 'newuser@example.com',
      isEmailVerified: false,
    }));
    sendVerificationEmail.mockResolvedValue({
      deliveryMethod: 'smtp',
      mailboxUrl: 'http://localhost:8025',
      verificationUrl: 'http://localhost:8080/verify-email?token=abc',
    });
    const res = makeResponse();

    await controller.register(
      makeRequest({
        body: {
          ...validRegistration,
          isMinor: false,
          parentName: '',
          parentEmail: '',
          parentPhone: '',
        },
      }),
      res
    );

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: 'newuser@example.com', role: 'LEARNER' }),
      })
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json.mock.calls[0][0].verificationMailboxUrl).toBe('http://localhost:8025');
  });

  test('registers a tutor with a pending application profile', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue(
      user({
        role: 'TUTOR',
        isEmailVerified: false,
        tutorProfile: {
          id: 'tutor-profile-1',
          status: 'SUSPENDED',
          applicationSubmitted: false,
          isVerified: false,
        },
      })
    );
    const res = makeResponse();

    await controller.register(
      makeRequest({ body: { ...validRegistration, role: 'tutor' } }),
      res
    );

    expect(prisma.user.create.mock.calls[0][0].data.tutorProfile).toBeDefined();
    expect(res.json.mock.calls[0][0].message).toContain('complete tutor verification');
  });
});

describe('auth login and token branches', () => {
  test('requires login credentials', async () => {
    const res = makeResponse();

    await controller.login(makeRequest({ body: { email: 'learner@example.com' } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  test.each([
    [null, true],
    [user(), false],
  ])('rejects invalid credentials', async (record, matches) => {
    prisma.user.findUnique.mockResolvedValue(record);
    comparePassword.mockReturnValue(matches);
    const res = makeResponse();

    await controller.login(
      makeRequest({ body: { email: 'learner@example.com', password: 'wrong' } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('blocks an unverified account when verification is required', async () => {
    prisma.user.findUnique.mockResolvedValue(user({ isEmailVerified: false }));
    const res = makeResponse();

    await controller.login(
      makeRequest({ body: { email: 'learner@example.com', password: 'Secure1!' } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('logs in, rehashes an old password, and normalizes an IPv6-mapped address', async () => {
    process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
    prisma.user.findUnique.mockResolvedValue(user({ isEmailVerified: false }));
    prisma.user.update.mockResolvedValue(user({ isEmailVerified: false }));
    passwordNeedsRehash.mockReturnValue(true);
    const res = makeResponse();

    await controller.login(
      makeRequest({
        body: { email: 'learner@example.com', password: 'Secure1!' },
        headers: { 'x-forwarded-for': ['::ffff:203.0.113.4, 10.0.0.1'] },
      }),
      res
    );

    expect(prisma.user.update.mock.calls[0][0].data.password).toBe('hashed-password');
    expect(res.json.mock.calls[0][0].user.ipAddress).toBe('203.0.113.4');
  });

  test('normalizes localhost when logging in', async () => {
    prisma.user.findUnique.mockResolvedValue(user());
    prisma.user.update.mockResolvedValue(user());
    const res = makeResponse();

    await controller.login(
      makeRequest({
        body: { email: 'learner@example.com', password: 'Secure1!' },
        headers: { 'x-real-ip': '::1' },
      }),
      res
    );

    expect(res.json.mock.calls[0][0].user.ipAddress).toBe('127.0.0.1');
  });

  test('requires a refresh token', async () => {
    const res = makeResponse();
    await controller.refreshToken(makeRequest(), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects an invalid refresh token', async () => {
    verifyRefreshToken.mockImplementation(() => {
      throw new Error('bad token');
    });
    const res = makeResponse();

    await controller.refreshToken(makeRequest({ body: { refreshToken: 'bad' } }), res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('rejects a refresh token for a deleted user', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const res = makeResponse();

    await controller.refreshToken(makeRequest({ body: { refreshToken: 'valid' } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('refreshes an access token and supports logout', async () => {
    prisma.user.findUnique.mockResolvedValue(user());
    const refreshRes = makeResponse();
    await controller.refreshToken(makeRequest({ body: { refreshToken: 'valid' } }), refreshRes);
    expect(refreshRes.json.mock.calls[0][0].accessToken).toBe('access-token');

    const logoutRes = makeResponse();
    await controller.logout(makeRequest(), logoutRes);
    expect(logoutRes.status).toHaveBeenCalledWith(200);
  });
});

describe('email verification and current user branches', () => {
  test('requires a verification token', async () => {
    const res = makeResponse();
    await controller.verifyEmail(makeRequest(), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects an unknown verification token', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const res = makeResponse();
    await controller.verifyEmail(makeRequest({ query: { token: 'unknown' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('accepts an already-used verification token', async () => {
    prisma.user.findUnique.mockResolvedValue(
      user({ isEmailVerified: true, emailVerificationExpiry: new Date(Date.now() + 60_000) })
    );
    const res = makeResponse();
    await controller.verifyEmail(makeRequest({ body: { token: 'used' } }), res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test.each([null, new Date(Date.now() - 60_000)])(
    'rejects an expired verification token',
    async (emailVerificationExpiry) => {
      prisma.user.findUnique.mockResolvedValue(
        user({ isEmailVerified: false, emailVerificationExpiry })
      );
      const res = makeResponse();
      await controller.verifyEmail(makeRequest({ query: { token: 'expired' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
  );

  test('verifies a valid token', async () => {
    prisma.user.findUnique.mockResolvedValue(
      user({ isEmailVerified: false, emailVerificationExpiry: new Date(Date.now() + 60_000) })
    );
    prisma.user.update.mockResolvedValue({});
    const res = makeResponse();
    await controller.verifyEmail(makeRequest({ query: { token: 'valid' } }), res);
    expect(prisma.user.update).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test.each([
    ['', null, 400],
    ['missing@example.com', null, 404],
    ['verified@example.com', user({ isEmailVerified: true }), 400],
  ])('rejects invalid resend requests', async (email, record, status) => {
    prisma.user.findUnique.mockResolvedValue(record);
    const res = makeResponse();
    await controller.resendVerification(makeRequest({ body: { email } }), res);
    expect(res.status).toHaveBeenCalledWith(status);
  });

  test('resends verification and includes optional development links', async () => {
    prisma.user.findUnique.mockResolvedValue(user({ isEmailVerified: false }));
    prisma.user.update.mockResolvedValue({});
    sendVerificationEmail.mockResolvedValue({
      deliveryMethod: 'smtp',
      mailboxUrl: 'http://localhost:8025',
      verificationUrl: 'http://localhost:8080/verify-email?token=new',
    });
    const res = makeResponse();

    await controller.resendVerification(
      makeRequest({ body: { email: ' Learner@example.com ' } }),
      res
    );

    expect(res.json.mock.calls[0][0]).toEqual(
      expect.objectContaining({ verificationDelivery: 'smtp' })
    );
  });

  test('requires authentication for the current user', async () => {
    const res = makeResponse();
    await controller.getMe(makeRequest(), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('returns 404 when the current user disappeared', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const res = makeResponse();
    await controller.getMe(makeRequest({ user: { id: 'missing' } }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('returns the current user and ignores an unknown IP', async () => {
    prisma.user.findUnique.mockResolvedValue(user());
    const res = makeResponse();
    await controller.getMe(
      makeRequest({ user: { id: 'user-1' }, ip: 'unknown' }),
      res
    );
    expect(res.json.mock.calls[0][0].user.ipAddress).toBeNull();
  });
});
