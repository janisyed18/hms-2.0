import { useEffect, useMemo, useState } from "react";

import {
  createHmsClient,
  loadReferenceStandardsWithFallback
} from "../api/hmsClient";
import type {
  DataSource,
  ReferenceStandardFormValues,
  ReferenceStandardRecord
} from "../domain/types";

function localStandard(
  values: ReferenceStandardFormValues,
  current?: ReferenceStandardRecord | null
): ReferenceStandardRecord {
  return {
    id: current?.id ?? `standard-${Date.now()}`,
    code: values.code.trim().toUpperCase(),
    name: values.name.trim(),
    etag: current?.etag ?? null
  };
}

export function useReferenceWorkspace() {
  const [standards, setStandards] = useState<ReferenceStandardRecord[]>([]);
  const [source, setSource] = useState<DataSource>("mock");
  const [query, setQuery] = useState("");
  const [editingStandard, setEditingStandard] =
    useState<ReferenceStandardRecord | null>(null);
  const [isFormOpen, setFormOpen] = useState(false);

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

  function openCreate() {
    setEditingStandard(null);
    setFormOpen(true);
  }

  function openEdit(standard: ReferenceStandardRecord) {
    setEditingStandard(standard);
    setFormOpen(true);
  }

  async function saveStandard(values: ReferenceStandardFormValues) {
    let saved = localStandard(values, editingStandard);
    if (source === "api") {
      try {
        const client = createHmsClient();
        saved = editingStandard
          ? await client.updateReferenceStandard(
              editingStandard.id,
              values,
              editingStandard.etag
            )
          : await client.createReferenceStandard(values);
      } catch {
        saved = localStandard(values, editingStandard);
      }
    }

    setStandards((current) => {
      if (editingStandard) {
        return current.map((standard) =>
          standard.id === editingStandard.id ? saved : standard
        );
      }
      return [saved, ...current];
    });
    setFormOpen(false);
    setEditingStandard(null);
  }

  async function archiveStandard(standard: ReferenceStandardRecord) {
    if (!window.confirm(`Archive ${standard.name}?`)) {
      return;
    }
    if (source === "api") {
      await createHmsClient().archiveReferenceStandard(standard.id, standard.etag);
    }
    setStandards((current) =>
      current.filter((item) => item.id !== standard.id)
    );
  }

  return {
    archiveStandard,
    editingStandard,
    isFormOpen,
    openCreate,
    openEdit,
    query,
    saveStandard,
    setFormOpen,
    setQuery,
    source,
    standards,
    visibleStandards
  };
}
