const { prisma } = require('../config/database');
const { getSocketIO } = require('../services/socketService');
const logger = require('../config/logger');
const { AppError } = require('../middleware/errorHandler');
const { notify, notifyAdmin } = require('../services/notificationService');
const { serializePayment } = require('../utils/paymentSerialization');
const {
  getPayoutOverview,
  getPayoutRuns,
  processPayoutRun,
} = require('../services/adminPayoutService');
const {
  REFUND_SOURCES,
  createRefundClaim,
  serializeRefund,
  submitRefund,
} = require('../services/refundService');
const { DEFAULT_PLATFORM_FEE_PERCENT } = require('../utils/earnings');


const ELEVATED_ROLES = ['ADMIN', 'SYSTEM_ADMIN'];

const parsePagination = (page = 1, limit = 20) => {
  const parsedPage = Math.max(parseInt(page, 10) || 1, 1);
  const parsedLimit = Math.max(parseInt(limit, 10) || 20, 1);

  return {
    page: parsedPage,
    limit: parsedLimit,
    skip: (parsedPage - 1) * parsedLimit,
  };
};

exports.getDashboard = async (req, res) => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const totalUsers = await prisma.user.count({ where: { role: { notIn: ELEVATED_ROLES } } });
  const newUsersThisMonth = await prisma.user.count({
    where: { role: { notIn: ELEVATED_ROLES }, createdAt: { gte: monthStart } },
  });
  const totalTutors = await prisma.tutorProfile.count();
  const pendingTutors = await prisma.tutorProfile.count({
    where: { status: 'PENDING', applicationSubmitted: true },
  });
  const totalBookings = await prisma.booking.count();
  const bookingsThisMonth = await prisma.booking.count({ where: { createdAt: { gte: monthStart } } });
  const completedBookings = await prisma.booking.count({ where: { status: 'COMPLETED' } });
  const revenueResult = await prisma.payment.aggregate({
    where: { status: 'COMPLETED' },
    _sum: { amount: true },
  });
  const usersByRoleRaw = await prisma.user.groupBy({
    by: ['role'],
    _count: { role: true },
    where: { role: { notIn: ELEVATED_ROLES } },
  });
  const recentBookings = await prisma.booking.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
    include: {
      learner: { select: { id: true, firstName: true, lastName: true, email: true } },
      tutorProfile: {
        include: {
          user: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      },
    },
  });

  const usersByRole = {};
  for (const item of usersByRoleRaw) {
    usersByRole[item.role] = item._count.role;
  }

  const overview = {
    totalUsers,
    newUsersThisMonth,
    totalTutors,
    pendingTutors,
    totalBookings,
    bookingsThisMonth,
    completedBookings,
    totalRevenue: revenueResult._sum.amount || 0,
  };

  res.json({
    success: true,
    data: { ...overview, overview, recentBookings, usersByRole },
  });
};

