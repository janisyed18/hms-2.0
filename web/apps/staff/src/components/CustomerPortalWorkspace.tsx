import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createHmsClient } from "../api/hmsClient";
import type {
  AssetRecord,
  ApiListResult,
  CertificateRecord,
  CustomerRecord,
  InspectionBookingRecord,
  InspectionRecord,
  NotificationRecord,
  RetestScheduleRecord,
  StaffSession
} from "../domain/types";
import type { AppModule } from "./AppShell";
import { CustomerBookings } from "./CustomerBookings";
import { WorkspaceState } from "./WorkspaceState";

interface CustomerPortalWorkspaceProps {
  activeModule: AppModule;
  customerId: string | null;
  onCustomerChange: (customerId: string) => void;
  onModuleChange: (module: AppModule) => void;
  session: StaffSession;
}

interface PortalData {
  assets: AssetRecord[];
  bookings: InspectionBookingRecord[];
  certificates: CertificateRecord[];
  inspections: InspectionRecord[];
  notifications: NotificationRecord[];
  retests: RetestScheduleRecord[];
}

const emptyData: PortalData = {
  assets: [],
  bookings: [],
  certificates: [],
  inspections: [],
  notifications: [],
  retests: []
};

function formatDate(value: string | null): string {
  if (!value) return "Not available";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value)
  );
}

