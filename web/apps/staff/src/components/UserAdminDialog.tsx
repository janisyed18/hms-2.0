import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";

import type { StaffRole } from "../domain/types";
import { ROLE_LABELS, manageableRoles, requiresCustomer } from "./roleAdmin";

export interface UserAdminValues {
  email: string;
  firstName: string;
  lastName: string;
  role: StaffRole;
  customerId: string | null;
  customerIds: string[];
}

export interface CustomerOption {
  id: string;
  name: string;
}

interface UserAdminDialogProps {
  open: boolean;
  mode: "create" | "edit";
  actorRoles: StaffRole[];
  customers: CustomerOption[];
  initial?: Partial<UserAdminValues>;
  onClose: () => void;
  onSubmit: (values: UserAdminValues) => void;
}

export function UserAdminDialog({
  open,
  mode,
  actorRoles,
  customers,
  initial,
  onClose,
  onSubmit
}: UserAdminDialogProps) {
  const roleOptions = useMemo(() => manageableRoles(actorRoles), [actorRoles]);
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [role, setRole] = useState<StaffRole>(roleOptions[0] ?? "INSPECTOR");
  const [customerIds, setCustomerIds] = useState<string[]>([]);
  const emailRef = useRef<HTMLInputElement>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (open) {
      setEmail(initial?.email ?? "");
      setFirstName(initial?.firstName ?? "");
      setLastName(initial?.lastName ?? "");
      setRole(initial?.role ?? roleOptions[0] ?? "INSPECTOR");
      setCustomerIds(initial?.customerIds ?? (initial?.customerId ? [initial.customerId] : []));
    }
  }, [initial, open, roleOptions]);

  useEffect(() => {
    if (open) {
      emailRef.current?.focus();
    }
  }, [open]);

  const needsCustomer = requiresCustomer(role);
  const customerInvalid = needsCustomer && customerIds.length === 0;
  const canSubmit = email.trim().length > 0 && !customerInvalid;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    onSubmit({
      email: email.trim(),
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      role,
      customerId: needsCustomer ? customerIds[0] ?? null : null,
      customerIds: needsCustomer ? customerIds : []
    });
  }

  return (
    <AnimatePresence initial={false}>
      {open ? (
        <m.div
          animate={{ opacity: 1 }}
          aria-label={mode === "create" ? "Add user" : "Edit user"}
          aria-modal="true"
          className="modal-backdrop"
          exit={{ opacity: 0 }}
          initial={{ opacity: 0 }}
          key="user-admin-dialog"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
          role="dialog"
          transition={{ duration: reducedMotion ? 0 : 0.16 }}
        >
          <m.form
            animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
            className="modal-card"
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
            onSubmit={submit}
            transition={{ duration: reducedMotion ? 0 : 0.16 }}
          >
        <div className="modal-header">
          <h2>{mode === "create" ? "Add user" : "Edit user"}</h2>
          <button
            aria-label="Close"
            className="icon-button light"
            onClick={onClose}
            type="button"
          >
            <X size={16} />
          </button>
        </div>

        <label className="auth-field">
          <span>Email</span>
          <input
            ref={emailRef}
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <div className="modal-grid">
          <label className="auth-field">
            <span>First name</span>
            <input
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
            />
          </label>
          <label className="auth-field">
            <span>Last name</span>
            <input
              value={lastName}
              onChange={(event) => setLastName(event.target.value)}
            />
          </label>
        </div>
        <label className="auth-field">
          <span>Role</span>
          <select
            aria-label="Role"
            value={role}
            onChange={(event) => setRole(event.target.value as StaffRole)}
          >
            {roleOptions.map((option) => (
              <option key={option} value={option}>
                {ROLE_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
        {needsCustomer ? (
          <label className="auth-field">
            <span>Customers</span>
            <select
              aria-label="Customers"
              multiple
              value={customerIds}
              onChange={(event) => setCustomerIds(Array.from(event.currentTarget.selectedOptions, (option) => option.value))}
              required
            >
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {customerInvalid ? (
          <p className="auth-error" role="alert">
            A Customer User must be assigned to at least one customer.
          </p>
        ) : null}

        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="primary-button" disabled={!canSubmit} type="submit">
            {mode === "create" ? "Create user" : "Save changes"}
          </button>
        </div>
          </m.form>
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}
