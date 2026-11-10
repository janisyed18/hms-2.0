import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Boxes,
  CalendarClock,
  Check,
  CircleCheck,
  Copy,
  Database,
  ExternalLink,
  FileCheck2,
  FileText,
  Info,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  X
} from "lucide-react";
import type { ComponentType } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { CustomerDeletionState } from "../hooks/useCustomerWorkspace";
import { customerLabel } from "../utils/identity";
import { ActionButton } from "./interaction/ActionButton";
import { ActionNotice } from "./interaction/ActionNotice";

type IconType = ComponentType<{ "aria-hidden"?: boolean; size?: number }>;
type Step = "choose" | "review" | "confirm";

/** The record kinds with their own icon; every other kind uses the plain document icon. */
const IMPACT_ICONS: Record<string, IconType> = {
  assets: Boxes,
  inspection_bookings: CalendarClock,
  inspection_appointments: CalendarClock,
  inspections: ShieldCheck,
  certificates: FileCheck2
};

const STEPS: { id: Step; label: string }[] = [
  { id: "choose", label: "Choose Action" },
  { id: "review", label: "Review & Confirm" },
  { id: "confirm", label: "Complete" }
];

/** "17 Nov 2026, 11:42 am (UTC)": the server stamps deletions in UTC, so the dialog says so. */
function formatUtc(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(date)} (UTC)`;
}

function Stepper({ current }: { current: Step }) {
  const index = STEPS.findIndex((step) => step.id === current);
  return (
    <ol aria-label="Progress" className="removal-steps">
      {STEPS.map((step, position) => (
        <li
          aria-current={position === index ? "step" : undefined}
          className={position < index ? "is-done" : position === index ? "is-current" : undefined}
          key={step.id}
        >
          <span aria-hidden="true" className="removal-steps__dot">{position < index ? <Check size={14} /> : position + 1}</span>
          <span className="removal-steps__label">
            {step.label}
            {position < index ? <span className="sr-only"> (done)</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Remove customer: choose Archive (reversible, recommended) or Delete Customer and Related Data, review the
 * impact the server counted, then confirm by typing the name. Deleting removes the records from active HMS
 * only after the server has written and verified a historical copy; the server repeats every check, so this
 * dialog informs the decision and never replaces the rule.
 */
export function CustomerRemovalDialog({
  onArchive,
  onCancel,
  onConfirm,
  onRetry,
  onViewHistory,
  state
}: {
  onArchive: () => void;
  onCancel: () => void;
  onConfirm: (input: { confirmName: string; reason: string }) => void;
  onRetry: () => void;
  onViewHistory: (batchId: string) => void;
  state: CustomerDeletionState | null;
}) {
  if (!state) return null;
  // Starting again after a fresh review remounts the body so the steps and the typed name reset.
  return createPortal(
    <RemovalBody
      key={state.attempt}
      onArchive={onArchive}
      onCancel={onCancel}
      onConfirm={onConfirm}
      onRetry={onRetry}
      onViewHistory={onViewHistory}
      state={state}
    />,
    document.body
  );
}

function RemovalBody({
  onArchive,
  onCancel,
  onConfirm,
  onRetry,
  onViewHistory,
  state
}: {
  onArchive: () => void;
  onCancel: () => void;
  onConfirm: (input: { confirmName: string; reason: string }) => void;
  onRetry: () => void;
  onViewHistory: (batchId: string) => void;
  state: CustomerDeletionState;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const ids = useId();
  const { check, checkError, actionError, customer, pending, result } = state;
  const name = customerLabel(customer);
  const [step, setStep] = useState<Step>(state.startAt);
  const [choice, setChoice] = useState<"archive" | "delete" | null>(null);
  const [typed, setTyped] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [reason, setReason] = useState("");
  const [copied, setCopied] = useState(false);
  const alreadyArchived = check?.archived === true;
  // Archive is the recommended default, unless the customer already is archived.
  const selected = choice ?? (alreadyArchived ? "delete" : "archive");
  const nameMatches = check !== null && typed.trim() === check.customerName.trim();
  const busy = pending !== null;

  // Focus moves to the first control of each step, and returns to the opener when the dialog closes.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);
  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
  }, [step, result]);

  function trapKeys(event: React.KeyboardEvent) {
    event.stopPropagation();
    if (event.key === "Escape" && !busy) onCancel();
    if (event.key !== "Tab" || !dialog.current) return;
    const controls = Array.from(dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled)"));
    if (controls.length === 0) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const shell = (title: string, subtitle: string | null, tone: "danger" | "success", body: React.ReactNode, closeable = true) => (
    <div className="confirm-backdrop confirm-backdrop--elevated" role="presentation">
      <div
        aria-busy={busy || (check === null && !checkError) ? true : undefined}
        aria-labelledby={`${ids}-title`}
        aria-modal="true"
        className="confirm-dialog customer-removal"
        onKeyDown={trapKeys}
        ref={dialog}
        role="alertdialog"
      >
        <header className="change-inspector__header">
          <span aria-hidden="true" className={`dialog-icon dialog-icon--${tone}`}>
            {tone === "success" ? <CircleCheck size={22} /> : <Trash2 size={20} />}
          </span>
          <div>
            <h2 id={`${ids}-title`}>{title}</h2>
            {subtitle ? <p className="field-hint">{subtitle}</p> : null}
          </div>
          {closeable ? (
            <button aria-label="Close dialog" className="dialog-close" disabled={busy} onClick={onCancel} type="button">
              <X aria-hidden="true" size={18} />
            </button>
          ) : null}
        </header>
        {body}
      </div>
    </div>
  );

  // Completed: the records are out of active HMS and the archive is verified.
  if (result) {
    return shell(
      "Customer Deleted Successfully",
      null,
      "success",
      <>
        <p role="status">
          <strong>{name}</strong> has been removed from active HMS. A complete historical copy ({result.totalRecords} related records
          {result.evidenceFiles > 0 ? `, ${result.evidenceFiles} files` : ""}) has been saved in Deleted Customers (History).
        </p>
        <dl className="removal-facts">
          <div>
            <dt>Deletion ID</dt>
            <dd>
              <span>{result.deletionNumber}</span>
              <button
                aria-label={copied ? "Deletion ID copied" : "Copy deletion ID"}
                className="dialog-close"
                onClick={() => {
                  void navigator.clipboard?.writeText(result.deletionNumber).then(() => setCopied(true)).catch(() => undefined);
                }}
                type="button"
              >
                {copied ? <Check aria-hidden="true" size={16} /> : <Copy aria-hidden="true" size={16} />}
              </button>
            </dd>
          </div>
          <div><dt>Deleted by</dt><dd>{result.actorName} (Super Admin)</dd></div>
          <div><dt>Deleted on</dt><dd>{formatUtc(result.deletedAt)}</dd></div>
          <div><dt>Historical records</dt><dd>{result.totalRecords + 1} records (available in History)</dd></div>
        </dl>
        <div className="confirm-dialog__actions">
          <ActionButton onClick={() => onViewHistory(result.id)} variant="secondary">
            View in History <ExternalLink aria-hidden="true" size={15} />
          </ActionButton>
          <ActionButton data-initial-focus onClick={onCancel} variant="primary">Done</ActionButton>
        </div>
      </>,
      false
    );
  }

  const loading = check === null && !checkError;
  const blocked = check !== null && !check.canDelete;

  const notices = (
    <>
      {loading ? <p className="field-hint" role="status">Checking what this customer is linked to…</p> : null}
      {checkError ? <ActionNotice kind="error" title="Could not check this customer">{checkError}</ActionNotice> : null}
      {actionError ? <ActionNotice kind="error" title="Nothing was removed">{actionError}</ActionNotice> : null}
    </>
  );

  if (step === "choose") {
    return shell(
      "Remove Customer",
      `Choose how you want to remove ${name} from HMS.`,
      "danger",
      <>
        <Stepper current="choose" />
        {notices}
        <fieldset className="removal-options" disabled={busy}>
          <legend className="sr-only">How to remove this customer</legend>
          <label className={`removal-option${selected === "archive" ? " is-selected" : ""}${alreadyArchived ? " is-disabled" : ""}`}>
            <span aria-hidden="true" className="removal-option__icon"><Archive size={20} /></span>
            <span className="removal-option__text">
              <strong>
                Archive Customer
                {alreadyArchived ? <span className="removal-tag">Already archived</span> : <span className="removal-tag removal-tag--info">Recommended</span>}
              </strong>
              <span>Remove from active workflows. Keep all assets, inspections, bookings, certificates and history. You can restore it later.</span>
            </span>
            <input
              checked={selected === "archive"}
              data-initial-focus={!alreadyArchived ? true : undefined}
              disabled={alreadyArchived}
              name={`${ids}-action`}
              onChange={() => setChoice("archive")}
              type="radio"
            />
          </label>
          <label className={`removal-option removal-option--danger${selected === "delete" ? " is-selected" : ""}`}>
            <span aria-hidden="true" className="removal-option__icon removal-option__icon--danger"><Trash2 size={20} /></span>
            <span className="removal-option__text">
              <strong>Delete Customer and Related Data</strong>
              <span>
                Remove the customer and its associated records from active HMS. A complete historical copy is kept in Deleted Customers (History) for audit and future reference.
              </span>
            </span>
            <input
              checked={selected === "delete"}
              data-initial-focus={alreadyArchived ? true : undefined}
              name={`${ids}-action`}
              onChange={() => setChoice("delete")}
              type="radio"
            />
          </label>
        </fieldset>
        <div className="removal-note" role="note">
          <Info aria-hidden="true" size={18} />
          <p>A verified historical copy, including inspections and certificates, is created before anything is removed. If it cannot be created, nothing is removed.</p>
        </div>
        <div className="confirm-dialog__actions">
          <ActionButton disabled={busy} onClick={onCancel} variant="ghost">Cancel</ActionButton>
          {checkError ? <ActionButton onClick={onRetry} variant="secondary">Try again</ActionButton> : null}
          {selected === "archive" ? (
            <ActionButton disabled={loading || checkError !== null} onClick={onArchive} pending={pending === "archiving"} pendingLabel="Archiving…" variant="primary">
              Archive customer
            </ActionButton>
          ) : (
            <ActionButton disabled={loading || checkError !== null} onClick={() => setStep("review")} variant="primary">
              Continue <ArrowRight aria-hidden="true" size={16} />
            </ActionButton>
          )}
        </div>
      </>
    );
  }

  if (step === "review") {
    return shell(
      "Delete Customer and Related Data",
      "Review the impact and records that will be removed from active HMS.",
      "danger",
      <>
        <Stepper current="review" />
        {notices}
        <div className="change-inspector__warning" role="note">
          <TriangleAlert aria-hidden="true" size={18} />
          <p>
            <strong>This action removes {name} from active HMS.</strong> All selected records are removed from operational use, but a complete historical copy is kept in Deleted Customers (History).
          </p>
        </div>
        {check ? (
          <section aria-labelledby={`${ids}-impact`} className="removal-impact">
            <header>
              <h3 id={`${ids}-impact`}><Database aria-hidden="true" size={16} /> Deletion Impact</h3>
              <span className="customer-delete__count">Total Records: {check.totalRecords}</span>
            </header>
            {check.items.length > 0 ? (
              <ul aria-label="Records to be removed from active HMS">
                {check.items.map((item) => {
                  const Icon = IMPACT_ICONS[item.kind] ?? FileText;
                  return (
                    <li key={item.kind}>
                      <Icon aria-hidden size={16} />
                      <span className="customer-delete__label">{item.label}</span>
                      <span className="customer-delete__count">{item.count}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="field-hint">No other records are linked to this customer.</p>
            )}
          </section>
        ) : null}
        {blocked ? (
          <ActionNotice kind="error" title="Linked records outside this customer">
            These records still refer to it, so it cannot be deleted: {check.blockers.map((blocker) => `${blocker.count} ${blocker.label}`).join(", ")}.
          </ActionNotice>
        ) : (
          <div className="removal-note removal-note--success" role="note">
            <CircleCheck aria-hidden="true" size={18} />
            <p>
              A full historical snapshot will be created, including customer details, associated records
              {check && check.evidenceFiles > 0 ? `, ${check.evidenceFiles} documents and certificates` : ""}. Shared records such as products and user accounts are not removed.
            </p>
          </div>
        )}
        <div className="confirm-dialog__actions">
          <ActionButton data-initial-focus onClick={() => setStep("choose")} variant="ghost"><ArrowLeft aria-hidden="true" size={16} /> Back</ActionButton>
          <ActionButton disabled={!check || blocked} onClick={() => setStep("confirm")} variant="primary">
            Continue <ArrowRight aria-hidden="true" size={16} />
          </ActionButton>
        </div>
      </>
    );
  }

  const fieldId = `${ids}-name`;
  return shell(
    "Confirm Deletion",
    "To proceed, confirm by typing the customer name below.",
    "danger",
    <>
      <Stepper current="confirm" />
      <div className="removal-final" role="note">
        <Trash2 aria-hidden="true" size={20} />
        <div>
          <strong>Final Confirmation</strong>
          <p>
            You are about to delete <strong>{name}</strong> and <strong>{check?.totalRecords ?? 0} related records</strong> from active HMS. A verified historical copy is created first.
          </p>
        </div>
      </div>
      {actionError ? <ActionNotice kind="error" title="Nothing was removed">{actionError}</ActionNotice> : null}
      <div className="field">
        <label htmlFor={fieldId}>Type the customer name to confirm <span aria-hidden="true" className="change-inspector__required">*</span></label>
        <div className={`removal-input${nameMatches ? " is-valid" : ""}`}>
          <input
            aria-describedby={`${fieldId}-hint`}
            aria-required="true"
            autoComplete="off"
            data-initial-focus
            disabled={busy}
            id={fieldId}
            onChange={(event) => setTyped(event.target.value)}
            spellCheck={false}
            value={typed}
          />
          {nameMatches ? <Check aria-hidden="true" size={18} /> : null}
        </div>
        <p className="field-hint" id={`${fieldId}-hint`}>
          {nameMatches ? "The name matches." : `Type ${check?.customerName ?? name} exactly as shown.`}
        </p>
      </div>
      <div className="field">
        <label htmlFor={`${ids}-reason`}>Reason (optional)</label>
        <textarea disabled={busy} id={`${ids}-reason`} maxLength={1000} onChange={(event) => setReason(event.target.value)} rows={2} value={reason} />
      </div>
      <label className="removal-ack">
        <input checked={acknowledged} disabled={busy} onChange={(event) => setAcknowledged(event.target.checked)} type="checkbox" />
        <span>I understand that this will remove the customer and all associated records from active HMS, and a historical copy will be retained for audit and future reference.</span>
      </label>
      {pending === "deleting" ? (
        <p className="field-hint" role="status">Creating and verifying the historical copy, then removing the records. Keep this window open.</p>
      ) : null}
      <div className="confirm-dialog__actions">
        <ActionButton disabled={busy} onClick={() => setStep("review")} variant="ghost"><ArrowLeft aria-hidden="true" size={16} /> Back</ActionButton>
        <ActionButton
          disabled={!nameMatches || !acknowledged}
          onClick={() => onConfirm({ confirmName: typed, reason })}
          pending={pending === "deleting"}
          pendingLabel="Deleting…"
          variant="danger"
        >
          <Trash2 aria-hidden="true" size={16} /> Delete Customer
        </ActionButton>
      </div>
    </>
  );
}
