const { UPLOAD_DIR } = require('../middleware/upload');
const path = require('path');
const fs = require('fs/promises');
const { prisma } = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const { notifyAdmin } = require('../services/notificationService');
const {
  convertAvailabilityForStudent,
  validateBookingTime,
  formatBookingInTimezone,
  normalizeTimezone,
} = require('../utils/timezone');
const { getEffectiveCancellationPolicy } = require('../utils/cancellationPolicy');

const weekdayMap = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
};

const normalizeDayOfWeek = (value) => {
  if (typeof value === 'number' && value >= 0 && value <= 6) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim().toUpperCase();
    if (trimmed !== '' && Number.isInteger(Number(trimmed))) {
      const num = Number(trimmed);
      if (num >= 0 && num <= 6) return num;
    }
    if (trimmed in weekdayMap) return weekdayMap[trimmed];
  }
  throw new AppError('Invalid day of week', 400);
};

const formatHour = (hour) => `${String(hour).padStart(2, '0')}:00`;

const readHour = (value, allowUpTo24 = false) => {
  const [rawHour, rawMinute] = String(value || '').trim().split(':');
  const hour = Number.parseInt(rawHour, 10);
  const minute = Number.parseInt(rawMinute, 10);

  if (Number.isNaN(hour) || Number.isNaN(minute) || minute !== 0 || hour < 0 || hour > (allowUpTo24 ? 24 : 23)) {
    throw new AppError('Invalid time format', 400);
  }

  return hour;
};

const normalizeAvailabilitySlots = (availability, defaultTimezone = 'UTC') => {
  if (availability == null) return [];
  if (!Array.isArray(availability)) throw new AppError('Availability must be an array', 400);

  return availability
    .map((slot) => {
      const dayOfWeek = normalizeDayOfWeek(slot?.dayOfWeek);
      const startHour = readHour(slot?.startTime);
      const endHour = readHour(slot?.endTime, true);

      if (endHour <= startHour) {
        throw new AppError('End time must be after start time', 400);
      }

      return {
        dayOfWeek,
        startTime: formatHour(startHour),
        endTime: formatHour(endHour),
        timezone: normalizeTimezone(slot?.timezone || defaultTimezone),
      };
    })
    .sort((a, b) => {
      if (a.dayOfWeek !== b.dayOfWeek) return a.dayOfWeek - b.dayOfWeek;
      return a.startTime.localeCompare(b.startTime);
    });
};

const getCurrentWeekStart = (date = new Date()) => {
  const start = new Date(date);
  const dayOffset = (start.getDay() + 6) % 7;
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - dayOffset);
  return start;
};

const availabilityOrderBy = [{ dayOfWeek: 'asc' }, { startTime: 'asc' }];

const serializeAvailabilitySlots = (slots = [], defaultTimezone) =>
  slots.map((slot) => ({
    dayOfWeek: slot.dayOfWeek,
    startTime: slot.startTime,
    endTime: slot.endTime,
    timezone: slot.timezone || defaultTimezone || 'UTC',
  }));

const getCurrentWeekAvailabilityOverride = (tutorId) =>
  prisma.tutorAvailabilityOverrideWeek.findUnique({
    where: {
      tutorId_weekStart: {
        tutorId,
        weekStart: getCurrentWeekStart(),
      },
    },
    include: {
      slots: {
        orderBy: availabilityOrderBy,
      },
    },
  });

const buildAvailabilityState = (baseAvailability = [], currentWeekOverride = null) => {
  const availability = serializeAvailabilitySlots(baseAvailability);
  const currentWeekAvailabilityOverride = currentWeekOverride
    ? serializeAvailabilitySlots(currentWeekOverride.slots, currentWeekOverride.timezone)
    : [];

  return {
    availability,
    currentWeekAvailabilityOverride,
    currentWeekEffectiveAvailability: currentWeekOverride
      ? currentWeekAvailabilityOverride
      : availability,
    hasCurrentWeekAvailabilityOverride: Boolean(currentWeekOverride),
  };
};

const getAvailabilityRange = () => {
  const start = getCurrentWeekStart();
  const end = new Date(start);
  end.setDate(start.getDate() + 13 * 7);
  return { start, end };
};

const serializeBookedSlots = (bookings = []) =>
  bookings.map((booking) => ({
    id: booking.id,
    scheduledAt: booking.scheduledAt,
    duration: booking.duration,
    status: booking.status,
  }));

