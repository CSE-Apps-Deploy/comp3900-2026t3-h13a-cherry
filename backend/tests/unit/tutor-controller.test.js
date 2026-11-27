const prisma = {
  tutorProfile: {
    findMany: vi.fn(),
    count: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  booking: { count: vi.fn(), findMany: vi.fn() },
  user: { findUnique: vi.fn(), update: vi.fn() },
  adminAction: { findFirst: vi.fn() },
  tutorAvailability: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    findMany: vi.fn(),
  },
  tutorAvailabilityOverrideWeek: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  subject: { findUnique: vi.fn() },
  tutorSubject: {
    upsert: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(),
    deleteMany: vi.fn(),
  },
};

prisma.$transaction = vi.fn(async (callback) => callback(prisma));

const notifyAdmin = vi.fn();
const databaseModulePath = require.resolve('../../src/config/database');
const notificationModulePath = require.resolve('../../src/services/notificationService');
const controllerModulePath = require.resolve('../../src/controllers/tutorController');

for (const modulePath of [databaseModulePath, notificationModulePath, controllerModulePath]) {
  delete require.cache[modulePath];
}

require.cache[databaseModulePath] = {
  id: databaseModulePath,
  filename: databaseModulePath,
  loaded: true,
  exports: { prisma },
};

require.cache[notificationModulePath] = {
  id: notificationModulePath,
  filename: notificationModulePath,
  loaded: true,
  exports: { notify: vi.fn(), notifyOrRefresh: vi.fn(), notifyAdmin },
};

const controller = require('../../src/controllers/tutorController');

const makeResponse = () => {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
};

const makeRequest = (overrides = {}) => ({
  user: { id: 'tutor-user-1', role: 'TUTOR', timezone: 'UTC' },
  params: {},
  query: {},
  body: {},
  files: [],
  ...overrides,
});

const activeProfile = (overrides = {}) => ({
  id: 'tutor-profile-1',
  userId: 'tutor-user-1',
  status: 'ACTIVE',
  applicationSubmitted: true,
  trialLessonLimit: 2,
  cancellationCutoffHours: 24,
  lateCancellationRefundPercent: 50,
  user: { id: 'tutor-user-1', timezone: 'UTC', bio: 'Tutor bio' },
  subjects: [],
  availability: [],
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
  prisma.adminAction.findFirst.mockResolvedValue(null);
  prisma.booking.findMany.mockResolvedValue([]);
  prisma.tutorAvailabilityOverrideWeek.findUnique.mockResolvedValue(null);
});

