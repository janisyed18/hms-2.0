import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CustomerDetail } from "../components/CustomerDetail";
import { FINAL_LOCATION_MESSAGE } from "../components/CustomerLocationsTab";
import { HmsApiError } from "../api/hmsClient";
import type { CustomerLocation, CustomerRecord } from "../domain/types";

const client = vi.hoisted(() => ({
  listAssets: vi.fn(),
  getCustomer: vi.fn(),
  deleteCustomerLocation: vi.fn(),
  deleteCustomerContact: vi.fn(),
  createCustomerContact: vi.fn(),
  updateCustomerContact: vi.fn(),
  createCustomerLocation: vi.fn(),
  updateCustomerLocation: vi.fn()
}));

vi.mock("../api/hmsClient", async (original) => ({
  ...(await original<typeof import("../api/hmsClient")>()),
  createHmsClient: () => client
}));

function location(id: string, name: string): CustomerLocation {
  return {
    id, name, address1: "1 Wharf Rd", address2: null, city: "Newcastle", state: "NSW", country: "Australia",
    siteContactName: "Alex", siteContactMobile: "0400", siteContactEmail: "alex@example.test",
    ppeRequirements: [], additionalRequirements: [], schedulingTimezone: "Australia/Sydney",
    schedulingOpenTime: "07:00", schedulingCloseTime: "15:00", schedulingWeekdays: [0, 1, 2, 3, 4], schedulingBlackoutDates: []
  };
}

function customerWith(locations: CustomerLocation[], overrides: Partial<CustomerRecord> = {}): CustomerRecord {
  return {
    id: "c1", code: "C1", name: "Harbour", notes: null, retestEnabled: true, defaultRetestMonths: 12,
    locations, contacts: [{ id: "k1", name: "Sam Reyes", email: "sam@example.test", phone: null, role: "Planner", receivesRetestReminders: true }],
    status: "Active", archivedAt: null,
    metrics: { assetCount: 0, inServiceCount: 0, inspectionDueCount: 0, inspectionDueLabel: "", certificateValidPercent: 0, certificateStatusLabel: "", recentInspections: [], activity: [] },
    ...overrides
  };
}

function renderDetail(customer: CustomerRecord, props: { tab?: string; canDelete?: boolean; canWrite?: boolean; onCustomerChange?: (c: CustomerRecord) => void; onLifecycle?: () => void } = {}) {
  return render(
    <CustomerDetail
      activeTab={props.tab ?? "Locations"}
      canDelete={props.canDelete ?? false}
      canWrite={props.canWrite ?? true}
      customer={customer}
      onLocationAssetsOpen={vi.fn()}
      onClose={vi.fn()}
      onCustomerChange={props.onCustomerChange}
      onEdit={vi.fn()}
      onLifecycle={props.onLifecycle}
      onTabChange={vi.fn()}
    />
  );
}

