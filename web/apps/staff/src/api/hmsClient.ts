import { mockAssets } from "../data/mockAssets";
import { mockCertificates } from "../data/mockCertificates";
import {
  makeLocalCustomer,
  mergeMockMetrics,
  mockCustomers,
  mockTotalCustomers
} from "../data/mockCustomers";
import { mockInspections } from "../data/mockInspections";
import { mockProducts } from "../data/mockProducts";
import { mockReferenceStandards } from "../data/mockReferenceData";
import { mockRetestSchedules } from "../data/mockRetestSchedules";
import type {
  ApiListResult,
  AssetEndValues,
  AssetListResult,
  AssetLocationSummary,
  AssetFormValues,
  AssetRecord,
  AssetRetestSummary,
  AssetProductSummary,
  CertificateIssueValues,
  CertificateListResult,
  CertificateRecord,
  CertificateStatus,
  CustomerContact,
  CustomerFormValues,
  CustomerListResult,
  CustomerLocation,
  CustomerRecord,
  InspectionCreateValues,
  InspectionListResult,
  InspectionRecord,
  InspectionStatus,
  InspectionType,
  InspectionUpdateValues,
  ProductListResult,
  ProductFormValues,
  ProductRecord,
  PressureTestRecord,
  PressureTestValues,
  RecordSummary,
  ReferenceStandardListResult,
  ReferenceStandardFormValues,
  ReferenceStandardRecord,
  RetestScheduleListResult,
  RetestScheduleRecord,
  RetestScheduleStatus,
  RetestScheduleUpdateValues
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
  notes: string | null;
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
  address_1: string | null;
  address_2: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
}

interface ApiAssetRetestSchedule {
  due_at: string;
  status: string;
}

interface ApiAssetEnd {
  fitting: string | null;
  size: string | null;
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
  notes: string | null;
  customer: ApiSummary;
  product: ApiProductSummary;
  location: ApiLocationSummary | null;
  retest_schedule: ApiAssetRetestSchedule | null;
  a_end?: ApiAssetEnd | null;
  b_end?: ApiAssetEnd | null;
}

interface ApiAssetList {
  total: number;
  limit: number;
  offset: number;
  items: ApiAsset[];
}

interface ApiInspectionAssetSummary {
  id: string;
  asset_number: string;
  tag: string | null;
  lifecycle_status: string;
}

interface ApiPressureTest {
  id: string;
  applied_pressure_kpa: number;
  hold_time_seconds: number;
  passed: boolean;
  measurements: Record<string, unknown> | null;
}

interface ApiInspection {
  id: string;
  asset_id: string;
  inspection_type: InspectionType;
  status: InspectionStatus;
  result: string | null;
  inspector_user_id: string;
  reviewer_user_id: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  asset: ApiInspectionAssetSummary;
  customer: ApiSummary;
  product: ApiProductSummary;
  pressure_test: ApiPressureTest | null;
}

interface ApiInspectionList {
  total: number;
  limit: number;
  offset: number;
  items: ApiInspection[];
}

interface ApiRetestSchedule {
  id: string;
  asset_id: string;
  customer_id: string;
  due_at: string;
  status: RetestScheduleStatus;
  reminder_interval_days: number;
  escalation_interval_days: number;
  last_reminded_at: string | null;
  escalated_at: string | null;
  asset: ApiInspectionAssetSummary;
  customer: ApiSummary;
  product: ApiProductSummary;
}

interface ApiRetestScheduleList {
  total: number;
  limit: number;
  offset: number;
  items: ApiRetestSchedule[];
}

interface ApiCertificateInspectionSummary {
  id: string;
  inspection_type: InspectionType;
  status: InspectionStatus;
  result: string | null;
  approved_at: string | null;
}

interface ApiCertificate {
  id: string;
  inspection_id: string;
  asset_id: string;
  number: string;
  certificate_version: number;
  issued_at: string;
  valid_until: string | null;
  pdf_object_key: string;
  verification_hash: string;
  public_token: string;
  issued_by_user_id: string;
  status: CertificateStatus;
  asset: ApiInspectionAssetSummary;
  customer: ApiSummary;
  product: ApiProductSummary;
  inspection: ApiCertificateInspectionSummary;
}

