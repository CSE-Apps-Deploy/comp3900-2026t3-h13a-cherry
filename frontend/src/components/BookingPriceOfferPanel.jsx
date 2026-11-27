'use client';

import { useEffect, useState } from 'react';
import {
  ArrowTrendingDownIcon,
  ArrowTrendingUpIcon,
  BanknotesIcon,
  CheckCircleIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline';
import EarningPreview from './EarningPreview';
import { calculateClientEarningPreview } from '../lib/earnings';
import { formatCurrency } from '../lib/formatters';
import { cn } from '../lib/utils';

const STATUS_STYLES = {
  PENDING: 'border-amber-200 bg-amber-50 text-amber-800',
  ACCEPTED: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  SUPERSEDED: 'border-gray-200 bg-gray-50 text-gray-600',
  REJECTED: 'border-red-200 bg-red-50 text-red-700',
  WITHDRAWN: 'border-gray-200 bg-gray-50 text-gray-600',
  CANCELLED: 'border-gray-200 bg-gray-50 text-gray-600',
};

const getPriceOfferStatusLabel = (status, { isLearner, isTutor }) => {
  if (status === 'PENDING') {
    if (isLearner) return 'Your response needed';
    if (isTutor) return 'Waiting for learner';
    return 'Waiting for response';
  }
  if (status === 'ACCEPTED') return 'Current price';
  if (status === 'SUPERSEDED') return 'Previous price';
  if (status === 'REJECTED') return 'Rejected';
  if (status === 'WITHDRAWN') return 'Withdrawn';
  if (status === 'CANCELLED') return 'Booking cancelled';
  return status || 'Unknown';
};

const getBookingTotal = (booking) => {
  const total = Number(booking?.totalAmount);
  if (Number.isFinite(total)) return total;
  return (Number(booking?.hourlyRate || 0) * Number(booking?.duration || 0)) / 60;
};

const hasAtMostTwoDecimalPlaces = (value) => /^\d+(?:\.\d{0,2})?$/.test(value);

export const getPendingPriceOffer = (booking) =>
  (booking?.priceOffers || []).find((offer) => offer.status === 'PENDING') || null;

export const hasPendingPriceOffer = (booking) => Boolean(getPendingPriceOffer(booking));

export default function BookingPriceOfferPanel({
  booking,
  isTutor = false,
  isLearner = false,
  onPropose,
  onAccept,
  onReject,
  onWithdraw,
  mutationAction = '',
  compact = false,
  seriesTotal = null,
  className,
}) {
  const [isFormOpen, setIsFormOpen] = useState(!compact);
  const [proposedTotal, setProposedTotal] = useState('');
  const [reason, setReason] = useState('');
  const [validationError, setValidationError] = useState('');

  const actions = booking?.availableActions || {};
  const offers = Array.isArray(booking?.priceOffers) ? booking.priceOffers : [];
  const pendingOffer = getPendingPriceOffer(booking);
  const canPropose = isTutor && Boolean(actions.canProposePriceOffer) && !pendingOffer;
  const canRespond = isLearner && Boolean(actions.canRespondPriceOffer) && Boolean(pendingOffer);
  const canWithdraw = isTutor && Boolean(actions.canWithdrawPriceOffer) && Boolean(pendingOffer);
  const currentTotal = getBookingTotal(booking);
  const currency = pendingOffer?.currency || booking?.currency || 'AUD';
  const isBusy = Boolean(mutationAction);
  const proposedAmount = Number(proposedTotal);
  const proposedEarningPreview =
    isTutor && Number.isFinite(proposedAmount) && proposedAmount > 0
      ? calculateClientEarningPreview({
          amount: proposedAmount,
          currency,
          commissionPercent: booking?.earningPreview?.commissionPercent || 15,
        })
      : null;

  useEffect(() => {
    setProposedTotal('');
    setReason('');
    setValidationError('');
    setIsFormOpen(!compact);
  }, [booking?.id, booking?.version, compact]);

  if (booking?.isTrialLesson || (!canPropose && offers.length === 0)) {
    return null;
  }

  const handleSubmit = (event) => {
    event.preventDefault();
    const normalizedAmount = proposedTotal.trim();
    const amount = Number(normalizedAmount);

    if (
      !normalizedAmount ||
      !hasAtMostTwoDecimalPlaces(normalizedAmount) ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      setValidationError('Enter a positive price with no more than two decimal places.');
      return;
    }

    if (Math.round(amount * 100) === Math.round(currentTotal * 100)) {
      setValidationError('The proposed price must be different from the current price.');
      return;
    }

    setValidationError('');
    onPropose?.({
      proposedTotal: amount,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    });
  };

  return (
    <section
      aria-label="Lesson price adjustment"
      className={cn(
        'rounded-2xl border border-indigo-100 bg-indigo-50/60',
        compact ? 'p-3' : 'p-5',
        className
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="rounded-xl bg-white p-2 text-indigo-600 shadow-sm" aria-hidden="true">
            <BanknotesIcon className="h-5 w-5" />
          </span>
          <div>
            <h3 className="font-semibold text-gray-900">Lesson price adjustment</h3>
            <p className="mt-0.5 text-xs leading-5 text-gray-600">
              {isTutor
                ? 'Offer a different price for this lesson only. The learner will need to approve it.'
                : 'Your tutor has offered a new price for this lesson.'}
            </p>
          </div>
        </div>
        {canPropose && compact && !isFormOpen && (
          <button
            type="button"
            onClick={() => setIsFormOpen(true)}
            className="btn-secondary btn-sm"
          >
            Adjust price
          </button>
        )}
      </div>

      {isTutor && !isFormOpen && (
        <EarningPreview preview={booking?.earningPreview} className="mt-4" />
      )}

      {canPropose && isFormOpen && (
        <form className="mt-4 space-y-3" onSubmit={handleSubmit} noValidate>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`proposed-price-${booking.id}`} className="label">
                New lesson price ({currency})
              </label>
              <input
                id={`proposed-price-${booking.id}`}
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.01"
                value={proposedTotal}
                onChange={(event) => {
                  setProposedTotal(event.target.value);
                  setValidationError('');
                }}
                disabled={isBusy}
                aria-describedby={`current-price-${booking.id}${validationError ? ` price-error-${booking.id}` : ''}`}
                className="input"
                placeholder="0.00"
              />
              <p id={`current-price-${booking.id}`} className="mt-1 text-xs text-gray-500">
                Current price: {formatCurrency(currentTotal, currency)}
              </p>
              {validationError && (
                <p id={`price-error-${booking.id}`} role="alert" className="error-text">
                  {validationError}
                </p>
              )}
            </div>
            <div>
              <label htmlFor={`price-reason-${booking.id}`} className="label">
                Reason (optional)
              </label>
              <textarea
                id={`price-reason-${booking.id}`}
                rows={2}
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                disabled={isBusy}
                className="input resize-none"
                placeholder="For example, a loyalty discount"
              />
            </div>
          </div>
          <EarningPreview
            preview={proposedEarningPreview || booking?.earningPreview}
            title={proposedEarningPreview ? 'Earnings at this proposed price' : 'Current earnings'}
          />
          <div className="flex flex-wrap justify-end gap-2">
            {compact && (
              <button
                type="button"
                onClick={() => {
                  setIsFormOpen(false);
                  setValidationError('');
                }}
                disabled={isBusy}
                className="btn-secondary btn-sm"
              >
                Cancel
              </button>
            )}
            <button type="submit" disabled={isBusy} className="btn-primary btn-sm">
              {mutationAction === 'propose' ? 'Sending...' : 'Send price offer'}
            </button>
          </div>
        </form>
      )}

      {offers.length > 0 && (
        <div className="mt-4 space-y-3">
          {offers.map((offer, index) => {
            const originalTotal = Number(offer.originalTotal || 0);
            const nextTotal = Number(offer.proposedTotal || 0);
            const difference = nextTotal - originalTotal;
            const isDecrease = difference < 0;
            const isIncrease = difference > 0;
            const isPending = offer.status === 'PENDING';
            const offerCurrency = offer.currency || currency;
            const numericSeriesTotal = seriesTotal == null ? null : Number(seriesTotal);
            const projectedSeriesTotal = Number.isFinite(numericSeriesTotal)
              ? numericSeriesTotal + difference
              : null;

            return (
              <article
                key={offer.id}
                className="rounded-xl border border-indigo-100 bg-white p-4"
                aria-label={`${index === 0 ? 'Latest' : 'Previous'} price offer`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700">
                    {index === 0 ? 'Latest price offer' : 'Previous price offer'}
                  </p>
                  <span
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-xs font-medium',
                      STATUS_STYLES[offer.status] || STATUS_STYLES.WITHDRAWN
                    )}
                  >
                    {getPriceOfferStatusLabel(offer.status, { isLearner, isTutor })}
                  </span>
                </div>

                <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-gray-400">
                      {isPending ? 'Current price' : 'Price before offer'}
                    </dt>
                    <dd className="mt-1 font-medium text-gray-700">
                      {formatCurrency(originalTotal, offerCurrency)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-gray-400">Proposed price</dt>
                    <dd className="mt-1 font-semibold text-gray-900">
                      {formatCurrency(nextTotal, offerCurrency)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-gray-400">
                      {isDecrease ? 'Decrease' : isIncrease ? 'Increase' : 'Difference'}
                    </dt>
                    <dd
                      className={cn(
                        'mt-1 inline-flex items-center gap-1 font-semibold',
                        isDecrease ? 'text-emerald-700' : isIncrease ? 'text-amber-700' : 'text-gray-700'
                      )}
                    >
                      {isDecrease && <ArrowTrendingDownIcon className="h-4 w-4" aria-hidden="true" />}
                      {isIncrease && <ArrowTrendingUpIcon className="h-4 w-4" aria-hidden="true" />}
                      {isIncrease ? '+' : isDecrease ? '−' : ''}
                      {formatCurrency(Math.abs(difference), offerCurrency)}
                    </dd>
                  </div>
                </dl>

                {isTutor && (
                  <EarningPreview
                    preview={offer.earningPreview}
                    title="Earnings at the proposed price"
                    className="mt-3"
                  />
                )}

                {isPending && projectedSeriesTotal !== null && (
                  <p className="mt-3 rounded-lg border border-sky-100 bg-sky-50 px-3 py-2 text-sm font-medium text-sky-800">
                    Series total if accepted: {formatCurrency(projectedSeriesTotal, offerCurrency)}
                  </p>
                )}

                {offer.reason && (
                  <div className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
                    <span className="font-medium">Tutor’s note:</span> {offer.reason}
                  </div>
                )}

                {isPending && canRespond && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => onAccept?.(offer.id)}
                      disabled={isBusy}
                      className="btn-primary btn-sm gap-1.5"
                    >
                      <CheckCircleIcon className="h-4 w-4" aria-hidden="true" />
                      {mutationAction === 'accept' ? 'Accepting...' : 'Accept new price'}
                    </button>
                    <button
                      type="button"
                      onClick={() => onReject?.(offer.id)}
                      disabled={isBusy}
                      className="btn-danger btn-sm gap-1.5"
                    >
                      <XCircleIcon className="h-4 w-4" aria-hidden="true" />
                      {mutationAction === 'reject' ? 'Keeping current price...' : 'Keep current price'}
                    </button>
                  </div>
                )}

                {isPending && canWithdraw && (
                  <div className="mt-4 flex justify-end">
                    <button
                      type="button"
                      onClick={() => onWithdraw?.(offer.id)}
                      disabled={isBusy}
                      className="btn-secondary btn-sm"
                    >
                      {mutationAction === 'withdraw' ? 'Withdrawing...' : 'Withdraw offer'}
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
