import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { CalendarClock, X } from "lucide-react";

import { guardNavigation } from "../routing/navigationGuard";
import { FormSection } from "./forms/FormLayout";
import { FormShell } from "./forms/FormShell";
import { useDirtyTracker } from "./forms/useDirtyTracker";
import { useFormSeed } from "./forms/useFormSeed";
import { useFormSubmit } from "./forms/useFormSubmit";
import { Field } from "./interaction/FormPrimitives";
import { isBlank, type FieldErrors } from "./interaction/useFormErrors";
import type {
  RetestScheduleRecord,
  RetestScheduleStatus,
  RetestScheduleUpdateValues
} from "../domain/types";
import { assetLabel } from "../utils/identity";
import { Select } from "./interaction/Select";

interface RetestScheduleDetailProps {
  canWrite: boolean;
  onClose: () => void;
  onSave: (values: RetestScheduleUpdateValues) => Promise<void>;
  schedule: RetestScheduleRecord | null;
}

const ORDER = ["dueAt", "reminder", "escalation"];
const FIELD_LABELS = { dueAt: "Retest due date", reminder: "Reminder interval days", escalation: "Escalation interval days" };

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
  const formRef = useRef<HTMLFormElement>(null);
  const { dirty, markClean, touch } = useDirtyTracker(JSON.stringify([dueAt, status, reminderIntervalDays, escalationIntervalDays]));
  const seed = useFormSeed({
    dirty,
    sourceKey: schedule?.id ?? null,
    sourceSignature: JSON.stringify(schedule ?? null),
    seed: () => {
      if (!schedule) return;
      setDueAt(schedule.dueAt);
      setStatus(schedule.status);
      setReminderIntervalDays(String(schedule.reminderIntervalDays));
      setEscalationIntervalDays(String(schedule.escalationIntervalDays));
      submission.reset();
      markClean();
    }
  });
  const submission = useFormSubmit({
    fallback: "The retest schedule could not be saved. Try again.",
    formRef,
    isCurrent: seed.isCurrent,
    order: ORDER,
    session: seed.current
  });
  const { clearError, errors } = submission;

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

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    const found: FieldErrors = {};
    const wholeDays = (value: string) => /^\d+$/.test(value.trim()) && Number(value) >= 1;
    if (isBlank(dueAt)) found.dueAt = "Choose the retest due date.";
    if (!wholeDays(reminderIntervalDays)) found.reminder = "Enter a whole number of days, 1 or more.";
    if (!wholeDays(escalationIntervalDays)) found.escalation = "Enter a whole number of days, 1 or more.";
    if (!submission.validate(found)) return;
    // The panel keeps what was typed on a failure; the schedule on screen is still the saved one.
    await submission.run(
      () => onSave({
        dueAt,
        status,
        reminderIntervalDays: Number(reminderIntervalDays),
        escalationIntervalDays: Number(escalationIntervalDays)
      }),
      markClean
    );
  }

  const fields: ReactNode = (
    <FormSection>
      <Field error={errors.dueAt} label="Retest due date" name="dueAt" required>
        {(props) => <input {...props} aria-label="Retest due date" disabled={!canWrite} type="date" value={dueAt} onChange={(event) => { setDueAt(event.target.value); clearError("dueAt"); }} />}
      </Field>
      <Field label="Retest status" name="status" required>
        {(props) => (
          <Select
            {...props}
            aria-label="Retest status"
            disabled={!canWrite}
            onChange={(next) => { setStatus(next as RetestScheduleStatus); touch(); }}
            options={scheduleStatuses.map((scheduleStatus) => ({ value: scheduleStatus, label: scheduleStatus }))}
            value={status}
          />
        )}
      </Field>
      <Field error={errors.reminder} label="Reminder interval days" name="reminder" required>
        {(props) => <input {...props} aria-label="Reminder interval days" disabled={!canWrite} inputMode="numeric" min="1" type="number" value={reminderIntervalDays} onChange={(event) => { setReminderIntervalDays(event.target.value); clearError("reminder"); }} />}
      </Field>
      <Field error={errors.escalation} label="Escalation interval days" name="escalation" required>
        {(props) => <input {...props} aria-label="Escalation interval days" disabled={!canWrite} inputMode="numeric" min="1" type="number" value={escalationIntervalDays} onChange={(event) => { setEscalationIntervalDays(event.target.value); clearError("escalation"); }} />}
      </Field>
    </FormSection>
  );
  const auditNote = (
    <div className="certificate-action-band">
      <CalendarClock aria-hidden="true" size={18} />
      <span>Schedule changes are captured through the HMS audit trail.</span>
    </div>
  );

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
          onClick={() => guardNavigation(onClose)}
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

      {canWrite ? (
        <FormShell
          dirty={dirty}
          errorSummaryTitle="Retest schedule could not be saved"
          errors={errors}
          fieldLabels={FIELD_LABELS}
          fieldOrder={ORDER}
          formClassName="inspection-detail-form"
          formRef={formRef}
          headerClassName="inspection-detail-form__header"
          isSubmitting={submission.isSubmitting}
          layout="inline"
          // Discarding in place puts the saved values back.
          onClose={() => { seed.reseed(); }}
          onEdit={touch}
          onSubmit={handleSave}
          pendingLabel="Saving…"
          submitError={submission.submitError}
          submitLabel="Save schedule"
          title="Retest schedule"
        >
          {fields}
          {auditNote}
        </FormShell>
      ) : (
        <div className="inspection-detail-form">
          {fields}
          {auditNote}
        </div>
      )}
    </aside>
  );
}
