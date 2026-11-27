'use client';

import { usePaymentEnvironment } from '../lib/use-payment-environment';

export function PaymentTestBanner() {
  const { environment } = usePaymentEnvironment();
  if (!environment?.isTestPayment) return null;
  return (
    <div role="status" className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <strong>Fake Payment — test environment.</strong> Payments, refunds and payouts are simulated. No real money moves.
    </div>
  );
}

export function TestPaymentBadge({ isTestPayment }) {
  if (!isTestPayment) return null;
  return <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">Test payment</span>;
}