exports.getAnalytics = async (req, res) => {
  const days = parseInt(req.query.period, 10) || 30;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const [bookingsByStatus, recentUsers, topTutorsRaw, topSubjects, revenueData] = await Promise.all(
    [
      prisma.booking.groupBy({
        by: ['status'],
        _count: { status: true },
        where: { createdAt: { gte: startDate } },
      }),
      prisma.user.findMany({
        where: { createdAt: { gte: startDate } },
        select: { createdAt: true, role: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.tutorProfile.findMany({
        orderBy: { totalSessions: 'desc' },
        take: 10,
        include: {
          user: { select: { firstName: true, lastName: true, avatar: true } },
          subjects: { include: { subject: true }, take: 3 },
          bookings: {
            where: {
              status: 'COMPLETED',
              createdAt: { gte: startDate },
            },
            select: { totalAmount: true },
          },
        },
      }),
      prisma.booking.groupBy({
        by: ['subject'],
        _count: { subject: true },
        orderBy: { _count: { subject: 'desc' } },
        take: 10,
        where: { createdAt: { gte: startDate } },
      }),
      prisma.payment.findMany({
        where: { status: 'COMPLETED', createdAt: { gte: startDate } },
        select: { amount: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]
  );

  const newUsersTimelineMap = recentUsers.reduce((accumulator, item) => {
    const date = item.createdAt.toISOString().slice(0, 10);
    accumulator[date] = (accumulator[date] || 0) + 1;
    return accumulator;
  }, {});

  const revenueTimelineMap = revenueData.reduce((accumulator, item) => {
    const date = item.createdAt.toISOString().slice(0, 10);
    accumulator[date] = (accumulator[date] || 0) + parseFloat(item.amount || 0);
    return accumulator;
  }, {});

  const topTutors = topTutorsRaw.map((tutor) => ({
    ...tutor,
    revenue: tutor.bookings.reduce((sum, booking) => sum + parseFloat(booking.totalAmount || 0), 0),
  }));

  res.json({
    success: true,
    data: {
      bookingsByStatusMap: bookingsByStatus.reduce((accumulator, item) => {
        accumulator[item.status] = item._count.status;
        return accumulator;
      }, {}),
      bookingsByStatus: bookingsByStatus.map((item) => ({
        status: item.status,
        count: item._count.status,
      })),
      recentUsers,
      newUsersTimeline: Object.entries(newUsersTimelineMap).map(([date, count]) => ({
        date,
        count,
      })),
      topTutors,
      topSubjects: topSubjects.map((item) => ({
        subject: item.subject,
        count: item._count.subject,
      })),
      revenueData,
      revenueTimeline: Object.entries(revenueTimelineMap).map(([date, revenue]) => ({
        date,
        revenue,
      })),
    },
  });
};

exports.getUsers = async (req, res) => {
  const { role, status, search, page = 1, limit = 20 } = req.query;
  const pagination = parsePagination(page, limit);
  const normalizedSearch = typeof search === 'string' ? search.trim() : '';

  const where = {
    ...(role && { role }),
    ...(status && { status }),
    ...(normalizedSearch && {
      OR: [
        { email: { contains: normalizedSearch, mode: 'insensitive' } },
        { firstName: { contains: normalizedSearch, mode: 'insensitive' } },
        { lastName: { contains: normalizedSearch, mode: 'insensitive' } },
      ],
    }),
  };

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        firstName: true,
        lastName: true,
        avatar: true,
        phone: true,
        timezone: true,
        isEmailVerified: true,
        createdAt: true,
        lastLoginAt: true,
        tutorProfile: {
          select: {
            id: true,
            status: true,
            rating: true,
            totalSessions: true,
            isVerified: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: pagination.skip,
      take: pagination.limit,
    }),
    prisma.user.count({ where }),
  ]);

  res.json({
    success: true,
    data: {
      users,
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        totalPages: Math.ceil(total / pagination.limit),
      },
    },
  });
};

exports.getUser = async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    include: {
      learnerProfile: true,
      tutorProfile: {
        include: {
          subjects: { include: { subject: true } },
          availability: true,
          bookings: {
            include: {
              learner: {
                select: { id: true, firstName: true, lastName: true, email: true },
              },
            },
            orderBy: { createdAt: 'desc' },
            take: 5,
          },
        },
      },
      subscription: true,
      bookingsAsLearner: {
        include: {
          tutorProfile: {
            include: {
              user: {
                select: { id: true, firstName: true, lastName: true, email: true },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
      },
    },
  });

  if (!user) throw new AppError('User not found', 404);

  const { password: _password, ...userWithoutPassword } = user;
  res.json({ success: true, data: userWithoutPassword });
};

exports.updateUserStatus = async (req, res) => {
  const { status, reason } = req.body;
  const validStatuses = ['ACTIVE', 'SUSPENDED', 'DEACTIVATED'];

  if (!validStatuses.includes(status)) {
    throw new AppError('Invalid status', 400);
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: { id: true, role: true, status: true },
  });

  if (!targetUser) throw new AppError('User not found', 404);
  if (ELEVATED_ROLES.includes(targetUser.role)) {
    throw new AppError('Cannot modify elevated admin accounts', 403);
  }

  await prisma.user.update({
    where: { id: req.params.id },
    data: { status },
  });

  if (status !== 'ACTIVE') {
    getSocketIO()?.in(`user:${targetUser.id}`).disconnectSockets(true);
  }

  await prisma.adminAction.create({
    data: {
      adminId: req.user.id,
      targetUserId: req.params.id,
      action: `USER_STATUS_${status}`,
      description: reason || `Status changed to ${status}`,
      metadata: { previousStatus: targetUser.status, nextStatus: status },
    },
  });

  // notify user
  await notify(targetUser.id, 'system', `Your status changed to ${status}`, reason || `Your status changed to ${status}`, `/dashboard`);

  res.json({ success: true, message: `User status updated to ${status}` });
};

exports.getPendingTutors = async (req, res) => {
  const { status = 'PENDING', page = 1, limit = 20 } = req.query;
  const pagination = parsePagination(page, limit);
  const where = {
    applicationSubmitted: true,
    ...(status ? { status } : {}),
  };

  const [tutors, total] = await Promise.all([
    prisma.tutorProfile.findMany({
      where,
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            avatar: true,
            bio: true,
            createdAt: true,
          },
        },
        subjects: { include: { subject: true } },
        availability: true,
      },
      orderBy: { createdAt: 'asc' },
      skip: pagination.skip,
      take: pagination.limit,
    }),
    prisma.tutorProfile.count({ where }),
  ]);

  res.json({
    success: true,
    data: {
      tutors,
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        totalPages: Math.ceil(total / pagination.limit),
      },
    },
  });
};

