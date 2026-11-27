import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import AvailabilityCalendar from '../AvailabilityCalendar';

describe('AvailabilityCalendar component', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-27T00:00:00.000Z'));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  test('toggles an editable availability cell and reports the updated slots', async () => {
    const onChange = vi.fn();

    render(
      <AvailabilityCalendar
        mode="edit"
        hideWeekNavigation
        slots={[{ dayOfWeek: 1, startTime: '09:00', endTime: '10:00' }]}
        onChange={onChange}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Available' }));

    expect(onChange).toHaveBeenCalledWith([]);
  });

  test('fills the chosen duration, blocks booked half-hours, and selects a valid start', async () => {
    const onSelect = vi.fn();

    render(
      <AvailabilityCalendar
        mode="select"
        fixedWeekOffset={1}
        hideWeekNavigation
        durationMinutes={60}
        slots={[{ dayOfWeek: 1, startTime: '09:00', endTime: '11:00' }]}
        bookedSlots={[{ scheduledAt: '2026-05-04T10:00:00.000Z', duration: 60 }]}
        selectedSlots={[]}
        onSelect={onSelect}
        timezone="UTC"
      />
    );

    // 09:00-11:00 window, 60-min lesson, 10:00-11:00 already booked ->
    // only 09:00 is a valid start; 10:00 and 10:30 show as booked.
    expect(screen.getAllByRole('button', { name: 'Available' }).length).toBe(1);
    expect(screen.getAllByRole('button', { name: 'Booked' }).length).toBe(2);

    fireEvent.click(screen.getByRole('button', { name: 'Available' }));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ key: '1:1-9:0', dayOfWeek: 1, hour: 9, minute: 0 })
    );
  });

  test('disables starts where the chosen duration would not fit availability', async () => {
    const onSelect = vi.fn();

    render(
      <AvailabilityCalendar
        mode="select"
        fixedWeekOffset={1}
        hideWeekNavigation
        durationMinutes={90}
        slots={[{ dayOfWeek: 1, startTime: '09:00', endTime: '10:00' }]}
        selectedSlots={[]}
        onSelect={onSelect}
        timezone="UTC"
      />
    );

    // A 90-minute lesson cannot fit inside a single one-hour window.
    expect(screen.queryAllByRole('button', { name: 'Available' }).length).toBe(0);
  });

  test('lets a tutor select free time outside declared availability while highlighting availability', () => {
    const onSelect = vi.fn();

    render(
      <AvailabilityCalendar
        mode="select"
        fixedWeekOffset={1}
        hideWeekNavigation
        allowOutsideAvailability
        durationMinutes={60}
        slots={[{ dayOfWeek: 1, startTime: '09:00', endTime: '10:00' }]}
        bookedSlots={[{ scheduledAt: '2026-05-04T11:00:00.000Z', duration: 60 }]}
        selectedSlots={[]}
        onSelect={onSelect}
        timezone="UTC"
      />
    );

    expect(screen.getByText(/green slots match your listed availability/i)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Availability' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Booked' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Conflicts' })).toHaveLength(1);

    const freeSlot = screen.getAllByRole('button', { name: 'Free' })[0];
    fireEvent.click(freeSlot);
    expect(onSelect).toHaveBeenCalledOnce();
  });

  test('offers Sydney availability at the exact Kolkata local time', () => {
    vi.setSystemTime(new Date('2026-10-26T00:00:00Z'));
    const onSelect = vi.fn();

    render(
      <AvailabilityCalendar
        mode="select"
        fixedWeekOffset={1}
        hideWeekNavigation
        durationMinutes={30}
        slots={[{ dayOfWeek: 1, startTime: '09:00', endTime: '10:00' }]}
        timezone="Asia/Kolkata"
        availabilityTimezone="Australia/Sydney"
        onSelect={onSelect}
      />
    );

    expect(screen.getAllByRole('button', { name: 'Available' })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Available' })[0]);
    const slot = onSelect.mock.calls[0][0];
    expect(slot.hour).toBe(3);
    expect(slot.minute).toBe(30);
    expect(slot.date.toISOString()).toBe('2026-11-01T22:00:00.000Z');
  });

  test('offers quarter-offset starts and excludes a booked lesson for the complete duration', () => {
    vi.setSystemTime(new Date('2026-10-26T00:00:00Z'));
    const onSelect = vi.fn();

    render(
      <AvailabilityCalendar
        mode="select"
        fixedWeekOffset={1}
        hideWeekNavigation
        durationMinutes={60}
        slots={[{ dayOfWeek: 1, startTime: '09:00', endTime: '11:00' }]}
        bookedSlots={[{ scheduledAt: '2026-11-01T23:00:00.000Z', duration: 60 }]}
        timezone="Asia/Kathmandu"
        availabilityTimezone="Australia/Sydney"
        onSelect={onSelect}
      />
    );

    expect(screen.getAllByRole('button', { name: 'Available' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Available' }));
    const slot = onSelect.mock.calls[0][0];
    expect(slot.hour).toBe(3);
    expect(slot.minute).toBe(45);
    expect(slot.date.toISOString()).toBe('2026-11-01T22:00:00.000Z');
  });

  test('uses the selected week DST offset rather than the current week offset', () => {
    vi.setSystemTime(new Date('2026-10-26T00:00:00Z'));
    const onSelect = vi.fn();
    render(
      <AvailabilityCalendar mode="select" fixedWeekOffset={1} hideWeekNavigation
        durationMinutes={30} slots={[{ dayOfWeek: 1, startTime: '09:00', endTime: '10:00' }]}
        timezone="Australia/Sydney" availabilityTimezone="America/Los_Angeles" onSelect={onSelect} />
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Available' })[0]);
    expect(onSelect.mock.calls[0][0].date.toISOString()).toBe('2026-11-02T17:00:00.000Z');
    expect(onSelect.mock.calls[0][0].hour).toBe(4);
  });

  test('applies the tutor current-week override when viewer and tutor weeks differ', () => {
    vi.setSystemTime(new Date('2026-10-26T12:00:00Z'));
    const onSelect = vi.fn();
    render(
      <AvailabilityCalendar mode="select" fixedWeekOffset={1} hideWeekNavigation
        durationMinutes={30} slots={[{ dayOfWeek: 0, startTime: '09:00', endTime: '10:00' }]}
        currentWeekSlots={[{ dayOfWeek: 0, startTime: '10:00', endTime: '11:00' }]}
        hasCurrentWeekOverride timezone="Australia/Sydney" availabilityTimezone="America/Los_Angeles"
        onSelect={onSelect} />
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Available' })[0]);
    expect(onSelect.mock.calls[0][0].date.toISOString()).toBe('2026-11-01T18:00:00.000Z');
  });

  test('excludes a Sydney spring-forward gap slot', async () => {
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));

    render(
      <AvailabilityCalendar
        mode="select"
        fixedWeekOffset={0}
        hideWeekNavigation
        durationMinutes={30}
        slots={[{ dayOfWeek: 0, startTime: '01:00', endTime: '04:00' }]}
        selectedSlots={[]}
        onSelect={vi.fn()}
        timezone="Australia/Sydney"
      />
    );

    // 2am on this Sunday does not exist, so only the hours either side are offered.
    expect(screen.getAllByRole('button', { name: 'Available' }).length).toBe(4);
  });

  test('offers both occurrences of a Sydney fall-back overlap slot', async () => {
    vi.setSystemTime(new Date('2026-04-02T00:00:00Z'));

    render(
      <AvailabilityCalendar
        mode="select"
        fixedWeekOffset={0}
        hideWeekNavigation
        durationMinutes={30}
        slots={[{ dayOfWeek: 0, startTime: '02:00', endTime: '03:00' }]}
        selectedSlots={[]}
        onSelect={vi.fn()}
        timezone="Australia/Sydney"
      />
    );

    // 2:00 and 2:30 on this Sunday each happen twice, so each occurrence is offered with its own offset.
    expect(screen.getAllByRole('button', { name: 'Available (AEDT)' }).length).toBe(2);
    expect(screen.getAllByRole('button', { name: 'Available (AEST)' }).length).toBe(2);
  });
});
