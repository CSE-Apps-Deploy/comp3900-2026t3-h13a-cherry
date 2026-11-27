'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  BanknotesIcon,
  ArrowPathIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  ReceiptPercentIcon,
  ShieldExclamationIcon,
} from '@heroicons/react/24/outline';
import { adminApi } from '../../../../lib/api-entry';
import { TestPaymentBadge } from '../../../../components/PaymentTestNotice';
import {
  formatCurrency,
  formatShortDateTime as formatDate,
} from '../../../../lib/formatters';

const statusClass = (status) => {
  if (status === 'COMPLETED' || status === 'SUCCEEDED') {
    return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  }
  if (status === 'FAILED') return 'border-red-200 bg-red-50 text-red-700';
  if (status === 'PARTIALLY_FAILED') return 'border-amber-200 bg-amber-50 text-amber-700';
  return 'border-blue-200 bg-blue-50 text-blue-700';
};

const tutorName = (tutor) =>
  `${tutor?.firstName || ''} ${tutor?.lastName || ''}`.trim() || tutor?.email || 'Tutor';

function StatCard({ label, value, icon: Icon, tone }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4">
      <div className={`flex h-9 w-9 items-center justify-center rounded-xl ${tone}`}>
        <Icon className="h-5 w-5" />
      </div>
      <p className="mt-3 text-2xl font-bold text-gray-900">{value}</p>
      <p className="text-xs text-gray-500">{label}</p>
    </div>
  );
}

