const databaseModulePath = require.resolve('../../src/config/database');
const stripeModulePath = require.resolve('../../src/config/stripe');
const notificationModulePath = require.resolve('../../src/services/notificationService');
const serviceModulePath = require.resolve('../../src/services/adminPayoutService');

const prisma = {
  booking: { updateMany: vi.fn() },
  payment: { findMany: vi.fn(), updateMany: vi.fn() },
  payoutRun: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  payoutTransfer: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  adminAction: { create: vi.fn() },
  $executeRaw: vi.fn(),
  $transaction: vi.fn((callback) => callback(prisma)),
};
const stripeTransferCreate = vi.fn();
const notifyOrRefresh = vi.fn();

for (const modulePath of [
  databaseModulePath,
  stripeModulePath,
  notificationModulePath,
  serviceModulePath,
]) {
  delete require.cache[modulePath];
}

require.cache[databaseModulePath] = {
  id: databaseModulePath,
  filename: databaseModulePath,
  loaded: true,
  exports: { prisma },
};
require.cache[stripeModulePath] = {
  id: stripeModulePath,
  filename: stripeModulePath,
  loaded: true,
  exports: {
    isStripeConfigured: () => true,
    getStripe: () => ({ transfers: { create: stripeTransferCreate } }),
  },
};
require.cache[notificationModulePath] = {
  id: notificationModulePath,
  filename: notificationModulePath,
  loaded: true,
  exports: { notifyOrRefresh },
};

const {
  groupPayoutCandidates,
  isIndeterminateProviderError,
  processPayoutRun,
  safeTransferFailure,
} = require('../../src/services/adminPayoutService');

const tutor = {
  id: 'tutor-profile-1',
  user: {
    id: 'tutor-user-1',
    firstName: 'Taylor',
    lastName: 'Tutor',
    email: 'tutor@example.com',
  },
  payoutAccount: {
    isPayoutReady: true,
    stripeAccountId: 'acct_tutor_1',
  },
};

const candidate = (id, amount, subject, overrides = {}) => ({
  id,
  tutorPayoutAmount: amount,
  currency: 'AUD',
  payoutStatus: 'ELIGIBLE',
  payoutEligibleAt: new Date('2026-08-01T00:00:00.000Z'),
  booking: {
    id: `booking-${id}`,
    tutorId: tutor.id,
    subject,
    scheduledAt: new Date('2026-07-30T00:00:00.000Z'),
    completedAt: new Date('2026-07-30T01:00:00.000Z'),
    learner: { id: 'learner-1', firstName: 'Lee', lastName: 'Learner' },
    tutorProfile: tutor,
  },
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  prisma.$transaction.mockImplementation((callback) => callback(prisma));
  prisma.booking.updateMany.mockResolvedValue({ count: 0 });
  prisma.payment.updateMany.mockResolvedValue({ count: 2 });
  prisma.payoutRun.findMany.mockResolvedValue([]);
  prisma.payoutTransfer.findMany.mockResolvedValue([]);
});

