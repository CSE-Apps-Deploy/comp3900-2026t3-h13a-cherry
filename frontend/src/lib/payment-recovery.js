export const getPaymentRecoveryError = (error) => {
  const body = error?.response?.data || error?.data || {};
  return {
    code: String(body.code || '').toUpperCase(),
    message: body.message || 'Payment could not be retried.',
    action: body.action || null,
    link: body.link || null,
  };
};

export const isProcessingRetryResponse = (response) =>
  Number(response?.status) === 202 ||
  String(response?.data?.outcome || response?.outcome || '').toUpperCase() ===
    'PAYMENT_PROCESSING';

export const saveMethodAndMaybeRetry = async ({
  saveMethod,
  retryPayment,
  shouldRetry,
}) => {
  await saveMethod();
  if (!shouldRetry) return null;
  return retryPayment();
};
