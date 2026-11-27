// SCH-03: booking slot rules.
// Lessons must start on a :00 / :30 boundary, and durations must be 30-minute
// multiples from 30 to 480 minutes. These pure helpers back the server-side
// validation that rejects off-grid booking requests (AC4).

const SLOT_INTERVAL_MINUTES = 30;
const MIN_DURATION_MINUTES = 30;
const MAX_DURATION_MINUTES = 480;

// "09:30" -> 570 (minutes since midnight). Returns NaN for malformed input.
function timeToMinutes(value) {
  const [rawHour, rawMinute] = String(value ?? '').split(':');
  const hour = Number.parseInt(rawHour, 10);
  const minute = Number.parseInt(rawMinute, 10);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return Number.NaN;
  return hour * 60 + minute;
}

// A start is valid only if it lands on the interval boundary (:00 or :30).
function isAlignedMinutes(totalMinutes) {
  return Number.isInteger(totalMinutes) && totalMinutes % SLOT_INTERVAL_MINUTES === 0;
}

// A duration is valid only if it is a 30-minute multiple within [30, 480].
function isValidDurationMinutes(duration) {
  return (
    Number.isInteger(duration) &&
    duration >= MIN_DURATION_MINUTES &&
    duration <= MAX_DURATION_MINUTES &&
    duration % SLOT_INTERVAL_MINUTES === 0
  );
}

module.exports = {
  SLOT_INTERVAL_MINUTES,
  MIN_DURATION_MINUTES,
  MAX_DURATION_MINUTES,
  timeToMinutes,
  isAlignedMinutes,
  isValidDurationMinutes,
};