interface ApiCertificateList {
  total: number;
  limit: number;
  offset: number;
  items: ApiCertificate[];
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
  standardCode?: string;
  enabled?: boolean;
  search?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

interface ListAssetOptions {
  search?: string;
  status?: string;
  customerId?: string;
  productId?: string;
  locationId?: string;
  dueFrom?: string;
  dueTo?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

interface ListInspectionOptions {
  search?: string;
  status?: InspectionStatus;
  inspectionType?: InspectionType;
  result?: string;
  assetId?: string;
  customerId?: string;
  productId?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

interface ListRetestScheduleOptions {
  search?: string;
  status?: RetestScheduleStatus;
  assetId?: string;
  customerId?: string;
  productId?: string;
  dueFrom?: string;
  dueTo?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

interface ListCertificateOptions {
  search?: string;
  status?: CertificateStatus;
  assetId?: string;
  customerId?: string;
  productId?: string;
  inspectionId?: string;
  validFrom?: string;
  validTo?: string;
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
  roles: "HMS_ADMIN,INSPECTOR,REVIEWER"
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
        notes: customer.notes,
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
          notes: customer.notes,
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
    address1: location.address_1,
    address2: location.address_2,
    city: location.city,
    state: location.state,
    country: location.country
  };
}

function toAssetRetestSummary(
  schedule: ApiAssetRetestSchedule | null
): AssetRetestSummary | null {
  if (schedule === null) {
    return null;
  }
  return {
    dueAt: schedule.due_at,
    status: schedule.status
  };
}

function toAssetEnd(end: ApiAssetEnd | null | undefined): AssetEndValues {
  return {
    fitting: end?.fitting ?? "",
    size: end?.size ?? ""
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
      notes: asset.notes,
      customer: toSummary(asset.customer),
      product: toProductSummary(asset.product),
      location: toLocationSummary(asset.location),
      retestSchedule: toAssetRetestSummary(asset.retest_schedule),
      aEnd: toAssetEnd(asset.a_end),
      bEnd: toAssetEnd(asset.b_end)
    },
    etag
  );
}

function toPressureTest(
  pressureTest: ApiPressureTest | null
): PressureTestRecord | null {
  if (pressureTest === null) {
    return null;
  }
  return {
    id: pressureTest.id,
    appliedPressureKpa: pressureTest.applied_pressure_kpa,
    holdTimeSeconds: pressureTest.hold_time_seconds,
    passed: pressureTest.passed,
    measurements: pressureTest.measurements
  };
}

function toInspection(
  inspection: ApiInspection,
  etag: string | null = null
): InspectionRecord {
  return withEtag(
    {
      id: inspection.id,
      assetId: inspection.asset_id,
      inspectionType: inspection.inspection_type,
      status: inspection.status,
      result: inspection.result,
      inspectorUserId: inspection.inspector_user_id,
      reviewerUserId: inspection.reviewer_user_id,
      submittedAt: inspection.submitted_at,
      approvedAt: inspection.approved_at,
      rejectedAt: inspection.rejected_at,
      asset: {
        id: inspection.asset.id,
        assetNumber: inspection.asset.asset_number,
        tag: inspection.asset.tag,
        lifecycleStatus: inspection.asset.lifecycle_status
      },
      customer: toSummary(inspection.customer),
      product: toProductSummary(inspection.product),
      pressureTest: toPressureTest(inspection.pressure_test)
    },
    etag
  );
}

function toInspectionAssetSummary(
  asset: ApiInspectionAssetSummary
): InspectionRecord["asset"] {
  return {
    id: asset.id,
    assetNumber: asset.asset_number,
    tag: asset.tag,
    lifecycleStatus: asset.lifecycle_status
  };
}

function toRetestScheduleRecord(
  schedule: ApiRetestSchedule,
  etag: string | null = null
): RetestScheduleRecord {
  return withEtag(
    {
      id: schedule.id,
      assetId: schedule.asset_id,
      customerId: schedule.customer_id,
      dueAt: schedule.due_at,
      status: schedule.status,
      reminderIntervalDays: schedule.reminder_interval_days,
      escalationIntervalDays: schedule.escalation_interval_days,
      lastRemindedAt: schedule.last_reminded_at,
      escalatedAt: schedule.escalated_at,
      asset: toInspectionAssetSummary(schedule.asset),
      customer: toSummary(schedule.customer),
      product: toProductSummary(schedule.product)
    },
    etag
  );
}

function toCertificate(
  certificate: ApiCertificate,
  etag: string | null = null
): CertificateRecord {
  return withEtag(
    {
      id: certificate.id,
      inspectionId: certificate.inspection_id,
      assetId: certificate.asset_id,
      number: certificate.number,
      certificateVersion: certificate.certificate_version,
      issuedAt: certificate.issued_at,
      validUntil: certificate.valid_until,
      pdfObjectKey: certificate.pdf_object_key,
      verificationHash: certificate.verification_hash,
      publicToken: certificate.public_token,
      issuedByUserId: certificate.issued_by_user_id,
      status: certificate.status,
      asset: toInspectionAssetSummary(certificate.asset),
      customer: toSummary(certificate.customer),
      product: toProductSummary(certificate.product),
      inspection: {
        id: certificate.inspection.id,
        inspectionType: certificate.inspection.inspection_type,
        status: certificate.inspection.status,
        result: certificate.inspection.result,
        approvedAt: certificate.inspection.approved_at
      }
    },
    etag
  );
}

function pressureTestPayload(
  pressureTest: PressureTestValues | null
): Record<string, unknown> | null {
  if (pressureTest === null) {
    return null;
  }
  return {
    applied_pressure_kpa: pressureTest.appliedPressureKpa,
    hold_time_seconds: pressureTest.holdTimeSeconds,
    passed: pressureTest.passed,
    measurements: pressureTest.measurements
  };
}

function retestScheduleStatus(lifecycleStatus: string): string {
  if (lifecycleStatus === "DUE" || lifecycleStatus === "OVERDUE") {
    return lifecycleStatus;
  }
  return "UPCOMING";
}

function assetEndPayload(end: AssetEndValues): Record<string, string | null> {
  return {
    fitting: end.fitting.trim() || null,
    size: end.size.trim() || null
  };
}

function assetPayload(values: AssetFormValues) {
  return {
    customer_id: values.customerId,
    location_id: values.locationId,
    product_id: values.productId,
    asset_number: values.assetNumber,
    customer_serial_no: values.customerSerialNo,
    lifecycle_status: values.lifecycleStatus,
    next_retest_due_at: values.nextRetestDueAt,
    notes: values.notes,
    retest_schedule: values.nextRetestDueAt
      ? {
          due_at: values.nextRetestDueAt,
          status: retestScheduleStatus(values.lifecycleStatus)
        }
      : null,
    a_end: assetEndPayload(values.aEnd),
    b_end: assetEndPayload(values.bEnd)
  };
}

function certificateSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function certificateIssuePayload(values: CertificateIssueValues) {
  const slug = certificateSlug(values.number);
  return {
    number: values.number,
    pdf_object_key: `certificates/${values.number}.pdf`,
    verification_hash: `dev-hash-${slug}-${values.inspectionId}`,
    public_token: `verify-${slug}-${values.inspectionId.slice(0, 8)}`,
    valid_until: values.validUntil
  };
}

function buildUrl(
  baseUrl: string,
  path: string,
  params: Record<string, string | number | boolean | undefined> = {}
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
    params: Record<string, string | number | boolean | undefined> = {}
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
            notes: values.notes,
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
        standard_code: listOptions.standardCode?.trim() || undefined,
        enabled: listOptions.enabled,
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
        product_id: listOptions.productId,
        location_id: listOptions.locationId,
        due_from: listOptions.dueFrom,
        due_to: listOptions.dueTo,
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
          body: JSON.stringify(assetPayload(values))
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
          body: JSON.stringify(assetPayload(values))
        }
      );
      return toAsset(response.data, response.etag);
    },

    async listInspections(
      listOptions: ListInspectionOptions = {}
    ): Promise<ApiListResult<InspectionRecord>> {
      const response = await request<ApiInspectionList>("/api/v1/inspections", {}, {
        limit: listOptions.limit ?? 50,
        offset: listOptions.offset ?? 0,
        status: listOptions.status,
        inspection_type: listOptions.inspectionType,
        result: listOptions.result?.trim() || undefined,
        asset_id: listOptions.assetId,
        customer_id: listOptions.customerId,
        product_id: listOptions.productId,
        search: listOptions.search?.trim() || undefined,
        sort: listOptions.sort
      });
      return {
        total: response.data.total,
        etag: response.etag,
        items: response.data.items.map((inspection) =>
          toInspection(inspection, response.etag)
        )
      };
    },

    async createInspection(
      values: InspectionCreateValues
    ): Promise<InspectionRecord> {
      const response = await request<ApiInspection>(
        `/api/v1/assets/${encodeURIComponent(values.assetId)}/inspections`,
        {
          method: "POST",
          body: JSON.stringify({
            inspection_type: values.inspectionType,
            result: values.result,
            pressure_test: pressureTestPayload(values.pressureTest)
          })
        }
      );
      return toInspection(response.data, response.etag);
    },

    async updateInspection(
      id: string,
      values: InspectionUpdateValues
    ): Promise<InspectionRecord> {
      const response = await request<ApiInspection>(
        `/api/v1/inspections/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            result: values.result,
            pressure_test: pressureTestPayload(values.pressureTest)
          })
        }
      );
      return toInspection(response.data, response.etag);
    },

    async submitInspection(id: string): Promise<InspectionRecord> {
      const response = await request<ApiInspection>(
        `/api/v1/inspections/${encodeURIComponent(id)}/submit`,
        {
          method: "POST"
        }
      );
      return toInspection(response.data, response.etag);
    },

    async approveInspection(id: string): Promise<InspectionRecord> {
      const response = await request<ApiInspection>(
        `/api/v1/inspections/${encodeURIComponent(id)}/approve`,
        {
          method: "POST"
        }
      );
      return toInspection(response.data, response.etag);
    },

    async listRetestSchedules(
      listOptions: ListRetestScheduleOptions = {}
    ): Promise<ApiListResult<RetestScheduleRecord>> {
      const response = await request<ApiRetestScheduleList>(
        "/api/v1/retest-schedules",
        {},
        {
          limit: listOptions.limit ?? 50,
          offset: listOptions.offset ?? 0,
          status: listOptions.status,
          asset_id: listOptions.assetId,
          customer_id: listOptions.customerId,
          product_id: listOptions.productId,
          due_from: listOptions.dueFrom,
          due_to: listOptions.dueTo,
          search: listOptions.search?.trim() || undefined,
          sort: listOptions.sort
        }
      );
      return {
        total: response.data.total,
        etag: response.etag,
        items: response.data.items.map((schedule) =>
          toRetestScheduleRecord(schedule, response.etag)
        )
      };
    },

    async updateRetestSchedule(
      id: string,
      values: RetestScheduleUpdateValues,
      etag?: string | null
    ): Promise<RetestScheduleRecord> {
      const response = await request<ApiRetestSchedule>(
        `/api/v1/retest-schedules/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: ifMatchHeader(etag),
          body: JSON.stringify({
            due_at: values.dueAt,
            status: values.status,
            reminder_interval_days: values.reminderIntervalDays,
            escalation_interval_days: values.escalationIntervalDays
          })
        }
      );
      return toRetestScheduleRecord(response.data, response.etag);
    },

    async listCertificates(
      listOptions: ListCertificateOptions = {}
    ): Promise<ApiListResult<CertificateRecord>> {
      const response = await request<ApiCertificateList>("/api/v1/certificates", {}, {
        limit: listOptions.limit ?? 50,
        offset: listOptions.offset ?? 0,
        status: listOptions.status,
        asset_id: listOptions.assetId,
        customer_id: listOptions.customerId,
        product_id: listOptions.productId,
        inspection_id: listOptions.inspectionId,
        valid_from: listOptions.validFrom,
        valid_to: listOptions.validTo,
        search: listOptions.search?.trim() || undefined,
        sort: listOptions.sort
      });
      return {
        total: response.data.total,
        etag: response.etag,
        items: response.data.items.map((certificate) =>
          toCertificate(certificate, response.etag)
        )
      };
    },

    async issueCertificate(
      values: CertificateIssueValues
    ): Promise<CertificateRecord> {
      const response = await request<ApiCertificate>(
        `/api/v1/inspections/${encodeURIComponent(values.inspectionId)}/certificate`,
        {
          method: "POST",
          body: JSON.stringify(certificateIssuePayload(values))
        }
      );
      return toCertificate(response.data, response.etag);
    },

    async revokeCertificate(id: string): Promise<CertificateRecord> {
      const response = await request<ApiCertificate>(
        `/api/v1/certificates/${encodeURIComponent(id)}/revoke`,
        {
          method: "POST"
        }
      );
      return toCertificate(response.data, response.etag);
    },

    async supersedeCertificate(id: string): Promise<CertificateRecord> {
      const response = await request<ApiCertificate>(
        `/api/v1/certificates/${encodeURIComponent(id)}/supersede`,
        {
          method: "POST"
        }
      );
      return toCertificate(response.data, response.etag);
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
      customer.notes,
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
    const matchesEnabled = options.enabled !== false;
    const matchesCategory =
      !options.category ||
      product.category.toLowerCase() === options.category.toLowerCase();
    const matchesStandard =
      !options.standardCode ||
      product.standardCode?.toLowerCase() === options.standardCode.toLowerCase();
    const matchesSearch =
      !normalized ||
      [product.code, product.name, product.category, product.subCategory]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(normalized));
    return matchesEnabled && matchesCategory && matchesStandard && matchesSearch;
  });
}