const getBookedSlots = async (tutorId) => {
  const { start, end } = getAvailabilityRange();
  const lookupStart = new Date(start);
  lookupStart.setDate(lookupStart.getDate() - 1);

  const bookings = await prisma.booking.findMany({
    where: {
      tutorId,
      status: { notIn: ['CANCELLED', 'DECLINED', 'NOT_COMPLETED'] },
      scheduledAt: {
        gte: lookupStart,
        lt: end,
      },
    },
    select: {
      id: true,
      scheduledAt: true,
      duration: true,
      status: true,
    },
    orderBy: { scheduledAt: 'asc' },
  });

  return serializeBookedSlots(bookings);
};

const normalizeSubjectLevel = (value) => {
  if (!value) return 'all';

  const normalized = String(value).trim().toUpperCase();
  const levelMap = {
    BEGINNER: 'beginner',
    INTERMEDIATE: 'intermediate',
    ADVANCED: 'advanced',
    ALL: 'all',
    ALL_LEVELS: 'all',
  };

  return levelMap[normalized] || String(value).trim().toLowerCase();
};

const parseHourlyRate = (value) => {
  const raw = String(value ?? '').trim();

  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw new AppError('Hourly Rate must be a positive AUD amount with up to two decimal places', 400);
  }

  const rate = Number(raw);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new AppError('Hourly Rate must be greater than 0', 400);
  }

  return rate.toFixed(2);
};

const tutorProfileSelect = {
  id: true,
  userId: true,
  status: true,
  applicationSubmitted: true,
  headline: true,
  hourlyRate: true,
  trialLessonLimit: true,
  cancellationCutoffHours: true,
  lateCancellationRefundPercent: true,
  currency: true,
  yearsExperience: true,
  education: true,
  certifications: true,
  languages: true,
  sessionTypes: true,
  location: true,
  rating: true,
  totalReviews: true,
  totalSessions: true,
  isVerified: true,
  responseTime: true,
  user: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      avatar: true,
      bio: true,
      timezone: true,
      createdAt: true,
    },
  },
  subjects: {
    include: { subject: true },
  },
  availability: {
    orderBy: availabilityOrderBy,
  },
};

const serializeTutorProfile = (profile) =>
  profile
    ? {
        ...profile,
        cancellationPolicy: getEffectiveCancellationPolicy(profile),
      }
    : profile;

const serializePublicTutorProfile = (profile) => serializeTutorProfile({
  ...profile,
  certifications: Array.isArray(profile.certifications)
    ? profile.certifications.filter((item) => !item?.url)
    : profile.certifications,
});

const REVIEW_ACTIONS = ['TUTOR_PROFILE_RETURNED', 'TUTOR_REJECTED', 'TUTOR_APPROVED'];

const ensureTutorProfileEditable = (profile) => {
  if (!profile) throw new AppError('Tutor profile not found', 404);
  if (profile.status !== 'ACTIVE') {
    throw new AppError(
      'Your tutor application is still under admin review. You can edit your public profile after approval.',
      403
    );
  }
};

const toReviewItems = (value) =>
  typeof value === 'string'
    ? value
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => ({ text: item }))
    : [];

const parseTextList = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }

  if (typeof value !== 'string') return [];

  const trimmed = value.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item || '').trim()).filter(Boolean);
    }
  } catch {
    // Fall back to newline parsing.
  }

  return trimmed
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
};

const buildTypedTextItems = (items, kind) =>
  items.map((text) => ({
    kind,
    text,
  }));

const toUploadedFileItems = (files = [], descriptions = []) =>
  files.map((file, index) => ({
    kind: 'file',
    originalName: file.originalname,
    fileName: file.filename,
    url: `/uploads/documents/${file.filename}`,
    mimeType: file.mimetype,
    size: file.size,
    uploadedAt: new Date().toISOString(),
    description: String(descriptions[index] || '').trim() || null,
  }));

const getApplicationFileItems = (items) =>
  Array.isArray(items) ? items.filter((item) => item && typeof item === 'object' && item.url) : [];

const getLatestReviewAction = (userId) =>
  prisma.adminAction.findFirst({
    where: {
      targetUserId: userId,
      action: { in: REVIEW_ACTIONS },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      action: true,
      description: true,
      createdAt: true,
      admin: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
        },
      },
    },
  });