exports.approveTutor = async (req, res) => {
  const tutor = await prisma.tutorProfile.findFirst({
    where: { OR: [{ id: req.params.id }, { userId: req.params.id }] },
    select: { id: true, userId: true, status: true },
  });

  if (!tutor) throw new AppError('Tutor not found', 404);

  await prisma.tutorProfile.update({
    where: { id: tutor.id },
    data: { status: 'ACTIVE', applicationSubmitted: true, isVerified: true, verifiedAt: new Date() },
  });

  await prisma.adminAction.create({
    data: {
      adminId: req.user.id,
      targetUserId: tutor.userId,
      action: 'TUTOR_APPROVED',
      description: 'Tutor profile approved',
      metadata: { previousStatus: tutor.status, nextStatus: 'ACTIVE' },
    },
  });

  // notify tutor
  await notify(tutor.userId, 'system', 'Tutor profile approved', 'Tutor profile approved', `/dashboard`);


  res.json({ success: true, message: 'Tutor approved successfully' });
};

exports.rejectTutor = async (req, res) => {
  const { reason } = req.body;
  const tutor = await prisma.tutorProfile.findFirst({
    where: { OR: [{ id: req.params.id }, { userId: req.params.id }] },
    select: { id: true, userId: true, status: true },
  });

  if (!tutor) throw new AppError('Tutor not found', 404);

  await prisma.tutorProfile.update({
    where: { id: tutor.id },
    data: { status: 'SUSPENDED', applicationSubmitted: true, isVerified: false, verifiedAt: null },
  });

  await prisma.adminAction.create({
    data: {
      adminId: req.user.id,
      targetUserId: tutor.userId,
      action: 'TUTOR_REJECTED',
      description: reason || 'Tutor profile rejected',
      metadata: { previousStatus: tutor.status, nextStatus: 'SUSPENDED' },
    },
  });

  // notify tutor
  await notify(tutor.userId, 'system', 'Tutor profile rejected', reason || 'Tutor profile rejected', `/dashboard`);

  res.json({ success: true, message: 'Tutor profile rejected' });
};

exports.returnTutor = async (req, res) => {
  const { feedback } = req.body;

  if (!feedback || !feedback.trim()) {
    throw new AppError('Feedback message is required when returning a profile', 400);
  }

  const tutor = await prisma.tutorProfile.findFirst({
    where: { OR: [{ id: req.params.id }, { userId: req.params.id }] },
    select: { id: true, userId: true, status: true },
  });

  if (!tutor) throw new AppError('Tutor not found', 404);

  await prisma.tutorProfile.update({
    where: { id: tutor.id },
    data: { status: 'SUSPENDED', applicationSubmitted: true, isVerified: false, verifiedAt: null },
  });

  await prisma.adminAction.create({
    data: {
      adminId: req.user.id,
      targetUserId: tutor.userId,
      action: 'TUTOR_PROFILE_RETURNED',
      description: feedback.trim(),
      metadata: { previousStatus: tutor.status, nextStatus: 'SUSPENDED' },
    },
  });

  // notify tutor
  await notify(tutor.userId, 'system', 'Tutor profile returned', feedback.trim(), `/dashboard`);

  res.json({ success: true, message: 'Profile returned to tutor for changes' });
};

