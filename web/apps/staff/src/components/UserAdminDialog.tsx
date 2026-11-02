import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { Mail, ShieldCheck, Info, User, UserPlus } from "lucide-react";

import type { StaffRole } from "../domain/types";
import { FormGrid, FormNote, FormSection } from "./forms/FormLayout";
import { FormShell } from "./forms/FormShell";
import { useDirtyTracker } from "./forms/useDirtyTracker";
import { Field } from "./interaction/FormPrimitives";
import { Combobox } from "./interaction/Combobox";
import { Select } from "./interaction/Select";
import { createHmsClient } from "../api/hmsClient";
import { useRemoteOptions } from "../hooks/useRemoteOptions";
import { friendlyApiError } from "./interaction/friendlyApiError";
import { focusFirstInvalid, isBlank, useFormErrors, type FieldErrors } from "./interaction/useFormErrors";
import { ROLE_LABELS, manageableRoles, requiresCustomer } from "./roleAdmin";
import { useFocusAfterRender } from "./forms/useFocusAfterRender";

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

const FOCUS_ORDER = ["email", "firstName", "lastName", "role", "customers"];
const FIELD_LABELS: Record<string, string> = { email: "Email", firstName: "First name", lastName: "Last name", role: "Role", customers: "Customers" };

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
  // No role is chosen for a new user: access is granted on purpose, never by whichever option is listed first.
  const [role, setRole] = useState<StaffRole | "">("");
  const [customerIds, setCustomerIds] = useState<string[]>([]);
  const [isSubmitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const { errors, setErrors, clearError, clearAll } = useFormErrors();
  const formRef = useRef<HTMLFormElement>(null);
  const submitLock = useRef(false);
  const focusAfterRender = useFocusAfterRender();
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
    setRole(initial?.role ?? "");
    setCustomerIds(initial?.customerIds ?? (initial?.customerId ? [initial.customerId] : []));
    setSubmitError(null);
    clearAll();
    markClean();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, sourceSignature, rolesKey]);

  const needsCustomer = role !== "" && requiresCustomer(role);

  // Customers to assign are searched on the server as the person types, so none is out of reach on a later page.
  const customerSearch = useRemoteOptions(
    (text) => createHmsClient().listCustomers({ search: text, sort: "name", limit: 25 }).then((result) => result.items.map((customer) => ({ id: customer.id, name: customer.name }))),
    open && needsCustomer
  );
  const [customerNames, setCustomerNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open) return;
    const known = new Map<string, string>([...customers.map((customer) => [customer.id, customer.name] as [string, string]), ...customerSearch.items.map((customer) => [customer.id, customer.name] as [string, string])]);
    const missing = customerIds.filter((id) => !customerNames[id] && !known.has(id));
    setCustomerNames((current) => {
      const next = { ...current };
      let changed = false;
      for (const id of customerIds) if (!next[id] && known.has(id)) { next[id] = known.get(id) as string; changed = true; }
      return changed ? next : current;
    });
    for (const id of missing) {
      void createHmsClient().getCustomer(id)
        .then((customer) => setCustomerNames((current) => ({ ...current, [id]: customer.name })))
        .catch(() => setCustomerNames((current) => ({ ...current, [id]: "Unavailable customer" })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, customerIds, customerSearch.items, customers]);

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
    if (role === "") found.role = "Select a role.";
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
        role: role as StaffRole,
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
      focusAfterRender(() => {
        if (!focusFirstInvalid(formRef.current, FOCUS_ORDER, fieldErrors)) {
          formRef.current?.querySelector<HTMLElement>(".action-notice")?.focus();
        }
      });
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
            description={mode === "create" ? "Create a new user account and assign their workspace access." : "Update this person's details and workspace access."}
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
            headerIcon={<UserPlus size={22} />}
            isSubmitting={isSubmitting}
            onClose={onClose}
            onEdit={touch}
            onSubmit={submit}
            pendingLabel={mode === "create" ? "Creating…" : "Saving…"}
            submitError={submitError}
            submitIcon={mode === "create" ? <UserPlus size={16} /> : undefined}
            submitLabel={mode === "create" ? "Create user" : "Save changes"}
            title={title}
          >
            <FormSection description="Who this person is. The email is their sign-in." step={1} title="Identity">
              <Field error={errors.email} icon={<Mail size={16} />} label="Email" name="email" required>
                {(props) => <input {...props} aria-label="Email" placeholder="name@company.com" type="email" value={email} onChange={(event) => { setEmail(event.target.value); clearError("email"); }} />}
              </Field>
              <FormGrid>
                <Field error={errors.firstName} icon={<User size={16} />} label="First name" name="firstName" required={nameRequired(initial?.firstName)}>
                  {(props) => <input {...props} aria-label="First name" placeholder="First name" value={firstName} onChange={(event) => { setFirstName(event.target.value); clearError("firstName"); }} />}
                </Field>
                <Field error={errors.lastName} icon={<User size={16} />} label="Last name" name="lastName" required={nameRequired(initial?.lastName)}>
                  {(props) => <input {...props} aria-label="Last name" placeholder="Last name" value={lastName} onChange={(event) => { setLastName(event.target.value); clearError("lastName"); }} />}
                </Field>
              </FormGrid>
            </FormSection>
            <FormSection description="What they can see and do." step={2} title="Access">
              <Field error={errors.role} label="Role" name="role" required>
                {(props) => (
                  <Select
                    {...props}
                    aria-label="Role"
                    icon={<ShieldCheck size={16} />}
                    onChange={(next) => { setRole(next as StaffRole); clearError("role"); touch(); }}
                    options={roleOptions.map((option) => ({ value: option, label: ROLE_LABELS[option] }))}
                    placeholder="Select a role"
                    value={role}
                  />
                )}
              </Field>
              <FormNote icon={<Info size={16} />}>
                Roles control workspace access, permissions and available features. You can change this later.
              </FormNote>
              {needsCustomer ? (
                <Field error={errors.customers} label="Customers" name="customers" required>
                  {(props) => (
                    <div>
                      <Combobox
                        {...props}
                        aria-label="Customers"
                        emptyText="No customers match"
                        loading={customerSearch.loading}
                        onChange={(next) => {
                          if (next && !customerIds.includes(next)) {
                            const found = customerSearch.items.find((customer) => customer.id === next);
                            if (found) setCustomerNames((current) => ({ ...current, [next]: found.name }));
                            setCustomerIds([...customerIds, next]);
                            touch();
                          }
                          clearError("customers");
                        }}
                        onSearch={customerSearch.search}
                        options={customerSearch.items.filter((customer) => !customerIds.includes(customer.id)).map((customer) => ({ value: customer.id, label: customer.name }))}
                        placeholder="Search customers to assign"
                        value=""
                      />
                      {customerIds.length > 0 ? (
                        <ul aria-label="Assigned customers" className="assigned-customers">
                          {customerIds.map((id) => (
                            <li key={id}>
                              <span>{customerNames[id] ?? "Loading…"}</span>
                              <button
                                aria-label={`Remove ${customerNames[id] ?? "customer"}`}
                                className="icon-button light"
                                onClick={() => { setCustomerIds(customerIds.filter((item) => item !== id)); touch(); }}
                                type="button"
                              >
                                ×
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  )}
                </Field>
              ) : null}
            </FormSection>
          </FormShell>
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}
