import { FormEvent, useEffect, useState } from "react";
import { CalendarClock, Save, X } from "lucide-react";

import type {
  RetestScheduleRecord,
  RetestScheduleStatus,
  RetestScheduleUpdateValues
} from "../domain/types";

interface RetestScheduleDetailProps {
  canWrite: boolean;
  onClose: () => void;
  onSave: (values: RetestScheduleUpdateValues) => Promise<void>;
  schedule: RetestScheduleRecord | null;
}

const scheduleStatuses: RetestScheduleStatus[] = [
  "UPCOMING",
  "DUE",
  "OVERDUE",
  "SUSPENDED"
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

export function RetestScheduleDetail({
  canWrite,
  onClose,
  onSave,
  schedule
}: RetestScheduleDetailProps) {
  const [dueAt, setDueAt] = useState("");
  const [status, setStatus] = useState<RetestScheduleStatus>("UPCOMING");
  const [reminderIntervalDays, setReminderIntervalDays] = useState("30");
  const [escalationIntervalDays, setEscalationIntervalDays] = useState("7");
  const [isSaving, setSaving] = useState(false);

  useEffect(() => {
    if (!schedule) {
      return;
    }
    setDueAt(schedule.dueAt);
    setStatus(schedule.status);
    setReminderIntervalDays(String(schedule.reminderIntervalDays));
    setEscalationIntervalDays(String(schedule.escalationIntervalDays));
  }, [schedule]);

  if (!schedule) {
    return (
      <aside className="inspection-detail-panel" aria-label="Retest schedule detail">
        <div className="empty-detail">
          <strong>Select a retest schedule</strong>
          <span>Open a row to review due dates and reminder cadence.</span>
        </div>
      </aside>
    );
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    await onSave({
      dueAt,
      status,
      reminderIntervalDays: Number(reminderIntervalDays),
      escalationIntervalDays: Number(escalationIntervalDays)
    });
    setSaving(false);
  }

  return (
    <aside className="inspection-detail-panel" aria-label="Retest schedule detail">
      <div className="inspection-detail-header">
        <div>
          <h2>{schedule.asset.assetNumber}</h2>
          <p>{schedule.customer.name} / {schedule.product.name}</p>
        </div>
        <button
          aria-label="Close retest schedule detail"
          className="icon-button light"
          onClick={onClose}
          type="button"
        >
          <X size={18} />
        </button>
      </div>

      <div className="inspection-detail-strip">
        <span className={statusClass(schedule.status)}>{schedule.status}</span>
        <span>Due {schedule.dueAt}</span>
        <span>{schedule.product.category}</span>
      </div>

      <div className="inspection-facts">
        <div>
          <span>Customer</span>
          <strong>{schedule.customer.name}</strong>
        </div>
        <div>
          <span>Asset tag</span>
          <strong>{schedule.asset.tag ?? "Not set"}</strong>
        </div>
        <div>
          <span>Last reminded</span>
          <strong>{schedule.lastRemindedAt ?? "Not sent"}</strong>
        </div>
        <div>
          <span>Escalated</span>
          <strong>{schedule.escalatedAt ?? "Not escalated"}</strong>
        </div>
      </div>

      <form className="inspection-detail-form" onSubmit={handleSave}>
        <label>
          <span>Retest due date</span>
          <input
            aria-label="Retest due date"
            disabled={!canWrite}
            type="date"
            value={dueAt}
            onChange={(event) => setDueAt(event.target.value)}
          />
        </label>
        <label>
          <span>Retest status</span>
          <select
            aria-label="Retest status"
            disabled={!canWrite}
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as RetestScheduleStatus)
            }
          >
            {scheduleStatuses.map((scheduleStatus) => (
              <option key={scheduleStatus} value={scheduleStatus}>
                {scheduleStatus}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Reminder interval days</span>
          <input
            aria-label="Reminder interval days"
            disabled={!canWrite}
            inputMode="numeric"
            min="1"
            type="number"
            value={reminderIntervalDays}
            onChange={(event) => setReminderIntervalDays(event.target.value)}
          />
        </label>
        <label>
          <span>Escalation interval days</span>
          <input
            aria-label="Escalation interval days"
            disabled={!canWrite}
            inputMode="numeric"
            min="1"
            type="number"
            value={escalationIntervalDays}
            onChange={(event) => setEscalationIntervalDays(event.target.value)}
          />
        </label>
        <div className="certificate-action-band">
          <CalendarClock aria-hidden="true" size={18} />
          <span>Schedule changes are captured through the HMS audit trail.</span>
        </div>
        {canWrite ? (
          <div className="inspection-action-row">
            <button className="primary-button" disabled={isSaving} type="submit">
              <Save aria-hidden="true" size={16} />
              {isSaving ? "Saving..." : "Save schedule"}
            </button>
          </div>
        ) : null}
      </form>
    </aside>
  );
}
