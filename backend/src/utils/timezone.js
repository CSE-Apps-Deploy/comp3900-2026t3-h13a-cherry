const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function isValidTimezone(timezone) {
  if (!timezone || typeof timezone !== 'string') return false;

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function normalizeTimezone(timezone, fallback = 'UTC') {
  return isValidTimezone(timezone) ? timezone : fallback;
}

function getZonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'long',
  }).formatToParts(date);

  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour) % 24,
    minute: Number(lookup.minute),
    second: Number(lookup.second),
    dayOfWeek: WEEKDAYS.indexOf(lookup.weekday),
  };
}

function getTimezoneOffset(date, timezone) {
  const parts = getZonedParts(date, timezone);
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return localAsUtc - date.getTime();
}

function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timezone) {
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let utc = localAsUtc - getTimezoneOffset(new Date(localAsUtc), timezone);
  utc = localAsUtc - getTimezoneOffset(new Date(utc), timezone);
  return new Date(utc);
}

const ONE_HOUR_MS = 60 * 60 * 1000;
// Wider than any real DST shift, narrower than the gap between transitions.
const PROBE_WINDOW_MS = 25 * ONE_HOUR_MS;

/**
 * Resolve a local wall-clock time to the UTC instant(s) it actually refers to.
 * Unlike zonedTimeToUtc, this does not guess through a DST transition - it detects when
 * the local time was skipped (spring-forward gap) or occurs twice (fall-back overlap).
 * @param {{year:number, month:number, day:number, hour?:number, minute?:number, second?:number}} parts
 * @param {string} timezone - IANA timezone
 * @returns {{type: 'unique'|'ambiguous'|'gap', instants: Date[]}} instants sorted ascending;
 *   empty for a gap, one for a unique time, two for an ambiguous (repeated) time.
 */
function resolveLocalTime({ year, month, day, hour = 0, minute = 0, second = 0 }, timezone) {
  const naiveUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstGuessMs = naiveUtcMs - getTimezoneOffset(new Date(naiveUtcMs), timezone);

  const offsetBefore = getTimezoneOffset(new Date(firstGuessMs - PROBE_WINDOW_MS), timezone);
  const offsetAfter = getTimezoneOffset(new Date(firstGuessMs + PROBE_WINDOW_MS), timezone);

  const matches = [...new Set([offsetBefore, offsetAfter])]
    .map((offset) => naiveUtcMs - offset)
    .filter((candidateMs) => {
      const parts = getZonedParts(new Date(candidateMs), timezone);
      return (
        parts.year === year &&
        parts.month === month &&
        parts.day === day &&
        parts.hour === hour &&
        parts.minute === minute
      );
    })
    .sort((a, b) => a - b);

  if (matches.length === 0) return { type: 'gap', instants: [] };
  return {
    type: matches.length > 1 ? 'ambiguous' : 'unique',
    instants: matches.map((ms) => new Date(ms)),
  };
}

