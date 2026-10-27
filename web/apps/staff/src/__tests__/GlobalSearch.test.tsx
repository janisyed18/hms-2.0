import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AppShell, type GlobalSearchSuggestion } from "../components/AppShell";
import type { StaffSession } from "../domain/types";

const listCustomers = vi.hoisted(() => vi.fn());
const listAssets = vi.hoisted(() => vi.fn());
const listProducts = vi.hoisted(() => vi.fn());
const listInspections = vi.hoisted(() => vi.fn());
const listNotifications = vi.hoisted(() => vi.fn());

vi.mock("../api/hmsClient", () => ({
  createHmsClient: () => ({
    listAssets,
    listCustomers,
    listInspections,
    listNotifications,
    listProducts
  })
}));

const session: StaffSession = {
  userId: "admin-1",
  displayName: "HMS Admin",
  email: "admin@example.test",
  roles: ["HMS_ADMIN"],
  permissions: ["asset:write"],
  customerIds: [],
  authMode: "bearer"
};

function renderSearch(
  onSearchRecordOpen = vi.fn(),
  notificationCustomerId?: string | null
) {
  return {
    onSearchRecordOpen,
    ...render(
      <AppShell
        activeModule="dashboard"
        canCreateAsset
        description="Operational snapshot"
        notificationCustomerId={notificationCustomerId}
        onModuleChange={vi.fn()}
        onSearchRecordOpen={onSearchRecordOpen}
        session={session}
        title="Dashboard"
        visibleModules={["dashboard", "customers", "assets", "products", "inspections"]}
      >
        <main>Dashboard content</main>
      </AppShell>
    )
  };
}

describe("global search", () => {
  it("loads the active customer bell preview with the server unread total", async () => {
    listNotifications.mockResolvedValue({
      items: [{
        id: "notification-a-newest",
        category: "CERTIFICATE_ISSUED",
        subject: "Customer A update",
        body: "The newest visible Customer A update.",
        customerId: "customer-a",
        assetId: null,
        createdAt: "2027-10-04T00:00:00Z",
        readAt: null
      }],
      unreadTotal: 5
    });

    renderSearch(vi.fn(), "customer-a");

    const notificationButton = await screen.findByRole("button", {
      name: "Notifications"
    });
    await waitFor(() =>
      expect(listNotifications).toHaveBeenCalledWith({
        customerId: "customer-a",
        limit: 12
      })
    );
    expect(notificationButton).toHaveTextContent("5");
  });

  it("shows real prefix matches and opens the selected record", async () => {
    listNotifications.mockResolvedValue({ items: [], unreadTotal: 0 });
    listCustomers.mockResolvedValue({
      total: 1,
      items: [{ id: "customer-1", name: "Customer One", code: "CUST-001" }]
    });
    listAssets.mockResolvedValue({ total: 0, items: [] });
    listProducts.mockResolvedValue({
      total: 1,
      items: [{ id: "product-1", name: "Customer Hose", code: "CUST-HOSE", category: "Composite" }]
    });
    listInspections.mockResolvedValue({ total: 0, items: [] });
    const user = userEvent.setup();
    const { onSearchRecordOpen } = renderSearch();

    await waitFor(() => expect(listNotifications).toHaveBeenCalledWith({ limit: 12 }));

    const input = screen.getByRole("combobox", { name: "Global search" });
    await user.type(input, "cust");

    expect(await screen.findByRole("option", { name: /Customer One/i })).toBeVisible();
    expect(screen.getByRole("option", { name: /Customer Hose/i })).toBeVisible();
    expect(listCustomers).toHaveBeenCalledWith(
      expect.objectContaining({ search: "cust" })
    );
    expect(listProducts).toHaveBeenCalledWith(
      expect.objectContaining({ search: "cust" })
    );

    await user.click(screen.getByRole("option", { name: /Customer One/i }));
    expect(onSearchRecordOpen).toHaveBeenCalledWith(
      expect.objectContaining<Partial<GlobalSearchSuggestion>>({
        id: "customer-1",
        kind: "customer",
        module: "customers"
      })
    );
  });
});
