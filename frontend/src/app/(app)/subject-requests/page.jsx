'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  AcademicCapIcon,
  CheckCircleIcon,
  ClockIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';

import { subjectApi, subjectRequestApi } from '../../../lib/api-entry';
import { getAvatarUrl } from '../../../lib/avatar';
import { formatTimeAgo } from '../../../lib/formatters';
import { useAuthStore } from '../../../lib/store';
import {
  getInitialSubjectRequestStatus,
  getSubjectRequestStatusClass,
  getSubjectRequestTabs,
  validateSubjectRequestForm,
} from '../../../lib/subject-requests';

const EMPTY_FORM = {
  subjectName: '',
  category: '',
  description: '',
};

export default function SubjectRequestsPage() {
  return (
    <Suspense fallback={<SubjectRequestsFallback />}>
      <SubjectRequestsContent />
    </Suspense>
  );
}

export function SubjectRequestsContent() {
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const role = user?.role || '';
  const isTutor = role === 'TUTOR';
  const isLearner = role === 'LEARNER';
  const currentUserId = user?.id || '';
  const statusParam = searchParams.get('status');
  const subjectParam = searchParams.get('subject') || '';
  const [activeStatus, setActiveStatus] = useState(() =>
    getInitialSubjectRequestStatus(statusParam, role)
  );
  const [page, setPage] = useState(1);
  const [form, setForm] = useState(() => ({ ...EMPTY_FORM, subjectName: subjectParam }));
  const [acceptingRequest, setAcceptingRequest] = useState(null);
  const [acceptHourlyRate, setAcceptHourlyRate] = useState('');
  const [acceptRateError, setAcceptRateError] = useState('');

  useEffect(() => {
    setActiveStatus(getInitialSubjectRequestStatus(statusParam, role));
    setPage(1);
  }, [role, statusParam]);

  useEffect(() => {
    if (!subjectParam) return;
    setForm((current) => ({ ...current, subjectName: current.subjectName || subjectParam }));
  }, [subjectParam]);

  const categoriesQuery = useQuery({
    queryKey: ['subject-categories'],
    queryFn: () => subjectApi.getCategories(),
    enabled: isLearner,
  });

  const categories = useMemo(() => {
    const values = categoriesQuery.data?.data?.data || [];
    return values
      .map((item) => (typeof item === 'string' ? item : item?.category || item?.name || ''))
      .filter(Boolean);
  }, [categoriesQuery.data]);

  const requestsQuery = useQuery({
    queryKey: ['subject-requests', currentUserId, activeStatus, page],
    queryFn: () =>
      subjectRequestApi.list({
        ...(activeStatus ? { status: activeStatus } : {}),
        page,
        limit: 10,
      }),
    enabled: Boolean(currentUserId && (isLearner || isTutor)),
    keepPreviousData: true,
  });

  const subjectRequests = requestsQuery.data?.data?.data?.subjectRequests || [];
  const pagination = requestsQuery.data?.data?.data?.pagination || {};
  const totalPages = pagination.totalPages || 1;
  const currentPage = pagination.page || page;
  const tabs = getSubjectRequestTabs(role);

  const invalidateRequests = () =>
    queryClient.invalidateQueries({ queryKey: ['subject-requests', currentUserId] });

  const createMutation = useMutation({
    mutationFn: (payload) => subjectRequestApi.create(payload),
    onSuccess: async () => {
      toast.success('Subject request submitted');
      setForm(EMPTY_FORM);
      setActiveStatus('');
      setPage(1);
      await invalidateRequests();
    },
    onError: (error) => {
      toast.error(error?.response?.data?.message || 'Failed to submit subject request');
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (requestId) => subjectRequestApi.cancel(requestId),
    onSuccess: async () => {
      toast.success('Subject request cancelled');
      await invalidateRequests();
    },
    onError: (error) => {
      toast.error(error?.response?.data?.message || 'Failed to cancel subject request');
    },
  });

  const acceptMutation = useMutation({
    mutationFn: ({ requestId, hourlyRate }) => subjectRequestApi.accept(requestId, hourlyRate),
    onSuccess: async () => {
      toast.success('Subject added to your tutor profile');
      setAcceptingRequest(null);
      setAcceptHourlyRate('');
      setAcceptRateError('');
      await Promise.all([
        invalidateRequests(),
        queryClient.invalidateQueries({ queryKey: ['my-tutor-profile'] }),
        queryClient.invalidateQueries({ queryKey: ['all-subjects'] }),
        queryClient.invalidateQueries({ queryKey: ['subject-categories'] }),
      ]);
    },
    onError: async (error) => {
      toast.error(error?.response?.data?.message || 'Failed to accept subject request');
      if (error?.response?.status === 409) await invalidateRequests();
    },
  });

  const updateForm = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    const validationError = validateSubjectRequestForm(form);
    if (validationError) {
      toast.error(validationError);
      return;
    }

    createMutation.mutate({
      subjectName: form.subjectName.trim(),
      category: form.category,
      description: form.description.trim(),
    });
  };

  const handleCancel = (requestId) => {
    if (!window.confirm('Cancel this subject request?')) return;
    cancelMutation.mutate(requestId);
  };

  const handleAccept = (subjectRequest) => {
    setAcceptingRequest(subjectRequest);
    setAcceptHourlyRate('');
    setAcceptRateError('');
  };

  const closeAcceptDialog = () => {
    if (acceptMutation.isPending) return;
    setAcceptingRequest(null);
    setAcceptHourlyRate('');
    setAcceptRateError('');
  };

  const confirmAccept = (event) => {
    event.preventDefault();
    const rawRate = acceptHourlyRate.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(rawRate) || Number(rawRate) <= 0) {
      setAcceptRateError('Enter a rate greater than $0 with no more than two decimal places.');
      return;
    }

    setAcceptRateError('');
    acceptMutation.mutate({
      requestId: acceptingRequest.id,
      hourlyRate: rawRate,
    });
  };

  if (role && !isLearner && !isTutor) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-8 text-center">
        <AcademicCapIcon className="mx-auto mb-3 h-10 w-10 text-gray-300" />
        <p className="font-medium text-gray-900">The Subject Board is available to learners and tutors.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Subject Board</h1>
        <p className="mt-1 text-gray-600">
          {isTutor
            ? 'Help learners find support for subjects that are not in the catalogue yet.'
            : 'Tell tutors what you want to learn when you cannot find the subject in search.'}
        </p>
      </div>

      {isLearner && (
        <form onSubmit={handleSubmit} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-gray-900">Request a missing subject</h2>
            <p className="mt-1 text-sm text-gray-500">
              Your name stays private while approved tutors review the board.
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-gray-700">Subject name</span>
              <input
                type="text"
                value={form.subjectName}
                onChange={(event) => updateForm('subjectName', event.target.value)}
                className="input w-full"
                placeholder="e.g. Rust Programming"
                maxLength={100}
                required
              />
              <span className="mt-1 block text-right text-xs text-gray-400">
                {form.subjectName.length}/100
              </span>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-gray-700">Category</span>
              <select
                value={form.category}
                onChange={(event) => updateForm('category', event.target.value)}
                className="input w-full"
                required
                disabled={categoriesQuery.isLoading}
              >
                <option value="">
                  {categoriesQuery.isLoading ? 'Loading categories...' : 'Select a category...'}
                </option>
                {categories.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
              {categoriesQuery.isError && (
                <button
                  type="button"
                  onClick={() => categoriesQuery.refetch()}
                  className="mt-1 text-xs font-medium text-red-600 hover:text-red-700"
                >
                  Categories failed to load — retry
                </button>
              )}
            </label>
          </div>

          <label className="mt-4 block">
            <span className="mb-1.5 block text-sm font-medium text-gray-700">
              What would you like help learning?
            </span>
            <textarea
              value={form.description}
              onChange={(event) => updateForm('description', event.target.value)}
              className="input min-h-28 w-full resize-y"
              placeholder="Describe the topics, goals, or level of support you need."
              maxLength={1000}
              required
            />
            <span className="mt-1 block text-right text-xs text-gray-400">
              {form.description.length}/1000
            </span>
          </label>

          <div className="mt-4 flex justify-end">
            <button
              type="submit"
              className="btn-primary"
              disabled={createMutation.isPending || categoriesQuery.isError}
            >
              {createMutation.isPending ? 'Submitting...' : 'Submit request'}
            </button>
          </div>
        </form>
      )}

      <section className="space-y-4">
        <div className="flex gap-1 overflow-x-auto border-b border-gray-200 pb-px">
          {tabs.map((tab) => (
            <button
              key={tab.value || 'ALL'}
              type="button"
              onClick={() => {
                setActiveStatus(tab.value);
                setPage(1);
              }}
              className={`min-w-fit flex-1 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${
                activeStatus === tab.value
                  ? 'border-primary-600 text-primary-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {requestsQuery.isError && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4">
            <p className="text-sm text-red-700">
              {requestsQuery.error?.response?.data?.message || 'Failed to load subject requests.'}
            </p>
            <button type="button" onClick={() => requestsQuery.refetch()} className="btn-primary btn-sm mt-3">
              Retry
            </button>
          </div>
        )}

        {requestsQuery.isLoading ? (
          <SubjectRequestsFallback />
        ) : !requestsQuery.isError && subjectRequests.length === 0 ? (
          <div className="rounded-xl border border-gray-200 bg-white px-5 py-14 text-center">
            <AcademicCapIcon className="mx-auto mb-3 h-12 w-12 text-gray-300" />
            <h3 className="font-medium text-gray-900">
              {isTutor ? 'No subject requests here yet' : 'No requests found'}
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              {isTutor
                ? 'New learner requests will appear here when they are submitted.'
                : activeStatus
                  ? `You do not have any ${activeStatus.toLowerCase()} requests.`
                  : 'Use the form above when a subject is missing from tutor search.'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {subjectRequests.map((subjectRequest) => (
              <SubjectRequestCard
                key={subjectRequest.id}
                subjectRequest={subjectRequest}
                isTutor={isTutor}
                onCancel={handleCancel}
                onAccept={handleAccept}
                actionPending={cancelMutation.isPending || acceptMutation.isPending}
              />
            ))}
          </div>
        )}

        {!requestsQuery.isLoading && !requestsQuery.isError && totalPages > 1 && (
          <div className="flex items-center justify-center gap-3">
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={() => setPage((value) => Math.max(1, value - 1))}
              disabled={currentPage <= 1}
            >
              ← Previous
            </button>
            <span className="text-sm text-gray-600">
              Page {currentPage} of {totalPages}
            </span>
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
              disabled={currentPage >= totalPages}
            >
              Next →
            </button>
          </div>
        )}
      </section>

      {acceptingRequest && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="accept-subject-title"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeAcceptDialog();
          }}
        >
          <form
            onSubmit={confirmAccept}
            className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
          >
            <h2 id="accept-subject-title" className="text-lg font-semibold text-gray-900">
              Set your rate for {acceptingRequest.subjectName}
            </h2>
            <p className="mt-2 text-sm text-gray-600">
              This subject will be added to your tutor profile at all levels.
            </p>

            <div className="mt-5">
              <label
                htmlFor="accept-hourly-rate"
                className="mb-1.5 block text-sm font-medium text-gray-700"
              >
                Hourly rate (AUD)
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-gray-500">
                  $
                </span>
                <input
                  id="accept-hourly-rate"
                  type="number"
                  inputMode="decimal"
                  min="0.01"
                  step="0.01"
                  value={acceptHourlyRate}
                  onChange={(event) => {
                    setAcceptHourlyRate(event.target.value);
                    setAcceptRateError('');
                  }}
                  className="input w-full pl-7"
                  placeholder="e.g. 65.00"
                  autoFocus
                  required
                  aria-invalid={Boolean(acceptRateError)}
                  aria-describedby={acceptRateError ? 'accept-rate-error' : undefined}
                />
              </div>
              {acceptRateError && (
                <span id="accept-rate-error" className="mt-1.5 block text-sm text-red-600">
                  {acceptRateError}
                </span>
              )}
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                className="btn-secondary"
                onClick={closeAcceptDialog}
                disabled={acceptMutation.isPending}
              >
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={acceptMutation.isPending}>
                {acceptMutation.isPending ? 'Accepting...' : 'Accept and add subject'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function SubjectRequestCard({ subjectRequest, isTutor, onCancel, onAccept, actionPending }) {
  const tutor = subjectRequest.acceptedTutor;
  const tutorUser = tutor?.user;
  const tutorName = tutorUser
    ? `${tutorUser.firstName || ''} ${tutorUser.lastName || ''}`.trim()
    : '';
  const tutorAvatar = tutorUser
    ? getAvatarUrl(tutorUser.avatar, tutorUser.firstName, tutorUser.lastName, {
        fallbackName: 'Tutor',
      })
    : '';

  return (
    <article className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-gray-900">{subjectRequest.subjectName}</h2>
            <span
              className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${getSubjectRequestStatusClass(
                subjectRequest.status
              )}`}
            >
              {subjectRequest.status === 'OPEN'
                ? 'Open'
                : subjectRequest.status === 'ACCEPTED'
                  ? 'Accepted'
                  : 'Cancelled'}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
            <span className="inline-flex items-center gap-1">
              <AcademicCapIcon className="h-4 w-4" />
              {subjectRequest.category}
            </span>
            <span className="inline-flex items-center gap-1">
              <ClockIcon className="h-4 w-4" />
              Requested {formatTimeAgo(subjectRequest.createdAt)}
            </span>
          </div>
        </div>

        {subjectRequest.status === 'OPEN' && (
          isTutor ? (
            <button
              type="button"
              className="btn-primary btn-sm gap-1.5"
              onClick={() => onAccept(subjectRequest)}
              disabled={actionPending}
            >
              <CheckCircleIcon className="h-4 w-4" />
              Accept request
            </button>
          ) : (
            <button
              type="button"
              className="btn-secondary btn-sm gap-1.5 text-red-600 hover:text-red-700"
              onClick={() => onCancel(subjectRequest.id)}
              disabled={actionPending}
            >
              <XMarkIcon className="h-4 w-4" />
              Cancel
            </button>
          )
        )}
      </div>

      <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-gray-700">
        {subjectRequest.description}
      </p>

      {!isTutor && subjectRequest.status === 'ACCEPTED' && tutor && (
        <div className="mt-5 flex flex-col gap-3 rounded-xl border border-green-200 bg-green-50 p-4 sm:flex-row sm:items-center">
          <img
            src={tutorAvatar}
            alt={tutorName || 'Tutor'}
            className="h-11 w-11 rounded-full border border-white object-cover"
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-gray-900">{tutorName || 'Your tutor'}</p>
            <p className="truncate text-xs text-gray-600">
              {tutor.headline || 'Available to teach this subject'}
            </p>
          </div>
          <Link href={`/tutors/${tutor.id}?from=subject-requests`} className="btn-primary btn-sm text-center">
            View tutor and book
          </Link>
        </div>
      )}

      {isTutor && subjectRequest.status === 'ACCEPTED' && (
        <div className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-green-700">
          <CheckCircleIcon className="h-5 w-5" />
          Added to your tutor profile at all levels
        </div>
      )}
    </article>
  );
}

function SubjectRequestsFallback() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="animate-pulse rounded-xl border border-gray-200 bg-white p-5">
          <div className="h-5 w-1/3 rounded bg-gray-200" />
          <div className="mt-3 h-3 w-1/4 rounded bg-gray-200" />
          <div className="mt-5 h-3 w-full rounded bg-gray-100" />
          <div className="mt-2 h-3 w-2/3 rounded bg-gray-100" />
        </div>
      ))}
    </div>
  );
}