exports.getBookings = async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  const pagination = parsePagination(page, limit);
  const where = status ? { status } : {};

  const [bookings, total] = await Promise.all([
    prisma.booking.findMany({
      where,
      include: {
        learner: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        tutorProfile: {
          include: {
            user: {
              select: { id: true, firstName: true, lastName: true, email: true },
            },
          },
        },
        payment: {
          include: {
            attempts: { orderBy: { sequence: 'desc' } },
            refund: true,
          },
        },
        statusHistory: { orderBy: { createdAt: 'desc' } },
      },
      orderBy: { createdAt: 'desc' },
      skip: pagination.skip,
      take: pagination.limit,
    }),
    prisma.booking.count({ where }),
  ]);

  res.json({
    success: true,
    data: {
      bookings: bookings.map((booking) => ({
        ...booking,
        payment: serializePayment(booking.payment, { isAdmin: true }),
      })),
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        totalPages: Math.ceil(total / pagination.limit),
      },
    },
  });
};

exports.getPayoutOverview = async (_req, res) => {
  res.json({ success: true, data: await getPayoutOverview() });
};

exports.getPayoutRuns = async (req, res) => {
  const data = await getPayoutRuns({ page: req.query.page, limit: req.query.limit });
  res.json({ success: true, data });
};

exports.processPayoutRun = async (req, res) => {
  const run = await processPayoutRun(req.user);
  res.status(201).json({
    success: true,
    message:
      run.status === 'COMPLETED'
        ? 'All eligible tutor transfers were completed.'
        : 'The payout run finished with transfers that need attention.',
    data: run,
  });
};

exports.processTutorPayoutRun = async (req, res) => {
  const run = await processPayoutRun(req.user, { tutorProfileId: req.params.tutorProfileId });
  res.status(201).json({
    success: true,
    message:
      run.status === 'COMPLETED'
        ? 'The selected tutor payout was completed.'
        : 'The selected tutor payout finished with transfers that need attention.',
    data: run,
  });
};

