const { prisma } = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const { notify } = require('../services/notificationService');

const requestInclude = {
  resolvedSubject: {
    select: { id: true, name: true, category: true },
  },
  acceptedTutor: {
    select: {
      id: true,
      headline: true,
      hourlyRate: true,
      currency: true,
      rating: true,
      totalReviews: true,
      sessionTypes: true,
      user: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          avatar: true,
        },
      },
    },
  },
};

const parsePagination = (pageValue, limitValue) => {
  const page = Math.max(1, Number.parseInt(pageValue, 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(limitValue, 10) || 10));
  return { page, limit, skip: (page - 1) * limit };
};

const toPublicSubjectRequest = (subjectRequest) => {
  const { learnerId: _learnerId, ...publicRequest } = subjectRequest;
  return publicRequest;
};

const ensureActiveTutor = (user) => {
  if (user.role !== 'TUTOR') return;

  if (!user.tutorProfile || String(user.tutorProfile.status).toUpperCase() !== 'ACTIVE') {
    throw new AppError('Your tutor account must be approved before using this feature.', 403);
  }
};

const parseHourlyRate = (value) => {
  const raw = String(value ?? '').trim();

  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw new AppError(
      'Hourly rate must be a positive AUD amount with up to two decimal places',
      400
    );
  }

  const rate = Number(raw);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new AppError('Hourly rate must be greater than 0', 400);
  }

  return rate.toFixed(2);
};

exports.createSubjectRequest = async (req, res) => {
  const subjectName = req.body.subjectName.trim();
  const category = req.body.category.trim();
  const description = req.body.description.trim();

  const [existingSubject, existingCategory, duplicateRequest] = await Promise.all([
    prisma.subject.findFirst({
      where: { name: { equals: subjectName, mode: 'insensitive' } },
      select: { id: true, name: true },
    }),
    prisma.subject.findFirst({
      where: { category: { equals: category, mode: 'insensitive' } },
      select: { category: true },
    }),
    prisma.subjectRequest.findFirst({
      where: {
        learnerId: req.user.id,
        status: 'OPEN',
        subjectName: { equals: subjectName, mode: 'insensitive' },
      },
      select: { id: true },
    }),
  ]);

  if (existingSubject) {
    throw new AppError(`${existingSubject.name} already exists in the subject catalogue`, 409);
  }
  if (!existingCategory) {
    throw new AppError('Select an existing subject category', 400);
  }
  if (duplicateRequest) {
    throw new AppError('You already have an open request for this subject', 409);
  }

  const subjectRequest = await prisma.subjectRequest.create({
    data: {
      learnerId: req.user.id,
      subjectName,
      category: existingCategory.category,
      description,
    },
    include: requestInclude,
  });

  res.status(201).json({
    success: true,
    message: 'Subject request submitted',
    data: toPublicSubjectRequest(subjectRequest),
  });
};

exports.listSubjectRequests = async (req, res) => {
  ensureActiveTutor(req.user);

  const { page, limit, skip } = parsePagination(req.query.page, req.query.limit);
  const status = req.query.status ? String(req.query.status).toUpperCase() : null;
  const roleScope =
    req.user.role === 'LEARNER'
      ? { learnerId: req.user.id }
      : {
          OR: [
            { status: 'OPEN' },
            { status: 'ACCEPTED', acceptedTutorId: req.user.tutorProfile.id },
          ],
        };
  const where = {
    ...roleScope,
    ...(status ? { status } : {}),
  };

  const [subjectRequests, total] = await Promise.all([
    prisma.subjectRequest.findMany({
      where,
      include: requestInclude,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.subjectRequest.count({ where }),
  ]);

  res.json({
    success: true,
    data: {
      subjectRequests: subjectRequests.map(toPublicSubjectRequest),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    },
  });
};

exports.cancelSubjectRequest = async (req, res) => {
  const subjectRequest = await prisma.subjectRequest.findUnique({
    where: { id: req.params.id },
    select: { id: true, learnerId: true, status: true },
  });

  if (!subjectRequest) throw new AppError('Subject request not found', 404);
  if (subjectRequest.learnerId !== req.user.id) throw new AppError('Access denied', 403);
  if (subjectRequest.status !== 'OPEN') {
    throw new AppError('Only open subject requests can be cancelled', 409);
  }

  const result = await prisma.subjectRequest.updateMany({
    where: { id: subjectRequest.id, learnerId: req.user.id, status: 'OPEN' },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  });

  if (result.count !== 1) {
    throw new AppError('This subject request is no longer open', 409);
  }

  const updated = await prisma.subjectRequest.findUnique({
    where: { id: subjectRequest.id },
    include: requestInclude,
  });

  res.json({
    success: true,
    message: 'Subject request cancelled',
    data: toPublicSubjectRequest(updated),
  });
};

exports.acceptSubjectRequest = async (req, res) => {
  ensureActiveTutor(req.user);
  const tutorId = req.user.tutorProfile.id;
  const hourlyRate = parseHourlyRate(req.body.hourlyRate);

  const acceptedRequest = await prisma.$transaction(async (database) => {
    const claim = await database.subjectRequest.updateMany({
      where: { id: req.params.id, status: 'OPEN' },
      data: {
        status: 'ACCEPTED',
        acceptedTutorId: tutorId,
        acceptedAt: new Date(),
      },
    });

    if (claim.count !== 1) {
      const existing = await database.subjectRequest.findUnique({
        where: { id: req.params.id },
        select: { id: true },
      });
      if (!existing) throw new AppError('Subject request not found', 404);
      throw new AppError('This subject request has already been claimed', 409);
    }

    const subjectRequest = await database.subjectRequest.findUnique({
      where: { id: req.params.id },
    });

    let subject = await database.subject.findFirst({
      where: { name: { equals: subjectRequest.subjectName, mode: 'insensitive' } },
    });

    if (!subject) {
      subject = await database.subject.upsert({
        where: { name: subjectRequest.subjectName },
        update: {},
        create: {
          name: subjectRequest.subjectName,
          category: subjectRequest.category,
          description: null,
        },
      });
    }

    await database.tutorSubject.upsert({
      where: { tutorId_subjectId: { tutorId, subjectId: subject.id } },
      update: { hourlyRate },
      create: {
        tutorId,
        subjectId: subject.id,
        level: 'all',
        hourlyRate,
      },
    });

    const updated = await database.subjectRequest.update({
      where: { id: subjectRequest.id },
      data: { resolvedSubjectId: subject.id },
      include: requestInclude,
    });

    const tutorName = `${updated.acceptedTutor.user.firstName} ${updated.acceptedTutor.user.lastName}`.trim();
    await notify(
      subjectRequest.learnerId,
      'subject_request',
      'Your subject request was accepted',
      `${tutorName} is now available to teach ${subjectRequest.subjectName}.`,
      `/tutors/${tutorId}?from=subject-requests`,
      database
    );

    return updated;
  });

  res.json({
    success: true,
    message: 'Subject request accepted',
    data: toPublicSubjectRequest(acceptedRequest),
  });
};
