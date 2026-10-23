import { useMemo } from "react";

import {
  STATUS_META,
  STATUS_ORDER,
  monthGrid,
  type ScheduleEntry
} from "../../scheduling/scheduleModel";
import { formatYmd } from "../../scheduling/zonedTime";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function MonthView({
  entries,
  gridZone,
  onOpenDay,
  today,
  ymd
}: {
  entries: ScheduleEntry[];
  gridZone: string;
  onOpenDay: (ymd: string) => void;
  today: string;
  ymd: string;
}) {
  const weeks = useMemo(() => monthGrid(entries, ymd, gridZone), [entries, gridZone, ymd]);
  const total = weeks.flat().filter((day) => day.inMonth).reduce((sum, day) => sum + day.total, 0);
  const monthName = formatYmd(ymd, { month: "long", year: "numeric" });

  return (
    <div className="schedule-month">
      {total === 0 ? (
        <p className="schedule-month__none" role="status">
          No inspections scheduled in {monthName}. Pick a day to book one.
        </p>
      ) : null}
      <div className="schedule-month__grid" role="grid" aria-label={`Inspections in ${monthName}`}>
        <div className="schedule-month__row" role="row">
          {WEEKDAYS.map((weekday) => (
            <span className="schedule-month__weekday" key={weekday} role="columnheader">
              {weekday}
            </span>
          ))}
        </div>
        {weeks.map((week) => (
          <div className="schedule-month__row" key={week[0].ymd} role="row">
            {week.map((day) => {
              const dayName = formatYmd(day.ymd, { weekday: "long", day: "numeric", month: "long" });
              const summary =
                day.total === 0
                  ? "no visits"
                  : `${day.total} ${day.total === 1 ? "visit" : "visits"}${day.unassigned ? `, ${day.unassigned} unassigned` : ""}${day.conflicts ? `, ${day.conflicts} overlapping` : ""}`;
              return (
                <div
                  className={`schedule-month__cell${day.inMonth ? "" : " is-outside"}${day.ymd === today ? " is-today" : ""}`}
                  key={day.ymd}
                  role="gridcell"
                >
                  <button
                    aria-label={`${dayName}: ${summary}. Open day view`}
                    className="schedule-month__day"
                    onClick={() => onOpenDay(day.ymd)}
                    type="button"
                  >
                    <span className="schedule-month__number">{Number(day.ymd.slice(8))}</span>
                    {day.total > 0 ? (
                      <span className="schedule-month__count">{day.total}</span>
                    ) : null}
                  </button>
                  {day.total > 0 ? (
                    <ul className="schedule-month__summary">
                      {STATUS_ORDER.filter((status) => day.byStatus[status]).map((status) => (
                        <li className={`status-${status}`} key={status}>
                          {day.byStatus[status]} {STATUS_META[status].label.toLowerCase()}
                        </li>
                      ))}
                      {day.unassigned > 0 ? <li className="is-unassigned">{day.unassigned} unassigned</li> : null}
                      {day.conflicts > 0 ? <li className="is-conflict">{day.conflicts} overlapping</li> : null}
                    </ul>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
