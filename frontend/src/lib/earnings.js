export const EARNING_STATUS = Object.freeze({
  PENDING: 'PENDING',
  ELIGIBLE: 'ELIGIBLE',
  PROCESSING: 'PROCESSING',
  DISPUTED: 'DISPUTED',
  PAID: 'PAID',
  FAILED: 'FAILED',
});

const STATUS_VIEW = {
  PENDING: {
    label: 'Pending',
    description: 'Payment received; waiting for lesson completion or a final cancellation outcome.',
    className: 'border-amber-200 bg-amber-50 text-amber-800',
    timestampKey: 'pendingAt',
    timestampLabel: 'Payment received',
  },
  ELIGIBLE: {
    label: 'Eligible',
    description: 'This amount is earned and eligible for payout.',
    className: 'border-sky-200 bg-sky-50 text-sky-800',
    timestampKey: 'eligibleAt',
    timestampLabel: 'Eligible since',
  },
  PROCESSING: {
    label: 'Processing',
    description: 'An administrator included this earning in a payout run.',
    className: 'border-indigo-200 bg-indigo-50 text-indigo-800',
    timestampKey: 'eligibleAt',
    timestampLabel: 'Payout processing started after eligibility',
  },
  DISPUTED: {
    label: 'Under review',
    description: 'The learner reported a completion issue, so this payout is paused for support review.',
    className: 'border-orange-200 bg-orange-50 text-orange-800',
    timestampKey: 'disputedAt',
    timestampLabel: 'Reported',
  },
  PAID: {
    label: 'Paid',
    description: 'This amount has been paid to your connected payout account.',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    timestampKey: 'paidAt',
    timestampLabel: 'Paid',
  },
  FAILED: {
    label: 'Failed',
    description: 'The payout failed; the amount remains recorded as owed.',
    className: 'border-red-200 bg-red-50 text-red-800',
    timestampKey: 'failedAt',
    timestampLabel: 'Failed',
  },
};

export const getEarningStatusView = (record) => {
  if (!record?.isPayable || !record?.payoutStatus) {
    const refundStatus = record?.refund?.status;
    const description =
      refundStatus === 'PROCESSING'
        ? 'No tutor payout is due. The learner’s full refund is being processed or reconciled.'
        : refundStatus === 'FAILED'
          ? 'No tutor payout is due. The learner refund needs administrator attention.'
          : refundStatus === 'SUCCEEDED'
            ? 'No tutor payout is due. The learner’s full refund was confirmed.'
            : 'The lesson has no payable tutor earning.';
    return {
      label: 'No payout due',
      description,
      className: 'border-gray-200 bg-gray-50 text-gray-700',
      timestampKey: null,
      timestampLabel: null,
    };
  }

  return STATUS_VIEW[record.payoutStatus] || {
    label: 'Status unavailable',
    description: 'The current payout state could not be displayed.',
    className: 'border-gray-200 bg-gray-50 text-gray-700',
    timestampKey: null,
    timestampLabel: null,
  };
};

export const calculateClientEarningPreview = ({
  amount,
  currency = 'AUD',
  commissionPercent = 15,
}) => {
  const grossMinor = Math.max(0, Math.round(Number(amount || 0) * 100));
  const normalizedPercent = Math.min(100, Math.max(0, Number(commissionPercent || 0)));
  const commissionMinor = Math.round((grossMinor * normalizedPercent) / 100);

  return {
    currency,
    grossAmount: (grossMinor / 100).toFixed(2),
    commissionPercent: normalizedPercent.toFixed(2),
    commissionAmount: (commissionMinor / 100).toFixed(2),
    netAmount: ((grossMinor - commissionMinor) / 100).toFixed(2),
  };
};

export const getPrimarySummary = (summaries, preferredCurrency = 'AUD') => {
  const values = Array.isArray(summaries) ? summaries : [];
  return (
    values.find((summary) => summary.currency === preferredCurrency) ||
    values[0] ||
    {
      currency: preferredCurrency,
      grossAmount: '0.00',
      commissionAmount: '0.00',
      netAmount: '0.00',
      byStatus: {
        PENDING: '0.00',
        ELIGIBLE: '0.00',
        PROCESSING: '0.00',
        DISPUTED: '0.00',
        PAID: '0.00',
        FAILED: '0.00',
      },
    }
  );
};
