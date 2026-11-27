'use client';

import { useMemo, useState } from 'react';
import { formatMonthDay as formatDate, getDatePartsInTimezone, getTimezoneName } from '../lib/formatters';
import {
  DAY_ORDER,
  DAY_LABELS,
  HOURS,
  HALF_HOUR_STEPS,
  buildCellKey,
  cellsToSlots,
  getSlotDate,
  getWeekStart,
  resolveSlotInstants,
  slotsToCells,
} from '../lib/availability-calendar';

const formatWeekRange = (weekOffset, timezone) => {
  const start = getWeekStart(new Date(), weekOffset, timezone);
  const end = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000);
  const format = new Intl.DateTimeFormat('en-AU', {
    month: 'short',
    day: 'numeric',
    ...(timezone ? { timeZone: timezone } : {}),
  });
  return `${format.format(start)} - ${format.format(end)}`;
};

const timeToMinutes = (value) => {
  const [hour, minute] = String(value || '00:00').split(':').map(Number);
  return hour * 60 + minute;
};

const partsForInstant = (instant, timezone) => timezone
  ? getDatePartsInTimezone(instant, timezone)
  : { dayOfWeek: instant.getDay(), hour: instant.getHours(), minute: instant.getMinutes() };

const overlapsBooking = (start, durationMs, bookings) =>
  bookings.some((booking) => booking.start < start + durationMs && start < booking.end);

// Compare the complete lesson with the tutor's local availability, retaining minutes.
const blockFitsAvailability = (startInstant, durationMs, getSlots, timezone) => {
  for (let elapsed = 0; elapsed < durationMs; elapsed += 15 * 60 * 1000) {
    const instant = new Date(startInstant.getTime() + elapsed);
    const { dayOfWeek, hour, minute } = partsForInstant(instant, timezone);
    const localMinute = hour * 60 + minute;
    if (!getSlots(instant).some((slot) => Number(slot.dayOfWeek) === dayOfWeek &&
      timeToMinutes(slot.startTime) <= localMinute &&
      timeToMinutes(slot.endTime) >= localMinute + 15)) return false;
  }
  return true;
};

const overlapsAnySelection = (startMs, durationMs, selectedSlots) =>
  selectedSlots.some((sel) => {
    const selStart = new Date(sel.date).getTime();
    return selStart < startMs + durationMs && startMs < selStart + durationMs;
  });

