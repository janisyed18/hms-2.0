import { useEffect, useMemo, useState } from "react";

import { loadAssetsWithFallback } from "../api/hmsClient";
import type { AssetRecord, DataSource } from "../domain/types";

export function useAssetsWorkspace() {
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [source, setSource] = useState<DataSource>("mock");
  const [query, setQuery] = useState("");

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

  return {
    assets,
    query,
    setQuery,
    source,
    visibleAssets
  };
}
