import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { slotsToCells, cellsToSlots, resolveSlotInstants, addWeeksToSlot } from '../availability-calendar';

describe('availability calendar helpers', () => {
  test('handles empty input without producing slots', () => {
    expect(slotsToCells()).toEqual(new Set());
    expect(cellsToSlots(new Set())).toEqual([]);
  });

  test('expands slots into unique hourly cells', () => {
    const cells = slotsToCells([
      { dayOfWeek: 2, startTime: '09:00', endTime: '11:00' },
      { dayOfWeek: 2, startTime: '10:00', endTime: '12:00' },
    ]);

    expect([...cells].sort()).toEqual(['2-10', '2-11', '2-9']);
  });

  test('compresses consecutive cells and keeps gaps separate', () => {
    expect(cellsToSlots(new Set(['3-9', '3-10', '3-12']))).toEqual([
      { dayOfWeek: '3', startTime: '09:00', endTime: '11:00' },
      { dayOfWeek: '3', startTime: '12:00', endTime: '13:00' },
    ]);
  });

  test('preserves a simple slot through the cell round trip', () => {
    const original = [{ dayOfWeek: 1, startTime: '09:00', endTime: '12:00' }];

    expect(cellsToSlots(slotsToCells(original))).toEqual([
      { dayOfWeek: '1', startTime: '09:00', endTime: '12:00' },
    ]);
  });
});

describe('resolveSlotInstants (SCH-02)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('returns no instants for a Sydney spring-forward gap slot', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));

    const result = resolveSlotInstants(0, 2, 0, 'Australia/Sydney', 30);
    expect(result.type).toBe('gap');
    expect(result.instants).toHaveLength(0);
  });

  test('returns both instants for a Sydney fall-back overlap slot', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-02T00:00:00Z'));

    const result = resolveSlotInstants(0, 2, 0, 'Australia/Sydney', 30);
    expect(result.type).toBe('ambiguous');
    expect(result.instants).toHaveLength(2);
    expect(result.instants[0].getTime()).toBeLessThan(result.instants[1].getTime());
  });

  test('returns a single instant when no timezone is given', () => {
    const result = resolveSlotInstants(1, 9, 0, null, 30);
    expect(result.type).toBe('unique');
    expect(result.instants).toHaveLength(1);
  });
});

describe('addWeeksToSlot (SCH-02 recurring bookings)', () => {
  test('keeps the same local wall-clock time for a week unaffected by DST', () => {
    const start = new Date('2026-09-19T16:30:00.000Z');
    const result = addWeeksToSlot(start, 1, 'Australia/Sydney');
    expect(result.toISOString()).toBe('2026-09-26T16:30:00.000Z');
  });

  test('skips a week that lands on a Sydney spring-forward gap', () => {
    const start = new Date('2026-09-19T16:30:00.000Z');
    const result = addWeeksToSlot(start, 2, 'Australia/Sydney');
    expect(result).toBeNull();
  });

  test('resolves a week that lands on a Sydney fall-back overlap to the earlier occurrence', () => {
    const start = new Date('2026-03-21T15:30:00.000Z');
    const result = addWeeksToSlot(start, 2, 'Australia/Sydney');
    expect(result.toISOString()).toBe('2026-04-04T15:30:00.000Z');
  });

  test('falls back to plain date arithmetic when no timezone is given', () => {
    const start = new Date('2026-09-19T16:30:00.000Z');
    const result = addWeeksToSlot(start, 1, null);
    expect(result.getTime()).toBe(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  });

  test('keeps the exact chosen instant at zero weeks, even the later of an ambiguous pair', () => {
    const laterOccurrence = new Date('2026-04-04T16:30:00.000Z');
    const result = addWeeksToSlot(laterOccurrence, 0, 'Australia/Sydney');
    expect(result.toISOString()).toBe('2026-04-04T16:30:00.000Z');
  });
});
