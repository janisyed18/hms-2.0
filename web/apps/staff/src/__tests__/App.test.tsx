import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../App";
import type { StaffSession } from "../domain/types";

const apiCustomer = {
  id: "cust-api-1",
  code: "VOPA",
  name: "Vopak API",
  notes: "Coordinate terminal access before field work.",
  retest_enabled: true,
  default_retest_months: 12,
  locations: [
    {
      id: "loc-api-1",
      name: "API Terminal",
      address_1: "1 Friendship Road",
      address_2: "Bay 3",
      city: "Port Botany",
      state: "NSW",
      country: "AU"
    }
  ],
  contacts: []
};

const apiUnassignedCustomer = {
  id: "cust-api-2",
  code: "E2EAPI",
  name: "E2E API Customer",
  retest_enabled: true,
  default_retest_months: 12,
  locations: [
    {
      id: "loc-api-2",
      name: "E2E Test Yard",
      address_1: "42 Test Avenue",
      address_2: null,
      city: "Newcastle",
      state: "NSW",
      country: "AU"
    }
  ],
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

const apiUnassignedProduct = {
  id: "product-api-2",
  code: "API-2000",
  name: "API Spare Hose",
  category: "Composite",
  sub_category: "E2E",
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
  notes: "API asset staged in Bay 3.",
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
    address_1: "1 Friendship Road",
    address_2: "Bay 3",
    city: "Port Botany",
    state: "NSW",
    country: "AU"
  },
  retest_schedule: {
    due_at: "2026-07-15",
    status: "DUE"
  },
  a_end: {
    fitting: "Camlock M",
    size: "2 inch"
  },
  b_end: {
    fitting: "Flange W",
    size: "2 inch"
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

const apiRetestSchedule = {
  id: "retest-api-1",
  asset_id: "asset-api-1",
  customer_id: "cust-api-1",
  due_at: "2026-07-15",
  status: "OVERDUE",
  reminder_interval_days: 30,
  escalation_interval_days: 7,
  last_reminded_at: null,
  escalated_at: null,
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
  }
};

const apiStandard = {
  id: "standard-api-1",
  code: "API-STD",
  name: "API Standard"
};

const apiAdminUser = {
  id: "user-api-1",
  oidc_subject: "staff-ui-dev",
  email: "staff@example.com",
  first_name: "Alex",
  last_name: "Williams",
  role: "HMS_ADMIN",
  customer_id: null,
  created_at: "2026-07-07T00:00:00Z",
  updated_at: "2026-07-07T00:00:00Z"
};

const apiDevice = {
  device_id: "field-tablet-01",
  user_id: "inspector-1",
  platform: "ios",
  app_version: "26.4.1",
  last_sync_at: "2026-07-07T01:30:00Z",
  offline_window_days: 7,
  revoked: false
};

const apiAuditEvent = {
  sequence: 42,
  actor_id: "staff-ui-dev",
  action: "user.created",
  entity: "User",
  entity_id: "user-api-1",
  before: null,
  after: { email: "staff@example.com" },
  timestamp: "2026-07-07T01:35:00Z",
  hash: "audit-hash-42"
};

const inspectorSession = {
  userId: "inspector-1",
  displayName: "Ivy Inspector",
  roles: ["INSPECTOR"],
  permissions: ["customer:read", "asset:read", "inspection:write"],
  customerIds: [],
  authMode: "dev"
} satisfies StaffSession;

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

function deferredJson() {
  let resolve!: (value: ReturnType<typeof okJson>) => void;
  const promise = new Promise<ReturnType<typeof okJson>>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function routeFetch() {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === "DELETE") {
      return noContent();
    }
    if (path.startsWith("/api/v1/customers")) {
      return okJson({
        total: 2,
        limit: 50,
        offset: 0,
        items: [apiCustomer, apiUnassignedCustomer]
      });
    }
    if (path.startsWith("/api/v1/products")) {
      return okJson({
        total: 2,
        limit: 50,
        offset: 0,
        items: [apiProduct, apiUnassignedProduct]
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
    if (path.startsWith("/api/v1/retest-schedules")) {
      if (init?.method === "PATCH") {
        return okJson({
          ...apiRetestSchedule,
          due_at: "2026-09-15",
          status: "UPCOMING",
          reminder_interval_days: 45,
          escalation_interval_days: 10
        });
      }
      return okJson({
        total: 1,
        limit: 50,
        offset: 0,
        items: [apiRetestSchedule]
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
      if (init?.method === "POST" && path.endsWith("/supersede")) {
        return okJson({ ...apiCertificate, status: "SUPERSEDED" });
      }
      if (init?.method === "POST" && path.endsWith("/revoke")) {
        return okJson({ ...apiCertificate, status: "REVOKED" });
      }
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
    if (path.startsWith("/api/v1/admin/users")) {
      if (init?.method === "POST") {
        return {
          ok: true,
          status: 201,
          headers: new Headers(),
          json: async () => ({
            ...apiAdminUser,
            id: "user-api-created",
            oidc_subject: "reviewer-2",
            email: "reviewer2@example.com",
            first_name: "Riley",
            last_name: "Reviewer",
            role: "REVIEWER"
          })
        };
      }
      if (init?.method === "DELETE") {
        return noContent();
      }
      return okJson({
        total: 1,
        limit: 50,
        offset: 0,
        items: [apiAdminUser]
      });
    }
    if (path.startsWith("/api/v1/admin/devices")) {
      if (init?.method === "PATCH") {
        return okJson({ ...apiDevice, revoked: true });
      }
      return okJson({
        total: 1,
        limit: 50,
        offset: 0,
        items: [apiDevice]
      });
    }
    if (path.startsWith("/api/v1/admin/audit-events")) {
      return okJson({
        total: 1,
        limit: 50,
        offset: 0,
        items: [apiAuditEvent]
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

    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeVisible();
    expect(screen.getByText("Overview")).toBeVisible();
    expect(screen.getByText("Operations")).toBeVisible();
    expect(screen.getByText("Management")).toBeVisible();
    expect(screen.getByText("System")).toBeVisible();
    expect(screen.getByText("Live Environment")).toBeVisible();
    expect(screen.getByRole("button", { name: "New Asset" })).toBeVisible();
    expect(screen.getByText("Total Assets")).toBeVisible();
    expect(screen.getByText("In Service")).toBeVisible();
    expect(screen.getByText("Overdue Retests")).toBeVisible();
    expect(screen.getByText("Fleet Health")).toBeVisible();
    expect(screen.getByText("Due This Week")).toBeVisible();
    expect(screen.getByText("Awaiting Review")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Customers" }));

    expect(await screen.findByRole("heading", { name: "Customer Management" })).toBeVisible();
    expect(screen.getByText("45 customers")).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Select customer North Sea Drilling Ltd./i })
    ).toBeVisible();
    expect(screen.getByRole("complementary", { name: /Customer detail/i })).toHaveTextContent(
      "North Sea Drilling Ltd."
    );
  });

  it("hides admin-only navigation for inspector sessions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App initialSession={inspectorSession} />);

    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Assets" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Inspections" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Users & Roles" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Devices" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Audit Log" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New Asset" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Inspections" }));

    expect(await screen.findByRole("heading", { name: "Inspection Management" })).toBeVisible();
    expect(screen.getByRole("button", { name: "User menu" })).toHaveTextContent(
      "Ivy Inspector"
    );
    expect(screen.getByRole("button", { name: "User menu" })).toHaveTextContent(
      "INSPECTOR"
    );
  });

  it("updates the selected customer from the table", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Customers" }));
    await user.click(
      await screen.findByRole("button", { name: /Select customer Bluewater Energy/i })
    );

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
      expect(
        screen.getByRole("button", { name: /Select customer Arctic Offshore AS/i })
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: /Select customer North Sea Drilling Ltd./i })
      ).not.toBeInTheDocument();
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
    await user.type(
      screen.getByLabelText("Customer notes"),
      "Call operations before scheduling the first retest."
    );
    await user.click(screen.getByRole("button", { name: "Save customer" }));

    expect(
      await screen.findByRole("button", { name: /Select customer Summit Marine Group/i })
    ).toBeVisible();
    expect(screen.getByRole("complementary", { name: /Customer detail/i })).toHaveTextContent(
      "Summit Marine Group"
    );
    await user.click(screen.getByRole("tab", { name: "Notes" }));
    expect(screen.getByRole("complementary", { name: /Customer detail/i })).toHaveTextContent(
      "Call operations before scheduling the first retest."
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

    expect(
      await screen.findByRole("button", { name: /Select customer Summit Marine Group/i })
    ).toBeVisible();
    expect(screen.getByLabelText("Search customers")).toHaveValue("");
  });

  it("navigates to asset, product, and reference-data modules with mock fallback rows", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Customers" }));
    await screen.findByRole("heading", { name: "Customer Management" });
    await user.click(screen.getByRole("button", { name: "Assets" }));
    expect(await screen.findByRole("heading", { name: "Asset Register" })).toBeVisible();
    expect(screen.getByRole("table", { name: "Asset records" })).toHaveTextContent(
      "Asset ID"
    );
    expect(screen.getByRole("table", { name: "Asset records" })).toHaveTextContent(
      "End A / End B"
    );
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
    expect(screen.getByRole("tab", { name: /Submitted/i })).toBeVisible();
    expect(screen.getByRole("table", { name: "Inspection records" })).toHaveTextContent(
      "997950"
    );
    expect(screen.getByRole("table", { name: "Inspection records" })).toHaveTextContent(
      "Pressure Test"
    );

    await user.click(screen.getByRole("button", { name: "Certificates" }));
    expect(await screen.findByRole("heading", { name: "Certificate Management" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "All Certificates" })).toBeVisible();
    expect(screen.getByRole("table", { name: "Certificate records" })).toHaveTextContent(
      "CERT-VOPA-NEW-1"
    );
  });

  it("shows backend-backed rows inside each core-record module", async () => {
    vi.stubGlobal("fetch", routeFetch());
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Customers" }));
    expect(
      await screen.findByRole("button", { name: /Select customer Vopak API/i })
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Assets" }));
    expect(await screen.findByRole("row", { name: /API-777/i })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Retest Schedule" }));
    expect(await screen.findByRole("row", { name: /API-777/i })).toHaveTextContent(
      "OVERDUE"
    );

    await user.click(screen.getByRole("button", { name: "Products" }));
    expect(await screen.findByRole("row", { name: /API Fuel Hose/i })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Reference Data" }));
    expect(await screen.findByRole("row", { name: /API Standard/i })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Inspections" }));
    expect((await screen.findAllByRole("row", { name: /API-777/i }))[0]).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Certificates" }));
    expect(await screen.findByRole("row", { name: /CERT-API-777-1/i })).toBeVisible();
  });

  it("uses full backend customer and product lists when adding assets", async () => {
    vi.stubGlobal("fetch", routeFetch());
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Assets" }));
    await user.click(screen.getByRole("button", { name: "Add Asset" }));

    expect(
      within(screen.getByLabelText("Asset customer")).getByRole("option", {
        name: "E2E API Customer"
      })
    ).toBeVisible();
    expect(
      within(screen.getByLabelText("Asset product")).getByRole("option", {
        name: "API Spare Hose"
      })
    ).toBeVisible();
  });

  it("preserves typed asset form values when option lists finish loading", async () => {
    const customers = deferredJson();
    const products = deferredJson();
    const fallbackFetch = routeFetch();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const path = String(url);
        if (path.startsWith("/api/v1/customers?limit=100")) {
          return customers.promise;
        }
        if (path.startsWith("/api/v1/products?limit=100")) {
          return products.promise;
        }
        return fallbackFetch(url, init);
      })
    );
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Assets" }));
    await user.click(await screen.findByRole("button", { name: "Add Asset" }));
    await user.type(screen.getByLabelText("Asset number"), "ASYNC-ASSET-001");
    await user.type(screen.getByLabelText("Customer serial number"), "SERIAL-ASYNC");

    customers.resolve(
      okJson({
        total: 2,
        limit: 100,
        offset: 0,
        items: [apiCustomer, apiUnassignedCustomer]
      })
    );
    products.resolve(
      okJson({
        total: 2,
        limit: 100,
        offset: 0,
        items: [apiProduct, apiUnassignedProduct]
      })
    );

    expect(
      await within(screen.getByLabelText("Asset customer")).findByRole("option", {
        name: "E2E API Customer"
      })
    ).toBeVisible();
    expect(
      await within(screen.getByLabelText("Asset product")).findByRole("option", {
        name: "API Spare Hose"
      })
    ).toBeVisible();
    expect(screen.getByLabelText("Asset number")).toHaveValue("ASYNC-ASSET-001");
    expect(screen.getByLabelText("Customer serial number")).toHaveValue("SERIAL-ASYNC");
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
    expect(screen.getByRole("complementary", { name: "Certificate detail" })).toHaveTextContent(
      "Valid until 2027-06-29"
    );
  });

  it("updates certificate lifecycle from the certificate detail panel", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Certificates" }));
    await user.click(await screen.findByRole("button", { name: "Open certificate CERT-VOPA-NEW-1" }));
    expect(screen.getByRole("button", { name: "Mark superseded" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Revoke certificate" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Mark superseded" }));

    expect(screen.getByRole("complementary", { name: "Certificate detail" })).toHaveTextContent(
      "SUPERSEDED"
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
    await user.type(screen.getByLabelText("Next retest due"), "2026-09-15");
    await user.type(screen.getByLabelText("Asset notes"), "Keep capped until install.");
    await user.type(screen.getByLabelText("A end fitting"), "Camlock A");
    await user.type(screen.getByLabelText("A end size"), "2 inch");
    await user.type(screen.getByLabelText("B end fitting"), "Flange B");
    await user.type(screen.getByLabelText("B end size"), "2 inch");

    expect(screen.getByDisplayValue("Camlock A")).toBeVisible();
    expect(screen.getByDisplayValue("Flange B")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Save asset" }));

    const assetRow = await screen.findByRole("row", { name: /ASSET-200/i });
    expect(assetRow).toBeVisible();
    expect(assetRow).toHaveTextContent("2026-09-15");
    expect(assetRow).toHaveTextContent("Camlock A 2 inch / Flange B 2 inch");
    expect(assetRow).toHaveTextContent("Keep capped until install.");
  });

  it("filters asset and product records from the filter panel", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Assets" }));
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.selectOptions(screen.getByLabelText("Asset lifecycle filter"), "OVERDUE");
    await user.selectOptions(screen.getByLabelText("Asset customer filter"), "cust-1005");
    await user.selectOptions(screen.getByLabelText("Asset product filter"), "product-1001");
    await user.type(screen.getByLabelText("Asset due from"), "2023-11-01");
    await user.type(screen.getByLabelText("Asset due to"), "2023-11-30");

    const assetTable = screen.getByRole("table", { name: "Asset records" });
    expect(assetTable).toHaveTextContent("997950");
    expect(assetTable).not.toHaveTextContent("ORIC-100");

    await user.click(screen.getByRole("button", { name: "Clear asset filters" }));
    expect(assetTable).toHaveTextContent("ORIC-100");

    await user.click(screen.getByRole("button", { name: "Products" }));
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.selectOptions(screen.getByLabelText("Product category filter"), "Composite");
    await user.selectOptions(screen.getByLabelText("Product standard filter"), "AS2683");

    const productTable = screen.getByRole("table", { name: "Product records" });
    expect(productTable).toHaveTextContent("FUELFLEX GREEN");
    expect(productTable).not.toHaveTextContent("SS1 CONV");
    expect(productTable).not.toHaveTextContent("Rubber Water Hose");
  });

  it("filters retest schedules by due-date range", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: /Retest Schedule/i }));
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.type(screen.getByLabelText("Retest due from"), "2026-07-20");
    await user.type(screen.getByLabelText("Retest due to"), "2026-08-01");

    const scheduleTable = screen.getByRole("table", { name: "Retest schedule records" });
    expect(scheduleTable).toHaveTextContent("ORIC-100");
    expect(scheduleTable).not.toHaveTextContent("997950");
    expect(scheduleTable).not.toHaveTextContent("VOPA-NEW");
  });

  it("uses date picker controls for user-entered dates", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Assets" }));
    await user.click(screen.getByRole("button", { name: "Add Asset" }));
    expect(screen.getByLabelText("Next retest due")).toHaveAttribute("type", "date");
    await user.click(screen.getByRole("button", { name: "Close form" }));

    await user.click(screen.getByRole("button", { name: /Retest Schedule/i }));
    await user.click(screen.getByRole("button", { name: "Open schedule 997950" }));
    expect(screen.getByLabelText("Retest due date")).toHaveAttribute("type", "date");

    await user.click(screen.getByRole("button", { name: "Certificates" }));
    await user.click(screen.getByRole("button", { name: "Issue Certificate" }));
    expect(screen.getByLabelText("Valid until")).toHaveAttribute("type", "date");
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
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeVisible();
    expect(screen.getByText("Mock data")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /Sync Queue/i }));
    expect(await screen.findByRole("heading", { name: "Sync Queue" })).toBeVisible();
    expect(screen.getByRole("table", { name: "Sync queue items" })).toHaveTextContent(
      "Certificate issue"
    );

    await user.click(screen.getByRole("button", { name: "Audit Log" }));
    expect(await screen.findByRole("heading", { name: "Audit Trail" })).toBeVisible();
    expect(screen.getByRole("table", { name: "Audit trail events" })).toHaveTextContent(
      "Inspection approved"
    );
  });

  it("opens and updates the retest schedule workspace", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: /Retest Schedule/i }));

    expect(await screen.findByRole("heading", { name: "Retest Schedule" })).toBeVisible();
    expect(screen.getByRole("table", { name: "Retest schedule records" })).toHaveTextContent(
      "997950"
    );

    await user.click(screen.getByRole("button", { name: "Open schedule 997950" }));
    await user.clear(screen.getByLabelText("Retest due date"));
    await user.type(screen.getByLabelText("Retest due date"), "2026-09-15");
    await user.selectOptions(screen.getByLabelText("Retest status"), "UPCOMING");
    await user.clear(screen.getByLabelText("Reminder interval days"));
    await user.type(screen.getByLabelText("Reminder interval days"), "45");
    await user.click(screen.getByRole("button", { name: "Save schedule" }));

    expect(screen.getByRole("complementary", { name: "Retest schedule detail" })).toHaveTextContent(
      "UPCOMING"
    );
    expect(screen.getByRole("complementary", { name: "Retest schedule detail" })).toHaveTextContent(
      "Due 2026-09-15"
    );
    expect(screen.getByRole("row", { name: /997950/i })).toHaveTextContent("2026-09-15");
  });

  it("opens analytics, users, and devices as implemented console workspaces", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Analytics" }));
    expect(await screen.findByRole("heading", { name: "Analytics" })).toBeVisible();
    expect(screen.getByText("Fleet Health Trend")).toBeVisible();
    expect(screen.getByText("Retest Risk by Customer")).toBeVisible();
    expect(screen.getByRole("table", { name: "Risk ranking" })).toHaveTextContent(
      "North Sea Drilling"
    );

    await user.click(screen.getByRole("button", { name: "Users & Roles" }));
    expect(await screen.findByRole("heading", { name: "Users & Roles" })).toBeVisible();
    expect(screen.getByText("Role Matrix")).toBeVisible();
    expect(screen.getByRole("table", { name: "User access records" })).toHaveTextContent(
      "James Mitchell"
    );
    expect(screen.getByRole("table", { name: "User access records" })).toHaveTextContent(
      "HMS Admin"
    );

    await user.click(screen.getByRole("button", { name: "Devices" }));
    expect(await screen.findByRole("heading", { name: "Devices" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Registered Devices" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Sync Health" })).toBeVisible();
    expect(screen.getByRole("table", { name: "Device records" })).toHaveTextContent(
      "Field Tablet 01"
    );
    expect(screen.getByRole("table", { name: "Device records" })).toHaveTextContent(
      "Offline Ready"
    );
  });

  it("shows backend-backed audit, users, and devices admin records", async () => {
    vi.stubGlobal("fetch", routeFetch());
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Audit Log" }));
    expect(await screen.findByRole("row", { name: /user.created/i })).toHaveTextContent(
      "staff-ui-dev"
    );
    expect(screen.getByText("Backend")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Users & Roles" }));
    expect(await screen.findByRole("row", { name: /staff@example.com/i })).toHaveTextContent(
      "HMS_ADMIN"
    );

    await user.click(screen.getByRole("button", { name: "Devices" }));
    expect(await screen.findByRole("row", { name: /field-tablet-01/i })).toHaveTextContent(
      "Active"
    );
  });

  it("creates and archives admin users from the users workspace", async () => {
    vi.stubGlobal("fetch", routeFetch());
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Users & Roles" }));
    await user.click(await screen.findByRole("button", { name: "Add User" }));
    await user.type(screen.getByLabelText("OIDC subject"), "reviewer-2");
    await user.type(screen.getByLabelText("Email"), "reviewer2@example.com");
    await user.type(screen.getByLabelText("First name"), "Riley");
    await user.type(screen.getByLabelText("Last name"), "Reviewer");
    await user.selectOptions(screen.getByLabelText("Role"), "REVIEWER");
    await user.click(screen.getByRole("button", { name: "Save user" }));

    expect(await screen.findByRole("row", { name: /reviewer2@example.com/i })).toHaveTextContent(
      "REVIEWER"
    );

    await user.click(screen.getByRole("button", { name: "Archive user reviewer2@example.com" }));
    await waitFor(() => {
      expect(screen.queryByRole("row", { name: /reviewer2@example.com/i })).not.toBeInTheDocument();
    });
  });

  it("shows structured admin API errors in system workspaces", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.startsWith("/api/v1/customers")) {
        return okJson({
          total: 1,
          limit: 50,
          offset: 0,
          items: [apiCustomer]
        });
      }
      if (path.startsWith("/api/v1/admin/users")) {
        return {
          ok: false,
          status: 403,
          headers: new Headers(),
          json: async () => ({
            error: {
              code: "forbidden",
              message: "Missing permission: user:admin",
              details: null
            }
          })
        };
      }
      throw new Error(`Unhandled URL: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Users & Roles" }));

    expect(await screen.findByText("Missing permission: user:admin")).toBeVisible();
  });

  it("opens topbar menus and applies global search navigation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.type(await screen.findByLabelText("Global search"), "certificate");
    await user.click(screen.getByRole("button", { name: "Run global search" }));
    expect(await screen.findByRole("heading", { name: "Certificate Management" })).toBeVisible();

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

  it("uses working filter summaries and download actions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();
    const objectUrl = "blob:hms-export";
    const createObjectURL = vi.fn().mockReturnValue(objectUrl);
    const revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL,
      revokeObjectURL
    });

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Customers" }));
    await user.click(screen.getByRole("button", { name: "More Filters" }));
    expect(screen.getByRole("status", { name: "Customer filter summary" })).toHaveTextContent(
      "Status"
    );

    await user.click(screen.getByRole("button", { name: "Download customer list" }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Certificates" }));
    await user.click(screen.getByRole("button", { name: "Filters" }));
    expect(
      screen.getByRole("status", { name: "Certificate records filter summary" })
    ).toHaveTextContent("Source");

    await user.click(screen.getByRole("button", { name: "Download Certificate records" }));
    expect(createObjectURL).toHaveBeenCalledTimes(2);
  });
});
