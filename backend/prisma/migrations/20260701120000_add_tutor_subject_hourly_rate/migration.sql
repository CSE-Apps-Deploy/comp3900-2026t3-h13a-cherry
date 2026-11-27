ALTER TABLE "tutor_subjects" ADD COLUMN "hourlyRate" DECIMAL(10,2);

UPDATE "tutor_subjects" ts
SET "hourlyRate" = tp."hourlyRate"
FROM "tutor_profiles" tp
WHERE ts."tutorId" = tp."id"
  AND ts."hourlyRate" IS NULL;

ALTER TABLE "tutor_subjects" ALTER COLUMN "hourlyRate" SET NOT NULL;