exports.searchTutors = async (req, res) => {
  const {
    q,
    subject,
    category,
    location,
    minRate,
    maxRate,
    minRating,
    sessionType,
    language,
    experience,
    sort = 'rating',
    page = 1,
    limit = 12,
  } = req.query;

  const keyword = typeof q === 'string' ? q.trim() : '';
  const nameParts = keyword.split(/\s+/).filter(Boolean);
  const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
  const take = parseInt(limit, 10);

  const where = {
    status: 'ACTIVE',
    ...(keyword && {
      OR: [
        { subjects: { some: { subject: { name: { contains: keyword, mode: 'insensitive' } } } } },
        { user: { AND: nameParts.map((part) => ({ OR: [
          { firstName: { contains: part, mode: 'insensitive' } },
          { lastName: { contains: part, mode: 'insensitive' } },
        ] })) } },
      ],
    }),
    ...(minRate || maxRate
      ? {
          hourlyRate: {
            ...(minRate && { gte: parseFloat(minRate) }),
            ...(maxRate && { lte: parseFloat(maxRate) }),
          },
        }
      : {}),
    ...(minRating && { rating: { gte: parseFloat(minRating) } }),
    ...(sessionType && { sessionTypes: { has: sessionType } }),
    ...(language && { languages: { has: language } }),
    ...(experience && { yearsExperience: { gte: parseInt(experience, 10) } }),
    ...(location && {
      location: { contains: location, mode: 'insensitive' },
    }),
    ...(subject && {
      subjects: {
        some: {
          subject: { name: { contains: subject, mode: 'insensitive' } },
        },
      },
    }),
    ...(category && {
      subjects: {
        some: {
          subject: { category: { contains: category, mode: 'insensitive' } },
        },
      },
    }),
  };

  const orderBy =
    {
      rating: { rating: 'desc' },
      rate_asc: { hourlyRate: 'asc' },
      rate_desc: { hourlyRate: 'desc' },
      experience: { yearsExperience: 'desc' },
      sessions: { totalSessions: 'desc' },
    }[sort] || { rating: 'desc' };

  const [tutors, total] = await Promise.all([
    prisma.tutorProfile.findMany({
      where,
      select: tutorProfileSelect,
      orderBy,
      skip,
      take,
    }),
    prisma.tutorProfile.count({ where }),
  ]);

  res.json({
    success: true,
    data: {
      tutors: tutors.map(serializePublicTutorProfile),
      pagination: {
        page: parseInt(page, 10),
        limit: take,
        total,
        totalPages: Math.ceil(total / take),
      },
    },
  });
};

exports.getTutorProfile = async (req, res) => {
  const tutor = await prisma.tutorProfile.findFirst({
    where: {
      OR: [{ id: req.params.id }, { userId: req.params.id }],
      status: 'ACTIVE',
    },
    select: tutorProfileSelect,
  });

  if (!tutor) throw new AppError('Tutor not found', 404);

  let trialLessonsRemaining = 0;
  if (req.user?.role === 'LEARNER' && tutor.trialLessonLimit > 0) {
    const claimedTrialLessons = await prisma.booking.count({
      where: {
        learnerId: req.user.id,
        tutorId: tutor.id,
        isTrialLesson: true,
        status: { notIn: ['CANCELLED', 'DECLINED', 'NOT_COMPLETED'] },
      },
    });
    trialLessonsRemaining = Math.max(
      0,
      Number(tutor.trialLessonLimit) - claimedTrialLessons
    );
  }

  res.json({
    success: true,
    data: {
      ...serializePublicTutorProfile(tutor),
      trialLessonsRemaining,
      isTrialLessonEligible: trialLessonsRemaining > 0,
    },
  });
};

exports.getMyProfile = async (req, res) => {
  const [profile, latestReviewAction] = await Promise.all([
    prisma.tutorProfile.findUnique({
      where: { userId: req.user.id },
      select: tutorProfileSelect,
    }),
    getLatestReviewAction(req.user.id),
  ]);

  if (!profile) throw new AppError('Tutor profile not found', 404);

  const currentWeekOverride = await getCurrentWeekAvailabilityOverride(profile.id);

  res.json({
    success: true,
    data: {
      ...serializeTutorProfile(profile),
      ...buildAvailabilityState(profile.availability, currentWeekOverride),
      latestReviewAction,
    },
  });
};