function addDaysToLocalDate({ year, month, day }, days) {
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function getCurrentWeekMondayInTimezone(timezone) {
  const parts = getZonedParts(new Date(), timezone);
  const daysFromMonday = (parts.dayOfWeek + 6) % 7;
  return addDaysToLocalDate(parts, -daysFromMonday);
}

function timeToHour(value, fallback = 0) {
  const hour = Number.parseInt(String(value || '').slice(0, 2), 10);
  return Number.isNaN(hour) ? fallback : hour;
}

function formatHour(hour) {
  return `${String(hour).padStart(2, '0')}:00`;
}

function timeToMinutes(value) {
  const [rawHour, rawMinute] = String(value || '00:00').split(':');
  const hour = Number.parseInt(rawHour, 10);
  const minute = Number.parseInt(rawMinute, 10);
  return (Number.isNaN(hour) ? 0 : hour) * 60 + (Number.isNaN(minute) ? 0 : minute);
}

/**
 * Format a time for display in the given timezone.
 * @param {Date} date - Date object
 * @param {string} timezone - IANA timezone string (e.g., 'Australia/Sydney')
 * @returns {string} Formatted time string
 */
function formatInTimezone(date, timezone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

/**
 * Get the time in a specific timezone (HH:MM format).
 * @param {Date} date - Date object
 * @param {string} timezone - Timezone
 * @returns {string} 'HH:MM' format
 */
function getTimeInTimezone(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const hour = formatter.formatToParts(date).find((part) => part.type === 'hour')?.value || '00';
  const minute = formatter.formatToParts(date).find((part) => part.type === 'minute')?.value || '00';
  return `${String(Number(hour) % 24).padStart(2, '0')}:${minute}`;
}

/**
 * Get the day of week in a specific timezone.
 * @param {Date} date - Date object
 * @param {string} timezone - Timezone
 * @returns {number} 0-6 (Sunday-Saturday)
 */
function getDayOfWeekInTimezone(date, timezone) {
  return getZonedParts(date, timezone).dayOfWeek;
}

/**
 * Convert a tutor's availability slots, adding display labels for the student side.
 * @param {Array} slots - Tutor's time slots [{dayOfWeek, startTime, endTime, timezone}]
 * @param {string} tutorTimezone - Tutor's timezone
 * @returns {Array} Time slots with display labels added
 */
function convertAvailabilityForStudent(slots, tutorTimezone, requesterTimezone = tutorTimezone) {
  const sourceTimezone = normalizeTimezone(tutorTimezone);
  const targetTimezone = normalizeTimezone(requesterTimezone, sourceTimezone);
  const weekMonday = getCurrentWeekMondayInTimezone(sourceTimezone);
  const convertedCells = new Set();

  slots.forEach((slot) => {
    const dayOffset = Number(slot.dayOfWeek) === 0 ? 6 : Number(slot.dayOfWeek) - 1;
    const localDate = addDaysToLocalDate(weekMonday, dayOffset);
    const startMinute = timeToMinutes(slot.startTime);
    const endMinute = timeToMinutes(slot.endTime);

    for (let minute = startMinute; minute < endMinute; minute += 15) {
      const { instants } = resolveLocalTime({
        ...localDate, hour: Math.floor(minute / 60), minute: minute % 60,
      }, sourceTimezone);
      instants.forEach((utcDate) => {
        const targetParts = getZonedParts(utcDate, targetTimezone);
        convertedCells.add(`${targetParts.dayOfWeek}-${targetParts.hour * 60 + targetParts.minute}`);
      });
    }
  });

  const formatMinute = (minute) =>
    `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

  return WEEKDAYS.flatMap((_, dayOfWeek) => {
    const minutes = Array.from({ length: 96 }, (__, index) => index * 15).filter((minute) =>
      convertedCells.has(`${dayOfWeek}-${minute}`)
    );
    if (!minutes.length) return [];

    const groups = [];
    let start = minutes[0];
    let prev = minutes[0];

    for (let index = 1; index < minutes.length; index += 1) {
      const current = minutes[index];
      if (current === prev + 15) {
        prev = current;
        continue;
      }

      groups.push({ dayOfWeek, startTime: formatMinute(start), endTime: formatMinute(prev + 15) });
      start = current;
      prev = current;
    }

    groups.push({ dayOfWeek, startTime: formatMinute(start), endTime: formatMinute(prev + 15) });
    return groups.map((item) => ({
      ...item,
      timezone: targetTimezone,
      sourceTimezone,
      displayTimezone: targetTimezone,
      displayText: `${item.startTime}-${item.endTime} (${targetTimezone})`,
    }));
  });
}

/**
 * Validate whether a booking time falls within the tutor's availability.
 * @param {Date} bookingDatetime - Booking time (UTC)
 * @param {string} tutorTimezone - Tutor's timezone
 * @param {Array} tutorAvailableSlots - Tutor's available time slots
 * @returns {object} { isValid: boolean, message: string }
 */
function validateBookingTime(bookingDatetime, tutorTimezone, tutorAvailableSlots, duration = 60) {
  // Get the time in the tutor's timezone
  const tutorTime = getTimeInTimezone(bookingDatetime, tutorTimezone);
  const tutorDay = getDayOfWeekInTimezone(bookingDatetime, tutorTimezone);
  const bookingEnd = new Date(bookingDatetime.getTime() + Number(duration || 60) * 60 * 1000);
  const tutorEndTime = getTimeInTimezone(bookingEnd, tutorTimezone);
  const tutorEndDay = getDayOfWeekInTimezone(bookingEnd, tutorTimezone);
  const startMinutes = timeToMinutes(tutorTime);
  const endMinutes = timeToMinutes(tutorEndTime);
  const endsOnAnotherDay = tutorEndDay !== tutorDay;
  const crossesMidnight = endsOnAnotherDay && endMinutes > 0;

  // Find whether there are any availability slots on that day of week
  const daySlots = tutorAvailableSlots.filter(slot => slot.dayOfWeek === tutorDay);

  if (daySlots.length === 0) {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return {
      isValid: false,
      message: `Tutor has no availability on ${days[tutorDay]}`
    };
  }

  const coveredBySlot = (slots, from, to) =>
    slots.some(slot => timeToMinutes(slot.startTime) <= from && timeToMinutes(slot.endTime) >= to);

  // A lesson running past midnight is checked in two parts, one against each day's slots
  const isInSlot = crossesMidnight
    ? coveredBySlot(daySlots, startMinutes, 24 * 60) &&
      coveredBySlot(tutorAvailableSlots.filter(slot => slot.dayOfWeek === tutorEndDay), 0, endMinutes)
    : coveredBySlot(daySlots, startMinutes, endsOnAnotherDay ? 24 * 60 : endMinutes);

  if (!isInSlot) {
    return {
      isValid: false,
      message: `Booking time ${tutorTime}-${tutorEndTime} is outside tutor's availability. Available slots: ${daySlots.map(s => `${s.startTime}-${s.endTime}`).join(', ')}`
    };
  }

  return {
    isValid: true,
    message: 'Booking time is valid',
    tutorLocalTime: tutorTime
  };
}

