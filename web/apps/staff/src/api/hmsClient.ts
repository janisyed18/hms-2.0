import { mockAssets } from "../data/mockAssets";
import {
  makeLocalCustomer,
  mergeMockMetrics,
  mockCustomers,
  mockTotalCustomers
} from "../data/mockCustomers";
import { mockProducts } from "../data/mockProducts";
import { mockReferenceStandards } from "../data/mockReferenceData";
import type {
  ApiListResult,
  AssetListResult,
  AssetLocationSummary,
  AssetFormValues,
  AssetRecord,
  AssetProductSummary,
  CustomerContact,
  CustomerFormValues,
  CustomerListResult,
  CustomerLocation,
  CustomerRecord,
  ProductListResult,
  ProductFormValues,
  ProductRecord,
  RecordSummary,
  ReferenceStandardListResult,
  ReferenceStandardFormValues,
  ReferenceStandardRecord,
  RetestScheduleRecord
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

interface ApiReferenceStandard {
  id: string;
  code: string;
  name: string;
}

interface ApiReferenceStandardList {
  items: ApiReferenceStandard[];
}

interface ApiProduct {
  id: string;
  code: string;
  name: string;
  category: string;
  sub_category: string | null;
  standard_code: string | null;
}

interface ApiProductList {
  total: number;
  limit: number;
  offset: number;
  items: ApiProduct[];
}

interface ApiSummary {
  id: string;
  code: string;
  name: string;
}

interface ApiProductSummary extends ApiSummary {
  category: string;
}

interface ApiLocationSummary {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  country: string | null;
}

interface ApiRetestSchedule {
  due_at: string;
  status: string;
}

interface ApiAsset {
  id: string;
  asset_number: string;
  customer_serial_no: string | null;
  tag: string | null;
  lifecycle_status: string;
  manufacture_date: string | null;
  next_retest_due_at: string | null;
  condemned_at: string | null;
  length_m: string | null;
  customer: ApiSummary;
  product: ApiProductSummary;
  location: ApiLocationSummary | null;
  retest_schedule: ApiRetestSchedule | null;
}

interface ApiAssetList {
  total: number;
  limit: number;
  offset: number;
  items: ApiAsset[];
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
  sort?: string;
  limit?: number;
  offset?: number;
}

interface ListProductOptions {
  category?: string;
  search?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

interface ListAssetOptions {
  search?: string;
  status?: string;
  customerId?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

interface ListReferenceStandardOptions {
  sort?: string;
}

interface HmsApiResponse<T> {
  data: T;
  etag: string | null;
}

const defaultIdentity = {
  userId: "staff-ui-dev",
  roles: "HMS_ADMIN"
};

function withEtag<TRecord extends object>(
  record: TRecord,
  etag: string | null
): TRecord & { etag: string | null } {
  return {
    ...record,
    etag
  };
}

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

function toCustomer(customer: ApiCustomer, etag: string | null = null): CustomerRecord {
  return mergeMockMetrics(
    withEtag(
      {
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
      },
      etag
    )
  );
}

function toReferenceStandard(
  standard: ApiReferenceStandard,
  etag: string | null = null
): ReferenceStandardRecord {
  return withEtag(
    {
      id: standard.id,
      code: standard.code,
      name: standard.name
    },
    etag
  );
}

function toProduct(product: ApiProduct, etag: string | null = null): ProductRecord {
  return withEtag(
    {
      id: product.id,
      code: product.code,
      name: product.name,
      category: product.category,
      subCategory: product.sub_category,
      standardCode: product.standard_code
    },
    etag
  );
}

function toSummary(summary: ApiSummary): RecordSummary {
  return {
    id: summary.id,
    code: summary.code,
    name: summary.name
  };
}

function toProductSummary(summary: ApiProductSummary): AssetProductSummary {
  return {
    id: summary.id,
    code: summary.code,
    name: summary.name,
    category: summary.category
  };
}

function toLocationSummary(
  location: ApiLocationSummary | null
): AssetLocationSummary | null {
  if (location === null) {
    return null;
  }
  return {
    id: location.id,
    name: location.name,
    city: location.city,
    state: location.state,
    country: location.country
  };
}

function toRetestSchedule(
  schedule: ApiRetestSchedule | null
): RetestScheduleRecord | null {
  if (schedule === null) {
    return null;
  }
  return {
    dueAt: schedule.due_at,
    status: schedule.status
  };
}

function toAsset(asset: ApiAsset, etag: string | null = null): AssetRecord {
  return withEtag(
    {
      id: asset.id,
      assetNumber: asset.asset_number,
      customerSerialNo: asset.customer_serial_no,
      tag: asset.tag,
      lifecycleStatus: asset.lifecycle_status,
      manufactureDate: asset.manufacture_date,
      nextRetestDueAt: asset.next_retest_due_at,
      condemnedAt: asset.condemned_at,
      lengthM: asset.length_m,
      customer: toSummary(asset.customer),
      product: toProductSummary(asset.product),
      location: toLocationSummary(asset.location),
      retestSchedule: toRetestSchedule(asset.retest_schedule)
    },
    etag
  );
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

function readEtag(response: Response): string | null {
  return response.headers?.get("ETag") ?? response.headers?.get("etag") ?? null;
}

function ifMatchHeader(etag?: string | null): Record<string, string> {
  return etag ? { "If-Match": etag } : {};
}

export function createHmsClient(options: HmsClientOptions = {}) {
  const baseUrl = options.baseUrl ?? "";
  const fetcher = options.fetcher ?? fetch;

  async function request<T>(
    path: string,
    init: RequestInit = {},
    params: Record<string, string | number | undefined> = {}
  ): Promise<HmsApiResponse<T>> {
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

    if (response.status === 204) {
      return {
        data: undefined as T,
        etag: readEtag(response)
      };
    }

    return {
      data: (await response.json()) as T,
      etag: readEtag(response)
    };
  }

  return {
    async listCustomers(
      searchOrOptions: string | ListCustomerOptions = {}
    ): Promise<ApiListResult<CustomerRecord>> {
      const listOptions =
        typeof searchOrOptions === "string"
          ? { search: searchOrOptions }
          : searchOrOptions;
      const response = await request<ApiCustomerList>("/api/v1/customers", {}, {
        limit: listOptions.limit ?? 50,
        offset: listOptions.offset ?? 0,
        search: listOptions.search?.trim() || undefined,
        sort: listOptions.sort
      });
      return {
        total: response.data.total,
        etag: response.etag,
        items: response.data.items.map((customer) =>
          toCustomer(customer, response.etag)
        )
      };
    },

    async createCustomer(values: CustomerFormValues): Promise<CustomerRecord> {
      const response = await request<ApiCustomer>(
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
      return toCustomer(response.data, response.etag);
    },

    async createReferenceStandard(
      values: ReferenceStandardFormValues
    ): Promise<ReferenceStandardRecord> {
      const response = await request<ApiReferenceStandard>(
        "/api/v1/reference/standards",
        {
          method: "POST",
          body: JSON.stringify({
            code: values.code,
            name: values.name,
            enabled: true
          })
        }
      );
      return toReferenceStandard(response.data, response.etag);
    },

    async updateReferenceStandard(
      id: string,
      values: ReferenceStandardFormValues,
      etag?: string | null
    ): Promise<ReferenceStandardRecord> {
      const response = await request<ApiReferenceStandard>(
        `/api/v1/reference/standards/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: ifMatchHeader(etag),
          body: JSON.stringify({
            code: values.code,
            name: values.name
          })
        }
      );
      return toReferenceStandard(response.data, response.etag);
    },

    async listProducts(
      listOptions: ListProductOptions = {}
    ): Promise<ApiListResult<ProductRecord>> {
      const response = await request<ApiProductList>("/api/v1/products", {}, {
        limit: listOptions.limit ?? 50,
        offset: listOptions.offset ?? 0,
        category: listOptions.category?.trim() || undefined,
        search: listOptions.search?.trim() || undefined,
        sort: listOptions.sort
      });
      return {
        total: response.data.total,
        etag: response.etag,
        items: response.data.items.map((product) =>
          toProduct(product, response.etag)
        )
      };
    },

    async createProduct(values: ProductFormValues): Promise<ProductRecord> {
      const response = await request<ApiProduct>(
        "/api/v1/products",
        {
          method: "POST",
          body: JSON.stringify({
            category: values.category,
            sub_category: values.subCategory,
            code: values.code,
            name: values.name,
            standard_id: values.standardId,
            enabled: true
          })
        }
      );
      return toProduct(response.data, response.etag);
    },

    async updateProduct(
      id: string,
      values: ProductFormValues,
      etag?: string | null
    ): Promise<ProductRecord> {
      const response = await request<ApiProduct>(
        `/api/v1/products/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: ifMatchHeader(etag),
          body: JSON.stringify({
            category: values.category,
            sub_category: values.subCategory,
            code: values.code,
            name: values.name,
            standard_id: values.standardId,
            enabled: true
          })
        }
      );
      return toProduct(response.data, response.etag);
    },

    async listAssets(
      listOptions: ListAssetOptions = {}
    ): Promise<ApiListResult<AssetRecord>> {
      const response = await request<ApiAssetList>("/api/v1/assets", {}, {
        limit: listOptions.limit ?? 50,
        offset: listOptions.offset ?? 0,
        search: listOptions.search?.trim() || undefined,
        status: listOptions.status,
        customer_id: listOptions.customerId,
        sort: listOptions.sort
      });
      return {
        total: response.data.total,
        etag: response.etag,
        items: response.data.items.map((asset) => toAsset(asset, response.etag))
      };
    },

    async createAsset(values: AssetFormValues): Promise<AssetRecord> {
      const response = await request<ApiAsset>(
        "/api/v1/assets",
        {
          method: "POST",
          body: JSON.stringify({
            customer_id: values.customerId,
            product_id: values.productId,
            asset_number: values.assetNumber,
            customer_serial_no: values.customerSerialNo,
            lifecycle_status: values.lifecycleStatus,
            next_retest_due_at: values.nextRetestDueAt
          })
        }
      );
      return toAsset(response.data, response.etag);
    },

    async updateAsset(
      id: string,
      values: AssetFormValues,
      etag?: string | null
    ): Promise<AssetRecord> {
      const response = await request<ApiAsset>(
        `/api/v1/assets/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: ifMatchHeader(etag),
          body: JSON.stringify({
            customer_id: values.customerId,
            product_id: values.productId,
            asset_number: values.assetNumber,
            customer_serial_no: values.customerSerialNo,
            lifecycle_status: values.lifecycleStatus,
            next_retest_due_at: values.nextRetestDueAt
          })
        }
      );
      return toAsset(response.data, response.etag);
    },

    async listReferenceStandards(
      listOptions: ListReferenceStandardOptions = {}
    ): Promise<ApiListResult<ReferenceStandardRecord>> {
      const response = await request<ApiReferenceStandardList>(
        "/api/v1/reference/standards",
        {},
        {
          sort: listOptions.sort
        }
      );
      return {
        total: response.data.items.length,
        etag: response.etag,
        items: response.data.items.map((standard) =>
          toReferenceStandard(standard, response.etag)
        )
      };
    },

    async archiveCustomer(id: string, etag?: string | null): Promise<void> {
      await request<void>(`/api/v1/customers/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: ifMatchHeader(etag)
      });
    },

    async archiveProduct(id: string, etag?: string | null): Promise<void> {
      await request<void>(`/api/v1/products/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: ifMatchHeader(etag)
      });
    },

    async archiveAsset(id: string, etag?: string | null): Promise<void> {
      await request<void>(`/api/v1/assets/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: ifMatchHeader(etag)
      });
    },

    async archiveReferenceStandard(
      id: string,
      etag?: string | null
    ): Promise<void> {
      await request<void>(
        `/api/v1/reference/standards/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: ifMatchHeader(etag)
        }
      );
    }
  };
}

function filterMockCustomers(search?: string): CustomerRecord[] {
  const normalized = search?.trim().toLowerCase();
  if (!normalized) {
    return mockCustomers;
  }
  return mockCustomers.filter((customer) =>
    [
      customer.name,
      customer.code,
      customer.locations[0]?.city,
      customer.locations[0]?.country
    ]
      .filter(Boolean)
      .some((value) => value?.toLowerCase().includes(normalized))
  );
}

function filterMockProducts(options: ListProductOptions = {}): ProductRecord[] {
  const normalized = options.search?.trim().toLowerCase();
  return mockProducts.filter((product) => {
    const matchesCategory =
      !options.category ||
      product.category.toLowerCase() === options.category.toLowerCase();
    const matchesSearch =
      !normalized ||
      [product.code, product.name, product.category, product.subCategory]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(normalized));
    return matchesCategory && matchesSearch;
  });
}

function filterMockAssets(options: ListAssetOptions = {}): AssetRecord[] {
  const normalized = options.search?.trim().toLowerCase();
  return mockAssets.filter((asset) => {
    const matchesStatus =
      !options.status || asset.lifecycleStatus === options.status;
    const matchesCustomer =
      !options.customerId || asset.customer.id === options.customerId;
    const matchesSearch =
      !normalized ||
      [
        asset.assetNumber,
        asset.customerSerialNo,
        asset.tag,
        asset.customer.code,
        asset.customer.name,
        asset.product.code,
        asset.product.name
      ]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(normalized));
    return matchesStatus && matchesCustomer && matchesSearch;
  });
}

function filterMockReferenceStandards(
  options: ListReferenceStandardOptions = {}
): ReferenceStandardRecord[] {
  const descending = options.sort?.startsWith("-") ?? false;
  const fieldName = options.sort?.replace(/^-/, "") ?? "code";
  const sorted = [...mockReferenceStandards];
  if (fieldName === "name") {
    sorted.sort((left, right) => left.name.localeCompare(right.name));
  } else {
    sorted.sort((left, right) => left.code.localeCompare(right.code));
  }
  return descending ? sorted.reverse() : sorted;
}

export async function loadCustomersWithFallback(
  options: HmsClientOptions & ListCustomerOptions = {}
): Promise<CustomerListResult> {
  try {
    const client = createHmsClient(options);
    const response = await client.listCustomers(options);
    return {
      source: "api",
      total: response.total,
      etag: response.etag,
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

export async function loadProductsWithFallback(
  options: HmsClientOptions & ListProductOptions = {}
): Promise<ProductListResult> {
  try {
    const client = createHmsClient(options);
    const response = await client.listProducts(options);
    return {
      source: "api",
      total: response.total,
      etag: response.etag,
      items: response.items
    };
  } catch {
    const items = filterMockProducts(options);
    return {
      source: "mock",
      total: mockProducts.length,
      items
    };
  }
}

export async function loadAssetsWithFallback(
  options: HmsClientOptions & ListAssetOptions = {}
): Promise<AssetListResult> {
  try {
    const client = createHmsClient(options);
    const response = await client.listAssets(options);
    return {
      source: "api",
      total: response.total,
      etag: response.etag,
      items: response.items
    };
  } catch {
    const items = filterMockAssets(options);
    return {
      source: "mock",
      total: mockAssets.length,
      items
    };
  }
}

export async function loadReferenceStandardsWithFallback(
  options: HmsClientOptions & ListReferenceStandardOptions = {}
): Promise<ReferenceStandardListResult> {
  try {
    const client = createHmsClient(options);
    const response = await client.listReferenceStandards(options);
    return {
      source: "api",
      total: response.total,
      etag: response.etag,
      items: response.items
    };
  } catch {
    const items = filterMockReferenceStandards(options);
    return {
      source: "mock",
      total: mockReferenceStandards.length,
      items
    };
  }
}
