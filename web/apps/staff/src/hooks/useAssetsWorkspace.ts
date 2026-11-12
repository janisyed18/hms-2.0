import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createHmsClient } from "../api/hmsClient";
import { useRemoteOptions } from "./useRemoteOptions";
import { useActionNotice } from "../components/interaction/ActionNotice";
import { friendlyApiError } from "../components/interaction/friendlyApiError";
import { assetLabel } from "../utils/identity";
import type { AssetConfigurationOptions, AssetFormValues, AssetRecord } from "../domain/types";

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

const emptyConfigurationOptions: AssetConfigurationOptions = { materials: [], couplings: [], couplingAddOns: [], attachMethods: [], nominalBores: [] };
const PAGE_SIZE = 50;
interface LifecycleCounts { total: number; due: number; overdue: number; condemned: number }

export function useAssetsWorkspace() {
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [serverTotal, setServerTotal] = useState<number | undefined>(undefined);
  const [counts, setCounts] = useState<LifecycleCounts | null>(null);
  const [isLoadingMore, setLoadingMore] = useState(false);
  const [configurationOptions, setConfigurationOptions] = useState<AssetConfigurationOptions>(emptyConfigurationOptions);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [customerFilter, setCustomerFilterId] = useState("ALL");
  const [locationFilter, setLocationFilterId] = useState("ALL");
  const [productFilter, setProductFilterId] = useState("ALL");
  // What each chosen filter is called, kept from when it was picked: the option lists are searched, not complete.
  const [filterLabels, setFilterLabels] = useState<{ customer?: string; location?: string; product?: string }>({});
  const [lifecycleFilter, setLifecycleFilter] = useState("ALL");
  const [dueFrom, setDueFrom] = useState("");
  const [dueTo, setDueTo] = useState("");
  const [editingAsset, setEditingAsset] = useState<AssetRecord | null>(null);
  const [formAsset, setFormAsset] = useState<AssetRecord | null>(null);
  const [isCopy, setIsCopy] = useState(false);
  const [isFormOpen, setFormOpen] = useState(false);
  // Which opening of the form is current: a save that finishes after the form moved on must not close it.
  const formSession = useRef(0);
  const [viewingAsset, setViewingAsset] = useState<AssetRecord | null>(null);
  const { notice, notify, clear: dismissNotice } = useActionNotice();
  const [deleteTarget, setDeleteTarget] = useState<AssetRecord | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setDeleting] = useState(false);
  // How many saves and deletes have landed here. A list answer asked for before one of
  // them must not be written: it still holds the row the delete removed, and under load
  // it can arrive afterwards and put it back.
  const mutations = useRef(0);

  // Customers and products are searched on the server as the person types, so neither list stops at a first page.
  const customerSearch = useRemoteOptions((text) => createHmsClient().listCustomers({ search: text, sort: "name", limit: 25 }).then((result) => result.items), true);
  const productSearch = useRemoteOptions((text) => createHmsClient().listProducts({ search: text, sort: "name", limit: 25 }).then((result) => result.items), true);

  // Options for the asset form, loaded once.
  useEffect(() => {
    let active = true;
    void createHmsClient().getAssetConfigurationOptions()
      .then((result) => { if (active) setConfigurationOptions(result); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Asset options could not be loaded."); });
    return () => { active = false; };
  }, []);

  // The totals above the table count the whole register, never the page on screen.
  const refreshCounts = useCallback(() => {
    const client = createHmsClient();
    const total = (status?: string) => client.listAssets({ status, limit: 1 }).then((result) => result.total);
    void Promise.all([total(), total("DUE"), total("OVERDUE"), total("CONDEMNED")])
      .then(([all, due, overdue, condemned]) => setCounts({ total: all, due, overdue, condemned }))
      .catch(() => setCounts(null));
  }, []);
  useEffect(() => { refreshCounts(); }, [refreshCounts]);

  // Search, customer, product, lifecycle and due dates are answered by the server, a page at a time.
  const filters = useMemo(() => ({
    search: query,
    customerId: customerFilter === "ALL" ? undefined : customerFilter,
    locationId: locationFilter === "ALL" ? undefined : locationFilter,
    productId: productFilter === "ALL" ? undefined : productFilter,
    status: lifecycleFilter === "ALL" ? undefined : lifecycleFilter,
    dueFrom: dueFrom || undefined,
    dueTo: dueTo || undefined
  }), [query, customerFilter, locationFilter, productFilter, lifecycleFilter, dueFrom, dueTo]);
  useEffect(() => {
    let active = true;
    // Only the first load replaces the table; a new search or filter keeps the rows until the answer arrives.
    setError(null);
    const timer = window.setTimeout(() => {
      const asked = mutations.current;
      void createHmsClient().listAssets({ ...filters, sort: "asset_number", limit: PAGE_SIZE, offset: 0 })
        .then((result) => { if (!active || mutations.current !== asked) return; setAssets(result.items); setServerTotal(result.total); })
        .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Asset records could not be loaded."); })
        .finally(() => { if (active) setIsLoading(false); });
    }, query ? 250 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [filters, query]);

  async function loadMore() {
    if (isLoadingMore) return;
    setLoadingMore(true);
    const asked = mutations.current;
    try {
      const next = await createHmsClient().listAssets({ ...filters, sort: "asset_number", limit: PAGE_SIZE, offset: assets.length });
      if (mutations.current !== asked) return;
      setAssets((current) => uniqueById([...current, ...next.items]));
      setServerTotal(next.total);
    } catch (reason) {
      notify({ kind: "error", message: friendlyApiError(reason, { fallback: "More assets could not be loaded. Try again." }).message, title: "Assets not loaded" });
    } finally { setLoadingMore(false); }
  }

  const visibleAssets = assets;
  function setCustomerFilter(id: string, label?: string) { setCustomerFilterId(id); setLocationFilterId("ALL"); setFilterLabels((current) => ({ ...current, customer: label, location: undefined })); }
  // A location belongs to one customer, so changing the customer drops it.
  function setLocationFilter(id: string, label?: string) { setLocationFilterId(id); setFilterLabels((current) => ({ ...current, location: label })); }
  function setProductFilter(id: string, label?: string) { setProductFilterId(id); setFilterLabels((current) => ({ ...current, product: label })); }
  function openCreate() { formSession.current += 1; setEditingAsset(null); setFormAsset(null); setIsCopy(false); setFormOpen(true); }
  function openEdit(asset: AssetRecord) { formSession.current += 1; setViewingAsset(null); setEditingAsset(asset); setFormAsset(asset); setIsCopy(false); setFormOpen(true); }
  function copyAsset(asset: AssetRecord) {
    formSession.current += 1;
    setViewingAsset(null);
    setEditingAsset(null);
    setFormAsset({ ...asset, assetName: `${asset.assetName || asset.assetNumber} copy`, customerSerialNo: "", etag: null });
    setIsCopy(true);
    setFormOpen(true);
  }
  const openDetail = useCallback((asset: AssetRecord) => { setViewingAsset(asset); }, []);
  /**
   * Finds an asset by id: the loaded register first, then the API. It only finds; it never opens, so the
   * caller can check the request is still the one that is wanted before showing anything. Null when the
   * asset is missing or not this person's to see.
   */
  const resolveAsset = useCallback(async (assetId: string): Promise<AssetRecord | null> => {
    const loadedAsset = assets.find((asset) => asset.id === assetId);
    if (loadedAsset) return loadedAsset;
    try { const asset = await createHmsClient().getAsset(assetId); setAssets((current) => uniqueById([asset, ...current])); return asset; }
    catch { return null; }
  }, [assets]);
  const reportOpenFailure = useCallback(() => setError("The selected asset could not be opened."), []);
  function closeDetail() { setViewingAsset(null); }
  function closeForm() { formSession.current += 1; setFormOpen(false); }
  async function saveAsset(values: AssetFormValues) {
    const client = createHmsClient();
    const session = formSession.current;
    const saved = editingAsset ? await client.updateAsset(editingAsset.id, values, editingAsset.etag) : await client.createAsset(values);
    if (!saved) return;
    mutations.current += 1;
    setAssets((current) => editingAsset ? current.map((asset) => asset.id === editingAsset.id ? saved : asset) : [saved, ...current]);
    setViewingAsset((current) => current?.id === saved.id ? saved : current);
    // The saved record always lands in the register; the form only closes if it is still the one that saved.
    if (session === formSession.current) { formSession.current += 1; setFormOpen(false); setEditingAsset(null); setFormAsset(null); setIsCopy(false); }
    // Only now, with the server's answer in hand, say it worked.
    refreshCounts();
    notify({ kind: "success", message: `${assetLabel(saved)} ${editingAsset ? "saved" : "created"} successfully.`, title: "Asset saved" });
  }
  function requestDelete(asset: AssetRecord) { setDeleteError(null); setDeleteTarget(asset); }
  function cancelDelete() { if (!isDeleting) { setDeleteTarget(null); setDeleteError(null); } }
  async function confirmDelete() {
    const asset = deleteTarget;
    if (!asset || isDeleting) return;
    setDeleting(true); setDeleteError(null);
    try {
      await createHmsClient().deleteAsset(asset.id, asset.etag);
      mutations.current += 1;
      setAssets((current) => current.filter((item) => item.id !== asset.id));
      setViewingAsset((current) => current?.id === asset.id ? null : current);
      setDeleteTarget(null);
      refreshCounts();
      notify({ kind: "success", message: `${assetLabel(asset)} was deleted.`, title: "Asset deleted" });
    } catch (reason) {
      // Nothing changed on the server, so nothing changes here: the asset stays listed.
      setDeleteError(friendlyApiError(reason, { fallback: `${assetLabel(asset)} could not be deleted. Try again.` }).message);
    } finally { setDeleting(false); }
  }
  function clearAssetFilters() { setCustomerFilter("ALL"); setLocationFilter("ALL"); setProductFilter("ALL"); setLifecycleFilter("ALL"); setDueFrom(""); setDueTo(""); }
  const activeFilterCount = [customerFilter !== "ALL", locationFilter !== "ALL", productFilter !== "ALL", lifecycleFilter !== "ALL", Boolean(dueFrom), Boolean(dueTo)].filter(Boolean).length;
  return { serverTotal, activeFilterCount, deleteError, deleteTarget, cancelDelete, confirmDelete, dismissNotice, isDeleting, notice, requestDelete, assets, clearAssetFilters, closeDetail, copyAsset, counts, customerFilter, locationFilter, setLocationFilter, customerSearch, filterLabels, isLoadingMore, loadMore, productSearch, configurationOptions, dueFrom, dueTo, editingAsset, formAsset, isCopy, isFormOpen, lifecycleFilter, openCreate, openDetail, openEdit, reportOpenFailure, resolveAsset, productFilter, query, saveAsset, setCustomerFilter, setDueFrom, setDueTo, closeForm, setLifecycleFilter, setProductFilter, setQuery, isLoading, error, viewingAsset, visibleAssets };
}