function filterMockAssets(options: ListAssetOptions = {}): AssetRecord[] {
  const normalized = options.search?.trim().toLowerCase();
  return mockAssets.filter((asset) => {
    const matchesStatus =
      !options.status || asset.lifecycleStatus === options.status;
    const matchesCustomer =
      !options.customerId || asset.customer.id === options.customerId;
    const matchesProduct =
      !options.productId || asset.product.id === options.productId;
    const matchesLocation =
      !options.locationId || asset.location?.id === options.locationId;
    const dueAt = asset.nextRetestDueAt ?? "";
    const matchesDueFrom = !options.dueFrom || (dueAt && dueAt >= options.dueFrom);
    const matchesDueTo = !options.dueTo || (dueAt && dueAt <= options.dueTo);
    const matchesSearch =
      !normalized ||
      [
        asset.assetNumber,
        asset.customerSerialNo,
        asset.tag,
        asset.customer.code,
        asset.customer.name,
        asset.product.code,
        asset.product.name,
        asset.notes
      ]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(normalized));
    return (
      matchesStatus &&
      matchesCustomer &&
      matchesProduct &&
      matchesLocation &&
      matchesDueFrom &&
      matchesDueTo &&
      matchesSearch
    );
  });
}

function filterMockInspections(
  options: ListInspectionOptions = {}
): InspectionRecord[] {
  const normalized = options.search?.trim().toLowerCase();
  return mockInspections.filter((inspection) => {
    const matchesStatus =
      !options.status || inspection.status === options.status;
    const matchesType =
      !options.inspectionType ||
      inspection.inspectionType === options.inspectionType;
    const matchesAsset =
      !options.assetId || inspection.assetId === options.assetId;
    const matchesCustomer =
      !options.customerId || inspection.customer.id === options.customerId;
    const matchesProduct =
      !options.productId || inspection.product.id === options.productId;
    const matchesResult =
      !options.result || inspection.result === options.result;
    const matchesSearch =
      !normalized ||
      [
        inspection.asset.assetNumber,
        inspection.asset.tag,
        inspection.customer.code,
        inspection.customer.name,
        inspection.product.code,
        inspection.product.name,
        inspection.inspectorUserId,
        inspection.reviewerUserId,
        inspection.result,
        inspection.status
      ]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(normalized));
    return (
      matchesStatus &&
      matchesType &&
      matchesAsset &&
      matchesCustomer &&
      matchesProduct &&
      matchesResult &&
      matchesSearch
    );
  });
}

