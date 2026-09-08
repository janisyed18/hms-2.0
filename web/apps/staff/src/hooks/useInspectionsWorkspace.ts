import { useEffect, useMemo, useState } from "react";

import { createHmsClient } from "../api/hmsClient";
import type { AssetRecord, InspectionBookingCreateValues, InspectionBookingRecord, InspectionCreateValues, InspectionRecord, InspectionStatus, InspectionType, InspectionUpdateValues } from "../domain/types";

export type InspectionStatusFilter = "ALL" | InspectionStatus;
export type InspectionTypeFilter = "ALL" | InspectionType;

export function useInspectionsWorkspace(initialInspectionId?: string | null, onInitialInspectionOpened?: () => void) {
  const [inspections, setInspections] = useState<InspectionRecord[]>([]);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [bookings, setBookings] = useState<InspectionBookingRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<InspectionStatusFilter>("ALL");
  const [typeFilter, setTypeFilter] = useState<InspectionTypeFilter>("ALL");
  const [resultFilter, setResultFilter] = useState("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isFormOpen, setFormOpen] = useState(false);
  const [isBookingFormOpen, setBookingFormOpen] = useState(false);

  useEffect(() => {
    let active = true;
    const client = createHmsClient();
    setIsLoading(true); setError(null);
    void Promise.all([client.listInspections({ sort: "-created_at" }), client.listAssets({ sort: "asset_number" }), client.listInspectionBookings()])
      .then(([inspectionResult, assetResult, bookingResult]) => {
        if (!active) return;
        setInspections(inspectionResult.items); setAssets(assetResult.items); setBookings(bookingResult.items);
      })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Inspection records could not be loaded."); })
      .finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, []);

  const visibleInspections = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return inspections.filter((inspection) => (
      (statusFilter === "ALL" || inspection.status === statusFilter) &&
      (typeFilter === "ALL" || inspection.inspectionType === typeFilter) &&
      (resultFilter === "ALL" || (inspection.result ?? "PENDING") === resultFilter) &&
      (!normalized || [inspection.asset.assetNumber, inspection.asset.tag, inspection.customer.code, inspection.customer.name, inspection.product.code, inspection.product.name, inspection.inspectionType, inspection.status, inspection.result].filter(Boolean).some((value) => value?.toLowerCase().includes(normalized)))
    ));
  }, [inspections, query, resultFilter, statusFilter, typeFilter]);
  const resultOptions = useMemo(() => Array.from(new Set(inspections.map((inspection) => inspection.result ?? "PENDING"))).sort(), [inspections]);
  const selectedInspection = useMemo(() => inspections.find((inspection) => inspection.id === selectedId) ?? null, [inspections, selectedId]);

  useEffect(() => {
    if (!initialInspectionId || !inspections.some((inspection) => inspection.id === initialInspectionId)) return;
    setSelectedId(initialInspectionId); onInitialInspectionOpened?.();
  }, [initialInspectionId, inspections, onInitialInspectionOpened]);

  function openCreate() { setFormOpen(true); }
  function openBooking() { setBookingFormOpen(true); }
  function openDetail(inspection: InspectionRecord) { setSelectedId(inspection.id); }
  function closeDetail() { setSelectedId(null); }
  function replaceInspection(updated: InspectionRecord) { setInspections((current) => current.map((inspection) => inspection.id === updated.id ? updated : inspection)); setSelectedId(updated.id); }
  async function saveInspection(values: InspectionCreateValues) {
    const saved = await createHmsClient().createInspection(values);
    setInspections((current) => [saved, ...current]); setSelectedId(saved.id); setFormOpen(false); setQuery(""); setStatusFilter("ALL"); setTypeFilter("ALL"); setResultFilter("ALL");
  }
  async function saveInspectionBooking(values: InspectionBookingCreateValues) {
    const saved = await createHmsClient().createInspectionBooking(values);
    setBookings((current) => [saved, ...current]);
    setBookingFormOpen(false);
  }
  async function approveInspectionBooking(id: string) {
    const saved = await createHmsClient().approveInspectionBooking(id);
    setBookings((current) => current.map((booking) => booking.id === saved.id ? saved : booking));
    const inspections = await createHmsClient().listInspections({ sort: "-created_at" });
    setInspections(inspections.items);
  }
  async function rejectInspectionBooking(id: string) {
    const saved = await createHmsClient().rejectInspectionBooking(id);
    setBookings((current) => current.map((booking) => booking.id === saved.id ? saved : booking));
  }
  async function saveInspectionUpdate(values: InspectionUpdateValues) {
    if (selectedInspection) replaceInspection(await createHmsClient().updateInspection(selectedInspection.id, values));
  }
  async function submitInspection(values?: InspectionUpdateValues) {
    if (!selectedInspection) return;
    const client = createHmsClient();
    if (values) await client.updateInspection(selectedInspection.id, values);
    replaceInspection(await client.submitInspection(selectedInspection.id));
  }
  async function approveInspection() {
    if (selectedInspection) replaceInspection(await createHmsClient().approveInspection(selectedInspection.id));
  }
  function clearInspectionFilters() { setTypeFilter("ALL"); setResultFilter("ALL"); }
  const activeFilterCount = [typeFilter !== "ALL", resultFilter !== "ALL"].filter(Boolean).length;
  return { activeFilterCount, approveInspection, approveInspectionBooking, assetOptions: assets, bookings, clearInspectionFilters, closeDetail, error, inspections, isBookingFormOpen, isFormOpen, isLoading, openBooking, openCreate, openDetail, query, rejectInspectionBooking, resultFilter, resultOptions, saveInspection, saveInspectionBooking, saveInspectionUpdate, selectedInspection, setBookingFormOpen, setFormOpen, setQuery, setResultFilter, setStatusFilter, setTypeFilter, statusFilter, submitInspection, typeFilter, visibleInspections };
}
