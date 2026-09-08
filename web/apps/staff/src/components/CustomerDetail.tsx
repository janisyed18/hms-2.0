import { Building2, Edit3, MapPin, Package, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";

import { createHmsClient } from "../api/hmsClient";
import type { AssetRecord, CustomerRecord } from "../domain/types";
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

interface CustomerAssets {
  items: AssetRecord[];
  total: number;
}

async function loadCustomerAssets(customerId: string): Promise<CustomerAssets> {
  const client = createHmsClient();
  const firstPage = await client.listAssets({ customerId, limit: 100, sort: "asset_number" });
  if (firstPage.total <= firstPage.items.length) {
    return { items: firstPage.items, total: firstPage.total };
  }

  const pageRequests = Array.from(
    { length: Math.ceil((firstPage.total - firstPage.items.length) / 100) },
    (_, index) => client.listAssets({
      customerId,
      limit: 100,
      offset: firstPage.items.length + index * 100,
      sort: "asset_number"
    })
  );
  const remainingPages = await Promise.all(pageRequests);
  return {
    items: [...firstPage.items, ...remainingPages.flatMap((page) => page.items)],
    total: firstPage.total
  };
}

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
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [assetTotal, setAssetTotal] = useState(0);
  const [assetsError, setAssetsError] = useState<string | null>(null);
  const [isLoadingAssets, setLoadingAssets] = useState(false);

  useEffect(() => {
    if (!customer) {
      return;
    }
    let active = true;
    setLoadingAssets(true);
    setAssetsError(null);
    setAssets([]);
    setAssetTotal(0);
    void loadCustomerAssets(customer.id)
      .then((result) => {
        if (!active) return;
        setAssets(result.items);
        setAssetTotal(result.total);
      })
      .catch(() => {
        if (active) setAssetsError("Asset locations could not be loaded.");
      })
      .finally(() => {
        if (active) setLoadingAssets(false);
      });
    return () => {
      active = false;
    };
  }, [customer]);

  useEffect(() => {
    if (customer) {
      closeButtonRef.current?.focus();
    }
  }, [customer]);

  const locationGroups = useMemo(() => (customer?.locations ?? [])
    .map((location) => ({
      location,
      assets: assets.filter((asset) => asset.location?.id === location.id)
    }))
    .sort((left, right) => left.location.name.localeCompare(right.location.name)), [assets, customer]);
  const unassignedAssets = assets.filter((asset) => !asset.location).length;

  const primaryContact = customer?.contacts[0];

  return (
    <AnimatePresence initial={false}>
      {customer ? (
        <m.div
          animate={{ opacity: 1 }}
          aria-labelledby="customer-detail-title"
          aria-modal="true"
          className="customer-detail-backdrop"
          exit={{ opacity: 0, transition: { duration: reducedMotion ? 0 : motionTokens.duration.fast } }}
          initial={false}
          key={customer.id}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
              return;
            }
            if (event.key === "Tab" && dialogRef.current) {
              const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
                'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
              ));
              if (!focusable.length) return;
              const first = focusable[0];
              const last = focusable[focusable.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
              }
            }
          }}
          role="dialog"
          transition={{ duration: reducedMotion ? 0 : motionTokens.duration.fast }}
        >
          <m.section
            animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            className="customer-detail-dialog"
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: motionTokens.distance.overlay, scale: 0.99 }}
            initial={false}
            ref={dialogRef}
            transition={motionTokens.spring.gentle}
          >
            <header className="customer-detail-dialog-header">
              <div className="customer-detail-heading">
                <span className="customer-detail-mark"><Building2 aria-hidden="true" size={19} /></span>
                <div>
                  <span className="customer-detail-eyebrow">Customer profile</span>
                  <h2 id="customer-detail-title">{customer.name}</h2>
                  <p>{customer.code} · {customer.status}</p>
                </div>
              </div>
              <div className="detail-actions">
                {canWrite ? (
                  <button className="secondary-button compact-action" onClick={onEdit} type="button">
                    <Edit3 aria-hidden="true" size={15} /> Edit customer
                  </button>
                ) : null}
                <button ref={closeButtonRef} className="icon-button light" aria-label="Close customer detail" onClick={onClose} type="button"><X size={18} /></button>
              </div>
            </header>

            <div className="customer-profile-metrics" aria-label="Customer asset summary">
              <article><span>Assets</span><strong>{isLoadingAssets ? "…" : assetTotal}</strong><small>Assigned to this customer</small></article>
              <article><span>Active locations</span><strong>{isLoadingAssets ? "…" : locationGroups.length}</strong><small>Derived from asset assignments</small></article>
              <article><span>Needs attention</span><strong className={customer.metrics.inspectionDueCount ? "danger-text" : "success-text"}>{customer.metrics.inspectionDueCount}</strong><small>{customer.metrics.inspectionDueLabel}</small></article>
              <article><span>Certificate coverage</span><strong>{customer.metrics.certificateValidPercent}%</strong><small>{customer.metrics.certificateStatusLabel}</small></article>
            </div>

            <div className="tab-list customer-detail-tabs" role="tablist" aria-label="Customer detail tabs">
              {tabs.map((tab) => (
                <button
                  aria-selected={activeTab === tab}
                  className={activeTab === tab ? "is-active" : ""}
                  key={tab}
                  role="tab"
                  type="button"
                  onClick={() => onTabChange(tab)}
                >
                  {tab}{tab === "Locations" ? ` (${isLoadingAssets ? "…" : locationGroups.length})` : ""}
                </button>
              ))}
            </div>

            {activeTab === "Overview" ? (
              <div className="customer-detail-content">
                <section className="detail-section">
                  <h3>Customer details</h3>
                  <dl className="info-grid customer-info-grid">
                    <div><dt>Name</dt><dd>{customer.name}</dd></div>
                    <div><dt>Primary asset location</dt><dd>{locationGroups[0]?.location.name ?? "No assigned asset location"}</dd></div>
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
              <section className="customer-location-section">
                <div className="customer-location-section-heading">
                  <div>
                    <h3>Asset locations</h3>
                  <p>Locations include their nominated site contact and assigned assets.</p>
                  </div>
                  {unassignedAssets ? <span className="mini-status due-soon">{unassignedAssets} unassigned</span> : null}
                </div>
                {isLoadingAssets ? <p className="customer-location-loading">Loading asset locations…</p> : null}
                {assetsError ? <p className="form-error" role="alert">{assetsError}</p> : null}
                {!isLoadingAssets && !assetsError && locationGroups.length === 0 ? (
                  <div className="customer-location-empty">
                    <Package aria-hidden="true" size={20} />
                    <p>No assets with a location are assigned to this customer.</p>
                  </div>
                ) : null}
                <div className="customer-location-grid">
                  {locationGroups.map(({ location, assets: locationAssets }) => (
                    <article key={location.id}>
                      <span className="customer-location-icon"><MapPin aria-hidden="true" size={18} /></span>
                      <div>
                        <h4>{location.name}</h4>
                    <p>{[location.address1, location.address2, location.city, location.state, location.country].filter(Boolean).join(", ") || "Location details not recorded"}</p>
                    <p className="customer-location-contact">{location.siteContactName ? `Site contact: ${location.siteContactName}${location.siteContactMobile ? ` · ${location.siteContactMobile}` : ""}${location.siteContactEmail ? ` · ${location.siteContactEmail}` : ""}` : "Site contact not recorded"}</p>
                      </div>
                      <strong>{locationAssets.length}<small>{locationAssets.length === 1 ? "asset" : "assets"}</small></strong>
                      <ul aria-label={`Assets at ${location.name}`}>
                        {locationAssets.map((asset) => <li key={asset.id}>{asset.assetNumber}</li>)}
                      </ul>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}
          </m.section>
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}
