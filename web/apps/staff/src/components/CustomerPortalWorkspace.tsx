import { useCallback, useEffect, useMemo, useState } from "react";

import { createHmsClient } from "../api/hmsClient";
import type {
  AssetRecord,
  CertificateRecord,
  CustomerRecord,
  InspectionAvailabilitySlot,
  InspectionBookingRecord,
  InspectionRecord,
  NotificationRecord,
  RetestScheduleRecord,
  StaffSession
} from "../domain/types";
import type { AppModule } from "./AppShell";
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

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "This portal data could not be loaded.";
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

  useEffect(() => {
    let current = true;
    void createHmsClient()
      .listCustomers({ limit: 100, sort: "name" })
      .then((response) => {
        if (!current) return;
        setCustomers(response.items);
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
    setStatus("loading");
    setError(null);
    try {
      const client = createHmsClient();
      const [assets, bookings, certificates, inspections, notifications, retests] =
        await Promise.all([
          client.listAssets({ customerId: customer.id, limit: 100, sort: "asset_number" }),
          client.listInspectionBookings({ customerId: customer.id, limit: 100 }),
          client.listCertificates({ customerId: customer.id, limit: 100, sort: "-issued_at" }),
          client.listInspections({ customerId: customer.id, limit: 100, sort: "-submitted_at" }),
          client.listNotifications(),
          client.listRetestSchedules({ customerId: customer.id, limit: 100, sort: "due_at" })
        ]);
      setData({
        assets: assets.items,
        bookings: bookings.items,
        certificates: certificates.items,
        inspections: inspections.items,
        notifications: notifications.items.filter(
          (item) => item.customerId === customer.id
        ),
        retests: retests.items
      });
      setStatus("ready");
    } catch (loadError) {
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
        <Bookings customer={customer} data={data} onChanged={loadCustomerData} />
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
      <Metric label="Assets" value={data.assets.length} />
      <Metric label="In service" value={data.assets.filter((item) => item.lifecycleStatus === "IN_SERVICE").length} />
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

function Bookings({ customer, data, onChanged }: { customer: CustomerRecord; data: PortalData; onChanged: () => Promise<void> }) {
  const [locationId, setLocationId] = useState("");
  const [assetId, setAssetId] = useState("");
  const [localDate, setLocalDate] = useState("");
  const [slots, setSlots] = useState<InspectionAvailabilitySlot[]>([]);
  const [quoteId, setQuoteId] = useState("");
  const [additionalInformation, setAdditionalInformation] = useState("");
  const [rescheduleBookingId, setRescheduleBookingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const locationAssets = data.assets.filter((asset) => asset.location?.id === locationId);
  const clearQuote = () => { setSlots([]); setQuoteId(""); };
  const changeLocation = (nextLocationId: string) => { setLocationId(nextLocationId); setAssetId(""); clearQuote(); };

  async function findAvailability() {
    if (!locationId || !assetId || !localDate) return;
    setBusy(true); setMessage(null); clearQuote();
    try {
      setSlots(await createHmsClient().listInspectionAvailability({ customerId: customer.id, locationId, localDate }));
    } catch (requestError) { setMessage(errorMessage(requestError)); } finally { setBusy(false); }
  }

  async function submitBooking() {
    if (!quoteId || !locationId || !assetId) return;
    setBusy(true); setMessage(null);
    try {
      if (rescheduleBookingId) {
        await createHmsClient().requestInspectionBookingReschedule(rescheduleBookingId, { availabilityQuoteId: quoteId, reason: additionalInformation.trim() || null, inspectorUserId: null });
        setMessage("Your reschedule request was sent for review.");
      } else {
        await createHmsClient().createInspectionBooking({ customerId: customer.id, locationId, assetIds: [assetId], availabilityQuoteId: quoteId, additionalInformation: additionalInformation.trim() || null });
        setMessage("Your inspection request was submitted for approval.");
      }
      setAssetId(""); setLocalDate(""); setAdditionalInformation(""); setRescheduleBookingId(null); clearQuote(); await onChanged();
    } catch (requestError) { setMessage(errorMessage(requestError)); } finally { setBusy(false); }
  }

  async function cancelBooking(booking: InspectionBookingRecord) {
    setBusy(true); setMessage(null);
    try { await createHmsClient().cancelInspectionBooking(booking.id, "Cancelled by customer"); setMessage("The booking was cancelled and the slot was released."); await onChanged(); }
    catch (requestError) { setMessage(errorMessage(requestError)); } finally { setBusy(false); }
  }

  return <>
    <section className="portal-panel"><h2>{rescheduleBookingId ? "Request a new appointment time" : "Request an inspection"}</h2><p>Select a location first. Changing organisation, location, asset, or date clears any previous availability quote.</p>
      <div className="portal-form-grid">
        <label>Location<select aria-label="Booking location" value={locationId} onChange={(event) => changeLocation(event.target.value)}><option value="">Select a location</option>{customer.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label>
        <label>Asset<select aria-label="Booking asset" disabled={!locationId} value={assetId} onChange={(event) => { setAssetId(event.target.value); clearQuote(); }}><option value="">Select an asset</option>{locationAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.assetNumber}</option>)}</select></label>
        <label>Preferred date<input aria-label="Preferred date" type="date" value={localDate} onChange={(event) => { setLocalDate(event.target.value); clearQuote(); }} /></label>
        <label>Notes<textarea value={additionalInformation} onChange={(event) => setAdditionalInformation(event.target.value)} /></label>
      </div>
      <button disabled={busy || !locationId || !assetId || !localDate} type="button" onClick={() => void findAvailability()}>Find availability</button>
      {slots.length > 0 ? <fieldset><legend>Select a time</legend>{slots.map((slot) => <label className="portal-slot" key={slot.quoteId}><input checked={quoteId === slot.quoteId} name="slot" type="radio" value={slot.quoteId} onChange={() => setQuoteId(slot.quoteId)} />{formatDateTime(slot.startsAt)} to {formatDateTime(slot.endsAt)}</label>)}</fieldset> : null}
      <button disabled={busy || !quoteId} type="button" onClick={() => void submitBooking()}>{rescheduleBookingId ? "Request reschedule" : "Submit booking request"}</button>
      {rescheduleBookingId ? <button disabled={busy} type="button" onClick={() => { setRescheduleBookingId(null); setLocationId(""); setAssetId(""); setLocalDate(""); clearQuote(); }}>Cancel reschedule</button> : null}
      {message ? <p role="status">{message}</p> : null}
    </section>
    <section className="portal-panel"><h2>Bookings</h2>{data.bookings.length === 0 ? <p>No booking requests for this organisation.</p> : <ul className="portal-list">{data.bookings.map((booking) => <li key={booking.id}><strong>{booking.location.name} · {booking.status}</strong><span>{formatDateTime(booking.scheduledAt)} · {booking.assets.map((asset) => asset.assetNumber).join(", ")}</span>{booking.rejectionReason ? <span>Reason: {booking.rejectionReason}</span> : null}{booking.status === "PENDING_APPROVAL" || booking.status === "APPROVED" ? <span className="portal-actions"><button disabled={busy} type="button" onClick={() => { setRescheduleBookingId(booking.id); changeLocation(booking.location.id); setAssetId(booking.assets[0]?.id ?? ""); setLocalDate(""); }}>Request reschedule</button><button disabled={busy} type="button" onClick={() => void cancelBooking(booking)}>Cancel booking</button></span> : null}{booking.changeRequests.some((request) => request.status === "PENDING_CUSTOMER_CONFIRMATION") ? <button disabled={busy} type="button" onClick={async () => { const request = booking.changeRequests.find((item) => item.status === "PENDING_CUSTOMER_CONFIRMATION"); if (!request) return; setBusy(true); try { await createHmsClient().confirmInspectionBookingReschedule(request.id); await onChanged(); } catch (requestError) { setMessage(errorMessage(requestError)); } finally { setBusy(false); } }}>Confirm proposed reschedule</button> : null}</li>)}</ul>}</section>
  </>;
}
