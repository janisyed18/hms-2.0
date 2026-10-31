import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createHmsClient } from "../api/hmsClient";
import type {
  AssetRecord,
  ApiListResult,
  CertificateRecord,
  CustomerRecord,
  InspectionBookingRecord,
  InspectionRecord,
  RetestScheduleRecord,
  StaffSession
} from "../domain/types";
import type { AppModule } from "./AppShell";
import { CustomerBookings } from "./CustomerBookings";
import { WorkspaceState } from "./WorkspaceState";
import { assetDisplayName, assetHasDistinctName, assetLabel, initialsOf } from "../utils/identity";
import { AssetIdentity } from "./AssetIdentity";
import { Select } from "./interaction/Select";
import { certificateStatusLabel, inspectionResultLabel, inspectionStatusLabel, lifecycleStatusLabel, plainWords, retestStatusLabel } from "../utils/statusLabels";

interface CustomerPortalWorkspaceProps {
  activeModule: AppModule;
  customerId: string | null;
  /** The asset the URL names; null when none is open. */
  assetId: string | null;
  onAssetChange: (assetId: string | null, options?: { replace?: boolean }) => void;
  onCustomerChange: (customerId: string, options?: { replace?: boolean }) => void;
  onModuleChange: (module: AppModule) => void;
  session: StaffSession;
}

interface PortalData {
  assets: AssetRecord[];
  bookings: InspectionBookingRecord[];
  certificates: CertificateRecord[];
  inspections: InspectionRecord[];
  retests: RetestScheduleRecord[];
}

const emptyData: PortalData = {
  assets: [],
  bookings: [],
  certificates: [],
  inspections: [],
  retests: []
};

function formatDate(value: string | null): string {
  if (!value) return "Not available";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value)
  );
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

