import { useEffect, useMemo, useState } from "react";

import {
  createHmsClient,
  loadAssetsWithFallback,
  loadCustomersWithFallback,
  loadProductsWithFallback
} from "../api/hmsClient";
import type {
  AssetFormValues,
  AssetProductSummary,
  AssetRecord,
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
  customers: RecordSummary[],
  products: AssetProductSummary[],
  current?: AssetRecord | null
): AssetRecord {
  const customer =
    customers.find((item) => item.id === values.customerId) ??
    current?.customer ??
    customers[0];
  const product =
    products.find((item) => item.id === values.productId) ??
    current?.product ??
    products[0];
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
    customer,
    product,
    location: current?.location ?? null,
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

export function useAssetsWorkspace() {
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [customers, setCustomers] = useState<RecordSummary[]>([]);
  const [products, setProducts] = useState<AssetProductSummary[]>([]);
  const [source, setSource] = useState<DataSource>("mock");
  const [query, setQuery] = useState("");
  const [editingAsset, setEditingAsset] = useState<AssetRecord | null>(null);
  const [isFormOpen, setFormOpen] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([
      loadAssetsWithFallback({ sort: "asset_number" }),
      loadCustomersWithFallback({ sort: "name", limit: 100 }),
      loadProductsWithFallback({ sort: "name", limit: 100 })
    ]).then(([assetResult, customerResult, productResult]) => {
      if (!active) {
        return;
      }
      setAssets(assetResult.items);
      setCustomers(
        uniqueById([
          ...customerResult.items.map(customerSummary),
          ...assetResult.items.map((asset) => asset.customer)
        ])
      );
      setProducts(
        uniqueById([
          ...productResult.items.map(productSummary),
          ...assetResult.items.map((asset) => asset.product)
        ])
      );
      setSource(assetResult.source);
    });
    return () => {
      active = false;
    };
  }, []);

  const visibleAssets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return assets;
    }
    return assets.filter((asset) =>
      [
        asset.assetNumber,
        asset.customerSerialNo,
        asset.tag,
        asset.lifecycleStatus,
        asset.customer.code,
        asset.customer.name,
        asset.product.code,
        asset.product.name,
        asset.location?.name
      ]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(normalized))
    );
  }, [assets, query]);

  const customerOptions = useMemo(
    () =>
      customers.length > 0
        ? customers
        : uniqueById(assets.map((asset) => asset.customer)),
    [assets, customers]
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

  async function saveAsset(values: AssetFormValues) {
    let saved = localAsset(values, customerOptions, productOptions, editingAsset);
    if (source === "api") {
      try {
        const client = createHmsClient();
        saved = editingAsset
          ? await client.updateAsset(editingAsset.id, values, editingAsset.etag)
          : await client.createAsset(values);
      } catch {
        saved = localAsset(values, customerOptions, productOptions, editingAsset);
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
  }

  return {
    archiveAsset,
    assets,
    customerOptions,
    editingAsset,
    isFormOpen,
    openCreate,
    openEdit,
    productOptions,
    query,
    saveAsset,
    setFormOpen,
    setQuery,
    source,
    visibleAssets
  };
}
