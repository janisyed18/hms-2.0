import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createHmsClient,
  loadAssetsWithFallback,
  loadCertificatesWithFallback,
  loadCustomersWithFallback,
  loadInspectionsWithFallback,
  loadProductsWithFallback,
  loadReferenceStandardsWithFallback,
  loadRetestSchedulesWithFallback
} from "../api/hmsClient";
import { mockAssets } from "../data/mockAssets";
import { mockCertificates } from "../data/mockCertificates";
import { mockCustomers } from "../data/mockCustomers";
import { mockInspections } from "../data/mockInspections";
import { mockProducts } from "../data/mockProducts";
import { mockReferenceStandards } from "../data/mockReferenceData";
import { mockRetestSchedules } from "../data/mockRetestSchedules";

const apiCustomer = {
  id: "cust-api-1",
  code: "NSD",
  name: "North Sea Drilling Ltd.",
  notes: "Coordinate vessel access before retests.",
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
  notes: "Stored in Bay 3 for scheduled retest.",
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
    address_1: "1 Friendship Road",
    address_2: "Bay 3",
    city: "Port Botany",
    state: "NSW",
    country: "AU"
  },
  retest_schedule: {
    due_at: "2023-11-02",
    status: "OVERDUE"
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

const apiCertificate = {
  id: "certificate-api-1",
  inspection_id: "inspection-api-1",
  asset_id: "asset-api-1",
  number: "CERT-997950-1",
  certificate_version: 1,
  issued_at: "2026-06-29T12:00:00Z",
  valid_until: "2027-06-29",
  pdf_object_key: "certificates/CERT-997950-1.pdf",
  verification_hash: "hash-997950-1",
  public_token: "public-token-997950-1",
  issued_by_user_id: "staff-ui-dev",
  status: "ISSUED",
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
  inspection: {
    id: "inspection-api-1",
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
          "x-hms-roles": "HMS_ADMIN,INSPECTOR,REVIEWER"
        })
      })
    );
    expect(result.etag).toBe('"customers-1"');
    expect(result.items[0]).toMatchObject({
      id: "cust-api-1",
      code: "NSD",
      name: "North Sea Drilling Ltd.",
      notes: "Coordinate vessel access before retests.",
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
    const products = await client.listProducts({
      standardCode: "AS2683",
      enabled: true,
      search: "fuel",
      sort: "-code"
    });
    const assets = await client.listAssets({
      status: "OVERDUE",
      productId: "product-api-1",
      locationId: "location-api-1",
      dueFrom: "2023-11-01",
      dueTo: "2023-11-30",
      sort: "asset_number"
    });
    const standards = await client.listReferenceStandards({ sort: "code" });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/products?limit=50&offset=0&standard_code=AS2683&enabled=true&search=fuel&sort=-code",
      expect.any(Object)
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/assets?limit=50&offset=0&status=OVERDUE&product_id=product-api-1&location_id=location-api-1&due_from=2023-11-01&due_to=2023-11-30&sort=asset_number",
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
      notes: "Stored in Bay 3 for scheduled retest.",
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

  it("sends customer notes in create payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({
        ...apiCustomer,
        code: "SUM",
        name: "Summit Marine Group",
        notes: "Use Newcastle dispatch contact for retest planning."
      })
    );

    const client = createHmsClient({ fetcher: fetchMock, baseUrl: "" });
    const created = await client.createCustomer({
      code: "SUM",
      name: "Summit Marine Group",
      notes: "Use Newcastle dispatch contact for retest planning.",
      retestEnabled: true,
      defaultRetestMonths: 12
    } as never);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/customers",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          code: "SUM",
          name: "Summit Marine Group",
          notes: "Use Newcastle dispatch contact for retest planning.",
          retest_enabled: true,
          default_retest_months: 12
        })
      })
    );
    expect(created.notes).toBe("Use Newcastle dispatch contact for retest planning.");
  });

  it("sends asset retest schedule and end configuration payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({
        ...apiAsset,
        asset_number: "E2E-ASSET-001",
        customer_serial_no: "SER-E2E-001",
        lifecycle_status: "IN_SERVICE",
        next_retest_due_at: "2026-09-15",
        notes: "Install after pressure test approval.",
        retest_schedule: {
          due_at: "2026-09-15",
          status: "UPCOMING"
        },
        a_end: {
          fitting: "Camlock M",
          size: "2 inch"
        },
        b_end: {
          fitting: "Flange W",
          size: "2 inch"
        }
      })
    );

    const client = createHmsClient({ fetcher: fetchMock, baseUrl: "" });
    const created = await client.createAsset({
      assetNumber: "E2E-ASSET-001",
      customerId: "cust-api-1",
      locationId: "loc-1",
      customerSerialNo: "SER-E2E-001",
      productId: "product-api-1",
      lifecycleStatus: "IN_SERVICE",
      nextRetestDueAt: "2026-09-15",
      notes: "Install after pressure test approval.",
      aEnd: {
        fitting: "Camlock M",
        size: "2 inch"
      },
      bEnd: {
        fitting: "Flange W",
        size: "2 inch"
      }
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/assets",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          customer_id: "cust-api-1",
          location_id: "loc-1",
          product_id: "product-api-1",
          asset_number: "E2E-ASSET-001",
          customer_serial_no: "SER-E2E-001",
          lifecycle_status: "IN_SERVICE",
          next_retest_due_at: "2026-09-15",
          notes: "Install after pressure test approval.",
          retest_schedule: {
            due_at: "2026-09-15",
            status: "UPCOMING"
          },
          a_end: {
            fitting: "Camlock M",
            size: "2 inch"
          },
          b_end: {
            fitting: "Flange W",
            size: "2 inch"
          }
        })
      })
    );
    expect(created.nextRetestDueAt).toBe("2026-09-15");
    expect(created.retestSchedule).toEqual({
      dueAt: "2026-09-15",
      status: "UPCOMING"
    });
    expect(created.notes).toBe("Install after pressure test approval.");
    expect(created.aEnd).toEqual({ fitting: "Camlock M", size: "2 inch" });
    expect(created.bEnd).toEqual({ fitting: "Flange W", size: "2 inch" });
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
      result: "PASS",
      productId: "product-api-1",
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
      "/api/v1/inspections?limit=50&offset=0&status=DRAFT&inspection_type=SERVICE&result=PASS&product_id=product-api-1&search=997&sort=-created_at",
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

  it("maps certificate list responses and issue mutations", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okJson(
          {
            total: 1,
            limit: 50,
            offset: 0,
            items: [apiCertificate]
          },
          { ETag: '"certificates-1"' }
        )
      )
      .mockResolvedValueOnce(okJson(apiCertificate));

    const client = createHmsClient({ fetcher: fetchMock, baseUrl: "" });
    const list = await client.listCertificates({
      status: "ISSUED",
      productId: "product-api-1",
      validFrom: "2027-06-01",
      validTo: "2027-06-30",
      search: "997",
      sort: "-issued_at"
    });
    const issued = await client.issueCertificate({
      inspectionId: "inspection-api-1",
      number: "CERT-997950-1",
      validUntil: "2027-06-29"
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/certificates?limit=50&offset=0&status=ISSUED&product_id=product-api-1&valid_from=2027-06-01&valid_to=2027-06-30&search=997&sort=-issued_at",
      expect.any(Object)
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/inspections/inspection-api-1/certificate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          number: "CERT-997950-1",
          pdf_object_key: "certificates/CERT-997950-1.pdf",
          verification_hash: "dev-hash-cert-997950-1-inspection-api-1",
          public_token: "verify-cert-997950-1-inspecti",
          valid_until: "2027-06-29"
        })
      })
    );
    expect(list.etag).toBe('"certificates-1"');
    expect(list.items[0]).toMatchObject({
      id: "certificate-api-1",
      number: "CERT-997950-1",
      status: "ISSUED",
      asset: expect.objectContaining({ assetNumber: "997950" }),
      customer: expect.objectContaining({ code: "VOPA" }),
      inspection: expect.objectContaining({ status: "APPROVED" })
    });
    expect(issued.publicToken).toBe("public-token-997950-1");
  });

  it("maps retest schedule list/update and certificate lifecycle mutations", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okJson(
          {
            total: 1,
            limit: 50,
            offset: 0,
            items: [apiRetestSchedule]
          },
          { ETag: '"retests-1"' }
        )
      )
      .mockResolvedValueOnce(
        okJson(
          {
            ...apiRetestSchedule,
            due_at: "2026-09-15",
            status: "UPCOMING",
            reminder_interval_days: 45,
            escalation_interval_days: 10
          },
          { ETag: '"retest-2"' }
        )
      )
      .mockResolvedValueOnce(
        okJson({ ...apiCertificate, status: "REVOKED" })
      )
      .mockResolvedValueOnce(
        okJson({ ...apiCertificate, status: "SUPERSEDED" })
      );

    const client = createHmsClient({ fetcher: fetchMock, baseUrl: "" });
    const list = await client.listRetestSchedules({
      status: "OVERDUE",
      productId: "product-api-1",
      dueFrom: "2023-11-01",
      dueTo: "2023-11-30",
      search: "997",
      sort: "due_at"
    });
    const updated = await client.updateRetestSchedule("retest-api-1", {
      dueAt: "2026-09-15",
      status: "UPCOMING",
      reminderIntervalDays: 45,
      escalationIntervalDays: 10
    });
    const revoked = await client.revokeCertificate("certificate-api-1");
    const superseded = await client.supersedeCertificate("certificate-api-1");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/retest-schedules?limit=50&offset=0&status=OVERDUE&product_id=product-api-1&due_from=2023-11-01&due_to=2023-11-30&search=997&sort=due_at",
      expect.any(Object)
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/retest-schedules/retest-api-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          due_at: "2026-09-15",
          status: "UPCOMING",
          reminder_interval_days: 45,
          escalation_interval_days: 10
        })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/v1/certificates/certificate-api-1/revoke",
      expect.objectContaining({ method: "POST" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/v1/certificates/certificate-api-1/supersede",
      expect.objectContaining({ method: "POST" })
    );
    expect(list.etag).toBe('"retests-1"');
    expect(list.items[0]).toMatchObject({
      id: "retest-api-1",
      asset: expect.objectContaining({ assetNumber: "997950" }),
      status: "OVERDUE"
    });
    expect(updated.dueAt).toBe("2026-09-15");
    expect(updated.status).toBe("UPCOMING");
    expect(revoked.status).toBe("REVOKED");
    expect(superseded.status).toBe("SUPERSEDED");
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
    const fallbackCertificates = await loadCertificatesWithFallback({
      fetcher: rejectedFetch,
      baseUrl: ""
    });
    const fallbackRetestSchedules = await loadRetestSchedulesWithFallback({
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
    expect(fallbackCertificates.source).toBe("mock");
    expect(fallbackCertificates.items).toHaveLength(mockCertificates.length);
    expect(fallbackRetestSchedules.source).toBe("mock");
    expect(fallbackRetestSchedules.items).toHaveLength(mockRetestSchedules.length);
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
