import {
  AlertTriangle,
  CalendarDays,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  CirclePause,
  Clock3,
  Ellipsis,
  ListChecks,
  X,
  type LucideIcon
} from "lucide-react";
import { useMemo, useState } from "react";

import { ModuleTable, type ModuleColumn } from "./ModuleTable";
import { RetestScheduleDetail } from "./RetestScheduleDetail";
import {
  type RetestScheduleStatusFilter,
  useRetestScheduleWorkspace
} from "../hooks/useRetestScheduleWorkspace";
import type { RetestScheduleRecord, RetestScheduleStatus } from "../domain/types";
import { StaggerGroup, StaggerItem } from "../motion/MotionPrimitives";

const statusFilters: Array<{ label: string; value: RetestScheduleStatusFilter }> = [
  { label: "All schedules", value: "ALL" },
  { label: "Overdue", value: "OVERDUE" },
  { label: "Due soon", value: "DUE" },
  { label: "Upcoming", value: "UPCOMING" },
  { label: "Suspended", value: "SUSPENDED" }
];

const calendarWeekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const statusPriority: Record<RetestScheduleStatus, number> = {
  OVERDUE: 0,
  DUE: 1,
  UPCOMING: 2,
  SUSPENDED: 3
};

function statusClass(status: RetestScheduleStatus) {
  if (status === "OVERDUE") {
    return "mini-status overdue";
  }
  if (status === "DUE") {
    return "mini-status due-soon";
  }
  if (status === "SUSPENDED") {
    return "mini-status status-review";
  }
  return "mini-status current";
}

function countByStatus(schedules: RetestScheduleRecord[], status: RetestScheduleStatus) {
  return schedules.filter((schedule) => schedule.status === status).length;
}

function toDate(value: string) {
  return new Date(`${value}T00:00:00`);
}

