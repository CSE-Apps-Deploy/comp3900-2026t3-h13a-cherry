const { randomUUID } = require('node:crypto');
const { prisma } = require('../config/database');
const { AppError } = require('../middleware/errorHandler');

const assertFakeReference = (id) => {
  if (!String(id || '').startsWith('fake_')) {
    throw new AppError('Use a separate test account for Fake Payment; real payment references cannot be used.', 409, {
      code: 'PAYMENT_ENVIRONMENT_MISMATCH',
    });
  }
};

const createObject = async (kind, prefix, data, options = {}) => {
  const object = { ...data, id: `fake_${prefix}_${randomUUID()}`, livemode: false, isTestPayment: true };
  const record = { id: object.id, kind, data: object };
  if (options.idempotencyKey) {
    record.idempotencyKey = `${kind}:${options.idempotencyKey}`;
    const saved = await prisma.fakePaymentObject.upsert({ where: { idempotencyKey: record.idempotencyKey }, create: record, update: {} });
    return saved.data;
  }
  await prisma.fakePaymentObject.create({ data: record });
  return object;
};

const retrieveObject = async (id, kind) => {
  assertFakeReference(id);
  const record = await prisma.fakePaymentObject.findUnique({ where: { id } });
  if (!record || record.kind !== kind) throw new AppError('Simulated payment object not found.', 404);
  return record.data;
};

const listObjects = async (kind, filter) => {
  const records = await prisma.fakePaymentObject.findMany({ where: { kind } });
  return { data: records.map((record) => record.data).filter(filter), has_more: false };
};

// This adapter has no network client. State is persisted so normal application
// reloads keep the same simulated payment references and ownership checks.
const fakePaymentProvider = {
  accounts: {
    create: (data, options) => createObject('account', 'acct', {
      ...data, details_submitted: true, charges_enabled: true, payouts_enabled: true,
      capabilities: { transfers: 'active' }, requirements: {}, default_currency: 'aud',
    }, options),
    retrieve: (id) => retrieveObject(id, 'account'),
  },
  accountLinks: {
    create: async (data) => {
      await retrieveObject(data.account, 'account');
      return { url: data.return_url, expires_at: Math.floor(Date.now() / 1000) + 300 };
    },
  },
  customers: { create: (data) => createObject('customer', 'cus', data) },
  setupIntents: {
    create: async (data) => {
      await retrieveObject(data.customer, 'customer');
      const method = await createObject('payment_method', 'pm', {
        customer: data.customer,
        type: 'card',
        card: { brand: 'fake', last4: '0000', exp_month: 12, exp_year: 2099 },
      });
      return createObject('setup_intent', 'seti', {
        ...data, status: 'succeeded', payment_method: method.id, client_secret: null,
      });
    },
    retrieve: (id) => retrieveObject(id, 'setup_intent'),
  },
  paymentMethods: {
    retrieve: (id) => retrieveObject(id, 'payment_method'),
    list: ({ customer }) => {
      assertFakeReference(customer);
      return listObjects('payment_method', (method) => method.customer === customer);
    },
  },
  paymentIntents: {
    create: async (data, options) => {
      await retrieveObject(data.customer, 'customer');
      const method = await retrieveObject(data.payment_method, 'payment_method');
      if (method.customer !== data.customer) throw new AppError('Simulated payment method does not belong to this customer.', 409);
      return createObject('payment_intent', 'pi', { ...data, status: 'succeeded', amount_received: data.amount }, options);
    },
    retrieve: (id) => retrieveObject(id, 'payment_intent'),
  },
  refunds: {
    list: ({ payment_intent }) => {
      assertFakeReference(payment_intent);
      return listObjects('refund', (refund) => refund.payment_intent === payment_intent);
    },
    create: async (data, options = {}) => {
      if (options.idempotencyKey) {
        const previous = await prisma.fakePaymentObject.findUnique({ where: { idempotencyKey: `refund:${options.idempotencyKey}` } });
        if (previous) return previous.data;
      }
      const intent = await retrieveObject(data.payment_intent, 'payment_intent');
      const refunds = await listObjects('refund', (refund) => refund.payment_intent === data.payment_intent);
      const remaining = intent.amount - refunds.data.reduce((total, refund) => total + refund.amount, 0);
      const amount = data.amount ?? remaining;
      if (!Number.isInteger(amount) || amount <= 0 || amount > remaining) {
        const error = new AppError('The simulated charge has insufficient refundable funds.', 400);
        error.code = 'charge_already_refunded';
        error.type = 'StripeInvalidRequestError';
        throw error;
      }
      return createObject('refund', 're', { ...data, amount, currency: intent.currency, status: 'succeeded' }, options);
    },
  },
  transfers: {
    create: async (data, options) => {
      await retrieveObject(data.destination, 'account');
      return createObject('transfer', 'tr', data, options);
    },
  },
};

module.exports = { fakePaymentProvider };