function filterMockRetestSchedules(
  options: ListRetestScheduleOptions = {}
): RetestScheduleRecord[] {
  const normalized = options.search?.trim().toLowerCase();
  const filtered = mockRetestSchedules.filter((schedule) => {
    const matchesStatus =
      !options.status || schedule.status === options.status;
    const matchesAsset =
      !options.assetId || schedule.assetId === options.assetId;
    const matchesCustomer =
      !options.customerId || schedule.customerId === options.customerId;
    const matchesProduct =
      !options.productId || schedule.product.id === options.productId;
    const matchesDueFrom = !options.dueFrom || schedule.dueAt >= options.dueFrom;
    const matchesDueTo = !options.dueTo || schedule.dueAt <= options.dueTo;
    const matchesSearch =
      !normalized ||
      [
        schedule.asset.assetNumber,
        schedule.asset.tag,
        schedule.customer.code,
        schedule.customer.name,
        schedule.product.code,
        schedule.product.name,
        schedule.status,
        schedule.dueAt
      ]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(normalized));
    return (
      matchesStatus &&
      matchesAsset &&
      matchesCustomer &&
      matchesProduct &&
      matchesDueFrom &&
      matchesDueTo &&
      matchesSearch
    );
  });
  const sorted = [...filtered].sort((left, right) =>
    left.dueAt.localeCompare(right.dueAt)
  );
  return options.sort?.startsWith("-") ? sorted.reverse() : sorted;
}

