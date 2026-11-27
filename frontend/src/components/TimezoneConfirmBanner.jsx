'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuthStore } from '../lib/store';
import { userApi } from '../lib/api-entry';
import { getDeviceTimezone, needsTimezoneConfirmation } from '../lib/formatters';

// prompt a user to confirm their timezone rather then resorting to UTC
export default function TimezoneConfirmBanner() {
  const user = useAuthStore((state) => state.user);
  const setUser = useAuthStore((state) => state.setUser);
  const [dismissed, setDismissed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  if (!user || dismissed || !needsTimezoneConfirmation(user)) return null;

  const deviceTimezone = getDeviceTimezone();

  const confirmTimezone = async (timezone) => {
    if (!timezone || saving) return;
    setSaving(true);
    setError('');
    try {
      await userApi.updateProfile({ timezone });
      setUser({ ...user, timezone });
    } catch (err) {
      setError(err?.response?.data?.message || 'Could not save your timezone. Please try again.');
      setSaving(false);
    }
  };

  return (
    <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm text-amber-900">
          <p className="font-semibold">Confirm your timezone</p>
          <p className="mt-0.5 text-amber-800">
            Your timezone isn&apos;t set yet, so lesson times are shown in{' '}
            <span className="font-medium">UTC</span>. Confirm a timezone to see times in your local
            time.
          </p>
          {error && <p className="mt-1 text-red-600">{error}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {deviceTimezone && (
            <button
              type="button"
              onClick={() => confirmTimezone(deviceTimezone)}
              disabled={saving}
              className="btn-primary btn-sm whitespace-nowrap disabled:opacity-60"
            >
              {saving ? 'Saving...' : `Use ${deviceTimezone}`}
            </button>
          )}
          <Link
            href="/profile"
            className="rounded-full border border-amber-300 bg-white px-3 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100"
          >
            Choose another
          </Link>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss"
            className="rounded-full px-2 py-2 text-amber-700 hover:bg-amber-100"
          >
            &#10005;
          </button>
        </div>
      </div>
    </div>
  );
}
