-- CreateEnum
CREATE TYPE "SubjectRequestStatus" AS ENUM ('OPEN', 'ACCEPTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "subject_requests" (
    "id" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "subjectName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "SubjectRequestStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedSubjectId" TEXT,
    "acceptedTutorId" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subject_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "subject_requests_learnerId_status_idx" ON "subject_requests"("learnerId", "status");

-- CreateIndex
CREATE INDEX "subject_requests_status_createdAt_idx" ON "subject_requests"("status", "createdAt");

-- CreateIndex
CREATE INDEX "subject_requests_acceptedTutorId_status_idx" ON "subject_requests"("acceptedTutorId", "status");

-- AddForeignKey
ALTER TABLE "subject_requests" ADD CONSTRAINT "subject_requests_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject_requests" ADD CONSTRAINT "subject_requests_resolvedSubjectId_fkey" FOREIGN KEY ("resolvedSubjectId") REFERENCES "subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject_requests" ADD CONSTRAINT "subject_requests_acceptedTutorId_fkey" FOREIGN KEY ("acceptedTutorId") REFERENCES "tutor_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
