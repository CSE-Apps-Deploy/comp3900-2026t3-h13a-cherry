'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  BanknotesIcon,
  CheckCircleIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
} from '@heroicons/react/24/outline';
import toast from 'react-hot-toast';
import BackButton from '../../../../components/BackButton';
import { TestPaymentBadge } from '../../../../components/PaymentTestNotice';
import { paymentApi } from '../../../../lib/api-entry';
import { getEarningStatusView, getPrimarySummary } from '../../../../lib/earnings';
import {
  formatCurrency,
  formatDateTimeWithYear,
  getUserTimezone,
} from '../../../../lib/formatters';
import { formatPayoutStatus, getPayoutStatusClass } from '../../../../lib/payment-display';
import {
  getPayoutPanelClass,
  getPayoutReturnState,
  getPayoutStatusView,
} from '../../../../lib/payout-onboarding';
import { useAuthStore } from '../../../../lib/store';
import { cn } from '../../../../lib/utils';

const TONE_ICONS = {
  success: CheckCircleIcon,
  failure: ExclamationTriangleIcon,
  warning: ExclamationTriangleIcon,
  info: BanknotesIcon,
};

const STATUS_ORDER = ['PENDING', 'ELIGIBLE', 'PROCESSING', 'DISPUTED', 'PAID', 'FAILED'];

const statusAmountLabel = {
  PENDING: 'Pending',
  ELIGIBLE: 'Eligible',
  PROCESSING: 'Processing',
  DISPUTED: 'Under review',
  PAID: 'Paid',
  FAILED: 'Failed',
};

