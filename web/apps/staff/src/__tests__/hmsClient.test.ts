import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createHmsClient,
  loadAssetsWithFallback,
  loadCustomersWithFallback,
  loadInspectionsWithFallback,
  loadProductsWithFallback,
  loadReferenceStandardsWithFallback
} from "../api/hmsClient";
import { mockAssets } from "../data/mockAssets";
import { mockCustomers } from "../data/mockCustomers";
import { mockInspections } from "../data/mockInspections";
import { mockProducts } from "../data/mockProducts";
import { mockReferenceStandards } from "../data/mockReferenceData";

const apiCustomer = {
  id: "cust-api-1",
  code: "NSD",
  name: "North Sea Drilling Ltd.",
  retest_enabled: true,
  default_retest_months: 12,
  locations: [
    {
      id: "loc-1",
      name: "Aberdeen Yard",
      address_1: "1 Harbour Road",
      address_2: null,
      city: "Aberdeen",
      state: null,
      country: "UK"
    }
  ],
  contacts: [
    {
      id: "contact-1",
      name: "Michael Grant",
      email: "michael.grant@example.com",
      phone: "+44 20 1000 1000",
      role: "Operations Manager",
      receives_retest_reminders: true
    }
  ]
};

const apiProduct = {
  id: "product-api-1",
  code: "1000GY",
  name: "FUELFLEX GREEN",
  category: "Composite",
  sub_category: "Petrol & Oil",
  standard_code: "AS2683"
};

const apiStandard = {
  id: "standard-api-1",
  code: "AS2683",
  name: "AS 2683"
};

const apiAsset = {
  id: "asset-api-1",
  asset_number: "997950",
  customer_serial_no: "VOPA-SN-1",
  tag: "HMS-997950",
  lifecycle_status: "OVERDUE",
  manufacture_date: "2023-05-02",
  next_retest_due_at: "2023-11-02",
  condemned_at: null,
  length_m: "6.100",
  customer: {
    id: "cust-api-1",
    code: "VOPA",
    name: "Vopak"
  },
  product: {
    id: "product-api-1",
    code: "1000GY",
    name: "FUELFLEX GREEN",
    category: "Composite"
  },
  location: {
    id: "loc-api-1",
    name: "Site A",
    city: "Port Botany",
    state: "NSW",
    country: "AU"
  },
  retest_schedule: {
    due_at: "2023-11-02",
    status: "OVERDUE"
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
    asset_number: "997950",
    tag: "HMS-997950",
    lifecycle_status: "OVERDUE"
  },
  customer: {
    id: "cust-api-1",
    code: "VOPA",
    name: "Vopak"
  },
  product: {
    id: "product-api-1",
    code: "1000GY",
    name: "FUELFLEX GREEN",
    category: "Composite"
  },
  pressure_test: {
    id: "pressure-api-1",
    applied_pressure_kpa: 1750,
    hold_time_seconds: 360,
    passed: true,
    measurements: {
      leak: "none",
      visual: "ok"
    }
  }
};

function okJson(body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    json: async () => body
  };
}

function noContent(headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 204,
    headers: new Headers(headers),
    json: async () => undefined
  };
}