describe('tutor discovery and profiles', () => {
  test('searches with all supported filters', async () => {
    prisma.tutorProfile.findMany.mockResolvedValue([activeProfile()]);
    prisma.tutorProfile.count.mockResolvedValue(13);
    const res = makeResponse();

    await controller.searchTutors(
      makeRequest({
        query: {
          subject: 'Maths',
          category: 'STEM',
          location: 'Sydney',
          minRate: '20',
          maxRate: '80',
          minRating: '4',
          sessionType: 'ONLINE',
          language: 'English',
          experience: '3',
          sort: 'rate_asc',
          page: '2',
          limit: '6',
        },
      }),
      res
    );

    expect(prisma.tutorProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { hourlyRate: 'asc' }, skip: 6, take: 6 })
    );
    expect(res.json.mock.calls[0][0].data.pagination.totalPages).toBe(3);
  });

  test.each([
    ['rate_desc', { hourlyRate: 'desc' }],
    ['experience', { yearsExperience: 'desc' }],
    ['sessions', { totalSessions: 'desc' }],
    ['unknown', { rating: 'desc' }],
  ])('supports the %s sort option', async (sort, orderBy) => {
    prisma.tutorProfile.findMany.mockResolvedValue([]);
    prisma.tutorProfile.count.mockResolvedValue(0);

    await controller.searchTutors(makeRequest({ query: { sort } }), makeResponse());

    expect(prisma.tutorProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy })
    );
  });

  test('returns learner trial availability', async () => {
    prisma.tutorProfile.findFirst.mockResolvedValue(activeProfile());
    prisma.booking.count.mockResolvedValue(1);
    const res = makeResponse();

    await controller.getTutorProfile(
      makeRequest({
        params: { id: 'tutor-profile-1' },
        user: { id: 'learner-1', role: 'LEARNER' },
      }),
      res
    );

    expect(res.json.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ trialLessonsRemaining: 1, isTrialLessonEligible: true })
    );
  });

  test('returns zero trial availability to anonymous visitors', async () => {
    prisma.tutorProfile.findFirst.mockResolvedValue(activeProfile({ trialLessonLimit: 0 }));
    const res = makeResponse();

    await controller.getTutorProfile(
      makeRequest({ params: { id: 'tutor-profile-1' }, user: undefined }),
      res
    );

    expect(res.json.mock.calls[0][0].data.isTrialLessonEligible).toBe(false);
  });

  test('rejects an unknown tutor profile', async () => {
    prisma.tutorProfile.findFirst.mockResolvedValue(null);

    await expect(
      controller.getTutorProfile(makeRequest({ params: { id: 'missing' } }), makeResponse())
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test('returns the signed-in tutor profile and current-week override', async () => {
    prisma.tutorProfile.findUnique.mockResolvedValue(
      activeProfile({
        availability: [
          { dayOfWeek: 1, startTime: '09:00', endTime: '11:00', timezone: 'UTC' },
        ],
      })
    );
    prisma.tutorAvailabilityOverrideWeek.findUnique.mockResolvedValue({
      timezone: 'Australia/Sydney',
      slots: [{ dayOfWeek: 2, startTime: '10:00', endTime: '12:00' }],
    });
    const res = makeResponse();

    await controller.getMyProfile(makeRequest(), res);

    expect(res.json.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ hasCurrentWeekAvailabilityOverride: true })
    );
  });

  test('rejects a missing signed-in tutor profile', async () => {
    prisma.tutorProfile.findUnique.mockResolvedValue(null);

    await expect(controller.getMyProfile(makeRequest(), makeResponse())).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('tutor application and public profile editing', () => {
  test('resubmits verification material from simple text fields', async () => {
    const pending = activeProfile({
      status: 'SUSPENDED',
      yearsExperience: 1,
      certifications: [],
    });
    prisma.tutorProfile.findUnique.mockResolvedValue(pending);
    prisma.user.update.mockResolvedValue({});
    prisma.tutorProfile.update.mockResolvedValue(activeProfile({ status: 'PENDING' }));
    prisma.adminAction.findFirst.mockResolvedValue({ action: 'TUTOR_PROFILE_RETURNED' });
    const res = makeResponse();

    await controller.updateApplication(
      makeRequest({
        body: {
          shortBio: 'I teach clearly.',
          tutorWorkExperience: 'School tutor\nPrivate tutor',
          tutorEducationItems: '["BSc", " MSc "]',
          tutorQualificationItems: ['Accredited', ''],
          tutorSupportingNotes: 'Available evenings',
          tutorExperienceYears: '4',
          verificationFileDescriptions: '["Degree certificate"]',
        },
        files: [
          {
            originalname: 'degree.pdf',
            filename: 'stored-degree.pdf',
            mimetype: 'application/pdf',
            size: 123,
          },
        ],
      }),
      res
    );

    expect(prisma.tutorProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ yearsExperience: 4, status: 'PENDING' }),
      })
    );
    expect(notifyAdmin).toHaveBeenCalledOnce();
    expect(res.json.mock.calls[0][0].data.latestReviewAction.action).toBe(
      'TUTOR_PROFILE_RETURNED'
    );
  });

  test.each([
    [null, { shortBio: 'Bio' }, 404],
    [activeProfile(), { shortBio: 'Bio' }, 400],
    [activeProfile({ status: 'SUSPENDED', certifications: [] }), { shortBio: '' }, 400],
    [activeProfile({ status: 'SUSPENDED', certifications: [] }), { shortBio: 'Bio' }, 400],
  ])('rejects incomplete application material', async (profile, body, statusCode) => {
    prisma.tutorProfile.findUnique.mockResolvedValue(profile);

    await expect(
      controller.updateApplication(makeRequest({ body }), makeResponse())
    ).rejects.toMatchObject({ statusCode });
  });

  test('updates every supported public profile field', async () => {
    prisma.tutorProfile.findUnique.mockResolvedValue(activeProfile());
    prisma.user.update.mockResolvedValue({});
    const updated = activeProfile({ headline: 'Maths specialist', trialLessonLimit: 3 });
    prisma.tutorProfile.update.mockResolvedValue(updated);
    const res = makeResponse();

    await controller.updateProfile(
      makeRequest({
        body: {
          bio: 'Updated bio',
          headline: 'Maths specialist',
          hourlyRate: '65.5',
          trialLessonLimit: '3',
          currency: 'AUD',
          yearsExperience: '7',
          education: ['BSc'],
          certifications: ['Qualified'],
          languages: ['English'],
          sessionTypes: ['ONLINE'],
          location: 'Sydney',
        },
      }),
      res
    );

    expect(prisma.tutorProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ hourlyRate: 65.5, trialLessonLimit: 3 }),
      })
    );
    expect(res.json.mock.calls[0][0].data.headline).toBe('Maths specialist');
  });

  test.each([
    [null, {}, 404],
    [activeProfile({ status: 'PENDING' }), {}, 403],
    [activeProfile(), { trialLessonLimit: '-1' }, 400],
    [activeProfile(), { trialLessonLimit: '1.5' }, 400],
  ])('rejects invalid profile updates', async (profile, body, statusCode) => {
    prisma.tutorProfile.findUnique.mockResolvedValue(profile);

    await expect(
      controller.updateProfile(makeRequest({ body }), makeResponse())
    ).rejects.toMatchObject({ statusCode });
  });

  test('updates the cancellation policy', async () => {
    prisma.tutorProfile.update.mockResolvedValue(
      activeProfile({ cancellationCutoffHours: 12, lateCancellationRefundPercent: 25 })
    );
    const res = makeResponse();

    await controller.updateCancellationPolicy(
      makeRequest({ body: { cutoffHours: '12', lateRefundPercent: '25' } }),
      res
    );

    expect(prisma.tutorProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { cancellationCutoffHours: 12, lateCancellationRefundPercent: 25 },
      })
    );
  });
});

