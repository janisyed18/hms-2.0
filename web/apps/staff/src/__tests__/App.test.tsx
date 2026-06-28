import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../App";

const apiCustomer = {
  id: "cust-api-1",
  code: "VOPA",
  name: "Vopak API",
  retest_enabled: true,
  default_retest_months: 12,
  locations: [],
  contacts: []
};

const apiProduct = {
  id: "product-api-1",
  code: "API-1000",
  name: "API Fuel Hose",
  category: "Composite",
  sub_category: "Petrol & Oil",
  standard_code: "AS2683"
};

const apiAsset = {
  id: "asset-api-1",
  asset_number: "API-777",
  customer_serial_no: "API-SN-777",
  tag: "HMS-API-777",
  lifecycle_status: "DUE",
  manufacture_date: "2026-01-15",
  next_retest_due_at: "2026-07-15",
  condemned_at: null,
  length_m: "5.000",
  customer: {
    id: "cust-api-1",
    code: "VOPA",
    name: "Vopak API"
  },
  product: {
    id: "product-api-1",
    code: "API-1000",
    name: "API Fuel Hose",
    category: "Composite"
  },
  location: {
    id: "loc-api-1",
    name: "API Terminal",
    city: "Port Botany",
    state: "NSW",
    country: "AU"
  },
  retest_schedule: {
    due_at: "2026-07-15",
    status: "DUE"
  }
};

const apiStandard = {
  id: "standard-api-1",
  code: "API-STD",
  name: "API Standard"
};

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body
  };
}

function routeFetch() {
  return vi.fn(async (url: string | URL | Request) => {
    const path = String(url);
    if (path.startsWith("/api/v1/customers")) {
      return okJson({
        total: 1,
        limit: 50,
        offset: 0,
        items: [apiCustomer]
      });
    }
    if (path.startsWith("/api/v1/products")) {
      return okJson({
        total: 1,
        limit: 50,
        offset: 0,
        items: [apiProduct]
      });
    }
    if (path.startsWith("/api/v1/assets")) {
      return okJson({
        total: 1,
        limit: 50,
        offset: 0,
        items: [apiAsset]
      });
    }
    if (path.startsWith("/api/v1/reference/standards")) {
      return okJson({
        items: [apiStandard]
      });
    }
    throw new Error(`Unhandled URL: ${path}`);
  });
}

describe("App", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the premium staff customer workspace with mock fallback data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Customers" })).toBeVisible();
    expect(screen.getByText("Live Environment")).toBeVisible();
    expect(screen.getByText("45 customers")).toBeVisible();
    expect(screen.getByRole("row", { name: /North Sea Drilling Ltd./i })).toBeVisible();
    expect(screen.getByRole("complementary", { name: /Customer detail/i })).toHaveTextContent(
      "North Sea Drilling Ltd."
    );
  });

  it("updates the selected customer from the table", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("row", { name: /Bluewater Energy/i }));

    expect(screen.getByRole("complementary", { name: /Customer detail/i })).toHaveTextContent(
      "Bluewater Energy"
    );
  });

  it("filters customer rows from the toolbar search", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.type(await screen.findByLabelText("Search customers"), "arctic");

    await waitFor(() => {
      const table = screen.getByRole("table", { name: "Customer records" });
      expect(within(table).getByText("Arctic Offshore AS")).toBeVisible();
      expect(within(table).queryByText("North Sea Drilling Ltd.")).not.toBeInTheDocument();
    });
  });

  it("creates a local customer record when using mock data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: /Add Customer/i }));
    await user.type(screen.getByLabelText("Customer name"), "Summit Marine Group");
    await user.type(screen.getByLabelText("Customer code"), "SMG");
    await user.click(screen.getByRole("button", { name: "Save customer" }));

    expect(await screen.findByRole("row", { name: /Summit Marine Group/i })).toBeVisible();
    expect(screen.getByRole("complementary", { name: /Customer detail/i })).toHaveTextContent(
      "Summit Marine Group"
    );
  });

  it("clears the customer filter when a local customer is created", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.type(await screen.findByLabelText("Search customers"), "arctic");
    await user.click(screen.getByRole("button", { name: /Add Customer/i }));
    await user.type(screen.getByLabelText("Customer name"), "Summit Marine Group");
    await user.type(screen.getByLabelText("Customer code"), "SMG");
    await user.click(screen.getByRole("button", { name: "Save customer" }));

    expect(await screen.findByRole("row", { name: /Summit Marine Group/i })).toBeVisible();
    expect(screen.getByLabelText("Search customers")).toHaveValue("");
  });

  it("navigates to asset, product, and reference-data modules with mock fallback rows", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole("heading", { name: "Customers" });
    await user.click(screen.getByRole("button", { name: "Assets" }));
    expect(await screen.findByRole("heading", { name: "Assets" })).toBeVisible();
    expect(screen.getByRole("table", { name: "Asset records" })).toHaveTextContent(
      "997950"
    );

    await user.click(screen.getByRole("button", { name: "Products" }));
    expect(await screen.findByRole("heading", { name: "Products" })).toBeVisible();
    expect(screen.getByRole("table", { name: "Product records" })).toHaveTextContent(
      "FUELFLEX GREEN"
    );

    await user.click(screen.getByRole("button", { name: "Reference Data" }));
    expect(await screen.findByRole("heading", { name: "Reference Data" })).toBeVisible();
    expect(
      screen.getByRole("table", { name: "Reference standard records" })
    ).toHaveTextContent("AS2683");
  });

  it("shows backend-backed rows inside each core-record module", async () => {
    vi.stubGlobal("fetch", routeFetch());
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByRole("row", { name: /Vopak API/i })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Assets" }));
    expect(await screen.findByRole("row", { name: /API-777/i })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Products" }));
    expect(await screen.findByRole("row", { name: /API Fuel Hose/i })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Reference Data" }));
    expect(await screen.findByRole("row", { name: /API Standard/i })).toBeVisible();
  });
});