exports.clearCompletionDispute = async (req, res) => {
  const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
  const expectedVersion = Number(req.body.expectedVersion);
  if (!note) throw new AppError('A resolution note is required.', 400);

  const booking = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: {
      payment: true,
      learner: { select: { id: true } },
      tutorProfile: { include: { user: { select: { id: true } } } },
    },
  });
  if (!booking) throw new AppError('Booking not found', 404);
  if (booking.completionReviewStatus !== 'DISPUTED') {
    throw new AppError('This lesson does not have an open completion dispute.', 409);
  }
  if (booking.version !== expectedVersion) {
    throw new AppError('The completion dispute changed. Refresh before resolving it.', 409);
  }

  const resolvedAt = new Date();
  await prisma.$transaction(async (tx) => {
    const changed = await tx.booking.updateMany({
      where: {
        id: booking.id,
        status: 'COMPLETED',
        version: expectedVersion,
        completionReviewStatus: 'DISPUTED',
      },
      data: {
        completionReviewStatus: 'CLEARED',
        completionReviewResolvedAt: resolvedAt,
        completionReviewResolvedById: req.user.id,
        completionReviewResolutionNote: note,
        completionResolution: booking.isTrialLesson
          ? 'ADMIN_CONFIRMED_TRIAL'
          : 'ADMIN_APPROVED_TUTOR',
        version: { increment: 1 },
      },
    });
    if (!changed.count) {
      throw new AppError('The completion dispute changed while it was being resolved.', 409);
    }

    if (booking.payment?.id && Number(booking.payment.tutorPayoutAmount || 0) > 0) {
      const paymentChanged = await tx.payment.updateMany({
        where: { id: booking.payment.id, payoutStatus: 'DISPUTED' },
        data: {
          payoutStatus: 'ELIGIBLE',
          payoutEligibleAt: resolvedAt,
          payoutFailedAt: null,
          payoutFailureReason: null,
        },
      });
      if (!paymentChanged.count) {
        throw new AppError('The tutor earning changed while the dispute was being resolved.', 409);
      }
    }

    await tx.adminAction.create({
      data: {
        adminId: req.user.id,
        targetUserId: booking.learnerId,
        action: 'COMPLETION_DISPUTE_CLEARED',
        description: note,
        metadata: { bookingId: booking.id, paymentId: booking.payment?.id || null },
      },
    });
  });

  await Promise.all([
    notify(
      booking.learnerId,
      'payment',
      'Completion review resolved',
      booking.isTrialLesson
        ? `Support reviewed the completion issue for the free trial ${booking.subject} and confirmed the lesson outcome. No earning or payout was created.`
        : `Support reviewed the completion issue for ${booking.subject}. The tutor earning was approved for payout.`,
      `/bookings/${booking.id}`
    ),
    notify(
      booking.tutorProfile.user.id,
      'payment',
      booking.isTrialLesson ? 'Free trial completion confirmed' : 'Earning approved for payout',
      booking.isTrialLesson
        ? `Support cleared the completion review for the free trial ${booking.subject}. No earning or payout was created.`
        : `Support cleared the completion review for ${booking.subject}. The earning is now eligible for a future payout run.`,
      `/bookings/${booking.id}`
    ),
  ]);

  res.json({
    success: true,
    message: booking.isTrialLesson
      ? 'Free-trial completion dispute cleared. No earning or payout was created.'
      : 'Completion dispute cleared and tutor earning approved for payout.',
  });
};

