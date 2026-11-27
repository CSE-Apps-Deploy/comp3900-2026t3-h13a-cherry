// src/app/(app)/tutor/profile/page.jsx - Tutor Profile Management
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { BanknotesIcon, LockClosedIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/outline';
import { tutorApi, subjectApi, userApi } from '../../../../lib/api-entry';
import AvailabilityCalendar from '../../../../components/AvailabilityCalendar';
import CancellationPolicySummary from '../../../../components/CancellationPolicySummary';
import { cloneSlots } from '../../../../lib/availability-calendar';
import { calculateClientEarningPreview } from '../../../../lib/earnings';
import { formatCurrency, getDeviceTimezone, getUserTimezone } from '../../../../lib/formatters';
import { useAuthStore } from '../../../../lib/store';
import {
  getTutorAccessStateFromProfile,
  TUTOR_REVIEW_PATH,
  TUTOR_VERIFICATION_PATH,
} from '../../../../lib/tutor-access';
import { TUTOR_SESSION_TYPES } from '../../../../lib/tutor-options';
import { cn } from '../../../../lib/utils';
import {
  CANCELLATION_CUTOFF_OPTIONS,
  LATE_REFUND_OPTIONS,
  normalizeCancellationPolicy,
} from '../../../../lib/cancellation-policy';

const DAY_OPTIONS = [
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
  { value: '0', label: 'Sunday' },
];

const LEVELS = [
  { value: 'beginner', label: 'Beginner' },
  { value: 'intermediate', label: 'Intermediate' },
  { value: 'advanced', label: 'Advanced' },
  { value: 'all', label: 'All Levels' },
];

const CURRENCIES = ['AUD', 'USD', 'GBP', 'EUR'];

const TIMEZONE_OPTIONS = [
  'Australia/Sydney',
  'Australia/Melbourne',
  'Australia/Brisbane',
  'Australia/Perth',
  'Australia/Adelaide',
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Europe/London',
  'America/Los_Angeles',
  'America/New_York',
  'UTC',
];

function SubjectRateEarningEstimate({ hourlyRate, currency = 'AUD' }) {
  const rate = Number(hourlyRate);
  if (!Number.isFinite(rate) || rate <= 0) return null;

  const estimate = calculateClientEarningPreview({ amount: rate, currency });

  return (
    <p className="mt-1 text-xs leading-5 text-gray-500">
      Estimated earnings:{' '}
      <span className="font-semibold text-emerald-700">
        {formatCurrency(estimate.netAmount, estimate.currency)}/hr
      </span>
    </p>
  );
}

export default function TutorProfilePage() {
  const queryClient = useQueryClient();
  const fetchMe = useAuthStore((state) => state.fetchMe);
  const [activeTab, setActiveTab] = useState('profile');
  const [profileForm, setProfileForm] = useState({
    headline: '',
    bio: '',
    hourlyRate: 50,
    trialLessonLimit: 0,
    currency: 'AUD',
    location: '',
    sessionTypes: ['ONLINE'],
    yearsExperience: 0,
    education: '',
    workExperience: '',
    certificationItems: '',
    languages: '',
    timezone: getDeviceTimezone() || 'UTC',
  });
  const [availability, setAvailability] = useState([]);
  const [currentWeekAvailability, setCurrentWeekAvailability] = useState([]);
  const [hasCurrentWeekAvailabilityOverride, setHasCurrentWeekAvailabilityOverride] = useState(false);
  const [showCurrentWeekEditor, setShowCurrentWeekEditor] = useState(false);
  const [mySubjects, setMySubjects] = useState([]);
  const [selectedSubjectId, setSelectedSubjectId] = useState('');
  const [selectedLevel, setSelectedLevel] = useState('all');
  const [selectedHourlyRate, setSelectedHourlyRate] = useState('');
  const [editingSubjectRates, setEditingSubjectRates] = useState({});
  const [cancellationPolicyForm, setCancellationPolicyForm] = useState({
    cutoffHours: 24,
    lateRefundPercent: 0,
  });

  const {
    data: profileData,
    isLoading: profileLoading,
    isError: profileError,
    error: profileQueryError,
  } = useQuery({
    queryKey: ['my-tutor-profile'],
    queryFn: () => tutorApi.getMyProfile(),
  });

  const {
    data: subjectsData,
    isLoading: subjectsLoading,
    isError: subjectsError,
    error: subjectsQueryError,
  } = useQuery({
    queryKey: ['all-subjects'],
    queryFn: () => subjectApi.getAll(),
  });

  const profile = profileData?.data?.data;
  const timeZone = getUserTimezone(profile?.user);
  const allSubjects = subjectsData?.data?.data?.subjects || [];
  const isApproved = profile?.status === 'ACTIVE';
  const latestReviewAction = profile?.latestReviewAction;
  const tutorAccessState = getTutorAccessStateFromProfile(profile);
  const pendingActionHref =
    tutorAccessState === 'PENDING_REVIEW' ? TUTOR_REVIEW_PATH : TUTOR_VERIFICATION_PATH;
  const pendingActionLabel =
    tutorAccessState === 'PENDING_REVIEW' ? 'Open Review Status' : 'Complete Verification';

  useEffect(() => {
    if (!profile) return;

    const certs = Array.isArray(profile.certifications) ? profile.certifications : [];
    setProfileForm({
      headline: profile.headline || '',
      bio: profile.user?.bio || '',
      hourlyRate: profile.hourlyRate || 50,
      trialLessonLimit: Number(profile.trialLessonLimit || 0),
      currency: profile.currency || 'AUD',
      location: profile.location || '',
      sessionTypes: profile.sessionTypes || ['ONLINE'],
      yearsExperience: profile.yearsExperience || 0,
      education: Array.isArray(profile.education)
        ? profile.education.map((item) => (typeof item === 'string' ? item : item?.text || '')).filter(Boolean).join('\n')
        : profile.education || '',
      workExperience: certs
        .filter((item) => item?.kind === 'experience' && item?.text)
        .map((item) => item.text)
        .join('\n'),
      certificationItems: certs
        .filter((item) => item?.kind === 'qualification' && item?.text)
        .map((item) => item.text)
        .join('\n'),
      languages: Array.isArray(profile.languages) ? profile.languages.join(', ') : '',
      timezone: profile.user?.timezone || getDeviceTimezone() || 'UTC',
    });

    setAvailability(cloneSlots(profile.availability || []));
    setCurrentWeekAvailability(
      cloneSlots(profile.currentWeekEffectiveAvailability || profile.availability || [])
    );
    setHasCurrentWeekAvailabilityOverride(Boolean(profile.hasCurrentWeekAvailabilityOverride));
    setShowCurrentWeekEditor(Boolean(profile.hasCurrentWeekAvailabilityOverride));

    setMySubjects(profile.subjects || []);
    setSelectedHourlyRate(String(profile.hourlyRate || 50));
    setCancellationPolicyForm(normalizeCancellationPolicy(profile));
  }, [profile]);

  const updateProfileMutation = useMutation({
    mutationFn: async ({ timezone, tutorProfile }) => {
      await userApi.updateProfile({ bio: tutorProfile.bio, timezone });
      return tutorApi.updateProfile(tutorProfile);
    },
    onSuccess: async () => {
      toast.success('Profile updated');
      await fetchMe();
      queryClient.invalidateQueries({ queryKey: ['my-tutor-profile'] });
    },
    onError: (err) => {
      toast.error(err?.response?.data?.message || 'Failed to update profile');
    },
  });

  const updateAvailabilityMutation = useMutation({
    mutationFn: (slots) => tutorApi.updateAvailability(slots),
    onSuccess: () => {
      toast.success('Availability updated');
      queryClient.invalidateQueries({ queryKey: ['my-tutor-profile'] });
      queryClient.invalidateQueries({ queryKey: ['tutor-availability'] });
    },
    onError: () => {
      toast.error('Failed to update availability');
    },
  });

  const updateCancellationPolicyMutation = useMutation({
    mutationFn: (policy) => tutorApi.updateCancellationPolicy(policy),
    onSuccess: () => {
      toast.success('Cancellation policy updated');
      queryClient.invalidateQueries({ queryKey: ['my-tutor-profile'] });
      queryClient.invalidateQueries({ queryKey: ['tutor'] });
    },
    onError: (err) => {
      toast.error(err?.response?.data?.message || 'Failed to update cancellation policy');
    },
  });

  const updateCurrentWeekAvailabilityMutation = useMutation({
    mutationFn: (slots) => tutorApi.updateCurrentWeekAvailability(slots),
    onSuccess: () => {
      toast.success('This week availability updated');
      queryClient.invalidateQueries({ queryKey: ['my-tutor-profile'] });
      queryClient.invalidateQueries({ queryKey: ['tutor-availability'] });
    },
    onError: (err) => {
      toast.error(err?.response?.data?.message || 'Failed to update this week availability');
    },
  });

  const clearCurrentWeekAvailabilityMutation = useMutation({
    mutationFn: () => tutorApi.clearCurrentWeekAvailability(),
    onSuccess: () => {
      toast.success('This week is back to your regular schedule');
      queryClient.invalidateQueries({ queryKey: ['my-tutor-profile'] });
      queryClient.invalidateQueries({ queryKey: ['tutor-availability'] });
    },
    onError: (err) => {
      toast.error(err?.response?.data?.message || 'Failed to clear this week availability');
    },
  });

  const addSubjectMutation = useMutation({
    mutationFn: ({ subjectId, level, hourlyRate }) =>
      tutorApi.addSubject(subjectId, { level, hourlyRate }),
    onSuccess: () => {
      toast.success('Subject added');
      queryClient.invalidateQueries({ queryKey: ['my-tutor-profile'] });
      setSelectedSubjectId('');
      setSelectedLevel('all');
      setSelectedHourlyRate(String(profile?.hourlyRate || 50));
    },
    onError: (err) => {
      toast.error(err?.response?.data?.message || 'Failed to add subject');
    },
  });

  const updateSubjectRateMutation = useMutation({
    mutationFn: ({ subjectId, hourlyRate }) => tutorApi.updateSubjectRate(subjectId, hourlyRate),
    onSuccess: (_data, variables) => {
      toast.success('Subject rate updated');
      setEditingSubjectRates((current) => {
        const next = { ...current };
        delete next[variables.subjectId];
        return next;
      });
      queryClient.invalidateQueries({ queryKey: ['my-tutor-profile'] });
    },
    onError: (err) => {
      toast.error(err?.response?.data?.message || 'Failed to update subject rate');
    },
  });

  const removeSubjectMutation = useMutation({
    mutationFn: (subjectId) => tutorApi.removeSubject(subjectId),
    onSuccess: () => {
      toast.success('Subject removed');
      queryClient.invalidateQueries({ queryKey: ['my-tutor-profile'] });
    },
    onError: () => {
      toast.error('Failed to remove subject');
    },
  });

  const handleProfileChange = (key, value) => {
    setProfileForm((prev) => ({ ...prev, [key]: value }));
  };

  const toggleSessionType = (type) => {
    setProfileForm((prev) => {
      const current = prev.sessionTypes || [];
      const next = current.includes(type)
        ? current.filter((item) => item !== type)
        : [...current, type];
      return { ...prev, sessionTypes: next };
    });
  };

  const handleSaveProfile = () => {
    if (!profileForm.hourlyRate || Number(profileForm.hourlyRate) <= 0) {
      toast.error('Hourly rate must be greater than 0');
      return;
    }

    if (!profileForm.sessionTypes || profileForm.sessionTypes.length === 0) {
      toast.error('Select at least one session type');
      return;
    }

    const trialLessonLimit = Number(profileForm.trialLessonLimit);
    if (!Number.isInteger(trialLessonLimit) || trialLessonLimit < 0) {
      toast.error('Trial lesson allowance must be a non-negative whole number');
      return;
    }

    const experienceItems = profileForm.workExperience
      ? profileForm.workExperience.split('\n').map((s) => s.trim()).filter(Boolean).map((text) => ({ kind: 'experience', text }))
      : [];
    const qualificationItems = profileForm.certificationItems
      ? profileForm.certificationItems.split('\n').map((s) => s.trim()).filter(Boolean).map((text) => ({ kind: 'qualification', text }))
      : [];

    const existingFileCerts = Array.isArray(profile?.certifications)
      ? profile.certifications.filter((item) => item?.kind === 'file')
      : [];

    const payload = {
      headline: profileForm.headline,
      bio: profileForm.bio,
      hourlyRate: Number(profileForm.hourlyRate),
      trialLessonLimit,
      currency: profileForm.currency,
      location: profileForm.location,
      sessionTypes: profileForm.sessionTypes,
      yearsExperience: Number(profileForm.yearsExperience || 0),
      languages: profileForm.languages
        ? profileForm.languages.split(',').map((item) => item.trim()).filter(Boolean)
        : [],
      education: profileForm.education
        ? profileForm.education.split('\n').map((item) => item.trim()).filter(Boolean)
        : [],
      certifications: [...existingFileCerts, ...experienceItems, ...qualificationItems],
    };

    updateProfileMutation.mutate({
      timezone: profileForm.timezone,
      tutorProfile: payload,
    });
  };

  const addAvailabilitySlot = () => {
    setAvailability((prev) => [
      ...prev,
      { dayOfWeek: '1', startTime: '09:00', endTime: '17:00' },
    ]);
  };

  const removeAvailabilitySlot = (index) => {
    setAvailability((prev) => prev.filter((_, i) => i !== index));
  };

  const updateSlot = (index, key, value) => {
    setAvailability((prev) =>
      prev.map((slot, i) => (i === index ? { ...slot, [key]: value } : slot))
    );
  };

  const handleSaveAvailability = () => {
    updateAvailabilityMutation.mutate(availability);
  };

  const handleSaveCancellationPolicy = () => {
    updateCancellationPolicyMutation.mutate(cancellationPolicyForm);
  };

  const handleToggleCurrentWeekEditor = () => {
    setShowCurrentWeekEditor((current) => {
      if (!current && !hasCurrentWeekAvailabilityOverride) {
        setCurrentWeekAvailability(cloneSlots(availability));
      }
      return !current;
    });
  };

  const handleSaveCurrentWeekAvailability = () => {
    updateCurrentWeekAvailabilityMutation.mutate(currentWeekAvailability);
  };

  const handleClearCurrentWeekAvailability = () => {
    clearCurrentWeekAvailabilityMutation.mutate();
  };

  const getTutorSubjectId = (item) => item.subjectId || item.subject?.id || item.id;
  const currentSubjectIds = mySubjects.map(getTutorSubjectId);
  const availableSubjects = allSubjects.filter((subject) => !currentSubjectIds.includes(subject.id));
  const isValidHourlyRate = (value) =>
    /^\d+(\.\d{1,2})?$/.test(String(value).trim()) && Number(value) > 0;

  const handleAddSubject = () => {
    if (!selectedSubjectId) {
      toast.error('Select a subject first');
      return;
    }

    const subject = allSubjects.find((item) => String(item.id) === String(selectedSubjectId));
    if (!subject) {
      toast.error('Selected subject is invalid');
      return;
    }

    if (!isValidHourlyRate(selectedHourlyRate)) {
      toast.error('Hourly rate must be a positive AUD amount with up to two decimal places');
      return;
    }

    addSubjectMutation.mutate({
      subjectId: selectedSubjectId,
      level: selectedLevel,
      hourlyRate: selectedHourlyRate,
    });
  };

  const handleSubjectRateChange = (subjectId, value) => {
    setEditingSubjectRates((current) => ({ ...current, [subjectId]: value }));
  };

  const handleUpdateSubjectRate = (subjectId, fallbackRate) => {
    const nextRate = editingSubjectRates[subjectId] ?? fallbackRate;

    if (!isValidHourlyRate(nextRate)) {
      toast.error('Hourly rate must be a positive AUD amount with up to two decimal places');
      return;
    }

    updateSubjectRateMutation.mutate({ subjectId, hourlyRate: nextRate });
  };

  const handleRemoveSubject = (subjectId) => {
    removeSubjectMutation.mutate(subjectId);
  };

  if (profileLoading || subjectsLoading) {
    return (
      <div className="w-full space-y-4 animate-pulse">
        <div className="h-10 bg-gray-200 rounded w-1/3" />
        <div className="card p-6 h-48" />
      </div>
    );
  }

  if (profileError || subjectsError || !profile) {
    return (
      <div className="w-full">
        <div className="card p-6">
          <h1 className="page-title">Tutor Profile</h1>
          <p className="text-sm text-gray-600 mt-3">
            {profileQueryError?.response?.data?.message ||
              subjectsQueryError?.response?.data?.message ||
              'Tutor profile data is unavailable for this account.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full space-y-5">
      <div>
        <div className='flex'>
          <h1 className="page-title flex-1">Tutor Profile</h1>
        </div>
        <p className="text-gray-600 mt-1">
          Status:{' '}
            <span
              className={cn(
                'font-medium',
                profile?.status === 'ACTIVE' && 'text-green-600',
                profile?.status === 'PENDING' && 'text-yellow-600',
                profile?.status === 'SUSPENDED' && 'text-red-600'
              )}
            >
              {profile?.status || '-'}
            </span>
          </p>
      </div>

      <div className="space-y-4">
        {!isApproved && (
          <>
          <div className="card p-5 border-yellow-200 bg-yellow-50/70">
            <div className="flex items-start gap-3">
              <LockClosedIcon className="w-5 h-5 text-yellow-700 mt-0.5" />
              <div>
                <h2 className="font-semibold text-gray-900">Tutor profile locked until approval</h2>
                <p className="text-sm text-gray-600 mt-1">
                  Finish your verification submission or wait for admin approval before editing your
                  public tutor profile.
                </p>
                <Link href={pendingActionHref} className="btn-primary mt-4 inline-flex">
                  {pendingActionLabel}
                </Link>
              </div>
            </div>
          </div>

          {latestReviewAction?.description && (
            <div className="card p-5 border-blue-200 bg-blue-50/70">
              <h3 className="font-semibold text-gray-900">Latest admin feedback</h3>
              <p className="text-sm text-gray-600 mt-2">{latestReviewAction.description}</p>
            </div>
          )}

          </>
        )}
      </div>

      {isApproved && (
        <>
          <Link
            href="/tutor/payouts"
            className="flex items-center justify-between gap-4 rounded-2xl border border-gray-200 bg-white p-4 hover:border-primary-300 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-primary-50 p-2.5">
                <BanknotesIcon className="w-6 h-6 text-primary-600" />
              </div>
              <div>
                <p className="font-semibold text-gray-900">Earnings &amp; Payouts</p>
                <p className="text-sm text-gray-500">
                  Set up where you get paid. Required before accepting paid bookings.
                </p>
              </div>
            </div>
            <span className="btn-secondary btn-sm shrink-0">Manage</span>
          </Link>

          <div className="border-b border-gray-200 flex gap-1 overflow-x-auto">
            {['profile', 'subjects', 'cancellation policy', 'availability'].map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab === 'cancellation policy' ? 'cancellation' : tab)}
                className={cn(
                  'shrink-0 whitespace-nowrap px-4 py-2.5 -mb-px text-sm font-medium capitalize border-b-2 transition-colors',
                  activeTab === (tab === 'cancellation policy' ? 'cancellation' : tab)
                    ? 'border-primary-600 text-primary-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                )}
              >
                {tab}
              </button>
            ))}
          </div>

          {activeTab === 'profile' && (
        <div className="card p-6 space-y-4">
          <div>
            <label className="label">Headline</label>
            <input
              value={profileForm.headline}
              onChange={(e) => handleProfileChange('headline', e.target.value)}
              className="input"
              placeholder="e.g. Mathematics Tutor with 5 years experience"
            />
          </div>

          <div>
            <label className="label">About / Bio</label>
            <textarea
              value={profileForm.bio}
              onChange={(e) => handleProfileChange('bio', e.target.value)}
              rows={5}
              className="input resize-none"
              placeholder="Describe your teaching style and experience..."
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="label">Hourly Rate</label>
              <input
                type="number"
                min="1"
                step="0.01"
                value={profileForm.hourlyRate}
                onChange={(e) => handleProfileChange('hourlyRate', e.target.value)}
                className="input"
              />
            </div>
            <div>
              <label className="label">Currency</label>
              <select
                value={profileForm.currency}
                onChange={(e) => handleProfileChange('currency', e.target.value)}
                className="input"
              >
                {CURRENCIES.map((currency) => (
                  <option key={currency} value={currency}>
                    {currency}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="label">Free trial lessons per learner</label>
            <input
              type="number"
              min="0"
              step="1"
              value={profileForm.trialLessonLimit}
              onChange={(e) => handleProfileChange('trialLessonLimit', e.target.value)}
              className="input"
            />
            <p className="mt-1 text-xs text-gray-500">
              Set 0 to disable free trials. Each learner can claim up to this many trial lessons.
            </p>
          </div>

          <div>
            <label className="label">Location</label>
            <input
              value={profileForm.location}
              onChange={(e) => handleProfileChange('location', e.target.value)}
              className="input"
              placeholder="e.g. Sydney, NSW"
            />
          </div>

          <div>
            <label className="label">Timezone</label>
            <select
              value={profileForm.timezone}
              onChange={(e) => handleProfileChange('timezone', e.target.value)}
              className="input"
            >
              {TIMEZONE_OPTIONS.map((timezone) => (
                <option key={timezone} value={timezone}>
                  {timezone}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">Session Types</label>
            <div className="flex gap-3 flex-wrap">
              {TUTOR_SESSION_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => toggleSessionType(type)}
                  className={cn(
                    'px-3 py-1.5 rounded-full text-sm font-medium border transition-colors',
                    profileForm.sessionTypes.includes(type)
                      ? 'bg-primary-600 text-white border-primary-600'
                      : 'bg-white text-gray-600 border-gray-300 hover:border-primary-400'
                  )}
                >
                  {type.replace('_', '-')}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="label">Years of Experience</label>
              <input
                type="number"
                min="0"
                max="50"
                value={profileForm.yearsExperience}
                onChange={(e) => handleProfileChange('yearsExperience', e.target.value)}
                className="input"
              />
            </div>
            <div>
              <label className="label">Languages Spoken</label>
              <input
                value={profileForm.languages}
                onChange={(e) => handleProfileChange('languages', e.target.value)}
                className="input"
                placeholder="English, Mandarin"
              />
            </div>
          </div>

          <div>
            <label className="label">Education / Qualifications</label>
            <textarea
              value={profileForm.education}
              onChange={(e) => handleProfileChange('education', e.target.value)}
              rows={2}
              className="input resize-none"
              placeholder="One item per line, e.g. BSc Mathematics, UNSW, 2023"
            />
          </div>

          <div>
            <label className="label">Teaching / Work Experience</label>
            <textarea
              value={profileForm.workExperience}
              onChange={(e) => handleProfileChange('workExperience', e.target.value)}
              rows={3}
              className="input resize-none"
              placeholder="One item per line, e.g. 3 years teaching high school Mathematics"
            />
          </div>

          <div>
            <label className="label">Certifications / Training</label>
            <textarea
              value={profileForm.certificationItems}
              onChange={(e) => handleProfileChange('certificationItems', e.target.value)}
              rows={3}
              className="input resize-none"
              placeholder="One item per line, e.g. Certificate IV in Training and Assessment"
            />
          </div>

          <button
            type="button"
            onClick={handleSaveProfile}
            disabled={updateProfileMutation.isPending}
            className="btn-primary"
          >
            {updateProfileMutation.isPending ? 'Saving...' : 'Update Profile'}
          </button>
        </div>
          )}

          {activeTab === 'cancellation' && (
            <div className="card p-6 space-y-6">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Cancellation Policy</h2>
                <p className="mt-1 text-sm leading-6 text-gray-600">
                  These terms apply to future booking requests. Existing bookings keep the policy
                  that the learner acknowledged when requesting the lesson.
                </p>
              </div>

              <fieldset>
                <legend className="label">Free-cancellation cutoff</legend>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {CANCELLATION_CUTOFF_OPTIONS.map((hours) => (
                    <label
                      key={hours}
                      className={cn(
                        'flex cursor-pointer items-center gap-3 rounded-xl border p-4 text-sm transition-colors',
                        cancellationPolicyForm.cutoffHours === hours
                          ? 'border-primary-500 bg-primary-50 text-primary-800'
                          : 'border-gray-200 bg-white text-gray-700 hover:border-primary-300'
                      )}
                    >
                      <input
                        type="radio"
                        name="cancellationCutoffHours"
                        value={hours}
                        checked={cancellationPolicyForm.cutoffHours === hours}
                        onChange={() =>
                          setCancellationPolicyForm((current) => ({
                            ...current,
                            cutoffHours: hours,
                          }))
                        }
                        className="h-4 w-4 text-primary-600 focus:ring-primary-500"
                      />
                      <span className="font-medium">{hours} hours</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <fieldset>
                <legend className="label">Refund for later cancellations</legend>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {LATE_REFUND_OPTIONS.map((percent) => (
                    <label
                      key={percent}
                      className={cn(
                        'flex cursor-pointer items-center gap-3 rounded-xl border p-4 text-sm transition-colors',
                        cancellationPolicyForm.lateRefundPercent === percent
                          ? 'border-primary-500 bg-primary-50 text-primary-800'
                          : 'border-gray-200 bg-white text-gray-700 hover:border-primary-300'
                      )}
                    >
                      <input
                        type="radio"
                        name="lateCancellationRefundPercent"
                        value={percent}
                        checked={cancellationPolicyForm.lateRefundPercent === percent}
                        onChange={() =>
                          setCancellationPolicyForm((current) => ({
                            ...current,
                            lateRefundPercent: percent,
                          }))
                        }
                        className="h-4 w-4 text-primary-600 focus:ring-primary-500"
                      />
                      <span className="font-medium">{percent}% refund</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <CancellationPolicySummary
                policy={cancellationPolicyForm}
                title="Policy preview"
              />

              <button
                type="button"
                onClick={handleSaveCancellationPolicy}
                disabled={updateCancellationPolicyMutation.isPending}
                className="btn-primary"
              >
                {updateCancellationPolicyMutation.isPending ? 'Saving...' : 'Save Cancellation Policy'}
              </button>
            </div>
          )}

          {activeTab === 'subjects' && (
        <div className="space-y-4">
          <div className="card p-5">
            <h3 className="font-semibold text-gray-900">My Subjects</h3>
            <p className="mt-1 mb-4 text-sm text-gray-500">
              Your hourly rate is the learner&apos;s price. TutorConnect deducts a 15% commission
              from this amount. Your estimated earnings are the remaining 85%; no extra platform
              fee is added to the learner&apos;s total.
            </p>
            {mySubjects.length === 0 ? (
              <p className="text-sm text-gray-400">No subjects added yet</p>
            ) : (
              <div className="space-y-2">
                {mySubjects.map((item) => {
                  const subjectId = getTutorSubjectId(item);
                  return (
                  <div
                    key={item.id}
                    className="flex flex-col gap-3 py-3 border-b border-gray-100 last:border-0 md:flex-row md:items-center md:justify-between"
                  >
                    <div>
                      <span className="font-medium text-sm text-gray-900">
                        {item.subject?.name}
                      </span>
                      <span className="text-xs text-gray-400 ml-2">
                        ({item.subject?.category})
                      </span>
                      <span className="badge bg-blue-50 text-blue-700 text-xs ml-2">
                        {item.level || 'All Levels'}
                      </span>
                    </div>
                    <div className="flex items-start gap-2">
                      <div className="w-52">
                        <input
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={editingSubjectRates[subjectId] ?? item.hourlyRate ?? ''}
                          onChange={(e) => handleSubjectRateChange(subjectId, e.target.value)}
                          className="input w-full"
                          aria-label={`${item.subject?.name} hourly rate`}
                        />
                        <SubjectRateEarningEstimate
                          hourlyRate={editingSubjectRates[subjectId] ?? item.hourlyRate}
                          currency={profileForm.currency}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => handleUpdateSubjectRate(subjectId, item.hourlyRate)}
                        disabled={updateSubjectRateMutation.isPending}
                        className="btn-secondary btn-sm"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemoveSubject(subjectId)}
                        disabled={removeSubjectMutation.isPending}
                        className="p-1.5 rounded-full text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                      >
                        <TrashIcon className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="card p-5">
            <h3 className="font-semibold text-gray-900 mb-3">Add Subject</h3>
            <div className="flex gap-3">
              <select
                value={selectedSubjectId}
                onChange={(e) => setSelectedSubjectId(e.target.value)}
                className="input flex-1"
              >
                <option value="">Select a subject...</option>
                {availableSubjects.map((subject) => (
                  <option key={subject.id} value={subject.id}>
                    {subject.name} ({subject.category})
                  </option>
                ))}
              </select>
              <select
                value={selectedLevel}
                onChange={(e) => setSelectedLevel(e.target.value)}
                className="input w-36"
              >
                {LEVELS.map((level) => (
                  <option key={level.value} value={level.value}>
                    {level.label}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={selectedHourlyRate}
                onChange={(e) => setSelectedHourlyRate(e.target.value)}
                className="input w-32"
                placeholder="AUD/hr"
              />
              <button
                type="button"
                onClick={handleAddSubject}
                disabled={!selectedSubjectId || addSubjectMutation.isPending}
                className="btn-primary gap-1.5 flex-shrink-0"
              >
                <PlusIcon className="w-4 h-4" /> Add
              </button>
            </div>
          </div>
        </div>
          )}

          {activeTab === 'availability' && (
        <div className="card p-5 space-y-4">
          <div>
            <h3 className="font-semibold text-gray-900">Weekly Availability</h3>
            <p className="mt-1 text-sm text-gray-500">Click cells to toggle 1-hour blocks across the full 24-hour day.</p>
          </div>

          <AvailabilityCalendar
            slots={availability}
            mode="edit"
            timezone={timeZone}
            onChange={setAvailability}
          />

          <div className="rounded-xl bg-gray-50 px-3 py-2 text-sm text-gray-500">
            {availability.length === 0
              ? 'No availability selected yet.'
              : `${availability.length} weekly availability block${availability.length > 1 ? 's' : ''} selected.`}
          </div>

          <button
            type="button"
            onClick={handleSaveAvailability}
            disabled={updateAvailabilityMutation.isPending}
            className="btn-primary"
          >
            {updateAvailabilityMutation.isPending ? 'Saving...' : 'Save Availability'}
          </button>

          <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4 space-y-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <h4 className="font-semibold text-gray-900">Temporary Modify This Week</h4>
                <p className="mt-1 text-sm text-gray-600">
                  Use a separate current-week table when you need one-off changes. Students will see this week&apos;s temporary timetable instead of the regular weekly schedule.
                </p>
              </div>

              <button
                type="button"
                onClick={handleToggleCurrentWeekEditor}
                className="btn-secondary"
              >
                {showCurrentWeekEditor
                  ? 'Hide This Week Editor'
                  : hasCurrentWeekAvailabilityOverride
                    ? 'Edit This Week Override'
                    : 'Open This Week Editor'}
              </button>
            </div>

            {hasCurrentWeekAvailabilityOverride && (
              <div className="rounded-xl border border-amber-200 bg-white/80 px-3 py-2 text-sm text-amber-800">
                A temporary schedule is active for this week. Students are currently seeing the override below for the current week only.
              </div>
            )}

            {showCurrentWeekEditor && (
              <div className="space-y-4">
                <AvailabilityCalendar
                  slots={currentWeekAvailability}
                  mode="edit"
                  onChange={setCurrentWeekAvailability}
                  fixedWeekOffset={0}
                  hideWeekNavigation
                  title="This Week Only"
                  timezone={timeZone}
                />

                <div className="rounded-xl bg-white/80 px-3 py-2 text-sm text-gray-600">
                  {currentWeekAvailability.length === 0
                    ? 'No hours selected for this week. Saving now will make you unavailable for the current week.'
                    : `${currentWeekAvailability.length} current-week availability block${currentWeekAvailability.length > 1 ? 's' : ''} selected.`}
                </div>

                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={handleSaveCurrentWeekAvailability}
                    disabled={updateCurrentWeekAvailabilityMutation.isPending}
                    className="btn-primary"
                  >
                    {updateCurrentWeekAvailabilityMutation.isPending
                      ? 'Saving This Week...'
                      : 'Save This Week Only'}
                  </button>

                  <button
                    type="button"
                    onClick={handleClearCurrentWeekAvailability}
                    disabled={
                      !hasCurrentWeekAvailabilityOverride ||
                      clearCurrentWeekAvailabilityMutation.isPending
                    }
                    className="btn-secondary"
                  >
                    {clearCurrentWeekAvailabilityMutation.isPending
                      ? 'Clearing...'
                      : 'Clear Temporary Changes'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
          )}
        </>
      )}
    </div>
  );
}
