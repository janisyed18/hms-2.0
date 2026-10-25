import { FormEvent, useEffect, useRef, useState } from "react";
import { CalendarClock, Save, X } from "lucide-react";

import { ActionButton } from "./interaction/ActionButton";
import { ActionNotice } from "./interaction/ActionNotice";
import { Field, RequiredNote } from "./interaction/FormPrimitives";
import { friendlyApiError } from "./interaction/friendlyApiError";
import { focusFirstInvalid, isBlank, useFormErrors, type FieldErrors } from "./interaction/useFormErrors";
import type {
  RetestScheduleRecord,
  RetestScheduleStatus,
  RetestScheduleUpdateValues
} from "../domain/types";
import { assetLabel } from "../utils/identity";

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
  const [saveError, setSaveError] = useState<string | null>(null);
  const { errors, setErrors, clearError, clearAll } = useFormErrors();
  const formRef = useRef<HTMLFormElement>(null);
  const saveLock = useRef(false);

  useEffect(() => {
    if (!schedule) {
      return;
    }
    setDueAt(schedule.dueAt);
    setStatus(schedule.status);
    setReminderIntervalDays(String(schedule.reminderIntervalDays));
    setEscalationIntervalDays(String(schedule.escalationIntervalDays));
    setSaveError(null);
    clearAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (saveLock.current) return;
    setSaveError(null);
    const found: FieldErrors = {};
    const wholeDays = (value: string) => /^\d+$/.test(value.trim()) && Number(value) >= 1;
    if (isBlank(dueAt)) found.dueAt = "Choose the retest due date.";
    if (!wholeDays(reminderIntervalDays)) found.reminder = "Enter a whole number of days, 1 or more.";
    if (!wholeDays(escalationIntervalDays)) found.escalation = "Enter a whole number of days, 1 or more.";
    setErrors(found);
    if (Object.keys(found).length > 0) {
      focusFirstInvalid(formRef.current, ["dueAt", "reminder", "escalation"], found);
      return;
    }
    saveLock.current = true;
    setSaving(true);
    try {
      await onSave({
        dueAt,
        status,
        reminderIntervalDays: Number(reminderIntervalDays),
        escalationIntervalDays: Number(escalationIntervalDays)
      });
    } catch (reason) {
      // The panel keeps what was typed; the schedule on screen is still the saved one.
      const friendly = friendlyApiError(reason, { fallback: "The retest schedule could not be saved. Try again." });
      setSaveError(friendly.message);
      window.setTimeout(() => formRef.current?.querySelector<HTMLElement>(".action-notice")?.focus(), 0);
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }

  return (
    <aside className="inspection-detail-panel" aria-label="Retest schedule detail">
      <div className="inspection-detail-header">
        <div>
          <h2>{assetLabel(schedule.asset)}</h2>
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

      <form className="inspection-detail-form" noValidate onSubmit={handleSave} ref={formRef}>
        {saveError ? <ActionNotice kind="error" title="Retest schedule could not be saved">{saveError}</ActionNotice> : null}
        {canWrite ? <RequiredNote /> : null}
        <Field error={errors.dueAt} label="Retest due date" name="dueAt" required>
          {(props) => <input {...props} aria-label="Retest due date" disabled={!canWrite} type="date" value={dueAt} onChange={(event) => { setDueAt(event.target.value); clearError("dueAt"); }} />}
        </Field>
        <Field label="Retest status" name="status" required>
          {(props) => (
            <select {...props} aria-label="Retest status" disabled={!canWrite} value={status} onChange={(event) => setStatus(event.target.value as RetestScheduleStatus)}>
              {scheduleStatuses.map((scheduleStatus) => <option key={scheduleStatus} value={scheduleStatus}>{scheduleStatus}</option>)}
            </select>
          )}
        </Field>
        <Field error={errors.reminder} label="Reminder interval days" name="reminder" required>
          {(props) => <input {...props} aria-label="Reminder interval days" disabled={!canWrite} inputMode="numeric" min="1" type="number" value={reminderIntervalDays} onChange={(event) => { setReminderIntervalDays(event.target.value); clearError("reminder"); }} />}
        </Field>
        <Field error={errors.escalation} label="Escalation interval days" name="escalation" required>
          {(props) => <input {...props} aria-label="Escalation interval days" disabled={!canWrite} inputMode="numeric" min="1" type="number" value={escalationIntervalDays} onChange={(event) => { setEscalationIntervalDays(event.target.value); clearError("escalation"); }} />}
        </Field>
        <div className="certificate-action-band">
          <CalendarClock aria-hidden="true" size={18} />
          <span>Schedule changes are captured through the HMS audit trail.</span>
        </div>
        {canWrite ? (
          <div className="inspection-action-row">
            <ActionButton pending={isSaving} pendingLabel="Saving…" type="submit" variant="primary">
              <Save aria-hidden="true" size={16} />
              Save schedule
            </ActionButton>
          </div>
        ) : null}
      </form>
    </aside>
  );
}
