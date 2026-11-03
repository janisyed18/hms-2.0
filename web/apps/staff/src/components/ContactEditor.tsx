import { useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

import { createHmsClient } from "../api/hmsClient";
import { FormSection } from "./forms/FormLayout";
import { FormShell } from "./forms/FormShell";
import { useDirtyTracker } from "./forms/useDirtyTracker";
import { useFormSeed } from "./forms/useFormSeed";
import { useFormSubmit } from "./forms/useFormSubmit";
import { Field } from "./interaction/FormPrimitives";
import { isBlank, type FieldErrors } from "./interaction/useFormErrors";
import type { ContactFormValues, CustomerContact, CustomerRecord } from "../domain/types";

const ORDER = ["name", "email", "phone", "role"];
const LABELS = { name: "Name", email: "Email", phone: "Phone", role: "Role" };

function emptyContact(): ContactFormValues {
  return { name: "", email: "", phone: "", role: "", receivesRetestReminders: true };
}

/** Add or edit one contact of a customer, from Customer Details. */
export function ContactEditor({
  contact,
  customerId,
  onClose,
  onSaved,
  open
}: {
  contact: CustomerContact | null;
  customerId: string;
  onClose: () => void;
  onSaved: (customer: CustomerRecord, saved: "added" | "updated") => void;
  open: boolean;
}) {
  const [values, setValues] = useState<ContactFormValues>(emptyContact);
  const formRef = useRef<HTMLFormElement>(null);
  const { dirty, markClean, touch } = useDirtyTracker(JSON.stringify(values));
  const seed = useFormSeed({
    dirty,
    sourceKey: open ? (contact?.id ?? "new") : null,
    sourceSignature: JSON.stringify(contact ?? null),
    seed: () => {
      setValues(contact ? {
        name: contact.name,
        email: contact.email ?? "",
        phone: contact.phone ?? "",
        role: contact.role ?? "",
        receivesRetestReminders: contact.receivesRetestReminders
      } : emptyContact());
      submission.reset();
      markClean();
    }
  });
  const submission = useFormSubmit({
    fallback: "The contact could not be saved. Check the entered details and try again.",
    fieldMap: { name: "name", email: "email", phone: "phone", role: "role" },
    formRef,
    isCurrent: seed.isCurrent,
    order: ORDER,
    session: seed.current
  });
  const { clearError, errors } = submission;

  if (!open) {
    return null;
  }

  const update = (patch: Partial<ContactFormValues>, errorKey?: string) => {
    if (errorKey) clearError(errorKey);
    setValues((current) => ({ ...current, ...patch }));
  };

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const found: FieldErrors = {};
    if (isBlank(values.name)) found.name = "Enter the contact's name.";
    if (!isBlank(values.email) && !/^\S+@\S+\.\S+$/.test(values.email.trim())) found.email = "Enter a valid email address.";
    if (!submission.validate(found)) return;
    await submission.run(async () => {
      const client = createHmsClient();
      if (contact) await client.updateCustomerContact(customerId, contact.id, values);
      else await client.createCustomerContact(customerId, values);
      onSaved(await client.getCustomer(customerId), contact ? "updated" : "added");
    }, markClean);
  }

  // Portalled out of the profile dialog, whose transform would otherwise anchor this drawer to it.
  return createPortal(
    <div className="drawer-backdrop drawer-backdrop--elevated" role="presentation">
      <FormShell
        closeLabel="Close contact form"
        description="Who to contact at this customer, and whether they are sent retest reminders."
        dirty={dirty}
        errorSummaryTitle="Contact could not be saved"
        errors={errors}
        fieldLabels={LABELS}
        fieldOrder={ORDER}
        formClassName="customer-drawer"
        formRef={formRef}
        headerClassName="drawer-header"
        isSubmitting={submission.isSubmitting}
        onClose={onClose}
        onEdit={touch}
        onSubmit={handleSubmit}
        pendingLabel="Saving…"
        submitError={submission.submitError}
        submitLabel="Save contact"
        title={contact ? "Edit contact" : "Add contact"}
      >
        <FormSection>
          <Field error={errors.name} label="Name" name="name" required>
            {(props) => <input {...props} aria-label="Name" value={values.name} onChange={(event) => update({ name: event.target.value }, "name")} />}
          </Field>
          <Field label="Role" name="role">
            {(props) => <input {...props} aria-label="Role" value={values.role} onChange={(event) => update({ role: event.target.value })} />}
          </Field>
          <Field error={errors.email} label="Email" name="email">
            {(props) => <input {...props} aria-label="Email" type="email" value={values.email} onChange={(event) => update({ email: event.target.value }, "email")} />}
          </Field>
          <Field label="Phone" name="phone">
            {(props) => <input {...props} aria-label="Phone" inputMode="tel" type="tel" value={values.phone} onChange={(event) => update({ phone: event.target.value })} />}
          </Field>
          <label className="checkbox-field">
            <input checked={values.receivesRetestReminders} onChange={(event) => update({ receivesRetestReminders: event.target.checked })} type="checkbox" />
            <span>Receives retest reminders</span>
          </label>
        </FormSection>
      </FormShell>
    </div>,
    document.body
  );
}
