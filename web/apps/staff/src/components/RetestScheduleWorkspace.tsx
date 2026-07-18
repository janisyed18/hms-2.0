import {
  AlertTriangle,
  CheckCircle2,
  CirclePause,
  Clock3,
} from "lucide-react";

import { ModuleTable, type ModuleColumn } from "./ModuleTable";
import { RetestScheduleDetail } from "./RetestScheduleDetail";
import {
  type RetestScheduleStatusFilter,
  useRetestScheduleWorkspace
} from "../hooks/useRetestScheduleWorkspace";
import type { RetestScheduleRecord, RetestScheduleStatus } from "../domain/types";

const statusFilters: Array<{ label: string; value: RetestScheduleStatusFilter }> = [
  { label: "All", value: "ALL" },
  { label: "Overdue", value: "OVERDUE" },
  { label: "Due", value: "DUE" },
  { label: "Upcoming", value: "UPCOMING" },
  { label: "Suspended", value: "SUSPENDED" }
];

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

function countByStatus(
  schedules: RetestScheduleRecord[],
  status: RetestScheduleStatus
) {
  return schedules.filter((schedule) => schedule.status === status).length;
}

export function RetestScheduleWorkspace({ canWrite }: { canWrite: boolean }) {
  const workspace = useRetestScheduleWorkspace();
  const overdueCount = countByStatus(workspace.schedules, "OVERDUE");
  const dueCount = countByStatus(workspace.schedules, "DUE");
  const upcomingCount = countByStatus(workspace.schedules, "UPCOMING");
  const suspendedCount = countByStatus(workspace.schedules, "SUSPENDED");

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
      header: "Retest Due",
      render: (schedule) => schedule.dueAt
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
            onClick={() => workspace.openDetail(schedule)}
            type="button"
          >
            Open
          </button>
        </span>
      )
    }
  ];

  return (
    <section className="inspection-workspace" aria-label="Retest schedule workspace">
      <div className="inspection-dashboard">
        <div className="inspection-dashboard-heading">
          <div>
            <h2>Schedule Overview</h2>
            <p>Plan hose assembly retest dates, reminders, and escalation timing.</p>
          </div>
        </div>
        <div className="inspection-metrics" aria-label="Retest schedule metrics">
          <div>
            <AlertTriangle aria-hidden="true" size={18} />
            <span>Overdue</span>
            <strong>{overdueCount}</strong>
          </div>
          <div>
            <Clock3 aria-hidden="true" size={18} />
            <span>Due</span>
            <strong>{dueCount}</strong>
          </div>
          <div>
            <CheckCircle2 aria-hidden="true" size={18} />
            <span>Upcoming</span>
            <strong>{upcomingCount}</strong>
          </div>
          <div>
            <CirclePause aria-hidden="true" size={18} />
            <span>Suspended</span>
            <strong>{suspendedCount}</strong>
          </div>
        </div>
        <div className="inspection-filter-tabs" role="tablist" aria-label="Retest status filters">
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
      </div>

      <div className="inspection-layout">
        <div className="inspection-table-wrap">
          <ModuleTable
            actionLabel="Open Schedule"
            columns={columns}
            countLabel={`${workspace.visibleSchedules.length} schedules`}
            emptyLabel="No retest schedules match the current filters."
            exportRows={(schedule) => [
              schedule.asset.assetNumber,
              schedule.customer.name,
              schedule.product.name,
              schedule.dueAt,
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
                  <input
                    aria-label="Retest due from"
                    type="date"
                    value={workspace.dueFrom}
                    onChange={(event) => workspace.setDueFrom(event.target.value)}
                  />
                </label>
                <label className="filter-field">
                  <span>Due to</span>
                  <input
                    aria-label="Retest due to"
                    type="date"
                    value={workspace.dueTo}
                    onChange={(event) => workspace.setDueTo(event.target.value)}
                  />
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
            query={workspace.query}
            searchLabel="Search retest schedules"
            searchPlaceholder="Search schedules..."
            tableLabel="Retest schedule records"
          />
        </div>
        <RetestScheduleDetail
          canWrite={canWrite}
          onClose={workspace.closeDetail}
          onSave={workspace.saveSchedule}
          schedule={workspace.selectedSchedule}
        />
      </div>
    </section>
  );
}
