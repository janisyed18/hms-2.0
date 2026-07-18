import { useEffect, useMemo, useState } from "react";

import {
  createHmsClient,
  loadReferenceStandardsWithFallback
} from "../api/hmsClient";
import type {
  DataSource,
  ReferenceCatalogFormValues,
  ReferenceCatalogKey,
  ReferenceCatalogRecord
} from "../domain/types";

export const referenceCatalogMeta: Record<
  ReferenceCatalogKey,
  { description: string; plural: string; singular: string }
> = {
  standards: {
    singular: "Standard",
    plural: "Standards",
    description: "Pressure and hose standards used by the product catalogue."
  },
  materials: {
    singular: "Material",
    plural: "Materials",
    description: "Hose construction materials available on asset end configurations."
  },
  couplings: {
    singular: "Coupling",
    plural: "Couplings",
    description: "End fittings available for hose assembly configurations."
  },
  "coupling-add-ons": {
    singular: "Add-on",
    plural: "Add-ons",
    description: "Optional fittings and accessories applied to an end configuration."
  },
  "attach-methods": {
    singular: "Attachment Method",
    plural: "Attachment Methods",
    description: "Approved methods used to secure a hose end fitting."
  },
  "nominal-bores": {
    singular: "Nominal Bore",
    plural: "Nominal Bores",
    description: "Controlled bore sizes used by products and hose assemblies."
  }
};

function emptyCatalogs(): Record<ReferenceCatalogKey, ReferenceCatalogRecord[]> {
  return {
    standards: [],
    materials: [],
    couplings: [],
    "coupling-add-ons": [],
    "attach-methods": [],
    "nominal-bores": []
  };
}

export function useReferenceWorkspace() {
  const [activeCategory, setActiveCategory] =
    useState<ReferenceCatalogKey>("standards");
  const [catalogs, setCatalogs] = useState(emptyCatalogs);
  const [query, setQuery] = useState("");
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeSource, setActiveSource] = useState<DataSource>("api");
  const [editingRecord, setEditingRecord] =
    useState<ReferenceCatalogRecord | null>(null);
  const [isFormOpen, setFormOpen] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const loadCatalog =
      activeCategory === "standards"
        ? loadReferenceStandardsWithFallback().then((result) => ({
            items: result.items,
            source: result.source
          }))
        : createHmsClient()
            .listReferenceCatalog(activeCategory)
            .then((result) => ({ items: result.items, source: "api" as const }));

    loadCatalog
      .then((result) => {
        if (!active) return;
        setCatalogs((current) => ({ ...current, [activeCategory]: result.items }));
        setActiveSource(result.source);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "Unable to load catalog data.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activeCategory]);

  const activeMeta = referenceCatalogMeta[activeCategory];
  const records = catalogs[activeCategory];
  const visibleRecords = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return records;
    return records.filter((record) =>
      [record.code, record.name].some((value) => value.toLowerCase().includes(normalized))
    );
  }, [query, records]);

  function selectCategory(category: ReferenceCatalogKey) {
    setActiveCategory(category);
    setQuery("");
    setEditingRecord(null);
    setFormOpen(false);
  }

  function openCreate() {
    setEditingRecord(null);
    setFormOpen(true);
  }

  function openEdit(record: ReferenceCatalogRecord) {
    setEditingRecord(record);
    setFormOpen(true);
  }

  async function saveRecord(values: ReferenceCatalogFormValues) {
    const saved =
      activeSource === "mock"
        ? {
            id: editingRecord?.id ?? `reference-${Date.now()}`,
            code: values.code.trim().toUpperCase(),
            name: values.name.trim(),
            etag: editingRecord?.etag ?? null
          }
        : await (async () => {
            const client = createHmsClient();
            return editingRecord
              ? client.updateReferenceCatalogItem(
                  activeCategory,
                  editingRecord.id,
                  values,
                  editingRecord.etag
                )
              : client.createReferenceCatalogItem(activeCategory, values);
          })();

    setCatalogs((current) => ({
      ...current,
      [activeCategory]: editingRecord
        ? current[activeCategory].map((record) =>
            record.id === editingRecord.id ? saved : record
          )
        : [saved, ...current[activeCategory]]
    }));
    setEditingRecord(null);
    setFormOpen(false);
  }

  async function archiveRecord(record: ReferenceCatalogRecord) {
    if (!window.confirm(`Archive ${record.name}?`)) return;
    if (activeSource === "api") {
      await createHmsClient().archiveReferenceCatalogItem(
        activeCategory,
        record.id,
        record.etag
      );
    }
    setCatalogs((current) => ({
      ...current,
      [activeCategory]: current[activeCategory].filter((item) => item.id !== record.id)
    }));
  }

  return {
    activeCategory,
    activeMeta,
    archiveRecord,
    editingRecord,
    error,
    isFormOpen,
    isLoading,
    openCreate,
    openEdit,
    query,
    saveRecord,
    selectCategory,
    setFormOpen,
    setQuery,
    visibleRecords
  };
}