exports.updateApplication = async (req, res) => {
  const profile = await prisma.tutorProfile.findUnique({
    where: { userId: req.user.id },
    select: {
      ...tutorProfileSelect,
      certifications: true,
    },
  });

  if (!profile) throw new AppError('Tutor profile not found', 404);
  if (profile.status === 'ACTIVE') {
    throw new AppError(
      'Approved tutors should update their public profile instead of re-submitting verification materials',
      400
    );
  }

  const {
    shortBio,
    tutorWorkExperience,
    tutorEducationItems,
    tutorEducationSummary,
    tutorQualificationItems,
    tutorSupportingNotes,
    tutorExperienceYears,
    verificationFileDescriptions,
  } = req.body;

  const educationItems = parseTextList(tutorEducationItems || tutorEducationSummary);
  const qualificationItems = parseTextList(tutorQualificationItems);
  const reviewerNotes = parseTextList(tutorSupportingNotes);
  const workExperienceItems = parseTextList(tutorWorkExperience);
  const fileDescriptions = parseTextList(verificationFileDescriptions);

  if (!String(shortBio || '').trim()) {
    throw new AppError('Short bio is required', 400);
  }

  if (educationItems.length === 0) {
    throw new AppError('Add at least one education item', 400);
  }

  const uploadedFiles = toUploadedFileItems(req.files || [], fileDescriptions);
  const nextFileItems =
    uploadedFiles.length > 0 ? uploadedFiles : getApplicationFileItems(profile.certifications);

  if (nextFileItems.length === 0) {
    throw new AppError('Upload at least one verification file before resubmitting', 400);
  }

  if (uploadedFiles.some((item) => !item.description)) {
    throw new AppError('Add a short description for each uploaded verification file', 400);
  }

  await prisma.user.update({
    where: { id: req.user.id },
    data: {
      bio:
        shortBio === undefined
          ? profile.user?.bio || null
          : String(shortBio || '').trim() || null,
    },
  });

  const updated = await prisma.tutorProfile.update({
    where: { userId: req.user.id },
    data: {
      applicationSubmitted: true,
      yearsExperience:
        tutorExperienceYears === undefined || tutorExperienceYears === ''
          ? profile.yearsExperience
          : parseInt(tutorExperienceYears, 10) || 0,
      education: buildTypedTextItems(educationItems, 'education'),
      certifications: [
        ...nextFileItems,
        ...buildTypedTextItems(workExperienceItems, 'experience'),
        ...buildTypedTextItems(qualificationItems, 'qualification'),
        ...buildTypedTextItems(reviewerNotes, 'note'),
      ],
      status: 'PENDING',
      isVerified: false,
      verifiedAt: null,
    },
    select: tutorProfileSelect,
  });

  const latestReviewAction = await getLatestReviewAction(req.user.id);

  // notify admin
  await notifyAdmin('system', 'Tutor Application Resubmitted', `A tutor application has been resubmitted for review.`, `/admin/tutors?status=PENDING`);

  res.json({
    success: true,
    message: 'Verification materials resubmitted for admin review',
    data: { ...serializeTutorProfile(updated), latestReviewAction },
  });
};

exports.updateProfile = async (req, res) => {
  const profile = await prisma.tutorProfile.findUnique({
    where: { userId: req.user.id },
  });
  ensureTutorProfileEditable(profile);

  const {
    headline,
    hourlyRate,
    trialLessonLimit,
    currency,
    yearsExperience,
    education,
    certifications,
    languages,
    sessionTypes,
    location,
  } = req.body;

  if (req.body.bio) {
    await prisma.user.update({
      where: { id: req.user.id },
      data: { bio: req.body.bio },
    });
  }

  const profileData = {};
  if (headline !== undefined) profileData.headline = headline;
  if (hourlyRate !== undefined) profileData.hourlyRate = parseFloat(hourlyRate);
  if (trialLessonLimit !== undefined) {
    const parsedTrialLessonLimit = Number(trialLessonLimit);
    if (
      !Number.isInteger(parsedTrialLessonLimit) ||
      parsedTrialLessonLimit < 0
    ) {
      throw new AppError('Trial lesson allowance must be a non-negative whole number', 400);
    }
    profileData.trialLessonLimit = parsedTrialLessonLimit;
  }
  if (currency) profileData.currency = currency;
  if (yearsExperience !== undefined) profileData.yearsExperience = parseInt(yearsExperience, 10);
  if (education) profileData.education = education;
  if (certifications) profileData.certifications = certifications;
  if (languages) profileData.languages = languages;
  if (sessionTypes) profileData.sessionTypes = sessionTypes;
  if (location !== undefined) profileData.location = location;

  const updated = await prisma.tutorProfile.update({
    where: { userId: req.user.id },
    data: profileData,
    select: tutorProfileSelect,
  });

  res.json({ success: true, message: 'Profile updated', data: serializeTutorProfile(updated) });
};

