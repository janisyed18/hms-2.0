import { useEffect, useMemo, useState } from "react";

import {
  createHmsClient,
  loadAssetsWithFallback,
  loadInspectionsWithFallback
} from "../api/hmsClient";
import type {
  AssetRecord,
  DataSource,
  InspectionCreateValues,
  InspectionRecord,
  InspectionStatus,
  InspectionType,
  InspectionUpdateValues,
  PressureTestValues
} from "../domain/types";

export type InspectionStatusFilter = "ALL" | InspectionStatus;
export type InspectionTypeFilter = "ALL" | InspectionType;

function localPressureTest(
  values: PressureTestValues | null,
  current?: InspectionRecord | null
): InspectionRecord["pressureTest"] {
  if (values === null) {
    return null;
  }
  return {
    id: current?.pressureTest?.id ?? `pressure-${Date.now()}`,
    appliedPressureKpa: values.appliedPressureKpa,
    holdTimeSeconds: values.holdTimeSeconds,
    passed: values.passed,
    measurements: values.measurements
  };
}

function localInspection(
  values: InspectionCreateValues,
  assets: AssetRecord[],
  current?: InspectionRecord | null
): InspectionRecord {
  const asset =
    assets.find((item) => item.id === values.assetId) ??
    assets[0] ??
    null;
  const assetSummary = asset
    ? {
        id: asset.id,
        assetNumber: asset.assetNumber,
        tag: asset.tag,
        lifecycleStatus: asset.lifecycleStatus
      }
    : current?.asset;
  const customer = asset?.customer ?? current?.customer;
  const product = asset?.product ?? current?.product;

  if (!assetSummary || !customer || !product) {
    throw new Error("Inspection requires an asset, customer, and product");
  }

  return {
    id: current?.id ?? `inspection-${Date.now()}`,
    assetId: values.assetId,
    inspectionType: values.inspectionType,
    status: current?.status ?? "DRAFT",
    result: values.result,
    inspectorUserId: current?.inspectorUserId ?? "staff-ui-dev",
    reviewerUserId: current?.reviewerUserId ?? null,
    submittedAt: current?.submittedAt ?? null,
    approvedAt: current?.approvedAt ?? null,
    rejectedAt: current?.rejectedAt ?? null,
    asset: assetSummary,
    customer,
    product,
    pressureTest: localPressureTest(values.pressureTest, current),
    etag: current?.etag ?? null
  };
}

function localInspectionUpdate(
  inspection: InspectionRecord,
  values: InspectionUpdateValues
): InspectionRecord {
  return {
    ...inspection,
    result: values.result,
    pressureTest: localPressureTest(values.pressureTest, inspection)
  };
}