function formatDateTime(value: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {})
  }).format(new Date(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "This portal data could not be loaded.";
}

async function loadAllPages<T>(
  loadPage: (offset: number) => Promise<ApiListResult<T>>
): Promise<T[]> {
  const pageSize = 100;
  const first = await loadPage(0);
  const pages = await Promise.all(
    Array.from(
      { length: Math.ceil(Math.max(0, first.total - first.items.length) / pageSize) },
      (_, index) => loadPage(first.items.length + index * pageSize)
    )
  );
  return [...first.items, ...pages.flatMap((page) => page.items)];
}

async function loadAllNotifications(customerId: string): Promise<NotificationRecord[]> {
  const client = createHmsClient();
  const pageSize = 100;
  const first = await client.listNotifications({ customerId, limit: pageSize });
  const pages = await Promise.all(
    Array.from(
      { length: Math.ceil(Math.max(0, first.total - first.items.length) / pageSize) },
      (_, index) => client.listNotifications({
        customerId,
        limit: pageSize,
        offset: first.items.length + index * pageSize
      })
    )
  );
  return [...first.items, ...pages.flatMap((page) => page.items)];
}

export function CustomerPortalWorkspace({
  activeModule,
  customerId,
  onCustomerChange,
  onModuleChange,
  session
}: CustomerPortalWorkspaceProps) {
  const [customers, setCustomers] = useState<CustomerRecord[]>([]);
  const [customersError, setCustomersError] = useState<string | null>(null);
  const [data, setData] = useState<PortalData>(emptyData);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  // The organisation the loaded data belongs to. A refresh of the same organisation keeps the
  // last good data on screen (and the booking form's state); only a different one starts over.
  const loadedFor = useRef<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    const client = createHmsClient();
    void loadAllPages((offset) => client.listCustomers({ limit: 100, offset, sort: "name" }))
      .then((response) => {
        if (!current) return;
        setCustomers(response);
        setCustomersError(null);
      })
      .catch((loadError) => {
        if (!current) return;
        setCustomersError(errorMessage(loadError));
      });
    return () => {
      current = false;
    };
  }, []);

  const customer = useMemo(
    () => customers.find((item) => item.id === customerId) ?? null,
    [customerId, customers]
  );

  useEffect(() => {
    if (customers.length > 0 && !customer) {
      onCustomerChange(customers[0].id);
    }
  }, [customer, customers, onCustomerChange]);

  const loadCustomerData = useCallback(async () => {
    if (!customer) return;
    const refreshing = loadedFor.current === customer.id;
    if (!refreshing) {
      setData(emptyData);
      setStatus("loading");
      loadedFor.current = null;
    }
    setError(null);
    try {
      const client = createHmsClient();
      const [assets, bookings, certificates, inspections, notifications, retests] =
        await Promise.all([
          loadAllPages((offset) => client.listAssets({ customerId: customer.id, limit: 100, offset, sort: "asset_number" })),
          loadAllPages((offset) => client.listInspectionBookings({ customerId: customer.id, limit: 100, offset })),
          loadAllPages((offset) => client.listCertificates({ customerId: customer.id, limit: 100, offset, sort: "-issued_at" })),
          loadAllPages((offset) => client.listInspections({ customerId: customer.id, limit: 100, offset, sort: "-submitted_at" })),
          loadAllNotifications(customer.id),
          loadAllPages((offset) => client.listRetestSchedules({ customerId: customer.id, limit: 100, offset, sort: "due_at" }))
        ]);
      setData({
        assets,
        bookings,
        certificates,
        inspections,
        notifications,
        retests
      });
      loadedFor.current = customer.id;
      setRefreshError(null);
      setStatus("ready");
    } catch (loadError) {
      if (refreshing) {
        setRefreshError(errorMessage(loadError));
        return;
      }
      setError(errorMessage(loadError));
      setStatus("error");
    }
  }, [customer]);

  useEffect(() => {
    void loadCustomerData();
  }, [loadCustomerData]);

  if (customersError) {
    return <WorkspaceState title="Customer access unavailable" tone="error">{customersError}</WorkspaceState>;
  }
  if (customers.length === 0) {
    return <WorkspaceState title="No customer access" tone="empty">Your account is not assigned to an active customer workspace.</WorkspaceState>;
  }
  if (!customer || status === "loading") {
    return <WorkspaceState title="Loading your workspace" tone="loading">Retrieving only the records assigned to your organisation.</WorkspaceState>;
  }
  if (status === "error") {
    return <WorkspaceState title="Portal data unavailable" tone="error">{error}</WorkspaceState>;
  }

  return (
    <section className="customer-portal-workspace" aria-label="Customer portal workspace">
      {refreshError ? (
        <div className="portal-notice is-error" role="alert">
          <span>Some information could not be refreshed, so the last loaded data is shown. {refreshError}</span>
          <button className="secondary-button" type="button" onClick={() => void loadCustomerData()}>Try again</button>
        </div>
      ) : null}
      <header className="customer-portal-context">
        <div>
          <span className="eyebrow">Customer workspace</span>
          <strong>{customer.name}</strong>
        </div>
        {customers.length > 1 ? (
          <label>
            <span>Organisation</span>
            <select
              aria-label="Organisation"
              value={customer.id}
              onChange={(event) => onCustomerChange(event.target.value)}
            >
              {customers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
        ) : null}
      </header>

      {activeModule === "dashboard" ? <Dashboard customer={customer} data={data} onModuleChange={onModuleChange} /> : null}
      {activeModule === "assets" ? <Assets assets={data.assets} /> : null}
      {activeModule === "locations" ? <Locations customer={customer} assets={data.assets} onModuleChange={onModuleChange} /> : null}
      {activeModule === "bookings" ? (
        <CustomerBookings
          assets={data.assets}
          bookings={data.bookings}
          customer={customer}
          key={customer.id}
          onChanged={loadCustomerData}
        />
      ) : null}
      {activeModule === "inspections" ? <Inspections inspections={data.inspections} /> : null}
      {activeModule === "certificates" ? <Certificates certificates={data.certificates} /> : null}
      {activeModule === "retest" ? <Retests retests={data.retests} onModuleChange={onModuleChange} /> : null}
      {activeModule === "notifications" ? (
        <Notifications notifications={data.notifications} onChanged={loadCustomerData} />
      ) : null}
      <p className="customer-portal-session">Signed in as {session.displayName}.</p>
    </section>
  );
}