function filterMockCertificates(
  options: ListCertificateOptions = {}
): CertificateRecord[] {
  const normalized = options.search?.trim().toLowerCase();
  const filtered = mockCertificates.filter((certificate) => {
    const matchesStatus =
      !options.status || certificate.status === options.status;
    const matchesAsset =
      !options.assetId || certificate.assetId === options.assetId;
    const matchesCustomer =
      !options.customerId || certificate.customer.id === options.customerId;
    const matchesInspection =
      !options.inspectionId || certificate.inspectionId === options.inspectionId;
    const matchesProduct =
      !options.productId || certificate.product.id === options.productId;
    const validUntil = certificate.validUntil ?? "";
    const matchesValidFrom =
      !options.validFrom || (validUntil && validUntil >= options.validFrom);
    const matchesValidTo =
      !options.validTo || (validUntil && validUntil <= options.validTo);
    const matchesSearch =
      !normalized ||
      [
        certificate.number,
        certificate.asset.assetNumber,
        certificate.asset.tag,
        certificate.customer.code,
        certificate.customer.name,
        certificate.product.code,
        certificate.product.name,
        certificate.publicToken,
        certificate.status,
        certificate.issuedByUserId
      ]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(normalized));
    return (
      matchesStatus &&
      matchesAsset &&
      matchesCustomer &&
      matchesInspection &&
      matchesProduct &&
      matchesValidFrom &&
      matchesValidTo &&
      matchesSearch
    );
  });
  if (options.sort === "number" || options.sort === "-number") {
    const sorted = [...filtered].sort((left, right) =>
      left.number.localeCompare(right.number)
    );
    return options.sort.startsWith("-") ? sorted.reverse() : sorted;
  }
  return [...filtered].sort((left, right) =>
    right.issuedAt.localeCompare(left.issuedAt)
  );
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