function TransferReceipt({ transfer }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-gray-900">{tutorName(transfer.tutor)}</p>
          <p className="mt-0.5 text-xs text-gray-500">{transfer.tutor?.email}</p>
        </div>
        <div className="text-right">
          <p className="font-semibold text-gray-900">
            {formatCurrency(transfer.amount, transfer.currency)}
          </p>
          <span className={`badge border ${statusClass(transfer.status)}`}>{transfer.status}</span>
        </div>
      </div>
      {transfer.providerTransferId && (
        <p className="mt-2 break-all font-mono text-xs text-gray-500">
          {transfer.isTestPayment ? 'Simulated receipt' : 'Stripe receipt'}: {transfer.providerTransferId}
          <TestPaymentBadge isTestPayment={transfer.isTestPayment} />
        </p>
      )}
      {transfer.failureReason && (
        <p className="mt-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">
          {transfer.failureReason}
        </p>
      )}
      <div className="mt-3 space-y-2">
        {(transfer.lessons || []).map((lesson) => (
          <div
            key={`${transfer.id}-${lesson.paymentId}`}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white px-3 py-2 text-sm"
          >
            <div>
              <p className="font-medium text-gray-800">{lesson.subject}</p>
              <p className="text-xs text-gray-500">
                {lesson.learner
                  ? `${lesson.learner.firstName} ${lesson.learner.lastName} · `
                  : ''}
                {formatDate(lesson.scheduledAt)}
              </p>
            </div>
            <p className="font-medium text-gray-700">
              {formatCurrency(lesson.amount, transfer.currency)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AdminPayoutsPage() {
  const queryClient = useQueryClient();
  const [runsPage, setRunsPage] = useState(1);
  const [expandedRunId, setExpandedRunId] = useState(null);

  const overviewQuery = useQuery({
    queryKey: ['admin-payout-overview'],
    queryFn: () => adminApi.getPayoutOverview(),
    refetchInterval: 60000,
  });
  const runsQuery = useQuery({
    queryKey: ['admin-payout-runs', runsPage],
    queryFn: () => adminApi.getPayoutRuns({ page: runsPage, limit: 10 }),
  });

  const processMutation = useMutation({
    mutationFn: ({ tutorProfileId } = {}) =>
      tutorProfileId
        ? adminApi.processTutorPayoutRun(tutorProfileId)
        : adminApi.processPayoutRun(),
    onSuccess: async (response) => {
      toast.success(response?.data?.message || 'Payout run processed');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-payout-overview'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-payout-runs'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-actions'] }),
      ]);
      const runId = response?.data?.data?.id;
      if (runId) setExpandedRunId(runId);
    },
    onError: (error) => {
      toast.error(error?.response?.data?.message || 'Could not process tutor payouts');
    },
  });

  const clearDisputeMutation = useMutation({
    mutationFn: ({ bookingId, note, expectedVersion }) =>
      adminApi.clearCompletionDispute(bookingId, note, expectedVersion),
    onSuccess: async (response) => {
      toast.success(response?.data?.message || 'Completion dispute cleared');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-payout-overview'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-actions'] }),
      ]);
    },
    onError: (error) => {
      toast.error(error?.response?.data?.message || 'Could not clear the completion dispute');
    },
  });

  const refundDisputeMutation = useMutation({
    mutationFn: ({ bookingId, note, expectedVersion }) =>
      adminApi.refundCompletionDispute(bookingId, note, expectedVersion),
    onSuccess: async (response) => {
      toast.success(response?.data?.message || 'Learner refund requested');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-payout-overview'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-actions'] }),
      ]);
    },
    onError: (error) => {
      toast.error(error?.response?.data?.message || 'Could not refund the learner');
    },
  });

  const retryRefundMutation = useMutation({
    mutationFn: ({ refundId }) => adminApi.retryCompletionRefund(refundId),
    onSuccess: async (response) => {
      toast.success(response?.data?.message || 'Refund retry submitted');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-payout-overview'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-actions'] }),
      ]);
    },
    onError: (error) => {
      toast.error(error?.response?.data?.message || 'Could not retry the refund');
    },
  });

  const overview = overviewQuery.data?.data?.data || {};
  const readyGroups = overview.readyGroups || [];
  const blockedGroups = overview.blockedGroups || [];
  const disputed = overview.disputed || [];
  const refunds = overview.refunds || [];
  const counts = overview.counts || {};
  const runsData = runsQuery.data?.data?.data || {};
  const runs = runsData.runs || [];
  const pagination = runsData.pagination || { page: 1, totalPages: 0 };
  const processingTutorId = processMutation.variables?.tutorProfileId || null;

  const processAll = () => {
    const lessonCount = Number(counts.readyPayments || 0);
    const transferCount = Number(counts.readyTransfers || 0);
    if (!lessonCount || !transferCount) return;
    if (
      !window.confirm(
        `Create ${transferCount} combined Stripe transfer(s) covering ${lessonCount} lesson earning(s)? This sends funds to tutors' connected Stripe balances.`
      )
    ) {
      return;
    }
    processMutation.mutate();
  };

  const processTutor = (group) => {
    const name = tutorName(group.tutor);
    if (
      !window.confirm(
        `Send ${formatCurrency(group.amount, group.currency)} for ${group.paymentCount} eligible lesson earning(s) to ${name}'s connected Stripe balance? Other tutors will not be processed.`
      )
    ) {
      return;
    }
    processMutation.mutate({ tutorProfileId: group.tutor.id });
  };

  return (
    <div className="space-y-6">
      <div className="-mx-4 -mt-4 rounded-b-2xl bg-gradient-to-r from-primary-600 to-primary-500 px-8 pb-6 pt-6 text-white">
        <p className="text-xs font-medium text-primary-200">Finance operations</p>
        <h1 className="mt-0.5 text-xl font-bold">Tutor Payouts</h1>
        <p className="mt-1 text-sm text-primary-100">
          Review eligible earnings, process combined tutor transfers, and inspect receipts.
        </p>
      </div>

      {overviewQuery.isError && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-red-800">
          <p className="font-semibold">Could not load payout operations.</p>
          <button type="button" onClick={() => overviewQuery.refetch()} className="btn-secondary btn-sm mt-3">
            Retry
          </button>
        </div>
      )}

      {!overviewQuery.isLoading && overview.providerConfigured === false && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-amber-900">
          <p className="font-semibold">Stripe transfers are not configured.</p>
          <p className="mt-1 text-sm">Add the platform Stripe secret key before processing payouts.</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Ready lesson earnings"
          value={overviewQuery.isLoading ? '…' : counts.readyPayments || 0}
          icon={CheckCircleIcon}
          tone="bg-emerald-100 text-emerald-700"
        />
        <StatCard
          label="Tutor transfers ready"
          value={overviewQuery.isLoading ? '…' : counts.readyTransfers || 0}
          icon={BanknotesIcon}
          tone="bg-sky-100 text-sky-700"
        />
        <StatCard
          label="Completion disputes"
          value={overviewQuery.isLoading ? '…' : counts.disputedPayments || 0}
          icon={ShieldExclamationIcon}
          tone="bg-orange-100 text-orange-700"
        />
        <StatCard
          label="Transfers processing"
          value={overviewQuery.isLoading ? '…' : counts.processingPayments || 0}
          icon={ClockIcon}
          tone="bg-indigo-100 text-indigo-700"
        />
      </div>

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Ready now</p>
            <h2 className="mt-1 text-lg font-semibold text-gray-900">Combined transfers by tutor</h2>
            <p className="mt-1 text-sm text-gray-500">
              Pay tutors individually for finer control, or process every ready tutor at once. Disputed
              lesson earnings are excluded from both actions.
            </p>
          </div>
          <button
            type="button"
            onClick={processAll}
            disabled={
              processMutation.isPending ||
              !readyGroups.length ||
              overview.providerConfigured === false
            }
            className="btn-primary shrink-0 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <BanknotesIcon className="h-4 w-4" />
            {processMutation.isPending && !processingTutorId
              ? 'Processing transfers…'
              : 'Process all eligible payouts'}
          </button>
        </div>

        <div className="mt-5 space-y-3">
          {overviewQuery.isLoading ? (
            Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="h-24 animate-pulse rounded-xl bg-gray-100" />
            ))
          ) : readyGroups.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-200 px-4 py-10 text-center text-sm text-gray-500">
              No eligible tutor payouts are ready.
            </div>
          ) : (
            readyGroups.map((group) => (
              <div key={group.key} className="rounded-xl border border-gray-100 bg-gray-50 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-gray-900">{tutorName(group.tutor)}</p>
                    <p className="text-xs text-gray-500">{group.tutor.email}</p>
                    <p className="mt-1 text-xs text-gray-500">
                      {group.paymentCount} lesson earning{group.paymentCount === 1 ? '' : 's'}
                    </p>
                    {group.openDisputeCount > 0 && (
                      <p className="mt-2 inline-flex rounded-full border border-orange-200 bg-orange-50 px-2 py-1 text-xs font-medium text-orange-700">
                        {group.openDisputeCount} other open lesson dispute
                        {group.openDisputeCount === 1 ? '' : 's'} for this tutor
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <p className="text-lg font-bold text-gray-900">
                      {formatCurrency(group.amount, group.currency)}
                    </p>
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      disabled={processMutation.isPending || overview.providerConfigured === false}
                      onClick={() => processTutor(group)}
                    >
                      <BanknotesIcon className="h-4 w-4" />
                      {processingTutorId === group.tutor.id
                        ? 'Processing tutor…'
                        : `Pay ${tutorName(group.tutor)}`}
                    </button>
                  </div>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {group.payments.map((payment) => (
                    <div key={payment.id} className="rounded-lg bg-white px-3 py-2 text-sm">
                      <div className="flex justify-between gap-3">
                        <span className="font-medium text-gray-800">{payment.lesson.subject}<TestPaymentBadge isTestPayment={payment.isTestPayment} /></span>
                        <span className="text-gray-700">
                          {formatCurrency(payment.amount, payment.currency)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-gray-500">
                        {payment.lesson.learner.firstName} {payment.lesson.learner.lastName} ·{' '}
                        {formatDate(payment.lesson.scheduledAt)}
                      </p>
                      {payment.payoutStatus === 'FAILED' && (
                        <p className="mt-1 text-xs font-medium text-red-600">Retrying a failed transfer</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {blockedGroups.length > 0 && (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
          <div className="flex items-start gap-3">
            <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            <div className="w-full">
              <h2 className="font-semibold text-amber-950">Blocked by tutor payout setup</h2>
              <p className="mt-1 text-sm text-amber-800">
                These earnings are owed but excluded until the tutor’s connected account is ready.
              </p>
              <div className="mt-3 space-y-2">
                {blockedGroups.map((group) => (
                  <div key={group.key} className="flex flex-wrap justify-between gap-2 rounded-lg bg-white/70 px-3 py-2 text-sm">
                    <span>{tutorName(group.tutor)} · {group.payoutAccountStatus}</span>
                    <span className="font-semibold">{formatCurrency(group.amount, group.currency)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-orange-700">Manual review</p>
          <h2 className="mt-1 text-lg font-semibold text-gray-900">Completion disputes</h2>
          <p className="mt-1 text-sm text-gray-500">
            Review the learner’s report, then choose exactly one final outcome. Approving an
            earning does not pay it immediately; it makes the earning eligible for a future run.
            Free-trial decisions record only the lesson outcome and have no financial effect.
          </p>
        </div>
        <div className="mt-4 space-y-3">
          {disputed.length === 0 ? (
            <p className="rounded-xl border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-gray-500">
              No completion disputes require review.
            </p>
          ) : (
            disputed.map((dispute) => (
              <div key={dispute.id} className="rounded-xl border border-orange-100 bg-orange-50 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-gray-900">{dispute.lesson.subject}<TestPaymentBadge isTestPayment={dispute.isTestPayment} /></p>
                    <p className="mt-0.5 text-sm text-gray-600">
                      {dispute.lesson.learner.firstName} {dispute.lesson.learner.lastName} reported an issue with {tutorName(dispute.tutor)}
                    </p>
                    <p className="mt-2 text-sm font-medium text-orange-900">
                      “{dispute.dispute.reason || 'No reason supplied'}”
                    </p>
                    <p className="mt-1 text-xs text-orange-700">Reported {formatDate(dispute.dispute.disputedAt)}</p>
                  </div>
                  <div className="min-w-[220px] text-right">
                    <p className="text-xs text-gray-500">Tutor earning if approved</p>
                    <p className="font-semibold text-gray-900">
                      {formatCurrency(dispute.amount, dispute.currency)}
                    </p>
                    <p className="mt-2 text-xs text-gray-500">Learner refund if approved</p>
                    <p className="font-semibold text-gray-900">
                      {dispute.isTrialLesson
                        ? 'No payment · free trial'
                        : formatCurrency(dispute.refundQuote?.amount, dispute.refundQuote?.currency)}
                    </p>
                    <div className="mt-3 flex flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        disabled={clearDisputeMutation.isPending || refundDisputeMutation.isPending}
                        onClick={() => {
                          const note = window.prompt(
                            dispute.isTrialLesson
                              ? 'Resolution note explaining why the free trial should be recorded as completed:'
                              : 'Resolution note explaining why the tutor earning should be approved:'
                          );
                          if (!note?.trim()) return;
                          const confirmation = dispute.isTrialLesson
                            ? 'Resolve this free-trial dispute as completed? No earning or payout will be created.'
                            : 'Resolve this dispute in the tutor’s favour and make the earning eligible for payout?';
                          if (!window.confirm(confirmation)) return;
                          clearDisputeMutation.mutate({
                            bookingId: dispute.bookingId,
                            note: note.trim(),
                            expectedVersion: dispute.version,
                          });
                        }}
                      >
                        {dispute.isTrialLesson ? 'Confirm Lesson Completed' : 'Approve Tutor Earning'}
                      </button>
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        disabled={clearDisputeMutation.isPending || refundDisputeMutation.isPending}
                        onClick={() => {
                          const note = window.prompt(
                            'Resolution note explaining why the learner should be refunded:'
                          );
                          if (!note?.trim()) return;
                          const amount = formatCurrency(
                            dispute.refundQuote?.amount,
                            dispute.refundQuote?.currency
                          );
                          const confirmation = dispute.isTrialLesson
                            ? 'Resolve this free-trial dispute in the learner’s favour? No payment transaction will be created.'
                            : `Refund ${amount} to the learner’s original payment method? This permanently removes the tutor earning and cannot be undone.`;
                          if (!window.confirm(confirmation)) return;
                          refundDisputeMutation.mutate({
                            bookingId: dispute.bookingId,
                            note: note.trim(),
                            expectedVersion: dispute.version,
                          });
                        }}
                      >
                        {dispute.isTrialLesson ? 'Resolve for Learner' : 'Refund Learner'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-violet-700">Refund records</p>
          <h2 className="mt-1 text-lg font-semibold text-gray-900">Post-lesson learner refunds</h2>
          <p className="mt-1 text-sm text-gray-500">
            Provider-confirmed status is retained here. Failed refunds can be retried without
            creating a duplicate payment reversal.
          </p>
        </div>
        <div className="mt-4 space-y-3">
          {refunds.length === 0 ? (
            <p className="rounded-xl border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-gray-500">
              No post-lesson refunds have been requested.
            </p>
          ) : (
            refunds.map((refund) => (
              <div key={refund.id} className="rounded-xl border border-violet-100 bg-violet-50 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-gray-900">
                      {refund.lesson?.subject || 'Lesson refund'}
                      <TestPaymentBadge isTestPayment={refund.isTestPayment} />
                    </p>
                    <p className="mt-0.5 text-sm text-gray-600">
                      {refund.lesson?.learner
                        ? `${refund.lesson.learner.firstName} ${refund.lesson.learner.lastName}`
                        : 'Learner'}{' '}
                      · {refund.source === 'TUTOR_NON_COMPLETION'
                        ? 'Tutor reported non-completion'
                        : 'Admin dispute resolution'}
                    </p>
                    <p className="mt-1 text-xs text-violet-700">
                      Requested {formatDate(refund.requestedAt)}
                      {refund.completedAt ? ` · completed ${formatDate(refund.completedAt)}` : ''}
                    </p>
                    {refund.failureReason && (
                      <p className="mt-2 text-sm font-medium text-red-700">{refund.failureReason}</p>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="font-semibold text-gray-900">
                      {formatCurrency(refund.amount, refund.currency)}
                    </p>
                    <span className={`badge mt-1 border ${statusClass(refund.status)}`}>
                      {refund.status === 'SUCCEEDED'
                        ? 'COMPLETED'
                        : refund.status}
                    </span>
                    {refund.canRetry && (
                      <button
                        type="button"
                        className="btn-secondary btn-sm mt-3"
                        disabled={retryRefundMutation.isPending}
                        onClick={() => {
                          if (!window.confirm('Retry or reconcile this refund using its saved Stripe request?')) return;
                          retryRefundMutation.mutate({ refundId: refund.id });
                        }}
                      >
                        <ArrowPathIcon className="h-4 w-4" />
                        {retryRefundMutation.isPending && retryRefundMutation.variables?.refundId === refund.id
                          ? 'Retrying…'
                          : 'Retry refund'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <div className="flex items-center gap-3">
          <ReceiptPercentIcon className="h-5 w-5 text-gray-500" />
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Payout run receipts</h2>
            <p className="text-sm text-gray-500">Every admin action, tutor transfer, lesson, amount, and Stripe receipt is retained.</p>
          </div>
        </div>
        <div className="mt-4 space-y-3">
          {runsQuery.isLoading ? (
            <div className="h-32 animate-pulse rounded-xl bg-gray-100" />
          ) : runs.length === 0 ? (
            <p className="rounded-xl border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-gray-500">
              No payout runs have been processed.
            </p>
          ) : (
            runs.map((run) => {
              const expanded = expandedRunId === run.id;
              return (
                <div key={run.id} className="rounded-xl border border-gray-100">
                  <button
                    type="button"
                    onClick={() => setExpandedRunId(expanded ? null : run.id)}
                    className="flex w-full items-center justify-between gap-4 p-4 text-left"
                  >
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold text-gray-900">Run {run.id.slice(0, 8)}</p>
                        <span className={`badge border ${statusClass(run.status)}`}>{run.status}</span>
                      </div>
                      <p className="mt-1 text-xs text-gray-500">
                        {formatDate(run.startedAt)} · {run.paymentCount} lessons · {run.transferCount} transfers · by{' '}
                        {run.initiatedBy ? `${run.initiatedBy.firstName} ${run.initiatedBy.lastName}` : 'administrator'}
                      </p>
                    </div>
                    {expanded ? <ChevronUpIcon className="h-5 w-5" /> : <ChevronDownIcon className="h-5 w-5" />}
                  </button>
                  {expanded && (
                    <div className="space-y-3 border-t border-gray-100 p-4">
                      {(run.transfers || []).map((transfer) => (
                        <TransferReceipt key={transfer.id} transfer={transfer} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
        {pagination.totalPages > 1 && (
          <div className="mt-4 flex items-center justify-center gap-3">
            <button
              type="button"
              className="btn-secondary btn-sm"
              disabled={runsPage <= 1 || runsQuery.isFetching}
              onClick={() => setRunsPage((page) => Math.max(1, page - 1))}
            >
              Previous
            </button>
            <span className="text-sm text-gray-500">Page {pagination.page} of {pagination.totalPages}</span>
            <button
              type="button"
              className="btn-secondary btn-sm"
              disabled={runsPage >= pagination.totalPages || runsQuery.isFetching}
              onClick={() => setRunsPage((page) => page + 1)}
            >
              Next
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
