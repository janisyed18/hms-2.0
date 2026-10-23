import type { ReactNode } from "react";

import {
  STATUS_META,
  placeEntries,
  snapshotClock,
  type PlacedEntry,
  type ScheduleEntry
} from "../../scheduling/scheduleModel";
import {
  addDays,
  dayLengthMinutes,
  formatTime,
  formatYmd,
  zoneLabel,
  zonedMidnight
} from "../../scheduling/zonedTime";

export interface GridColumn {
  key: string;
  ymd: string;
  title: ReactNode;
  subtitle?: ReactNode;
  entries: ScheduleEntry[];
}

const PX_PER_MINUTE = 1.2;
const DEFAULT_START = 6 * 60;
const DEFAULT_END = 19 * 60;

/** How a visit reads to people: its own zone's wall-clock times. */
export function visitTimes(entry: ScheduleEntry, gridZone: string): string {
  const appointment = entry.booking.appointment;
  const from = appointment
    ? snapshotClock(appointment.localStartSnapshot)
    : formatTime(entry.start, entry.timeZone);
  const to = appointment
    ? snapshotClock(appointment.localEndSnapshot)
    : formatTime(entry.end, entry.timeZone);
  // Name the zone only when it is not the calendar's own, so nobody misreads it.
  const suffix =
    entry.timeZone === gridZone ? "" : ` ${zoneLabel(entry.start, entry.timeZone)}`;
  return `${from} to ${to}${suffix}`;
}

export function entryLabel(entry: ScheduleEntry, gridZone: string, ymd: string): string {
  const day = formatYmd(ymd, { weekday: "long", day: "numeric", month: "long" });
  return [
    `${day}, ${visitTimes(entry, gridZone)}`,
    entry.customerName,
    entry.locationName,
    entry.inspectorName,
    STATUS_META[entry.status].label
  ].join(", ");
}

export function TimeGrid({
  columns,
  conflicts,
  gridZone,
  label,
  nowMarker,
  onSelect,
  selectedId,
  showInspector
}: {
  columns: GridColumn[];
  conflicts: ReadonlySet<string>;
  gridZone: string;
  label: string;
  /** An instant to mark as "now" in the column for its local day. */
  nowMarker?: number;
  onSelect: (entry: ScheduleEntry) => void;
  selectedId: string | null;
  showInspector: boolean;
}) {
  const placedByColumn = columns.map((column) =>
    placeEntries(column.entries, column.ymd, gridZone)
  );
  let windowStart = DEFAULT_START;
  let windowEnd = DEFAULT_END;
  for (const placed of placedByColumn) {
    for (const item of placed) {
      windowStart = Math.min(windowStart, Math.floor(item.startMin / 60) * 60);
      windowEnd = Math.max(windowEnd, Math.ceil(item.endMin / 60) * 60);
    }
  }
  const length = dayLengthMinutes(columns[0]?.ymd ?? "1970-01-01", gridZone);
  windowEnd = Math.min(windowEnd, Math.max(length, 60));
  const height = (windowEnd - windowStart) * PX_PER_MINUTE;
  const hours: number[] = [];
  for (let minute = windowStart; minute < windowEnd; minute += 60) hours.push(minute);
  const base = columns[0] ? zonedMidnight(columns[0].ymd, gridZone) : 0;

  return (
    <div
      aria-label={label}
      className="time-grid"
      role="group"
      style={{ ["--grid-columns" as string]: columns.length }}
    >
      <div className="time-grid__head">
        <span className="time-grid__corner" aria-hidden="true">
          {zoneLabel(base, gridZone)}
        </span>
        {columns.map((column) => (
          <div className="time-grid__title" key={column.key}>
            {column.title}
            {column.subtitle ? <small>{column.subtitle}</small> : null}
          </div>
        ))}
      </div>
      <div className="time-grid__body" style={{ height }}>
        <div className="time-grid__hours" aria-hidden="true">
          {hours.map((minute) => (
            <span key={minute} style={{ top: (minute - windowStart) * PX_PER_MINUTE }}>
              {formatTime(base + minute * 60_000, gridZone)}
            </span>
          ))}
        </div>
        {columns.map((column, index) => {
          const nowMinute =
            nowMarker === undefined
              ? null
              : (nowMarker - zonedMidnight(column.ymd, gridZone)) / 60_000;
          const showNow =
            nowMinute !== null &&
            nowMinute >= windowStart &&
            nowMinute < windowEnd &&
            nowMarker! < zonedMidnight(addDays(column.ymd, 1), gridZone);
          return (
            <div className="time-grid__column" key={column.key}>
              {hours.map((minute) => (
                <i
                  aria-hidden="true"
                  className="time-grid__line"
                  key={minute}
                  style={{ top: (minute - windowStart) * PX_PER_MINUTE }}
                />
              ))}
              {showNow ? (
                <i
                  aria-hidden="true"
                  className="time-grid__now"
                  style={{ top: (nowMinute - windowStart) * PX_PER_MINUTE }}
                />
              ) : null}
              {placedByColumn[index].map((item) => (
                <Block
                  conflict={conflicts.has(item.entry.id)}
                  gridZone={gridZone}
                  item={item}
                  key={item.entry.id}
                  onSelect={onSelect}
                  selected={selectedId === item.entry.id}
                  showInspector={showInspector}
                  windowStart={windowStart}
                  ymd={column.ymd}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Block({
  conflict,
  gridZone,
  item,
  onSelect,
  selected,
  showInspector,
  windowStart,
  ymd
}: {
  conflict: boolean;
  gridZone: string;
  item: PlacedEntry;
  onSelect: (entry: ScheduleEntry) => void;
  selected: boolean;
  showInspector: boolean;
  windowStart: number;
  ymd: string;
}) {
  const { entry } = item;
  const top = (item.startMin - windowStart) * PX_PER_MINUTE;
  const blockHeight = Math.max((item.endMin - item.startMin) * PX_PER_MINUTE, 22);
  return (
    <button
      aria-label={`${entryLabel(entry, gridZone, ymd)}${conflict ? ", conflicts with another visit for this inspector" : ""}`}
      aria-pressed={selected}
      className={`schedule-block status-${entry.status}${conflict ? " has-conflict" : ""}${selected ? " is-selected" : ""}`}
      onClick={() => onSelect(entry)}
      style={{
        top,
        height: blockHeight,
        left: `${(item.column / item.columns) * 100}%`,
        width: `${100 / item.columns}%`
      }}
      type="button"
    >
      <strong>{visitTimes(entry, gridZone)}</strong>
      <span>{entry.customerName}</span>
      {blockHeight > 56 ? <span>{entry.locationName}</span> : null}
      {showInspector && blockHeight > 70 ? <span>{entry.inspectorName}</span> : null}
      <em>
        {STATUS_META[entry.status].label}
        {conflict ? " · Conflict" : ""}
      </em>
    </button>
  );
}
