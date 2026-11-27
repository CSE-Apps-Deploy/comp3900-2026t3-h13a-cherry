const { PrismaClient } = require('@prisma/client');
const { hashPassword } = require('../src/utils/passwords');
const { resolveLocalTime } = require('../src/utils/timezone');

const prisma = new PrismaClient();

const DEMO_TIMEZONE = 'Australia/Sydney';
const DEMO_YEAR = 2026;
const DEMO_MONTH = 8;

const SUBJECTS = [
  { name: 'Mathematics', category: 'Mathematics', description: 'General mathematics' },
  { name: 'Calculus', category: 'Mathematics', description: 'Differential and integral calculus' },
  { name: 'Algebra', category: 'Mathematics', description: 'Linear and abstract algebra' },
  { name: 'Statistics', category: 'Mathematics', description: 'Statistics and probability' },
  { name: 'Physics', category: 'Science', description: 'Classical and modern physics' },
  { name: 'Chemistry', category: 'Science', description: 'General and organic chemistry' },
  { name: 'Programming', category: 'Computing', description: 'General programming concepts' },
  { name: 'Python', category: 'Computing', description: 'Python programming language' },
  { name: 'JavaScript', category: 'Computing', description: 'JavaScript and web development' },
  { name: 'Data Science', category: 'Computing', description: 'Data analysis and machine learning' },
  { name: 'English', category: 'Languages', description: 'English language and literature' },
  { name: 'Japanese', category: 'Languages', description: 'Japanese language' },
];

const CLASS_DEMO_BOOKINGS = [
  {
    bookingId: '10000000-0000-4000-8000-000000000703',
    paymentId: '20000000-0000-4000-8000-000000000703',
    subject: 'Edison Tutor Payout Demo',
    notes: 'Open this lesson as the learner and confirm it was completed.',
    day: 5,
    hour: 10,
    status: 'ACCEPTED',
  },
  {
    bookingId: '10000000-0000-4000-8000-000000000705',
    paymentId: '20000000-0000-4000-8000-000000000705',
    subject: 'Dispute Demo - Refund Learner',
    notes: 'Open this booking as the learner and report that it was not completed.',
    day: 5,
    hour: 11,
    status: 'ACCEPTED',
  },
  {
    bookingId: '10000000-0000-4000-8000-000000000706',
    paymentId: '20000000-0000-4000-8000-000000000706',
    subject: 'Tutor Emergency Demo',
    notes: 'Mark this lesson as not completed as the tutor.',
    day: 5,
    hour: 12,
    status: 'ACCEPTED',
  },
  {
    bookingId: '10000000-0000-4000-8000-000000000707',
    paymentId: '20000000-0000-4000-8000-000000000707',
    subject: 'Yechan - Within 24 Hours',
    notes: 'Accepted booking for the within-24-hours demonstration.',
    day: 6,
    hour: 18,
    status: 'ACCEPTED',
  },
  {
    bookingId: '10000000-0000-4000-8000-000000000708',
    paymentId: '20000000-0000-4000-8000-000000000708',
    subject: 'Yechan - Outside 24 Hours',
    notes: 'Accepted booking for the outside-24-hours demonstration.',
    day: 8,
    hour: 10,
    status: 'ACCEPTED',
  },
  {
    bookingId: '10000000-0000-4000-8000-000000000709',
    paymentId: '20000000-0000-4000-8000-000000000709',
    subject: 'Kieran Schedule Demo',
    notes: 'Leave this booking pending for the scheduling demonstration.',
    day: 8,
    hour: 12,
    status: 'PENDING',
  },
];

function getClassDemoStart(day, hour) {
  const { instants } = resolveLocalTime(
    { year: DEMO_YEAR, month: DEMO_MONTH, day, hour },
    DEMO_TIMEZONE
  );
  if (!instants[0]) {
    throw new Error(`Could not resolve ${DEMO_YEAR}-${DEMO_MONTH}-${day} ${hour}:00 Sydney time`);
  }
  return instants[0];
}

