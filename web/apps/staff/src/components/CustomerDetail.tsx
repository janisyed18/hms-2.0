import { Building2, Edit3, MapPin, ShieldCheck, X } from "lucide-react";
import { m, useReducedMotion } from "motion/react";

import type { CustomerRecord } from "../domain/types";
import { motionTokens } from "../motion/motionTokens";

interface CustomerDetailProps {
  activeTab: string;
  canWrite: boolean;
  customer: CustomerRecord | null;
  onClose: () => void;
  onEdit: () => void;
  onTabChange: (tab: string) => void;
}

const tabs = ["Overview", "Locations"];

function RequirementList({ items, emptyLabel }: { items?: string[]; emptyLabel: string }) {
  const requirements = items ?? [];

  return requirements.length ? (
    <ul className="requirement-list">
      {requirements.map((item) => <li key={item}><ShieldCheck aria-hidden="true" size={15} />{item}</li>)}
    </ul>
  ) : <p className="empty-requirements">{emptyLabel}</p>;
}

export function CustomerDetail({
  activeTab,
  canWrite,
  customer,
  onClose,
  onEdit,
  onTabChange
}: CustomerDetailProps) {
  const reducedMotion = useReducedMotion();

  if (!customer) {
    return null;
  }

  const primaryLocation = customer.locations[0];
  const primaryContact = customer.contacts[0];

  return (
    <m.aside
      animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
      aria-label="Customer detail"
      className="detail-panel customer-detail-card customer-detail-motion"
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: motionTokens.distance.overlay, scale: 0.992 }}
      key={customer.id}
      transition={motionTokens.spring.gentle}
    >
      <div className="detail-header">
        <div className="customer-detail-heading">
          <span className="customer-detail-mark"><Building2 aria-hidden="true" size={19} /></span>
          <div>
            <span className="customer-detail-eyebrow">Customer</span>
            <h2>{customer.name}</h2>
          </div>
        </div>
        <div className="detail-actions">
          {canWrite ? (
            <button className="secondary-button compact-action" onClick={onEdit} type="button">
              <Edit3 aria-hidden="true" size={15} /> Edit
            </button>
          ) : null}
          <button className="icon-button light" aria-label="Close customer detail" onClick={onClose} type="button"><X size={17} /></button>
        </div>
      </div>

      <div className="tab-list" role="tablist" aria-label="Customer detail tabs">
        {tabs.map((tab) => (
          <button
            aria-selected={activeTab === tab}
            className={activeTab === tab ? "is-active" : ""}
            key={tab}
            role="tab"
            type="button"
            onClick={() => onTabChange(tab)}
          >
            {tab}{tab === "Locations" ? ` (${customer.locations.length})` : ""}
          </button>
        ))}
      </div>

      {activeTab === "Overview" ? (
        <div className="customer-detail-content">
          <section className="detail-section">
            <h3>Customer details</h3>
            <dl className="info-grid customer-info-grid">
              <div><dt>Name</dt><dd>{customer.name}</dd></div>
              <div><dt>Location</dt><dd>{primaryLocation?.name ?? "Not set"}</dd></div>
              <div><dt>Phone</dt><dd>{primaryContact?.phone ?? "Not set"}</dd></div>
              <div><dt>Email</dt><dd>{primaryContact?.email ?? "Not set"}</dd></div>
            </dl>
          </section>
          <section className="detail-section customer-requirements-grid">
            <div>
              <h3>PPE Requirements</h3>
              <RequirementList emptyLabel="No PPE requirements recorded." items={customer.ppeRequirements} />
            </div>
            <div>
              <h3>Additional Requirements</h3>
              <RequirementList emptyLabel="No additional requirements recorded." items={customer.additionalRequirements} />
            </div>
          </section>
        </div>
      ) : null}

      {activeTab === "Locations" ? (
        <section className="detail-section">
          <h3>Locations</h3>
          <div className="stack-list">
            {customer.locations.map((location) => (
              <article key={location.id}>
                <MapPin aria-hidden="true" size={17} />
                <div>
                  <strong>{location.name}</strong>
                  <span>{[location.address1, location.address2, location.city, location.state, location.country].filter(Boolean).join(", ") || "Location details not recorded"}</span>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </m.aside>
  );
}
