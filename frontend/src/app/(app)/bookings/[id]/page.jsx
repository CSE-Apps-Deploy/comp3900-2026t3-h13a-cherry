// src/app/(app)/bookings/[id]/page.jsx -  Booking Detail Page
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import {
  CalendarDaysIcon,
  ClockIcon,
  ChatBubbleLeftRightIcon,
  CheckCircleIcon,
  StarIcon,
  XCircleIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { bookingApi, paymentApi, reviewApi, tutorApi } from '../../../../lib/api-entry';
import {
  ACCEPTANCE_OUTCOMES,
  getAcceptanceErrorDetails,
  getAcceptanceOutcome,
  getTutorBookingActionHint,
  hasProcessingPayment,
  summarizeAcceptanceResults,
} from '../../../../lib/booking-acceptance';
import { getAvatarUrl } from '../../../../lib/avatar';
import { formatBookingStatus, getBookingStatusClass as getStatusClass } from '../../../../lib/booking-status';
import { formatCurrency, formatDateTimeWithYear as formatDate, formatDuration, getUserTimezone } from '../../../../lib/formatters';
import { formatSavedMethod } from '../../../../lib/payment-display';
import {
  canChangePendingRequestedTime,
  canTutorChooseAnyFreeTime,
  getTimeNegotiationHistory,
} from '../../../../lib/pending-booking-reschedule';
import {
  getDisplayStatusLabel,
  getRecurringDisplayStatus,
  getPayableSeriesBookings,
  getRecurringLabel,
  getRecurringSeriesBookings,
  getRecurringStatusSummary,
  getSeriesTotalAmount,
  isRecurringBooking,
} from '../../../../lib/recurring-bookings';
import { useAuthStore } from '../../../../lib/store';
import BackButton from '../../../../components/BackButton';
import { TestPaymentBadge } from '../../../../components/PaymentTestNotice';
import SessionLinkCard from '../../../../components/SessionLinkCard';
import AvailabilityCalendar from '../../../../components/AvailabilityCalendar';
import { StarRatingDisplay, StarRatingInput } from '../../../../components/StarRating';
import CancellationPolicySummary from '../../../../components/CancellationPolicySummary';
import EarningPreview from '../../../../components/EarningPreview';
import PostLessonResolutionPanel from '../../../../components/PostLessonResolutionPanel';
import BookingPriceOfferPanel, {
  hasPendingPriceOffer,
} from '../../../../components/BookingPriceOfferPanel';
import { getCancellationState } from '../../../../lib/cancellation-policy';

const rescheduleSchema = z.object({
  newDate: z.string().min(1, 'Please select a new date'),
  reason: z.string().optional(),
});

const getLatestStatusReason = (booking, status) =>
  booking?.statusHistory?.find((entry) => entry.status === status)?.reason || '';

const getCancellationOutcome = (booking) => {
  const outcome = booking?.cancellationOutcome;
  if (!outcome) return null;

  if (typeof outcome === 'string') {
    try {
      return JSON.parse(outcome);
    } catch {
      return null;
    }
  }

  return outcome;
};

const getCancellationActorLabel = (actorRole) => {
  if (actorRole === 'LEARNER') return 'Learner';
  if (actorRole === 'TUTOR') return 'Tutor';
  if (actorRole === 'ADMIN') return 'Administrator';
  return 'Unknown';
};

const invalidateBookingViews = async ({ queryClient, currentUserId, id, bookingTutorId }) => {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['booking', currentUserId, id] }),
    queryClient.invalidateQueries({ queryKey: ['bookings', currentUserId] }),
    queryClient.invalidateQueries({ queryKey: ['myBookings'] }),
    queryClient.invalidateQueries({ queryKey: ['myBookings', 'dashboard', currentUserId] }),
    queryClient.invalidateQueries({ queryKey: ['myBookings', 'calendar', currentUserId] }),
    queryClient.invalidateQueries({ queryKey: ['tutor-requests'] }),
    queryClient.invalidateQueries({ queryKey: ['tutor-bookings'] }),
    queryClient.invalidateQueries({ queryKey: ['tutor-bookings-all'] }),
    queryClient.invalidateQueries({ queryKey: ['notifications', currentUserId] }),
    queryClient.invalidateQueries({ queryKey: ['savedPaymentMethod', currentUserId] }),
    queryClient.invalidateQueries({ queryKey: ['tutor-earnings'] }),
    queryClient.invalidateQueries({ queryKey: ['admin-payout-overview'] }),
    bookingTutorId
      ? queryClient.invalidateQueries({ queryKey: ['tutor-availability', bookingTutorId] })
      : Promise.resolve(),
  ]);
};
export default function BookingDetailPage() {
  const { id } = useParams();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { user, fetchMe } = useAuthStore();
  const timeZone = getUserTimezone(user);
  const currentUserId = user?.id || '';
  const [showRescheduleModal, setShowRescheduleModal] = useState(false);
  // Kept on screen rather than in a toast so the tutor can act on the link.
  const [payoutSetupPrompt, setPayoutSetupPrompt] = useState(null);
  const [handledRequestedAction, setHandledRequestedAction] = useState(false);
  const [rescheduleTargetBooking, setRescheduleTargetBooking] = useState(null);
  const [selectedSeriesBookingIds, setSelectedSeriesBookingIds] = useState([]);
  const [selectedRescheduleSlot, setSelectedRescheduleSlot] = useState(null);
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewComment, setReviewComment] = useState('');

  const from = (searchParams.get('from') || '').toLowerCase();
  const returnTo = searchParams.get('returnTo') || '';
  const paymentResult = (searchParams.get('payment') || '').toLowerCase();
  const showBackButton = Boolean(returnTo || from);
  const paymentMethodResult = (searchParams.get('paymentMethod') || '').toLowerCase();
  const requestedAction = (searchParams.get('action') || '').toLowerCase();
  const backConfigMap = {
    'tutor-requests': { href: '/tutor/requests', label: 'Back' },
    'tutor-dashboard': { href: '/tutor/dashboard', label: 'Back' },
    dashboard: { href: '/dashboard', label: 'Back' },
    notifications: { href: '/notifications', label: 'Back' },
    search: { href: '/search', label: 'Back' },
    bookings: { href: '/bookings', label: 'Back' },
  };
  const backConfig = backConfigMap[from] || null;
  const backHref = returnTo || backConfig?.href || '/bookings';
  const backLabel = backConfig?.label || 'Back';

  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['booking', currentUserId, id],
    queryFn: () => bookingApi.getById(id),
    enabled: !!id && !!currentUserId,
    refetchInterval: (query) => {
      const currentBooking = query.state.data?.data?.data;
      const occurrences = [
        currentBooking,
        ...(currentBooking?.recurringSeries?.bookings || []),
      ].filter(Boolean);
      const hasProcessingRefund = occurrences.some(
        (occurrence) => occurrence?.payment?.refund?.status === 'PROCESSING'
      );
      const hasOpenCompletionReview = occurrences.some(
        (occurrence) => occurrence?.completionReviewStatus === 'AWAITING_LEARNER'
      );
      return hasProcessingPayment(currentBooking) ||
        hasProcessingRefund
        ? 5000
        : hasOpenCompletionReview
          ? 30000
          : false;
    },
  });

  const booking = data?.data?.data;
  const isTutor = user?.role === 'TUTOR';
  const isLearner = user?.role === 'LEARNER';

  const savedMethodQuery = useQuery({
    queryKey: ['savedPaymentMethod', currentUserId],
    queryFn: () => paymentApi.getSavedMethod(),
    enabled: !!currentUserId && !!isLearner,
  });
  const other = isTutor ? booking?.learner : booking?.tutorProfile?.user || booking?.tutor;
  const bookingTutorId = booking?.tutorProfile?.id || booking?.tutor?.id || booking?.tutorId;
  const rescheduleAvailabilityQuery = useQuery({
    queryKey: ['tutor-availability', bookingTutorId, 'reschedule'],
    queryFn: () => tutorApi.getAvailability(bookingTutorId),
    enabled: !!bookingTutorId && showRescheduleModal,
  });
  const bookingDetailHref = (() => {
    const params = new URLSearchParams();
    if (returnTo) params.set('returnTo', returnTo);
    if (from) params.set('from', from);
    if (paymentResult) params.set('payment', paymentResult);
    const query = params.toString();
    return query ? `/bookings/${id}?${query}` : `/bookings/${id}`;
  })();
  const tutorDetailHref = (() => {
    if (isTutor) return null;
    if (!bookingTutorId) return null;

    const params = new URLSearchParams();
    params.set('returnTo', bookingDetailHref);
    const query = params.toString();

    return query ? `/tutors/${bookingTutorId}?${query}` : `/tutors/${bookingTutorId}`;
  })();
  const paymentStatus = booking?.payment?.status || 'PENDING';
  const savedMethod = savedMethodQuery.data?.data?.data?.paymentMethod || null;
  const isPaidBooking = ['PAID', 'COMPLETED'].includes(paymentStatus);
  const isRefunded = ['REFUNDED', 'PARTIALLY_REFUNDED'].includes(paymentStatus);
  const isProcessingPayment = paymentStatus === 'PROCESSING';
  const isFailedPayment = paymentStatus === 'FAILED';
  const paymentAttempts = booking?.payment?.attempts || [];
  const isAcceptedBooking = booking?.status === 'ACCEPTED';
  const cancellationOutcome = getCancellationOutcome(booking);
  const hasCancellationOutcome = booking?.status === 'CANCELLED' && cancellationOutcome;
  const recurring = isRecurringBooking(booking);
  const actions = booking?.availableActions || {};
  const cancellationState = getCancellationState(booking, { isLearner, isTutor });
  const canCancel = !recurring && actions.canCancel;
  const latestRescheduleReason = getLatestStatusReason(booking, 'RESCHEDULED');
  const pendingRescheduleRequests = (booking?.rescheduleRequests || []).filter(
    (request) => request.status === 'PENDING'
  );
  const pendingRescheduleRequest = pendingRescheduleRequests[0] || null;
  const tutorProposedPendingTime = booking?.negotiationStatus === 'TIME_PROPOSED_BY_TUTOR';
  const learnerProposedPendingTime = booking?.negotiationStatus === 'TIME_PROPOSED_BY_LEARNER';
  const canProposeReschedule = actions.canProposeReschedule;
  const canTutorProposePendingTime = !recurring && actions.canProposePendingTime;
  const canChangeRequestedTime = canChangePendingRequestedTime(booking, {
    isLearner,
    isRecurring: recurring,
  });
  const pendingProposalIsMine = Boolean(
    pendingRescheduleRequest &&
    ((isLearner && pendingRescheduleRequest.proposedBy === 'LEARNER') ||
      (isTutor && pendingRescheduleRequest.proposedBy === 'TUTOR'))
  );
  const hasPendingRescheduleProposal =
    booking?.status === 'ACCEPTED' && pendingProposalIsMine;
  const timeNegotiationHistory = getTimeNegotiationHistory(booking);
  const recurringReviewBookings = getRecurringSeriesBookings(booking);
  const review = booking?.review || null;
  const recurringCompletedSessions = recurringReviewBookings.filter(
    (seriesBooking) =>
      seriesBooking.status === 'COMPLETED' &&
      seriesBooking.completionReviewStatus === 'CLEARED'
  ).length;
  const reviewEligible =
    isLearner &&
    (
      recurring
        ? recurringCompletedSessions > 0
        : booking?.status === 'COMPLETED' && booking?.completionReviewStatus === 'CLEARED'
    );
  const canLeaveReview = reviewEligible && !review;
  const canUpdateReview = reviewEligible && recurring && !!review;
  const canDeleteReview = isLearner && review?.learnerId === currentUserId;
  const activeRescheduleBooking = rescheduleTargetBooking || booking;
  const isPendingRequestedTimeChange =
    isLearner && activeRescheduleBooking?.status === 'PENDING';
  const isPendingTutorProposal =
    isTutor && activeRescheduleBooking?.status === 'PENDING';
  const tutorCanChooseAnyFreeTime = canTutorChooseAnyFreeTime(activeRescheduleBooking, {
    isTutor,
  });
  const rescheduleAvailabilityState = rescheduleAvailabilityQuery.data?.data?.data || {};
  const rescheduleAvailability = rescheduleAvailabilityState?.availability || [];
  const rescheduleCurrentWeekAvailability =
    rescheduleAvailabilityState?.currentWeekEffectiveAvailability || rescheduleAvailability;
  const rescheduleHasCurrentWeekAvailabilityOverride = Boolean(
    rescheduleAvailabilityState?.hasCurrentWeekAvailabilityOverride
  );
  const rescheduleBookedSlots = (rescheduleAvailabilityState?.bookedSlots || []).filter(
    (slot) => slot?.id !== activeRescheduleBooking?.id
  );

  const promptForReason = ({ title, required = false, defaultValue = '' }) => {
    const value = window.prompt(title, defaultValue);
    if (value === null) return null;
    const trimmed = value.trim();
    if (required && !trimmed) {
      toast.error('Please provide a short reason.');
      return null;
    }
    return trimmed;
  };

  const cancelMutation = useMutation({
    mutationFn: ({ targetId, reason }) => bookingApi.cancel(targetId, reason),
    onSuccess: async (response) => {
      toast.success(response?.data?.message || 'Booking cancelled');
      await invalidateBookingViews({ queryClient, currentUserId, id, bookingTutorId });
      fetchMe();
    },
    onError: (err) => {
      toast.error(err?.response?.data?.message || 'Failed to cancel booking');
    },
  });

  const cancelSeriesMutation = useMutation({
    mutationFn: async ({ targetIds, reason }) => {
      const results = await Promise.allSettled(
        targetIds.map((targetId) => bookingApi.cancel(targetId, reason))
      );
      const successCount = results.filter((result) => result.status === 'fulfilled').length;
      const failedCount = results.length - successCount;
      return { successCount, failedCount };
    },
    onSuccess: async ({ successCount, failedCount }) => {
      if (successCount > 0 && failedCount > 0) {
        toast.success(`${successCount} sessions cancelled. ${failedCount} could not be cancelled.`);
      } else if (successCount > 0) {
        toast.success(`${successCount} sessions cancelled.`);
      } else {
        toast.error('No sessions could be cancelled.');
      }

      await invalidateBookingViews({ queryClient, currentUserId, id, bookingTutorId });
    },
    onError: () => {
      toast.error('Failed to cancel recurring booking');
    },
  });

  const acceptMutation = useMutation({
    mutationFn: ({ targetId, expectedVersion }) =>
      bookingApi.accept(targetId, { expectedVersion }),
    onSuccess: async (response) => {
      const outcome = getAcceptanceOutcome(response);
      toast.success(
        outcome === ACCEPTANCE_OUTCOMES.PAYMENT_PROCESSING
          ? 'Payment is processing. The booking remains pending until it succeeds.'
          : response?.data?.message || 'Session accepted!'
      );
      await invalidateBookingViews({ queryClient, currentUserId, id, bookingTutorId });
    },
    onError: (err) => {
      const details = getAcceptanceErrorDetails(err);
      toast.error(details.message);
      // Only the tutor gets a link; the learner-facing variant carries none.
      setPayoutSetupPrompt(
        details.requiresPayoutSetup && details.link
          ? { message: details.message, link: details.link }
          : null
      );
      if (
        err?.response?.status === 409 ||
        details.requiresPaymentMethod ||
        details.code === 'PAYMENT_PROVIDER_UNAVAILABLE'
      ) {
        invalidateBookingViews({ queryClient, currentUserId, id, bookingTutorId });
      }
    },
  });

  const acceptPendingTimeProposalMutation = useMutation({
    mutationFn: () =>
      bookingApi.acceptPendingTimeProposal(id, { expectedVersion: booking.version }),
    onSuccess: async (response) => {
      const outcome = getAcceptanceOutcome(response);
      toast.success(
        outcome === ACCEPTANCE_OUTCOMES.PAYMENT_PROCESSING
          ? 'Payment is processing. The booking remains pending until it succeeds.'
          : response?.data?.message || 'Proposed time accepted'
      );
      await invalidateBookingViews({ queryClient, currentUserId, id, bookingTutorId });
      fetchMe();
    },
    onError: async (err) => {
      const details = getAcceptanceErrorDetails(err);
      toast.error(details.message);
      if (err?.response?.status === 409 || details.requiresPaymentMethod) {
        await invalidateBookingViews({ queryClient, currentUserId, id, bookingTutorId });
      }
    },
  });

  const rejectPendingTimeProposalMutation = useMutation({
    mutationFn: (reason) =>
      bookingApi.rejectPendingTimeProposal(id, {
        expectedVersion: booking.version,
        reason,
      }),
    onSuccess: async (response) => {
      toast.success(response?.data?.message || 'Proposed time rejected');
      await invalidateBookingViews({ queryClient, currentUserId, id, bookingTutorId });
    },
    onError: async (err) => {
      toast.error(err?.response?.data?.message || 'Failed to reject proposed time');
      if (err?.response?.status === 409) {
        await invalidateBookingViews({ queryClient, currentUserId, id, bookingTutorId });
      }
    },
  });

  const priceOfferMutation = useMutation({
    mutationFn: ({ action, targetBooking, offerId, payload = {} }) => {
      const versionedPayload = {
        ...payload,
        expectedVersion: targetBooking.version,
      };

      if (action === 'propose') {
        return bookingApi.proposePriceOffer(targetBooking.id, versionedPayload);
      }
      if (action === 'accept') {
        return bookingApi.acceptPriceOffer(targetBooking.id, offerId, versionedPayload);
      }
      if (action === 'reject') {
        return bookingApi.rejectPriceOffer(targetBooking.id, offerId, versionedPayload);
      }
      if (action === 'withdraw') {
        return bookingApi.withdrawPriceOffer(targetBooking.id, offerId, versionedPayload);
      }

      throw new Error('Unsupported price offer action');
    },
    onSuccess: async (response, variables) => {
      const fallbackMessages = {
        propose: 'Price offer sent to the learner',
        accept: 'New price accepted',
        reject: 'Current price kept',
        withdraw: 'Price offer withdrawn',
      };
      toast.success(response?.data?.message || fallbackMessages[variables.action]);
      await invalidateBookingViews({ queryClient, currentUserId, id, bookingTutorId });
    },
    onError: async (err) => {
      toast.error(err?.response?.data?.message || 'Couldn’t update the price offer');
      if (err?.response?.status === 409) {
        await invalidateBookingViews({ queryClient, currentUserId, id, bookingTutorId });
      }
    },
  });

  const declineMutation = useMutation({
    mutationFn: ({ targetId, reason, expectedVersion }) =>
      bookingApi.decline(targetId, reason, expectedVersion),
    onSuccess: async (response) => {
      toast.success(response?.data?.message || 'Session declined');
      await invalidateBookingViews({ queryClient, currentUserId, id, bookingTutorId });
    },
    onError: (err) => {
      toast.error(err?.response?.data?.message || 'Failed to decline');
    },
  });

  const bulkSeriesDecisionMutation = useMutation({
    mutationFn: async ({ acceptedBookings, declinedIds, declineReason }) => {
      const acceptedResults = await Promise.allSettled(
        acceptedBookings.map((targetBooking) =>
          bookingApi.accept(targetBooking.id, { expectedVersion: targetBooking.version })
        )
      );
      const declinedResults = await Promise.allSettled(
        declinedIds.map((targetId) => {
          const targetBooking = recurringBookings.find((entry) => entry.id === targetId);
          return bookingApi.decline(targetId, declineReason, targetBooking?.version);
        })
      );

      return {
        acceptanceSummary: summarizeAcceptanceResults(acceptedResults),
        declinedSuccessCount: declinedResults.filter((result) => result.status === 'fulfilled').length,
        declinedFailureCount: declinedResults.filter((result) => result.status === 'rejected').length,
      };
    },
    onSuccess: async ({ acceptanceSummary, declinedSuccessCount, declinedFailureCount }) => {
      const { acceptedCount, processingCount, failedCount: acceptedFailureCount } = acceptanceSummary;
      const handledCount = acceptedCount + processingCount + declinedSuccessCount;
      const failedCount = acceptedFailureCount + declinedFailureCount;

      if (handledCount > 0 && failedCount > 0) {
        toast.success(
          `${acceptedCount} accepted, ${processingCount} processing, ${declinedSuccessCount} declined. ${failedCount} could not be updated.`
        );
      } else if (handledCount > 0) {
        toast.success(`${acceptedCount} accepted, ${processingCount} processing, ${declinedSuccessCount} declined.`);
      } else {
        toast.error('No sessions were updated.');
      }

      setSelectedSeriesBookingIds([]);
      await invalidateBookingViews({ queryClient, currentUserId, id, bookingTutorId });
    },
    onError: () => {
      toast.error('Failed to update selected sessions');
    },
  });

  const completeMutation = useMutation({
    mutationFn: ({ targetId, expectedVersion }) =>
      bookingApi.complete(targetId, expectedVersion),
    onSuccess: async () => {
      toast.success('Session marked as complete');
      await invalidateBookingViews({ queryClient, currentUserId, id, bookingTutorId });
    },
    onError: (err) => {
      toast.error(err?.response?.data?.message || 'Failed to complete');
    },
  });

  const notCompletedMutation = useMutation({
    mutationFn: ({ targetId, reason, expectedVersion }) =>
      bookingApi.markNotCompleted(targetId, reason, expectedVersion),
    onSuccess: async (response) => {
      toast.success(response?.data?.message || 'Lesson marked as not completed');
      await invalidateBookingViews({ queryClient, currentUserId, id, bookingTutorId });
    },
    onError: (err) => {
      toast.error(err?.response?.data?.message || 'Could not mark the lesson as not completed');
    },
  });

  const confirmCompletionMutation = useMutation({
    mutationFn: ({ targetId, expectedVersion }) =>
      bookingApi.confirmCompletion(targetId, expectedVersion),
    onSuccess: async (response) => {
      toast.success(response?.data?.message || 'Lesson completion confirmed');
      await invalidateBookingViews({ queryClient, currentUserId, id, bookingTutorId });
    },
    onError: (err) => {
      toast.error(err?.response?.data?.message || 'Could not confirm the lesson');
    },
  });

  const disputeCompletionMutation = useMutation({
    mutationFn: ({ targetId, reason, expectedVersion }) =>
      bookingApi.disputeCompletion(targetId, reason, expectedVersion),
    onSuccess: async () => {
      toast.success('Completion issue sent to TutorConnect support');
      await invalidateBookingViews({ queryClient, currentUserId, id, bookingTutorId });
    },
    onError: (err) => {
      toast.error(err?.response?.data?.message || 'Could not report the completion issue');
    },
  });

  const createReviewMutation = useMutation({
    mutationFn: (payload) => reviewApi.create(payload),
    onSuccess: async (response) => {
      toast.success(response?.data?.message || 'Review submitted');
      await Promise.all([
        invalidateBookingViews({ queryClient, currentUserId, id, bookingTutorId }),
        queryClient.invalidateQueries({ queryKey: ['tutor', bookingTutorId] }),
        queryClient.invalidateQueries({ queryKey: ['tutor-reviews', bookingTutorId] }),
        queryClient.invalidateQueries({ queryKey: ['admin-reviews'] }),
      ]);
    },
    onError: (err) => {
      toast.error(err?.response?.data?.message || 'Failed to submit review');
    },
  });

  const deleteReviewMutation = useMutation({
    mutationFn: (reviewId) => reviewApi.delete(reviewId),
    onSuccess: async () => {
      toast.success('Review deleted');
      await Promise.all([
        invalidateBookingViews({ queryClient, currentUserId, id, bookingTutorId }),
        queryClient.invalidateQueries({ queryKey: ['tutor', bookingTutorId] }),
        queryClient.invalidateQueries({ queryKey: ['tutor-reviews', bookingTutorId] }),
        queryClient.invalidateQueries({ queryKey: ['admin-reviews'] }),
      ]);
    },
    onError: (err) => {
      toast.error(err?.response?.data?.message || 'Failed to delete review');
    },
  });

  const {
    register: registerReschedule,
    handleSubmit: handleRescheduleSubmit,
    setValue: setRescheduleValue,
    reset: resetRescheduleForm,
    formState: { errors: rescheduleErrors },
  } = useForm({
    resolver: zodResolver(rescheduleSchema),
  });

  const totalAmount =
    booking?.totalAmount ??
    ((Number(booking?.hourlyRate || 0) * Number(booking?.duration || 0)) / 60 || 0);
  const recurringLabel = getRecurringLabel(booking);
  const recurringBookings = getRecurringSeriesBookings(booking);
  const recurringStatus = getRecurringStatusSummary(booking);
  const displayStatus = recurring
    ? getRecurringDisplayStatus(booking)
    : booking?.status === 'PENDING' && booking?.negotiationStatus && booking.negotiationStatus !== 'NONE'
      ? booking.negotiationStatus
      : booking?.status;
  const pendingRecurringBookings = recurringBookings.filter((seriesBooking) => seriesBooking.status === 'PENDING');
  const pendingRecurringBookingIds = pendingRecurringBookings.map((seriesBooking) => seriesBooking.id);
  const pendingRecurringBookingIdsKey = pendingRecurringBookingIds.join('|');
  const recurringHasPendingPriceOffer = Boolean(
    booking?.recurringSeries?.seriesHasPendingPriceOffer ||
    recurringBookings.some(hasPendingPriceOffer)
  );
  const allPendingRecurringSelected =
    pendingRecurringBookingIds.length > 0 &&
    pendingRecurringBookingIds.every((seriesBookingId) => selectedSeriesBookingIds.includes(seriesBookingId));
  const cancellableRecurringBookings = recurringBookings.filter(
    (seriesBooking) => seriesBooking.availableActions?.canCancel
  );
  const paymentSetupSeriesBookings = getPayableSeriesBookings(booking);
  const paymentSetupSeriesAmount = getSeriesTotalAmount(paymentSetupSeriesBookings);
  const fullSeriesAmount = getSeriesTotalAmount(recurringBookings);
  const recurringDisplayAmount = paymentSetupSeriesAmount || fullSeriesAmount || totalAmount;
  const canSetupPaymentMethod =
    isLearner &&
    (
      recurring
        ? paymentSetupSeriesBookings.length > 0 && !recurringHasPendingPriceOffer
        : ['PENDING', 'ACCEPTED'].includes(booking?.status) &&
          ['PENDING', 'FAILED'].includes(paymentStatus) &&
          !hasPendingPriceOffer(booking)
    );

  const getPriceOfferMutationAction = (targetBookingId) =>
    priceOfferMutation.isPending &&
    priceOfferMutation.variables?.targetBooking?.id === targetBookingId
      ? priceOfferMutation.variables.action
      : '';

  const renderPriceOfferPanel = (targetBooking, { compact = false } = {}) => (
    <BookingPriceOfferPanel
      booking={targetBooking}
      isTutor={isTutor}
      isLearner={isLearner}
      compact={compact}
      seriesTotal={recurring ? fullSeriesAmount : null}
      mutationAction={getPriceOfferMutationAction(targetBooking.id)}
      onPropose={(payload) =>
        priceOfferMutation.mutate({
          action: 'propose',
          targetBooking,
          payload,
        })
      }
      onAccept={(offerId) =>
        priceOfferMutation.mutate({
          action: 'accept',
          targetBooking,
          offerId,
        })
      }
      onReject={(offerId) =>
        priceOfferMutation.mutate({
          action: 'reject',
          targetBooking,
          offerId,
        })
      }
      onWithdraw={(offerId) =>
        priceOfferMutation.mutate({
          action: 'withdraw',
          targetBooking,
          offerId,
        })
      }
    />
  );

  const renderCompletionReview = (targetBooking, { compact = false } = {}) => {
    if (!targetBooking?.completionReviewStatus) return null;

    const isConfirming =
      confirmCompletionMutation.isPending &&
      confirmCompletionMutation.variables?.targetId === targetBooking.id;
    const isDisputing =
      disputeCompletionMutation.isPending &&
      disputeCompletionMutation.variables?.targetId === targetBooking.id;

    return (
      <PostLessonResolutionPanel
        booking={targetBooking}
        isLearner={isLearner}
        timeZone={timeZone}
        compact={compact}
        isConfirming={isConfirming}
        isDisputing={isDisputing}
        onConfirm={() => {
          if (!window.confirm('Confirm that this lesson was completed?')) return;
          confirmCompletionMutation.mutate({
            targetId: targetBooking.id,
            expectedVersion: targetBooking.version,
          });
        }}
        onDispute={() => {
          const reason = promptForReason({
            title: 'Explain why this lesson was not completed:',
            required: true,
          });
          if (reason === null) return;
          if (
            !window.confirm(
              'Report this lesson as not completed? TutorConnect support will be notified to review the issue.'
            )
          ) return;
          disputeCompletionMutation.mutate({
            targetId: targetBooking.id,
            reason,
            expectedVersion: targetBooking.version,
          });
        }}
      />
    );
  };

  const acceptRescheduleRequestMutation = useMutation({
    mutationFn: ({ targetId, requestId, expectedVersion }) =>
      bookingApi.acceptRescheduleRequest(targetId, requestId, expectedVersion),
    onSuccess: async (response) => {
      toast.success(response?.data?.message || 'Reschedule accepted');
      await invalidateBookingViews({ queryClient, currentUserId, id, bookingTutorId });
    },
    onError: async (err) => {
      toast.error(err?.response?.data?.message || 'Failed to accept reschedule');
      if (err?.response?.data?.code === 'RESCHEDULE_SLOT_UNAVAILABLE' || err?.response?.status === 409) {
        await invalidateBookingViews({ queryClient, currentUserId, id, bookingTutorId });
      }
    },
  });

  const declineRescheduleRequestMutation = useMutation({
    mutationFn: ({ targetId, requestId, reason, expectedVersion }) =>
      bookingApi.declineRescheduleRequest(targetId, requestId, reason, expectedVersion),
    onSuccess: async (response) => {
      toast.success(response?.data?.message || 'Reschedule declined');
      await invalidateBookingViews({ queryClient, currentUserId, id, bookingTutorId });
    },
    onError: (err) => {
      toast.error(err?.response?.data?.message || 'Failed to decline reschedule');
    },
  });

  useEffect(() => {
    setSelectedSeriesBookingIds((currentSelection) => {
      const nextSelection = currentSelection.filter((seriesBookingId) => pendingRecurringBookingIds.includes(seriesBookingId));
      return nextSelection.length === currentSelection.length &&
        nextSelection.every((seriesBookingId, index) => seriesBookingId === currentSelection[index])
        ? currentSelection
        : nextSelection;
    });
  }, [booking?.id, pendingRecurringBookingIdsKey]);

  useEffect(() => {
    if (!showRescheduleModal) {
      setRescheduleTargetBooking(null);
      setSelectedRescheduleSlot(null);
      resetRescheduleForm({ newDate: '', reason: '' });
    }
  }, [showRescheduleModal, resetRescheduleForm]);

  useEffect(() => {
    if (
      requestedAction === 'propose-time' &&
      canTutorProposePendingTime &&
      booking &&
      !handledRequestedAction
    ) {
      setHandledRequestedAction(true);
      setRescheduleTargetBooking(booking);
      setShowRescheduleModal(true);
      return;
    }
    if (
      requestedAction === 'change-time' &&
      canChangeRequestedTime &&
      booking &&
      !handledRequestedAction
    ) {
      setHandledRequestedAction(true);
      setRescheduleTargetBooking(booking);
      setShowRescheduleModal(true);
    }
  }, [
    booking,
    canChangeRequestedTime,
    canTutorProposePendingTime,
    handledRequestedAction,
    requestedAction,
  ]);

  useEffect(() => {
    if (!review) {
      setReviewRating(5);
      setReviewComment('');
      return;
    }

    setReviewRating(Number(review.rating || 5));
    setReviewComment(review.comment || '');
  }, [review?.id, review?.rating, review?.comment]);

  if (!currentUserId) {
    return (
      <div className="max-w-2xl mx-auto text-center py-14">
        <p className="text-gray-700 font-medium mb-1">Login required</p>
        <p className="text-gray-500 text-sm mb-4">Please log in first to view booking details.</p>
        <Link href="/login" className="btn-primary btn-sm">
          Go to login
        </Link>
      </div>
    );
  }

  if (!id) {
    return (
      <div className="max-w-2xl mx-auto text-center py-14">
        <p className="text-gray-700 font-medium mb-1">Invalid booking link</p>
        <p className="text-gray-500 text-sm mb-4">Booking ID is missing.</p>
        {showBackButton && (
          <BackButton href={backHref} label={backLabel} />
        )}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="max-w-2xl mx-auto space-y-4 animate-pulse">
        <div className="h-6 bg-gray-200 rounded w-1/3" />
        <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-3">
          <div className="h-5 bg-gray-200 rounded w-1/3" />
          <div className="h-4 bg-gray-200 rounded" />
          <div className="h-4 bg-gray-200 rounded w-3/4" />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="max-w-2xl mx-auto text-center py-14">
        <ExclamationTriangleIcon className="w-10 h-10 text-red-400 mx-auto mb-2" />
        <p className="text-red-700 font-medium mb-1">Unable to load booking detail</p>
        <p className="text-red-600 mb-3">{error?.response?.data?.message || 'Failed to load booking detail.'}</p>
        <div className="flex items-center justify-center gap-3">
          <button type="button" onClick={() => refetch()} className="btn-primary btn-sm">
            Retry
          </button>
          {showBackButton && (
            <BackButton href={backHref} label={backLabel} />
          )}
        </div>
      </div>
    );
  }

  if (!booking) {
    return (
      <div className="max-w-2xl mx-auto text-center py-14">
        <p className="text-gray-700 font-medium mb-1">Booking not found</p>
        <p className="text-gray-500 text-sm mb-3">This booking may have been removed or is unavailable.</p>
        {showBackButton && (
          <BackButton href={backHref} label={backLabel} />
        )}
      </div>
    );
  }

  return (
    <div className="relative w-full space-y-5">
      {paymentMethodResult === 'saved' && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
          Payment method saved. We will charge it automatically once the tutor accepts this booking.
        </div>
      )}

      {paymentResult === 'success' && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
          Payment successful. {recurring ? 'This session is' : 'Your booking is'} accepted.
        </div>
      )}

      {paymentResult === 'processing' && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-medium text-blue-800">
          Payment is processing. The booking remains pending until the provider confirms it.
        </div>
      )}

      <div className={`rounded-lg px-4 py-3 flex items-center gap-2 text-sm font-medium ${getStatusClass(displayStatus)}`}>
        {(['UNPAID', 'PENDING', 'TIME_PROPOSED_BY_TUTOR', 'TIME_PROPOSED_BY_LEARNER'].includes(displayStatus)) && <ExclamationTriangleIcon className="w-5 h-5" />}
        {(displayStatus === 'ACCEPTED' || displayStatus === 'COMPLETED') && <CheckCircleIcon className="w-5 h-5" />}
        {(displayStatus === 'CANCELLED' || displayStatus === 'DECLINED') && <XCircleIcon className="w-5 h-5" />}
        Booking Status: <strong className="flex-1">{getDisplayStatusLabel(booking)}</strong>
        {showBackButton && (
          <BackButton href={backHref} label={backLabel} />
        )}
      </div>

      <SessionLinkCard booking={booking} user={user} />

      <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-5">
        {tutorDetailHref ? (
          <div className="flex items-center gap-3">
            <Link
              href={tutorDetailHref}
              className="group rounded-full transition-transform hover:scale-[1.03]"
            >
              <img
                src={getAvatarUrl(other?.avatar, other?.firstName, other?.lastName, { fallbackName: 'Tutor' })}
                alt={other?.firstName || 'Tutor'}
                className="w-14 h-14 rounded-full object-cover ring-0 transition-shadow group-hover:shadow-md group-hover:ring-2 group-hover:ring-sky-100"
              />
            </Link>
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wide">
                Tutor
              </p>
              <h2 className="font-semibold text-gray-900">
                {other?.firstName || 'Tutor'} {other?.lastName || ''}
              </h2>
              <p className="text-sm text-gray-500">{other?.email || '-'}</p>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <img
              src={getAvatarUrl(other?.avatar, other?.firstName, other?.lastName, { fallbackName: 'Tutor' })}
              alt={other?.firstName || 'Tutor'}
              className="w-14 h-14 rounded-full object-cover"
            />
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wide">
                {isTutor ? 'Learner' : 'Tutor'}
              </p>
              <h2 className="font-semibold text-gray-900">
                {other?.firstName || 'Tutor'} {other?.lastName || ''}
              </h2>
              <p className="text-sm text-gray-500">{other?.email || '-'}</p>
            </div>
          </div>
        )}

        <hr className="border-gray-100" />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-gray-400 text-xs uppercase tracking-wide mb-1">Subject</p>
            <p className="font-medium text-gray-900">{booking.subject || '-'}<TestPaymentBadge isTestPayment={booking.payment?.isTestPayment} /></p>
          </div>
          <div>
            <p className="text-gray-400 text-xs uppercase tracking-wide mb-1">Session Type</p>
            <p className="font-medium text-gray-900">
              {booking.sessionType ? String(booking.sessionType).replace('_', '-') : '-'}
            </p>
          </div>
          <div>
            <p className="text-gray-400 text-xs uppercase tracking-wide mb-1">Date & Time</p>
            <p className="font-medium text-gray-900 inline-flex items-center gap-1">
              <CalendarDaysIcon className="w-4 h-4 text-gray-400" />
              {formatDate(booking.scheduledAt, timeZone)}
            </p>
          </div>
          <div>
            <p className="text-gray-400 text-xs uppercase tracking-wide mb-1">Duration</p>
            <p className="font-medium text-gray-900 inline-flex items-center gap-1">
              <ClockIcon className="w-4 h-4 text-gray-400" />
              {formatDuration(booking.duration)}
            </p>
          </div>
          <div>
            <p className="text-gray-400 text-xs uppercase tracking-wide mb-1">
              {booking.isTrialLesson && !recurring ? 'Price' : 'Total Amount'}
            </p>
            {booking.isTrialLesson && !recurring ? (
              <p className="font-bold text-emerald-700 text-base">Free trial lesson</p>
            ) : (
              <p className="font-bold text-gray-900 text-base">
                {formatCurrency(recurring ? recurringDisplayAmount : totalAmount, booking.currency || 'AUD')}
              </p>
            )}
          </div>
        </div>

        <hr className="border-gray-100" />
        <CancellationPolicySummary
          policy={booking}
          title="Cancellation policy acknowledged for this booking"
        />

        {recurring && (
          <>
            <hr className="border-gray-100" />
            <div className="rounded-2xl border border-sky-100 bg-sky-50/70 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs text-sky-700 uppercase tracking-wide font-semibold">
                    Recurring Booking
                  </p>
                  <h3 className="mt-1 font-semibold text-gray-900">{recurringLabel}</h3>
                  <p className="mt-1 text-sm text-gray-600">
                    Tutors can review each session in this series separately.
                    Learner cancellation still applies to this session only.
                  </p>
                  <p className="mt-2 text-sm font-medium text-sky-800">
                    {recurringStatus.acceptedCount} accepted · {recurringStatus.completedCount} completed · {recurringStatus.pendingCount} pending · {recurringStatus.declinedCount} declined · {recurringStatus.cancelledCount} cancelled · {recurringStatus.notCompletedCount} not completed
                  </p>
                </div>
                {isTutor && pendingRecurringBookingIds.length > 0 && (
                  <div className="min-w-[280px] flex-1">
                    {recurringHasPendingPriceOffer ? (
                      <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
                        Wait for the learner to respond to the price offer, or withdraw it, before accepting or declining sessions in this series.
                      </p>
                    ) : (
                      <p className="text-xs text-sky-700">
                        Tick the sessions you want to accept. Any pending session left unticked will be declined.
                      </p>
                    )}
                    <div className="ml-auto mt-2 flex w-fit items-center justify-end gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedSeriesBookingIds(
                            allPendingRecurringSelected ? [] : pendingRecurringBookingIds
                          );
                        }}
                        disabled={bulkSeriesDecisionMutation.isPending || recurringHasPendingPriceOffer}
                        className="text-sm font-medium text-primary-600 transition-colors hover:text-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {allPendingRecurringSelected ? 'Clear selection' : 'Select all'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const declinedIds = pendingRecurringBookingIds.filter(
                            (seriesBookingId) => !selectedSeriesBookingIds.includes(seriesBookingId)
                          );
                          const declineReason =
                            declinedIds.length > 0
                              ? promptForReason({
                                title:
                                  'Reason for the sessions you are declining:',
                                required: true,
                              })
                              : '';
                          if (declinedIds.length > 0 && declineReason === null) {
                            return;
                          }
                          if (
                            !window.confirm(
                              `Accept ${selectedSeriesBookingIds.length} selected session(s) and decline ${declinedIds.length} unselected session(s)?`
                            )
                          ) {
                            return;
                          }

                          bulkSeriesDecisionMutation.mutate({
                            acceptedBookings: recurringBookings.filter((seriesBooking) =>
                              selectedSeriesBookingIds.includes(seriesBooking.id)
                            ),
                            declinedIds,
                            declineReason,
                          });
                        }}
                        disabled={bulkSeriesDecisionMutation.isPending || recurringHasPendingPriceOffer}
                        className="btn-primary btn-sm gap-1.5"
                      >
                        <CheckCircleIcon className="w-4 h-4" />
                        {bulkSeriesDecisionMutation.isPending
                          ? 'Updating...'
                          : `Accept selected (${selectedSeriesBookingIds.length})`}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {recurringBookings.length > 0 && (
                <div className="mt-4 space-y-2">
                  {recurringBookings.map((seriesBooking) => {
                    const isCurrent = seriesBooking.id === booking.id;
                    const isPendingSeriesBooking = seriesBooking.status === 'PENDING';
                    const seriesActions = seriesBooking.availableActions || {};
                    const seriesCancellationState = getCancellationState(seriesBooking, {
                      isLearner,
                      isTutor,
                    });
                    const canRescheduleSeriesBooking = seriesActions.canReschedule;
                    const canProposeSeriesReschedule = seriesActions.canProposeReschedule;
                    const pendingSeriesReschedule = (seriesBooking.rescheduleRequests || []).find(
                      (request) => request.status === 'PENDING'
                    );
                    const canCompleteSeriesBooking = seriesActions.canComplete;
                    const canMarkSeriesNotCompleted = seriesActions.canMarkNotCompleted;
                    const canCancelSeriesBooking = seriesActions.canCancel;
                    const isCancellingThis =
                      cancelMutation.isPending &&
                      cancelMutation.variables?.targetId === seriesBooking.id;
                    const isCompletingThis =
                      completeMutation.isPending &&
                      completeMutation.variables?.targetId === seriesBooking.id;
                    const isMarkingNotCompleted =
                      notCompletedMutation.isPending &&
                      notCompletedMutation.variables?.targetId === seriesBooking.id;
                    return (
                      <div
                        key={seriesBooking.id}
                        className={`block rounded-xl border px-3 py-2 text-sm transition-colors ${isCurrent
                          ? 'border-sky-200 bg-white'
                          : 'border-white/70 bg-white/70 hover:border-sky-200 hover:bg-white'
                          }`}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="flex min-w-0 flex-1 items-start gap-3 rounded-lg">
                            {isTutor && isPendingSeriesBooking && (
                              <label className="mt-0.5 inline-flex items-center">
                                <input
                                  type="checkbox"
                                  checked={selectedSeriesBookingIds.includes(seriesBooking.id)}
                                  onChange={(event) => {
                                    setSelectedSeriesBookingIds((currentSelection) =>
                                      event.target.checked
                                        ? [...currentSelection, seriesBooking.id]
                                        : currentSelection.filter((seriesBookingId) => seriesBookingId !== seriesBooking.id)
                                    );
                                  }}
                                  disabled={bulkSeriesDecisionMutation.isPending || recurringHasPendingPriceOffer}
                                  className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                                />
                              </label>
                            )}

                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="font-medium text-gray-900">
                                  {formatDate(seriesBooking.scheduledAt, timeZone)}
                                  {isCurrent ? ' · current' : ''}
                                </span>
                                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${getStatusClass(seriesBooking.status)}`}>
                                  {formatBookingStatus(seriesBooking.status)}
                                </span>
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-gray-500">
                                <span>{formatDuration(seriesBooking.duration)}</span>
                                {seriesBooking.isTrialLesson ? (
                                  <span className="font-medium text-emerald-700">Free trial lesson</span>
                                ) : paymentSetupSeriesBookings.some((item) => item.id === seriesBooking.id) ? (
                                  <span>Included in series total</span>
                                ) : (
                                  <span>Payment: {seriesBooking.payment?.status || 'PENDING'}</span>
                                )}
                              </div>
                              <CancellationPolicySummary
                                policy={seriesBooking}
                                title="Policy for this session"
                                compact
                                className="mt-2"
                              />
                              {renderPriceOfferPanel(seriesBooking, { compact: true })}
                              {seriesBooking.declineReason && (
                                <p className="mt-2 text-xs text-red-600">
                                  Decline reason: {seriesBooking.declineReason}
                                </p>
                              )}
                              {seriesBooking.cancellationReason && (
                                <p className="mt-2 text-xs text-gray-600">
                                  {seriesBooking.status === 'NOT_COMPLETED'
                                    ? 'Non-completion reason'
                                    : 'Cancellation reason'}: {seriesBooking.cancellationReason}
                                </p>
                              )}
                              {seriesBooking.latestRescheduleReason && (
                                <p className="mt-2 text-xs text-purple-700">
                                  Reschedule note: {seriesBooking.latestRescheduleReason}
                                </p>
                              )}
                              {pendingSeriesReschedule && (
                                <p className="mt-2 text-xs font-medium text-amber-700">
                                  {seriesActions.canRespondReschedule
                                    ? `${pendingSeriesReschedule.proposedBy === 'TUTOR' ? 'Tutor' : 'Learner'} proposed ${formatDate(pendingSeriesReschedule.proposedScheduledAt, timeZone)}`
                                    : 'Reschedule proposal awaiting the other participant'}
                                </p>
                              )}
                              {renderCompletionReview(seriesBooking, { compact: true })}
                            </div>
                          </div>

                          <div className="flex shrink-0 flex-wrap gap-2">
                            {canCompleteSeriesBooking && (
                              <button
                                type="button"
                                onClick={() =>
                                  completeMutation.mutate({
                                    targetId: seriesBooking.id,
                                    expectedVersion: seriesBooking.version,
                                  })
                                }
                                disabled={isCompletingThis || bulkSeriesDecisionMutation.isPending}
                                className="btn-primary btn-sm gap-1.5"
                              >
                                <CheckCircleIcon className="w-4 h-4" />
                                {isCompletingThis ? 'Saving...' : 'Mark Complete'}
                              </button>
                            )}
                            {canMarkSeriesNotCompleted && (
                              <button
                                type="button"
                                onClick={() => {
                                  const reason = promptForReason({
                                    title: 'Explain why you could not complete this lesson:',
                                    required: true,
                                  });
                                  if (reason === null) return;
                                  const amount = Number(
                                    seriesBooking.payment?.amount || seriesBooking.totalAmount || 0
                                  ).toFixed(2);
                                  const confirmation = seriesBooking.isTrialLesson
                                    ? 'Mark this free trial as not completed? This outcome is final.'
                                    : `Mark this lesson as not completed and request a full ${seriesBooking.currency || 'AUD'} ${amount} refund to the learner? This outcome is final.`;
                                  if (!window.confirm(confirmation)) return;
                                  notCompletedMutation.mutate({
                                    targetId: seriesBooking.id,
                                    reason,
                                    expectedVersion: seriesBooking.version,
                                  });
                                }}
                                disabled={isMarkingNotCompleted || bulkSeriesDecisionMutation.isPending}
                                className="btn-danger btn-sm gap-1.5"
                              >
                                <XCircleIcon className="w-4 h-4" />
                                {isMarkingNotCompleted ? 'Saving…' : 'Mark lesson not completed'}
                              </button>
                            )}
                            {canRescheduleSeriesBooking && (
                              <button
                                type="button"
                                onClick={() => {
                                  setRescheduleTargetBooking(seriesBooking);
                                  setShowRescheduleModal(true);
                                }}
                                disabled={bulkSeriesDecisionMutation.isPending}
                                className="btn-secondary btn-sm gap-1.5"
                              >
                                <CalendarDaysIcon className="w-4 h-4" />
                                Reschedule
                              </button>
                            )}
                            {canProposeSeriesReschedule && (
                              <button
                                type="button"
                                onClick={() => {
                                  setRescheduleTargetBooking(seriesBooking);
                                  setShowRescheduleModal(true);
                                }}
                                disabled={bulkSeriesDecisionMutation.isPending}
                                className="btn-secondary btn-sm gap-1.5"
                              >
                                <CalendarDaysIcon className="w-4 h-4" />
                                {pendingSeriesReschedule ? 'Propose Different Time' : 'Propose New Time'}
                              </button>
                            )}
                            {seriesActions.canRespondReschedule && pendingSeriesReschedule && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (window.confirm('Accept this proposed time?')) {
                                      acceptRescheduleRequestMutation.mutate({
                                        targetId: seriesBooking.id,
                                        requestId: pendingSeriesReschedule.id,
                                        expectedVersion: seriesBooking.version,
                                      });
                                    }
                                  }}
                                  disabled={acceptRescheduleRequestMutation.isPending || declineRescheduleRequestMutation.isPending}
                                  className="btn-primary btn-sm gap-1.5"
                                >
                                  Accept Time
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    const reason = promptForReason({
                                      title: 'Reason for declining this proposed time (optional):',
                                    });
                                    if (reason === null) return;
                                    declineRescheduleRequestMutation.mutate({
                                      targetId: seriesBooking.id,
                                      requestId: pendingSeriesReschedule.id,
                                      reason,
                                      expectedVersion: seriesBooking.version,
                                    });
                                  }}
                                  disabled={acceptRescheduleRequestMutation.isPending || declineRescheduleRequestMutation.isPending}
                                  className="btn-danger btn-sm gap-1.5"
                                >
                                  Decline
                                </button>
                              </>
                            )}
                            {(isLearner || isTutor) && canCancelSeriesBooking && (
                              <button
                                type="button"
                                onClick={() => {
                                  const reason = promptForReason({
                                    title: 'Reason for cancelling this session:',
                                    required: true,
                                  });
                                  if (reason === null) return;
                                  if (window.confirm(
                                    isLearner && ['PAID', 'COMPLETED'].includes(seriesBooking.payment?.status)
                                      ? `Cancel this session? The current refund is ${seriesCancellationState.refundPercent}%.`
                                      : 'Cancel this session?'
                                  )) {
                                    cancelMutation.mutate({ targetId: seriesBooking.id, reason });
                                  }
                                }}
                                disabled={isCancellingThis || cancelSeriesMutation.isPending || bulkSeriesDecisionMutation.isPending}
                                className="btn-danger btn-sm gap-1.5"
                              >
                                <XCircleIcon className="w-4 h-4" />
                                {isCancellingThis ? 'Cancelling...' : 'Cancel'}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}

        {booking.notes && (
          <>
            <hr className="border-gray-100" />
            <div>
              <p className="text-gray-400 text-xs uppercase tracking-wide mb-1">Notes</p>
              <p className="text-gray-700 text-sm leading-relaxed">{booking.notes}</p>
            </div>
          </>
        )}
      </div>

      {!recurring && renderPriceOfferPanel(booking)}
      {!recurring && renderCompletionReview(booking)}

      {payoutSetupPrompt && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-amber-900">
          <div className="flex items-start gap-3">
            <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            <div>
              <p className="font-semibold">Payout setup required</p>
              <p className="mt-1 text-sm leading-6 text-amber-800">
                {payoutSetupPrompt.message}
              </p>
              <Link href={payoutSetupPrompt.link} className="btn-primary btn-sm mt-3 inline-block">
                Complete payout setup
              </Link>
            </div>
          </div>
        </div>
      )}

      {booking.status === 'PENDING' && isFailedPayment && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-red-950">
          <div className="flex items-start gap-3">
            <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
            <div>
              <p className="font-semibold">Payment failed — booking not confirmed</p>
              <p className="mt-1 text-sm leading-6 text-red-800">
                {booking.payment?.failureReason ||
                  'Payment could not be completed. Please choose another payment method and try again.'}
              </p>
              {isTutor && actions.isAwaitingLearnerPaymentRetry && (
                <p className="mt-2 text-sm text-red-700">
                  The learner has been asked to update their payment method and retry. You do not
                  need to accept this request again.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {canSetupPaymentMethod && (
        <div className="bg-white border border-gray-200 rounded-2xl p-6">
          <div className="rounded-2xl border border-sky-100 bg-sky-50/70 p-5">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
              <div className="space-y-2">
                <p className="text-xs text-sky-700 uppercase tracking-[0.18em] font-semibold">
                  Payment Method
                </p>
                <div className="flex items-end gap-3">
                  <h3 className="text-3xl font-bold tracking-tight text-gray-900">
                    {formatCurrency(recurring ? recurringDisplayAmount : totalAmount, booking.currency || 'AUD')}
                  </h3>
                </div>
                {savedMethod && !isFailedPayment && (
                  <div className="inline-flex items-center rounded-full border border-sky-200 bg-white/80 px-3 py-1 text-xs font-medium text-sky-700">
                    Saved method: {formatSavedMethod(savedMethod)}
                  </div>
                )}
                <p className="max-w-xl text-sm leading-6 text-gray-600">
                  {isFailedPayment
                    ? recurring
                      ? 'Update the method and retry payment for this failed session. Other occurrences are not charged.'
                      : 'Update or confirm the payment method to retry immediately. The tutor does not need to accept again.'
                    : savedMethod
                      ? recurring
                        ? `Your saved ${formatSavedMethod(savedMethod)} will be charged after tutor approval.`
                        : `Your saved ${formatSavedMethod(savedMethod)} will be charged after tutor approval.`
                      : recurring
                        ? 'Save a payment method so TutorConnect can charge the remaining sessions after tutor approval.'
                        : 'Save a payment method so TutorConnect can charge this booking after tutor approval.'}
                </p>
                {recurring && paymentSetupSeriesBookings.length > 0 && (
                  <p className="text-sm font-semibold text-sky-800">
                    Series total: {formatCurrency(recurringDisplayAmount, booking.currency || 'AUD')}
                  </p>
                )}
              </div>

              {isLearner && (
                <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
                  <Link
                    href={`/bookings/${id}/payment?returnTo=${encodeURIComponent(bookingDetailHref)}`}
                    className="btn-primary inline-flex min-w-[220px] justify-center whitespace-nowrap rounded-xl px-5 py-3 shadow-sm"
                  >
                    <CheckCircleIcon className="w-4 h-4" />
                    {isFailedPayment || savedMethod
                      ? recurring
                        ? 'Update Method and Retry'
                        : 'Update Method and Retry'
                      : recurring
                        ? 'Set Up Series Payment'
                        : 'Set Up Payment Method'}
                  </Link>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {booking.status === 'PENDING' && isProcessingPayment && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
          Payment is processing. This booking remains pending until Stripe confirms the charge.
        </div>
      )}

      {paymentAttempts.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-2xl p-6">
          <h3 className="font-semibold text-gray-900">Payment Attempt History</h3>
          <p className="mt-1 text-sm text-gray-500">
            Audit history only; no card or bank details are stored here.
          </p>
          <div className="mt-4 space-y-3">
            {paymentAttempts.map((attempt) => (
              <div key={attempt.id} className="rounded-xl border border-gray-100 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-900">
                      Attempt {attempt.number}
                    </span>
                    <span className={`badge ${getStatusClass(
                      attempt.outcome === 'SUCCEEDED'
                        ? 'ACCEPTED'
                        : attempt.outcome === 'FAILED'
                          ? 'DECLINED'
                          : 'PENDING'
                    )}`}>
                      {attempt.outcome === 'SUCCEEDED'
                        ? 'Successful'
                        : attempt.outcome === 'FAILED'
                          ? 'Failed'
                          : 'Processing'}
                    </span>
                  </div>
                  <span className="text-xs text-gray-500">
                    {formatDate(attempt.attemptedAt, timeZone)}
                  </span>
                </div>
                {attempt.failureReason && (
                  <p className="mt-2 text-sm text-gray-600">{attempt.failureReason}</p>
                )}
                <p className="mt-2 text-xs text-gray-500">
                  {String(attempt.source || 'PAYMENT').replaceAll('_', ' ')}
                  {attempt.initiatedByRole
                    ? ` · initiated by ${String(attempt.initiatedByRole).toLowerCase()}`
                    : ''}
                  {attempt.completedAt
                    ? ` · completed ${formatDate(attempt.completedAt, timeZone)}`
                    : ''}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {isLearner && booking.status === 'DECLINED' && isRefunded && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
          Refunded
        </div>
      )}

      {hasCancellationOutcome && (
        <div
          id="cancellation-outcome"
          className="scroll-mt-20 rounded-lg border border-sky-200 bg-sky-50 px-4 py-4 text-sm text-sky-950"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-sky-700">
                Cancellation Outcome
              </p>
              <p className="mt-1 font-semibold text-sky-950">
                Cancelled by {getCancellationActorLabel(cancellationOutcome.actorRole)}
              </p>
            </div>
            <span className="rounded-full border border-sky-200 bg-white px-3 py-1 text-xs font-semibold text-sky-800">
              {Number(cancellationOutcome.refundPercent || 0)}% refund
            </span>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-xs uppercase tracking-wide text-sky-700">Refund</p>
              <p className="mt-0.5 font-semibold">
                {formatCurrency(cancellationOutcome.refundAmount || 0, booking.currency || 'AUD')}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-sky-700">
                Gross retained
              </p>
              <p className="mt-0.5 font-semibold">
                {formatCurrency(cancellationOutcome.retainedAmount || 0, booking.currency || 'AUD')}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-sky-700">
                TutorConnect commission ({Number(cancellationOutcome.platformFeePercent || 15)}%)
              </p>
              <p className="mt-0.5 font-semibold">
                {formatCurrency(cancellationOutcome.platformFeeAmount || 0, booking.currency || 'AUD')}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-sky-700">Tutor earnings</p>
              <p className="mt-0.5 font-semibold">
                {formatCurrency(cancellationOutcome.tutorPayoutAmount || 0, booking.currency || 'AUD')}
              </p>
            </div>
          </div>

          {cancellationOutcome.cutoffAt && (
            <p className="mt-3 text-xs text-sky-700">
              Cutoff used: {formatDate(cancellationOutcome.cutoffAt, timeZone)}
            </p>
          )}
        </div>
      )}

      {isTutor && booking.status === 'PENDING' && (
        <EarningPreview preview={booking.earningPreview} />
      )}

      <div className="flex flex-wrap gap-3">
        <div className='text-gray-700 text-sm mb-2 mt-2'>
          {recurring
            ? 'Recurring bookings stay grouped as one order. Tutors and learners can handle each session directly in the list below.'
            : !canCancel && cancellationState.blockedReason
              ? cancellationState.blockedReason
              : isLearner && isAcceptedBooking && isPaidBooking
                ? cancellationState.refundPercent === 100
                  ? 'Cancelling now qualifies for a full refund.'
                  : cancellationState.refundPercent > 0
                    ? `Cancelling now qualifies for a ${cancellationState.refundPercent}% refund.`
                    : 'Cancelling now is allowed, but no refund will be issued.'
                : isTutor
                  ? getTutorBookingActionHint(booking)
                  : 'Only currently valid booking actions are shown here.'}
        </div>
        {isLearner && canCancel && (
          <>

            <button
              type="button"
              onClick={() => {
                const reason = promptForReason({
                  title: 'Reason for cancelling this booking:',
                  required: true,
                });
                if (reason === null) return;
                if (window.confirm(
                  isPaidBooking
                    ? `Cancel this booking? The current refund is ${cancellationState.refundPercent}%.`
                    : 'Cancel this booking?'
                )) {
                  cancelMutation.mutate({ targetId: id, reason });
                }
              }}
              disabled={cancelMutation.isPending}
              className="btn-danger gap-2"
            >
              <XCircleIcon className="w-4 h-4" />
              {cancelMutation.isPending ? 'Cancelling...' : 'Cancel Booking'}
            </button>
          </>
        )}

        {recurring && isLearner && cancellableRecurringBookings.length > 0 && (
          <button
            type="button"
            onClick={() => {
              const reason = promptForReason({
                title: 'Reason for cancelling these sessions:',
                required: true,
              });
              if (reason === null) return;
              if (window.confirm(`Cancel ${cancellableRecurringBookings.length} session(s) in this recurring booking?`)) {
                cancelSeriesMutation.mutate({
                  targetIds: cancellableRecurringBookings.map((seriesBooking) => seriesBooking.id),
                  reason,
                });
              }
            }}
            disabled={cancelSeriesMutation.isPending}
            className="btn-danger gap-2"
          >
            <XCircleIcon className="w-4 h-4" />
            {cancelSeriesMutation.isPending ? 'Cancelling All...' : 'Cancel All'}
          </button>
        )}

        {(isLearner || isTutor) && !recurring && canProposeReschedule && (
          <button
            type="button"
            onClick={() => {
              setRescheduleTargetBooking(booking);
              setShowRescheduleModal(true);
            }}
            className="btn-secondary gap-2"
          >
            <CalendarDaysIcon className="w-4 h-4" />
            Propose New Time
          </button>
        )}

        {canTutorProposePendingTime && (
          <button
            type="button"
            onClick={() => {
              setRescheduleTargetBooking(booking);
              setShowRescheduleModal(true);
            }}
            className="btn-secondary gap-2"
          >
            <CalendarDaysIcon className="w-4 h-4" />
            {pendingRescheduleRequest ? 'Propose Different Time' : 'Propose New Time'}
          </button>
        )}

        {canChangeRequestedTime && (
          <button
            type="button"
            onClick={() => {
              setRescheduleTargetBooking(booking);
              setShowRescheduleModal(true);
            }}
            className="btn-secondary gap-2"
          >
            <CalendarDaysIcon className="w-4 h-4" />
            {tutorProposedPendingTime ? 'Propose Different Time' : 'Change Requested Time'}
          </button>
        )}

        {isLearner && actions.canAcceptPendingTimeProposal && (
          <button
            type="button"
            onClick={() => acceptPendingTimeProposalMutation.mutate()}
            disabled={acceptPendingTimeProposalMutation.isPending || rejectPendingTimeProposalMutation.isPending}
            className="btn-primary gap-2"
          >
            <CheckCircleIcon className="w-4 h-4" />
            {acceptPendingTimeProposalMutation.isPending ? 'Accepting...' : 'Accept Proposed Time'}
          </button>
        )}

        {isLearner && actions.canRejectPendingTimeProposal && (
          <button
            type="button"
            onClick={() => {
              const reason = promptForReason({
                title: 'Reason for rejecting this proposed time (optional):',
              });
              if (reason === null) return;
              if (!window.confirm('Reject this time and cancel the booking request?')) return;
              rejectPendingTimeProposalMutation.mutate(reason);
            }}
            disabled={acceptPendingTimeProposalMutation.isPending || rejectPendingTimeProposalMutation.isPending}
            className="btn-danger gap-2"
          >
            <XCircleIcon className="w-4 h-4" />
            {rejectPendingTimeProposalMutation.isPending ? 'Rejecting...' : 'Reject Proposed Time'}
          </button>
        )}

        {tutorProposedPendingTime && isTutor && (
          <div className="rounded-lg border border-purple-200 bg-purple-50 px-4 py-2 text-sm font-medium text-purple-800">
            Waiting for the learner to respond to your proposed time.
          </div>
        )}

        {learnerProposedPendingTime && isLearner && (
          <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-2 text-sm font-medium text-sky-800">
            Waiting for the tutor to respond to your proposed time.
          </div>
        )}

        {hasPendingRescheduleProposal && (
          <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-2 text-sm font-medium text-sky-800">
            Your reschedule proposal is waiting for the other participant.
          </div>
        )}

        {!recurring && ((actions.canAccept && !hasPendingPriceOffer(booking)) || actions.canDecline) && (
          <>
            {actions.canAccept && !hasPendingPriceOffer(booking) && (
              <button
                type="button"
                onClick={() =>
                  acceptMutation.mutate({ targetId: id, expectedVersion: booking.version })
                }
                disabled={acceptMutation.isPending}
                className="btn-primary gap-2"
              >
                <CheckCircleIcon className="w-4 h-4" />
                {acceptMutation.isPending ? 'Accepting...' : 'Accept'}
              </button>
            )}
            {actions.canDecline && (
              <button
                type="button"
                onClick={() => {
                  const reason = promptForReason({
                    title: 'Please enter a short decline reason:',
                    required: true,
                  });
                  if (reason === null) return;
                  declineMutation.mutate({
                    targetId: id,
                    reason,
                    expectedVersion: booking.version,
                  });
                }}
                disabled={declineMutation.isPending}
                className="btn-danger gap-2"
              >
                <XCircleIcon className="w-4 h-4" />
                {declineMutation.isPending ? 'Declining...' : 'Decline'}
              </button>
            )}
          </>
        )}

        {!recurring && (
          actions.canReschedule ||
          actions.canComplete ||
          actions.canMarkNotCompleted ||
          (!isLearner && actions.canCancel)
        ) && (
          <>
            {actions.canReschedule && (
              <button
                type="button"
                onClick={() => {
                  setRescheduleTargetBooking(booking);
                  setShowRescheduleModal(true);
                }}
                className="btn-secondary gap-2"
              >
                <CalendarDaysIcon className="w-4 h-4" />
                Reschedule
              </button>
            )}
            {actions.canComplete && (
              <button
                type="button"
                onClick={() =>
                  completeMutation.mutate({ targetId: id, expectedVersion: booking.version })
                }
                disabled={completeMutation.isPending}
                className="btn-primary gap-2"
              >
                <CheckCircleIcon className="w-4 h-4" />
                {completeMutation.isPending ? 'Saving...' : 'Mark Complete'}
              </button>
            )}
            {actions.canMarkNotCompleted && (
              <button
                type="button"
                onClick={() => {
                  const reason = promptForReason({
                    title: 'Explain why you could not complete this lesson:',
                    required: true,
                  });
                  if (reason === null) return;
                  const amount = Number(booking.payment?.amount || booking.totalAmount || 0).toFixed(2);
                  const confirmation = booking.isTrialLesson
                    ? 'Mark this free trial as not completed? This outcome is final.'
                    : `Mark this lesson as not completed and request a full ${booking.currency || 'AUD'} ${amount} refund to the learner? This outcome is final.`;
                  if (!window.confirm(confirmation)) return;
                  notCompletedMutation.mutate({
                    targetId: id,
                    reason,
                    expectedVersion: booking.version,
                  });
                }}
                disabled={notCompletedMutation.isPending || completeMutation.isPending}
                className="btn-danger gap-2"
              >
                <XCircleIcon className="w-4 h-4" />
                {notCompletedMutation.isPending ? 'Saving…' : 'Mark lesson not completed'}
              </button>
            )}
            {!isLearner && actions.canCancel && (
              <button
                type="button"
                onClick={() => {
                  const reason = promptForReason({
                    title: 'Reason for cancelling this booking:',
                    required: true,
                  });
                  if (reason === null) return;
                  if (window.confirm('Cancel this booking?')) {
                    cancelMutation.mutate({ targetId: id, reason });
                  }
                }}
                disabled={cancelMutation.isPending}
                className="btn-danger gap-2"
              >
                <XCircleIcon className="w-4 h-4" />
                {cancelMutation.isPending ? 'Cancelling...' : 'Cancel'}
              </button>
            )}
          </>
        )}
      </div>

      {booking.status === 'ACCEPTED' && pendingRescheduleRequest && (
        <div className="bg-white border border-sky-200 rounded-2xl p-6 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs text-sky-700 uppercase tracking-wide font-semibold">
                Reschedule Request
              </p>
              <h3 className="mt-1 text-lg font-semibold text-gray-900">
                {pendingProposalIsMine
                  ? 'Waiting for the other participant'
                  : `${pendingRescheduleRequest.proposedBy === 'TUTOR' ? 'Tutor' : 'Learner'} proposed a new time`}
              </h3>
              <p className="mt-1 text-sm text-gray-600">
                Proposed time: {formatDate(pendingRescheduleRequest.proposedScheduledAt, timeZone)}
              </p>
            </div>
            <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700">
              Pending
            </span>
          </div>

          <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
            <div>
              <p className="text-gray-400 text-xs uppercase tracking-wide mb-1">Current Time</p>
              <p className="font-medium text-gray-900">
                {formatDate(pendingRescheduleRequest.currentScheduledAt, timeZone)}
              </p>
            </div>
            <div>
              <p className="text-gray-400 text-xs uppercase tracking-wide mb-1">Proposed Time</p>
              <p className="font-medium text-gray-900">
                {formatDate(pendingRescheduleRequest.proposedScheduledAt, timeZone)}
              </p>
            </div>
          </div>

          <div>
            <p className="text-gray-400 text-xs uppercase tracking-wide mb-1">Reason</p>
            <p className="text-sm text-gray-700">{pendingRescheduleRequest.reason}</p>
          </div>

          {actions.canRespondReschedule && (
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => {
                  if (window.confirm('Accept this proposed time?')) {
                    acceptRescheduleRequestMutation.mutate({
                      targetId: booking.id,
                      requestId: pendingRescheduleRequest.id,
                      expectedVersion: booking.version,
                    });
                  }
                }}
                disabled={acceptRescheduleRequestMutation.isPending || declineRescheduleRequestMutation.isPending}
                className="btn-primary gap-2"
              >
                <CheckCircleIcon className="w-4 h-4" />
                {acceptRescheduleRequestMutation.isPending ? 'Accepting...' : 'Accept New Time'}
              </button>
              <button
                type="button"
                onClick={() => {
                  const reason = promptForReason({
                    title: 'Reason for declining this proposed time (optional):',
                  });
                  if (reason === null) return;
                  declineRescheduleRequestMutation.mutate({
                    targetId: booking.id,
                    requestId: pendingRescheduleRequest.id,
                    reason,
                    expectedVersion: booking.version,
                  });
                }}
                disabled={acceptRescheduleRequestMutation.isPending || declineRescheduleRequestMutation.isPending}
                className="btn-danger gap-2"
              >
                <XCircleIcon className="w-4 h-4" />
                {declineRescheduleRequestMutation.isPending ? 'Declining...' : 'Decline'}
              </button>
            </div>
          )}
        </div>
      )}

      {timeNegotiationHistory.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide font-semibold">
              Time Negotiation History
            </p>
            <h3 className="mt-1 text-lg font-semibold text-gray-900">Proposals and responses</h3>
          </div>
          <div className="space-y-3">
            {timeNegotiationHistory.map((request) => (
              <div
                key={request.id}
                className="rounded-xl border border-gray-100 bg-gray-50/70 p-4"
              >
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-gray-600">
                    Proposed by {String(request.proposedBy || 'LEARNER').toLowerCase()}
                  </span>
                  <span className="rounded-full border border-gray-200 bg-white px-2 py-0.5 text-xs font-medium text-gray-600">
                    {request.status === 'COUNTERED'
                      ? 'Countered'
                      : request.status === 'PENDING'
                        ? 'Awaiting response'
                        : String(request.status || '').toLowerCase().replace(/^./, (value) => value.toUpperCase())}
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-gray-400">Previous time</p>
                    <p className="mt-1 font-medium text-gray-900">
                      {formatDate(request.currentScheduledAt, timeZone)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide text-gray-400">Updated time</p>
                    <p className="mt-1 font-medium text-gray-900">
                      {formatDate(request.proposedScheduledAt, timeZone)}
                    </p>
                  </div>
                </div>
                {request.reason && (
                  <p className="mt-3 text-sm text-gray-600">{request.reason}</p>
                )}
                {request.decisionReason && (
                  <p className="mt-2 text-sm text-gray-500">
                    Response: {request.decisionReason}
                  </p>
                )}
                {request.decidedBy && (
                  <p className="mt-2 text-xs text-gray-500">
                    Responded by {request.decidedBy.firstName} {request.decidedBy.lastName}
                  </p>
                )}
                <p className="mt-2 text-xs text-gray-400">
                  Proposed {formatDate(request.createdAt, timeZone)}
                  {request.decidedAt ? ` · Responded ${formatDate(request.decidedAt, timeZone)}` : ''}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {(booking.declineReason || booking.cancellationReason || latestRescheduleReason) && (
        <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-3">
          {booking.declineReason && (
            <div>
              <p className="text-gray-400 text-xs uppercase tracking-wide mb-1">Decline Reason</p>
              <p className="text-sm text-gray-700">{booking.declineReason}</p>
            </div>
          )}
          {booking.cancellationReason && (
            <div>
              <p className="text-gray-400 text-xs uppercase tracking-wide mb-1">Cancellation Reason</p>
              <p className="text-sm text-gray-700">{booking.cancellationReason}</p>
            </div>
          )}
          {latestRescheduleReason && (
            <div>
              <p className="text-gray-400 text-xs uppercase tracking-wide mb-1">Reschedule Note</p>
              <p className="text-sm text-gray-700">{latestRescheduleReason}</p>
            </div>
          )}
        </div>
      )}

      {(review || reviewEligible) && (
        <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Tutor Review</p>
              <h3 className="text-lg font-semibold text-gray-900">
                {review ? 'Learner feedback' : 'Rate this tutor'}
              </h3>
              <p className="text-sm text-gray-500 mt-1">
                {recurring
                  ? 'You can start reviewing this recurring booking after the first completed session and update it later.'
                  : 'Reviews are only available after the lesson is completed.'}
              </p>
            </div>
            <div className="rounded-full border border-amber-100 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700">
              {recurring
                ? `${recurringCompletedSessions} completed session${recurringCompletedSessions === 1 ? '' : 's'}`
                : 'Completed booking'}
            </div>
          </div>

          {review ? (
            <div className="space-y-4">
              <div className="rounded-2xl border border-gray-100 bg-gray-50/70 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <StarRatingDisplay rating={review.rating} size="h-5 w-5" />
                    <span className="text-sm font-semibold text-gray-900">
                      {review.rating} / 5
                    </span>
                  </div>
                  <span className="text-xs text-gray-500">
                    {formatDate(review.updatedAt || review.createdAt, timeZone)}
                  </span>
                </div>
                {review.comment ? (
                  <p className="text-sm leading-6 text-gray-700">{review.comment}</p>
                ) : (
                  <p className="text-sm text-gray-500">No written comment.</p>
                )}
                {canDeleteReview && (
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => {
                        if (!window.confirm('Delete your review?')) return;
                        deleteReviewMutation.mutate(review.id);
                      }}
                      disabled={deleteReviewMutation.isPending}
                      className="btn-secondary btn-sm"
                    >
                      {deleteReviewMutation.isPending ? 'Deleting...' : 'Delete review'}
                    </button>
                  </div>
                )}
              </div>

              {canUpdateReview && (
                <div className="rounded-2xl border border-sky-100 bg-sky-50/70 p-4 space-y-4">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">Add more feedback</p>
                    <p className="text-sm text-gray-500 mt-1">
                      Update your rating or keep adding new thoughts as more sessions in this series are completed.
                    </p>
                  </div>
                  <div>
                    <label className="label">Rating</label>
                    <StarRatingInput
                      value={reviewRating}
                      onChange={setReviewRating}
                      disabled={createReviewMutation.isPending}
                    />
                  </div>
                  <div>
                    <label className="label">Comment</label>
                    <textarea
                      value={reviewComment}
                      onChange={(event) => setReviewComment(event.target.value)}
                      rows={4}
                      className="input resize-none"
                      placeholder="Add new thoughts about how the sessions are going..."
                      maxLength={1000}
                    />
                    <p className="mt-1 text-xs text-gray-400">{reviewComment.length}/1000</p>
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() =>
                        createReviewMutation.mutate({
                          bookingId: booking.id,
                          rating: reviewRating,
                          comment: reviewComment,
                        })
                      }
                      disabled={createReviewMutation.isPending}
                      className="btn-primary gap-2"
                    >
                      <StarIcon className="w-4 h-4" />
                      {createReviewMutation.isPending ? 'Saving...' : 'Update review'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-2xl border border-gray-100 bg-gray-50/70 p-4 space-y-4">
              <div>
                <label className="label">Rating</label>
                <StarRatingInput
                  value={reviewRating}
                  onChange={setReviewRating}
                  disabled={createReviewMutation.isPending}
                />
              </div>
              <div>
                <label className="label">Comment</label>
                <textarea
                  value={reviewComment}
                  onChange={(event) => setReviewComment(event.target.value)}
                  rows={4}
                  className="input resize-none"
                  placeholder="Share your learning experience with this tutor..."
                  maxLength={1000}
                />
                <p className="mt-1 text-xs text-gray-400">{reviewComment.length}/1000</p>
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() =>
                    createReviewMutation.mutate({
                      bookingId: booking.id,
                      rating: reviewRating,
                      comment: reviewComment,
                    })
                  }
                  disabled={createReviewMutation.isPending}
                  className="btn-primary gap-2"
                >
                  <StarIcon className="w-4 h-4" />
                  {createReviewMutation.isPending
                    ? 'Submitting...'
                    : recurring
                      ? 'Submit review for this series'
                      : 'Submit review'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {showRescheduleModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/50 p-4">
          <div className="mx-auto flex min-h-full w-full max-w-4xl items-start justify-center py-6">
            <div className="w-full max-h-[90vh] overflow-hidden rounded-xl bg-white shadow-xl">
              <form
                onSubmit={handleRescheduleSubmit((formData) => {
                  const trimmedReason = (formData.reason || '').trim();
                  const isAcceptedRescheduleProposal = activeRescheduleBooking?.status === 'ACCEPTED';
                  if (isAcceptedRescheduleProposal && !trimmedReason) {
                    toast.error('Please provide a reason for the other participant.');
                    return;
                  }

                  const payload = {
                    scheduledAt: new Date(formData.newDate).toISOString(),
                    reason: trimmedReason,
                    expectedVersion: activeRescheduleBooking.version,
                  };
                  const request = isPendingRequestedTimeChange
                    ? bookingApi.changeRequestedTime(activeRescheduleBooking.id, {
                      ...payload,
                      expectedVersion: activeRescheduleBooking.version,
                    })
                    : isPendingTutorProposal
                      ? bookingApi.proposePendingTime(activeRescheduleBooking.id, {
                        ...payload,
                        expectedVersion: activeRescheduleBooking.version,
                      })
                    : isAcceptedRescheduleProposal
                      ? bookingApi.proposeReschedule(activeRescheduleBooking.id, payload)
                      : Promise.reject(new Error('This booking cannot be rescheduled'));

                  request
                    .then(async () => {
                      toast.success(
                        isPendingRequestedTimeChange
                          ? tutorProposedPendingTime
                            ? 'Different time proposed'
                            : 'Requested time changed'
                          : isPendingTutorProposal
                            ? 'New time proposed to learner'
                          : 'Reschedule proposal sent'
                      );
                      setShowRescheduleModal(false);
                      await invalidateBookingViews({ queryClient, currentUserId, id, bookingTutorId });
                    })
                    .catch(async (err) => {
                      toast.error(err?.response?.data?.message || 'Failed');
                      if (err?.response?.status === 409) {
                        setShowRescheduleModal(false);
                        await invalidateBookingViews({ queryClient, currentUserId, id, bookingTutorId });
                      }
                    });
                })}
                className="flex max-h-[90vh] flex-col"
              >
                <div className="overflow-y-auto p-6">
                  <h2 className="mb-5 text-lg font-bold text-gray-900">
                    {isPendingRequestedTimeChange
                      ? tutorProposedPendingTime
                        ? 'Propose Different Time'
                        : 'Change Requested Time'
                      : isPendingTutorProposal
                        ? 'Propose New Time'
                      : 'Propose New Time'}
                  </h2>
                  {activeRescheduleBooking?.scheduledAt && (
                    <p className="mb-4 text-sm text-gray-500">
                      Current session: {formatDate(activeRescheduleBooking.scheduledAt, timeZone)}
                    </p>
                  )}
                  <div className="space-y-4">
                    <div>
                      <label className="label">New Date & Time</label>
                      <p className="mb-2 text-sm text-gray-500">
                        {tutorCanChooseAnyFreeTime
                          ? 'Choose any free time. Your listed availability is highlighted in green.'
                          : 'Select a new time slot from the tutor\'s availability.'}
                      </p>
                      <input type="hidden" {...registerReschedule('newDate')} />
                      {rescheduleAvailabilityQuery.isLoading ? (
                        <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-6 text-sm text-gray-500">
                          Loading availability...
                        </div>
                      ) : (
                        <div className="rounded-2xl border border-gray-100 p-1">
                          <AvailabilityCalendar
                            slots={rescheduleAvailabilityState.sourceAvailability?.availability || rescheduleAvailability}
                            currentWeekSlots={rescheduleAvailabilityState.sourceAvailability?.currentWeekEffectiveAvailability || rescheduleCurrentWeekAvailability}
                            hasCurrentWeekOverride={rescheduleHasCurrentWeekAvailabilityOverride}
                            bookedSlots={rescheduleBookedSlots}
                            mode="select"
                            selectedSlots={selectedRescheduleSlot ? [selectedRescheduleSlot] : []}
                            durationMinutes={activeRescheduleBooking?.duration || 60}
                            timezone={timeZone}
                            availabilityTimezone={rescheduleAvailabilityState.sourceAvailability ? rescheduleAvailabilityState.tutorTimezone : timeZone}
                            allowOutsideAvailability={tutorCanChooseAnyFreeTime}
                            onSelect={(slot) => {
                              setSelectedRescheduleSlot(slot);
                              setRescheduleValue('newDate', slot.date.toISOString(), { shouldValidate: true });
                            }}
                          />
                        </div>
                      )}
                      {selectedRescheduleSlot && (
                        <div className="mt-3">
                          <span className="rounded-full border border-primary-200 bg-primary-50 px-3 py-1 text-xs text-primary-700">
                            {selectedRescheduleSlot.date.toLocaleString('en-AU')}
                          </span>
                        </div>
                      )}
                      {rescheduleErrors.newDate && (
                        <p className="error-text">{rescheduleErrors.newDate.message}</p>
                      )}
                    </div>
                    <div>
                      <label className="label">
                        Reason {activeRescheduleBooking?.status === 'ACCEPTED' ? '' : '(optional)'}
                      </label>
                      <textarea
                        {...registerReschedule('reason')}
                        rows={2}
                        className="input resize-none"
                        placeholder={
                          isPendingRequestedTimeChange
                            ? tutorProposedPendingTime
                              ? 'Optional note with your counter-proposal...'
                              : 'Optional note for your tutor...'
                            : isPendingTutorProposal
                              ? 'Optional note for the learner...'
                            : 'Explain why you are proposing a new time...'
                        }
                      />
                    </div>
                  </div>
                </div>
                <div className="border-t border-gray-100 bg-white p-6 pt-4">
                  <div className="flex gap-3">
                    <button type="submit" className="btn-primary flex-1">
                      {isPendingRequestedTimeChange
                        ? tutorProposedPendingTime
                          ? 'Send Counter-Proposal'
                          : 'Confirm New Time'
                        : isPendingTutorProposal
                          ? 'Send Proposal'
                        : 'Send Proposal'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowRescheduleModal(false)}
                      className="btn-secondary flex-1"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