async function ensurePendingBookingPayment({ booking, learner, paymentId }) {
  if (booking.status !== 'PENDING' || booking.isTrialLesson) return;

  const existingPayment = await prisma.payment.findUnique({
    where: { bookingId: booking.id },
  });
  if (existingPayment) {
    if (existingPayment.status === 'PENDING') {
      await prisma.payment.update({
        where: { id: existingPayment.id },
        data: {
          amount: booking.totalAmount,
          currency: booking.currency,
        },
      });
    }
    return;
  }

  await prisma.payment.create({
    data: {
      id: paymentId,
      userId: learner.id,
      bookingId: booking.id,
      amount: booking.totalAmount,
      currency: booking.currency,
      status: 'PENDING',
      stripeCustomerId: learner.stripeCustomerId || null,
      stripePaymentMethodId: learner.stripeDefaultPaymentMethodId || null,
      stripeIdempotencyKey: `seed_accept_${booking.id}`,
      description: `${booking.subject} session booking payment`,
    },
  });
}

async function seedClassDemoBookings({ tutorProfile, learner }) {
  let createdBookingCount = 0;

  for (const fixture of CLASS_DEMO_BOOKINGS) {
    const scheduledAt = getClassDemoStart(fixture.day, fixture.hour);
    let booking = await prisma.booking.findUnique({ where: { id: fixture.bookingId } });

    if (!booking) {
      booking = await prisma.booking.create({
        data: {
          id: fixture.bookingId,
          learnerId: learner.id,
          tutorId: tutorProfile.id,
          subject: fixture.subject,
          status: fixture.status,
          sessionType: 'ONLINE',
          scheduledAt,
          duration: 60,
          hourlyRate: 75,
          totalAmount: 75,
          currency: 'AUD',
          notes: fixture.notes,
          meetingTool: 'GOOGLE_MEET',
          recurringType: 'ONE_OFF',
          cancellationCutoffHours: 24,
          lateCancellationRefundPercent: 0,
          learnerTimezone: DEMO_TIMEZONE,
          tutorTimezone: DEMO_TIMEZONE,
          statusHistory: {
            create:
              fixture.status === 'ACCEPTED'
                ? [
                    { status: 'PENDING', reason: 'Seeded class demo booking request' },
                    { status: 'ACCEPTED', reason: 'Seeded class demo tutor acceptance' },
                  ]
                : [{ status: 'PENDING', reason: 'Seeded class demo booking request' }],
          },
        },
      });
      createdBookingCount += 1;
    }

    if (fixture.status === 'PENDING') {
      await ensurePendingBookingPayment({ booking, learner, paymentId: fixture.paymentId });
      continue;
    }

    const existingPayment = await prisma.payment.findUnique({
      where: { bookingId: booking.id },
    });
    if (existingPayment) continue;

    const paidAt = new Date(Date.UTC(DEMO_YEAR, DEMO_MONTH - 1, 4));
    await prisma.payment.create({
      data: {
        id: fixture.paymentId,
        userId: learner.id,
        bookingId: booking.id,
        amount: 75,
        currency: 'AUD',
        status: 'PAID',
        description: `${booking.subject} seeded database-only payment`,
        platformFeePercent: 15,
        platformFeeAmount: 11.25,
        tutorPayoutAmount: 63.75,
        payoutStatus: 'PENDING',
        payoutPendingAt: paidAt,
        payoutEligibleAt: null,
        processedAt: paidAt,
        paidAt,
        createdAt: paidAt,
      },
    });
  }

  return createdBookingCount;
}

async function upsertUser({ email, password, firstName, lastName, role, status, bio, timezone = 'Australia/Sydney' }) {
  const storedPassword = hashPassword(password);

  return prisma.user.upsert({
    where: { email },
    update: {
      password: storedPassword,
      firstName,
      lastName,
      role,
      status,
      bio: bio || null,
      timezone,
      isEmailVerified: true,
    },
    create: {
      email,
      password: storedPassword,
      firstName,
      lastName,
      role,
      status,
      bio: bio || null,
      timezone,
      isEmailVerified: true,
    },
  });
}

