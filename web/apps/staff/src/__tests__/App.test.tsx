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

const apiInspection = {
  id: "inspection-api-1",
  asset_id: "asset-api-1",
  inspection_type: "SERVICE",
  status: "DRAFT",
  result: "REVIEW",
  inspector_user_id: "inspector-1",
  reviewer_user_id: null,
  submitted_at: null,
  approved_at: null,
  rejected_at: null,
  asset: {
    id: "asset-api-1",
    asset_number: "API-777",
    tag: "HMS-API-777",
    lifecycle_status: "DUE"
  },
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
  pressure_test: {
    id: "pressure-api-1",
    applied_pressure_kpa: 1500,
    hold_time_seconds: 300,
    passed: true,
    measurements: { leak: "none" }
  }
};

const apiApprovedInspection = {
  ...apiInspection,
  id: "inspection-api-approved-1",
  status: "APPROVED",
  result: "PASS",
  reviewer_user_id: "reviewer-1",
  approved_at: "2026-06-29T11:00:00Z"
};

const apiCertificate = {
  id: "certificate-api-1",
  inspection_id: "inspection-api-approved-1",
  asset_id: "asset-api-1",
  number: "CERT-API-777-1",
  certificate_version: 1,
  issued_at: "2026-06-29T12:00:00Z",
  valid_until: "2027-06-29",
  pdf_object_key: "certificates/CERT-API-777-1.pdf",
  verification_hash: "hash-api-777-1",
  public_token: "public-token-api-777-1",
  issued_by_user_id: "staff-ui-dev",
  status: "ISSUED",
  asset: {
    id: "asset-api-1",
    asset_number: "API-777",
    tag: "HMS-API-777",
    lifecycle_status: "DUE"
  },
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
  inspection: {
    id: "inspection-api-approved-1",
    inspection_type: "SERVICE",
    status: "APPROVED",
    result: "PASS",
    approved_at: "2026-06-29T11:00:00Z"
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

function noContent() {
  return {
    ok: true,
    status: 204,
    headers: new Headers(),
    json: async () => undefined
  };
}

function routeFetch() {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === "DELETE") {
      return noContent();
    }
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
    if (path.startsWith("/api/v1/inspections")) {
      if (init?.method === "POST" && path.includes("/certificate")) {
        return {
          ok: true,
          status: 201,
          headers: new Headers(),
          json: async () => apiCertificate
        };
      }
      return okJson({
        total: 2,
        limit: 50,
        offset: 0,
        items: [apiInspection, apiApprovedInspection]
      });
    }
    if (path.startsWith("/api/v1/certificates")) {
      return okJson({
        total: 1,
        limit: 50,
        offset: 0,
        items: [apiCertificate]
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

  it("renders the operations dashboard first and keeps the customer workspace reachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Operations Dashboard" })).toBeVisible();
    expect(screen.getByText("Live Environment")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Customers" }));

    expect(await screen.findByRole("heading", { name: "Customers" })).toBeVisible();
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

    await user.click(await screen.findByRole("button", { name: "Customers" }));
    await user.click(await screen.findByRole("row", { name: /Bluewater Energy/i }));

    expect(screen.getByRole("complementary", { name: /Customer detail/i })).toHaveTextContent(
      "Bluewater Energy"
    );
  });

  it("filters customer rows from the toolbar search", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Customers" }));
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

    await user.click(await screen.findByRole("button", { name: "Customers" }));
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

    await user.click(await screen.findByRole("button", { name: "Customers" }));
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

    await user.click(await screen.findByRole("button", { name: "Customers" }));
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

    await user.click(screen.getByRole("button", { name: "Inspections" }));
    expect(await screen.findByRole("heading", { name: "Inspection Management" })).toBeVisible();
    expect(screen.getByRole("table", { name: "Inspection records" })).toHaveTextContent(
      "997950"
    );

    await user.click(screen.getByRole("button", { name: "Certificates" }));
    expect(await screen.findByRole("heading", { name: "Certificate Management" })).toBeVisible();
    expect(screen.getByRole("table", { name: "Certificate records" })).toHaveTextContent(
      "CERT-VOPA-NEW-1"
    );
  });

  it("shows backend-backed rows inside each core-record module", async () => {
    vi.stubGlobal("fetch", routeFetch());
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Customers" }));
    expect(await screen.findByRole("row", { name: /Vopak API/i })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Assets" }));
    expect(await screen.findByRole("row", { name: /API-777/i })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Products" }));
    expect(await screen.findByRole("row", { name: /API Fuel Hose/i })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Reference Data" }));
    expect(await screen.findByRole("row", { name: /API Standard/i })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Inspections" }));
    expect((await screen.findAllByRole("row", { name: /API-777/i }))[0]).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Certificates" }));
    expect(await screen.findByRole("row", { name: /CERT-API-777-1/i })).toBeVisible();
  });

  it("issues a certificate from an approved inspection in the staff UI", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Certificates" }));
    await user.click(screen.getByRole("button", { name: "Issue Certificate" }));
    await user.selectOptions(screen.getByLabelText("Approved inspection"), "inspection-1003");
    await user.clear(screen.getByLabelText("Certificate number"));
    await user.type(screen.getByLabelText("Certificate number"), "CERT-VOPA-NEW-2");
    await user.clear(screen.getByLabelText("Valid until"));
    await user.type(screen.getByLabelText("Valid until"), "2027-06-29");
    await user.click(screen.getByRole("button", { name: "Issue certificate" }));

    expect(await screen.findByRole("row", { name: /CERT-VOPA-NEW-2/i })).toBeVisible();
    expect(screen.getByRole("complementary", { name: "Certificate detail" })).toHaveTextContent(
      "CERT-VOPA-NEW-2"
    );
  });

  it("creates a draft inspection from the staff UI", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Inspections" }));
    await user.click(screen.getByRole("button", { name: "Add Inspection" }));
    await user.selectOptions(screen.getByLabelText("Inspection asset"), "asset-1002");
    await user.selectOptions(screen.getByLabelText("Inspection type"), "NEW_ASSET");
    await user.selectOptions(screen.getByLabelText("Inspection result"), "PASS");
    await user.clear(screen.getByLabelText("Applied pressure kPa"));
    await user.type(screen.getByLabelText("Applied pressure kPa"), "900");
    await user.clear(screen.getByLabelText("Hold time seconds"));
    await user.type(screen.getByLabelText("Hold time seconds"), "180");
    await user.type(screen.getByLabelText("Measurement notes"), "visual=ok");
    await user.click(screen.getByRole("button", { name: "Save inspection" }));

    const oricRows = await screen.findAllByRole("row", { name: /ORIC-100/i });
    expect(oricRows[0]).toHaveTextContent("DRAFT");
  });

  it("edits and submits a draft inspection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Inspections" }));
    await user.click(await screen.findByRole("button", { name: "Open inspection 997950" }));
    await user.clear(screen.getByLabelText("Detail applied pressure kPa"));
    await user.type(screen.getByLabelText("Detail applied pressure kPa"), "1800");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await user.click(screen.getByRole("button", { name: "Submit inspection" }));

    await waitFor(() => {
      expect(
        within(screen.getByRole("complementary", { name: "Inspection detail" })).getByText(
          "SUBMITTED"
        )
      ).toBeVisible();
    });
  });

  it("approves a submitted inspection from the detail panel", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Inspections" }));
    await user.click(await screen.findByRole("button", { name: "Open inspection ORIC-100" }));
    await user.click(screen.getByRole("button", { name: "Approve inspection" }));

    await waitFor(() => {
      expect(
        within(screen.getByRole("complementary", { name: "Inspection detail" })).getByText(
          "APPROVED"
        )
      ).toBeVisible();
    });
  });

  it("opens the reference standard drawer and saves a standard", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Reference Data" }));
    await user.click(screen.getByRole("button", { name: "Add Standard" }));
    await user.type(screen.getByLabelText("Standard code"), "EN857");
    await user.type(screen.getByLabelText("Standard name"), "EN 857");
    await user.click(screen.getByRole("button", { name: "Save standard" }));

    expect(await screen.findByRole("row", { name: /EN 857/i })).toBeVisible();
  });

  it("opens the product drawer, adds a pressure rating row, and saves a product", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Products" }));
    await user.click(screen.getByRole("button", { name: "Add Product" }));
    await user.type(screen.getByLabelText("Product code"), "API-HOSE");
    await user.type(screen.getByLabelText("Product name"), "API Demo Hose");
    await user.type(screen.getByLabelText("Category"), "Composite");
    await user.click(screen.getByRole("button", { name: "Add pressure rating" }));

    expect(screen.getByText("Rating 1")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Save product" }));

    expect(await screen.findByRole("row", { name: /API Demo Hose/i })).toBeVisible();
  });

  it("opens the asset drawer, edits A/B end values, and saves an asset", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Assets" }));
    await user.click(screen.getByRole("button", { name: "Add Asset" }));
    await user.type(screen.getByLabelText("Asset number"), "ASSET-200");
    await user.type(screen.getByLabelText("Customer serial number"), "SER-200");
    await user.type(screen.getByLabelText("A end fitting"), "Camlock A");
    await user.type(screen.getByLabelText("B end fitting"), "Flange B");

    expect(screen.getByDisplayValue("Camlock A")).toBeVisible();
    expect(screen.getByDisplayValue("Flange B")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Save asset" }));

    expect(await screen.findByRole("row", { name: /ASSET-200/i })).toBeVisible();
  });

  it("confirms archive actions and calls soft-delete endpoints", async () => {
    const fetchMock = routeFetch();
    const confirmMock = vi.fn().mockReturnValue(true);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", confirmMock);
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Products" }));
    await user.click(await screen.findByRole("button", { name: "Archive API Fuel Hose" }));

    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalledWith("Archive API Fuel Hose?");
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/products/product-api-1",
        expect.objectContaining({ method: "DELETE" })
      );
    });
  });

  it("opens dashboard, sync queue, and audit as real shell workspaces", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Dashboard" }));
    expect(await screen.findByRole("heading", { name: "Operations Dashboard" })).toBeVisible();
    expect(screen.getByText("Mock data")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /Sync Queue/i }));
    expect(await screen.findByRole("heading", { name: "Sync Queue" })).toBeVisible();
    expect(screen.getByRole("table", { name: "Sync queue items" })).toHaveTextContent(
      "Certificate issue"
    );

    await user.click(screen.getByRole("button", { name: "Audit" }));
    expect(await screen.findByRole("heading", { name: "Audit Trail" })).toBeVisible();
    expect(screen.getByRole("table", { name: "Audit trail events" })).toHaveTextContent(
      "Inspection approved"
    );
  });

  it("opens topbar menus and applies global search navigation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.type(await screen.findByLabelText("Global search"), "certificate");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { name: "Certificates" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Environment and source details" }));
    expect(screen.getByRole("dialog", { name: "Environment details" })).toHaveTextContent(
      "Demo mode"
    );

    await user.click(screen.getByRole("button", { name: "Notifications" }));
    expect(screen.getByRole("dialog", { name: "Notifications" })).toHaveTextContent(
      "Inspection approval"
    );

    await user.click(screen.getByRole("button", { name: "Help" }));
    expect(screen.getByRole("dialog", { name: "Help" })).toHaveTextContent("Support");

    await user.click(screen.getByRole("button", { name: "User menu" }));
    expect(screen.getByRole("dialog", { name: "User menu" })).toHaveTextContent(
      "Alex Williams"
    );
  });
});