describe('tutor availability editing', () => {
  test('replaces recurring availability with normalized slots', async () => {
    prisma.tutorProfile.findUnique.mockResolvedValue(activeProfile());
    prisma.tutorAvailability.deleteMany.mockResolvedValue({ count: 1 });
    prisma.tutorAvailability.createMany.mockResolvedValue({ count: 3 });
    prisma.tutorAvailability.findMany.mockResolvedValue([{ dayOfWeek: 1 }]);
    const res = makeResponse();

    await controller.updateAvailability(
      makeRequest({
        body: {
          availability: [
            { dayOfWeek: 'TUESDAY', startTime: '10:00', endTime: '12:00' },
            { dayOfWeek: '1', startTime: '09:00', endTime: '10:00' },
            { dayOfWeek: 3, startTime: '23:00', endTime: '24:00' },
          ],
        },
      }),
      res
    );

    expect(prisma.tutorAvailability.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.arrayContaining([expect.objectContaining({ dayOfWeek: 1 })]) })
    );
    expect(res.json).toHaveBeenCalledWith({ success: true, data: [{ dayOfWeek: 1 }] });
  });

  test('allows recurring availability to be cleared with an array body', async () => {
    prisma.tutorProfile.findUnique.mockResolvedValue(activeProfile());
    prisma.tutorAvailability.deleteMany.mockResolvedValue({ count: 1 });
    prisma.tutorAvailability.findMany.mockResolvedValue([]);

    await controller.updateAvailability(makeRequest({ body: [] }), makeResponse());

    expect(prisma.tutorAvailability.createMany).not.toHaveBeenCalled();
  });

  test.each([
    [{ availability: {} }, 400],
    [{ availability: [{ dayOfWeek: 'FUNDAY', startTime: '09:00', endTime: '10:00' }] }, 400],
    [{ availability: [{ dayOfWeek: 1, startTime: 'bad', endTime: '10:00' }] }, 400],
    [{ availability: [{ dayOfWeek: 1, startTime: '10:00', endTime: '09:00' }] }, 400],
  ])('rejects malformed recurring availability', async (body, statusCode) => {
    prisma.tutorProfile.findUnique.mockResolvedValue(activeProfile());

    await expect(
      controller.updateAvailability(makeRequest({ body }), makeResponse())
    ).rejects.toMatchObject({ statusCode });
  });

  test('creates a current-week override', async () => {
    prisma.tutorProfile.findUnique.mockResolvedValue(
      activeProfile({ user: { timezone: 'Australia/Sydney' } })
    );
    prisma.tutorAvailabilityOverrideWeek.upsert.mockResolvedValue({
      timezone: 'Australia/Sydney',
      slots: [{ dayOfWeek: 5, startTime: '14:00', endTime: '16:00' }],
    });
    const res = makeResponse();

    await controller.updateCurrentWeekAvailability(
      makeRequest({
        body: [{ dayOfWeek: 'FRIDAY', startTime: '14:00', endTime: '16:00' }],
      }),
      res
    );

    expect(res.json.mock.calls[0][0].data.hasCurrentWeekAvailabilityOverride).toBe(true);
  });

  test('creates an explicitly empty current-week override', async () => {
    prisma.tutorProfile.findUnique.mockResolvedValue(activeProfile());
    prisma.tutorAvailabilityOverrideWeek.upsert.mockResolvedValue({ timezone: 'UTC', slots: [] });

    await controller.updateCurrentWeekAvailability(
      makeRequest({ body: { availability: [] } }),
      makeResponse()
    );

    expect(prisma.tutorAvailabilityOverrideWeek.upsert).toHaveBeenCalledOnce();
  });

  test('clears the current-week override', async () => {
    prisma.tutorProfile.findUnique.mockResolvedValue(activeProfile());
    prisma.tutorAvailabilityOverrideWeek.deleteMany.mockResolvedValue({ count: 1 });
    const res = makeResponse();

    await controller.clearCurrentWeekAvailability(makeRequest(), res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: 'Current week availability override cleared',
    });
  });

  test('returns converted availability and booked slots', async () => {
    prisma.tutorProfile.findFirst.mockResolvedValue({
      id: 'tutor-profile-1',
      userId: 'tutor-user-1',
      availability: [
        { dayOfWeek: 1, startTime: '09:00', endTime: '11:00', timezone: 'UTC' },
      ],
    });
    prisma.user.findUnique.mockResolvedValue({ timezone: 'UTC' });
    prisma.booking.findMany.mockResolvedValue([
      {
        id: 'booking-1',
        scheduledAt: new Date('2026-08-17T10:00:00.000Z'),
        duration: 60,
        status: 'ACCEPTED',
      },
    ]);
    const res = makeResponse();

    await controller.getTutorAvailability(
      makeRequest({
        params: { id: 'tutor-profile-1' },
        user: { id: 'learner-1', timezone: 'Australia/Sydney' },
      }),
      res
    );

    expect(res.json.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ tutorTimezone: 'UTC', requesterTimezone: 'Australia/Sydney' })
    );
    expect(res.json.mock.calls[0][0].data.bookedSlots).toHaveLength(1);
  });

  test('rejects availability for an unknown tutor', async () => {
    prisma.tutorProfile.findFirst.mockResolvedValue(null);

    await expect(
      controller.getTutorAvailability(makeRequest({ params: { id: 'missing' } }), makeResponse())
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('tutor subject editing', () => {
  test('adds, changes, and removes a tutor subject', async () => {
    prisma.tutorProfile.findUnique.mockResolvedValue(activeProfile());
    prisma.subject.findUnique.mockResolvedValue({ id: 'subject-1', name: 'Maths' });
    prisma.tutorSubject.upsert.mockResolvedValue({ id: 'link-1', hourlyRate: '45.50' });
    prisma.tutorSubject.updateMany.mockResolvedValue({ count: 1 });
    prisma.tutorSubject.findUnique.mockResolvedValue({ id: 'link-1', hourlyRate: '50.00' });
    prisma.tutorSubject.deleteMany.mockResolvedValue({ count: 1 });

    const addRes = makeResponse();
    await controller.addSubject(
      makeRequest({
        body: {
          subjectId: 'subject-1',
          level: 'ALL_LEVELS',
          description: 'All levels',
          hourlyRate: '45.50',
        },
      }),
      addRes
    );
    expect(addRes.json.mock.calls[0][0].data.id).toBe('link-1');

    const updateRes = makeResponse();
    await controller.updateSubjectRate(
      makeRequest({ params: { subjectId: 'subject-1' }, body: { hourlyRate: '50' } }),
      updateRes
    );
    expect(updateRes.json.mock.calls[0][0].data.hourlyRate).toBe('50.00');

    const removeRes = makeResponse();
    await controller.removeSubject(
      makeRequest({ params: { subjectId: 'subject-1' } }),
      removeRes
    );
    expect(removeRes.json).toHaveBeenCalledWith({ success: true, message: 'Subject removed' });
  });

  test.each([
    ['', 400],
    ['0', 400],
    ['-1', 400],
    ['12.345', 400],
  ])('rejects invalid hourly rate %s', async (hourlyRate, statusCode) => {
    prisma.tutorProfile.findUnique.mockResolvedValue(activeProfile());
    prisma.subject.findUnique.mockResolvedValue({ id: 'subject-1' });

    await expect(
      controller.addSubject(
        makeRequest({ body: { subjectId: 'subject-1', hourlyRate } }),
        makeResponse()
      )
    ).rejects.toMatchObject({ statusCode });
  });

  test('rejects an unknown catalogue subject', async () => {
    prisma.tutorProfile.findUnique.mockResolvedValue(activeProfile());
    prisma.subject.findUnique.mockResolvedValue(null);

    await expect(
      controller.addSubject(
        makeRequest({ body: { subjectId: 'missing', hourlyRate: '50' } }),
        makeResponse()
      )
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test('rejects a rate update for an unowned subject', async () => {
    prisma.tutorProfile.findUnique.mockResolvedValue(activeProfile());
    prisma.tutorSubject.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      controller.updateSubjectRate(
        makeRequest({ params: { subjectId: 'missing' }, body: { hourlyRate: '50' } }),
        makeResponse()
      )
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
