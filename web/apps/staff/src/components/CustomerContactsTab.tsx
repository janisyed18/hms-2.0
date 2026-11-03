import { Plus } from "lucide-react";
import { useState } from "react";

import { createHmsClient } from "../api/hmsClient";
import type { CustomerContact, CustomerRecord } from "../domain/types";
import { ContactEditor } from "./ContactEditor";
import { ActionButton } from "./interaction/ActionButton";
import { ConfirmDialog } from "./interaction/ConfirmDialog";
import { friendlyApiError } from "./interaction/friendlyApiError";

/** The customer's contacts, with add and edit for anyone who may edit customers and Delete for Super Admin only. */
export function CustomerContactsTab({
  canDelete,
  canWrite,
  customer,
  onChanged,
  onNotice
}: {
  canDelete: boolean;
  canWrite: boolean;
  customer: CustomerRecord;
  onChanged: (customer: CustomerRecord) => void;
  onNotice: (title: string, message: string) => void;
}) {
  const [editing, setEditing] = useState<CustomerContact | "new" | null>(null);
  const [deleting, setDeleting] = useState<CustomerContact | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const contacts = [...customer.contacts].sort((left, right) => left.name.localeCompare(right.name));

  async function confirmDelete() {
    if (!deleting || isDeleting) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      const client = createHmsClient();
      await client.deleteCustomerContact(customer.id, deleting.id);
      onChanged(await client.getCustomer(customer.id));
      onNotice("Contact deleted", `${deleting.name} was deleted.`);
      setDeleting(null);
    } catch (reason) {
      setDeleteError(friendlyApiError(reason, { fallback: `${deleting.name} could not be deleted. Try again.` }).message);
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <section className="customer-location-section">
      <div className="customer-location-section-heading">
        <div>
          <h3>Contacts</h3>
          <p>People to reach at this customer, and who receives retest reminders.</p>
        </div>
        {canWrite ? (
          <ActionButton onClick={() => setEditing("new")} variant="secondary">
            <Plus aria-hidden="true" size={15} /> Add contact
          </ActionButton>
        ) : null}
      </div>
      {contacts.length === 0 ? (
        <div className="customer-location-empty"><p>No contacts have been added for this customer.</p></div>
      ) : (
        <div className="customer-location-grid">
          {contacts.map((contact) => (
            <article key={contact.id}>
              <div>
                <h4>{contact.name}</h4>
                <p>{contact.role || "Role not recorded"}</p>
              </div>
              <p className="customer-location-contact">
                {[contact.email, contact.phone].filter(Boolean).join(" · ") || "No contact details recorded"}
              </p>
              <p>{contact.receivesRetestReminders ? "Receives retest reminders" : "Does not receive retest reminders"}</p>
              <span className="row-actions">
                {canWrite ? <ActionButton aria-label={`Edit ${contact.name}`} onClick={() => setEditing(contact)} variant="secondary">Edit</ActionButton> : null}
                {canDelete ? <ActionButton aria-label={`Delete ${contact.name}`} onClick={() => { setDeleteError(null); setDeleting(contact); }} variant="ghost">Delete</ActionButton> : null}
              </span>
            </article>
          ))}
        </div>
      )}
      <ContactEditor
        contact={editing === "new" ? null : editing}
        customerId={customer.id}
        onClose={() => setEditing(null)}
        onSaved={(fresh, saved) => {
          onChanged(fresh);
          setEditing(null);
          onNotice(saved === "added" ? "Contact added" : "Contact saved", `The contact was ${saved}.`);
        }}
        open={editing !== null}
      />
      <ConfirmDialog
        confirmLabel="Delete contact"
        elevated
        error={deleteError}
        message="The contact is removed from this customer. Past notifications are kept."
        onCancel={() => { if (!isDeleting) { setDeleting(null); setDeleteError(null); } }}
        onConfirm={() => void confirmDelete()}
        open={deleting !== null}
        pending={isDeleting}
        pendingLabel="Deleting…"
        title={deleting ? `Delete ${deleting.name}?` : "Delete contact?"}
      />
    </section>
  );
}
