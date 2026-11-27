const request = require('supertest');

const learner = { id: 'fake-test-learner', email: 'learner@example.test', role: 'LEARNER', status: 'ACTIVE' };
const objects = new Map();
const prisma = {
  user: {
    findUnique: vi.fn(async () => learner),
    update: vi.fn(async ({ data }) => Object.assign(learner, data)),
  },
  fakePaymentObject: {
    create: async ({ data }) => { objects.set(data.id, structuredClone(data)); return data; },
    findUnique: async ({ where }) => objects.get(where.id) || null,
    findMany: async ({ where }) => [...objects.values()].filter((record) => record.kind === where.kind),
  },
};
const databasePath = require.resolve('../../src/config/database');
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: { prisma } };
// Stripe is an external boundary. A mistaken call fails immediately here,
// without contacting any real or sandbox payment service.
const stripePath = require.resolve('stripe');
require.cache[stripePath] = {
  id: stripePath, filename: stripePath, loaded: true,
  exports: class StripeBoundary {
    constructor() {
      this.setupIntents = { create: async () => { throw new Error('Real provider received a simulated reference'); } };
    }
  },
};
const app = require('../../src/app');
const { createAccessToken } = require('../../src/utils/tokens');

afterEach(() => {
  delete process.env.PAYMENT_PROVIDER;
  delete process.env.APP_ENV;
  vi.unstubAllEnvs();
});

test('a learner can save and retrieve a clearly marked fake payment method without Stripe keys', async () => {
  process.env.PAYMENT_PROVIDER = 'fake';
  process.env.APP_ENV = 'local';
  const auth = `Bearer ${createAccessToken(learner)}`;
  const setup = await request(app).post('/api/v1/payments/setup-intent').set('Authorization', auth);
  expect(setup.status).toBe(200);
  expect(setup.body.data.isTestPayment).toBe(true);
  const saved = await request(app).post('/api/v1/payments/complete-setup-intent')
    .set('Authorization', auth).send({ setupIntentId: setup.body.data.setupIntentId });
  expect(saved.status).toBe(200);
  expect(saved.body.data.paymentMethod).toMatchObject({ brand: 'fake', isTestPayment: true });
  const method = await request(app).get('/api/v1/payments/method').set('Authorization', auth);
  expect(method.body.data).toMatchObject({ hasPaymentMethod: true, paymentMethod: { brand: 'fake', isTestPayment: true } });
});

test('payment configuration keeps simulation disabled by default', async () => {
  const response = await request(app).get('/api/v1/payments/config')
    .set('Authorization', `Bearer ${createAccessToken(learner)}`);
  expect(response.status).toBe(200);
  expect(response.body.data).toEqual({ provider: 'stripe', isTestPayment: false });
});

test.each([
  ['local', 200],
  ['test', 200],
  ['production', 503],
  ['', 503],
])('fake payments require an explicitly enabled local/test environment (%s)', async (environment, status) => {
  process.env.PAYMENT_PROVIDER = 'fake';
  process.env.APP_ENV = environment;
  const response = await request(app).get('/api/v1/payments/config')
    .set('Authorization', `Bearer ${createAccessToken(learner)}`);
  expect(response.status).toBe(status);
  if (status === 200) expect(response.body.data).toEqual({ provider: 'fake', isTestPayment: true });
  else expect(response.body.code).toBe('FAKE_PAYMENT_DISABLED');
});

test('switching back to Stripe refuses a fake customer before invoking the real provider', async () => {
  process.env.PAYMENT_PROVIDER = 'fake';
  process.env.APP_ENV = 'local';
  const auth = `Bearer ${createAccessToken(learner)}`;
  await request(app).post('/api/v1/payments/setup-intent').set('Authorization', auth).expect(200);
  process.env.PAYMENT_PROVIDER = 'stripe';
  vi.stubEnv('STRIPE_SECRET_KEY', 'not-a-real-key');
  const response = await request(app).post('/api/v1/payments/setup-intent').set('Authorization', auth);
  expect(response.status).toBe(409);
  expect(response.body.code).toBe('PAYMENT_ENVIRONMENT_MISMATCH');
});
