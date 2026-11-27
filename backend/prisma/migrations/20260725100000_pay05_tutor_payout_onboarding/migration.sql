-- PAY-05: tutor-owned connected payout accounts and provider readiness state.
--
-- Onboarding and readiness only. This migration deliberately does NOT change how
-- money moves: charges still settle to the platform account exactly as PAY-03
-- left them, and no transfer or application-fee column is introduced here.
--
-- The table stores provider identifiers plus booleans and counts derived from the
-- provider's account object. It never stores bank credentials, identity documents,
-- or the requirement field names themselves -- those name specific identity
-- documents, so only their counts are kept.

CREATE TYPE "PayoutAccountStatus" AS ENUM (
  'NOT_STARTED',
  'ONBOARDING_INCOMPLETE',
  'PENDING_VERIFICATION',
  'RESTRICTED',
  'READY'
);

CREATE TABLE "tutor_payout_accounts" (
  "id" TEXT NOT NULL,
  "tutorProfileId" TEXT NOT NULL,
  "stripeAccountId" TEXT NOT NULL,
  "country" TEXT NOT NULL DEFAULT 'AU',
  "defaultCurrency" TEXT,
  "status" "PayoutAccountStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "isPayoutReady" BOOLEAN NOT NULL DEFAULT false,
  "detailsSubmitted" BOOLEAN NOT NULL DEFAULT false,
  "chargesEnabled" BOOLEAN NOT NULL DEFAULT false,
  "payoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
  "transfersCapability" TEXT,
  "disabledReason" TEXT,
  "currentlyDueCount" INTEGER NOT NULL DEFAULT 0,
  "pastDueCount" INTEGER NOT NULL DEFAULT 0,
  "eventuallyDueCount" INTEGER NOT NULL DEFAULT 0,
  "pendingVerificationCount" INTEGER NOT NULL DEFAULT 0,
  "requirementsDueAt" TIMESTAMP(3),
  "onboardingStartedAt" TIMESTAMP(3),
  "onboardingCompletedAt" TIMESTAMP(3),
  "lastSyncedAt" TIMESTAMP(3),
  "lastEventCreatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "tutor_payout_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tutor_payout_accounts_tutorProfileId_fkey"
    FOREIGN KEY ("tutorProfileId") REFERENCES "tutor_profiles"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- One connected account per tutor. The unique account id is how account.updated
-- webhooks are mapped back to a tutor without trusting mutable event metadata.
CREATE UNIQUE INDEX "tutor_payout_accounts_tutorProfileId_key"
  ON "tutor_payout_accounts"("tutorProfileId");
CREATE UNIQUE INDEX "tutor_payout_accounts_stripeAccountId_key"
  ON "tutor_payout_accounts"("stripeAccountId");
CREATE INDEX "tutor_payout_accounts_status_idx"
  ON "tutor_payout_accounts"("status");
CREATE INDEX "tutor_payout_accounts_isPayoutReady_idx"
  ON "tutor_payout_accounts"("isPayoutReady");

-- No backfill. Tutors onboarded before PAY-05 correctly have no row, which the
-- application reads as NOT_STARTED; fabricating rows would claim a provider
-- account id that does not exist.