async function main() {
  console.log('Seeding demo data...');

  const subjects = await Promise.all(
    SUBJECTS.map((subject) =>
      prisma.subject.upsert({
        where: { name: subject.name },
        update: subject,
        create: subject,
      })
    )
  );

  const admin = await upsertUser({
    email: 'admin@tutorconnect.com',
    password: 'Admin@123456',
    firstName: 'Admin',
    lastName: 'User',
    role: 'ADMIN',
    status: 'ACTIVE',
    bio: 'Platform administrator account.',
  });

  const learner = await upsertUser({
    email: 'learner@demo.com',
    password: 'Learner@123',
    firstName: 'Alex',
    lastName: 'Johnson',
    role: 'LEARNER',
    status: 'ACTIVE',
    bio: 'University student looking to improve in mathematics and programming.',
  });

  await prisma.learnerProfile.upsert({
    where: { userId: learner.id },
    update: {
      gradeLevel: 'University Year 2',
      learningGoals: 'Improve math and coding skills',
      subjects: ['Mathematics', 'Python', 'Data Science'],
      preferredStyle: 'visual',
    },
    create: {
      userId: learner.id,
      gradeLevel: 'University Year 2',
      learningGoals: 'Improve math and coding skills',
      subjects: ['Mathematics', 'Python', 'Data Science'],
      preferredStyle: 'visual',
    },
  });

  await prisma.subscription.upsert({
    where: { userId: learner.id },
    update: {
      plan: 'FREE',
      status: 'ACTIVE',
    },
    create: {
      userId: learner.id,
      plan: 'FREE',
      status: 'ACTIVE',
    },
  });

  const tutor = await upsertUser({
    email: 'tutor@demo.com',
    password: 'Tutor@123',
    firstName: 'Sarah',
    lastName: 'Chen',
    role: 'TUTOR',
    status: 'ACTIVE',
    bio: 'PhD candidate teaching mathematics and programming.',
  });

  const tutorProfile = await prisma.tutorProfile.upsert({
    where: { userId: tutor.id },
    update: {
      status: 'ACTIVE',
      headline: 'Expert Math and Programming Tutor',
      hourlyRate: 75,
      currency: 'AUD',
      yearsExperience: 8,
      education: [
        { institution: 'UNSW Sydney', degree: 'PhD', field: 'Mathematics', year: '2024' },
      ],
      certifications: [{ name: 'Google Data Analytics Certificate', issuer: 'Google', year: '2022' }],
      languages: ['English', 'Mandarin Chinese'],
      sessionTypes: ['ONLINE', 'IN_PERSON'],
      location: 'Sydney, NSW, Australia',
      rating: 4.9,
      totalReviews: 47,
      totalSessions: 12,
      isVerified: true,
      verifiedAt: new Date(),
      responseTime: 30,
    },
    create: {
      userId: tutor.id,
      status: 'ACTIVE',
      headline: 'Expert Math and Programming Tutor',
      hourlyRate: 75,
      currency: 'AUD',
      yearsExperience: 8,
      education: [
        { institution: 'UNSW Sydney', degree: 'PhD', field: 'Mathematics', year: '2024' },
      ],
      certifications: [{ name: 'Google Data Analytics Certificate', issuer: 'Google', year: '2022' }],
      languages: ['English', 'Mandarin Chinese'],
      sessionTypes: ['ONLINE', 'IN_PERSON'],
      location: 'Sydney, NSW, Australia',
      rating: 4.9,
      totalReviews: 47,
      totalSessions: 12,
      isVerified: true,
      verifiedAt: new Date(),
      responseTime: 30,
    },
  });

  const pendingTutor = await upsertUser({
    email: 'pending.tutor@demo.com',
    password: 'Tutor@123',
    firstName: 'Mia',
    lastName: 'Wong',
    role: 'TUTOR',
    status: 'ACTIVE',
    bio: 'Pending tutor application for admin review.',
  });

  const pendingTutorProfile = await prisma.tutorProfile.upsert({
    where: { userId: pendingTutor.id },
    update: {
      status: 'PENDING',
      headline: 'STEM tutor application',
      hourlyRate: 55,
      currency: 'AUD',
      yearsExperience: 3,
      education: [{ institution: 'USYD', degree: 'BSc', field: 'Physics', year: '2023' }],
      certifications: [{ text: 'Teaching statement submitted' }],
      languages: ['English'],
      sessionTypes: ['ONLINE'],
      location: 'Sydney, NSW, Australia',
      isVerified: false,
      verifiedAt: null,
      responseTime: 90,
    },
    create: {
      userId: pendingTutor.id,
      status: 'PENDING',
      headline: 'STEM tutor application',
      hourlyRate: 55,
      currency: 'AUD',
      yearsExperience: 3,
      education: [{ institution: 'USYD', degree: 'BSc', field: 'Physics', year: '2023' }],
      certifications: [{ text: 'Teaching statement submitted' }],
      languages: ['English'],
      sessionTypes: ['ONLINE'],
      location: 'Sydney, NSW, Australia',
      isVerified: false,
      verifiedAt: null,
      responseTime: 90,
    },
  });

  const timezoneLearner = await upsertUser({
    email: 'tz.learner.la@demo.com',
    password: 'Demo@123456',
    firstName: 'Timezone',
    lastName: 'Learner LA',
    role: 'LEARNER',
    status: 'ACTIVE',
    timezone: 'America/Los_Angeles',
    bio: 'Timezone validation learner account.',
  });

  await prisma.learnerProfile.upsert({
    where: { userId: timezoneLearner.id },
    update: {
      gradeLevel: 'Demo',
      learningGoals: 'Validate timezone display',
      subjects: ['Mathematics', 'Programming'],
      preferredStyle: 'visual',
    },
    create: {
      userId: timezoneLearner.id,
      gradeLevel: 'Demo',
      learningGoals: 'Validate timezone display',
      subjects: ['Mathematics', 'Programming'],
      preferredStyle: 'visual',
    },
  });

  const timezoneTutor = await upsertUser({
    email: 'tz.tutor.sydney@demo.com',
    password: 'Demo@123456',
    firstName: 'Timezone',
    lastName: 'Tutor Sydney',
    role: 'TUTOR',
    status: 'ACTIVE',
    timezone: 'Australia/Sydney',
    bio: 'Sydney tutor account for timezone validation.',
  });

  const timezoneTutorProfile = await prisma.tutorProfile.upsert({
    where: { userId: timezoneTutor.id },
    update: {
      status: 'ACTIVE',
      applicationSubmitted: true,
      headline: 'Sydney Timezone Demo Tutor',
      hourlyRate: 70,
      currency: 'AUD',
      yearsExperience: 6,
      education: [{ institution: 'UNSW Sydney', degree: 'MSc', field: 'Mathematics', year: '2022' }],
      certifications: [{ text: 'Timezone demo verified tutor' }],
      languages: ['English'],
      sessionTypes: ['ONLINE'],
      location: 'Sydney, NSW, Australia',
      rating: 4.8,
      totalReviews: 12,
      totalSessions: 20,
      isVerified: true,
      verifiedAt: new Date(),
      responseTime: 20,
    },
    create: {
      userId: timezoneTutor.id,
      status: 'ACTIVE',
      applicationSubmitted: true,
      headline: 'Sydney Timezone Demo Tutor',
      hourlyRate: 70,
      currency: 'AUD',
      yearsExperience: 6,
      education: [{ institution: 'UNSW Sydney', degree: 'MSc', field: 'Mathematics', year: '2022' }],
      certifications: [{ text: 'Timezone demo verified tutor' }],
      languages: ['English'],
      sessionTypes: ['ONLINE'],
      location: 'Sydney, NSW, Australia',
      rating: 4.8,
      totalReviews: 12,
      totalSessions: 20,
      isVerified: true,
      verifiedAt: new Date(),
      responseTime: 20,
    },
  });

  const byName = Object.fromEntries(subjects.map((subject) => [subject.name, subject]));

  for (const subjectName of ['Mathematics', 'Python', 'Calculus']) {
    const subject = byName[subjectName];
    if (!subject) continue;
    await prisma.tutorSubject.upsert({
      where: {
        tutorId_subjectId: {
          tutorId: tutorProfile.id,
          subjectId: subject.id,
        },
      },
      update: {
        level: 'all',
        hourlyRate: tutorProfile.hourlyRate,
      },
      create: {
        tutorId: tutorProfile.id,
        subjectId: subject.id,
        level: 'all',
        hourlyRate: tutorProfile.hourlyRate,
      },
    });
  }

  const pendingSubject = byName.Physics;
  if (pendingSubject) {
    await prisma.tutorSubject.upsert({
      where: {
        tutorId_subjectId: {
          tutorId: pendingTutorProfile.id,
          subjectId: pendingSubject.id,
        },
      },
      update: {
        level: 'intermediate',
        hourlyRate: pendingTutorProfile.hourlyRate,
      },
      create: {
        tutorId: pendingTutorProfile.id,
        subjectId: pendingSubject.id,
        level: 'intermediate',
        hourlyRate: pendingTutorProfile.hourlyRate,
      },
    });
  }

  const timezoneSubject = byName.Mathematics;
  if (timezoneSubject) {
    await prisma.tutorSubject.upsert({
      where: {
        tutorId_subjectId: {
          tutorId: timezoneTutorProfile.id,
          subjectId: timezoneSubject.id,
        },
      },
      update: {
        level: 'all',
        description: 'Timezone demo mathematics sessions',
        hourlyRate: timezoneTutorProfile.hourlyRate,
      },
      create: {
        tutorId: timezoneTutorProfile.id,
        subjectId: timezoneSubject.id,
        level: 'all',
        description: 'Timezone demo mathematics sessions',
        hourlyRate: timezoneTutorProfile.hourlyRate,
      },
    });
  }

  await prisma.tutorAvailability.deleteMany({
    where: {
      tutorId: { in: [tutorProfile.id, pendingTutorProfile.id, timezoneTutorProfile.id] },
    },
  });

  await prisma.tutorAvailability.createMany({
    data: [
      { tutorId: tutorProfile.id, dayOfWeek: 1, startTime: '09:00', endTime: '18:00', timezone: 'Australia/Sydney' },
      { tutorId: tutorProfile.id, dayOfWeek: 3, startTime: '10:00', endTime: '16:00', timezone: 'Australia/Sydney' },
      { tutorId: tutorProfile.id, dayOfWeek: 4, startTime: '00:00', endTime: '24:00', timezone: 'Australia/Sydney' },
      { tutorId: tutorProfile.id, dayOfWeek: 6, startTime: '10:00', endTime: '14:00', timezone: 'Australia/Sydney' },
      { tutorId: pendingTutorProfile.id, dayOfWeek: 2, startTime: '17:00', endTime: '20:00', timezone: 'Australia/Sydney' },
      { tutorId: timezoneTutorProfile.id, dayOfWeek: 1, startTime: '09:00', endTime: '11:00', timezone: 'Australia/Sydney' },
      { tutorId: timezoneTutorProfile.id, dayOfWeek: 3, startTime: '18:00', endTime: '20:00', timezone: 'Australia/Sydney' },
      { tutorId: timezoneTutorProfile.id, dayOfWeek: 6, startTime: '10:00', endTime: '12:00', timezone: 'Australia/Sydney' },
    ],
  });

  const createdClassDemoBookings = await seedClassDemoBookings({ tutorProfile, learner });

  await prisma.adminAction.create({
    data: {
      adminId: admin.id,
      targetUserId: pendingTutor.id,
      action: 'TUTOR_PROFILE_RETURNED',
      description: 'Please add more detail to your teaching experience.',
      metadata: { seeded: true },
    },
  }).catch(() => null);

  console.log(`Seeded ${subjects.length} subjects.`);
  console.log(`Seeded ${createdClassDemoBookings} new class demo booking(s).`);
  console.log('Demo accounts:');
  console.log('  Admin:   admin@tutorconnect.com / Admin@123456');
  console.log('  Learner: learner@demo.com / Learner@123');
  console.log('  Tutor:   tutor@demo.com / Tutor@123');
  console.log('  Pending tutor: pending.tutor@demo.com / Tutor@123');
  console.log('  TZ learner: tz.learner.la@demo.com / Demo@123456');
  console.log('  TZ tutor:   tz.tutor.sydney@demo.com / Demo@123456');
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