function SummaryPanel({ summary }) {
  const currency = summary.currency || 'AUD';

  return (
    <section
      aria-label={`${currency} earnings summary`}
      className="rounded-2xl border border-gray-200 bg-white p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
            {currency} earnings
          </p>
          <h2 className="mt-1 text-lg font-semibold text-gray-900">Your transparent breakdown</h2>
        </div>
        <p className="text-xs text-gray-500">All figures are after refunds</p>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl bg-gray-50 p-4">
          <dt className="text-xs uppercase tracking-wide text-gray-500">Gross retained</dt>
          <dd className="mt-1 text-xl font-bold text-gray-900">
            {formatCurrency(summary.grossAmount, currency)}
          </dd>
        </div>
        <div className="rounded-xl bg-rose-50 p-4">
          <dt className="text-xs uppercase tracking-wide text-rose-700">
            TutorConnect commission
          </dt>
          <dd className="mt-1 text-xl font-bold text-rose-800">
            −{formatCurrency(summary.commissionAmount, currency)}
          </dd>
        </div>
        <div className="rounded-xl bg-emerald-50 p-4">
          <dt className="text-xs uppercase tracking-wide text-emerald-700">Net earnings</dt>
          <dd className="mt-1 text-xl font-bold text-emerald-800">
            {formatCurrency(summary.netAmount, currency)}
          </dd>
        </div>
      </dl>

      <dl className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-6">
        {STATUS_ORDER.map((status) => (
          <div key={status} className="rounded-xl border border-gray-100 px-3 py-2.5">
            <dt className="text-xs text-gray-500">{statusAmountLabel[status]}</dt>
            <dd className="mt-0.5 font-semibold text-gray-900">
              {formatCurrency(summary.byStatus?.[status] || 0, currency)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function EarningRecord({ record, timeZone }) {
  const currency = record.currency || 'AUD';
  const calculation = record.calculation || {};
  const statusView = getEarningStatusView(record);
  const timestamp = statusView.timestampKey
    ? record.statusTimestamps?.[statusView.timestampKey]
    : record.cancellation?.cancelledAt;

  return (
    <article className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href={record.lesson.href}
            className="font-semibold text-gray-900 hover:text-primary-700 hover:underline"
          >
            {record.lesson.subject}
            <TestPaymentBadge isTestPayment={record.isTestPayment} />
          </Link>
          <p className="mt-1 text-sm text-gray-500">
            {formatDateTimeWithYear(record.lesson.scheduledAt, timeZone)}
          </p>
        </div>
        <span
          className={cn(
            'rounded-full border px-3 py-1 text-xs font-semibold',
            statusView.className
          )}
        >
          {statusView.label}
        </span>
      </div>

      {Number(calculation.refundAmount || 0) > 0 && (
        <div className="mt-4 rounded-xl border border-sky-100 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          <p className="font-semibold">Refund-adjusted earning</p>
          <p className="mt-1">
            Original charge {formatCurrency(calculation.originalAmount, currency)}
            {' − refund '}
            {formatCurrency(calculation.refundAmount, currency)}
            {' = '}
            {formatCurrency(calculation.grossAmount, currency)} retained gross.
          </p>
          {record.cancellation && (
            <Link href={record.cancellation.href} className="mt-2 inline-block font-medium underline">
              {record.cancellation.outcomeType === 'POST_LESSON_RESOLUTION'
                ? 'View post-lesson outcome'
                : 'View cancellation outcome'}
            </Link>
          )}
        </div>
      )}

      <div className="mt-4 rounded-xl border border-violet-200 bg-violet-50 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-violet-700">
          Earning calculation
        </p>
        <p className="mt-2 text-sm text-violet-950">
          {formatCurrency(calculation.grossAmount, currency)}
          {' gross − '}
          {formatCurrency(calculation.commissionAmount, currency)}
          {` TutorConnect commission (${Number(calculation.commissionPercent || 0)}%)`}
          {' = '}
          <strong>{formatCurrency(calculation.netAmount, currency)} net to you</strong>
        </p>
      </div>

      <div className="mt-4 flex items-start gap-2 text-sm text-gray-600">
        <InformationCircleIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div>
          <p>{statusView.description}</p>
          {timestamp && (
            <p className="mt-1 text-xs text-gray-500">
              {statusView.timestampLabel || 'Outcome recorded'}{' '}
              {formatDateTimeWithYear(timestamp, timeZone)}
            </p>
          )}
          {record.payoutFailureReason && (
            <p className="mt-1 text-sm font-medium text-red-700">{record.payoutFailureReason}</p>
          )}
        </div>
      </div>
    </article>
  );
}

export default function TutorPayoutsPage() {
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const autoResumed = useRef(false);
  const user = useAuthStore((state) => state.user);
  const [page, setPage] = useState(1);
  const timeZone = getUserTimezone(user);

  const returnState = useMemo(() => getPayoutReturnState(searchParams), [searchParams]);

  const payoutQuery = useQuery({
    queryKey: ['payout-account'],
    queryFn: () => paymentApi.getPayoutAccount({ refresh: returnState.shouldForceRefresh }),
  });
  const earningsQuery = useQuery({
    queryKey: ['tutor-earnings', page],
    queryFn: () => paymentApi.getEarnings({ page, limit: 20 }),
  });

  const account = payoutQuery.data?.data?.data;
  const payoutView = getPayoutStatusView(account);
  const ToneIcon = TONE_ICONS[payoutView.tone] || BanknotesIcon;
  const earnings = earningsQuery.data?.data?.data;
  const commissionPercent = Number(earnings?.commissionPolicy?.percent || 15);
  const tutorPercent = Number(earnings?.commissionPolicy?.tutorPercent || 85);
  const exampleCommission = (commissionPercent).toFixed(2);
  const exampleNet = (100 - commissionPercent).toFixed(2);
  const summaries = earnings?.summaries || [];
  const displayedSummaries =
    summaries.length > 0 ? summaries : [getPrimarySummary([], 'AUD')];
  const records = earnings?.records || [];
  const pagination = earnings?.pagination || { page: 1, totalPages: 0, total: 0 };

  const startOnboarding = useMutation({
    mutationFn: () => paymentApi.createPayoutOnboardingLink(),
    onSuccess: (response) => {
      const url = response?.data?.data?.url;
      if (!url) {
        toast.error('Could not open payout setup. Please try again.');
        return;
      }
      window.location.assign(url);
    },
    onError: (error) => {
      toast.error(error?.response?.data?.message || 'Could not start payout setup');
    },
  });

  useEffect(() => {
    if (!returnState.shouldAutoResume || autoResumed.current) return;
    autoResumed.current = true;
    startOnboarding.mutate();
  }, [returnState.shouldAutoResume, startOnboarding]);

  useEffect(() => {
    if (!account?.isPayoutReady) return;
    queryClient.invalidateQueries({ queryKey: ['tutor-requests'] });
    queryClient.invalidateQueries({ queryKey: ['bookings'] });
  }, [account?.isPayoutReady, queryClient]);

  const isOnboardingBusy = startOnboarding.isPending || returnState.shouldAutoResume;

  return (
    <div className="w-full space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="mb-1 text-xs uppercase tracking-wide text-gray-400">Tutor finances</p>
          <h1 className="text-2xl font-bold text-gray-900">Earnings &amp; payouts</h1>
        </div>
        <BackButton href={returnState.returnTo || '/tutor/dashboard'} />
      </div>

      <section className="rounded-2xl border-2 border-violet-300 bg-violet-50 p-5 text-violet-950">
        <div className="flex items-start gap-3">
          <BanknotesIcon className="h-6 w-6 shrink-0 text-violet-700" aria-hidden="true" />
          <div>
            <h2 className="text-lg font-bold">The TutorConnect commission is {commissionPercent}%</h2>
            <p className="mt-1 text-sm leading-6">
              TutorConnect retains {commissionPercent}% of each non-refunded paid lesson amount.
              You receive {tutorPercent}%. Refunds reduce the gross first, then the same commission
              percentage is applied to the amount retained.
            </p>
            <p className="mt-3 rounded-xl bg-white px-4 py-3 text-sm font-semibold shadow-sm">
              AUD 100.00 gross − AUD {exampleCommission} commission = AUD {exampleNet} net to you
            </p>
          </div>
        </div>
      </section>

      {earningsQuery.isLoading ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-6 text-sm text-gray-500">
          Loading your earnings…
        </div>
      ) : earningsQuery.isError ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-red-800">
          <p className="font-semibold">We couldn’t load your earnings.</p>
          <button
            type="button"
            onClick={() => earningsQuery.refetch()}
            className="btn-secondary btn-sm mt-3 gap-2"
          >
            <ArrowPathIcon className="h-4 w-4" aria-hidden="true" />
            Try again
          </button>
        </div>
      ) : (
        <>
          {displayedSummaries.map((summary) => (
            <SummaryPanel key={summary.currency} summary={summary} />
          ))}

          <section aria-labelledby="lesson-earnings-heading" className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 id="lesson-earnings-heading" className="text-lg font-semibold text-gray-900">
                  Lesson earnings
                </h2>
                <p className="mt-0.5 text-sm text-gray-500">
                  Every paid or refunded lesson keeps its own commission snapshot and payout state.
                </p>
              </div>
              <p className="text-xs text-gray-500">
                Free trials are excluded because they are not payable earnings.
              </p>
            </div>

            {records.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-gray-300 bg-white px-6 py-10 text-center">
                <BanknotesIcon className="mx-auto h-9 w-9 text-gray-300" aria-hidden="true" />
                <p className="mt-3 font-semibold text-gray-900">No payable lesson records yet</p>
                <p className="mt-1 text-sm text-gray-500">
                  Paid lessons will appear here. Completed free trials are intentionally excluded.
                </p>
              </div>
            ) : (
              records.map((record) => (
                <EarningRecord key={record.id} record={record} timeZone={timeZone} />
              ))
            )}

            {pagination.totalPages > 1 && (
              <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-4 py-3">
                <p className="text-sm text-gray-500">
                  Page {pagination.page} of {pagination.totalPages} · {pagination.total} records
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setPage((current) => Math.max(1, current - 1))}
                    disabled={page <= 1 || earningsQuery.isFetching}
                    className="btn-secondary btn-sm gap-1"
                  >
                    <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
                    Previous
                  </button>
                  <button
                    type="button"
                    onClick={() => setPage((current) => current + 1)}
                    disabled={page >= pagination.totalPages || earningsQuery.isFetching}
                    className="btn-secondary btn-sm gap-1"
                  >
                    Next
                    <ChevronRightIcon className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </div>
            )}
          </section>
        </>
      )}

      <section aria-labelledby="payout-account-heading" className="rounded-2xl border border-gray-200 bg-white p-6">
        <div className="mb-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
            Separate from lesson status
          </p>
          <h2 id="payout-account-heading" className="mt-1 text-lg font-semibold text-gray-900">
            Payout account
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            Account readiness controls where payouts can be sent. It does not change how much you
            earned.
          </p>
        </div>

        {payoutQuery.isLoading ? (
          <p className="text-sm text-gray-500">Loading your payout-account status…</p>
        ) : payoutQuery.isError ? (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <p>We couldn’t load your payout-account status.</p>
            <button type="button" onClick={() => payoutQuery.refetch()} className="mt-2 underline">
              Try again
            </button>
          </div>
        ) : (
          <div className={cn('p-4', getPayoutPanelClass(payoutView.tone))}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold">{payoutView.title}</h3>
                  <span className={cn('badge', getPayoutStatusClass(payoutView.status))}>
                    {formatPayoutStatus(payoutView.status)}
                  </span>
                </div>
                <p className="text-sm">{payoutView.description}</p>
                {account?.lastSyncedAt && (
                  <p className="mt-2 text-xs opacity-75">
                    Status last checked {formatDateTimeWithYear(account.lastSyncedAt, timeZone)}
                  </p>
                )}
              </div>
              <ToneIcon className="h-8 w-8 shrink-0" aria-hidden="true" />
            </div>

            {payoutView.showCta && (
              <button
                type="button"
                onClick={() => startOnboarding.mutate()}
                disabled={isOnboardingBusy}
                className="btn-primary mt-4 inline-flex items-center gap-2"
              >
                {isOnboardingBusy ? 'Opening secure setup…' : payoutView.ctaLabel}
                {!isOnboardingBusy && (
                  <ArrowTopRightOnSquareIcon className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            )}
          </div>
        )}

        <p className="mt-4 text-sm text-gray-500">
          Bank and identity details are collected and stored by our payment provider, not by
          TutorConnect.
        </p>

        {account?.isPayoutReady && returnState.returnTo && (
          <Link href={returnState.returnTo} className="btn-secondary mt-4 inline-block">
            Back to your booking
          </Link>
        )}
      </section>
    </div>
  );
}
