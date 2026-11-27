const { AppError } = require('../middleware/errorHandler');

const getPaymentEnvironment = () => {
  const provider = String(process.env.PAYMENT_PROVIDER || 'stripe').trim().toLowerCase();
  if (provider === 'stripe') return { provider, isTestPayment: false };
  if (provider === 'fake' && ['local', 'test'].includes(process.env.APP_ENV)) {
    return { provider, isTestPayment: true };
  }
  throw new AppError('Fake Payment requires PAYMENT_PROVIDER=fake and APP_ENV=local or test.', 503, {
    code: 'FAKE_PAYMENT_DISABLED',
  });
};

const assertMatchingPaymentEnvironment = (record = {}) => {
  const references = [record?.stripeCustomerId, record?.stripePaymentMethodId, record?.stripeSetupIntentId,
    record?.stripePaymentIntentId, record?.stripeAccountId, record?.providerTransferId].filter(Boolean);
  if (!references.length) return;
  const fake = references.some((id) => String(id).startsWith('fake_'));
  if (fake !== getPaymentEnvironment().isTestPayment || (fake && references.some((id) => !String(id).startsWith('fake_')))) {
    throw new AppError('This record belongs to a different payment environment. Use separate test accounts and matching payment settings.', 409, {
      code: 'PAYMENT_ENVIRONMENT_MISMATCH',
    });
  }
};

module.exports = { getPaymentEnvironment, assertMatchingPaymentEnvironment };
