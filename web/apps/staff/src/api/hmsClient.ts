import {
  makeLocalCustomer,
  mergeMockMetrics,
  mockCustomers,
  mockTotalCustomers
} from "../data/mockCustomers";
import type {
  CustomerContact,
  CustomerFormValues,
  CustomerListResult,
  CustomerLocation,
  CustomerRecord
} from "../domain/types";

interface ApiLocation {
  id: string;
  name: string;
  address_1: string | null;
  address_2: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
}

interface ApiContact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string | null;
  receives_retest_reminders: boolean;
}

interface ApiCustomer {
  id: string;
  code: string;
  name: string;
  retest_enabled: boolean;
  default_retest_months: number | null;
  locations: ApiLocation[];
  contacts: ApiContact[];
}

interface ApiCustomerList {
  total: number;
  limit: number;
  offset: number;
  items: ApiCustomer[];
}

export interface HmsClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
  identity?: {
    userId?: string;
    roles?: string;
    customerIds?: string;
  };
}

interface ListCustomerOptions {
  search?: string;
  limit?: number;
  offset?: number;
}

const defaultIdentity = {
  userId: "staff-ui-dev",
  roles: "HMS_ADMIN"
};

function toLocation(location: ApiLocation): CustomerLocation {
  return {
    id: location.id,
    name: location.name,
    address1: location.address_1,
    address2: location.address_2,
    city: location.city,
    state: location.state,
    country: location.country
  };
}

function toContact(contact: ApiContact): CustomerContact {
  return {
    id: contact.id,
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    role: contact.role,
    receivesRetestReminders: contact.receives_retest_reminders
  };
}

function toCustomer(customer: ApiCustomer): CustomerRecord {
  return mergeMockMetrics({
    id: customer.id,
    code: customer.code,
    name: customer.name,
    retestEnabled: customer.retest_enabled,
    defaultRetestMonths: customer.default_retest_months,
    locations: customer.locations.map(toLocation),
    contacts: customer.contacts.map(toContact),
    status: "Active",
    riskLevel: "Low",
    industry: "Marine Operations",
    paymentTerms: "Net 30",
    contractStart: "Not set",
    contractEnd: "Not set",
    lastActivity: "Synced",
    metrics: makeLocalCustomer({
      name: customer.name,
      code: customer.code,
      retestEnabled: customer.retest_enabled,
      defaultRetestMonths: customer.default_retest_months
    }).metrics
  });
}

function buildUrl(
  baseUrl: string,
  path: string,
  params: Record<string, string | number | undefined> = {}
): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  });
  const query = search.toString();
  return `${baseUrl}${path}${query ? `?${query}` : ""}`;
}

function identityHeaders(options: HmsClientOptions): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-hms-user-id": options.identity?.userId ?? defaultIdentity.userId,
    "x-hms-roles": options.identity?.roles ?? defaultIdentity.roles,
    ...(options.identity?.customerIds
      ? { "x-hms-customer-ids": options.identity.customerIds }
      : {})
  };
}

export function createHmsClient(options: HmsClientOptions = {}) {
  const baseUrl = options.baseUrl ?? "";
  const fetcher = options.fetcher ?? fetch;

  async function request<T>(
    path: string,
    init: RequestInit = {},
    params: Record<string, string | number | undefined> = {}
  ): Promise<T> {
    const response = await fetcher(buildUrl(baseUrl, path, params), {
      ...init,
      headers: {
        ...identityHeaders(options),
        ...init.headers
      }
    });

    if (!response.ok) {
      throw new Error(`HMS API request failed: ${response.status}`);
    }

    return (await response.json()) as T;
  }

  return {
    async listCustomers(
      searchOrOptions: string | ListCustomerOptions = {}
    ): Promise<{ total: number; items: CustomerRecord[] }> {
      const options =
        typeof searchOrOptions === "string"
          ? { search: searchOrOptions }
          : searchOrOptions;
      const payload = await request<ApiCustomerList>("/api/v1/customers", {}, {
        limit: options.limit ?? 50,
        offset: options.offset ?? 0,
        search: options.search?.trim() || undefined
      });
      return {
        total: payload.total,
        items: payload.items.map(toCustomer)
      };
    },

    async createCustomer(values: CustomerFormValues): Promise<CustomerRecord> {
      const payload = await request<ApiCustomer>(
        "/api/v1/customers",
        {
          method: "POST",
          body: JSON.stringify({
            code: values.code,
            name: values.name,
            retest_enabled: values.retestEnabled,
            default_retest_months: values.defaultRetestMonths
          })
        }
      );
      return toCustomer(payload);
    }
  };
}

function filterMockCustomers(search?: string): CustomerRecord[] {
  const normalized = search?.trim().toLowerCase();
  if (!normalized) {
    return mockCustomers;
  }
  return mockCustomers.filter((customer) =>
    [customer.name, customer.code, customer.locations[0]?.city, customer.locations[0]?.country]
      .filter(Boolean)
      .some((value) => value?.toLowerCase().includes(normalized))
  );
}

export async function loadCustomersWithFallback(
  options: HmsClientOptions & { search?: string } = {}
): Promise<CustomerListResult> {
  try {
    const client = createHmsClient(options);
    const response = await client.listCustomers({ search: options.search });
    return {
      source: "api",
      total: response.total,
      items: response.items
    };
  } catch {
    const items = filterMockCustomers(options.search);
    return {
      source: "mock",
      total: mockTotalCustomers,
      items
    };
  }
}