export function useInspectionsWorkspace() {
  const [inspections, setInspections] = useState<InspectionRecord[]>([]);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [source, setSource] = useState<DataSource>("mock");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] =
    useState<InspectionStatusFilter>("ALL");
  const [typeFilter, setTypeFilter] = useState<InspectionTypeFilter>("ALL");
  const [resultFilter, setResultFilter] = useState("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isFormOpen, setFormOpen] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([
      loadInspectionsWithFallback({ sort: "-created_at" }),
      loadAssetsWithFallback({ sort: "asset_number" })
    ]).then(([inspectionResult, assetResult]) => {
      if (!active) {
        return;
      }
      setInspections(inspectionResult.items);
      setAssets(assetResult.items);
      setSource(inspectionResult.source);
    });
    return () => {
      active = false;
    };
  }, []);

  const visibleInspections = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return inspections.filter((inspection) => {
      const matchesStatus =
        statusFilter === "ALL" || inspection.status === statusFilter;
      const matchesType =
        typeFilter === "ALL" || inspection.inspectionType === typeFilter;
      const matchesResult =
        resultFilter === "ALL" || (inspection.result ?? "PENDING") === resultFilter;
      const matchesSearch =
        !normalized ||
        [
          inspection.asset.assetNumber,
          inspection.asset.tag,
          inspection.customer.code,
          inspection.customer.name,
          inspection.product.code,
          inspection.product.name,
          inspection.inspectionType,
          inspection.status,
          inspection.result
        ]
          .filter(Boolean)
          .some((value) => value?.toLowerCase().includes(normalized));
      return matchesStatus && matchesType && matchesResult && matchesSearch;
    });
  }, [inspections, query, resultFilter, statusFilter, typeFilter]);

  const resultOptions = useMemo(
    () =>
      Array.from(
        new Set(inspections.map((inspection) => inspection.result ?? "PENDING"))
      ).sort(),
    [inspections]
  );

  const selectedInspection = useMemo(
    () => inspections.find((inspection) => inspection.id === selectedId) ?? null,
    [inspections, selectedId]
  );

  function openCreate() {
    setFormOpen(true);
  }

  function openDetail(inspection: InspectionRecord) {
    setSelectedId(inspection.id);
  }

  function closeDetail() {
    setSelectedId(null);
  }

  function replaceInspection(updated: InspectionRecord) {
    setInspections((current) =>
      current.map((inspection) =>
        inspection.id === updated.id ? updated : inspection
      )
    );
    setSelectedId(updated.id);
  }

  async function saveInspection(values: InspectionCreateValues) {
    let saved = localInspection(values, assets);
    if (source === "api") {
      try {
        saved = await createHmsClient().createInspection(values);
      } catch {
        saved = localInspection(values, assets);
      }
    }
    setInspections((current) => [saved, ...current]);
    setSelectedId(saved.id);
    setFormOpen(false);
    setQuery("");
    setStatusFilter("ALL");
    setTypeFilter("ALL");
    setResultFilter("ALL");
  }

  async function saveInspectionUpdate(values: InspectionUpdateValues) {
    if (!selectedInspection) {
      return;
    }
    let saved = localInspectionUpdate(selectedInspection, values);
    if (source === "api") {
      try {
        saved = await createHmsClient().updateInspection(
          selectedInspection.id,
          values
        );
      } catch {
        saved = localInspectionUpdate(selectedInspection, values);
      }
    }
    replaceInspection(saved);
  }

  async function submitInspection() {
    if (!selectedInspection) {
      return;
    }
    let saved: InspectionRecord = {
      ...selectedInspection,
      status: "SUBMITTED",
      submittedAt: new Date().toISOString()
    };
    if (source === "api") {
      try {
        saved = await createHmsClient().submitInspection(selectedInspection.id);
      } catch {
        saved = {
          ...selectedInspection,
          status: "SUBMITTED",
          submittedAt: new Date().toISOString()
        };
      }
    }
    replaceInspection(saved);
  }

  async function approveInspection() {
    if (!selectedInspection) {
      return;
    }
    let saved: InspectionRecord = {
      ...selectedInspection,
      status: "APPROVED",
      reviewerUserId: "staff-ui-dev",
      approvedAt: new Date().toISOString()
    };
    if (source === "api") {
      try {
        saved = await createHmsClient().approveInspection(selectedInspection.id);
      } catch {
        saved = {
          ...selectedInspection,
          status: "APPROVED",
          reviewerUserId: "staff-ui-dev",
          approvedAt: new Date().toISOString()
        };
      }
    }
    replaceInspection(saved);
  }

  function clearInspectionFilters() {
    setTypeFilter("ALL");
    setResultFilter("ALL");
  }

  const activeFilterCount = [
    typeFilter !== "ALL",
    resultFilter !== "ALL"
  ].filter(Boolean).length;

  return {
    activeFilterCount,
    approveInspection,
    assetOptions: assets,
    clearInspectionFilters,
    closeDetail,
    inspections,
    isFormOpen,
    openCreate,
    openDetail,
    query,
    resultFilter,
    resultOptions,
    saveInspection,
    saveInspectionUpdate,
    selectedInspection,
    setFormOpen,
    setQuery,
    setResultFilter,
    setStatusFilter,
    setTypeFilter,
    source,
    statusFilter,
    submitInspection,
    typeFilter,
    visibleInspections
  };
}