function Dashboard({ customer, data, onModuleChange }: { customer: CustomerRecord; data: PortalData; onModuleChange: (module: AppModule) => void }) {
  const due = data.retests.filter((item) => item.status === "DUE" || item.status === "OVERDUE");
  return <>
    <div className="customer-portal-metrics">
      <Metric label="Assets" value={customer.metrics.assetCount} />
      <Metric label="In service" value={customer.metrics.inServiceCount} />
      <Metric label="Retests requiring attention" value={due.length} />
      <Metric label="Open bookings" value={data.bookings.filter((item) => item.status === "PENDING_APPROVAL" || item.status === "APPROVED").length} />
    </div>
    <section className="portal-panel">
      <h2>Upcoming retests</h2>
      {due.length === 0 ? <p>No retests currently require attention.</p> : <ul className="portal-list">{due.slice(0, 5).map((item) => <li key={item.id}><strong>{item.asset.assetNumber}</strong><span>{item.status} · {formatDate(item.dueAt)}</span></li>)}</ul>}
    </section>
    <div className="portal-actions">
      <button type="button" onClick={() => onModuleChange("bookings")}>Book inspection</button>
      <button type="button" onClick={() => onModuleChange("assets")}>View assets</button>
      <button type="button" onClick={() => onModuleChange("certificates")}>View certificates</button>
    </div>
    <section className="portal-panel">
      <h2>Organisation</h2>
      <p>{customer.locations.length} approved location{customer.locations.length === 1 ? "" : "s"} and {customer.contacts.length} listed contact{customer.contacts.length === 1 ? "" : "s"}.</p>
    </section>
  </>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return <article className="customer-portal-metric"><span>{label}</span><strong>{value}</strong></article>;
}

