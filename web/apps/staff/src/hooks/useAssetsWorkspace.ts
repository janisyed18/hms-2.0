import { useEffect, useMemo, useState } from "react";

import {
  createHmsClient,
  loadAssetsWithFallback,
  loadCustomersWithFallback,
  loadProductsWithFallback
} from "../api/hmsClient";
import type {
  AssetFormValues,
  AssetLocationSummary,
  AssetProductSummary,
  AssetRecord,
  CustomerLocation,
  CustomerRecord,
  DataSource,
  ProductRecord,
  RecordSummary
} from "../domain/types";

function uniqueById<TItem extends { id: string }>(items: TItem[]): TItem[] {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

function retestScheduleStatus(lifecycleStatus: string): string {
  if (lifecycleStatus === "DUE" || lifecycleStatus === "OVERDUE") {
    return lifecycleStatus;
  }
  return "UPCOMING";
}

function customerSummary(customer: CustomerRecord): RecordSummary {
  return {
    id: customer.id,
    code: customer.code,
    name: customer.name
  };
}

function productSummary(product: ProductRecord): AssetProductSummary {
  return {
    id: product.id,
    code: product.code,
    name: product.name,
    category: product.category
  };
}

function localAsset(
  values: AssetFormValues,
  customers: CustomerRecord[],
  products: AssetProductSummary[],
  current?: AssetRecord | null
): AssetRecord {
  const customer =
    customers.map(customerSummary).find((item) => item.id === values.customerId) ??
    current?.customer ??
    (customers[0] ? customerSummary(customers[0]) : null) ?? {
      id: values.customerId,
      code: "",
      name: "Unknown customer"
    };
  const product =
    products.find((item) => item.id === values.productId) ??
    current?.product ??
    products[0] ?? {
      id: values.productId,
      code: "",
      name: "Unknown product",
      category: ""
    };
  const selectedLocation = customers
    .flatMap((item) => item.locations ?? [])
    .filter((location): location is CustomerLocation => Boolean(location))
    .find((location) => location.id === values.locationId);
  return {
    id: current?.id ?? `asset-${Date.now()}`,
    assetNumber: values.assetNumber.trim().toUpperCase(),
    customerSerialNo: values.customerSerialNo,
    tag: current?.tag ?? null,
    lifecycleStatus: values.lifecycleStatus,
    manufactureDate: current?.manufactureDate ?? null,
    nextRetestDueAt: values.nextRetestDueAt,
    condemnedAt: current?.condemnedAt ?? null,
    lengthM: current?.lengthM ?? null,
    notes: values.notes,
    customer,
    product,
    location: selectedLocation ? assetLocationSummary(selectedLocation) : null,
    retestSchedule: values.nextRetestDueAt
      ? {
          dueAt: values.nextRetestDueAt,
          status: retestScheduleStatus(values.lifecycleStatus)
        }
      : current?.retestSchedule ?? null,
    aEnd: values.aEnd,
    bEnd: values.bEnd,
    etag: current?.etag ?? null
  };
}

function assetLocationSummary(location: CustomerLocation): AssetLocationSummary {
  return {
    id: location.id,
    name: location.name,
    address1: location.address1,
    address2: location.address2,
    city: location.city,
    state: location.state,
    country: location.country
  };
}

export function useAssetsWorkspace() {
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [customers, setCustomers] = useState<CustomerRecord[]>([]);
  const [products, setProducts] = useState<AssetProductSummary[]>([]);
  const [source, setSource] = useState<DataSource>("mock");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [customerFilter, setCustomerFilter] = useState("ALL");
  const [productFilter, setProductFilter] = useState("ALL");
  const [lifecycleFilter, setLifecycleFilter] = useState("ALL");
  const [dueFrom, setDueFrom] = useState("");
  const [dueTo, setDueTo] = useState("");
  const [editingAsset, setEditingAsset] = useState<AssetRecord | null>(null);
  const [isFormOpen, setFormOpen] = useState(false);
  const [viewingAsset, setViewingAsset] = useState<AssetRecord | null>(null);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setError(null);
    Promise.all([
      loadAssetsWithFallback({ sort: "asset_number" }),
      loadCustomersWithFallback({ sort: "name", limit: 100 }),
      loadProductsWithFallback({ sort: "name", limit: 100 })
    ]).then(([assetResult, customerResult, productResult]) => {
      if (!active) {
        return;
      }
      setAssets(assetResult.items);
      setCustomers(customerResult.items);
      setProducts(
        uniqueById([
          ...productResult.items.map(productSummary),
          ...assetResult.items.map((asset) => asset.product)
        ])
      );
      setSource(assetResult.source);
      setIsLoading(false);
    }).catch((reason: unknown) => {
      if (!active) {
        return;
      }
      setError(reason instanceof Error ? reason.message : "Asset records could not be loaded.");
      setIsLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  const visibleAssets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return assets.filter((asset) => {
      const matchesCustomer =
        customerFilter === "ALL" || asset.customer.id === customerFilter;
      const matchesProduct =
        productFilter === "ALL" || asset.product.id === productFilter;
      const matchesLifecycle =
        lifecycleFilter === "ALL" || asset.lifecycleStatus === lifecycleFilter;
      const dueAt = asset.nextRetestDueAt ?? "";
      const matchesDueFrom = !dueFrom || (dueAt && dueAt >= dueFrom);
      const matchesDueTo = !dueTo || (dueAt && dueAt <= dueTo);
      const matchesSearch =
        !normalized ||
        [
          asset.assetNumber,
          asset.customerSerialNo,
          asset.tag,
          asset.lifecycleStatus,
          asset.customer.code,
          asset.customer.name,
          asset.product.code,
          asset.product.name,
          asset.location?.name,
          asset.location?.address1,
          asset.location?.address2,
          asset.location?.city,
          asset.location?.state,
          asset.location?.country,
          asset.notes
        ]
          .filter(Boolean)
          .some((value) => value?.toLowerCase().includes(normalized));

      return (
        matchesCustomer &&
        matchesProduct &&
        matchesLifecycle &&
        matchesDueFrom &&
        matchesDueTo &&
        matchesSearch
      );
    });
  }, [
    assets,
    customerFilter,
    dueFrom,
    dueTo,
    lifecycleFilter,
    productFilter,
    query
  ]);

  const customerOptions = useMemo(
    () =>
      customers.length > 0
        ? customers.map(customerSummary)
        : uniqueById(assets.map((asset) => asset.customer)),
    [assets, customers]
  );

  const locationOptions = useMemo(
    () =>
      customers.map((customer) => ({
        customerId: customer.id,
        locations: (customer.locations ?? []).filter(
          (location): location is CustomerLocation => Boolean(location)
        )
      })),
    [customers]
  );

  const productOptions = useMemo(
    () =>
      products.length > 0
        ? products
        : uniqueById(assets.map((asset) => asset.product)),
    [assets, products]
  );

  function openCreate() {
    setEditingAsset(null);
    setFormOpen(true);
  }

  function openEdit(asset: AssetRecord) {
    setEditingAsset(asset);
    setFormOpen(true);
  }

  function openDetail(asset: AssetRecord) {
    setViewingAsset(asset);
  }

  function closeDetail() {
    setViewingAsset(null);
  }

  async function saveAsset(values: AssetFormValues) {
    let saved = localAsset(values, customers, productOptions, editingAsset);
    if (source === "api") {
      try {
        const client = createHmsClient();
        saved = editingAsset
          ? await client.updateAsset(editingAsset.id, values, editingAsset.etag)
          : await client.createAsset(values);
      } catch {
        saved = localAsset(values, customers, productOptions, editingAsset);
      }
    }

    setAssets((current) => {
      if (editingAsset) {
        return current.map((asset) =>
          asset.id === editingAsset.id ? saved : asset
        );
      }
      return [saved, ...current];
    });
    // Keep an open detail view in sync with the saved record.
    setViewingAsset((current) =>
      current && editingAsset && current.id === editingAsset.id ? saved : current
    );
    setFormOpen(false);
    setEditingAsset(null);
  }

  async function archiveAsset(asset: AssetRecord) {
    if (!window.confirm(`Archive ${asset.assetNumber}?`)) {
      return;
    }
    if (source === "api") {
      await createHmsClient().archiveAsset(asset.id, asset.etag);
    }
    setAssets((current) => current.filter((item) => item.id !== asset.id));
    setViewingAsset((current) => (current?.id === asset.id ? null : current));
  }

  function clearAssetFilters() {
    setCustomerFilter("ALL");
    setProductFilter("ALL");
    setLifecycleFilter("ALL");
    setDueFrom("");
    setDueTo("");
  }

  const activeFilterCount = [
    customerFilter !== "ALL",
    productFilter !== "ALL",
    lifecycleFilter !== "ALL",
    Boolean(dueFrom),
    Boolean(dueTo)
  ].filter(Boolean).length;

  return {
    activeFilterCount,
    archiveAsset,
    assets,
    clearAssetFilters,
    closeDetail,
    customerFilter,
    customerOptions,
    dueFrom,
    dueTo,
    editingAsset,
    isFormOpen,
    lifecycleFilter,
    locationOptions,
    openCreate,
    openDetail,
    openEdit,
    productFilter,
    productOptions,
    query,
    saveAsset,
    setCustomerFilter,
    setDueFrom,
    setDueTo,
    setFormOpen,
    setLifecycleFilter,
    setProductFilter,
    setQuery,
    source,
    isLoading,
    error,
    viewingAsset,
    visibleAssets
  };
}
