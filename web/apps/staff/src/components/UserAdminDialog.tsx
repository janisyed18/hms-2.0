import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";

import type { StaffRole } from "../domain/types";
import { ActionButton } from "./interaction/ActionButton";
import { ActionNotice } from "./interaction/ActionNotice";
import { Field, RequiredNote } from "./interaction/FormPrimitives";
import { friendlyApiError } from "./interaction/friendlyApiError";
import { focusFirstInvalid, isBlank, useFormErrors, type FieldErrors } from "./interaction/useFormErrors";
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
  /** Rejects when the server refuses; the dialog then stays open with what was typed. */
  onSubmit: (values: UserAdminValues) => Promise<void>;
}

const FOCUS_ORDER = ["email", "firstName", "lastName", "customers"];

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
  const nameRequired = (existing?: string) => mode === "create" || Boolean(existing);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [role, setRole] = useState<StaffRole>(roleOptions[0] ?? "INSPECTOR");
  const [customerIds, setCustomerIds] = useState<string[]>([]);
  const [isSubmitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const { errors, setErrors, clearError, clearAll } = useFormErrors();
  const formRef = useRef<HTMLFormElement>(null);
  const submitLock = useRef(false);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (open) {
      setEmail(initial?.email ?? "");
      setFirstName(initial?.firstName ?? "");
      setLastName(initial?.lastName ?? "");
      setRole(initial?.role ?? roleOptions[0] ?? "INSPECTOR");
      setCustomerIds(initial?.customerIds ?? (initial?.customerId ? [initial.customerId] : []));
      setSubmitError(null);
      clearAll();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial, open, roleOptions]);

  useEffect(() => {
    if (open) {
      window.setTimeout(() => formRef.current?.querySelector<HTMLElement>('[data-field="email"]')?.focus(), 0);
    }
  }, [open]);

  const needsCustomer = requiresCustomer(role);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitLock.current) return;
    setSubmitError(null);
    const found: FieldErrors = {};
    if (isBlank(email)) found.email = "Enter the user's email address.";
    else if (!/^\S+@\S+\.\S+$/.test(email.trim())) found.email = "Enter a valid email address.";
    // New users must have a name to show; an existing user keeps whatever they had, and a legacy user
    // without one can still be edited.
    if (mode === "create" || initial?.firstName) {
      if (isBlank(firstName)) found.firstName = "Enter the user's first name.";
    }
    if (mode === "create" || initial?.lastName) {
      if (isBlank(lastName)) found.lastName = "Enter the user's last name.";
    }
    if (needsCustomer && customerIds.length === 0) found.customers = "Select at least one customer for this user.";
    setErrors(found);
    if (Object.keys(found).length > 0) {
      focusFirstInvalid(formRef.current, FOCUS_ORDER, found);
      return;
    }
    submitLock.current = true;
    setSubmitting(true);
    try {
      await onSubmit({
        email: email.trim(),
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        role,
        customerId: needsCustomer ? customerIds[0] ?? null : null,
        customerIds: needsCustomer ? customerIds : []
      });
    } catch (reason) {
      const friendly = friendlyApiError(reason, {
        fallback: mode === "create" ? "The user could not be created. Nothing was saved." : "The user could not be updated. Nothing was changed.",
        fieldMap: { email: "email", first_name: "firstName", last_name: "lastName", customer_ids: "customers", customer_id: "customers" }
      });
      const fieldErrors = { ...friendly.fieldErrors };
      // A duplicate address is reported by the server as a conflict about the email.
      if (friendly.kind === "conflict" && /email/i.test(friendly.message)) fieldErrors.email = friendly.message;
      setErrors(fieldErrors);
      setSubmitError(friendly.message);
      window.setTimeout(() => {
        if (!focusFirstInvalid(formRef.current, FOCUS_ORDER, fieldErrors)) {
          formRef.current?.querySelector<HTMLElement>(".action-notice")?.focus();
        }
      }, 0);
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
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
            noValidate
            onSubmit={submit}
            ref={formRef}
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

        {submitError ? <ActionNotice kind="error" title={mode === "create" ? "User not created" : "User not updated"}>{submitError}</ActionNotice> : null}
        <RequiredNote />
        <Field className="auth-field" error={errors.email} label="Email" name="email" required>
          {(props) => <input {...props} aria-label="Email" type="email" value={email} onChange={(event) => { setEmail(event.target.value); clearError("email"); }} />}
        </Field>
        <div className="modal-grid">
          <Field className="auth-field" error={errors.firstName} label="First name" name="firstName" required={nameRequired(initial?.firstName)}>
            {(props) => <input {...props} aria-label="First name" value={firstName} onChange={(event) => { setFirstName(event.target.value); clearError("firstName"); }} />}
          </Field>
          <Field className="auth-field" error={errors.lastName} label="Last name" name="lastName" required={nameRequired(initial?.lastName)}>
            {(props) => <input {...props} aria-label="Last name" value={lastName} onChange={(event) => { setLastName(event.target.value); clearError("lastName"); }} />}
          </Field>
        </div>
        <Field className="auth-field" label="Role" name="role" required>
          {(props) => (
            <select {...props} aria-label="Role" value={role} onChange={(event) => setRole(event.target.value as StaffRole)}>
              {roleOptions.map((option) => (
                <option key={option} value={option}>
                  {ROLE_LABELS[option]}
                </option>
              ))}
            </select>
          )}
        </Field>
        {needsCustomer ? (
          <Field className="auth-field" error={errors.customers} label="Customers" name="customers" required>
            {(props) => (
              <select
                {...props}
                aria-label="Customers"
                multiple
                value={customerIds}
                onChange={(event) => { setCustomerIds(Array.from(event.currentTarget.selectedOptions, (option) => option.value)); clearError("customers"); }}
              >
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}

        <div className="modal-actions">
          <ActionButton disabled={isSubmitting} onClick={onClose} variant="ghost">Cancel</ActionButton>
          <ActionButton pending={isSubmitting} pendingLabel={mode === "create" ? "Creating…" : "Saving…"} type="submit" variant="primary">
            {mode === "create" ? "Create user" : "Save changes"}
          </ActionButton>
        </div>
          </m.form>
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}