exports.updateCancellationPolicy = async (req, res) => {
  const { cutoffHours, lateRefundPercent } = req.body;

  const updated = await prisma.tutorProfile.update({
    where: { userId: req.user.id },
    data: {
      cancellationCutoffHours: Number(cutoffHours),
      lateCancellationRefundPercent: Number(lateRefundPercent),
    },
    select: tutorProfileSelect,
  });

  res.json({
    success: true,
    message: 'Cancellation policy updated',
    data: serializeTutorProfile(updated),
  });
};

exports.updateAvailability = async (req, res) => {
  const availability = Array.isArray(req.body) ? req.body : req.body.availability;

  const profile = await prisma.tutorProfile.findUnique({
    where: { userId: req.user.id },
    include: { user: { select: { timezone: true } } },
  });
  ensureTutorProfileEditable(profile);
  const tutorTimezone = normalizeTimezone(profile.user?.timezone || req.user?.timezone || 'UTC');
  const normalizedAvailability = normalizeAvailabilitySlots(availability, tutorTimezone);

  await prisma.$transaction(async (tx) => {
    await tx.tutorAvailability.deleteMany({ where: { tutorId: profile.id } });

    if (normalizedAvailability.length > 0) {
      await tx.tutorAvailability.createMany({
        data: normalizedAvailability.map((slot) => ({
          tutorId: profile.id,
          dayOfWeek: slot.dayOfWeek,
          startTime: slot.startTime,
          endTime: slot.endTime,
          timezone: slot.timezone,
        })),
      });
    }
  });

  const updated = await prisma.tutorAvailability.findMany({
    where: { tutorId: profile.id },
    orderBy: availabilityOrderBy,
  });
  res.json({ success: true, data: updated });
};

exports.updateCurrentWeekAvailability = async (req, res) => {
  const availability = Array.isArray(req.body) ? req.body : req.body.availability;

  const profile = await prisma.tutorProfile.findUnique({
    where: { userId: req.user.id },
    include: { user: { select: { timezone: true } } },
  });
  ensureTutorProfileEditable(profile);
  const tutorTimezone = normalizeTimezone(profile.user?.timezone || req.user?.timezone || 'UTC');
  const normalizedAvailability = normalizeAvailabilitySlots(availability, tutorTimezone);

  const weekStart = getCurrentWeekStart();

  const updated = await prisma.tutorAvailabilityOverrideWeek.upsert({
    where: {
      tutorId_weekStart: {
        tutorId: profile.id,
        weekStart,
      },
    },
    create: {
      tutorId: profile.id,
      weekStart,
      timezone: tutorTimezone,
      ...(normalizedAvailability.length > 0
        ? {
            slots: {
              create: normalizedAvailability.map((slot) => ({
                dayOfWeek: slot.dayOfWeek,
                startTime: slot.startTime,
                endTime: slot.endTime,
              })),
            },
          }
        : {}),
    },
    update: {
      timezone: tutorTimezone,
      slots: {
        deleteMany: {},
        ...(normalizedAvailability.length > 0
          ? {
              create: normalizedAvailability.map((slot) => ({
                dayOfWeek: slot.dayOfWeek,
                startTime: slot.startTime,
                endTime: slot.endTime,
              })),
            }
          : {}),
      },
    },
    include: {
      slots: {
        orderBy: availabilityOrderBy,
      },
    },
  });

  res.json({
    success: true,
    data: {
      currentWeekAvailabilityOverride: serializeAvailabilitySlots(updated.slots, updated.timezone),
      hasCurrentWeekAvailabilityOverride: true,
    },
  });
};

exports.clearCurrentWeekAvailability = async (req, res) => {
  const profile = await prisma.tutorProfile.findUnique({
    where: { userId: req.user.id },
  });
  ensureTutorProfileEditable(profile);

  await prisma.tutorAvailabilityOverrideWeek.deleteMany({
    where: {
      tutorId: profile.id,
      weekStart: getCurrentWeekStart(),
    },
  });

  res.json({
    success: true,
    message: 'Current week availability override cleared',
  });
};