exports.refundCompletionDispute = async (req, res) => {
  const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
  const expectedVersion = Number(req.body.expectedVersion);
  if (!note) throw new AppError('A resolution note is required.', 400);

  const initial = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: {
      payment: { include: { refund: true } },
      learner: { select: { id: true, firstName: true, lastName: true } },
      tutorProfile: {
        include: { user: { select: { id: true, firstName: true, lastName: true } } },
      },
    },
  });
  if (!initial) throw new AppError('Booking not found', 404);
  if (initial.completionReviewStatus !== 'DISPUTED' || initial.status !== 'COMPLETED') {
    throw new AppError('This lesson does not have an open completion dispute.', 409);
  }
  if (initial.version !== expectedVersion) {
    throw new AppError('The completion dispute changed. Refresh before resolving it.', 409);
  }

  let claim;
  try {
    claim = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${initial.id}))`;
      const booking = await tx.booking.findUnique({
        where: { id: initial.id },
        include: {
          payment: { include: { refund: true } },
          learner: { select: { id: true, firstName: true, lastName: true } },
          tutorProfile: {
            include: { user: { select: { id: true, firstName: true, lastName: true } } },
          },
        },
      });
      if (
        !booking ||
        booking.status !== 'COMPLETED' ||
        booking.version !== expectedVersion ||
        booking.completionReviewStatus !== 'DISPUTED'
      ) {
        throw new AppError('The completion dispute changed while it was being resolved.', 409);
      }

      const resolvedAt = new Date();
      const refund = booking.isTrialLesson
        ? null
        : await createRefundClaim(tx, {
            payment: booking.payment,
            initiatedById: req.user.id,
            source: REFUND_SOURCES.ADMIN_COMPLETION_DISPUTE,
            resolutionNote: note,
          });
      const refundAmount = refund ? Number(refund.amount) : 0;
      const outcome = {
        type: booking.isTrialLesson
          ? 'ADMIN_COMPLETION_DISPUTE_NOT_COMPLETED'
          : 'ADMIN_COMPLETION_DISPUTE_REFUND',
        actorRole: 'ADMIN',
        evaluatedAt: resolvedAt.toISOString(),
        refundPercent: refund ? 100 : 0,
        refundAmount,
        retainedAmount: 0,
        platformFeePercent:
          booking.payment?.platformFeePercent ?? DEFAULT_PLATFORM_FEE_PERCENT,
        platformFeeAmount: 0,
        tutorPayoutAmount: 0,
        paymentStatus: refund ? 'REFUND_PROCESSING' : undefined,
      };

      const updated = await tx.booking.update({
        where: {
          id: booking.id,
          status: 'COMPLETED',
          version: expectedVersion,
          completionReviewStatus: 'DISPUTED',
        },
        data: {
          status: 'NOT_COMPLETED',
          version: { increment: 1 },
          cancellationReason: booking.completionDisputeReason || note,
          cancellationOutcome: outcome,
          cancelledAt: resolvedAt,
          cancelledById: req.user.id,
          completionReviewStatus: 'RESOLVED_LEARNER',
          completionReviewResolvedAt: resolvedAt,
          completionReviewResolvedById: req.user.id,
          completionReviewResolutionNote: note,
          completionResolution: booking.isTrialLesson
            ? 'ADMIN_RESOLVED_LEARNER_TRIAL'
            : 'ADMIN_REFUNDED_LEARNER',
          statusHistory: {
            create: {
              status: 'NOT_COMPLETED',
              reason: `Completion dispute resolved in the learner's favour: ${note}`,
            },
          },
        },
      });

      // The existing completion flow counts the tutor's claim immediately. A
      // learner-favouring resolution reverses that count exactly once inside the
      // same final-outcome transaction.
      await tx.tutorProfile.updateMany({
        where: { id: booking.tutorId, totalSessions: { gt: 0 } },
        data: { totalSessions: { decrement: 1 } },
      });

      await tx.adminAction.create({
        data: {
          adminId: req.user.id,
          targetUserId: booking.learnerId,
          action: booking.isTrialLesson
            ? 'COMPLETION_DISPUTE_RESOLVED_LEARNER'
            : 'COMPLETION_DISPUTE_REFUNDED',
          description: note,
          metadata: {
            bookingId: booking.id,
            paymentId: booking.payment?.id || null,
            refundId: refund?.id || null,
            refundAmount,
            currency: booking.payment?.currency || booking.currency || 'AUD',
          },
        },
      });

      return { booking: updated, refund };
    });
  } catch (error) {
    if (error?.code === 'P2025') {
      throw new AppError('The completion dispute changed while it was being resolved.', 409);
    }
    throw error;
  }

  let submittedRefund = claim.refund;
  if (claim.refund) {
    try {
      submittedRefund = await submitRefund(claim.refund.id);
    } catch (error) {
      logger.error(`Refund ${claim.refund.id} needs provider reconciliation:`, error);
      submittedRefund = {
        ...claim.refund,
        status: 'PROCESSING',
        failureReason:
          'Stripe may have received the refund request, but its final status still needs reconciliation.',
      };
    }
  }

  const learnerMessage = !claim.refund
    ? `Support resolved the free trial ${initial.subject} in your favour. No payment transaction was required.`
    : submittedRefund?.status === 'FAILED'
      ? `Support resolved ${initial.subject} in your favour. Your full refund requires administrator attention before it can be sent.`
      : submittedRefund?.status === 'SUCCEEDED'
        ? `Support resolved ${initial.subject} in your favour. Stripe confirmed your full refund to the original payment method.`
        : `Support resolved ${initial.subject} in your favour. Your full refund is being processed for the original payment method.`;

  await Promise.all([
    notify(
      initial.learnerId,
      'payment',
      'Completion dispute resolved',
      learnerMessage,
      `/bookings/${initial.id}`
    ),
    notify(
      initial.tutorProfile.user.id,
      'payment',
      'Completion dispute resolved',
      `Support resolved ${initial.subject} in the learner's favour. No tutor earning is payable for this lesson.`,
      `/bookings/${initial.id}`
    ),
  ]);

  const processing = submittedRefund?.status === 'PROCESSING';
  const failed = submittedRefund?.status === 'FAILED';
  res.status(processing || failed ? 202 : 200).json({
    success: true,
    message: !claim.refund
      ? 'Completion dispute resolved in the learner’s favour. No refund was required for this free trial.'
      : failed
        ? 'Completion dispute resolved in the learner’s favour. The refund requires attention.'
        : processing
          ? 'Completion dispute resolved in the learner’s favour. The refund is processing.'
          : 'Completion dispute resolved in the learner’s favour and the refund was confirmed.',
    data: {
      bookingId: claim.booking.id,
      status: claim.booking.status,
      completionReviewStatus: claim.booking.completionReviewStatus,
      completionResolution: claim.booking.completionResolution,
      resolvedAt: claim.booking.completionReviewResolvedAt,
      refund: serializeRefund(submittedRefund),
    },
  });
};

