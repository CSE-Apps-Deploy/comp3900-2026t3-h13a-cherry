import {
  CheckCircleIcon,
  ClockIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { formatDateTimeWithYear as formatDate } from '../lib/formatters';

const refundView = {
  PROCESSING: {
    label: 'Refund processing',
    description:
      'Stripe is processing or reconciling the full refund. This status will update after confirmation.',
    className: 'border-sky-200 bg-sky-50 text-sky-800',
  },
  SUCCEEDED: {
    label: 'Refund completed',
    description: 'Stripe confirmed the full refund to the learner’s original payment method.',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  },
  FAILED: {
    label: 'Refund needs attention',
    description: 'The refund could not be completed. An administrator can retry it safely.',
    className: 'border-red-200 bg-red-50 text-red-800',
  },
};

const clearedDescription = (booking) => {
  const resolution = booking?.completionResolution;
  if (booking?.isTrialLesson) {
    if (resolution === 'LEARNER_CONFIRMED') {
      return 'The learner confirmed that the free trial was completed. No earning or payout was created.';
    }
    if (resolution === 'WINDOW_EXPIRED') {
      return 'No issue was reported within 48 hours, so the free-trial review closed automatically. No earning or payout was created.';
    }
    if (resolution === 'ADMIN_APPROVED_TUTOR') {
      return 'An administrator confirmed the free-trial completion outcome. No earning or payout was created.';
    }
    return 'The free-trial completion review is closed. No financial transaction was created.';
  }
  if (resolution === 'LEARNER_CONFIRMED') {
    return 'The learner confirmed that the lesson was completed. The earning is eligible for a future payout.';
  }
  if (resolution === 'WINDOW_EXPIRED') {
    return 'No issue was reported within 48 hours. The review closed automatically and the earning is eligible for a future payout.';
  }
  if (resolution === 'ADMIN_APPROVED_TUTOR') {
    return 'An administrator reviewed the dispute and approved the tutor earning for a future payout.';
  }
  return 'The completion review is closed and its outcome is read-only.';
};

export default function PostLessonResolutionPanel({
  booking,
  isLearner,
  timeZone,
  compact = false,
  isConfirming = false,
  isDisputing = false,
  onConfirm,
  onDispute,
}) {
  const status = booking?.completionReviewStatus;
  if (!status) return null;

  const refund = booking?.payment?.refund || null;
  const resolvedAt = booking?.completionReviewResolvedAt || null;
  const wrapperSpacing = compact ? 'mt-2 px-3 py-2' : 'p-5';

  if (status === 'RESOLVED_LEARNER') {
    const currentRefundView = refundView[refund?.status] || null;
    const isTestPayment = Boolean(booking.payment?.isTestPayment);
    const tutorReported = booking.completionResolution === 'TUTOR_REPORTED_NOT_COMPLETED';
    return (
      <section
        id="post-lesson-resolution"
        className={`${wrapperSpacing} rounded-2xl border border-violet-200 bg-violet-50 text-violet-950`}
      >
        <p className="text-xs font-semibold uppercase tracking-wide">Final lesson outcome</p>
        <p className={`${compact ? 'mt-1 text-xs' : 'mt-2 text-sm'} leading-6`}>
          {tutorReported
            ? 'The tutor reported that this lesson was not completed. No tutor earning is payable.'
            : 'An administrator resolved the completion dispute in the learner’s favour. No tutor earning is payable.'}
        </p>
        {currentRefundView ? (
          <div className={`mt-3 rounded-xl border px-3 py-2 ${currentRefundView.className}`}>
            <p className="font-semibold">
              {isTestPayment ? `Simulated ${currentRefundView.label.toLowerCase()}` : currentRefundView.label}
              {refund.amount ? ` · ${refund.currency} ${Number(refund.amount).toFixed(2)}` : ''}
            </p>
            <p className="mt-1 text-xs leading-5">
              {isTestPayment
                ? refund.status === 'SUCCEEDED'
                  ? 'The local simulator completed this refund. No real money was moved.'
                  : 'This refund belongs to the local test simulation. No real money moves.'
                : currentRefundView.description}
            </p>
            {refund.failureReason && (
              <p className="mt-1 text-xs font-medium">{refund.failureReason}</p>
            )}
          </div>
        ) : (
          <p className="mt-2 text-xs font-medium text-violet-800">
            This was a free trial, so no learner refund or tutor payout was created.
          </p>
        )}
        {resolvedAt && (
          <p className="mt-2 text-xs text-violet-700">
            Finalised {formatDate(resolvedAt, timeZone)}
          </p>
        )}
      </section>
    );
  }

  if (status === 'CLEARED') {
    return (
      <section
        id="post-lesson-resolution"
        className={`${wrapperSpacing} rounded-2xl border border-emerald-200 bg-emerald-50 text-emerald-950`}
      >
        <div className="flex items-start gap-2">
          <CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide">Completion review closed</p>
            <p className={`${compact ? 'mt-1 text-xs' : 'mt-2 text-sm'} leading-6`}>
              {clearedDescription(booking)}
            </p>
            {resolvedAt && (
              <p className="mt-1 text-xs text-emerald-700">
                Finalised {formatDate(resolvedAt, timeZone)}
              </p>
            )}
          </div>
        </div>
      </section>
    );
  }

  if (status === 'DISPUTED') {
    return (
      <section
        id="post-lesson-resolution"
        className={`${wrapperSpacing} rounded-2xl border border-orange-200 bg-orange-50 text-orange-950`}
      >
        <div className="flex items-start gap-2">
          <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-orange-700" />
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide">Completion under review</p>
            <p className={`${compact ? 'mt-1 text-xs' : 'mt-2 text-sm'} leading-6`}>
              {isLearner
                ? 'You reported that this lesson was not completed. TutorConnect support has been notified. Please contact support if you have any additional information that may help resolve the dispute.'
                : 'The learner reported that this lesson was not completed. Your earning is paused. Please contact TutorConnect support with any information that may help resolve the dispute.'}
            </p>
            {booking.completionDisputeReason && (
              <p className={`${compact ? 'mt-1 text-xs' : 'mt-2 text-sm'} font-medium`}>
                Reported reason: {booking.completionDisputeReason}
              </p>
            )}
          </div>
        </div>
      </section>
    );
  }

  if (status !== 'AWAITING_LEARNER') return null;

  const canConfirm = Boolean(booking.availableActions?.canConfirmCompletion);
  const canDispute = Boolean(booking.availableActions?.canDisputeCompletion);

  return (
    <section
      id="post-lesson-resolution"
      className={`${wrapperSpacing} rounded-2xl border border-sky-200 bg-sky-50 text-sky-950`}
    >
      <div className="flex items-start gap-2">
        <ClockIcon className="mt-0.5 h-4 w-4 shrink-0 text-sky-700" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wide">48-hour completion review</p>
          <p className={`${compact ? 'mt-1 text-xs' : 'mt-2 text-sm'} leading-6`}>
            {booking.isTrialLesson
              ? isLearner
                ? `No action is required if the free trial was completed. If you take no action before ${formatDate(booking.completionReviewDueAt, timeZone)}, it will be treated as completed and the review will close. You can confirm now to close the review early, or report a problem if the lesson did not take place. No earning, payout or refund applies to a free trial.`
                : `The learner can confirm this free trial or report a problem until ${formatDate(booking.completionReviewDueAt, timeZone)}. If they take no action, the review closes automatically. No earning, payout or refund applies.`
              : isLearner
                ? `No action is required if the lesson was completed. If you take no action before ${formatDate(booking.completionReviewDueAt, timeZone)}, the lesson will be treated as completed and the tutor’s earning will become eligible for payout. You can confirm now to complete the review early, or report a problem if the lesson did not take place.`
                : `The learner can confirm this lesson or report a problem until ${formatDate(booking.completionReviewDueAt, timeZone)}. If they take no action, the earning becomes eligible for a future payout when the window closes.`}
          </p>
          {isLearner && (canConfirm || canDispute) && (
            <div className="mt-3 flex flex-wrap gap-2">
              {canConfirm && (
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  disabled={isConfirming || isDisputing}
                  onClick={onConfirm}
                >
                  <CheckCircleIcon className="h-4 w-4" />
                  {isConfirming ? 'Confirming…' : 'Confirm lesson completed'}
                </button>
              )}
              {canDispute && (
                <button
                  type="button"
                  className="btn-danger btn-sm"
                  disabled={isConfirming || isDisputing}
                  onClick={onDispute}
                >
                  <ExclamationTriangleIcon className="h-4 w-4" />
                  {isDisputing ? 'Reporting…' : 'Report lesson not completed'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