function toDateKey(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dueSummary(schedule: RetestScheduleRecord) {
  if (schedule.status === "SUSPENDED") {
    return "On hold";
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((toDate(schedule.dueAt).getTime() - today.getTime()) / 86_400_000);
  if (days < 0) {
    return `${Math.abs(days)} days overdue`;
  }
  if (days === 0) {
    return "Due today";
  }
  return `Due in ${days} days`;
}

function calendarStatus(schedules: RetestScheduleRecord[]) {
  return schedules.reduce<RetestScheduleStatus | null>((current, schedule) => (
    !current || statusPriority[schedule.status] < statusPriority[current] ? schedule.status : current
  ), null);
}

function calendarDates(month: Date) {
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const firstDay = new Date(year, monthIndex, 1);
  const leadingDays = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const cellCount = Math.ceil((leadingDays + daysInMonth) / 7) * 7;

  return Array.from({ length: cellCount }, (_, index) => {
    const date = new Date(year, monthIndex, index - leadingDays + 1);
    return { date, inMonth: date.getMonth() === monthIndex };
  });
}

export function RetestScheduleWorkspace({ canWrite }: { canWrite: boolean }) {
  const workspace = useRetestScheduleWorkspace();
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  });
  const overdueCount = countByStatus(workspace.schedules, "OVERDUE");
  const dueCount = countByStatus(workspace.schedules, "DUE");
  const upcomingCount = countByStatus(workspace.schedules, "UPCOMING");
  const suspendedCount = countByStatus(workspace.schedules, "SUSPENDED");
  const schedulesByDate = useMemo(() => {
    const scheduleMap = new Map<string, RetestScheduleRecord[]>();
    workspace.schedules.forEach((schedule) => {
      const current = scheduleMap.get(schedule.dueAt) ?? [];
      current.push(schedule);
      scheduleMap.set(schedule.dueAt, current);
    });
    return scheduleMap;
  }, [workspace.schedules]);
  const prioritySchedules = useMemo(
    () => [...workspace.schedules]
      .sort((left, right) => statusPriority[left.status] - statusPriority[right.status] || left.dueAt.localeCompare(right.dueAt))
      .slice(0, 4),
    [workspace.schedules]
  );
  const selectedCalendarDate = workspace.dueFrom === workspace.dueTo ? workspace.dueFrom : "";

  const columns: ModuleColumn<RetestScheduleRecord>[] = [
    {
      header: "Asset",
      render: (schedule) => <strong>{schedule.asset.assetNumber}</strong>
    },
    {
      header: "Customer",
      render: (schedule) => schedule.customer.name
    },
    {
      header: "Product",
      render: (schedule) => schedule.product.name
    },
    {
      header: "Retest due",
      render: (schedule) => (
        <span className="retest-due-cell">
          <strong>{schedule.dueAt}</strong>
          <small className={`retest-due-${schedule.status.toLowerCase()}`}>{dueSummary(schedule)}</small>
        </span>
      )
    },
    {
      header: "Reminder",
      render: (schedule) => `${schedule.reminderIntervalDays} days`
    },
    {
      header: "Escalation",
      render: (schedule) => `${schedule.escalationIntervalDays} days`
    },
    {
      header: "Status",
      render: (schedule) => (
        <span className={statusClass(schedule.status)}>{schedule.status}</span>
      )
    },
    {
      header: "Actions",
      render: (schedule) => (
        <span className="row-actions">
          <button
            aria-label={`Open schedule ${schedule.asset.assetNumber}`}
            className="icon-button light"
            onClick={() => workspace.openDetail(schedule)}
            type="button"
          >
            <Ellipsis aria-hidden="true" size={18} />
          </button>
        </span>
      )
    }
  ];

  function selectCalendarDate(date: Date) {
    const dateKey = toDateKey(date);
    if (selectedCalendarDate === dateKey) {
      workspace.clearDateFilters();
      return;
    }
    workspace.setDueFrom(dateKey);
    workspace.setDueTo(dateKey);
  }

  return (
    <section className="asset-register-workspace retest-schedule-workspace" aria-labelledby="retest-schedule-heading">
      <header className="asset-register-header retest-schedule-header">
        <div>
          <span className="asset-register-eyebrow">Retest schedule</span>
          <h2 id="retest-schedule-heading">Retest readiness</h2>
          <p>Plan hose assembly retests, reminder cadence, and escalation timing.</p>
        </div>
        <div className="asset-register-context" aria-label="Current retest schedule scope">
          <CalendarRange aria-hidden="true" size={23} />
          <span>
            <strong>{workspace.schedules.length} schedule{workspace.schedules.length === 1 ? "" : "s"}</strong>
            <small>{workspace.visibleSchedules.length} matching the current view</small>
          </span>
        </div>
      </header>

      <section aria-label="Retest schedule overview">
        <StaggerGroup className="asset-register-metrics retest-schedule-metrics">
          <RetestMetric icon={AlertTriangle} label="Overdue" value={overdueCount} detail="Past the retest due date" tone="red" />
          <RetestMetric icon={Clock3} label="Due soon" value={dueCount} detail="Requires near-term planning" tone="amber" />
          <RetestMetric icon={CalendarDays} label="Upcoming" value={upcomingCount} detail="Scheduled for a future date" tone="blue" />
          <RetestMetric icon={CirclePause} label="Suspended" value={suspendedCount} detail="Manually held schedules" tone="green" />
        </StaggerGroup>
      </section>

      <div className="inspection-filter-tabs retest-filter-tabs" role="tablist" aria-label="Retest status filters">
        {statusFilters.map((filter) => (
          <button
            aria-selected={workspace.statusFilter === filter.value}
            className={workspace.statusFilter === filter.value ? "is-active" : ""}
            key={filter.value}
            onClick={() => workspace.setStatusFilter(filter.value)}
            role="tab"
            type="button"
          >
            {filter.label}
          </button>
        ))}
      </div>

      <div className="retest-schedule-layout">
        <div className="retest-schedule-primary">
          <ModuleTable
            actionLabel="Open schedule"
            actionsInToolbar
            className="asset-register-table retest-register-table"
            columns={columns}
            countLabel={`${workspace.visibleSchedules.length} schedules`}
            emptyLabel="No retest schedules match the current filters."
            exportRows={(schedule) => [
              schedule.asset.assetNumber,
              schedule.customer.name,
              schedule.product.name,
              schedule.dueAt,
              dueSummary(schedule),
              String(schedule.reminderIntervalDays),
              String(schedule.escalationIntervalDays),
              schedule.status,
              ""
            ]}
            activeFilterCount={workspace.activeFilterCount}
            filterControls={
              <>
                <label className="filter-field">
                  <span>Due from</span>
                  <span className="date-input-shell">
                    <input
                      aria-label="Retest due from"
                      type="date"
                      value={workspace.dueFrom}
                      onChange={(event) => workspace.setDueFrom(event.target.value)}
                    />
                    {!workspace.dueFrom ? <span aria-hidden="true" className="date-input-placeholder">Select date</span> : null}
                    <CalendarDays aria-hidden="true" size={17} />
                  </span>
                </label>
                <label className="filter-field">
                  <span>Due to</span>
                  <span className="date-input-shell">
                    <input
                      aria-label="Retest due to"
                      type="date"
                      value={workspace.dueTo}
                      onChange={(event) => workspace.setDueTo(event.target.value)}
                    />
                    {!workspace.dueTo ? <span aria-hidden="true" className="date-input-placeholder">Select date</span> : null}
                    <CalendarDays aria-hidden="true" size={17} />
                  </span>
                </label>
                <button className="secondary-button filter-clear" type="button" onClick={workspace.clearDateFilters}>
                  Clear date filters
                </button>
              </>
            }
            getRowKey={(schedule) => schedule.id}
            items={workspace.visibleSchedules}
            onAction={() => {
              const firstSchedule = workspace.visibleSchedules[0];
              if (firstSchedule) {
                workspace.openDetail(firstSchedule);
              }
            }}
            onQueryChange={workspace.setQuery}
            onRowSelect={workspace.openDetail}
            query={workspace.query}
            searchLabel="Search retest schedules"
            searchPlaceholder="Search schedules, assets, customers..."
            selectedRowKey={workspace.selectedSchedule?.id}
            tableLabel="Retest schedule records"
          />
          {workspace.selectedSchedule ? (
            <RetestScheduleDetail
              canWrite={canWrite}
              onClose={workspace.closeDetail}
              onSave={workspace.saveSchedule}
              schedule={workspace.selectedSchedule}
            />
          ) : null}
        </div>

        <aside className="retest-schedule-rail" aria-label="Retest calendar">
          <section className="retest-calendar-panel" aria-labelledby="retest-calendar-heading">
            <header>
              <div>
                <h3 id="retest-calendar-heading">Schedule activity</h3>
                <p>Dates reflect the current retest register.</p>
              </div>
              <CalendarDays aria-hidden="true" size={19} />
            </header>
            <div className="retest-calendar-month">
              <strong>{calendarMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</strong>
              <span>
                <button
                  aria-label="Previous calendar month"
                  className="icon-button light"
                  onClick={() => setCalendarMonth((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1))}
                  type="button"
                >
                  <ChevronLeft aria-hidden="true" size={17} />
                </button>
                <button
                  aria-label="Next calendar month"
                  className="icon-button light"
                  onClick={() => setCalendarMonth((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1))}
                  type="button"
                >
                  <ChevronRight aria-hidden="true" size={17} />
                </button>
                {selectedCalendarDate ? (
                  <button
                    aria-label="Clear calendar date filter"
                    className="icon-button light"
                    onClick={workspace.clearDateFilters}
                    type="button"
                  >
                    <X aria-hidden="true" size={16} />
                  </button>
                ) : null}
              </span>
            </div>
            <div className="retest-calendar-weekdays" aria-hidden="true">
              {calendarWeekdays.map((weekday) => <span key={weekday}>{weekday}</span>)}
            </div>
            <div className="retest-calendar-grid">
              {calendarDates(calendarMonth).map(({ date, inMonth }) => {
                const dateKey = toDateKey(date);
                const daySchedules = schedulesByDate.get(dateKey) ?? [];
                const dayStatus = calendarStatus(daySchedules);
                const isSelected = selectedCalendarDate === dateKey;
                return (
                  <button
                    aria-label={`${date.toLocaleDateString(undefined, { dateStyle: "full" })}${daySchedules.length ? `, ${daySchedules.length} schedule${daySchedules.length === 1 ? "" : "s"}` : ""}`}
                    aria-pressed={isSelected}
                    className={`retest-calendar-day${inMonth ? "" : " is-outside"}${isSelected ? " is-selected" : ""}`}
                    key={dateKey}
                    onClick={() => selectCalendarDate(date)}
                    type="button"
                  >
                    <span>{date.getDate()}</span>
                    {dayStatus ? <i aria-hidden="true" className={`retest-calendar-dot ${dayStatus.toLowerCase()}`} /> : null}
                  </button>
                );
              })}
            </div>
            <div className="retest-calendar-legend" aria-label="Calendar status legend">
              <span><i className="overdue" />Overdue</span>
              <span><i className="due" />Due soon</span>
              <span><i className="upcoming" />Upcoming</span>
              <span><i className="suspended" />Suspended</span>
            </div>
          </section>

          <section className="retest-priorities-panel" aria-labelledby="retest-priorities-heading">
            <header>
              <div>
                <h3 id="retest-priorities-heading">Retest priorities</h3>
                <p>Ordered by current schedule status.</p>
              </div>
              <ListChecks aria-hidden="true" size={19} />
            </header>
            {prioritySchedules.length ? (
              <div className="retest-priority-list">
                {prioritySchedules.map((schedule) => (
                  <button key={schedule.id} onClick={() => workspace.openDetail(schedule)} type="button">
                    <span className={`retest-priority-marker ${schedule.status.toLowerCase()}`} aria-hidden="true" />
                    <span>
                      <strong>{schedule.asset.assetNumber}</strong>
                      <small>{schedule.customer.name} · {schedule.product.name}</small>
                    </span>
                    <em className={`retest-due-${schedule.status.toLowerCase()}`}>{dueSummary(schedule)}</em>
                  </button>
                ))}
              </div>
            ) : (
              <p className="retest-priority-empty">No retest schedules are currently recorded.</p>
            )}
          </section>
        </aside>
      </div>
    </section>
  );
}

function RetestMetric({
  detail,
  icon: Icon,
  label,
  tone,
  value
}: {
  detail: string;
  icon: LucideIcon;
  label: string;
  tone: "amber" | "blue" | "green" | "red";
  value: number;
}) {
  return (
    <StaggerItem className={`asset-register-metric tone-${tone}`}>
      <Icon aria-hidden="true" size={22} />
      <span>
        <small>{label}</small>
        <strong>{value}</strong>
        <em>{detail}</em>
      </span>
    </StaggerItem>
  );
}
