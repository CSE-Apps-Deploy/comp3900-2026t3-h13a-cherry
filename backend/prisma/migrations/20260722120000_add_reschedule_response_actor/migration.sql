ALTER TABLE "reschedule_requests"
ADD COLUMN "decidedById" TEXT;

ALTER TABLE "reschedule_requests"
ADD CONSTRAINT "reschedule_requests_decidedById_fkey"
FOREIGN KEY ("decidedById") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "reschedule_requests_decidedById_idx"
ON "reschedule_requests"("decidedById");
