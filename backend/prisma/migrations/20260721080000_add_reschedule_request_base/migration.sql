-- The original time-negotiation migration assumed this enum and table had
-- already been created by `prisma db push`. Make the migration history
-- deployable from an empty database without changing existing installations.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RescheduleRequestStatus') THEN
    CREATE TYPE "RescheduleRequestStatus" AS ENUM (
      'PENDING',
      'ACCEPTED',
      'DECLINED',
      'CANCELLED'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "reschedule_requests" (
  "id" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "learnerId" TEXT NOT NULL,
  "tutorId" TEXT NOT NULL,
  "currentScheduledAt" TIMESTAMP(3) NOT NULL,
  "proposedScheduledAt" TIMESTAMP(3) NOT NULL,
  "reason" TEXT NOT NULL,
  "status" "RescheduleRequestStatus" NOT NULL DEFAULT 'PENDING',
  "decisionReason" TEXT,
  "decidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "reschedule_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reschedule_requests_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "reschedule_requests_learnerId_fkey"
    FOREIGN KEY ("learnerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "reschedule_requests_tutorId_fkey"
    FOREIGN KEY ("tutorId") REFERENCES "tutor_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "reschedule_requests_bookingId_idx"
  ON "reschedule_requests"("bookingId");
CREATE INDEX IF NOT EXISTS "reschedule_requests_learnerId_idx"
  ON "reschedule_requests"("learnerId");
CREATE INDEX IF NOT EXISTS "reschedule_requests_tutorId_idx"
  ON "reschedule_requests"("tutorId");
CREATE INDEX IF NOT EXISTS "reschedule_requests_status_idx"
  ON "reschedule_requests"("status");
