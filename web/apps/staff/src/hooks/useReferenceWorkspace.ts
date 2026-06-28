import { useEffect, useMemo, useState } from "react";

import { loadReferenceStandardsWithFallback } from "../api/hmsClient";
import type { DataSource, ReferenceStandardRecord } from "../domain/types";

export function useReferenceWorkspace() {
  const [standards, setStandards] = useState<ReferenceStandardRecord[]>([]);
  const [source, setSource] = useState<DataSource>("mock");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let active = true;
    loadReferenceStandardsWithFallback({ sort: "code" }).then((result) => {
      if (!active) {
        return;
      }
      setStandards(result.items);
      setSource(result.source);
    });
    return () => {
      active = false;
    };
  }, []);

  const visibleStandards = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return standards;
    }
    return standards.filter((standard) =>
      [standard.code, standard.name]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(normalized))
    );
  }, [standards, query]);

  return {
    query,
    setQuery,
    source,
    standards,
    visibleStandards
  };
}
