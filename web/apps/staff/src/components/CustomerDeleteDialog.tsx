import { Boxes, CalendarClock, ChevronRight, Link2, Package, Trash2, TriangleAlert, Users, X } from "lucide-react";
import type { ComponentType } from "react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import type { CustomerDeletionState } from "../hooks/useCustomerWorkspace";
import { customerLabel } from "../utils/identity";
import { ActionButton } from "./interaction/ActionButton";
import { ActionNotice } from "./interaction/ActionNotice";

/** The linked-record kinds that have a page to go to, and the icon that marks each row. */
export const LINKED_RECORD_ICONS: Record<string, ComponentType<{ "aria-hidden"?: boolean; size?: number }>> = {
  assets: Boxes,
  inspection_bookings: CalendarClock,
  inspection_appointments: CalendarClock,
  products: Package,
  users: Users,
  user_customer_accesses: Users
};

/**
 * Delete customer in one place: it first shows what the server says is linked, then either confirms a
 * permanent delete (nothing linked) or explains what blocks it and offers Archive as the safe alternative.
 * The server repeats the check when deleting, so this dialog informs the choice and never replaces the rule.
 */
export function CustomerDeleteDialog({
  onArchive,
  onCancel,
  onConfirm,
  onOpenLinked,
  onRetry,
  state
}: {
  onArchive: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  /** Opens the page behind a linked-record row: the whole list for that kind, or one named record. Null when that kind has no page. */
  onOpenLinked: (kind: string, recordId: string | null) => boolean;
  onRetry: () => void;
  state: CustomerDeletionState | null;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const open = state !== null;
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open]);
  if (!state) return null;

  const { check, checkError, actionError, customer, pending } = state;
  const name = customerLabel(customer);
  const blocked = check !== null && !check.canDelete;

  return createPortal(
    <div className="confirm-backdrop confirm-backdrop--elevated" role="presentation">
      <div
        aria-busy={check === null && !checkError ? true : undefined}
        aria-labelledby="customer-delete-title"
        aria-modal="true"
        className="confirm-dialog customer-delete"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape" && !pending) onCancel();
          if (event.key !== "Tab" || !dialog.current) return;
          const controls = Array.from(dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled)"));
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
        }}
        ref={dialog}
        role="alertdialog"
      >
        <header className="change-inspector__header">
          <span aria-hidden="true" className="dialog-icon"><Trash2 size={20} /></span>
          <div>
            <h2 id="customer-delete-title">Delete customer?</h2>
            <p className="field-hint">{name}</p>
          </div>
          <button aria-label="Close dialog" className="dialog-close" disabled={pending !== null} onClick={onCancel} type="button">
            <X aria-hidden="true" size={18} />
          </button>
        </header>

        {check === null && !checkError ? (
          <p className="field-hint" role="status">Checking what this customer is linked to…</p>
        ) : null}
        {checkError ? <ActionNotice kind="error" title="Could not check this customer">{checkError}</ActionNotice> : null}

        {check?.canDelete ? (
          <p>
            Nothing is linked to {name}, so it can be deleted permanently. This cannot be undone.
          </p>
        ) : null}

        {blocked ? (
          <>
            <div className="change-inspector__warning" role="note">
              <TriangleAlert aria-hidden="true" size={18} />
              <p>
                {check.archived
                  ? "This customer has linked records and is already archived, so it is hidden from active work and its history is kept."
                  : "This customer has linked records. Archive the customer to preserve its history and keep it out of active work."}
              </p>
            </div>
            <ul className="customer-delete__blockers" aria-label="Linked records">
              {check.blockers.map((blocker) => {
                const Icon = LINKED_RECORD_ICONS[blocker.kind] ?? Link2;
                const row = (
                  <>
                    <Icon aria-hidden size={16} />
                    <span className="customer-delete__label">{blocker.label}</span>
                    <span className="customer-delete__count">{blocker.count}</span>
                    <ChevronRight aria-hidden="true" className="customer-delete__chevron" size={16} />
                  </>
                );
                return (
                  <li key={blocker.kind}>
                    {LINKED_RECORD_ICONS[blocker.kind] ? (
                      <button
                        aria-label={`${blocker.label}, ${blocker.count}. Open`}
                        className="customer-delete__row"
                        onClick={() => onOpenLinked(blocker.kind, null)}
                        type="button"
                      >
                        {row}
                      </button>
                    ) : (
                      <div className="customer-delete__row customer-delete__row--static">{row}</div>
                    )}
                    {blocker.records.length > 0 ? (
                      <span className="customer-delete__records">
                        {blocker.records.map((record) =>
                          blocker.kind === "assets" ? (
                            <button className="link-button" key={record.id} onClick={() => onOpenLinked("asset", record.id)} type="button">
                              {record.name}
                            </button>
                          ) : (
                            <span key={record.id}>{record.name}</span>
                          )
                        )}
                        {blocker.count > blocker.records.length ? <span>and {blocker.count - blocker.records.length} more</span> : null}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <p className="field-hint">
              Assets and users open already filtered to this customer. Bookings, appointments and products open their full lists, because those pages cannot be filtered by customer yet.
            </p>
            <p className="field-hint">
              Archiving hides it from active work and selectors while every record is kept, and it can be restored later.
              Permanent deletion is available only when no linked records remain.
            </p>
          </>
        ) : null}

        {actionError ? <ActionNotice kind="error" title="Could not complete">{actionError}</ActionNotice> : null}

        <div className="confirm-dialog__actions">
          <button className="action-button action-button--ghost" data-initial-focus disabled={pending !== null} onClick={onCancel} type="button">
            {blocked && check.archived ? "Close" : "Cancel"}
          </button>
          {checkError ? <ActionButton onClick={onRetry} variant="secondary">Try again</ActionButton> : null}
          {blocked && !check.archived ? (
            <ActionButton onClick={onArchive} pending={pending === "archiving"} pendingLabel="Archiving…" variant="primary">
              Archive customer
            </ActionButton>
          ) : null}
          {check?.canDelete ? (
            <ActionButton onClick={onConfirm} pending={pending === "deleting"} pendingLabel="Deleting…" variant="danger">
              Delete customer
            </ActionButton>
          ) : null}
        </div>
      </div>
    </div>,
    document.body
  );
}