exports.getTutorAvailability = async (req, res) => {
  const profile = await prisma.tutorProfile.findFirst({
    where: { OR: [{ id: req.params.id }, { userId: req.params.id }] },
    select: {
      id: true,
      userId: true,
      availability: {
        orderBy: availabilityOrderBy,
      },
    },
  });
  if (!profile) throw new AppError('Tutor not found', 404);

  // Get tutor's timezone
  const tutor = await prisma.user.findUnique({
    where: { id: profile.userId },
    select: { timezone: true },
  });
  const tutorTimezone = tutor?.timezone || 'UTC';

  // Get requesting user's timezone (if student is logged in)
  const requesterTimezone = normalizeTimezone(req.user?.timezone || 'UTC');

  const [currentWeekOverride, bookedSlots] = await Promise.all([
    getCurrentWeekAvailabilityOverride(profile.id),
    getBookedSlots(profile.id),
  ]);

  // Build availability state
  let availabilityState = buildAvailabilityState(profile.availability, currentWeekOverride);
  const sourceAvailability = availabilityState;

  // If requester is a different timezone, convert availability to their timezone
  if (requesterTimezone && requesterTimezone !== tutorTimezone) {
    availabilityState = {
      ...availabilityState,
      availability: convertAvailabilityForStudent(
        availabilityState.availability,
        tutorTimezone,
        requesterTimezone
      ),
      currentWeekEffectiveAvailability: convertAvailabilityForStudent(
        availabilityState.currentWeekEffectiveAvailability,
        tutorTimezone,
        requesterTimezone
      ),
    };
  }

  res.json({
    success: true,
    data: {
      ...availabilityState,
      sourceAvailability,
      tutorTimezone,
      requesterTimezone,
      bookedSlots,
    },
  });
};

exports.addSubject = async (req, res) => {
  const { subjectId, level, description, hourlyRate } = req.body;

  const profile = await prisma.tutorProfile.findUnique({ where: { userId: req.user.id } });
  ensureTutorProfileEditable(profile);

  const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
  if (!subject) throw new AppError('Subject not found', 404);

  const parsedHourlyRate = parseHourlyRate(hourlyRate);

  const tutorSubject = await prisma.tutorSubject.upsert({
    where: { tutorId_subjectId: { tutorId: profile.id, subjectId } },
    update: { level: normalizeSubjectLevel(level), description, hourlyRate: parsedHourlyRate },
    create: {
      tutorId: profile.id,
      subjectId,
      level: normalizeSubjectLevel(level),
      description,
      hourlyRate: parsedHourlyRate,
    },
    include: { subject: true },
  });

  res.json({ success: true, data: tutorSubject });
};

exports.updateSubjectRate = async (req, res) => {
  const profile = await prisma.tutorProfile.findUnique({ where: { userId: req.user.id } });
  ensureTutorProfileEditable(profile);

  const hourlyRate = parseHourlyRate(req.body.hourlyRate);

  const updated = await prisma.tutorSubject.updateMany({
    where: { tutorId: profile.id, subjectId: req.params.subjectId },
    data: { hourlyRate },
  });

  if (updated.count === 0) {
    throw new AppError('Subject not found', 404);
  }

  const tutorSubject = await prisma.tutorSubject.findUnique({
    where: { tutorId_subjectId: { tutorId: profile.id, subjectId: req.params.subjectId } },
    include: { subject: true },
  });

  res.json({ success: true, data: tutorSubject });
};

exports.removeSubject = async (req, res) => {
  const profile = await prisma.tutorProfile.findUnique({ where: { userId: req.user.id } });
  ensureTutorProfileEditable(profile);

  await prisma.tutorSubject.deleteMany({
    where: { tutorId: profile.id, subjectId: req.params.subjectId },
  });

  res.json({ success: true, message: 'Subject removed' });
};


exports.downloadVerificationFile = async (req, res) => {
  const filename = req.params.filename;
  if (!/^[a-f0-9-]{36}\.(?:pdf|png|jpe?g|gif|webp|docx?|txt)$/i.test(filename)) {
    throw new AppError('File not found', 404);
  }
  const url = `/uploads/documents/${filename}`;
  const profile = await prisma.tutorProfile.findUnique({
    where: { id: req.params.id },
    select: { userId: true, certifications: true },
  });
  if (!profile) throw new AppError('File not found', 404);
  if (profile.userId !== req.user.id && !['ADMIN', 'SYSTEM_ADMIN'].includes(req.user.role)) {
    throw new AppError('Access denied', 403);
  }
  const file = profile.certifications.find((item) => item?.url === url);
  if (!file) throw new AppError('File not found', 404);
  const filePath = path.resolve(UPLOAD_DIR, 'documents', filename);
  try { await fs.access(filePath); } catch { throw new AppError('File not found', 404); }
  res.download(filePath, file.originalName || filename);
};