/**
 * Format a booking for display in the given timezone.
 * @param {Date} scheduledAt - Booking time (UTC)
 * @param {string} timezone - Timezone used for display
 * @returns {object} { dateStr, timeStr, display }
 */
function formatBookingInTimezone(scheduledAt, timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });

  const display = formatter.format(scheduledAt);
  const [dateStr, timeStr] = display.split(', ');

  return {
    dateStr,
    timeStr,
    display: `${dateStr} at ${timeStr} (${timezone})`,
    timezone
  };
}

/**
 * Format a lesson instant for a notification in a specific recipient's timezone,
 * always including a timezone label (SCH-01 / AC5). Falls back to UTC for a
 * missing or invalid timezone.
 * @param {Date|string} instant - The lesson time (a UTC instant)
 * @param {string} timezone - The recipient's IANA timezone
 * @returns {string} e.g. "26 Jun 2026, 9:30 am AEST (GMT+10)" or "... UTC"
 */
function formatLessonTimeForUser(instant, timezone) {
  const tz = normalizeTimezone(timezone, 'UTC');
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return '';

  const datePart = new Intl.DateTimeFormat('en-AU', {
    timeZone: tz,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);

  let label = 'UTC';
  if (tz !== 'UTC' && tz !== 'Etc/UTC') {
    const offset =
      new Intl.DateTimeFormat('en-AU', { timeZone: tz, timeZoneName: 'shortOffset' })
        .formatToParts(date)
        .find((part) => part.type === 'timeZoneName')?.value || tz;
    const city = tz.startsWith('Etc/') ? '' : (tz.split('/').pop() || '').replace(/_/g, ' ');
    label = city ? `${city} (${offset})` : offset;
  }

  return `${datePart} ${label}`;
}

module.exports = {
  isValidTimezone,
  normalizeTimezone,
  formatInTimezone,
  getTimeInTimezone,
  getDayOfWeekInTimezone,
  convertAvailabilityForStudent,
  validateBookingTime,
  formatBookingInTimezone,
  formatLessonTimeForUser,
  resolveLocalTime,
};
