const Stripe = require('stripe');
const { getPaymentEnvironment } = require('./paymentEnvironment');
const { AppError } = require('../middleware/errorHandler');

const providerReferenceFields = ['id', 'customer', 'payment_method', 'payment_intent', 'destination', 'account', 'source_transaction'];
const assertStripeReferences = (args) => {
  for (const argument of args) {
    const references = typeof argument === 'string'
      ? [argument]
      : providerReferenceFields.map((field) => argument?.[field]);
    if (references.some((value) => typeof value === 'string' && value.startsWith('fake_'))) {
      throw new AppError('Simulated payment data cannot be sent to Stripe. Use the matching payment environment.', 409, {
        code: 'PAYMENT_ENVIRONMENT_MISMATCH',
      });
    }
  }
};

const guardStripeClient = (client) => new Proxy(client, {
  get(target, name) {
    const resource = Reflect.get(target, name);
    if (!['customers', 'setupIntents', 'paymentMethods', 'paymentIntents', 'accounts', 'accountLinks', 'refunds', 'transfers'].includes(name)) return resource;
    return new Proxy(resource, {
      get(resourceTarget, methodName) {
        const method = Reflect.get(resourceTarget, methodName);
        if (typeof method !== 'function') return method;
        return (...args) => {
          assertStripeReferences(args);
          return method.apply(resourceTarget, args);
        };
      },
    });
  },
});

let stripeClient = null;

const isStripeConfigured = () => getPaymentEnvironment().isTestPayment || Boolean(process.env.STRIPE_SECRET_KEY);

const getStripe = () => {
  if (getPaymentEnvironment().isTestPayment) {
    return require('../services/fakePaymentProvider').fakePaymentProvider;
  }
  if (stripeClient) return stripeClient;

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }

  stripeClient = guardStripeClient(new Stripe(secretKey));

  return stripeClient;
};

module.exports = {
  getStripe,
  isStripeConfigured,
};
