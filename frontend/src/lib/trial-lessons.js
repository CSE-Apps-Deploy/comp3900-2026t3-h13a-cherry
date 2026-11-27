export const getTrialLessonAllocation = ({
  bookingCount,
  trialLessonsRemaining,
  useTrialLesson,
}) => {
  const totalBookings = Math.max(0, Number(bookingCount) || 0);
  const remainingTrials = Math.max(0, Number(trialLessonsRemaining) || 0);
  const trialLessonCount = useTrialLesson
    ? Math.min(totalBookings, remainingTrials)
    : 0;

  return {
    trialLessonCount,
    paidLessonCount: totalBookings - trialLessonCount,
  };
};

export const shouldClaimNextTrialLesson = (trialLessonsToClaim) =>
  Number(trialLessonsToClaim) > 0;
