import { Building2, Edit3, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";

import { createHmsClient } from "../api/hmsClient";
import type { AssetRecord, CustomerRecord } from "../domain/types";
import { motionTokens } from "../motion/motionTokens";
import { ActionNotice } from "./interaction/ActionNotice";
import { CustomerContactsTab } from "./CustomerContactsTab";
import { CustomerLocationsTab } from "./CustomerLocationsTab";
import type { CustomerLifecycleAction } from "../hooks/useCustomerWorkspace";

interface CustomerDetailProps {
  activeTab: string;
  canWrite: boolean;
  /** Super Admin: the only role that may archive, restore or delete, and delete locations and contacts. */
  canDelete?: boolean;
  customer: CustomerRecord | null;
  onAssetOpen: (assetId: string) => void;
  /** Called with the customer as the server now has it, after a location or contact changed. */
  onCustomerChange?: (customer: CustomerRecord) => void;
  onClose: () => void;
  onEdit: () => void;
  onLifecycle?: (action: CustomerLifecycleAction, customer: CustomerRecord) => void;
  onTabChange: (tab: string) => void;
}

const tabs = ["Overview", "Locations", "Contacts"] as const;

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

export function CustomerDetail({
  activeTab,
  canWrite,
  canDelete = false,
  customer,
  onAssetOpen,
  onCustomerChange,
  onClose,
  onEdit,
  onLifecycle,
  onTabChange
}: CustomerDetailProps) {
  const reducedMotion = useReducedMotion();
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [assetTotal, setAssetTotal] = useState(0);
  const [assetsError, setAssetsError] = useState<string | null>(null);
  const [isLoadingAssets, setLoadingAssets] = useState(false);
  const [notice, setNotice] = useState<{ title: string; message: string } | null>(null);

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

  const customerId = customer?.id;
  useEffect(() => {
    if (customerId) {
      closeButtonRef.current?.focus();
      setNotice(null);
    }
  }, [customerId]);

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
              <article><span>Locations</span><strong>{customer.locations.length}</strong><small>Registered for this customer</small></article>
              <article><span>Needs attention</span><strong className={customer.metrics.inspectionDueCount === null ? undefined : customer.metrics.inspectionDueCount ? "danger-text" : "success-text"}>{customer.metrics.inspectionDueCount ?? "—"}</strong><small>{customer.metrics.inspectionDueLabel}</small></article>
              <article><span>Certificate coverage</span><strong>{customer.metrics.certificateValidPercent === null ? "—" : `${customer.metrics.certificateValidPercent}%`}</strong><small>{customer.metrics.certificateStatusLabel}</small></article>
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
                  {tab}{tab === "Locations" ? ` (${customer.locations.length})` : tab === "Contacts" ? ` (${customer.contacts.length})` : ""}
                </button>
              ))}
            </div>

            {notice ? <ActionNotice kind="success" onDismiss={() => setNotice(null)} title={notice.title}>{notice.message}</ActionNotice> : null}

            {activeTab === "Overview" ? (
              <section className="customer-location-section" aria-label="Customer overview">
                <div className="inspection-facts">
                  <div><span>Status</span><strong>{customer.status}</strong></div>
                  <div><span>Retest reminders</span><strong>{customer.retestEnabled ? `Every ${customer.defaultRetestMonths ?? "—"} months` : "Not enabled"}</strong></div>
                  <div><span>Locations</span><strong>{customer.locations.length}</strong></div>
                  <div><span>Contacts</span><strong>{customer.contacts.length}</strong></div>
                </div>
                <div><h4>Global Customer Notes</h4><p>{customer.notes || "No global customer notes recorded."}</p></div>
                {canDelete && onLifecycle ? (
                  <div className="row-actions" role="group" aria-label="Customer lifecycle">
                    {customer.status === "Active" ? (
                      <button className="secondary-button compact-action" onClick={() => onLifecycle("archive", customer)} type="button">Archive customer</button>
                    ) : (
                      <>
                        <button className="secondary-button compact-action" onClick={() => onLifecycle("restore", customer)} type="button">Restore customer</button>
                        <button className="secondary-button compact-action" onClick={() => onLifecycle("delete", customer)} type="button">Delete customer</button>
                      </>
                    )}
                  </div>
                ) : null}
                {customer.status === "Archived" ? (
                  <p className="empty-requirements">This customer is archived. It and its history are kept, and it is left out of new work until it is restored.</p>
                ) : null}
              </section>
            ) : null}

            {activeTab === "Locations" ? (
              <CustomerLocationsTab
                assets={assets}
                assetsError={assetsError}
                canDelete={canDelete}
                canWrite={canWrite && customer.status === "Active"}
                customer={customer}
                isLoadingAssets={isLoadingAssets}
                onAssetOpen={(assetId) => { onClose(); onAssetOpen(assetId); }}
                onChanged={(fresh) => onCustomerChange?.(fresh)}
                onNotice={(title, message) => setNotice({ title, message })}
              />
            ) : null}

            {activeTab === "Contacts" ? (
              <CustomerContactsTab
                canDelete={canDelete}
                canWrite={canWrite}
                customer={customer}
                onChanged={(fresh) => onCustomerChange?.(fresh)}
                onNotice={(title, message) => setNotice({ title, message })}
              />
            ) : null}
          </m.section>
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}