describe('admin payout transfers', () => {
  test('combines lesson earnings by tutor and currency in exact cents', () => {
    const groups = groupPayoutCandidates([
      candidate('payment-1', '50.25', 'Mathematics'),
      candidate('payment-2', '34.75', 'Physics'),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual(
      expect.objectContaining({
        tutorProfileId: tutor.id,
        currency: 'AUD',
        amount: '85.00',
        amountMinor: 8500,
        paymentCount: 2,
      })
    );
  });

  test('creates one idempotent Stripe transfer and marks every included lesson paid', async () => {
    const payments = [
      candidate('payment-1', '50.25', 'Mathematics'),
      candidate('payment-2', '34.75', 'Physics'),
    ];
    const run = {
      id: 'run-1',
      initiatedByAdminId: 'admin-1',
      status: 'PROCESSING',
      paymentCount: 2,
      transferCount: 1,
      successfulTransferCount: 0,
      failedTransferCount: 0,
      startedAt: new Date('2026-08-01T02:00:00.000Z'),
    };
    const transfer = {
      id: 'transfer-1',
      payoutRunId: run.id,
      tutorProfileId: tutor.id,
      amount: '85.00',
      currency: 'AUD',
      status: 'PROCESSING',
      idempotencyKey: 'payout-run:run-1:tutor:tutor-profile-1:currency:AUD',
      tutorProfile: tutor,
      items: payments.map((payment) => ({
        paymentId: payment.id,
        amount: payment.tutorPayoutAmount,
        payment,
      })),
    };
    const succeededTransfer = {
      ...transfer,
      status: 'SUCCEEDED',
      providerTransferId: 'tr_test_1',
      completedAt: new Date(),
    };
    const completedRun = {
      ...run,
      status: 'COMPLETED',
      successfulTransferCount: 1,
      failedTransferCount: 0,
      completedAt: new Date(),
      initiatedByAdmin: {
        id: 'admin-1',
        firstName: 'Ada',
        lastName: 'Admin',
        role: 'ADMIN',
      },
      transfers: [succeededTransfer],
    };

    prisma.payment.findMany.mockResolvedValue(payments);
    prisma.payoutRun.create.mockResolvedValue(run);
    prisma.payoutTransfer.create.mockResolvedValue(transfer);
    prisma.payoutTransfer.update.mockResolvedValue(succeededTransfer);
    prisma.payoutRun.update.mockResolvedValue(completedRun);
    stripeTransferCreate.mockResolvedValue({ id: 'tr_test_1' });

    const result = await processPayoutRun({ id: 'admin-1', role: 'ADMIN' });

    expect(result).toEqual(expect.objectContaining({ id: 'run-1', status: 'COMPLETED' }));
    expect(stripeTransferCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 8500,
        currency: 'aud',
        destination: 'acct_tutor_1',
      }),
      { idempotencyKey: transfer.idempotencyKey }
    );
    expect(prisma.payment.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: { in: ['payment-1', 'payment-2'] },
        payoutStatus: 'PROCESSING',
      },
      data: {
        payoutStatus: 'PAID',
        payoutAt: expect.any(Date),
        payoutFailedAt: null,
        payoutFailureReason: null,
      },
    });
    expect(prisma.adminAction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'PAYOUT_RUN_PROCESSED' }) })
    );
  });

  test('claims and transfers earnings for only the selected tutor', async () => {
    const payment = candidate('payment-selected', '8.50', 'Calculus');
    const run = {
      id: 'run-selected',
      initiatedByAdminId: 'admin-1',
      status: 'PROCESSING',
      paymentCount: 1,
      transferCount: 1,
      successfulTransferCount: 0,
      failedTransferCount: 0,
      startedAt: new Date('2026-08-01T02:00:00.000Z'),
    };
    const transfer = {
      id: 'transfer-selected',
      payoutRunId: run.id,
      tutorProfileId: tutor.id,
      amount: '8.50',
      currency: 'AUD',
      status: 'PROCESSING',
      idempotencyKey: 'payout-run:run-selected:tutor:tutor-profile-1:currency:AUD',
      tutorProfile: tutor,
      items: [{ paymentId: payment.id, amount: payment.tutorPayoutAmount, payment }],
    };
    const succeededTransfer = {
      ...transfer,
      status: 'SUCCEEDED',
      providerTransferId: 'tr_selected',
      completedAt: new Date(),
    };
    const completedRun = {
      ...run,
      status: 'COMPLETED',
      successfulTransferCount: 1,
      failedTransferCount: 0,
      completedAt: new Date(),
      initiatedByAdmin: { id: 'admin-1', firstName: 'Ada', lastName: 'Admin', role: 'ADMIN' },
      transfers: [succeededTransfer],
    };

    prisma.payment.findMany.mockResolvedValue([payment]);
    prisma.payment.updateMany.mockResolvedValue({ count: 1 });
    prisma.payoutRun.create.mockResolvedValue(run);
    prisma.payoutTransfer.create.mockResolvedValue(transfer);
    prisma.payoutTransfer.update.mockResolvedValue(succeededTransfer);
    prisma.payoutRun.update.mockResolvedValue(completedRun);
    stripeTransferCreate.mockResolvedValue({ id: 'tr_selected' });

    await processPayoutRun(
      { id: 'admin-1', role: 'ADMIN' },
      { tutorProfileId: tutor.id }
    );

    expect(prisma.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          booking: expect.objectContaining({
            is: expect.objectContaining({ tutorId: tutor.id }),
          }),
        }),
      })
    );
    expect(stripeTransferCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 850, destination: 'acct_tutor_1' }),
      { idempotencyKey: transfer.idempotencyKey }
    );
    expect(prisma.adminAction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'TUTOR_PAYOUT_RUN_PROCESSED',
          metadata: expect.objectContaining({ tutorProfileId: tutor.id }),
        }),
      })
    );
  });

  test('turns provider failures into safe retryable admin messages', () => {
    expect(safeTransferFailure({ code: 'balance_insufficient' })).toMatch(/balance is not yet available/i);
    expect(safeTransferFailure({ code: 'secret_internal_detail' })).not.toContain('internal detail');
  });

  test('keeps ambiguous network failures in reconciliation instead of risking a duplicate transfer', () => {
    expect(isIndeterminateProviderError({ type: 'StripeConnectionError' })).toBe(true);
    expect(isIndeterminateProviderError({ statusCode: 503 })).toBe(true);
    expect(isIndeterminateProviderError({ code: 'balance_insufficient', statusCode: 400 })).toBe(false);
  });
});
