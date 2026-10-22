import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CustomerPortalWorkspace } from "../components/CustomerPortalWorkspace";
import type { StaffSession } from "../domain/types";

const session: StaffSession = {
  userId: "customer-user",
  displayName: "Customer User",
  roles: ["CUSTOMER_USER"],
  permissions: ["customer:read", "asset:read", "inspection:book"],
  customerIds: ["customer-a", "customer-b"],
  authMode: "bearer"
};

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function customer(id: string, name: string) {
  return {
    id,
    code: id.toUpperCase(),
    name,
    notes: null,
    retest_enabled: true,
    default_retest_months: 12,
    locations: [{
      id: `location-${id}`,
      name: `${name} Site`,
      address_1: null,
      address_2: null,
      city: null,
      state: null,
      country: null,
      site_contact_name: null,
      site_contact_mobile: null,
      site_contact_email: null,
      ppe_requirements: [],
      additional_requirements: [],
      scheduling_timezone: "UTC",
      scheduling_open_time: "08:00",
      scheduling_close_time: "17:00",
      scheduling_weekdays: [0, 1, 2, 3, 4],
      scheduling_blackout_dates: []
    }],
    contacts: [],
    metrics: { asset_count: 1, in_service_count: 1 }
  };
}

function asset(customerId: string) {
  return {
    id: `asset-${customerId}`,
    asset_number: `ASSET-${customerId}`,
    customer_serial_no: null,
    purchase_order_number: null,
    tag: null,
    lifecycle_status: "IN_SERVICE",
    manufacture_date: null,
    installation_date: null,
    grave_date: null,
    next_retest_due_at: null,
    condemned_at: null,
    length_m: null,
    notes: null,
    description: null,
    customer: { id: customerId, code: customerId, name: customerId },
    product: { id: "product-1", code: "PRODUCT", name: "Product", category: "Hose" },
    location: { id: `location-${customerId}`, name: "Site", address_1: null, address_2: null, city: null, state: null, country: null, scheduling_timezone: "UTC" },
    retest_schedule: null,
    a_end: null,
    b_end: null,
    inspection_history: [],
    certificate_history: []
  };
}

function Harness() {
  const [customerId, setCustomerId] = useState<string | null>(null);
  return <CustomerPortalWorkspace activeModule="bookings" customerId={customerId} key={customerId ?? "customer"} onCustomerChange={setCustomerId} onModuleChange={vi.fn()} session={session} />;
}

afterEach(() => vi.unstubAllGlobals());

describe("CustomerPortalWorkspace", () => {
  it("does not auto-select assets and clears the booking quote when the organisation changes", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url), "http://test");
      requested.push(requestUrl.toString());
      if (requestUrl.pathname === "/api/v1/customers") {
        return response({ total: 2, limit: 100, offset: 0, items: [customer("customer-a", "Customer A"), customer("customer-b", "Customer B")] });
      }
      if (requestUrl.pathname === "/api/v1/assets") {
        const id = requestUrl.searchParams.get("customer_id") ?? "customer-a";
        return response({ total: 1, limit: 100, offset: 0, items: [asset(id)] });
      }
      if (requestUrl.pathname === "/api/v1/inspection-availability") {
        return response({ items: [{ quote_id: "quote-1", starts_at: "2026-10-22T10:00:00Z", ends_at: "2026-10-22T11:00:00Z", expires_at: "2026-10-22T12:00:00Z" }] });
      }
      if (requestUrl.pathname === "/api/v1/notifications/me") return response({ total: 0, unread_total: 0, limit: 12, offset: 0, items: [] });
      return response({ total: 0, limit: 100, offset: 0, items: [] });
    }));

    const user = userEvent.setup();
    render(<Harness />);

    const organisation = await screen.findByRole("combobox", { name: "Organisation" });
    const location = screen.getByRole("combobox", { name: "Booking location" });
    await user.selectOptions(location, "location-customer-a");
    const bookingAsset = screen.getByRole("combobox", { name: "Booking asset" });
    expect(bookingAsset).toHaveValue("");
    expect(screen.getByRole("button", { name: "Find availability" })).toBeDisabled();

    await user.selectOptions(bookingAsset, "asset-customer-a");
    fireEvent.change(screen.getByLabelText("Preferred date"), { target: { value: "2026-10-25" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Find availability" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Find availability" }));
    expect(await screen.findByRole("radio")).toBeInTheDocument();

    await user.selectOptions(organisation, "customer-b");
    expect(await screen.findByRole("heading", { name: "Request an inspection" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Booking location" })).toHaveValue("");
    expect(screen.queryByRole("radio")).toBeNull();
    await waitFor(() => expect(requested.some((value) => value.includes("customer_id=customer-b"))).toBe(true));
  });
});
