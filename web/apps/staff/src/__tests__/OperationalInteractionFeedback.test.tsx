import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HmsApiError } from "../api/hmsClient";
import { CertificateForm } from "../components/CertificateForm";
import { CertificatesWorkspace } from "../components/CertificatesWorkspace";
import { InspectionDetail } from "../components/InspectionDetail";
import { InspectionsWorkspace } from "../components/InspectionsWorkspace";
import { ReferenceWorkspace } from "../components/ReferenceWorkspace";
import { RetestScheduleDetail } from "../components/RetestScheduleDetail";
import type { CertificateRecord, InspectionBookingRecord, InspectionRecord, ReferenceCatalogRecord, RetestScheduleRecord } from "../domain/types";

const client = vi.hoisted(() => ({
  listReferenceCatalog: vi.fn(),
  createReferenceCatalogItem: vi.fn(),
  updateReferenceCatalogItem: vi.fn(),
  archiveReferenceCatalogItem: vi.fn(),
  listCertificates: vi.fn(),
  listInspections: vi.fn(),
  listAllAssets: vi.fn(),
  listInspectionBookings: vi.fn(),
  listAdminUsers: vi.fn(),
  issueCertificate: vi.fn(),
  revokeCertificate: vi.fn(),
  supersedeCertificate: vi.fn(),
  approveInspectionBooking: vi.fn(),
  rejectInspectionBooking: vi.fn(),
  cancelInspectionBooking: vi.fn(),
  getInspectionBooking: vi.fn(),
  confirmInspectionBookingReschedule: vi.fn()
}));

vi.mock("../api/hmsClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/hmsClient")>()),
  createHmsClient: () => client
}));

const api = (status: number, message: string, details: unknown = null) => new HmsApiError(status, "code", message, details);
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const assetSummary = { id: "asset-1", assetNumber: "HMS-001842", assetName: "Main Pump Hose", tag: null, lifecycleStatus: "IN_SERVICE" };
const customer = { id: "cust-1", code: "ORIC", name: "Orica" };
const product = { id: "prod-1", code: "PROD-014", name: "Hydraulic Hose", category: "Hose" };

const certificate = {
  id: "cert-1", number: "CERT-1", certificateVersion: 1, status: "ISSUED", inspectionId: "insp-1", assetId: "asset-1",
  issuedAt: "2027-03-01T00:00:00Z", validUntil: "2028-03-01", publicToken: "tok", verificationHash: "h", pdfObjectKey: "k",
  issuedByUserId: "u1", asset: assetSummary, customer, product, inspection: { inspectionType: "SERVICE", status: "APPROVED", result: "PASS", approvedAt: "2027-03-01T00:00:00Z" }, etag: "c1"
} as unknown as CertificateRecord;

const approvedInspection = {
  id: "insp-2", assetId: "asset-1", inspectionType: "SERVICE", status: "APPROVED", result: "PASS", asset: assetSummary, customer, product,
  inspectorUserId: "i1", reviewerUserId: null, submittedAt: null, approvedAt: null, pressureTest: null
} as unknown as InspectionRecord;

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  client.listReferenceCatalog.mockResolvedValue({ total: 1, etag: null, items: [{ id: "std-1", code: "EN853", name: "Hydraulic Standard", etag: "s1" } as ReferenceCatalogRecord] });
  client.listCertificates.mockResolvedValue({ total: 1, etag: null, items: [certificate] });
  client.listInspections.mockResolvedValue({ total: 1, etag: null, items: [approvedInspection] });
  client.listAllAssets.mockResolvedValue({ total: 0, items: [] });
  client.listInspectionBookings.mockResolvedValue({ total: 0, etag: null, items: [] });
  client.listAdminUsers.mockResolvedValue({ total: 0, etag: null, items: [] });
});

