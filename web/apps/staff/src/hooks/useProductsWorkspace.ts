import { useEffect, useMemo, useState } from "react";

import { createHmsClient, loadProductsWithFallback } from "../api/hmsClient";
import type { DataSource, ProductFormValues, ProductRecord } from "../domain/types";

function localProduct(
  values: ProductFormValues,
  current?: ProductRecord | null
): ProductRecord {
  return {
    id: current?.id ?? `product-${Date.now()}`,
    code: values.code.trim().toUpperCase(),
    name: values.name.trim(),
    category: values.category.trim(),
    subCategory: values.subCategory,
    standardCode: current?.standardCode ?? null,
    etag: current?.etag ?? null
  };
}

export function useProductsWorkspace() {
  const [products, setProducts] = useState<ProductRecord[]>([]);
  const [source, setSource] = useState<DataSource>("mock");
  const [query, setQuery] = useState("");
  const [editingProduct, setEditingProduct] = useState<ProductRecord | null>(null);
  const [isFormOpen, setFormOpen] = useState(false);

  useEffect(() => {
    let active = true;
    loadProductsWithFallback({ sort: "code" }).then((result) => {
      if (!active) {
        return;
      }
      setProducts(result.items);
      setSource(result.source);
    });
    return () => {
      active = false;
    };
  }, []);

  const visibleProducts = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return products;
    }
    return products.filter((product) =>
      [product.code, product.name, product.category, product.subCategory, product.standardCode]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(normalized))
    );
  }, [products, query]);

  function openCreate() {
    setEditingProduct(null);
    setFormOpen(true);
  }

  function openEdit(product: ProductRecord) {
    setEditingProduct(product);
    setFormOpen(true);
  }

  async function saveProduct(values: ProductFormValues) {
    let saved = localProduct(values, editingProduct);
    if (source === "api") {
      try {
        const client = createHmsClient();
        saved = editingProduct
          ? await client.updateProduct(editingProduct.id, values, editingProduct.etag)
          : await client.createProduct(values);
      } catch {
        saved = localProduct(values, editingProduct);
      }
    }

    setProducts((current) => {
      if (editingProduct) {
        return current.map((product) =>
          product.id === editingProduct.id ? saved : product
        );
      }
      return [saved, ...current];
    });
    setFormOpen(false);
    setEditingProduct(null);
  }

  async function archiveProduct(product: ProductRecord) {
    if (!window.confirm(`Archive ${product.name}?`)) {
      return;
    }
    if (source === "api") {
      await createHmsClient().archiveProduct(product.id, product.etag);
    }
    setProducts((current) => current.filter((item) => item.id !== product.id));
  }

  return {
    archiveProduct,
    editingProduct,
    isFormOpen,
    openCreate,
    openEdit,
    products,
    query,
    saveProduct,
    setFormOpen,
    setQuery,
    source,
    visibleProducts
  };
}