describe("Customer Locations tab", () => {
  beforeEach(() => {
    Object.values(client).forEach((fn) => fn.mockReset());
    client.listAssets.mockResolvedValue({ total: 0, items: [] });
  });

  it("lists every location and shows its scheduling instead of hiding it", async () => {
    const user = userEvent.setup();
    renderDetail(customerWith([location("l2", "Kooragang workshop"), location("l1", "Newcastle yard")]));

    expect(screen.getByRole("heading", { level: 4, name: "Kooragang workshop" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 4, name: "Newcastle yard" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "View Newcastle yard" }));
    expect(screen.getByText(/Australia\/Sydney/)).toBeVisible();
  });

  it("never offers Delete to anyone but a Super Admin", () => {
    renderDetail(customerWith([location("l1", "A"), location("l2", "B")]), { canDelete: false });
    expect(screen.queryByRole("button", { name: /^Delete / })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit A" })).toBeVisible();
  });

  it("blocks deleting the final location, even for a Super Admin, with the exact message", () => {
    renderDetail(customerWith([location("l1", "Only site")]), { canDelete: true });
    expect(screen.getByRole("button", { name: "Delete Only site" })).toBeDisabled();
    expect(screen.getByText(FINAL_LOCATION_MESSAGE)).toBeVisible();
    expect(FINAL_LOCATION_MESSAGE).toBe("A customer must have at least one location. Add another location before deleting this one.");
  });

  it("lets a Super Admin delete one of several locations after confirming, then reloads the customer", async () => {
    const user = userEvent.setup();
    const onCustomerChange = vi.fn();
    const remaining = customerWith([location("l1", "Newcastle yard")]);
    client.deleteCustomerLocation.mockResolvedValue(undefined);
    client.getCustomer.mockResolvedValue(remaining);
    renderDetail(customerWith([location("l1", "Newcastle yard"), location("l2", "Old depot")]), { canDelete: true, onCustomerChange });

    await user.click(screen.getByRole("button", { name: "Delete Old depot" }));
    expect(client.deleteCustomerLocation).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete location" }));

    await waitFor(() => expect(client.deleteCustomerLocation).toHaveBeenCalledWith("c1", "l2"));
    expect(onCustomerChange).toHaveBeenCalledWith(remaining);
  });

  it("keeps the location and explains why when the server refuses the delete", async () => {
    const user = userEvent.setup();
    client.deleteCustomerLocation.mockRejectedValue(new HmsApiError(409, "conflict", "This location is still used by 2 tables.", null));
    renderDetail(customerWith([location("l1", "A"), location("l2", "B")]), { canDelete: true });

    await user.click(screen.getByRole("button", { name: "Delete B" }));
    await user.click(screen.getByRole("button", { name: "Delete location" }));

    expect(await screen.findByText(/still used by 2 tables/)).toBeVisible();
    expect(screen.getByRole("heading", { level: 4, name: "B" })).toBeVisible();
  });

  it("opens an add-location drawer with a blank timezone and visible hours", async () => {
    const user = userEvent.setup();
    renderDetail(customerWith([location("l1", "A")]));
    await user.click(screen.getByRole("button", { name: /Add location/ }));
    expect(await screen.findByRole("heading", { name: "Add location" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Timezone" })).toHaveValue("");
    expect(screen.getByLabelText("Opening time")).toHaveValue("08:00");
  });
});

describe("Customer Contacts tab", () => {
  beforeEach(() => {
    Object.values(client).forEach((fn) => fn.mockReset());
    client.listAssets.mockResolvedValue({ total: 0, items: [] });
  });

  it("lists contacts with the retest reminder preference", () => {
    renderDetail(customerWith([location("l1", "A")]), { tab: "Contacts" });
    expect(screen.getByRole("heading", { level: 4, name: "Sam Reyes" })).toBeVisible();
    expect(screen.getByText("Receives retest reminders")).toBeVisible();
  });

  it("offers Delete only to a Super Admin and deletes after confirming", async () => {
    const user = userEvent.setup();
    client.deleteCustomerContact.mockResolvedValue(undefined);
    client.getCustomer.mockResolvedValue(customerWith([location("l1", "A")], { contacts: [] }));
    const { unmount } = renderDetail(customerWith([location("l1", "A")]), { tab: "Contacts", canDelete: false });
    expect(screen.queryByRole("button", { name: "Delete Sam Reyes" })).not.toBeInTheDocument();
    unmount();

    renderDetail(customerWith([location("l1", "A")]), { tab: "Contacts", canDelete: true });
    await user.click(screen.getByRole("button", { name: "Delete Sam Reyes" }));
    await user.click(screen.getByRole("button", { name: "Delete contact" }));
    await waitFor(() => expect(client.deleteCustomerContact).toHaveBeenCalledWith("c1", "k1"));
  });
});

describe("Customer lifecycle actions", () => {
  beforeEach(() => {
    Object.values(client).forEach((fn) => fn.mockReset());
    client.listAssets.mockResolvedValue({ total: 0, items: [] });
  });

  it("hides Archive, Restore and Delete from everyone but a Super Admin", () => {
    renderDetail(customerWith([location("l1", "A")]), { tab: "Overview", canDelete: false, onLifecycle: vi.fn() });
    expect(screen.queryByRole("button", { name: /Archive customer|Restore customer|Delete customer/ })).not.toBeInTheDocument();
  });

  it("offers Delete on an active customer without archiving first, next to Archive", async () => {
    const user = userEvent.setup();
    const onLifecycle = vi.fn();
    renderDetail(customerWith([location("l1", "A")]), { tab: "Overview", canDelete: true, onLifecycle });
    expect(screen.getByRole("button", { name: "Delete customer" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Archive customer" }));
    expect(onLifecycle).toHaveBeenLastCalledWith("archive", expect.objectContaining({ id: "c1" }));
    await user.click(screen.getByRole("button", { name: "Delete customer" }));
    expect(onLifecycle).toHaveBeenLastCalledWith("delete", expect.objectContaining({ id: "c1" }));
  });

  it("offers Restore and Delete on an archived customer, as separate actions", async () => {
    const user = userEvent.setup();
    const onLifecycle = vi.fn();
    renderDetail(customerWith([location("l1", "A")], { status: "Archived", archivedAt: "2026-11-02T00:00:00Z" }), { tab: "Overview", canDelete: true, onLifecycle });
    expect(screen.queryByRole("button", { name: "Archive customer" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Restore customer" }));
    expect(onLifecycle).toHaveBeenLastCalledWith("restore", expect.anything());
    await user.click(screen.getByRole("button", { name: "Delete customer" }));
    expect(onLifecycle).toHaveBeenLastCalledWith("delete", expect.anything());
  });

  it("explains archive versus delete, for an active and an archived customer", () => {
    const { unmount } = renderDetail(customerWith([location("l1", "A")]), { tab: "Overview", canDelete: true, onLifecycle: vi.fn() });
    expect(screen.getByRole("heading", { name: "Customer lifecycle" })).toBeVisible();
    expect(screen.getByText(/Archive hides this customer from active work and keeps history/)).toBeVisible();
    unmount();

    renderDetail(customerWith([location("l1", "A")], { status: "Archived", archivedAt: "2026-11-02T00:00:00Z" }), { tab: "Overview", canDelete: true, onLifecycle: vi.fn() });
    expect(screen.getByRole("button", { name: "Restore customer" })).toBeVisible();
  });
});
