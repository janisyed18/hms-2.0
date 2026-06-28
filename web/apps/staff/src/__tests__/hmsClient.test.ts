import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createHmsClient,
  loadCustomersWithFallback
} from "../api/hmsClient";
import { mockCustomers } from "../data/mockCustomers";

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

describe("hmsClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends HMS identity headers and maps customer list responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total: 1,
        limit: 50,
        offset: 0,
        items: [apiCustomer]
      })
    });

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
    expect(result.items[0]).toMatchObject({
      id: "cust-api-1",
      code: "NSD",
      name: "North Sea Drilling Ltd.",
      locations: expect.arrayContaining([
        expect.objectContaining({ name: "Aberdeen Yard" })
      ])
    });
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