export function CustomerPortalWorkspace({
  activeModule,
  customerId,
  assetId,
  onAssetChange,
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

  // With no organisation chosen the first one is selected (without adding a history entry). An
  // organisation named by the link that this account cannot see is never swapped for another one.
  useEffect(() => {
    if (customers.length > 0 && !customer && !customerId) {
      onCustomerChange(customers[0].id, { replace: true });
    }
  }, [customer, customerId, customers, onCustomerChange]);

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
      const [assets, bookings, certificates, inspections, retests] =
        await Promise.all([
          loadAllPages((offset) => client.listAssets({ customerId: customer.id, limit: 100, offset, sort: "asset_number" })),
          loadAllPages((offset) => client.listInspectionBookings({ customerId: customer.id, limit: 100, offset })),
          loadAllPages((offset) => client.listCertificates({ customerId: customer.id, limit: 100, offset, sort: "-issued_at" })),
          loadAllPages((offset) => client.listInspections({ customerId: customer.id, limit: 100, offset, sort: "-submitted_at" })),
          loadAllPages((offset) => client.listRetestSchedules({ customerId: customer.id, limit: 100, offset, sort: "due_at" }))
        ]);
      setData({
        assets,
        bookings,
        certificates,
        inspections,
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
  if (customerId && !customer) {
    return (
      <WorkspaceState
        action={<button className="secondary-button" type="button" onClick={() => onCustomerChange(customers[0].id, { replace: true })}>Open {customers[0].name}</button>}
        title="Organisation unavailable"
        tone="error"
      >
        That organisation could not be found, or your account does not have access to it.
      </WorkspaceState>
    );
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
        <div className="customer-portal-identity">
          <span aria-hidden="true" className="customer-avatar">{initialsOf(customer.name)}</span>
          <div>
            <span className="eyebrow">Customer workspace</span>
            <strong>{customer.name}</strong>
          </div>
        </div>
        {customers.length > 1 ? (
          <label>
            <span>Organisation</span>
            <Select
              aria-label="Organisation"
              onChange={onCustomerChange}
              options={customers.map((item) => ({ value: item.id, label: item.name }))}
              value={customer.id}
            />
          </label>
        ) : null}
      </header>

      {activeModule === "dashboard" ? <Dashboard customer={customer} data={data} onModuleChange={onModuleChange} /> : null}
      {activeModule === "assets" ? <Assets assets={data.assets} assetId={assetId} organisation={customer.name} onAssetChange={onAssetChange} /> : null}
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
      <p className="customer-portal-session">Signed in as {session.displayName}.</p>
    </section>
  );
}

function Dashboard({ customer, data, onModuleChange }: { customer: CustomerRecord; data: PortalData; onModuleChange: (module: AppModule) => void }) {
  const due = data.retests.filter((item) => item.status === "DUE" || item.status === "OVERDUE");
  const openBookings = data.bookings.filter((item) => item.status === "PENDING_APPROVAL" || item.status === "APPROVED").length;
  const awaitingYou = data.bookings.filter((booking) => booking.changeRequests.some((change) => change.status === "PENDING_CUSTOMER_CONFIRMATION"));
  const organisation = (
    <section aria-labelledby="portal-organisation" className="portal-panel">
      <h2 id="portal-organisation">Sites and contacts</h2>
      <p>{customer.locations.length} approved location{customer.locations.length === 1 ? "" : "s"} and {customer.contacts.length} listed contact{customer.contacts.length === 1 ? "" : "s"}.</p>
    </section>
  );
  if (customer.metrics.assetCount === 0) {
    return <>
      <section aria-labelledby="portal-no-assets" className="portal-panel">
        <h2 className="sr-only" id="portal-no-assets">Assets</h2>
        <WorkspaceState title="No assets yet">Assets registered for {customer.name} will appear here, with their retest dates and certificates.</WorkspaceState>
      </section>
      {organisation}
    </>;
  }
  return <>
    <div aria-label="At a glance" className="customer-portal-metrics" role="group">
      <Metric label="Assets" value={customer.metrics.assetCount} />
      <Metric label="In service" value={customer.metrics.inServiceCount} />
      <Metric label="Retests requiring attention" value={due.length} />
      <Metric label="Open bookings" value={openBookings} />
    </div>
    <section aria-labelledby="portal-attention" className="portal-panel">
      <h2 id="portal-attention">Needs attention</h2>
      {awaitingYou.length > 0 ? (
        <p className="portal-notice is-warning">
          <span>{awaitingYou.length === 1 ? "A new time for one of your bookings is waiting for your confirmation." : `New times for ${awaitingYou.length} of your bookings are waiting for your confirmation.`}</span>
          <button className="secondary-button" type="button" onClick={() => onModuleChange("bookings")}>Review bookings</button>
        </p>
      ) : null}
      {due.length === 0 && awaitingYou.length === 0 ? (
        <WorkspaceState title="Nothing needs attention">You are up to date. Assets appear here when a retest approaches.</WorkspaceState>
      ) : null}
      {due.length > 0 ? <ul className="portal-list">{due.slice(0, 5).map((item) => <li key={item.id}><AssetIdentity asset={item.asset} /><span>{retestStatusLabel(item.status)} · {formatDate(item.dueAt)}</span></li>)}</ul> : null}
    </section>
    <section aria-labelledby="portal-next" className="portal-panel">
      <h2 id="portal-next">Next steps</h2>
      <div className="portal-actions">
        <button className="primary-button" type="button" onClick={() => onModuleChange("bookings")}>Book inspection</button>
        <button className="secondary-button" type="button" onClick={() => onModuleChange("assets")}>View assets</button>
        <button className="secondary-button" type="button" onClick={() => onModuleChange("certificates")}>View certificates</button>
      </div>
    </section>
    {organisation}
  </>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return <article className="customer-portal-metric"><span>{label}</span><strong>{value}</strong></article>;
}

function Assets({ assets, assetId, organisation, onAssetChange }: { assets: AssetRecord[]; assetId: string | null; organisation: string; onAssetChange: (assetId: string | null, options?: { replace?: boolean }) => void }) {
  const [query, setQuery] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const asset = assets.find((item) => item.id === assetId) ?? null;
  // An asset the link names that is not among this organisation's is never shown; the link stops naming it.
  useEffect(() => {
    if (assetId && !asset) {
      setUnavailable(true);
      onAssetChange(null, { replace: true });
    } else if (asset) {
      setUnavailable(false);
    }
  }, [asset, assetId, onAssetChange]);
  const visibleAssets = assets.filter((item) => `${item.assetNumber} ${item.assetName ?? ""} ${item.tag ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  if (asset) return <section className="portal-panel"><button type="button" onClick={() => onAssetChange(null)}>Back to assets</button><h2>{assetDisplayName(asset)}</h2><p>{[assetHasDistinctName(asset) ? `Asset #${asset.assetNumber}` : null, asset.product.name, lifecycleStatusLabel(asset.lifecycleStatus)].filter(Boolean).join(" · ")}</p><dl className="portal-details"><div><dt>Location</dt><dd>{asset.location?.name ?? "Not assigned"}</dd></div><div><dt>Pressure rating</dt><dd>{asset.pressureRating ? `${asset.pressureRating.workingPressureKpa} kPa working / ${asset.pressureRating.testPressureKpa} kPa test` : "Not recorded"}</dd></div><div><dt>Next retest</dt><dd>{formatDate(asset.nextRetestDueAt)}</dd></div></dl><h3>Inspection history</h3>{asset.inspectionHistory.length ? <ul className="portal-list">{asset.inspectionHistory.map((item) => <li key={item.id}><strong>{plainWords(item.inspectionType)}</strong><span>{inspectionStatusLabel(item.status)} · {inspectionResultLabel(item.result)} · {formatDate(item.approvedAt ?? item.submittedAt)}</span></li>)}</ul> : <p>No inspection history is available.</p>}<h3>Certificate history</h3>{asset.certificateHistory.length ? <ul className="portal-list">{asset.certificateHistory.map((item) => <li key={item.id}><strong>{item.number}</strong><span>{item.status} · Valid through {formatDate(item.validUntil)}</span></li>)}</ul> : <p>No certificate history is available.</p>}</section>;
  return <section className="portal-panel"><h2>Assets</h2>{unavailable ? <p className="portal-notice is-error" role="alert">That asset could not be found for this organisation.</p> : null}<label className="portal-search">Search assets<span className="portal-search__field"><input aria-label="Search assets" placeholder="Search assets by name, number or tag" value={query} onChange={(event) => setQuery(event.target.value)} />{query ? <button aria-label="Clear search" className="search-clear" type="button" onClick={() => setQuery("")}>×</button> : null}</span></label><p aria-live="polite" className="portal-count">{query.trim() ? `${visibleAssets.length} matching ${visibleAssets.length === 1 ? "asset" : "assets"}` : `${assets.length} ${assets.length === 1 ? "asset" : "assets"}`}</p>{visibleAssets.length === 0 ? (query.trim() ? <WorkspaceState action={<button className="secondary-button" type="button" onClick={() => setQuery("")}>Show all assets</button>} title="No matching assets">Try a different name, number or tag.</WorkspaceState> : <WorkspaceState title="No assets yet">Assets registered for {organisation} will appear here.</WorkspaceState>) : <ul className="portal-list">{visibleAssets.map((item) => <li key={item.id}><button className="portal-record-button" type="button" onClick={() => onAssetChange(item.id)}><AssetIdentity asset={item} /><span>{item.product.name} · {item.location?.name ?? "No location"} · {lifecycleStatusLabel(item.lifecycleStatus)}</span><span>Next retest: {formatDate(item.nextRetestDueAt)}</span></button></li>)}</ul>}</section>;
}

function Locations({ customer, assets, onModuleChange }: { customer: CustomerRecord; assets: AssetRecord[]; onModuleChange: (module: AppModule) => void }) {
  return <section className="portal-panel"><h2>Locations</h2>{customer.locations.length === 0 ? <WorkspaceState title="No approved locations">Approved locations for {customer.name} will appear here.</WorkspaceState> : <ul className="portal-list">{customer.locations.map((location) => <li key={location.id}><strong>{location.name}</strong><span>{[location.address1, location.city, location.state, location.country].filter(Boolean).join(", ") || "Address not recorded"}</span><span>{assets.filter((asset) => asset.location?.id === location.id).length} assigned asset(s)</span><span>{location.siteContactName ?? "No site contact"}{location.siteContactMobile ? ` · ${location.siteContactMobile}` : ""}</span><span>Timezone: {location.schedulingTimezone ?? "Not configured"}</span><span className="portal-actions"><button className="secondary-button" type="button" onClick={() => onModuleChange("assets")}>View assets</button><button className="primary-button" type="button" onClick={() => onModuleChange("bookings")}>Book inspection</button></span></li>)}</ul>}</section>;
}

function Inspections({ inspections }: { inspections: InspectionRecord[] }) {
  return <section className="portal-panel"><h2>Inspections</h2>{inspections.length === 0 ? <WorkspaceState title="No inspections yet">Inspections appear here once one has been completed for your assets.</WorkspaceState> : <ul className="portal-list">{inspections.map((inspection) => <li key={inspection.id}><AssetIdentity asset={inspection.asset} /><span>{plainWords(inspection.inspectionType)} · {inspectionStatusLabel(inspection.status)} · {inspectionResultLabel(inspection.result)}</span><span>{formatDate(inspection.submittedAt)}</span></li>)}</ul>}</section>;
}

function Certificates({ certificates }: { certificates: CertificateRecord[] }) {
  return <section className="portal-panel"><h2>Certificates</h2>{certificates.length === 0 ? <WorkspaceState title="No certificates yet">A certificate is issued once an inspection has been approved.</WorkspaceState> : <ul className="portal-list">{certificates.map((certificate) => <li key={certificate.id}><strong>{certificate.number}</strong><span>{assetLabel(certificate.asset)} · {certificateStatusLabel(certificate.status)} · Valid through {formatDate(certificate.validUntil)}</span><span className="portal-actions"><a href={`/api/v1/certificates/verify/${encodeURIComponent(certificate.publicToken)}`} target="_blank" rel="noreferrer">Verify certificate</a><a href={`/api/v1/certificates/verify/${encodeURIComponent(certificate.publicToken)}/pdf`} target="_blank" rel="noreferrer">Download PDF</a></span></li>)}</ul>}</section>;
}

function Retests({ retests, onModuleChange }: { retests: RetestScheduleRecord[]; onModuleChange: (module: AppModule) => void }) {
  return <section className="portal-panel"><h2>Retest schedule</h2>{retests.length === 0 ? <WorkspaceState title="No retests scheduled">You are up to date. Retests appear here when an asset has a retest date.</WorkspaceState> : <ul className="portal-list">{retests.map((retest) => <li key={retest.id}><AssetIdentity asset={retest.asset} /><span>{retestStatusLabel(retest.status)} · Due {formatDate(retest.dueAt)}</span><span className="portal-actions"><button className="secondary-button" type="button" onClick={() => onModuleChange("assets")}>View asset</button><button className="primary-button" type="button" onClick={() => onModuleChange("bookings")}>Book inspection</button></span></li>)}</ul>}</section>;
}


