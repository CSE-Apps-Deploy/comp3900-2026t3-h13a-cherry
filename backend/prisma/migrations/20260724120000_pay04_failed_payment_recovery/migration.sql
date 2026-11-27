-- PAY-04: learner-owned failed-payment recovery with an append-only attempt ledger.

CREATE TYPE "PaymentAcceptanceMode" AS ENUM (
  'TUTOR_ACCEPT',
  'LEARNER_ACCEPT_TUTOR_TIME'
);

CREATE TYPE "PaymentAttemptSource" AS ENUM (
  'ACCEPTANCE',
  'RETRY',
  'LEGACY'
);

CREATE TYPE "PaymentAttemptOutcome" AS ENUM (
  'PROCESSING',
  'SUCCEEDED',
  'FAILED'
);

ALTER TABLE "payments"
  ADD COLUMN "acceptanceMode" "PaymentAcceptanceMode",
  ADD COLUMN "acceptanceAuthorizedById" TEXT,
  ADD COLUMN "acceptanceAuthorizedAt" TIMESTAMP(3),
  ADD COLUMN "acceptanceBookingVersion" INTEGER,
  ADD COLUMN "acceptanceMeetingLink" TEXT;

CREATE TABLE "payment_attempts" (
  "id" TEXT NOT NULL,
  "paymentId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "source" "PaymentAttemptSource" NOT NULL,
  "outcome" "PaymentAttemptOutcome" NOT NULL,
  "initiatedByUserId" TEXT,
  "initiatedByRole" "Role",
  "bookingVersion" INTEGER NOT NULL,
  "acceptanceMode" "PaymentAcceptanceMode" NOT NULL,
  "providerCode" TEXT,
  "safeFailureReason" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),

  CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_attempts_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "payments"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "payment_attempts_paymentId_sequence_key"
  ON "payment_attempts"("paymentId", "sequence");
CREATE INDEX "payment_attempts_paymentId_startedAt_idx"
  ON "payment_attempts"("paymentId", "startedAt");
CREATE INDEX "payment_attempts_outcome_idx"
  ON "payment_attempts"("outcome");

-- Preserve a single honest snapshot of pre-PAY-04 activity. The old schema
-- cannot reconstruct every historical attempt, so it must not fabricate them.
INSERT INTO "payment_attempts" (
  "id",
  "paymentId",
  "sequence",
  "source",
  "outcome",
  "bookingVersion",
  "acceptanceMode",
  "safeFailureReason",
  "startedAt",
  "completedAt"
)
SELECT
  'pay04_legacy_' || payment."id",
  payment."id",
  GREATEST(payment."acceptanceAttemptCount", 1),
  'LEGACY',
  CASE
    WHEN payment."status"::text IN ('PAID', 'COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED')
      THEN 'SUCCEEDED'::"PaymentAttemptOutcome"
    WHEN payment."status"::text = 'FAILED'
      THEN 'FAILED'::"PaymentAttemptOutcome"
    ELSE 'PROCESSING'::"PaymentAttemptOutcome"
  END,
  COALESCE(booking."version", 1),
  CASE
    WHEN booking."negotiationStatus"::text = 'TIME_PROPOSED_BY_TUTOR'
      THEN 'LEARNER_ACCEPT_TUTOR_TIME'::"PaymentAcceptanceMode"
    ELSE 'TUTOR_ACCEPT'::"PaymentAcceptanceMode"
  END,
  CASE
    WHEN payment."status"::text = 'FAILED'
      THEN 'Payment could not be completed. Please choose another payment method and try again.'
    ELSE NULL
  END,
  COALESCE(payment."processingStartedAt", payment."createdAt"),
  CASE
    WHEN payment."status"::text IN ('PAID', 'COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED')
      THEN COALESCE(payment."paidAt", payment."processedAt", payment."updatedAt")
    WHEN payment."status"::text = 'FAILED'
      THEN COALESCE(payment."failedAt", payment."processedAt", payment."updatedAt")
    ELSE NULL
  END
FROM "payments" AS payment
LEFT JOIN "bookings" AS booking ON booking."id" = payment."bookingId"
WHERE payment."acceptanceAttemptCount" > 0
   OR payment."status"::text IN ('PROCESSING', 'FAILED', 'PAID', 'COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED')
ON CONFLICT ("paymentId", "sequence") DO NOTHING;

UPDATE "payments"
SET "acceptanceAttemptCount" = GREATEST("acceptanceAttemptCount", 1)
WHERE "acceptanceAttemptCount" = 0
  AND "status"::text IN (
    'PROCESSING',
    'FAILED',
    'PAID',
    'COMPLETED',
    'PARTIALLY_REFUNDED',
    'REFUNDED'
  );

-- Existing failed PAY-03 acceptances remain learner-recoverable after deploy.
UPDATE "payments" AS payment
SET
  "acceptanceAttemptCount" = GREATEST(payment."acceptanceAttemptCount", 1),
  "acceptanceMode" = CASE
    WHEN booking."negotiationStatus"::text = 'TIME_PROPOSED_BY_TUTOR'
      THEN 'LEARNER_ACCEPT_TUTOR_TIME'::"PaymentAcceptanceMode"
    ELSE 'TUTOR_ACCEPT'::"PaymentAcceptanceMode"
  END,
  "acceptanceAuthorizedById" = CASE
    WHEN booking."negotiationStatus"::text = 'TIME_PROPOSED_BY_TUTOR'
      THEN booking."learnerId"
    ELSE tutor."userId"
  END,
  "acceptanceAuthorizedAt" = COALESCE(payment."failedAt", payment."processedAt", payment."updatedAt"),
  "acceptanceBookingVersion" = booking."version",
  "acceptanceMeetingLink" = booking."meetingLink",
  "failureReason" = 'Payment could not be completed. Please choose another payment method and try again.'
FROM "bookings" AS booking
JOIN "tutor_profiles" AS tutor ON tutor."id" = booking."tutorId"
WHERE payment."bookingId" = booking."id"
  AND payment."status"::text = 'FAILED'
  AND booking."status"::text = 'PENDING';
