import { useEffect, useMemo, useState } from "react";

import { createHmsClient } from "../api/hmsClient";
import type { ProductFormValues, ProductRecord } from "../domain/types";

export function useProductsWorkspace() {
  const [products, setProducts] = useState<ProductRecord[]>([]);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("ALL");
  const [standardFilter, setStandardFilter] = useState("ALL");
  const [editingProduct, setEditingProduct] = useState<ProductRecord | null>(null);
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [isFormOpen, setFormOpen] = useState(false);

  useEffect(() => {
    let active = true;
    void createHmsClient().listProducts({ sort: "code" }).then((result) => {
      if (active) setProducts(result.items);
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
  }
  async function archiveProduct(product: ProductRecord) {
    if (!window.confirm(`Archive ${product.name}?`)) return;
    await createHmsClient().archiveProduct(product.id, product.etag);
    setProducts((current) => current.filter((item) => item.id !== product.id));
    if (selectedProductId === product.id) setSelectedProductId(null);
  }
  function clearProductFilters() { setCategoryFilter("ALL"); setStandardFilter("ALL"); }
  const activeFilterCount = [categoryFilter !== "ALL", standardFilter !== "ALL"].filter(Boolean).length;
  return { activeFilterCount, archiveProduct, categoryFilter, categoryOptions, closeDetail, clearProductFilters, editingProduct, isFormOpen, openCreate, openDetail, openEdit, products, query, saveProduct, selectedProduct, setCategoryFilter, setFormOpen, setQuery, setStandardFilter, standardFilter, standardOptions, visibleProducts };
}
