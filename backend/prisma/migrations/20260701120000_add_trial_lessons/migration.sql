ALTER TABLE "tutor_profiles"
ADD COLUMN "trialLessonLimit" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "bookings"
ADD COLUMN "isTrialLesson" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "tutor_profiles"
ADD CONSTRAINT "tutor_profiles_trialLessonLimit_check"
CHECK ("trialLessonLimit" >= 0);

CREATE INDEX "bookings_trial_lesson_eligibility_idx"
ON "bookings" ("learnerId", "tutorId", "isTrialLesson", "status");