function Assets({ assets }: { assets: AssetRecord[] }) {
  const [query, setQuery] = useState("");
  const [assetId, setAssetId] = useState<string | null>(null);
  const asset = assets.find((item) => item.id === assetId) ?? null;
  const visibleAssets = assets.filter((item) => `${item.assetNumber} ${item.assetName ?? ""} ${item.tag ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  if (asset) return <section className="portal-panel"><button type="button" onClick={() => setAssetId(null)}>Back to assets</button><h2>{asset.assetNumber}</h2><p>{asset.product.name} · {asset.lifecycleStatus}</p><dl className="portal-details"><div><dt>Location</dt><dd>{asset.location?.name ?? "Not assigned"}</dd></div><div><dt>Pressure rating</dt><dd>{asset.pressureRating ? `${asset.pressureRating.workingPressureKpa} kPa working / ${asset.pressureRating.testPressureKpa} kPa test` : "Not recorded"}</dd></div><div><dt>Next retest</dt><dd>{formatDate(asset.nextRetestDueAt)}</dd></div></dl><h3>Inspection history</h3>{asset.inspectionHistory.length ? <ul className="portal-list">{asset.inspectionHistory.map((item) => <li key={item.id}><strong>{item.inspectionType.replaceAll("_", " ")}</strong><span>{item.status} · {item.result ?? "Result pending"} · {formatDate(item.approvedAt ?? item.submittedAt)}</span></li>)}</ul> : <p>No inspection history is available.</p>}<h3>Certificate history</h3>{asset.certificateHistory.length ? <ul className="portal-list">{asset.certificateHistory.map((item) => <li key={item.id}><strong>{item.number}</strong><span>{item.status} · Valid through {formatDate(item.validUntil)}</span></li>)}</ul> : <p>No certificate history is available.</p>}</section>;
  return <section className="portal-panel"><h2>Assets</h2><label className="portal-search">Search assets<input aria-label="Search assets" value={query} onChange={(event) => setQuery(event.target.value)} /></label>{visibleAssets.length === 0 ? <p>No matching assets are assigned to this organisation.</p> : <ul className="portal-list">{visibleAssets.map((item) => <li key={item.id}><button className="portal-record-button" type="button" onClick={() => setAssetId(item.id)}><strong>{item.assetNumber}</strong><span>{item.product.name} · {item.location?.name ?? "No location"} · {item.lifecycleStatus}</span><span>Next retest: {formatDate(item.nextRetestDueAt)}</span></button></li>)}</ul>}</section>;
}

function Locations({ customer, assets, onModuleChange }: { customer: CustomerRecord; assets: AssetRecord[]; onModuleChange: (module: AppModule) => void }) {
  return <section className="portal-panel"><h2>Locations</h2>{customer.locations.length === 0 ? <p>No approved locations are available.</p> : <ul className="portal-list">{customer.locations.map((location) => <li key={location.id}><strong>{location.name}</strong><span>{[location.address1, location.city, location.state, location.country].filter(Boolean).join(", ") || "Address not recorded"}</span><span>{assets.filter((asset) => asset.location?.id === location.id).length} assigned asset(s)</span><span>{location.siteContactName ?? "No site contact"}{location.siteContactMobile ? ` · ${location.siteContactMobile}` : ""}</span><span>Timezone: {location.schedulingTimezone ?? "Not configured"}</span><span className="portal-actions"><button type="button" onClick={() => onModuleChange("assets")}>View assets</button><button type="button" onClick={() => onModuleChange("bookings")}>Book inspection</button></span></li>)}</ul>}</section>;
}

function Inspections({ inspections }: { inspections: InspectionRecord[] }) {
  return <section className="portal-panel"><h2>Inspections</h2>{inspections.length === 0 ? <p>No inspections are available.</p> : <ul className="portal-list">{inspections.map((inspection) => <li key={inspection.id}><strong>{inspection.asset.assetNumber}</strong><span>{inspection.inspectionType.replaceAll("_", " ")} · {inspection.status} · {inspection.result ?? "Result pending"}</span><span>{formatDate(inspection.submittedAt)}</span></li>)}</ul>}</section>;
}

function Certificates({ certificates }: { certificates: CertificateRecord[] }) {
  return <section className="portal-panel"><h2>Certificates</h2>{certificates.length === 0 ? <p>No certificates are available.</p> : <ul className="portal-list">{certificates.map((certificate) => <li key={certificate.id}><strong>{certificate.number}</strong><span>{certificate.asset.assetNumber} · {certificate.status} · Valid through {formatDate(certificate.validUntil)}</span><span className="portal-actions"><a href={`/api/v1/certificates/verify/${encodeURIComponent(certificate.publicToken)}`} target="_blank" rel="noreferrer">Verify certificate</a><a href={`/api/v1/certificates/verify/${encodeURIComponent(certificate.publicToken)}/pdf`} target="_blank" rel="noreferrer">Download PDF</a></span></li>)}</ul>}</section>;
}

function Retests({ retests, onModuleChange }: { retests: RetestScheduleRecord[]; onModuleChange: (module: AppModule) => void }) {
  return <section className="portal-panel"><h2>Retest schedule</h2>{retests.length === 0 ? <p>No retests are scheduled.</p> : <ul className="portal-list">{retests.map((retest) => <li key={retest.id}><strong>{retest.asset.assetNumber}</strong><span>{retest.status} · Due {formatDate(retest.dueAt)}</span><span className="portal-actions"><button type="button" onClick={() => onModuleChange("assets")}>View asset</button><button type="button" onClick={() => onModuleChange("bookings")}>Book inspection</button></span></li>)}</ul>}</section>;
}

function Notifications({ notifications, onChanged }: { notifications: NotificationRecord[]; onChanged: () => Promise<void> }) {
  const [pending, setPending] = useState<string | null>(null);
  return <section className="portal-panel"><h2>Notifications</h2>{notifications.length === 0 ? <p>No notifications for this organisation.</p> : <ul className="portal-list">{notifications.map((notification) => <li key={notification.id}><strong>{notification.subject ?? notification.category}</strong><span>{notification.body}</span><span>{formatDateTime(notification.createdAt)}</span>{notification.readAt ? <span>Read</span> : <button disabled={pending === notification.id} type="button" onClick={async () => { setPending(notification.id); try { await createHmsClient().markNotificationRead(notification.id); await onChanged(); } finally { setPending(null); } }}>Mark as read</button>}</li>)}</ul>}</section>;
}
