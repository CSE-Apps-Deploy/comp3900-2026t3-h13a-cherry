import { describe, expect, it } from 'vitest';

import {
  isValidTimezone,
  getUserTimezone,
  getDeviceTimezone,
  needsTimezoneConfirmation,
  getTimezoneName,
  resolveLocalTime,
} from '../formatters.js';

describe('isValidTimezone', () => {
  it('accepts valid IANA timezones', () => {
    expect(isValidTimezone('Australia/Sydney')).toBe(true);
    expect(isValidTimezone('America/Los_Angeles')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
  });

  it('rejects missing or invalid values', () => {
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone(null)).toBe(false);
    expect(isValidTimezone(undefined)).toBe(false);
    expect(isValidTimezone('Not/AZone')).toBe(false);
    expect(isValidTimezone(123)).toBe(false);
  });
});

describe('getUserTimezone', () => {
  it('returns the saved timezone when valid', () => {
    expect(getUserTimezone({ timezone: 'Australia/Sydney' })).toBe('Australia/Sydney');
  });

  it('supports the timeZone alias', () => {
    expect(getUserTimezone({ timeZone: 'Asia/Tokyo' })).toBe('Asia/Tokyo');
  });

  it('falls back to UTC (not the device tz) when missing or invalid', () => {
    expect(getUserTimezone(null)).toBe('UTC');
    expect(getUserTimezone({})).toBe('UTC');
    expect(getUserTimezone({ timezone: '' })).toBe('UTC');
    expect(getUserTimezone({ timezone: 'Not/AZone' })).toBe('UTC');
  });

  it('honours a custom fallback', () => {
    expect(getUserTimezone({ timezone: null }, 'Australia/Sydney')).toBe('Australia/Sydney');
  });
});

describe('needsTimezoneConfirmation', () => {
  it('is false when the user has a valid saved timezone', () => {
    expect(needsTimezoneConfirmation({ timezone: 'Australia/Sydney' })).toBe(false);
  });

  it('is true when the timezone is missing or invalid', () => {
    expect(needsTimezoneConfirmation({ timezone: null })).toBe(true);
    expect(needsTimezoneConfirmation({ timezone: '' })).toBe(true);
    expect(needsTimezoneConfirmation({ timezone: 'Not/AZone' })).toBe(true);
  });

  it('is false when there is no user', () => {
    expect(needsTimezoneConfirmation(null)).toBe(false);
    expect(needsTimezoneConfirmation(undefined)).toBe(false);
  });
});

describe('getDeviceTimezone', () => {
  it('returns a string timezone from the runtime', () => {
    expect(typeof getDeviceTimezone()).toBe('string');
  });
});

describe('getTimezoneName label style', () => {
  const instant = '2026-06-25T00:00:00Z';

  it('labels the UTC fallback as "UTC", not GMT+0', () => {
    expect(getTimezoneName(instant, 'UTC')).toBe('UTC');
    expect(getTimezoneName(instant, 'Etc/UTC')).toBe('UTC');
  });

  it('shows the place name with its GMT offset', () => {
    expect(getTimezoneName(instant, 'Australia/Sydney')).toBe('Sydney (GMT+10)');
    expect(getTimezoneName(instant, 'America/Los_Angeles')).toBe('Los Angeles (GMT-7)');
    expect(getTimezoneName(instant, 'Asia/Hong_Kong')).toBe('Hong Kong (GMT+8)');
  });

  it('shows the offset alone for an Etc zone, which names an offset not a place', () => {
    expect(getTimezoneName(instant, 'Etc/GMT-10')).toMatch(/^GMT[+-]\d/);
  });

  it('returns empty string when no timezone is given', () => {
    expect(getTimezoneName(instant, null)).toBe('');
  });
});

describe('resolveLocalTime (SCH-02)', () => {
  it('resolves an ordinary time away from any transition uniquely', () => {
    const result = resolveLocalTime(
      { year: 2026, month: 6, day: 15, hour: 9, minute: 30 },
      'Australia/Sydney'
    );
    expect(result.type).toBe('unique');
    expect(result.instants).toHaveLength(1);
  });

  it('flags a Sydney spring-forward gap (clocks jump 2am -> 3am)', () => {
    const result = resolveLocalTime(
      { year: 2026, month: 10, day: 4, hour: 2, minute: 30 },
      'Australia/Sydney'
    );
    expect(result.type).toBe('gap');
    expect(result.instants).toHaveLength(0);
  });

  it('disambiguates a Sydney fall-back overlap (clocks repeat 2am)', () => {
    const result = resolveLocalTime(
      { year: 2026, month: 4, day: 5, hour: 2, minute: 30 },
      'Australia/Sydney'
    );
    expect(result.type).toBe('ambiguous');
    expect(result.instants).toHaveLength(2);
    expect(result.instants[0].getTime()).toBeLessThan(result.instants[1].getTime());
    expect(getTimezoneName(result.instants[0], 'Australia/Sydney')).toBe('Sydney (GMT+11)');
    expect(getTimezoneName(result.instants[1], 'Australia/Sydney')).toBe('Sydney (GMT+10)');
  });

  it('flags a Los Angeles spring-forward gap (clocks jump 2am -> 3am)', () => {
    const result = resolveLocalTime(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
      'America/Los_Angeles'
    );
    expect(result.type).toBe('gap');
    expect(result.instants).toHaveLength(0);
  });

  it('disambiguates a Los Angeles fall-back overlap (clocks repeat 1am)', () => {
    const result = resolveLocalTime(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
      'America/Los_Angeles'
    );
    expect(result.type).toBe('ambiguous');
    expect(result.instants).toHaveLength(2);
    expect(getTimezoneName(result.instants[0], 'America/Los_Angeles')).toBe('Los Angeles (GMT-7)');
    expect(getTimezoneName(result.instants[1], 'America/Los_Angeles')).toBe('Los Angeles (GMT-8)');
  });

  it('UTC never has gaps or ambiguous times', () => {
    const springForwardDate = resolveLocalTime(
      { year: 2026, month: 10, day: 4, hour: 2, minute: 30 },
      'UTC'
    );
    const fallBackDate = resolveLocalTime(
      { year: 2026, month: 4, day: 5, hour: 2, minute: 30 },
      'UTC'
    );
    expect(springForwardDate.type).toBe('unique');
    expect(fallBackDate.type).toBe('unique');
  });
});
