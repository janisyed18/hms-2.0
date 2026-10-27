import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";

import type { StaffRole } from "../domain/types";
import { FormGrid } from "./forms/FormLayout";
import { FormShell } from "./forms/FormShell";
import { useDirtyTracker } from "./forms/useDirtyTracker";
import { Field } from "./interaction/FormPrimitives";
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
  /** Identifies the record being edited, so the form re-seeds for another user but not for a refresh. */
  recordKey?: string;
  onClose: () => void;
  /** Rejects when the server refuses; the dialog then stays open with what was typed. */
  onSubmit: (values: UserAdminValues) => Promise<void>;
}

const FOCUS_ORDER = ["email", "firstName", "lastName", "customers"];
const FIELD_LABELS: Record<string, string> = { email: "Email", firstName: "First name", lastName: "Last name", customers: "Customers" };

export function UserAdminDialog({
  open,
  mode,
  actorRoles,
  customers,
  initial,
  recordKey,
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

  const { dirty, markClean, touch } = useDirtyTracker(JSON.stringify([email, firstName, lastName, role, customerIds]));
  const dirtyRef = useRef(false);
  useEffect(() => { dirtyRef.current = dirty; });
  // Re-seed when the dialog opens or is pointed at another user. The parent rebuilds `initial` on every
  // render, so a list refresh must not reset what is being typed: only a form nobody has edited follows
  // a changed record. Each seeding is a new session, so a slow save for the previous user is ignored.
  const sourceKey = open ? `${mode}:${recordKey ?? ""}` : null;
  const sourceSignature = JSON.stringify(initial ?? null);
  const rolesKey = roleOptions.join(",");
  const seededKey = useRef<string | null>(null);
  const session = useRef(0);

  useEffect(() => {
    if (sourceKey === null) {
      seededKey.current = null;
      return;
    }
    if (seededKey.current === sourceKey && dirtyRef.current) return;
    seededKey.current = sourceKey;
    session.current += 1;
    submitLock.current = false;
    setSubmitting(false);
    setEmail(initial?.email ?? "");
    setFirstName(initial?.firstName ?? "");
    setLastName(initial?.lastName ?? "");
    setRole(initial?.role ?? roleOptions[0] ?? "INSPECTOR");
    setCustomerIds(initial?.customerIds ?? (initial?.customerId ? [initial.customerId] : []));
    setSubmitError(null);
    clearAll();
    markClean();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, sourceSignature, rolesKey]);

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
    const startedIn = session.current;
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
      if (startedIn === session.current) markClean();
    } catch (reason) {
      if (startedIn !== session.current) return;
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
      if (startedIn === session.current) {
        submitLock.current = false;
        setSubmitting(false);
      }
    }
  }

  const title = mode === "create" ? "Add user" : "Edit user";
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <m.div
          animate={{ opacity: 1 }}
          aria-label={title}
          aria-modal="true"
          className="modal-backdrop"
          exit={{ opacity: 0 }}
          initial={{ opacity: 0 }}
          key="user-admin-dialog"
          role="dialog"
          transition={{ duration: reducedMotion ? 0 : 0.16 }}
        >
          <FormShell
            closeLabel="Close"
            dirty={dirty}
            errorSummaryTitle={mode === "create" ? "User not created" : "User not updated"}
            errors={errors}
            fieldLabels={FIELD_LABELS}
            fieldOrder={FOCUS_ORDER}
            formClassName="modal-card"
            formComponent={m.form}
            formProps={{
              animate: reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 },
              exit: reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 },
              initial: reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 },
              transition: { duration: reducedMotion ? 0 : 0.16 }
            }}
            formRef={formRef}
            headerClassName="modal-header"
            isSubmitting={isSubmitting}
            onClose={onClose}
            onEdit={touch}
            onSubmit={submit}
            pendingLabel={mode === "create" ? "Creating…" : "Saving…"}
            submitError={submitError}
            submitLabel={mode === "create" ? "Create user" : "Save changes"}
            title={title}
          >
            <Field className="auth-field" error={errors.email} label="Email" name="email" required>
              {(props) => <input {...props} aria-label="Email" type="email" value={email} onChange={(event) => { setEmail(event.target.value); clearError("email"); }} />}
            </Field>
            <FormGrid>
              <Field className="auth-field" error={errors.firstName} label="First name" name="firstName" required={nameRequired(initial?.firstName)}>
                {(props) => <input {...props} aria-label="First name" value={firstName} onChange={(event) => { setFirstName(event.target.value); clearError("firstName"); }} />}
              </Field>
              <Field className="auth-field" error={errors.lastName} label="Last name" name="lastName" required={nameRequired(initial?.lastName)}>
                {(props) => <input {...props} aria-label="Last name" value={lastName} onChange={(event) => { setLastName(event.target.value); clearError("lastName"); }} />}
              </Field>
            </FormGrid>
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
          </FormShell>
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}
