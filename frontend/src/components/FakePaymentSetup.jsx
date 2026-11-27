'use client';

import { useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { paymentApi } from '../lib/api-entry';

export default function FakePaymentSetup({ onSetup, isPending = false }) {
  const setup = useMutation({
    mutationFn: () => paymentApi.createSetupIntent(),
    onSuccess: (response) => onSetup(response.data.data.setupIntentId),
    onError: (error) => toast.error(error?.response?.data?.message || 'Could not prepare the simulated payment method'),
  });
  return (
    <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
      <p className="font-semibold text-amber-900">Local Fake Payment</p>
      <p className="text-sm text-amber-800">Use a simulated successful payment method. No card or bank details are required.</p>
      <button type="button" className="btn-primary" disabled={setup.isPending || isPending} onClick={() => setup.mutate()}>
        {setup.isPending || isPending ? 'Saving...' : 'Use simulated payment method'}
      </button>
    </div>
  );
}
