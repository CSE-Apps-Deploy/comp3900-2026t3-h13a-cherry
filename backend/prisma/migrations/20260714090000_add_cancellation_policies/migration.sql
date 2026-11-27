ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_REFUNDED';

ALTER TABLE "tutor_profiles"
ADD COLUMN "cancellationCutoffHours" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN "lateCancellationRefundPercent" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "tutor_profiles"
ADD CONSTRAINT "tutor_profiles_cancellationCutoffHours_check"
CHECK ("cancellationCutoffHours" IN (12, 24, 48)),
ADD CONSTRAINT "tutor_profiles_lateCancellationRefundPercent_check"
CHECK ("lateCancellationRefundPercent" IN (0, 50));
