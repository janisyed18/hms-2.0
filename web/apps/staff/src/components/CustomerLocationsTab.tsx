import { ChevronDown, ExternalLink, MapPin, Plus, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { createHmsClient } from "../api/hmsClient";
import type { AssetRecord, CustomerLocation, CustomerRecord } from "../domain/types";
import { assetAccessibleName } from "../utils/identity";
import { AssetIdentity } from "./AssetIdentity";
import { ActionButton } from "./interaction/ActionButton";
import { ConfirmDialog } from "./interaction/ConfirmDialog";
import { friendlyApiError } from "./interaction/friendlyApiError";
import { LocationEditor } from "./LocationEditor";
import { scheduleSummary } from "./LocationFields";

/** Asset links shown on a location card before "+N more"; the rest are one click away. */
const ASSET_LINK_PREVIEW = 4;

export const FINAL_LOCATION_MESSAGE = "A customer must have at least one location. Add another location before deleting this one.";

function googleMapsUrl(location: CustomerLocation) {
  const parts = [location.address1, location.address2, location.city, location.state, location.country];
  if (!parts.some((value) => Boolean(value?.trim()))) return null;
  const address = [location.name, ...parts].filter((value): value is string => Boolean(value?.trim())).join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

function RequirementList({ items, emptyLabel }: { items?: string[]; emptyLabel: string }) {
  const requirements = items ?? [];
  return requirements.length ? (
    <ul className="requirement-list">
      {requirements.map((item) => <li key={item}><ShieldCheck aria-hidden="true" size={15} />{item}</li>)}
    </ul>
  ) : <p className="empty-requirements">{emptyLabel}</p>;
}

/**
 * Every location of the customer, whether or not any asset is assigned to it, with add, edit and view
 * for anyone who may edit customers and Delete for Super Admin only. The last location cannot be
 * deleted, and a location that still has work against it is refused by the server with the reason.
 */
export function CustomerLocationsTab({
  assets,
  assetsError,
  canDelete,
  canWrite,
  customer,
  isLoadingAssets,
  onAssetOpen,
  onChanged,
  onNotice
}: {
  assets: AssetRecord[];
  assetsError: string | null;
  canDelete: boolean;
  canWrite: boolean;
  customer: CustomerRecord;
  isLoadingAssets: boolean;
  onAssetOpen: (assetId: string) => void;
  onChanged: (customer: CustomerRecord) => void;
  onNotice: (title: string, message: string) => void;
}) {
  const [editing, setEditing] = useState<CustomerLocation | "new" | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<CustomerLocation | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const locations = [...customer.locations].sort((left, right) => left.name.localeCompare(right.name));
  const isFinal = locations.length <= 1;
  const unassigned = assets.filter((asset) => !asset.location).length;

  async function confirmDelete() {
    if (!deleting || isDeleting) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      const client = createHmsClient();
      await client.deleteCustomerLocation(customer.id, deleting.id);
      onChanged(await client.getCustomer(customer.id));
      onNotice("Location deleted", `${deleting.name} was deleted.`);
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
          <h3>Locations</h3>
          <p>Every location registered for this customer, with its site contact, requirements and booking window.</p>
        </div>
        <span className="row-actions">
          {unassigned ? <span className="mini-status due-soon">{unassigned} assets without a location</span> : null}
          {canWrite ? (
            <ActionButton onClick={() => setEditing("new")} variant="secondary">
              <Plus aria-hidden="true" size={15} /> Add location
            </ActionButton>
          ) : null}
        </span>
      </div>
      {assetsError ? <p className="form-error" role="alert">{assetsError}</p> : null}
      <div className="customer-location-grid">
        {locations.map((location) => {
          const mapUrl = googleMapsUrl(location);
          const locationAssets = assets.filter((asset) => asset.location?.id === location.id);
          const isOpen = expanded === location.id;
          return (
            <article key={location.id}>
              <span className="customer-location-icon"><MapPin aria-hidden="true" size={18} /></span>
              <div>
                <h4>{location.name}</h4>
                <p>{[location.address1, location.address2, location.city, location.state, location.country].filter(Boolean).join(", ") || "Address not recorded"}</p>
                {mapUrl ? (
                  <a aria-label={`Open ${location.name} in Google Maps`} className="customer-location-map-link" href={mapUrl} rel="noopener noreferrer" target="_blank">
                    View in Google Maps <ExternalLink aria-hidden="true" size={13} />
                  </a>
                ) : null}
              </div>
              <p className="customer-location-contact">{(location.contacts ?? []).length ? `${(location.contacts ?? []).length} location contact${(location.contacts ?? []).length === 1 ? "" : "s"}` : location.siteContactName ? `Site contact: ${location.siteContactName}` : "Site contact not recorded"}</p>
              <div className="customer-location-assets">
                {isLoadingAssets ? (
                  <strong aria-label="Loading assets" className="customer-location-asset-count">…</strong>
                ) : (
                  <strong className="customer-location-asset-count">{locationAssets.length}<small>{locationAssets.length === 1 ? "asset" : "assets"}</small></strong>
                )}
                {!isLoadingAssets && locationAssets.length === 0 ? <p className="customer-location-no-assets">No assets at this location.</p> : null}
                {locationAssets.length > 0 ? (
                  <ul aria-label={`Assets at ${location.name}`} className="customer-location-asset-chips">
                    {(isOpen ? locationAssets : locationAssets.slice(0, ASSET_LINK_PREVIEW)).map((asset) => (
                      <li key={asset.id}>
                        <button aria-label={`Open asset ${assetAccessibleName(asset)}`} className="customer-location-asset-link" onClick={() => onAssetOpen(asset.id)} type="button">
                          <AssetIdentity asset={asset} />
                        </button>
                      </li>
                    ))}
                    {!isOpen && locationAssets.length > ASSET_LINK_PREVIEW ? (
                      <li>
                        <button aria-label={`Show all ${locationAssets.length} assets at ${location.name}`} className="customer-location-asset-link customer-location-asset-more" onClick={() => setExpanded(location.id)} type="button">
                          +{locationAssets.length - ASSET_LINK_PREVIEW} more
                        </button>
                      </li>
                    ) : null}
                  </ul>
                ) : null}
              </div>
              <span className="row-actions">
                <ActionButton aria-expanded={isOpen} aria-label={`View ${location.name}`} onClick={() => setExpanded(isOpen ? null : location.id)} variant="ghost">
                  <ChevronDown aria-hidden="true" size={15} /> {isOpen ? "Hide" : "View"}
                </ActionButton>
                {canWrite ? <ActionButton aria-label={`Edit ${location.name}`} onClick={() => setEditing(location)} variant="secondary">Edit</ActionButton> : null}
                {canDelete ? (
                  <ActionButton aria-label={`Delete ${location.name}`} disabled={isFinal} onClick={() => { setDeleteError(null); setDeleting(location); }} variant="destructive">Delete</ActionButton>
                ) : null}
              </span>
              {canDelete && isFinal ? <p className="empty-requirements">{FINAL_LOCATION_MESSAGE}</p> : null}
              {isOpen ? (
                <div className="customer-location-requirements">
                  <div><h5>Booking window</h5><p>{scheduleSummary(location) || "Not recorded"}</p></div>
                  <div><h5>Blackout dates</h5><p>{location.schedulingBlackoutDates?.length ? location.schedulingBlackoutDates.join(", ") : "None"}</p></div>
                  <div><h5>PPE requirements</h5><RequirementList emptyLabel="No PPE requirements." items={location.ppeRequirements} /></div>
                  <div><h5>Additional requirements</h5><RequirementList emptyLabel="No additional requirements." items={location.additionalRequirements} /></div>
                  <div><h5>Location Notes</h5><p>{location.notes || "No location notes recorded."}</p></div>
                  <div><h5>Location contacts</h5><ul>{(location.contacts ?? []).map((contact, index) => <li key={contact.id ?? index}>{contact.name}{contact.role ? ` · ${contact.role}` : ""}{contact.phone ? ` · ${contact.phone}` : ""}{contact.email ? ` · ${contact.email}` : ""}</li>)}</ul></div>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      <LocationEditor
        customerId={customer.id}
        location={editing === "new" ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={(fresh, saved) => {
          onChanged(fresh);
          setEditing(null);
          onNotice(saved === "added" ? "Location added" : "Location saved", `The location was ${saved}.`);
        }}
        open={editing !== null}
      />
      <ConfirmDialog
        confirmLabel="Delete location"
        elevated
        error={deleteError}
        message="Its assets, bookings and history are kept. A location that still has work against it cannot be deleted."
        onCancel={() => { if (!isDeleting) { setDeleting(null); setDeleteError(null); } }}
        onConfirm={() => void confirmDelete()}
        open={deleting !== null}
        pending={isDeleting}
        pendingLabel="Deleting…"
        title={deleting ? `Delete ${deleting.name}?` : "Delete location?"}
      />
    </section>
  );
}