describe("Reference catalog", () => {
  async function openAdd() {
    const user = userEvent.setup();
    render(<ReferenceWorkspace canManage />);
    await screen.findByText("Hydraulic Standard");
    await user.click(screen.getByRole("button", { name: "Add Standard" }));
    return user;
  }

  it("marks code and name required, validates inline with focus, and keeps values when the server refuses", async () => {
    client.createReferenceCatalogItem.mockRejectedValueOnce(api(409, "A standard with this code already exists."));
    const user = await openAdd();
    expect(screen.getByLabelText("Standard code")).toBeRequired();
    expect(screen.getByLabelText("Standard name")).toHaveAttribute("aria-required", "true");
    expect(screen.getByText("Required fields", { exact: false })).toHaveTextContent("* Required fields");

    await user.type(screen.getByLabelText("Standard name"), "Fuel Standard");
    await user.click(screen.getByRole("button", { name: "Save standard" }));
    expect(screen.getByLabelText("Standard code")).toHaveFocus();
    expect(screen.getByLabelText("Standard code")).toHaveAccessibleDescription("Enter a standard code.");
    expect(client.createReferenceCatalogItem).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Standard code"), "en854");
    await user.click(screen.getByRole("button", { name: "Save standard" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A standard with this code already exists.");
    expect(screen.getByLabelText("Standard code")).toHaveValue("EN854");
    expect(screen.getByLabelText("Standard name")).toHaveValue("Fuel Standard");
  });

  it("reports success only after the server answers, naming the record by name and code", async () => {
    const save = deferred<ReferenceCatalogRecord>();
    client.createReferenceCatalogItem.mockReturnValue(save.promise);
    const user = await openAdd();
    await user.type(screen.getByLabelText("Standard code"), "EN854");
    await user.type(screen.getByLabelText("Standard name"), "Fuel Standard");
    await user.click(screen.getByRole("button", { name: "Save standard" }));
    expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.queryByText(/created successfully/)).toBeNull();
    await act(async () => save.resolve({ id: "std-2", code: "EN854", name: "Fuel Standard", etag: "s2" } as ReferenceCatalogRecord));
    expect(await screen.findByText("Fuel Standard — EN854 created successfully.")).toBeInTheDocument();
  });

  it("archives only after confirmation and leaves the record listed when it fails", async () => {
    client.archiveReferenceCatalogItem.mockRejectedValueOnce(api(500, "psycopg.errors.ForeignKeyViolation"));
    const user = userEvent.setup();
    render(<ReferenceWorkspace canManage />);
    await screen.findByText("Hydraulic Standard");
    await user.click(screen.getByRole("button", { name: "Archive" }));
    const dialog = screen.getByRole("alertdialog", { name: "Archive Hydraulic Standard — EN853?" });
    expect(client.archiveReferenceCatalogItem).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Archive standard" }));
    const failure = await within(await screen.findByRole("alertdialog")).findByRole("alert");
    expect(failure).toHaveTextContent(/service is unavailable/i);
    expect(failure.textContent).not.toMatch(/psycopg|ForeignKey/);
    expect(screen.getByText("Hydraulic Standard")).toBeInTheDocument();

    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Archive standard" }));
    expect(await screen.findByText("Hydraulic Standard — EN853 was archived.")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

const schedule = {
  id: "rs-1", assetId: "asset-1", customerId: "cust-1", dueAt: "2027-06-01", status: "DUE", reminderIntervalDays: 30,
  escalationIntervalDays: 7, lastRemindedAt: null, escalatedAt: null, asset: assetSummary, customer, product, etag: "r1"
} as unknown as RetestScheduleRecord;

describe("Retest schedule detail", () => {
  it("validates visibly, keeps typed values on a server failure, and blocks a double save", async () => {
    const attempt = deferred();
    const onSave = vi.fn().mockReturnValueOnce(attempt.promise);
    const user = userEvent.setup();
    render(<RetestScheduleDetail canWrite onClose={vi.fn()} onSave={onSave} schedule={schedule} />);
    expect(screen.getByRole("heading", { name: "Main Pump Hose — HMS-001842" })).toBeInTheDocument();
    for (const name of ["Retest due date", "Retest status", "Reminder interval days", "Escalation interval days"]) {
      expect(screen.getByLabelText(name)).toBeRequired();
    }

    await user.clear(screen.getByLabelText("Reminder interval days"));
    await user.click(screen.getByRole("button", { name: "Save schedule" }));
    expect(screen.getByLabelText("Reminder interval days")).toHaveFocus();
    expect(screen.getByLabelText("Reminder interval days")).toHaveAccessibleDescription("Enter a whole number of days, 1 or more.");
    expect(onSave).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Reminder interval days"), "14");
    await user.click(screen.getByRole("button", { name: "Save schedule" }));
    const busy = await screen.findByRole("button", { name: "Saving…" });
    await user.click(busy);
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => attempt.reject(api(412, "Resource version does not match")));
    expect(await screen.findByRole("alert")).toHaveTextContent(/changed by someone else.*refresh/i);
    expect(screen.getByLabelText("Reminder interval days")).toHaveValue(14);
  });
});

describe("Certificates", () => {
  it("keeps the issue drawer open with its choices when the certificate service fails, then issues on retry", async () => {
    client.issueCertificate.mockRejectedValueOnce(api(502, "Bad gateway: signing provider timed out"));
    client.issueCertificate.mockResolvedValueOnce({ ...certificate, id: "cert-2", number: "CERT-HMS-001842-1" });
    const user = userEvent.setup();
    render(<CertificatesWorkspace canManage />);
    await screen.findByText("CERT-1");
    await user.click(screen.getByRole("button", { name: /Issue Certificate|Add Certificate/ }));
    expect(screen.getByLabelText("Approved inspection")).toBeRequired();
    expect(screen.getByLabelText("Certificate number")).toBeRequired();
    expect(screen.getByLabelText("Approved inspection").textContent).toContain("Main Pump Hose — HMS-001842");

    await user.click(screen.getByRole("button", { name: "Issue certificate" }));
    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent("Certificate could not be issued");
    expect(failure).toHaveTextContent(/service is unavailable/i);
    expect(failure.textContent).not.toMatch(/signing provider|Bad gateway/);
    expect(screen.getByLabelText("Certificate number")).toHaveValue("CERT-HMS-001842-1");

    await user.click(screen.getByRole("button", { name: "Issue certificate" }));
    expect(await screen.findByText(/Certificate CERT-HMS-001842-1 for Main Pump Hose — HMS-001842 issued successfully\./)).toBeInTheDocument();
  });

  it("requires a certificate number inline before sending", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<CertificateForm inspectionOptions={[approvedInspection]} onClose={vi.fn()} onSubmit={onSubmit} open />);
    await user.clear(screen.getByLabelText("Certificate number"));
    await user.click(screen.getByRole("button", { name: "Issue certificate" }));
    expect(screen.getByLabelText("Certificate number")).toHaveFocus();
    expect(screen.getByLabelText("Certificate number")).toHaveAccessibleDescription("Enter a certificate number.");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("asks before revoking, shows a failure in the dialog, and only then changes the certificate", async () => {
    client.revokeCertificate.mockRejectedValueOnce(api(409, "Only issued certificates can be revoked."));
    client.revokeCertificate.mockResolvedValueOnce({ ...certificate, status: "REVOKED" });
    const user = userEvent.setup();
    render(<CertificatesWorkspace canManage />);
    await user.click(await screen.findByText("CERT-1"));
    await user.click(await screen.findByRole("button", { name: "Revoke certificate" }));
    const dialog = screen.getByRole("alertdialog", { name: "Revoke certificate CERT-1?" });
    expect(client.revokeCertificate).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Revoke certificate" }));
    const failure = await within(await screen.findByRole("alertdialog")).findByRole("alert");
    expect(failure).toHaveTextContent("Only issued certificates can be revoked.");
    expect(failure).not.toHaveTextContent(/someone else|refresh/i); // a business conflict, not a stale edit
    expect(screen.getAllByText("ISSUED").length).toBeGreaterThan(0);

    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Revoke certificate" }));
    expect(await screen.findByText(/Certificate CERT-1 for Main Pump Hose — HMS-001842 was revoked\./)).toBeInTheDocument();
  });
});

const inspectionDraft = {
  ...approvedInspection, status: "SUBMITTED", pressureTest: null
} as unknown as InspectionRecord;

describe("Inspection approval", () => {
  it("shows Approving…, a lifecycle conflict as the server states it, and asks the list to refresh", async () => {
    const approve = deferred();
    const onApprove = vi.fn().mockReturnValueOnce(approve.promise);
    const onRefresh = vi.fn();
    const user = userEvent.setup();
    render(<InspectionDetail canApprove canWrite={false} inspection={inspectionDraft} onApprove={onApprove} onClose={vi.fn()} onRefresh={onRefresh} onSaveDraft={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Inspection Main Pump Hose — HMS-001842" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve inspection" }));
    const busy = await screen.findByRole("button", { name: "Approving…" });
    expect(busy).toBeDisabled();
    await act(async () => approve.reject(api(409, "Only submitted inspections can be approved.")));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Only submitted inspections can be approved.");
    expect(alert).not.toHaveTextContent(/someone else/i);
    expect(onRefresh).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Approve inspection" })).toBeEnabled();
  });
});

const booking = {
  id: "bk-1", customer, location: { id: "loc-1", name: "Kooragang", schedulingTimezone: "Australia/Sydney" },
  assets: [assetSummary], scheduledAt: "2027-03-01T00:00:00Z", scheduledEndAt: "2027-03-01T01:00:00Z", additionalInformation: null,
  status: "PENDING_APPROVAL", requestedByUserId: "c1", inspectorUserId: null, reviewedByUserId: null, reviewedAt: null, rejectionReason: null,
  createdAt: "2027-02-01T00:00:00Z", appointment: null, changeRequests: []
} as unknown as InspectionBookingRecord;

describe("Inspection bookings", () => {
  async function renderBookings() {
    client.listInspectionBookings.mockResolvedValue({ total: 1, etag: null, items: [booking] });
    client.listAdminUsers.mockResolvedValue({ total: 1, etag: null, items: [{ id: "ins-1", displayName: "Ben Brook", role: "INSPECTOR", accountStatus: "ACTIVE" }] });
    const user = userEvent.setup();
    render(<InspectionsWorkspace canApprove canApproveBookings canBook canWrite />);
    await screen.findByText("Kooragang");
    return user;
  }

  it("says an inspector is needed instead of sending, then shows a business conflict without stale-edit wording", async () => {
    client.approveInspectionBooking.mockRejectedValueOnce(api(409, "Only pending inspection bookings can be approved."));
    client.listInspections.mockResolvedValue({ total: 0, etag: null, items: [] });
    const user = await renderBookings();
    await user.click(screen.getByRole("button", { name: "Assign & approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose an inspector to assign first.");
    expect(client.approveInspectionBooking).not.toHaveBeenCalled();

    await user.selectOptions(screen.getByLabelText("Assign inspector for Kooragang"), "ins-1");
    await user.click(screen.getByRole("button", { name: "Assign & approve" }));
    const alert = await screen.findByText("Only pending inspection bookings can be approved.");
    expect(alert.closest('[role="alert"]')).not.toBeNull();
    expect(alert.closest('[role="alert"]')).not.toHaveTextContent(/someone else/i);
    // The lists are reloaded so the screen shows what is true now.
    await waitFor(() => expect(client.listInspectionBookings.mock.calls.length).toBeGreaterThan(1));
  });

  it("declines only after confirmation and keeps the booking if declining fails", async () => {
    client.rejectInspectionBooking.mockRejectedValueOnce(api(500, "Internal server error"));
    const user = await renderBookings();
    await user.click(screen.getByRole("button", { name: "Decline" }));
    const dialog = screen.getByRole("alertdialog", { name: "Decline the booking at Kooragang?" });
    expect(client.rejectInspectionBooking).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Decline booking" }));
    expect(await within(await screen.findByRole("alertdialog")).findByRole("alert")).toHaveTextContent(/service is unavailable/i);
    expect(screen.getByText("Kooragang")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Assign & approve" })).toBeInTheDocument();
  });

  it("names the booked asset by name first, then HMS number", async () => {
    await renderBookings();
    const card = screen.getByText("Kooragang").closest("article") as HTMLElement;
    expect(within(card).getByText("Main Pump Hose — HMS-001842")).toBeInTheDocument();
  });
});

describe("A successful booking action is never reported as a failure because a later reload failed", () => {
  it("approve booking: the approval stands and is shown when the inspection list reload fails", async () => {
    const approved = { ...booking, status: "APPROVED", inspectorUserId: "ins-1" } as unknown as InspectionBookingRecord;
    client.approveInspectionBooking.mockResolvedValue(approved);
    client.listInspections.mockResolvedValueOnce({ total: 0, etag: null, items: [] }); // initial load
    client.listInspections.mockRejectedValueOnce(api(500, "Internal server error")); // the secondary reload
    client.listInspectionBookings.mockResolvedValue({ total: 1, etag: null, items: [booking] });
    client.listAdminUsers.mockResolvedValue({ total: 1, etag: null, items: [{ id: "ins-1", displayName: "Ben Brook", role: "INSPECTOR", accountStatus: "ACTIVE" }] });
    const user = userEvent.setup();
    render(<InspectionsWorkspace canApprove canApproveBookings canBook canWrite />);
    await screen.findByText("Kooragang");
    await user.selectOptions(screen.getByLabelText("Assign inspector for Kooragang"), "ins-1");
    await user.click(screen.getByRole("button", { name: "Assign & approve" }));

    const notice = (await screen.findByText(/approved and an inspector assigned, but the latest view could not be refreshed/)).closest('[role="status"]');
    expect(notice).toHaveTextContent("Booking approved");
    expect(notice).toHaveTextContent("Reload to see the current state.");
    expect(screen.queryByText(/could not be approved/i)).toBeNull();
    expect(client.approveInspectionBooking).toHaveBeenCalledTimes(1);
    // The booking returned by the approval is already applied, so the card no longer offers approval.
    expect(screen.queryByRole("button", { name: "Assign & approve" })).toBeNull();
    expect(within(screen.getByText("Kooragang").closest("article") as HTMLElement).getByText("APPROVED")).toBeInTheDocument();
  });

  it("confirm reschedule: the confirmation stands when the booking reload fails, and says the view is stale", async () => {
    const proposal = { ...booking, status: "APPROVED", appointment: { status: "CONFIRMED" }, changeRequests: [{ id: "chg-1", status: "PENDING_CUSTOMER_CONFIRMATION", startsAt: "2027-03-05T00:00:00Z", endsAt: "2027-03-05T01:00:00Z", reason: null, emergency: false, createdAt: "2027-02-01T00:00:00Z" }] } as unknown as InspectionBookingRecord;
    client.listInspectionBookings.mockResolvedValue({ total: 1, etag: null, items: [proposal] });
    client.confirmInspectionBookingReschedule.mockResolvedValue(undefined);
    client.getInspectionBooking.mockRejectedValue(api(503, "Service unavailable"));
    const user = userEvent.setup();
    render(<InspectionsWorkspace canApprove={false} canApproveBookings={false} canBook canWrite={false} />);
    await user.click(await screen.findByRole("button", { name: "Confirm reschedule" }));

    const notice = (await screen.findByText(/The new time is confirmed, but the latest view could not be refreshed/)).closest('[role="status"]');
    expect(notice).toHaveTextContent("Reschedule confirmed");
    expect(screen.queryByText(/could not be confirmed/i)).toBeNull();
    expect(client.confirmInspectionBookingReschedule).toHaveBeenCalledTimes(1);
  });

  it("decline 409: the business message stands as written, with no stale-edit wording, and the booking is reloaded afterwards", async () => {
    client.rejectInspectionBooking.mockRejectedValueOnce(api(409, "Only pending inspection bookings can be declined."));
    client.listInspectionBookings.mockResolvedValue({ total: 1, etag: null, items: [booking] });
    client.listAdminUsers.mockResolvedValue({ total: 1, etag: null, items: [{ id: "ins-1", displayName: "Ben Brook", role: "INSPECTOR", accountStatus: "ACTIVE" }] });
    const user = userEvent.setup();
    render(<InspectionsWorkspace canApprove canApproveBookings canBook canWrite />);
    await screen.findByText("Kooragang");
    const loads = client.listInspectionBookings.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Decline" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Decline booking" }));

    const alert = await within(await screen.findByRole("alertdialog")).findByRole("alert");
    expect(alert).toHaveTextContent("Only pending inspection bookings can be declined.");
    expect(alert).not.toHaveTextContent(/someone else|refresh/i);
    await waitFor(() => expect(client.listInspectionBookings.mock.calls.length).toBeGreaterThan(loads));
  });

  it("decline 409 whose follow-up reload also fails still shows the original, truthful action error", async () => {
    client.rejectInspectionBooking.mockRejectedValueOnce(api(409, "Only pending inspection bookings can be declined."));
    client.listInspectionBookings.mockResolvedValueOnce({ total: 1, etag: null, items: [booking] });
    client.listInspectionBookings.mockRejectedValue(api(503, "Service unavailable"));
    const user = userEvent.setup();
    render(<InspectionsWorkspace canApprove canApproveBookings canBook canWrite />);
    await screen.findByText("Kooragang");
    await user.click(screen.getByRole("button", { name: "Decline" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Decline booking" }));
    expect(await within(await screen.findByRole("alertdialog")).findByRole("alert")).toHaveTextContent("Only pending inspection bookings can be declined.");
  });
});