export async function loadInspectionsWithFallback(
  options: HmsClientOptions & ListInspectionOptions = {}
): Promise<InspectionListResult> {
  try {
    const client = createHmsClient(options);
    const response = await client.listInspections(options);
    return {
      source: "api",
      total: response.total,
      etag: response.etag,
      items: response.items
    };
  } catch {
    const items = filterMockInspections(options);
    return {
      source: "mock",
      total: mockInspections.length,
      items
    };
  }
}

export async function loadRetestSchedulesWithFallback(
  options: HmsClientOptions & ListRetestScheduleOptions = {}
): Promise<RetestScheduleListResult> {
  try {
    const client = createHmsClient(options);
    const response = await client.listRetestSchedules(options);
    return {
      source: "api",
      total: response.total,
      etag: response.etag,
      items: response.items
    };
  } catch {
    const items = filterMockRetestSchedules(options);
    return {
      source: "mock",
      total: mockRetestSchedules.length,
      items
    };
  }
}

export async function loadCertificatesWithFallback(
  options: HmsClientOptions & ListCertificateOptions = {}
): Promise<CertificateListResult> {
  try {
    const client = createHmsClient(options);
    const response = await client.listCertificates(options);
    return {
      source: "api",
      total: response.total,
      etag: response.etag,
      items: response.items
    };
  } catch {
    const items = filterMockCertificates(options);
    return {
      source: "mock",
      total: mockCertificates.length,
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
