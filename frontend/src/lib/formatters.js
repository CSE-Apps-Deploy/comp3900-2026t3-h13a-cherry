const LOCALE = 'en-AU';
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const SHORT_DATE_TIME_FORMAT = {
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
};

const DATE_TIME_WITH_YEAR_FORMAT = {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
};

const MONTH_DAY_FORMAT = {
  month: 'short',
  day: 'numeric',
};

function formatDateValue(value, options, timezone = null) {
  if (!value) return '-';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';

  const formatOptions = { ...options };
  if (timezone) {
    formatOptions.timeZone = timezone;
  }

  try {
    return new Intl.DateTimeFormat(LOCALE, formatOptions).format(date);
  } catch {
    return new Intl.DateTimeFormat(LOCALE, options).format(date);
  }
}

function getTimezoneCity(timezone) {
  if (timezone.startsWith('Etc/')) return '';
  return (timezone.split('/').pop() || '').replace(/_/g, ' ');
}

function readTimeZoneNamePart(date, timezone, style) {
  try {
    return (
      new Intl.DateTimeFormat('en-AU', { timeZone: timezone, timeZoneName: style })
        .formatToParts(date)
        .find((part) => part.type === 'timeZoneName')?.value || ''
    );
  } catch {
    return '';
  }
}

export function getTimezoneName(value = new Date(), timezone = null, style = 'shortOffset') {
  if (!timezone) return '';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  // AC4: the fallback zone must always read as "UTC", not the "GMT+0" offset form.
  if (timezone === 'UTC' || timezone === 'Etc/UTC') return 'UTC';

  if (style !== 'shortOffset') return readTimeZoneNamePart(date, timezone, style);

  const offset = readTimeZoneNamePart(date, timezone, 'shortOffset');
  if (!offset) return '';

  const city = getTimezoneCity(timezone);
  return city ? `${city} (${offset})` : offset;
}

export function appendTimezoneName(label, value, timezone = null) {
  const timezoneName = getTimezoneName(value, timezone);
  return timezoneName ? `${label} ${timezoneName}` : label;
}

export function isValidTimezone(timezone) {
  if (!timezone || typeof timezone !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function getDeviceTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

// Returns the user's saved timezone when it is valid, otherwise a safe fallback (UTC).
// We deliberately do NOT fall back to the device timezone: AC4 requires the user to
// confirm a timezone rather than silently using the device's.
export function getUserTimezone(user, fallback = 'UTC') {
  const saved = (user?.timezone || user?.timeZone || '').trim();
  return isValidTimezone(saved) ? saved : fallback;
}

// True when the user has no usable saved timezone, so we should prompt them to confirm one.
export function needsTimezoneConfirmation(user) {
  if (!user) return false;
  const saved = (user?.timezone || user?.timeZone || '').trim();
  return !isValidTimezone(saved);
}

export function getDatePartsInTimezone(value, timezone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'long',
    hour12: false,
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
  const parts = getDatePartsInTimezone(date, timezone);
  if (!parts) return 0;

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

export function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timezone) {
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let utc = localAsUtc - getTimezoneOffset(new Date(localAsUtc), timezone);
  utc = localAsUtc - getTimezoneOffset(new Date(utc), timezone);
  return new Date(utc);
}

const ONE_HOUR_MS = 60 * 60 * 1000;
// Wider than any real DST shift, narrower than the gap between transitions.
const PROBE_WINDOW_MS = 25 * ONE_HOUR_MS;

/**
 * Resolve a local wall-clock time to its real UTC instant(s), detecting DST gaps and overlaps.
 * @param {{year:number, month:number, day:number, hour?:number, minute?:number, second?:number}} parts
 * @param {string} timezone - IANA timezone
 * @returns {{type: 'unique'|'ambiguous'|'gap', instants: Date[]}}
 */
export function resolveLocalTime({ year, month, day, hour = 0, minute = 0, second = 0 }, timezone) {
  const naiveUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstGuessMs = naiveUtcMs - getTimezoneOffset(new Date(naiveUtcMs), timezone);

  const offsetBefore = getTimezoneOffset(new Date(firstGuessMs - PROBE_WINDOW_MS), timezone);
  const offsetAfter = getTimezoneOffset(new Date(firstGuessMs + PROBE_WINDOW_MS), timezone);

  const matches = [...new Set([offsetBefore, offsetAfter])]
    .map((offset) => naiveUtcMs - offset)
    .filter((candidateMs) => {
      const parts = getDatePartsInTimezone(candidateMs, timezone);
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

export function formatShortDateTime(value, timezone = null) {
  return appendTimezoneName(formatDateValue(value, SHORT_DATE_TIME_FORMAT, timezone), value, timezone);
}

export function formatDateTimeWithYear(value, timezone = null) {
  return appendTimezoneName(formatDateValue(value, DATE_TIME_WITH_YEAR_FORMAT, timezone), value, timezone);
}

export function formatMonthDay(value, timezone = null) {
  return formatDateValue(value, MONTH_DAY_FORMAT, timezone);
}

/**
 * Format a date-time using the given timezone.
 * @param {Date|string} value - Date
 * @param {string} timezone - IANA timezone (e.g., 'Australia/Sydney')
 * @returns {string} Formatted date-time
 */
export function formatDateInTimezone(value, timezone) {
  if (!value || !timezone) return '-';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';

  const options = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  };

  return appendTimezoneName(new Intl.DateTimeFormat(LOCALE, options).format(date), date, timezone);
}

/**
 * Get the hour part of a time in a specific timezone.
 * @param {Date|string} value - Date
 * @param {string} timezone - IANA timezone
 * @returns {number} Hour from 0-23
 */
export function getHourInTimezone(value, timezone) {
  if (!value || !timezone) return 0;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 0;

  const options = {
    hour: '2-digit',
    hour12: false,
    timeZone: timezone,
  };

  const formatter = new Intl.DateTimeFormat('en-US', options);
  const parts = formatter.formatToParts(date);
  const hourPart = parts.find(p => p.type === 'hour');
  return parseInt(hourPart?.value || 0, 10) % 24;
}

/**
 * Get the day of week in a specific timezone.
 * @param {Date|string} value - Date
 * @param {string} timezone - IANA timezone
 * @returns {number} 0-6 (Sunday-Saturday)
 */
export function getDayOfWeekInTimezone(value, timezone) {
  if (!value || !timezone) return 0;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 0;

  return getDatePartsInTimezone(date, timezone)?.dayOfWeek ?? 0;
}

export function formatCurrency(amount, currency = 'AUD') {
  const value = Number(amount || 0);
  if (Number.isNaN(value)) return '$0';

  try {
    return new Intl.NumberFormat(LOCALE, {
      style: 'currency',
      currency: currency || 'AUD',
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `$${value}`;
  }
}

export function formatTimeAgo(value) {
  const timestamp = typeof value === 'string' ? new Date(value) : value;
  if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
    return 'Just now';
  }

  const diff = new Date() - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

export function formatDuration(minutes) {
  const value = Number(minutes || 0);
  if (!value) return '0 mins';
  if (value % 60 === 0) return `${value / 60} hr`;
  return `${value} mins`;
}
