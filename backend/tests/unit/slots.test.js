const {
  timeToMinutes,
  isAlignedMinutes,
  isValidDurationMinutes,
} = require('../../src/utils/slots');

describe('timeToMinutes', () => {
  it('converts time strings to minutes since midnight', () => {
    expect(timeToMinutes('09:00')).toBe(540);
    expect(timeToMinutes('09:30')).toBe(570);
    expect(timeToMinutes('00:00')).toBe(0);
  });
  it('returns NaN for malformed input', () => {
    expect(Number.isNaN(timeToMinutes('bad'))).toBe(true);
    expect(Number.isNaN(timeToMinutes(''))).toBe(true);
  });
});

describe('isAlignedMinutes (AC4 start rule)', () => {
  it('accepts :00 and :30 boundaries', () => {
    expect(isAlignedMinutes(540)).toBe(true); // 09:00
    expect(isAlignedMinutes(570)).toBe(true); // 09:30
  });
  it('rejects off-boundary minutes', () => {
    expect(isAlignedMinutes(557)).toBe(false); // 09:17
    expect(isAlignedMinutes(545)).toBe(false); // 09:05
  });
});

describe('isValidDurationMinutes (AC4 duration rule)', () => {
  it('accepts 30-minute multiples within 30..480', () => {
    expect(isValidDurationMinutes(30)).toBe(true);
    expect(isValidDurationMinutes(60)).toBe(true);
    expect(isValidDurationMinutes(480)).toBe(true);
  });
  it('rejects non-multiples and out-of-range values', () => {
    expect(isValidDurationMinutes(45)).toBe(false);
    expect(isValidDurationMinutes(0)).toBe(false);
    expect(isValidDurationMinutes(15)).toBe(false);
    expect(isValidDurationMinutes(510)).toBe(false);
    expect(isValidDurationMinutes(60.5)).toBe(false);
  });
});
