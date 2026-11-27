const configuredCommissionPercent = Number(process.env.DEFAULT_PLATFORM_FEE_PERCENT || 15);

const DEFAULT_PLATFORM_FEE_PERCENT =
  Number.isFinite(configuredCommissionPercent) &&
  configuredCommissionPercent >= 0 &&
  configuredCommissionPercent <= 100
    ? configuredCommissionPercent
    : 15;

const decimalToScaledInteger = (value, scale) => {
  const normalized = String(value ?? 0).trim();
  const match = normalized.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) return 0;

  const sign = match[1] === '-' ? -1 : 1;
  const whole = Number(match[2]);
  const fraction = match[3] || '';
  const kept = fraction.slice(0, scale).padEnd(scale, '0');
  const nextDigit = Number(fraction[scale] || 0);
  const multiplier = 10 ** scale;
  const scaled = whole * multiplier + Number(kept || 0) + (nextDigit >= 5 ? 1 : 0);

  return sign * scaled;
};

const toMinorUnits = (value) => decimalToScaledInteger(value, 2);
const percentToBasisPoints = (value) => decimalToScaledInteger(value, 2);
const fromMinorUnits = (value) => Number((Number(value || 0) / 100).toFixed(2));
const formatMoney = (value) => fromMinorUnits(toMinorUnits(value)).toFixed(2);
const formatPercent = (value) => (percentToBasisPoints(value) / 100).toFixed(2);

const calculateEarning = ({
  amount,
  refundAmount = 0,
  commissionPercent = DEFAULT_PLATFORM_FEE_PERCENT,
} = {}) => {
  const originalMinor = Math.max(0, toMinorUnits(amount));
  const refundMinor = Math.min(originalMinor, Math.max(0, toMinorUnits(refundAmount)));
  const grossMinor = originalMinor - refundMinor;
  const commissionBasisPoints = Math.min(
    10_000,
    Math.max(0, percentToBasisPoints(commissionPercent))
  );
  const commissionMinor = Math.round((grossMinor * commissionBasisPoints) / 10_000);
  const netMinor = grossMinor - commissionMinor;

  return {
    originalAmount: fromMinorUnits(originalMinor),
    refundAmount: fromMinorUnits(refundMinor),
    grossAmount: fromMinorUnits(grossMinor),
    commissionPercent: commissionBasisPoints / 100,
    commissionAmount: fromMinorUnits(commissionMinor),
    netAmount: fromMinorUnits(netMinor),
  };
};

const serializeEarningCalculation = (calculation) => ({
  originalAmount: formatMoney(calculation.originalAmount),
  refundAmount: formatMoney(calculation.refundAmount),
  grossAmount: formatMoney(calculation.grossAmount),
  commissionPercent: formatPercent(calculation.commissionPercent),
  commissionAmount: formatMoney(calculation.commissionAmount),
  netAmount: formatMoney(calculation.netAmount),
});

const buildEarningPreview = ({ amount, currency = 'AUD', isTrialLesson = false } = {}) => {
  if (isTrialLesson) {
    return {
      isTrialLesson: true,
      currency: String(currency || 'AUD').toUpperCase(),
      message: 'Free trial — no commission or payout.',
    };
  }

  return {
    isTrialLesson: false,
    currency: String(currency || 'AUD').toUpperCase(),
    ...serializeEarningCalculation(calculateEarning({ amount })),
  };
};

module.exports = {
  DEFAULT_PLATFORM_FEE_PERCENT,
  buildEarningPreview,
  calculateEarning,
  formatMoney,
  formatPercent,
  fromMinorUnits,
  serializeEarningCalculation,
  toMinorUnits,
};