exports.retryCompletionRefund = async (req, res) => {
  const refund = await prisma.paymentRefund.findUnique({
    where: { id: req.params.refundId },
    include: { payment: { include: { booking: true } } },
  });
  if (!refund) throw new AppError('Refund record not found.', 404);
  if (refund.status === 'SUCCEEDED') throw new AppError('This refund has already completed.', 409);

  let updated;
  try {
    updated = await submitRefund(refund.id);
  } catch (error) {
    logger.error(`Refund ${refund.id} still needs provider reconciliation:`, error);
    updated = {
      ...refund,
      status: 'PROCESSING',
      failureReason:
        'Stripe may have received the refund request, but its final status still needs reconciliation.',
    };
  }
  await prisma.adminAction.create({
    data: {
      adminId: req.user.id,
      targetUserId: refund.payment?.booking?.learnerId || null,
      action: 'COMPLETION_REFUND_RETRIED',
      description: `Retried refund ${refund.id}.`,
      metadata: {
        refundId: refund.id,
        bookingId: refund.payment?.bookingId || null,
        status: updated.status,
      },
    },
  });

  res.status(updated.status === 'SUCCEEDED' ? 200 : 202).json({
    success: true,
    message:
      updated.status === 'SUCCEEDED'
        ? 'The learner refund was confirmed.'
        : updated.status === 'FAILED'
          ? 'The refund retry failed and still requires attention.'
          : 'The learner refund is processing.',
    data: serializeRefund(updated),
  });
};

exports.getAdminActions = async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const pagination = parsePagination(page, limit);

  const [actions, total] = await Promise.all([
    prisma.adminAction.findMany({
      include: {
        admin: { select: { id: true, firstName: true, lastName: true } },
        targetUser: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: pagination.skip,
      take: pagination.limit,
    }),
    prisma.adminAction.count(),
  ]);

  res.json({
    success: true,
    data: {
      actions,
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        totalPages: Math.ceil(total / pagination.limit),
      },
    },
  });
};

exports.createSubject = async (req, res) => {
  const { name, category, description } = req.body;

  const subject = await prisma.subject.create({
    data: { name, category, description },
  });

  await prisma.adminAction.create({
    data: {
      adminId: req.user.id,
      action: 'SUBJECT_CREATED',
      description: `Created subject ${subject.name}`,
      metadata: { subjectId: subject.id },
    },
  });

  res.status(201).json({ success: true, data: subject });
};

exports.updateSubject = async (req, res) => {
  const { name, category, description } = req.body;

  const subject = await prisma.subject.update({
    where: { id: req.params.id },
    data: {
      ...(name && { name }),
      ...(category && { category }),
      ...(description !== undefined && { description }),
    },
  });

  await prisma.adminAction.create({
    data: {
      adminId: req.user.id,
      action: 'SUBJECT_UPDATED',
      description: `Updated subject ${subject.name}`,
      metadata: { subjectId: subject.id },
    },
  });

  res.json({ success: true, data: subject });
};

exports.deleteSubject = async (req, res) => {
  const subject = await prisma.subject.findUnique({ where: { id: req.params.id } });

  if (!subject) throw new AppError('Subject not found', 404);

  await prisma.subject.delete({ where: { id: req.params.id } });

  await prisma.adminAction.create({
    data: {
      adminId: req.user.id,
      action: 'SUBJECT_DELETED',
      description: `Deleted subject ${subject.name}`,
      metadata: { subjectId: subject.id, subjectName: subject.name },
    },
  });

  res.json({ success: true, message: 'Subject deleted' });
};
