const {
  formatLessonTimeForUser,
  isValidTimezone,
  normalizeTimezone,
  resolveLocalTime,
  convertAvailabilityForStudent,
  validateBookingTime,
} = require('../../src/utils/timezone');

describe('isValidTimezone / normalizeTimezone', () => {
  it('validates IANA timezones', () => {
    expect(isValidTimezone('Australia/Sydney')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Bad/Zone')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone(null)).toBe(false);
  });

  it('normalizes invalid/missing zones to the fallback', () => {
    expect(normalizeTimezone('Australia/Sydney')).toBe('Australia/Sydney');
    expect(normalizeTimezone('Bad/Zone')).toBe('UTC');
    expect(normalizeTimezone(null)).toBe('UTC');
  });
});

describe('formatLessonTimeForUser (AC5)', () => {
  const instant = '2026-06-25T23:30:00Z';

  it('formats in the recipient timezone with the place name and GMT offset', () => {
    const syd = formatLessonTimeForUser(instant, 'Australia/Sydney');
    expect(syd).toContain('Sydney (GMT+10)');
    expect(syd).toContain('9:30');

    const la = formatLessonTimeForUser(instant, 'America/Los_Angeles');
    expect(la).toContain('Los Angeles (GMT-7)');
    expect(la).toContain('4:30');
  });

  it('labels the UTC fallback as "UTC", not GMT+0', () => {
    const utc = formatLessonTimeForUser(instant, 'UTC');
    expect(utc).toContain('UTC');
    expect(utc).not.toContain('GMT');
    expect(utc).toContain('11:30');
  });

  it('falls back to UTC for a missing or invalid timezone', () => {
    expect(formatLessonTimeForUser(instant, null)).toContain('UTC');
    expect(formatLessonTimeForUser(instant, 'Bad/Zone')).toContain('UTC');
  });

  it('returns an empty string for an invalid date', () => {
    expect(formatLessonTimeForUser('not-a-date', 'UTC')).toBe('');
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

  it('AC1: flags a Sydney spring-forward gap (clocks jump 2am -> 3am)', () => {
    const result = resolveLocalTime(
      { year: 2026, month: 10, day: 4, hour: 2, minute: 30 },
      'Australia/Sydney'
    );
    expect(result.type).toBe('gap');
    expect(result.instants).toHaveLength(0);
  });

  it('AC2: disambiguates a Sydney fall-back overlap (clocks repeat 2am)', () => {
    const result = resolveLocalTime(
      { year: 2026, month: 4, day: 5, hour: 2, minute: 30 },
      'Australia/Sydney'
    );
    expect(result.type).toBe('ambiguous');
    expect(result.instants).toHaveLength(2);
    expect(result.instants[0].getTime()).toBeLessThan(result.instants[1].getTime());
    expect(formatLessonTimeForUser(result.instants[0], 'Australia/Sydney')).toContain('GMT+11');
    expect(formatLessonTimeForUser(result.instants[1], 'Australia/Sydney')).toContain('GMT+10');
  });

  it('AC5: flags a Los Angeles spring-forward gap (clocks jump 2am -> 3am)', () => {
    const result = resolveLocalTime(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
      'America/Los_Angeles'
    );
    expect(result.type).toBe('gap');
    expect(result.instants).toHaveLength(0);
  });

  it('AC5: disambiguates a Los Angeles fall-back overlap (clocks repeat 1am)', () => {
    const result = resolveLocalTime(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
      'America/Los_Angeles'
    );
    expect(result.type).toBe('ambiguous');
    expect(result.instants).toHaveLength(2);
    expect(formatLessonTimeForUser(result.instants[0], 'America/Los_Angeles')).toContain('GMT-7');
    expect(formatLessonTimeForUser(result.instants[1], 'America/Los_Angeles')).toContain('GMT-8');
  });

  it('AC5: UTC never has gaps or ambiguous times', () => {
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

describe('formatLessonTimeForUser across a DST rule change (AC3)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('converts the same stored instant correctly whether viewed before or after the boundary', () => {
    const instant = resolveLocalTime(
      { year: 2026, month: 10, day: 10, hour: 9, minute: 0 },
      'Australia/Sydney'
    ).instants[0];

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    const viewedBefore = formatLessonTimeForUser(instant, 'Australia/Sydney');

    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    const viewedAfter = formatLessonTimeForUser(instant, 'Australia/Sydney');

    expect(viewedBefore).toBe(viewedAfter);
    expect(viewedBefore).toContain('10 Oct 2026, 9:00 am Sydney (GMT+11)');
  });
});

describe('convertAvailabilityForStudent (AC1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves half-hour offsets when displaying a Sydney slot in Kolkata', () => {
    const converted = convertAvailabilityForStudent(
      [{ dayOfWeek: 1, startTime: '09:00', endTime: '10:00' }],
      'Australia/Sydney',
      'Asia/Kolkata'
    );

    expect(converted).toEqual([
      expect.objectContaining({ dayOfWeek: 1, startTime: '04:30', endTime: '05:30' }),
    ]);
  });

  it.each([
    ['Asia/Kathmandu', '04:45', '05:45'],
    ['Australia/Adelaide', '08:30', '09:30'],
  ])('retains minute boundaries when converting to %s', (zone, startTime, endTime) => {
    const converted = convertAvailabilityForStudent(
      [{ dayOfWeek: 1, startTime: '09:00', endTime: '10:00' }],
      'Australia/Sydney', zone
    );
    expect(converted).toEqual([expect.objectContaining({ dayOfWeek: 1, startTime, endTime })]);
  });

  it('keeps fractional minutes when availability crosses the viewer midnight', () => {
    expect(convertAvailabilityForStudent(
      [{ dayOfWeek: 1, startTime: '04:00', endTime: '06:00' }],
      'Australia/Sydney', 'Asia/Kolkata'
    )).toEqual([
      expect.objectContaining({ dayOfWeek: 0, startTime: '23:30', endTime: '24:00' }),
      expect.objectContaining({ dayOfWeek: 1, startTime: '00:00', endTime: '01:30' }),
    ]);
  });

  it('does not offer a slot at 2am on the Sydney spring-forward Sunday', () => {
    const slots = [{ dayOfWeek: 0, startTime: '01:00', endTime: '04:00' }];
    const converted = convertAvailabilityForStudent(slots, 'Australia/Sydney');

    expect(converted).toEqual([
      { dayOfWeek: 0, startTime: '01:00', endTime: '02:00', timezone: 'Australia/Sydney', sourceTimezone: 'Australia/Sydney', displayTimezone: 'Australia/Sydney', displayText: '01:00-02:00 (Australia/Sydney)' },
      { dayOfWeek: 0, startTime: '03:00', endTime: '04:00', timezone: 'Australia/Sydney', sourceTimezone: 'Australia/Sydney', displayTimezone: 'Australia/Sydney', displayText: '03:00-04:00 (Australia/Sydney)' },
    ]);
  });
});

describe('validateBookingTime across midnight in the tutor timezone', () => {
  const allDay = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
    dayOfWeek,
    startTime: '00:00',
    endTime: '24:00',
  }));
  const businessHours = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
    dayOfWeek,
    startTime: '09:00',
    endTime: '17:00',
  }));
  const crossesMidnightInLa = new Date('2026-09-14T06:30:00Z');

  it('accepts a lesson running past midnight when the tutor is available both days', () => {
    const result = validateBookingTime(crossesMidnightInLa, 'America/Los_Angeles', allDay, 90);
    expect(result.isValid).toBe(true);
  });

  it('rejects a lesson running past midnight when the next day has no cover', () => {
    const sundayLateOnly = [{ dayOfWeek: 0, startTime: '22:00', endTime: '24:00' }];
    const result = validateBookingTime(crossesMidnightInLa, 'America/Los_Angeles', sundayLateOnly, 90);
    expect(result.isValid).toBe(false);
  });

  it('accepts a lesson ending exactly at midnight without needing next-day cover', () => {
    const endsAtMidnight = new Date('2026-09-14T06:00:00Z');
    const result = validateBookingTime(endsAtMidnight, 'America/Los_Angeles', allDay, 60);
    expect(result.isValid).toBe(true);
  });

  it('still rejects a lesson that runs past the end of a normal availability window', () => {
    const lateAfternoon = new Date('2026-09-14T06:30:00Z');
    const result = validateBookingTime(lateAfternoon, 'Australia/Sydney', businessHours, 60);
    expect(result.isValid).toBe(false);
  });
});
