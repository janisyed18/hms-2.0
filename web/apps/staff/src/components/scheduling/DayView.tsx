import { CalendarPlus } from "lucide-react";
import { useMemo, useState } from "react";

import {
  buildLanes,
  conflictIds,
  entriesOnDay,
  workloadLabel,
  type InspectorOption,
  type ScheduleEntry
} from "../../scheduling/scheduleModel";
import { formatYmd } from "../../scheduling/zonedTime";
import { TimeGrid } from "./TimeGrid";

/** Beyond this many inspectors, idle ones are hidden unless the user asks for them. */
const SHOW_IDLE_BELOW = 9;

export function DayView({
  canBook,
  entries,
  gridZone,
  inspectors,
  nowMarker,
  onBook,
  onSelect,
  selectedId,
  ymd
}: {
  canBook: boolean;
  entries: ScheduleEntry[];
  gridZone: string;
  inspectors: InspectorOption[];
  nowMarker: number;
  onBook: () => void;
  onSelect: (entry: ScheduleEntry) => void;
  selectedId: string | null;
  ymd: string;
}) {
  const dayEntries = useMemo(() => entriesOnDay(entries, ymd, gridZone), [entries, gridZone, ymd]);
  const [idleOverride, setIdleOverride] = useState<boolean | null>(null);
  const showIdle = idleOverride ?? inspectors.length < SHOW_IDLE_BELOW;
  const lanes = useMemo(
    () => buildLanes(dayEntries, inspectors, showIdle),
    [dayEntries, inspectors, showIdle]
  );
  const conflicts = useMemo(() => conflictIds(dayEntries), [dayEntries]);
  const dayName = formatYmd(ymd, { weekday: "long", day: "numeric", month: "long" });

  if (dayEntries.length === 0) {
    return (
      <div className="schedule-empty" role="status">
        <strong>No inspections scheduled for {dayName}</strong>
        <span>Nothing matches the current filters on this day.</span>
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
    <div className="schedule-day">
      {inspectors.length >= SHOW_IDLE_BELOW ? (
        <label className="schedule-toggle">
          <input
            checked={showIdle}
            onChange={(event) => setIdleOverride(event.target.checked)}
            type="checkbox"
          />
          Show inspectors with no visits ({inspectors.length} in total)
        </label>
      ) : null}
      <TimeGrid
        columns={lanes.map((lane) => ({
          key: lane.id ?? "unassigned",
          ymd,
          title: <strong>{lane.name}</strong>,
          subtitle: (
            <>
              {workloadLabel(lane)}
              {lane.conflicts > 0 ? (
                <span className="schedule-flag">
                  {lane.conflicts} overlapping {lane.conflicts === 1 ? "visit" : "visits"}
                </span>
              ) : null}
            </>
          ),
          entries: lane.entries
        }))}
        conflicts={conflicts}
        gridZone={gridZone}
        label={`Dispatch schedule for ${dayName}`}
        nowMarker={nowMarker}
        onSelect={onSelect}
        selectedId={selectedId}
        showInspector={false}
      />
    </div>
  );
}
