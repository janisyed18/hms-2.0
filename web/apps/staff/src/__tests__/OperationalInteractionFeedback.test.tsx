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
import { choose } from "../test/choose";

const client = vi.hoisted(() => ({
  listReferenceCatalog: vi.fn(),
  createReferenceCatalogItem: vi.fn(),
  updateReferenceCatalogItem: vi.fn(),
  deleteReferenceCatalogItem: vi.fn(),
  setReferenceCatalogEnabled: vi.fn(),
  listCertificates: vi.fn(),
  listInspections: vi.fn(),
  listAllAssets: vi.fn(),
  listInspectionBookings: vi.fn(),
  listAdminUsers: vi.fn(),
  issueCertificate: vi.fn(),
  revokeCertificate: vi.fn(),
  supersedeCertificate: vi.fn(),
  approveInspectionBooking: vi.fn(),
  reassignInspectionBookingInspector: vi.fn(),
  getInspectorAvailability: vi.fn(),
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
  client.listReferenceCatalog.mockResolvedValue({ total: 1, etag: null, items: [{ id: "std-1", code: "EN853", name: "Hydraulic Standard", enabled: true, etag: "s1" } as ReferenceCatalogRecord] });
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

  it("deletes only after confirmation and leaves the record listed when it fails", async () => {
    client.deleteReferenceCatalogItem.mockRejectedValueOnce(api(500, "psycopg.errors.ForeignKeyViolation"));
    const user = userEvent.setup();
    render(<ReferenceWorkspace canDelete canManage />);
    await screen.findByText("Hydraulic Standard");
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete Hydraulic Standard — EN853?" });
    expect(client.deleteReferenceCatalogItem).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Delete standard" }));
    const failure = await within(await screen.findByRole("alertdialog")).findByRole("alert");
    expect(failure).toHaveTextContent(/service is unavailable/i);
    expect(failure.textContent).not.toMatch(/psycopg|ForeignKey/);
    expect(screen.getByText("Hydraulic Standard")).toBeInTheDocument();

    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete standard" }));
    expect(await screen.findByText("Hydraulic Standard — EN853 was deleted.")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("offers Disable to anyone who manages reference data and Delete only to a Super Admin", async () => {
    render(<ReferenceWorkspace canManage />);
    await screen.findByText("Hydraulic Standard");
    expect(screen.getByRole("button", { name: "Disable" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
  });

  it("disables and re-enables an item without deleting it", async () => {
    client.setReferenceCatalogEnabled.mockResolvedValueOnce({ id: "std-1", code: "EN853", name: "Hydraulic Standard", enabled: false, etag: "s2" });
    const user = userEvent.setup();
    render(<ReferenceWorkspace canManage />);
    await screen.findByText("Hydraulic Standard");
    await user.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(client.setReferenceCatalogEnabled).toHaveBeenCalledWith("standards", "std-1", false, "s1"));
    expect(await screen.findByRole("button", { name: "Enable" })).toBeVisible();
    expect(client.deleteReferenceCatalogItem).not.toHaveBeenCalled();
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
    // Nothing is chosen for the person: the inspection is picked, then the number follows.
    expect(screen.getByLabelText("Approved inspection")).toHaveValue("");
    await choose(user, screen.getByLabelText("Approved inspection"), "insp-2");
    expect(screen.getByLabelText("Approved inspection")).toHaveValue("Main Pump Hose — HMS-001842");

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
    render(<CertificateForm onClose={vi.fn()} onSubmit={onSubmit} open />);
    await choose(user, screen.getByLabelText("Approved inspection"), "insp-2");
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
    render(<InspectionDetail canApprove canWrite={false} inspection={inspectionDraft} onApprove={onApprove} onBeginRework={vi.fn()} onClose={vi.fn()} onRefresh={onRefresh} onReject={vi.fn()} onSaveDraft={vi.fn()} onStart={vi.fn()} onSubmit={vi.fn()} />);
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

    await choose(user, screen.getByLabelText("Assign inspector for Kooragang"), "ins-1");
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
    await user.click(screen.getByText("Actions"));
    await user.click(screen.getByRole("button", { name: "Reject request" }));
    const dialog = screen.getByRole("alertdialog", { name: "Decline the booking at Kooragang?" });
    expect(client.rejectInspectionBooking).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Decline booking" }));
    expect(await within(await screen.findByRole("alertdialog")).findByRole("alert")).toHaveTextContent(/service is unavailable/i);
    expect(screen.getByText("Kooragang")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Assign & approve" })).toBeInTheDocument();
  });

  it("puts Book inspection in the page header, only for someone who can book", async () => {
    client.listInspectionBookings.mockResolvedValue({ total: 1, etag: null, items: [booking] });
    client.listInspections.mockResolvedValue({ total: 0, etag: null, items: [] });
    const { unmount } = render(<InspectionsWorkspace canApprove canApproveBookings canBook canWrite />);
    await screen.findByText("Kooragang");
    const header = screen.getByRole("heading", { name: "Inspection operations" }).closest("header") as HTMLElement;
    expect(within(header).getByRole("button", { name: "Book inspection" })).toBeVisible();
    unmount();
    render(<InspectionsWorkspace canApprove canApproveBookings={false} canBook={false} canWrite={false} />);
    await screen.findByText("Kooragang");
    expect(screen.queryByRole("button", { name: "Book inspection" })).not.toBeInTheDocument();
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
    await choose(user, screen.getByLabelText("Assign inspector for Kooragang"), "ins-1");
    await user.click(screen.getByRole("button", { name: "Assign & approve" }));

    const notice = (await screen.findByText(/approved and an inspector assigned, but the latest view could not be refreshed/)).closest('[role="status"]');
    expect(notice).toHaveTextContent("Booking approved");
    expect(notice).toHaveTextContent("Reload to see the current state.");
    expect(screen.queryByText(/could not be approved/i)).toBeNull();
    expect(client.approveInspectionBooking).toHaveBeenCalledTimes(1);
    // The booking returned by the approval is already applied, so the card no longer offers approval.
    expect(screen.queryByRole("button", { name: "Assign & approve" })).toBeNull();
    expect(within(screen.getByText("Kooragang").closest("article") as HTMLElement).getByText("Approved")).toBeInTheDocument();
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
    await user.click(screen.getByText("Actions"));
    await user.click(screen.getByRole("button", { name: "Reject request" }));
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
    await user.click(screen.getByText("Actions"));
    await user.click(screen.getByRole("button", { name: "Reject request" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Decline booking" }));
    expect(await within(await screen.findByRole("alertdialog")).findByRole("alert")).toHaveTextContent("Only pending inspection bookings can be declined.");
  });
});

describe("Changing the inspector of a confirmed booking", () => {
  const confirmed = { ...booking, status: "APPROVED", inspectorUserId: "ins-1", appointment: { status: "CONFIRMED" } } as unknown as InspectionBookingRecord;
  const inspectors = [
    { id: "ins-1", displayName: "Ben Brook", role: "INSPECTOR", accountStatus: "ACTIVE" },
    { id: "ins-2", displayName: "Cara Cole", role: "INSPECTOR", accountStatus: "ACTIVE" }
  ];
  const assigned = () => document.querySelector(".assigned-inspector__name")?.textContent;
  const dialog = () => screen.getByRole("dialog", { name: "Change inspector" });
  const pickInspector = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
    await user.click(within(dialog()).getByRole("combobox", { name: /New inspector/ }));
    await user.click(within(dialog()).getByRole("option", { name: new RegExp(name) }));
  };
  const free = { eligible: true, blockedReason: null, available: true, reason: null, suggestedInspectorIds: [] };
  beforeEach(() => client.getInspectorAvailability.mockResolvedValue(free));
  const open = (user: ReturnType<typeof userEvent.setup>, site = "Kooragang") => user.click(screen.getByRole("button", { name: `Change inspector for ${site}` }));

  async function renderConfirmed(props: { canApproveBookings: boolean } = { canApproveBookings: true }, people = inspectors) {
    client.listInspectionBookings.mockResolvedValue({ total: 1, etag: null, items: [confirmed] });
    client.listAdminUsers.mockResolvedValue({ total: people.length, etag: null, items: people });
    const user = userEvent.setup();
    render(<InspectionsWorkspace canApprove={props.canApproveBookings} canApproveBookings={props.canApproveBookings} canBook canWrite />);
    await screen.findByText("Kooragang");
    return user;
  }

  it("shows the assigned inspector beside Change inspector, and saves only from the dialog", async () => {
    client.reassignInspectionBookingInspector.mockResolvedValue({ ...confirmed, inspectorUserId: "ins-2" });
    const user = await renderConfirmed();
    expect(screen.getByText("Inspector")).toBeInTheDocument();
    await waitFor(() => expect(assigned()).toBe("Ben Brook"));

    await open(user);
    const box = within(dialog());
    expect(box.getByText(/appointment date, time, location and assets stay the same/i)).toBeInTheDocument();
    expect(box.getByText("Ben Brook")).toBeInTheDocument();
    // The current inspector is not a replacement.
    await user.click(box.getByRole("combobox", { name: /New inspector/ }));
    expect(box.getAllByRole("option").map((option) => option.querySelector("span")?.textContent?.trim())).toEqual(["Cara Cole"]);
    expect(box.getAllByText("Current inspector")).toHaveLength(2);
    await user.keyboard("{Escape}");
    expect(dialog()).toBeInTheDocument();
    expect(client.reassignInspectionBookingInspector).not.toHaveBeenCalled();

    await pickInspector(user, "Cara Cole");
    await user.click(box.getByRole("button", { name: "Save change" }));
    expect(client.reassignInspectionBookingInspector).toHaveBeenCalledWith("bk-1", "ins-2");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Change inspector" })).not.toBeInTheDocument());
    expect(assigned()).toBe("Cara Cole");
  });

  it("cannot save until a replacement is chosen and verified, and Cancel changes nothing", async () => {
    const user = await renderConfirmed();
    await open(user);
    expect(within(dialog()).getByRole("button", { name: "Save change" })).toBeDisabled();
    await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(client.reassignInspectionBookingInspector).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Change inspector" })).not.toBeInTheDocument();
    expect(assigned()).toBe("Ben Brook");
  });

  it("checks the chosen inspector with the server and shows Available before Save is allowed", async () => {
    const user = await renderConfirmed();
    await open(user);
    await pickInspector(user, "Cara Cole");
    expect(client.getInspectorAvailability).toHaveBeenCalledWith("bk-1", "ins-2");
    expect(await within(dialog()).findByText("Available")).toBeInTheDocument();
    expect(within(dialog()).getByRole("button", { name: "Save change" })).toBeEnabled();
  });

  it("warns when the chosen inspector is already booked, offers verified alternatives, and blocks Save", async () => {
    client.getInspectorAvailability.mockImplementation(async (_booking: string, inspector: string) =>
      inspector === "ins-2" ? { ...free, available: false, reason: "inspector_busy", suggestedInspectorIds: ["ins-3"] } : free);
    const user = await renderConfirmed(undefined, [...inspectors, { id: "ins-3", displayName: "Dee Dunn", role: "INSPECTOR", accountStatus: "ACTIVE" }]);
    await open(user);
    await pickInspector(user, "Cara Cole");
    expect(await within(dialog()).findByText("This inspector is already scheduled during the selected time. Choose another inspector or reschedule the inspection.")).toBeInTheDocument();
    expect(within(dialog()).queryByText("Available", { selector: "p" })).not.toBeInTheDocument();
    expect(within(dialog()).getByRole("button", { name: "Save change" })).toBeDisabled();
    // Choosing a suggestion re-checks it and, once verified, allows Save.
    await user.click(within(dialog()).getByRole("button", { name: /Dee Dunn/ }));
    expect(client.getInspectorAvailability).toHaveBeenLastCalledWith("bk-1", "ins-3");
    expect(await within(dialog()).findByRole("button", { name: "Save change" })).toBeEnabled();
    expect(within(dialog()).getByRole("combobox", { name: /New inspector/ })).toHaveTextContent("Dee Dunn");
    expect(client.reassignInspectionBookingInspector).not.toHaveBeenCalled();
  });

  it("lists who is free or busy in the dropdown, never marking an unchecked inspector Available", async () => {
    client.getInspectorAvailability.mockImplementation((_b: string, inspector: string) =>
      inspector === "ins-3" ? Promise.reject(api(500, "boom")) : Promise.resolve(inspector === "ins-2" ? { ...free, available: false, reason: "inspector_busy" } : free));
    const user = await renderConfirmed(undefined, [...inspectors, { id: "ins-3", displayName: "Dee Dunn", role: "INSPECTOR", accountStatus: "ACTIVE" }]);
    await open(user);
    await user.click(within(dialog()).getByRole("combobox", { name: /New inspector/ }));
    const cara = within(dialog()).getByRole("option", { name: /Cara Cole/ });
    const dee = within(dialog()).getByRole("option", { name: /Dee Dunn/ });
    await waitFor(() => expect(cara).toHaveTextContent("Busy at this time"));
    expect(dee).not.toHaveTextContent("Available");
    // Typing filters the list.
    await user.type(within(dialog()).getByRole("textbox", { name: "Search inspectors" }), "dee");
    expect(within(dialog()).queryByRole("option", { name: /Cara Cole/ })).not.toBeInTheDocument();
  });

  it("checks an inspector beyond the up-front batch when it is chosen, before Save is allowed", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `x-${i + 1}`, displayName: `Person ${String(i + 1).padStart(2, "0")}`, role: "INSPECTOR", accountStatus: "ACTIVE" }));
    const user = await renderConfirmed(undefined, [inspectors[0], ...many]);
    await open(user);
    await waitFor(() => expect(client.getInspectorAvailability).toHaveBeenCalledTimes(12));
    expect(client.getInspectorAvailability).not.toHaveBeenCalledWith("bk-1", "x-18");
    await user.click(within(dialog()).getByRole("combobox", { name: /New inspector/ }));
    await user.click(within(dialog()).getByRole("option", { name: /Person 18/ }));
    expect(client.getInspectorAvailability).toHaveBeenCalledWith("bk-1", "x-18");
    expect(await within(dialog()).findByText("Available")).toBeInTheDocument();
  });

  it("an older answer for a previous choice never overrides the current one", async () => {
    const slow = deferred<unknown>();
    client.getInspectorAvailability.mockImplementation((_b: string, inspector: string) =>
      inspector === "ins-2" ? Promise.resolve(free) : slow.promise);
    const user = await renderConfirmed(undefined, [...inspectors, { id: "ins-3", displayName: "Dee Dunn", role: "INSPECTOR", accountStatus: "ACTIVE" }]);
    await open(user);
    await waitFor(() => expect(client.getInspectorAvailability).toHaveBeenCalledTimes(2));
    // Choose Dee (answer pending), then Cara (answers at once) and only then let Dee's late "busy" arrive.
    await pickInspector(user, "Dee Dunn");
    expect(within(dialog()).getByRole("button", { name: "Save change" })).toBeDisabled();
    await pickInspector(user, "Cara Cole");
    expect(await within(dialog()).findByText("Available")).toBeInTheDocument();
    slow.resolve({ ...free, available: false, reason: "inspector_busy" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(within(dialog()).queryByText(/already scheduled/)).not.toBeInTheDocument();
    expect(within(dialog()).getByRole("combobox", { name: /New inspector/ })).toHaveTextContent("Cara Cole");
    expect(within(dialog()).getByRole("button", { name: "Save change" })).toBeEnabled();
  });

  it("works from the keyboard: open, search, arrow, Enter, and Escape closes only the list", async () => {
    const user = await renderConfirmed();
    await open(user);
    const combo = within(dialog()).getByRole("combobox", { name: /New inspector/ });
    expect(combo).toHaveFocus();
    expect(combo).toHaveAttribute("aria-expanded", "false");
    await user.keyboard("{ArrowDown}");
    expect(combo).toHaveAttribute("aria-expanded", "true");
    const box = within(dialog()).getByRole("textbox", { name: "Search inspectors" });
    await waitFor(() => expect(box).toHaveFocus());
    // Escape closes the list, returns focus to the field, and leaves the dialog open.
    await user.keyboard("{Escape}");
    expect(combo).toHaveAttribute("aria-expanded", "false");
    expect(combo).toHaveFocus();
    expect(dialog()).toBeInTheDocument();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("cara");
    expect(box).toHaveAttribute("aria-activedescendant", expect.stringContaining("ins-2"));
    await user.keyboard("{Enter}");
    expect(combo).toHaveTextContent("Cara Cole");
    expect(combo).toHaveFocus();
    expect(await within(dialog()).findByText("Available")).toBeInTheDocument();
  });

  it("never shows Available or allows Save when the check cannot be completed, and can check again", async () => {
    client.getInspectorAvailability.mockRejectedValue(api(500, "boom"));
    const user = await renderConfirmed();
    await open(user);
    await pickInspector(user, "Cara Cole");
    expect(await within(dialog()).findByText(/could not check this inspector's availability/)).toBeInTheDocument();
    expect(within(dialog()).queryByText("Available")).not.toBeInTheDocument();
    expect(within(dialog()).getByRole("button", { name: "Save change" })).toBeDisabled();
    client.getInspectorAvailability.mockResolvedValue(free);
    await user.click(within(dialog()).getByRole("button", { name: "Check again" }));
    expect(await within(dialog()).findByText("Available")).toBeInTheDocument();
    expect(within(dialog()).getByRole("button", { name: "Save change" })).toBeEnabled();
  });

  it("re-checks on Save and does not change anything if the inspector was booked meanwhile", async () => {
    const user = await renderConfirmed();
    await open(user);
    await pickInspector(user, "Cara Cole");
    await within(dialog()).findByText("Available");
    client.getInspectorAvailability.mockResolvedValueOnce({ ...free, available: false, reason: "inspector_busy" });
    await user.click(within(dialog()).getByRole("button", { name: "Save change" }));
    expect(await within(dialog()).findByText(/already scheduled during the selected time/)).toBeInTheDocument();
    expect(client.reassignInspectionBookingInspector).not.toHaveBeenCalled();
    expect(within(dialog()).getByRole("combobox", { name: /New inspector/ })).toHaveTextContent("Cara Cole");
    expect(assigned()).toBe("Ben Brook");
  });

  it.each([
    [409, "That inspector already has an appointment at this time."],
    [403, "You do not have permission to do this."],
    [409, "Inspector cannot be changed after inspection work has been submitted or approved."]
  ])("a %i refusal (%s) keeps the dialog open with the replacement still chosen", async (status, message) => {
    client.reassignInspectionBookingInspector.mockRejectedValueOnce(api(status, message));
    const user = await renderConfirmed();
    await open(user);
    await pickInspector(user, "Cara Cole");
    await user.click(within(dialog()).getByRole("button", { name: "Save change" }));
    expect(await within(dialog()).findByText(message)).toBeInTheDocument();
    expect(within(dialog()).getByRole("combobox", { name: /New inspector/ })).toHaveTextContent("Cara Cole");
    expect(assigned()).toBe("Ben Brook");
  });

  it("can retry after a refusal without choosing again", async () => {
    client.reassignInspectionBookingInspector
      .mockRejectedValueOnce(api(409, "That inspector already has an appointment at this time."))
      .mockResolvedValueOnce({ ...confirmed, inspectorUserId: "ins-2" });
    const user = await renderConfirmed();
    await open(user);
    await pickInspector(user, "Cara Cole");
    await user.click(within(dialog()).getByRole("button", { name: "Save change" }));
    await within(dialog()).findByText("That inspector already has an appointment at this time.");
    await user.click(within(dialog()).getByRole("button", { name: "Save change" }));
    expect(client.reassignInspectionBookingInspector).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(assigned()).toBe("Cara Cole"));
  });

  it.each([
    ["a booking still awaiting approval", { status: "PENDING_APPROVAL", appointment: null }],
    ["a cancelled booking", { status: "CANCELLED", appointment: { status: "CANCELLED" } }]
  ])("is not offered for %s", async (_label, overrides) => {
    client.listInspectionBookings.mockResolvedValue({ total: 1, etag: null, items: [{ ...confirmed, ...overrides } as unknown as InspectionBookingRecord] });
    client.listAdminUsers.mockResolvedValue({ total: 2, etag: null, items: inspectors });
    render(<InspectionsWorkspace canApprove canApproveBookings canBook canWrite />);
    await screen.findByText("Kooragang");
    expect(screen.queryByRole("button", { name: /Change inspector/ })).not.toBeInTheDocument();
  });

  it("explains why it is unavailable while a reschedule is pending, instead of just hiding the button", async () => {
    const pending = { id: "chg-1", status: "PENDING_CUSTOMER_CONFIRMATION", startsAt: "2027-03-05T00:00:00Z", endsAt: "2027-03-05T01:00:00Z", reason: null, emergency: false, createdAt: "2027-02-01T00:00:00Z" };
    client.listInspectionBookings.mockResolvedValue({ total: 1, etag: null, items: [{ ...confirmed, changeRequests: [pending] } as unknown as InspectionBookingRecord] });
    client.listAdminUsers.mockResolvedValue({ total: 2, etag: null, items: inspectors });
    render(<InspectionsWorkspace canApprove canApproveBookings canBook canWrite />);
    await screen.findByText("Kooragang");
    expect(screen.getByText("Reassignment paused while reschedule is pending.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Change inspector/ })).not.toBeInTheDocument();
  });

  const site = (n: number, overrides: Record<string, unknown> = {}) => ({
    ...confirmed, id: `bk-${n}`, location: { ...(confirmed as unknown as { location: object }).location, id: `loc-${n}`, name: `Site ${n}` }, ...overrides
  }) as unknown as InspectionBookingRecord;

  it("reaches a confirmed booking beyond the first four, and can load bookings that were not fetched yet", async () => {
    client.listInspectionBookings.mockResolvedValueOnce({ total: 7, etag: null, items: [1, 2, 3, 4, 5].map((n) => site(n)) });
    client.listAdminUsers.mockResolvedValue({ total: 2, etag: null, items: inspectors });
    client.reassignInspectionBookingInspector.mockResolvedValue(site(5, { inspectorUserId: "ins-2" }));
    const user = userEvent.setup();
    render(<InspectionsWorkspace canApprove canApproveBookings canBook canWrite />);
    await screen.findByText("Site 1");
    expect(screen.queryByRole("button", { name: "Change inspector for Site 5" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show all 5 loaded bookings" }));
    expect(screen.getByText("Site 5")).toBeInTheDocument();
    await open(user, "Site 5");
    await pickInspector(user, "Cara Cole");
    await user.click(within(dialog()).getByRole("button", { name: "Save change" }));
    expect(client.reassignInspectionBookingInspector).toHaveBeenCalledWith("bk-5", "ins-2");

    // Two more exist on the server: they can be loaded without leaving the page.
    client.listInspectionBookings.mockResolvedValueOnce({ total: 7, etag: null, items: [site(6), site(7)] });
    await user.click(await screen.findByRole("button", { name: "Load more bookings" }));
    expect(client.listInspectionBookings).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 5 }));
    expect(await screen.findByText("Site 7")).toBeInTheDocument();
  });

  it("refreshes the inspections after the change, and keeps it with a warning if that refresh fails", async () => {
    client.reassignInspectionBookingInspector.mockResolvedValue({ ...confirmed, inspectorUserId: "ins-2" });
    const user = await renderConfirmed();
    await waitFor(() => expect(assigned()).toBe("Ben Brook"));
    const before = client.listInspections.mock.calls.length;
    client.listInspections.mockRejectedValueOnce(api(500, "Server error"));
    await open(user);
    await pickInspector(user, "Cara Cole");
    await user.click(within(dialog()).getByRole("button", { name: "Save change" }));

    await waitFor(() => expect(client.listInspections.mock.calls.length).toBeGreaterThan(before));
    await waitFor(() => expect(assigned()).toBe("Cara Cole"));
    expect(await screen.findByText(/could not be refreshed/)).toBeInTheDocument();
    expect(screen.queryByText("Inspector not changed")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Change inspector" })).not.toBeInTheDocument();
  });

  it("asks the server for active inspectors only, and reads every page of them", async () => {
    const many = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: `ins-${from + i}`, displayName: `Inspector ${from + i}`, role: "INSPECTOR", accountStatus: "ACTIVE" }));
    client.listInspectionBookings.mockResolvedValue({ total: 1, etag: null, items: [confirmed] });
    client.listAdminUsers
      .mockResolvedValueOnce({ total: 150, etag: null, nextAfter: null, items: many(1, 100) })
      .mockResolvedValueOnce({ total: 150, etag: null, nextAfter: null, items: many(101, 50) });
    const user = userEvent.setup();
    render(<InspectionsWorkspace canApprove canApproveBookings canBook canWrite />);
    await screen.findByText("Kooragang");
    await open(user);

    expect(client.listAdminUsers).toHaveBeenNthCalledWith(1, expect.objectContaining({ role: "INSPECTOR", accountStatus: "ACTIVE", offset: 0 }));
    expect(client.listAdminUsers).toHaveBeenNthCalledWith(2, expect.objectContaining({ role: "INSPECTOR", accountStatus: "ACTIVE", offset: 100 }));
    // 150 inspectors, minus the one currently assigned (ins-1).
    await user.click(within(dialog()).getByRole("combobox", { name: /New inspector/ }));
    expect(within(dialog()).getAllByRole("option")).toHaveLength(149);
  });

  it("is not offered to someone who cannot approve bookings", async () => {
    await renderConfirmed({ canApproveBookings: false });
    expect(screen.queryByRole("button", { name: /Change inspector/ })).not.toBeInTheDocument();
  });
});