describe("hmsClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends HMS identity headers and maps customer list responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson(
        {
          total: 1,
          limit: 50,
          offset: 0,
          items: [apiCustomer]
        },
        { ETag: '"customers-1"' }
      )
    );

    const client = createHmsClient({ fetcher: fetchMock, baseUrl: "" });
    const result = await client.listCustomers("north");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/customers?limit=50&offset=0&search=north",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-hms-user-id": "staff-ui-dev",
          "x-hms-roles": "HMS_ADMIN"
        })
      })
    );
    expect(result.etag).toBe('"customers-1"');
    expect(result.items[0]).toMatchObject({
      id: "cust-api-1",
      code: "NSD",
      name: "North Sea Drilling Ltd.",
      locations: expect.arrayContaining([
        expect.objectContaining({ name: "Aberdeen Yard" })
      ])
    });
  });

  it("maps product, asset, and reference-data list responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okJson(
          {
            total: 1,
            limit: 50,
            offset: 0,
            items: [apiProduct]
          },
          { ETag: '"products-1"' }
        )
      )
      .mockResolvedValueOnce(
        okJson(
          {
            total: 1,
            limit: 50,
            offset: 0,
            items: [apiAsset]
          },
          { ETag: '"assets-1"' }
        )
      )
      .mockResolvedValueOnce(
        okJson(
          {
            items: [apiStandard]
          },
          { ETag: '"standards-1"' }
        )
      );

    const client = createHmsClient({ fetcher: fetchMock, baseUrl: "" });
    const products = await client.listProducts({ search: "fuel", sort: "-code" });
    const assets = await client.listAssets({ status: "OVERDUE", sort: "asset_number" });
    const standards = await client.listReferenceStandards({ sort: "code" });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/products?limit=50&offset=0&search=fuel&sort=-code",
      expect.any(Object)
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/assets?limit=50&offset=0&status=OVERDUE&sort=asset_number",
      expect.any(Object)
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/v1/reference/standards?sort=code",
      expect.any(Object)
    );
    expect(products.etag).toBe('"products-1"');
    expect(products.items[0]).toMatchObject({
      id: "product-api-1",
      code: "1000GY",
      subCategory: "Petrol & Oil",
      standardCode: "AS2683"
    });
    expect(assets.etag).toBe('"assets-1"');
    expect(assets.items[0]).toMatchObject({
      id: "asset-api-1",
      assetNumber: "997950",
      lifecycleStatus: "OVERDUE",
      customer: expect.objectContaining({ code: "VOPA" }),
      product: expect.objectContaining({ code: "1000GY" }),
      retestSchedule: expect.objectContaining({ status: "OVERDUE" })
    });
    expect(standards.etag).toBe('"standards-1"');
    expect(standards.items[0]).toEqual({
      id: "standard-api-1",
      code: "AS2683",
      name: "AS 2683",
      etag: '"standards-1"'
    });
  });

  it("archives core records with DELETE and optional If-Match headers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(noContent())
      .mockResolvedValueOnce(noContent())
      .mockResolvedValueOnce(noContent())
      .mockResolvedValueOnce(noContent());

    const client = createHmsClient({ fetcher: fetchMock, baseUrl: "" });
    await client.archiveCustomer("cust-api-1", '"2"');
    await client.archiveProduct("product-api-1", '"3"');
    await client.archiveAsset("asset-api-1", '"4"');
    await client.archiveReferenceStandard("standard-api-1", '"5"');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/customers/cust-api-1",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ "If-Match": '"2"' })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/products/product-api-1",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ "If-Match": '"3"' })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/v1/assets/asset-api-1",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ "If-Match": '"4"' })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/v1/reference/standards/standard-api-1",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ "If-Match": '"5"' })
      })
    );
  });

  it("maps inspection list responses and workflow mutations", async () => {
    const submittedInspection = {
      ...apiInspection,
      status: "SUBMITTED",
      submitted_at: "2026-06-29T10:00:00Z"
    };
    const approvedInspection = {
      ...submittedInspection,
      status: "APPROVED",
      reviewer_user_id: "staff-ui-dev",
      approved_at: "2026-06-29T11:00:00Z"
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okJson(
          {
            total: 1,
            limit: 50,
            offset: 0,
            items: [apiInspection]
          },
          { ETag: '"inspections-1"' }
        )
      )
      .mockResolvedValueOnce(okJson(apiInspection))
      .mockResolvedValueOnce(okJson(apiInspection))
      .mockResolvedValueOnce(okJson(submittedInspection))
      .mockResolvedValueOnce(okJson(approvedInspection));

    const client = createHmsClient({ fetcher: fetchMock, baseUrl: "" });
    const list = await client.listInspections({
      status: "DRAFT",
      inspectionType: "SERVICE",
      search: "997",
      sort: "-created_at"
    });
    const created = await client.createInspection({
      assetId: "asset-api-1",
      inspectionType: "SERVICE",
      result: "REVIEW",
      pressureTest: null
    });
    const updated = await client.updateInspection("inspection-api-1", {
      result: "PASS",
      pressureTest: {
        appliedPressureKpa: 1750,
        holdTimeSeconds: 360,
        passed: true,
        measurements: { leak: "none" }
      }
    });
    const submitted = await client.submitInspection("inspection-api-1");
    const approved = await client.approveInspection("inspection-api-1");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/inspections?limit=50&offset=0&status=DRAFT&inspection_type=SERVICE&search=997&sort=-created_at",
      expect.any(Object)
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/assets/asset-api-1/inspections",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          inspection_type: "SERVICE",
          result: "REVIEW",
          pressure_test: null
        })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/v1/inspections/inspection-api-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          result: "PASS",
          pressure_test: {
            applied_pressure_kpa: 1750,
            hold_time_seconds: 360,
            passed: true,
            measurements: { leak: "none" }
          }
        })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/v1/inspections/inspection-api-1/submit",
      expect.objectContaining({ method: "POST" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      "/api/v1/inspections/inspection-api-1/approve",
      expect.objectContaining({ method: "POST" })
    );
    expect(list.etag).toBe('"inspections-1"');
    expect(list.items[0]).toMatchObject({
      id: "inspection-api-1",
      assetId: "asset-api-1",
      inspectionType: "SERVICE",
      status: "DRAFT",
      asset: expect.objectContaining({ assetNumber: "997950" }),
      customer: expect.objectContaining({ code: "VOPA" }),
      pressureTest: expect.objectContaining({ appliedPressureKpa: 1750 })
    });
    expect(created.result).toBe("REVIEW");
    expect(updated.pressureTest?.measurements).toMatchObject({ visual: "ok" });
    expect(submitted.status).toBe("SUBMITTED");
    expect(approved.reviewerUserId).toBe("staff-ui-dev");
  });

  it("uses mock fallback only when list requests reject or return non-OK", async () => {
    const apiFetch = vi.fn().mockResolvedValue(
      okJson({
        total: 1,
        limit: 50,
        offset: 0,
        items: [apiProduct]
      })
    );
    const nonOkFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers(),
      json: async () => ({ detail: "unavailable" })
    });
    const rejectedFetch = vi.fn().mockRejectedValue(new Error("offline"));

    const apiProducts = await loadProductsWithFallback({
      fetcher: apiFetch,
      baseUrl: ""
    });
    const fallbackProducts = await loadProductsWithFallback({
      fetcher: nonOkFetch,
      baseUrl: ""
    });
    const fallbackAssets = await loadAssetsWithFallback({
      fetcher: rejectedFetch,
      baseUrl: ""
    });
    const fallbackStandards = await loadReferenceStandardsWithFallback({
      fetcher: rejectedFetch,
      baseUrl: ""
    });
    const fallbackInspections = await loadInspectionsWithFallback({
      fetcher: rejectedFetch,
      baseUrl: ""
    });

    expect(apiProducts.source).toBe("api");
    expect(apiProducts.items[0].code).toBe("1000GY");
    expect(fallbackProducts.source).toBe("mock");
    expect(fallbackProducts.items).toHaveLength(mockProducts.length);
    expect(fallbackAssets.source).toBe("mock");
    expect(fallbackAssets.items).toHaveLength(mockAssets.length);
    expect(fallbackStandards.source).toBe("mock");
    expect(fallbackStandards.items).toHaveLength(mockReferenceStandards.length);
    expect(fallbackInspections.source).toBe("mock");
    expect(fallbackInspections.items).toHaveLength(mockInspections.length);
  });

  it("falls back to mock customer data when the backend is unavailable", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    const result = await loadCustomersWithFallback({
      fetcher: fetchMock,
      baseUrl: ""
    });

    expect(result.source).toBe("mock");
    expect(result.items).toHaveLength(mockCustomers.length);
    expect(result.items[0].name).toBe("North Sea Drilling Ltd.");
  });
});
