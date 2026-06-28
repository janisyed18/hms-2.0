import { useEffect, useMemo, useState } from "react";

import { createHmsClient, loadAssetsWithFallback } from "../api/hmsClient";
import type {
  AssetFormValues,
  AssetProductSummary,
  AssetRecord,
  DataSource,
  RecordSummary
} from "../domain/types";

function uniqueById<TItem extends { id: string }>(items: TItem[]): TItem[] {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
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
          status: values.lifecycleStatus
        }
      : current?.retestSchedule ?? null,
    etag: current?.etag ?? null
  };
}

export function useAssetsWorkspace() {
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [source, setSource] = useState<DataSource>("mock");
  const [query, setQuery] = useState("");
  const [editingAsset, setEditingAsset] = useState<AssetRecord | null>(null);
  const [isFormOpen, setFormOpen] = useState(false);

  useEffect(() => {
    let active = true;
    loadAssetsWithFallback({ sort: "asset_number" }).then((result) => {
      if (!active) {
        return;
      }
      setAssets(result.items);
      setSource(result.source);
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
    () => uniqueById(assets.map((asset) => asset.customer)),
    [assets]
  );

  const productOptions = useMemo(
    () => uniqueById(assets.map((asset) => asset.product)),
    [assets]
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
