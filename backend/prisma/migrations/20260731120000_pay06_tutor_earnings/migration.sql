-- PAY-06: auditable tutor earning calculations and payout lifecycle timestamps.
--
-- PAY-06 does not move money. PAID and FAILED are terminal states written by
-- the payout process; this migration preserves any such existing values.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "payments"
    WHERE "payoutStatus" IS NOT NULL
      AND "payoutStatus" NOT IN ('PENDING', 'ELIGIBLE', 'PAID', 'FAILED')
  ) THEN
    RAISE EXCEPTION
      'PAY-06 migration blocked: payments contain an unknown payoutStatus';
  END IF;
END $$;

CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'ELIGIBLE', 'PAID', 'FAILED');

ALTER TABLE "payments"
  ALTER COLUMN "payoutStatus" TYPE "PayoutStatus"
    USING "payoutStatus"::"PayoutStatus",
  ADD COLUMN "payoutPendingAt" TIMESTAMP(3),
  ADD COLUMN "payoutEligibleAt" TIMESTAMP(3),
  ADD COLUMN "payoutFailedAt" TIMESTAMP(3),
  ADD COLUMN "payoutFailureReason" TEXT;

-- Historical PAY-03 rows used the contractual 15% default. Preserve every
-- explicit snapshot and fill only missing calculations.
UPDATE "payments"
SET
  "platformFeePercent" = COALESCE("platformFeePercent", 15.00),
  "platformFeeAmount" = COALESCE(
    "platformFeeAmount",
    ROUND(
      GREATEST("amount" - COALESCE("refundAmount", 0), 0)
        * COALESCE("platformFeePercent", 15.00) / 100,
      2
    )
  ),
  "tutorPayoutAmount" = COALESCE(
    "tutorPayoutAmount",
    GREATEST("amount" - COALESCE("refundAmount", 0), 0)
      - ROUND(
        GREATEST("amount" - COALESCE("refundAmount", 0), 0)
          * COALESCE("platformFeePercent", 15.00) / 100,
        2
      )
  ),
  "payoutPendingAt" = COALESCE("payoutPendingAt", "paidAt", "processedAt", "updatedAt")
WHERE "status"::text IN ('PAID', 'COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED');

UPDATE "payments" AS payment
SET
  "payoutStatus" = CASE
    WHEN payment."payoutStatus" IN ('PAID', 'FAILED') THEN payment."payoutStatus"
    WHEN COALESCE(payment."tutorPayoutAmount", 0) <= 0 THEN NULL
    WHEN booking."status"::text = 'COMPLETED' OR booking."status"::text = 'CANCELLED'
      THEN 'ELIGIBLE'::"PayoutStatus"
    ELSE 'PENDING'::"PayoutStatus"
  END,
  "payoutEligibleAt" = CASE
    WHEN payment."payoutStatus" IN ('PAID', 'FAILED') THEN payment."payoutEligibleAt"
    WHEN COALESCE(payment."tutorPayoutAmount", 0) > 0
      AND booking."status"::text = 'COMPLETED'
      THEN COALESCE(payment."payoutEligibleAt", booking."completedAt", booking."updatedAt")
    WHEN COALESCE(payment."tutorPayoutAmount", 0) > 0
      AND booking."status"::text = 'CANCELLED'
      THEN COALESCE(payment."payoutEligibleAt", booking."cancelledAt", booking."updatedAt")
    ELSE payment."payoutEligibleAt"
  END,
  "payoutFailedAt" = CASE
    WHEN payment."payoutStatus" = 'FAILED'
      THEN COALESCE(payment."payoutFailedAt", payment."updatedAt")
    ELSE payment."payoutFailedAt"
  END
FROM "bookings" AS booking
WHERE booking."id" = payment."bookingId"
  AND payment."status"::text IN ('PAID', 'COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED');

CREATE INDEX "payments_payoutStatus_idx" ON "payments"("payoutStatus");
