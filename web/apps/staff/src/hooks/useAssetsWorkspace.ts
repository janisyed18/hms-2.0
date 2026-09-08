import { useCallback, useEffect, useMemo, useState } from "react";

import { createHmsClient } from "../api/hmsClient";
import type { AssetConfigurationOptions, AssetProductSummary, AssetFormValues, AssetRecord, CustomerLocation, CustomerRecord, ProductRecord, RecordSummary } from "../domain/types";

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

const emptyConfigurationOptions: AssetConfigurationOptions = { materials: [], couplings: [], couplingAddOns: [], attachMethods: [], nominalBores: [] };
const customerSummary = (customer: CustomerRecord): RecordSummary => ({ id: customer.id, code: customer.code, name: customer.name });
const productSummary = (product: ProductRecord): AssetProductSummary => ({ id: product.id, code: product.code, name: product.name, category: product.category });

export function useAssetsWorkspace() {
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [customers, setCustomers] = useState<CustomerRecord[]>([]);
  const [products, setProducts] = useState<AssetProductSummary[]>([]);
  const [configurationOptions, setConfigurationOptions] = useState<AssetConfigurationOptions>(emptyConfigurationOptions);
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
    const client = createHmsClient();
    setIsLoading(true); setError(null);
    void Promise.all([
      client.listAssets({ sort: "asset_number" }),
      client.listCustomers({ sort: "name", limit: 100 }),
      client.listProducts({ sort: "name", limit: 100 }),
      client.getAssetConfigurationOptions()
    ]).then(([assetResult, customerResult, productResult, configurationResult]) => {
      if (!active) return;
      setAssets(assetResult.items);
      setCustomers(customerResult.items);
      setProducts(uniqueById([...productResult.items.map(productSummary), ...assetResult.items.map((asset) => asset.product)]));
      setConfigurationOptions(configurationResult);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Asset records could not be loaded.");
    }).finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, []);

  const visibleAssets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return assets.filter((asset) => {
      const dueAt = asset.nextRetestDueAt ?? "";
      return (
        (customerFilter === "ALL" || asset.customer.id === customerFilter) &&
        (productFilter === "ALL" || asset.product.id === productFilter) &&
        (lifecycleFilter === "ALL" || asset.lifecycleStatus === lifecycleFilter) &&
        (!dueFrom || (dueAt && dueAt >= dueFrom)) &&
        (!dueTo || (dueAt && dueAt <= dueTo)) &&
        (!normalized || [asset.assetNumber, asset.assetName, asset.customerSerialNo, asset.purchaseOrderNumber, asset.tag, asset.lifecycleStatus, asset.customer.code, asset.customer.name, asset.product.code, asset.product.name, asset.location?.name, asset.location?.address1, asset.location?.address2, asset.location?.city, asset.location?.state, asset.location?.country, asset.notes, asset.description].filter(Boolean).some((value) => value?.toLowerCase().includes(normalized)))
      );
    });
  }, [assets, customerFilter, dueFrom, dueTo, lifecycleFilter, productFilter, query]);

  const customerOptions = useMemo(() => customers.length ? customers.map(customerSummary) : uniqueById(assets.map((asset) => asset.customer)), [assets, customers]);
  const locationOptions = useMemo(() => customers.map((customer) => ({ customerId: customer.id, locations: (customer.locations ?? []).filter((location): location is CustomerLocation => Boolean(location)) })), [customers]);
  const productOptions = useMemo(() => products.length ? products : uniqueById(assets.map((asset) => asset.product)), [assets, products]);
  function openCreate() { setEditingAsset(null); setFormOpen(true); }
  function openEdit(asset: AssetRecord) { setEditingAsset(asset); setFormOpen(true); }
  const openDetail = useCallback((asset: AssetRecord) => { setViewingAsset(asset); }, []);
  const openDetailById = useCallback(async (assetId: string) => {
    const loadedAsset = assets.find((asset) => asset.id === assetId);
    if (loadedAsset) return openDetail(loadedAsset);
    try { const asset = await createHmsClient().getAsset(assetId); setAssets((current) => uniqueById([asset, ...current])); openDetail(asset); }
    catch { setError("The selected asset could not be opened."); }
  }, [assets, openDetail]);
  function closeDetail() { setViewingAsset(null); }
  async function saveAsset(values: AssetFormValues) {
    const client = createHmsClient();
    const saved = editingAsset ? await client.updateAsset(editingAsset.id, values, editingAsset.etag) : await client.createAsset(values);
    setAssets((current) => editingAsset ? current.map((asset) => asset.id === editingAsset.id ? saved : asset) : [saved, ...current]);
    setViewingAsset((current) => current?.id === saved.id ? saved : current);
    setFormOpen(false); setEditingAsset(null);
  }
  async function archiveAsset(asset: AssetRecord) {
    if (!window.confirm(`Archive ${asset.assetNumber}?`)) return;
    await createHmsClient().archiveAsset(asset.id, asset.etag);
    setAssets((current) => current.filter((item) => item.id !== asset.id));
    setViewingAsset((current) => current?.id === asset.id ? null : current);
  }
  function clearAssetFilters() { setCustomerFilter("ALL"); setProductFilter("ALL"); setLifecycleFilter("ALL"); setDueFrom(""); setDueTo(""); }
  const activeFilterCount = [customerFilter !== "ALL", productFilter !== "ALL", lifecycleFilter !== "ALL", Boolean(dueFrom), Boolean(dueTo)].filter(Boolean).length;
  return { activeFilterCount, archiveAsset, assets, clearAssetFilters, closeDetail, customerFilter, customerOptions, configurationOptions, dueFrom, dueTo, editingAsset, isFormOpen, lifecycleFilter, locationOptions, openCreate, openDetail, openDetailById, openEdit, productFilter, productOptions, query, saveAsset, setCustomerFilter, setDueFrom, setDueTo, setFormOpen, setLifecycleFilter, setProductFilter, setQuery, isLoading, error, viewingAsset, visibleAssets };
}
