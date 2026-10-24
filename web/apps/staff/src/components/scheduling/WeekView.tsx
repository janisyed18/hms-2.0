import { CalendarPlus } from "lucide-react";
import { useMemo } from "react";

import {
  conflictIds,
  entriesOnDay,
  type ScheduleEntry
} from "../../scheduling/scheduleModel";
import { addDays, formatYmd, startOfWeek } from "../../scheduling/zonedTime";
import { TimeGrid } from "./TimeGrid";

export function WeekView({
  canBook,
  entries,
  gridZone,
  nowMarker,
  onBook,
  onOpenDay,
  onSelect,
  selectedId,
  ymd
}: {
  canBook: boolean;
  entries: ScheduleEntry[];
  gridZone: string;
  nowMarker: number;
  onBook: () => void;
  onOpenDay: (ymd: string) => void;
  onSelect: (entry: ScheduleEntry) => void;
  selectedId: string | null;
  ymd: string;
}) {
  const first = startOfWeek(ymd);
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, index) => addDays(first, index)),
    [first]
  );
  const conflicts = useMemo(() => conflictIds(entries), [entries]);
  const weekEntries = useMemo(
    () => days.flatMap((day) => entriesOnDay(entries, day, gridZone)),
    [days, entries, gridZone]
  );
  const range = `${formatYmd(first, { day: "numeric", month: "long" })} to ${formatYmd(
    addDays(first, 6),
    { day: "numeric", month: "long", year: "numeric" }
  )}`;

  if (weekEntries.length === 0) {
    return (
      <div className="schedule-empty" role="status">
        <strong>No inspections scheduled for the week of {range}</strong>
        <span>Nothing matches the current filters in this week.</span>
        {canBook ? (
          <button className="primary-button" onClick={onBook} type="button">
            <CalendarPlus aria-hidden="true" size={17} />
            Book inspection
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <TimeGrid
      columns={days.map((day) => {
        const dayEntries = entriesOnDay(entries, day, gridZone);
        return {
          key: day,
          ymd: day,
          title: (
            <button
              aria-label={`Open ${formatYmd(day, { weekday: "long", day: "numeric", month: "long" })} in day view`}
              className="schedule-day-link"
              onClick={() => onOpenDay(day)}
              type="button"
            >
              {formatYmd(day, { weekday: "short", day: "numeric", month: "short" })}
            </button>
          ),
          subtitle: `${dayEntries.length} ${dayEntries.length === 1 ? "visit" : "visits"}`,
          entries: dayEntries
        };
      })}
      conflicts={conflicts}
      gridZone={gridZone}
      label={`Schedule for the week of ${range}`}
      nowMarker={nowMarker}
      onSelect={onSelect}
      selectedId={selectedId}
      showInspector
    />
  );
}
