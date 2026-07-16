import {
  Building2,
  Edit3,
  ExternalLink,
  FileText,
  MapPin,
  MoreVertical,
  Phone,
  X
} from "lucide-react";

import type { CustomerRecord } from "../domain/types";
import { PresencePanel } from "../motion/MotionPrimitives";

interface CustomerDetailProps {
  customer: CustomerRecord | null;
  activeTab: string;
  onClose: () => void;
  onTabChange: (tab: string) => void;
}

const tabs = ["Overview", "Locations", "Contacts", "Documents", "Notes"];

function statusClass(value: string) {
  return value.toLowerCase().replace(" ", "-");
}

export function CustomerDetail({
  customer,
  activeTab,
  onClose,
  onTabChange
}: CustomerDetailProps) {
  if (!customer) {
    return (
      <aside className="detail-panel" aria-label="Customer detail">
        <p>No customer selected.</p>
      </aside>
    );
  }

  const primaryLocation = customer.locations[0];

  return (
    <PresencePanel className="customer-detail-motion" presenceKey={customer.id}>
      <aside className="detail-panel customer-detail-card" aria-label="Customer detail">
        <div className="detail-header">
          <div className="customer-detail-heading">
            <span className="customer-detail-mark">
              <Building2 aria-hidden="true" size={19} />
            </span>
            <div>
              <span className="customer-detail-eyebrow">Customer record</span>
              <h2>{customer.name}</h2>
            </div>
            <div className="detail-tags">
              <span className={`status-pill risk-${customer.riskLevel.toLowerCase()}`}>
                {customer.riskLevel} Risk
              </span>
              <span className={`status-pill status-${statusClass(customer.status)}`}>
                {customer.status}
              </span>
            </div>
          </div>
        <div className="detail-actions">
          <button
            className="icon-button light"
            aria-label="Close customer detail"
            onClick={onClose}
            type="button"
          >
            <X size={17} />
          </button>
          <button className="icon-button light" aria-label="More detail actions" type="button">
            <MoreVertical size={17} />
          </button>
        </div>
        </div>

      <div className="summary-grid">
        <div>
          <span>Assets</span>
          <strong>{customer.metrics.assetCount}</strong>
          <button type="button">View all</button>
        </div>
        <div>
          <span>Inspections</span>
          <strong className={customer.metrics.inspectionDueCount ? "danger-text" : ""}>
            {customer.metrics.inspectionDueCount}
          </strong>
          <em>{customer.metrics.inspectionDueCount ? "Overdue" : "Current"}</em>
        </div>
        <div>
          <span>Certificates</span>
          <strong className="success-text">{customer.metrics.certificateValidPercent}%</strong>
          <em>Valid</em>
        </div>
        <div>
          <span>Locations</span>
          <strong>{customer.locations.length}</strong>
          <em>Sites</em>
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
            {tab}
            {tab === "Locations" ? ` (${customer.locations.length})` : ""}
            {tab === "Contacts" ? ` (${customer.contacts.length})` : ""}
          </button>
        ))}
      </div>

      {activeTab === "Overview" ? (
        <>
          <section className="detail-section">
            <div className="section-heading compact">
              <h3>Customer Information</h3>
              <button type="button">
                <Edit3 aria-hidden="true" size={15} />
                Edit
              </button>
            </div>
            <dl className="info-grid">
              <div>
                <dt>Customer ID</dt>
                <dd>{customer.code}-{customer.id.slice(-4).toUpperCase()}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd className="success-text">{customer.status}</dd>
              </div>
              <div>
                <dt>Industry</dt>
                <dd>{customer.industry}</dd>
              </div>
              <div>
                <dt>Risk Level</dt>
                <dd className={customer.riskLevel === "High" ? "danger-text" : ""}>
                  {customer.riskLevel}
                </dd>
              </div>
              <div>
                <dt>Primary Location</dt>
                <dd>{primaryLocation ? [primaryLocation.city, primaryLocation.country].filter(Boolean).join(", ") : "Not set"}</dd>
              </div>
              <div>
                <dt>Payment Terms</dt>
                <dd>{customer.paymentTerms}</dd>
              </div>
              <div>
                <dt>Contract Start</dt>
                <dd>{customer.contractStart}</dd>
              </div>
              <div>
                <dt>Contract End</dt>
                <dd>{customer.contractEnd}</dd>
              </div>
            </dl>
          </section>

          <section className="detail-section">
            <h3>Asset &amp; Inspection Summary</h3>
            <div className="mini-grid">
              <div>
                <span>Total Assets</span>
                <strong>{customer.metrics.assetCount}</strong>
                <button type="button">View assets</button>
              </div>
              <div>
                <span>In Service</span>
                <strong className="success-text">{customer.metrics.inServiceCount}</strong>
                <em>91%</em>
              </div>
              <div>
                <span>Out of Service</span>
                <strong>{customer.metrics.outOfServiceCount}</strong>
                <em>9%</em>
              </div>
              <div>
                <span>Inspection Due</span>
                <strong className="danger-text">{customer.metrics.inspectionDueCount}</strong>
                <em>Overdue</em>
              </div>
            </div>
          </section>

          <section className="inspection-list">
            <div className="section-heading compact">
              <h3>Recent Inspections</h3>
              <button type="button">View all</button>
            </div>
            {customer.metrics.recentInspections.map((inspection) => (
              <article key={inspection.id}>
                <span className={`mini-status ${statusClass(inspection.status)}`}>
                  {inspection.status}
                </span>
                <strong>{inspection.asset}</strong>
                <time>{inspection.date}</time>
                <span>{inspection.locationCode}</span>
              </article>
            ))}
          </section>
        </>
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
                  <span>
                    {[location.address1, location.address2, location.city, location.state, location.country]
                      .filter(Boolean)
                      .join(", ") || "No address recorded"}
                  </span>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {activeTab === "Contacts" ? (
        <section className="detail-section">
          <h3>Contacts</h3>
          <div className="stack-list">
            {customer.contacts.map((contact) => (
              <article key={contact.id}>
                <Phone aria-hidden="true" size={17} />
                <div>
                  <strong>{contact.name}</strong>
                  <span>{contact.role ?? "Contact"} * {contact.email ?? "No email"}</span>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {activeTab === "Documents" ? (
        <section className="detail-section empty-section">
          <FileText aria-hidden="true" size={20} />
          <h3>Documents</h3>
          <p>No documents are attached to this development record.</p>
        </section>
      ) : null}

      {activeTab === "Notes" ? (
        customer.notes ? (
          <section className="detail-section">
            <h3>Notes</h3>
            <p className="record-notes">{customer.notes}</p>
          </section>
        ) : (
          <section className="detail-section empty-section">
            <FileText aria-hidden="true" size={20} />
            <h3>Notes</h3>
            <p>No notes are attached to this development record.</p>
          </section>
        )
      ) : null}

      <button className="detail-link" type="button">
        View Customer Details
        <ExternalLink aria-hidden="true" size={17} />
      </button>
      </aside>
    </PresencePanel>
  );
}
