CREATE TYPE "BookingNegotiationStatus" AS ENUM (
  'NONE',
  'TIME_PROPOSED_BY_TUTOR',
  'TIME_PROPOSED_BY_LEARNER'
);

CREATE TYPE "BookingProposalActor" AS ENUM ('LEARNER', 'TUTOR');

ALTER TYPE "RescheduleRequestStatus" ADD VALUE 'COUNTERED';

ALTER TABLE "bookings"
ADD COLUMN "negotiationStatus" "BookingNegotiationStatus" NOT NULL DEFAULT 'NONE';

ALTER TABLE "reschedule_requests"
ADD COLUMN "proposedBy" "BookingProposalActor" NOT NULL DEFAULT 'LEARNER';
