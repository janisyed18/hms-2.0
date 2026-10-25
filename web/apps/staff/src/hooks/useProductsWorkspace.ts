import { useEffect, useMemo, useState } from "react";

import { createHmsClient } from "../api/hmsClient";
import { useActionNotice } from "../components/interaction/ActionNotice";
import { friendlyApiError } from "../components/interaction/friendlyApiError";
import { productLabel } from "../utils/identity";
import type { ProductFormValues, ProductRecord } from "../domain/types";

export function useProductsWorkspace() {
  const [products, setProducts] = useState<ProductRecord[]>([]);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("ALL");
  const [standardFilter, setStandardFilter] = useState("ALL");
  const [editingProduct, setEditingProduct] = useState<ProductRecord | null>(null);
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [isFormOpen, setFormOpen] = useState(false);
  const { notice, notify, clear: dismissNotice } = useActionNotice();
  const [archiveTarget, setArchiveTarget] = useState<ProductRecord | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [isArchiving, setArchiving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void createHmsClient().listProducts({ sort: "code" }).then((result) => {
      if (active) setProducts(result.items);
    }).catch((reason: unknown) => {
      if (active) setLoadError(friendlyApiError(reason, { fallback: "Products could not be loaded." }).message);
    });
    return () => { active = false; };
  }, []);

  const visibleProducts = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return products.filter((product) => (
      (categoryFilter === "ALL" || product.category === categoryFilter) &&
      (standardFilter === "ALL" || product.standardCode === standardFilter) &&
      (!normalized || [product.code, product.name, product.category, product.subCategory, product.standardCode]
        .filter(Boolean).some((value) => value?.toLowerCase().includes(normalized)))
    ));
  }, [categoryFilter, products, query, standardFilter]);

  const categoryOptions = useMemo(() => Array.from(new Set(products.map((product) => product.category))).sort(), [products]);
  const standardOptions = useMemo(() => Array.from(new Set(products.map((product) => product.standardCode).filter(Boolean))).sort() as string[], [products]);
  const selectedProduct = selectedProductId ? products.find((product) => product.id === selectedProductId) ?? null : null;

  function openCreate() { setEditingProduct(null); setFormOpen(true); }
  function openEdit(product: ProductRecord) { setSelectedProductId(product.id); setEditingProduct(product); setFormOpen(true); }
  function openDetail(product: ProductRecord) { setSelectedProductId(product.id); }
  function closeDetail() { setSelectedProductId(null); }
  async function saveProduct(values: ProductFormValues) {
    const client = createHmsClient();
    const saved = editingProduct ? await client.updateProduct(editingProduct.id, values, editingProduct.etag) : await client.createProduct(values);
    setProducts((current) => editingProduct ? current.map((product) => product.id === saved.id ? saved : product) : [saved, ...current]);
    setSelectedProductId(saved.id); setFormOpen(false); setEditingProduct(null);
    notify({ kind: "success", message: `${productLabel(saved)} ${editingProduct ? "saved" : "created"} successfully.`, title: "Product saved" });
  }
  function requestArchive(product: ProductRecord) { setArchiveError(null); setArchiveTarget(product); }
  function cancelArchive() { if (!isArchiving) { setArchiveTarget(null); setArchiveError(null); } }
  async function confirmArchive() {
    const product = archiveTarget;
    if (!product || isArchiving) return;
    setArchiving(true); setArchiveError(null);
    try {
      await createHmsClient().archiveProduct(product.id, product.etag);
      setProducts((current) => current.filter((item) => item.id !== product.id));
      if (selectedProductId === product.id) setSelectedProductId(null);
      setArchiveTarget(null);
      notify({ kind: "success", message: `${productLabel(product)} was archived.`, title: "Product archived" });
    } catch (reason) {
      setArchiveError(friendlyApiError(reason, { fallback: `${productLabel(product)} could not be archived. Try again.` }).message);
    } finally { setArchiving(false); }
  }
  function clearProductFilters() { setCategoryFilter("ALL"); setStandardFilter("ALL"); }
  const activeFilterCount = [categoryFilter !== "ALL", standardFilter !== "ALL"].filter(Boolean).length;
  return { activeFilterCount, archiveError, archiveTarget, cancelArchive, confirmArchive, dismissNotice, isArchiving, loadError, notice, requestArchive, categoryFilter, categoryOptions, closeDetail, clearProductFilters, editingProduct, isFormOpen, openCreate, openDetail, openEdit, products, query, saveProduct, selectedProduct, setCategoryFilter, setFormOpen, setQuery, setStandardFilter, standardFilter, standardOptions, visibleProducts };
}