export default function AvailabilityCalendar({
  slots = [],
  mode = 'view',
  onChange,
  onSelect,
  selectedSlots = [],
  currentWeekSlots = [],
  hasCurrentWeekOverride = false,
  bookedSlots = [],
  durationMinutes = 60,
  fixedWeekOffset,
  hideWeekNavigation = false,
  title,
  timezone = null,
  availabilityTimezone = timezone,
  allowOutsideAvailability = false,
}) {
  const [internalWeekOffset, setInternalWeekOffset] = useState(0);
  const weekOffset = typeof fixedWeekOffset === 'number' ? fixedWeekOffset : internalWeekOffset;
  const baseCells = useMemo(() => slotsToCells(slots), [slots]);
  const overrideCells = useMemo(() => slotsToCells(currentWeekSlots), [currentWeekSlots]);
  const cells = hasCurrentWeekOverride && weekOffset === 0 ? overrideCells : baseCells;
  const bookedRanges = useMemo(() => bookedSlots.map((slot) => ({
    start: new Date(slot?.scheduledAt).getTime(),
    end: new Date(slot?.scheduledAt).getTime() + Number(slot?.duration || 60) * 60 * 1000,
  })).filter((slot) => Number.isFinite(slot.start)), [bookedSlots]);
  const overrideWeekStart = getWeekStart(new Date(), 0, availabilityTimezone).getTime();
  const getSlots = (instant) => hasCurrentWeekOverride &&
    getWeekStart(instant, 0, availabilityTimezone).getTime() === overrideWeekStart
      ? currentWeekSlots : slots;

  const heading = title || (mode === 'edit' ? 'Weekly availability preview' : 'Pick a slot');
  const durationValue = Number(durationMinutes || 60);
  const durationMs = durationValue * 60 * 1000;
  // Keep half-hour starts in the tutor's timezone, including :15/:45 for the viewer.
  const now = new Date();
  const minuteOffset = (partsForInstant(now, timezone).minute -
    partsForInstant(now, availabilityTimezone).minute + 60) % 30;
  const selectRows = minuteOffset === 0 ? HALF_HOUR_STEPS : HOURS.flatMap((hour) =>
    [minuteOffset, minuteOffset + 30].map((minute) => ({ hour, minute }))
  );
  const rows = mode === 'select' ? selectRows : HOURS.map((hour) => ({ hour, minute: 0 }));

  const handleEditToggle = (dayOfWeek, hour) => {
    const cellKey = buildCellKey(dayOfWeek, hour);
    const next = new Set(cells);
    next.has(cellKey) ? next.delete(cellKey) : next.add(cellKey);
    onChange?.(cellsToSlots(next));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 text-sm">
        <div>
          <div className="font-medium text-gray-700">{heading}</div>
          <div className="text-xs text-gray-400">{formatWeekRange(weekOffset, timezone)}</div>
        </div>
        {!hideWeekNavigation && typeof fixedWeekOffset !== 'number' && (
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setInternalWeekOffset((value) => value - 1)} className="btn-secondary btn-sm">Prev</button>
            <button type="button" onClick={() => setInternalWeekOffset((value) => value + 1)} className="btn-secondary btn-sm">Next</button>
          </div>
        )}
      </div>
      {mode === 'select' && allowOutsideAvailability && (
        <p className="text-xs text-gray-500">
          Green slots match your listed availability. Other free slots can also be selected.
        </p>
      )}
      <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white p-3">
        <div
          className="grid min-w-[820px] gap-2 text-xs"
          style={{ gridTemplateColumns: '58px repeat(7, minmax(104px, 1fr))' }}
        >
          <div />
          {DAY_ORDER.map((dayOfWeek) => (
            <div key={dayOfWeek} className="rounded-lg bg-gray-50 p-2 text-center font-medium text-gray-600">
              <div>{DAY_LABELS[dayOfWeek]}</div>
              <div className="text-[11px] text-gray-400">{formatDate(getSlotDate(dayOfWeek, 0, weekOffset, timezone), timezone)}</div>
            </div>
          ))}
          {rows.map(({ hour, minute }) => (
            <FragmentRow
              key={`${hour}:${minute}`}
              hour={hour}
              minute={minute}
              mode={mode}
              cells={cells}
              bookedRanges={bookedRanges}
              getSlots={getSlots}
              availabilityTimezone={availabilityTimezone}
              selectedSlots={selectedSlots}
              durationMs={durationMs}
              weekOffset={weekOffset}
              timezone={timezone}
              onSelect={onSelect}
              onEditToggle={handleEditToggle}
              allowOutsideAvailability={allowOutsideAvailability}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function FragmentRow({
  hour,
  minute,
  mode,
  cells,
  bookedRanges,
  getSlots,
  availabilityTimezone,
  selectedSlots,
  durationMs,
  weekOffset,
  timezone,
  onSelect,
  onEditToggle,
  allowOutsideAvailability,
}) {
  const timeLabel = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return (
    <>
      <div className="flex items-center justify-center rounded-lg bg-gray-50 text-gray-400">
        {timeLabel}
      </div>
      {DAY_ORDER.map((dayOfWeek) => {
        const cellKey = buildCellKey(dayOfWeek, hour);
        const availableHour = cells.has(cellKey);

        // ----- edit / view: hour cells, unchanged behaviour -----
        if (mode !== 'select') {
          const label = availableHour ? 'Available' : '';
          return (
            <button
              key={`${cellKey}:${minute}`}
              type="button"
              disabled={mode === 'view'}
              onClick={() => onEditToggle(dayOfWeek, hour)}
              className={cellClass({ selected: false, booked: false, active: availableHour, disabled: mode === 'view' })}
            >
              {label && <span className="text-[11px] font-medium">{label}</span>}
            </button>
          );
        }

        // ----- select: duration-aware block fill -----
        // A gap instant has no real occurrences; an ambiguous one has two, both offered.
        const { instants } = resolveSlotInstants(dayOfWeek, hour, weekOffset, timezone, minute);
        if (instants.length === 0) {
          return <div key={`${cellKey}:${minute}`} className={cellClass({ selected: false, booked: false, active: false, disabled: true })} />;
        }

        return (
          <div key={`${cellKey}:${minute}`} className="flex flex-col gap-1">
            {instants.map((cellStart, index) => (
              <SlotButton
                key={cellStart.toISOString()}
                cellStart={cellStart}
                slotKey={
                  instants.length > 1
                    ? `${weekOffset}:${dayOfWeek}-${hour}:${minute}:${index}`
                    : `${weekOffset}:${dayOfWeek}-${hour}:${minute}`
                }
                offsetLabel={instants.length > 1 ? getTimezoneName(cellStart, timezone, 'short') : null}
                dayOfWeek={dayOfWeek}
                hour={hour}
                minute={minute}
                timezone={timezone}
                bookedRanges={bookedRanges}
                getSlots={getSlots}
                availabilityTimezone={availabilityTimezone}
                selectedSlots={selectedSlots}
                durationMs={durationMs}
                onSelect={onSelect}
                allowOutsideAvailability={allowOutsideAvailability}
              />
            ))}
          </div>
        );
      })}
    </>
  );
}

function SlotButton({
  cellStart,
  slotKey,
  offsetLabel,
  dayOfWeek,
  hour,
  minute,
  timezone,
  bookedRanges,
  getSlots,
  availabilityTimezone,
  selectedSlots,
  durationMs,
  onSelect,
  allowOutsideAvailability,
}) {
  const cellMs = cellStart.getTime();
  const coveredBy = selectedSlots.find((sel) => {
    const selStart = new Date(sel.date).getTime();
    return cellMs >= selStart && cellMs < selStart + durationMs;
  });

  let label = '';
  let selected = false;
  let booked = false;
  let disabled = true;
  let handleClick;
  const ownBooked = overlapsBooking(cellMs, 30 * 60 * 1000, bookedRanges);
  const isPast = cellStart < new Date();
  const tutorParts = partsForInstant(cellStart, availabilityTimezone);
  const alignedStart = tutorParts.minute % 30 === 0;
  const withinDeclaredAvailability = alignedStart && blockFitsAvailability(
    cellStart, durationMs, getSlots, availabilityTimezone
  );
  const conflictFreeBlock = alignedStart && !overlapsBooking(cellMs, durationMs, bookedRanges);


  if (coveredBy) {
    selected = true;
    disabled = false;
    label = 'Selected';
    handleClick = () => onSelect?.(coveredBy);
  } else {
    const bookable =
      !isPast &&
      (allowOutsideAvailability
        ? conflictFreeBlock
        : withinDeclaredAvailability && conflictFreeBlock) &&
      !overlapsAnySelection(cellMs, durationMs, selectedSlots);

    if (bookable) {
      disabled = false;
      label = allowOutsideAvailability
        ? (withinDeclaredAvailability ? 'Availability' : 'Free')
        : 'Available';
      handleClick = () =>
        onSelect?.({
          key: slotKey,
          dayOfWeek,
          hour,
          minute,
          date: cellStart,
        });
    } else if (ownBooked) {
      booked = true;
      label = 'Booked';
    } else if (!isPast && alignedStart && !conflictFreeBlock) {
      booked = true;
      label = 'Conflicts';
    }
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={handleClick}
      className={cellClass({
        selected,
        booked,
        active: withinDeclaredAvailability,
        outsideSelectable: allowOutsideAvailability && !withinDeclaredAvailability && !disabled,
        disabled,
      })}
    >
      {label && <span className="text-[11px] font-medium">{label}{offsetLabel ? ` (${offsetLabel})` : ''}</span>}
    </button>
  );
}

function cellClass({ selected, booked, active, outsideSelectable = false, disabled }) {
  const base = 'flex h-9 items-center justify-center rounded-lg border px-2 text-center transition-colors';
  const state = selected
    ? 'border-primary-600 bg-primary-100 text-primary-700'
    : booked
      ? 'border-gray-300 bg-gray-100 text-gray-500'
    : active
      ? 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
      : outsideSelectable
        ? 'border-sky-200 bg-white text-sky-700 hover:bg-sky-50'
      : 'border-gray-200 bg-white text-gray-300';
  return `${base} ${state} ${disabled ? 'cursor-not-allowed opacity-40' : ''}`;
}
