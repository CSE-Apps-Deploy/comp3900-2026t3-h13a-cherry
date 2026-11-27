-- PAY-07: learner completion review and admin-controlled Stripe Connect transfers.

ALTER TYPE "PayoutStatus" ADD VALUE 'PROCESSING' BEFORE 'PAID';
ALTER TYPE "PayoutStatus" ADD VALUE 'DISPUTED' BEFORE 'PAID';

CREATE TYPE "CompletionReviewStatus" AS ENUM ('AWAITING_LEARNER', 'DISPUTED', 'CLEARED');
CREATE TYPE "PayoutRunStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'PARTIALLY_FAILED', 'FAILED');
CREATE TYPE "PayoutTransferStatus" AS ENUM ('PROCESSING', 'SUCCEEDED', 'FAILED');

ALTER TABLE "bookings"
  ADD COLUMN "completionReviewStatus" "CompletionReviewStatus",
  ADD COLUMN "completionReviewDueAt" TIMESTAMP(3),
  ADD COLUMN "completionDisputedAt" TIMESTAMP(3),
  ADD COLUMN "completionDisputeReason" TEXT,
  ADD COLUMN "completionReviewResolvedAt" TIMESTAMP(3),
  ADD COLUMN "completionReviewResolvedById" TEXT,
  ADD COLUMN "completionReviewResolutionNote" TEXT;

-- Existing completed lessons already passed the old immediate-eligibility rule.
-- Preserve that decision instead of retroactively opening a dispute window.
UPDATE "bookings"
SET
  "completionReviewStatus" = 'CLEARED',
  "completionReviewDueAt" = COALESCE("completedAt", "updatedAt")
WHERE "status"::text = 'COMPLETED';

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_completionReviewResolvedById_fkey"
  FOREIGN KEY ("completionReviewResolvedById") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "bookings_completionReviewStatus_completionReviewDueAt_idx"
  ON "bookings"("completionReviewStatus", "completionReviewDueAt");

CREATE TABLE "payout_runs" (
  "id" TEXT NOT NULL,
  "initiatedByAdminId" TEXT NOT NULL,
  "status" "PayoutRunStatus" NOT NULL DEFAULT 'PROCESSING',
  "paymentCount" INTEGER NOT NULL DEFAULT 0,
  "transferCount" INTEGER NOT NULL DEFAULT 0,
  "successfulTransferCount" INTEGER NOT NULL DEFAULT 0,
  "failedTransferCount" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payout_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payout_runs_initiatedByAdminId_fkey"
    FOREIGN KEY ("initiatedByAdminId") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "payout_transfers" (
  "id" TEXT NOT NULL,
  "payoutRunId" TEXT NOT NULL,
  "tutorProfileId" TEXT NOT NULL,
  "amount" DECIMAL(10,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'AUD',
  "status" "PayoutTransferStatus" NOT NULL DEFAULT 'PROCESSING',
  "providerTransferId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "failureReason" TEXT,
  "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payout_transfers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payout_transfers_payoutRunId_fkey"
    FOREIGN KEY ("payoutRunId") REFERENCES "payout_runs"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "payout_transfers_tutorProfileId_fkey"
    FOREIGN KEY ("tutorProfileId") REFERENCES "tutor_profiles"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "payout_transfer_items" (
  "id" TEXT NOT NULL,
  "payoutTransferId" TEXT NOT NULL,
  "paymentId" TEXT NOT NULL,
  "amount" DECIMAL(10,2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payout_transfer_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payout_transfer_items_payoutTransferId_fkey"
    FOREIGN KEY ("payoutTransferId") REFERENCES "payout_transfers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "payout_transfer_items_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "payments"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "payout_runs_status_createdAt_idx" ON "payout_runs"("status", "createdAt");
CREATE INDEX "payout_runs_initiatedByAdminId_createdAt_idx" ON "payout_runs"("initiatedByAdminId", "createdAt");
CREATE UNIQUE INDEX "payout_transfers_providerTransferId_key" ON "payout_transfers"("providerTransferId");
CREATE UNIQUE INDEX "payout_transfers_idempotencyKey_key" ON "payout_transfers"("idempotencyKey");
CREATE INDEX "payout_transfers_payoutRunId_idx" ON "payout_transfers"("payoutRunId");
CREATE INDEX "payout_transfers_tutorProfileId_createdAt_idx" ON "payout_transfers"("tutorProfileId", "createdAt");
CREATE INDEX "payout_transfers_status_idx" ON "payout_transfers"("status");
CREATE UNIQUE INDEX "payout_transfer_items_payoutTransferId_paymentId_key"
  ON "payout_transfer_items"("payoutTransferId", "paymentId");
CREATE INDEX "payout_transfer_items_paymentId_idx" ON "payout_transfer_items"("paymentId");
