-- PAY-03: charge each normal booking only after its final acceptance is requested.
-- Older development environments used `prisma db push`, so column additions are
-- deliberately defensive while the state-changing backfill remains explicit.

ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'PAID';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'CREDITED';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_REFUNDED';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "stripeCustomerId" TEXT,
  ADD COLUMN IF NOT EXISTS "stripeDefaultPaymentMethodId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "users_stripeCustomerId_key"
  ON "users"("stripeCustomerId");

ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "stripeCustomerId" TEXT,
  ADD COLUMN IF NOT EXISTS "stripePaymentMethodId" TEXT,
  ADD COLUMN IF NOT EXISTS "stripeSetupIntentId" TEXT,
  ADD COLUMN IF NOT EXISTS "stripePaymentIntentId" TEXT,
  ADD COLUMN IF NOT EXISTS "stripeIdempotencyKey" TEXT,
  ADD COLUMN IF NOT EXISTS "acceptanceAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "processingStartedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "paymentAttemptToken" TEXT,
  ADD COLUMN IF NOT EXISTS "platformFeePercent" DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "platformFeeAmount" DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "tutorPayoutAmount" DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "payoutStatus" TEXT,
  ADD COLUMN IF NOT EXISTS "payoutAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "processedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "paidAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "failedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "failureReason" TEXT,
  ADD COLUMN IF NOT EXISTS "creditApplied" DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "refundAmount" DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "refundedAt" TIMESTAMP(3);

ALTER TABLE "payments" ALTER COLUMN "payoutStatus" DROP DEFAULT;

UPDATE "payments"
SET "acceptanceAttemptCount" = 0
WHERE "acceptanceAttemptCount" IS NULL;

ALTER TABLE "payments"
  ALTER COLUMN "acceptanceAttemptCount" SET DEFAULT 0,
  ALTER COLUMN "acceptanceAttemptCount" SET NOT NULL;

-- A legacy PROCESSING payment may still settle at Stripe. Deployment must stop
-- until an operator reconciles it instead of risking a replacement charge.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "payments"
    WHERE "status"::text = 'PROCESSING'
  ) THEN
    RAISE EXCEPTION
      'PAY-03 migration blocked: reconcile legacy PROCESSING payments in Stripe and mark them PAID or FAILED before retrying';
  END IF;
END $$;

-- Trial rows with commercial data are inconsistent and require investigation.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "payments" AS payment
    JOIN "bookings" AS booking ON booking."id" = payment."bookingId"
    WHERE booking."isTrialLesson" = true
      AND payment."amount" <> 0
  ) THEN
    RAISE EXCEPTION
      'PAY-03 migration blocked: a free trial has a non-zero payment record';
  END IF;
END $$;

DELETE FROM "payments" AS payment
USING "bookings" AS booking
WHERE payment."bookingId" = booking."id"
  AND booking."isTrialLesson" = true
  AND payment."amount" = 0;

WITH reset_bookings AS (
  UPDATE "bookings" AS booking
  SET
    "status" = 'PENDING',
    "version" = booking."version" + 1,
    "updatedAt" = CURRENT_TIMESTAMP
  FROM "payments" AS payment
  WHERE payment."bookingId" = booking."id"
    AND booking."isTrialLesson" = false
    AND booking."status"::text = 'ACCEPTED'
    AND payment."status"::text IN ('PENDING', 'FAILED')
  RETURNING booking."id"
)
INSERT INTO "booking_status_history" ("id", "bookingId", "status", "reason", "createdAt")
SELECT
  'pay03_backfill_pending_' || "id",
  "id",
  'PENDING',
  'PAY-03 backfill: payment must succeed before acceptance',
  CURRENT_TIMESTAMP
FROM reset_bookings
ON CONFLICT ("id") DO NOTHING;

UPDATE "payments"
SET
  "stripeIdempotencyKey" = 'pay03_accept_' || "id",
  "paymentAttemptToken" = NULL,
  "processingStartedAt" = NULL,
  "platformFeePercent" = NULL,
  "platformFeeAmount" = NULL,
  "tutorPayoutAmount" = NULL,
  "payoutStatus" = NULL,
  "payoutAt" = NULL,
  "refundAmount" = NULL,
  "refundedAt" = NULL
WHERE "status"::text NOT IN ('PAID', 'COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED');

-- Historical paid rows no longer need their original request key. Re-keying
-- them by payment ID removes legacy recurring-series duplicates safely.
UPDATE "payments"
SET "stripeIdempotencyKey" = 'pay03_accept_' || "id"
WHERE "stripeIdempotencyKey" IS NULL
   OR EXISTS (
     SELECT 1
     FROM "payments" AS duplicate
     WHERE duplicate."stripeIdempotencyKey" = "payments"."stripeIdempotencyKey"
       AND duplicate."id" <> "payments"."id"
   );

CREATE UNIQUE INDEX IF NOT EXISTS "payments_stripeIdempotencyKey_key"
  ON "payments"("stripeIdempotencyKey");
CREATE INDEX IF NOT EXISTS "payments_stripePaymentIntentId_idx"
  ON "payments"("stripePaymentIntentId");
CREATE INDEX IF NOT EXISTS "payments_stripeSetupIntentId_idx"
  ON "payments"("stripeSetupIntentId");

CREATE TABLE IF NOT EXISTS "stripe_webhook_events" (
  "eventId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "objectId" TEXT,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stripe_webhook_events_pkey" PRIMARY KEY ("eventId")
);

CREATE INDEX IF NOT EXISTS "stripe_webhook_events_type_idx"
  ON "stripe_webhook_events"("type");
CREATE INDEX IF NOT EXISTS "stripe_webhook_events_objectId_idx"
  ON "stripe_webhook_events"("objectId");
