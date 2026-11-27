-- PAY-08: mutually exclusive post-lesson outcomes and auditable provider refunds.

ALTER TYPE "CompletionReviewStatus" ADD VALUE 'RESOLVED_LEARNER';
ALTER TYPE "BookingStatus" ADD VALUE 'NOT_COMPLETED' BEFORE 'RESCHEDULED';

CREATE TYPE "RefundStatus" AS ENUM ('PROCESSING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "RefundSource" AS ENUM ('TUTOR_NON_COMPLETION', 'ADMIN_COMPLETION_DISPUTE');
CREATE TYPE "CompletionResolution" AS ENUM (
  'LEGACY_CLEARED',
  'LEARNER_CONFIRMED',
  'WINDOW_EXPIRED',
  'ADMIN_APPROVED_TUTOR',
  'ADMIN_CONFIRMED_TRIAL',
  'TUTOR_REPORTED_NOT_COMPLETED',
  'ADMIN_REFUNDED_LEARNER',
  'ADMIN_RESOLVED_LEARNER_TRIAL'
);

ALTER TABLE "bookings" ADD COLUMN "completionResolution" "CompletionResolution";

-- PAY-07 already produced final CLEARED reviews before the explicit outcome
-- field existed. Preserve those records honestly rather than inferring how
-- each review was cleared.
UPDATE "bookings"
SET "completionResolution" = 'LEGACY_CLEARED'
WHERE "completionReviewStatus" = 'CLEARED'
  AND "completionResolution" IS NULL;

CREATE TABLE "payment_refunds" (
  "id" TEXT NOT NULL,
  "paymentId" TEXT NOT NULL,
  "initiatedById" TEXT NOT NULL,
  "source" "RefundSource" NOT NULL,
  "amount" DECIMAL(10,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'AUD',
  "status" "RefundStatus" NOT NULL DEFAULT 'PROCESSING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "resolutionNote" TEXT NOT NULL,
  "failureReason" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "failedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payment_refunds_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_refunds_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "payments"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "payment_refunds_initiatedById_fkey"
    FOREIGN KEY ("initiatedById") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "payment_refund_attempts" (
  "id" TEXT NOT NULL,
  "refundId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "status" "RefundStatus" NOT NULL DEFAULT 'PROCESSING',
  "providerRefundId" TEXT,
  "providerStatus" TEXT,
  "providerRequestStartedAt" TIMESTAMP(3),
  "idempotencyKey" TEXT NOT NULL,
  "failureReason" TEXT,
  "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "failedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payment_refund_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_refund_attempts_refundId_fkey"
    FOREIGN KEY ("refundId") REFERENCES "payment_refunds"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "payment_refunds_paymentId_key" ON "payment_refunds"("paymentId");
CREATE INDEX "payment_refunds_status_requestedAt_idx" ON "payment_refunds"("status", "requestedAt");
CREATE INDEX "payment_refunds_initiatedById_requestedAt_idx" ON "payment_refunds"("initiatedById", "requestedAt");
CREATE UNIQUE INDEX "payment_refund_attempts_providerRefundId_key" ON "payment_refund_attempts"("providerRefundId");
CREATE UNIQUE INDEX "payment_refund_attempts_idempotencyKey_key" ON "payment_refund_attempts"("idempotencyKey");
CREATE UNIQUE INDEX "payment_refund_attempts_refundId_sequence_key" ON "payment_refund_attempts"("refundId", "sequence");
CREATE INDEX "payment_refund_attempts_refundId_attemptedAt_idx" ON "payment_refund_attempts"("refundId", "attemptedAt");
CREATE INDEX "payment_refund_attempts_status_attemptedAt_idx" ON "payment_refund_attempts"("status", "attemptedAt");
