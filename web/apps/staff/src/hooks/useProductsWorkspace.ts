import { useEffect, useMemo, useState } from "react";

import { loadProductsWithFallback } from "../api/hmsClient";
import type { DataSource, ProductRecord } from "../domain/types";

export function useProductsWorkspace() {
  const [products, setProducts] = useState<ProductRecord[]>([]);
  const [source, setSource] = useState<DataSource>("mock");
  const [query, setQuery] = useState("");

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

  return {
    products,
    query,
    setQuery,
    source,
    visibleProducts
  };
}
