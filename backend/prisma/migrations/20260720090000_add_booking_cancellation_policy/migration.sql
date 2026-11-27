ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_REFUNDED';

ALTER TABLE "bookings"
  ADD COLUMN "cancellationCutoffHours" INTEGER NOT NULL DEFAULT 24,
  ADD COLUMN "lateCancellationRefundPercent" DECIMAL(5,2) NOT NULL DEFAULT 50.00,
  ADD COLUMN "cancellationOutcome" JSONB,
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancelledById" TEXT;