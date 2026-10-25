import { useCallback, useEffect, useMemo, useState } from "react";

import { createHmsClient } from "../api/hmsClient";
import { useActionNotice } from "../components/interaction/ActionNotice";
import { friendlyApiError } from "../components/interaction/friendlyApiError";
import { useActionRunner } from "../components/interaction/useActionRunner";
import { useConfirmedAction } from "../components/interaction/useConfirmedAction";
import { assetLabel } from "../utils/identity";
import type { AdminUserRecord, AssetRecord, InspectionBookingCreateValues, InspectionBookingRecord, InspectionCreateValues, InspectionRecord, InspectionStatus, InspectionType, InspectionUpdateValues } from "../domain/types";

export type InspectionStatusFilter = "ALL" | InspectionStatus;
export type InspectionTypeFilter = "ALL" | InspectionType;

export function useInspectionsWorkspace(
  canApproveBookings: boolean,
  initialInspectionId?: string | null,
  onInitialInspectionOpened?: () => void
) {
  const [inspections, setInspections] = useState<InspectionRecord[]>([]);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [bookings, setBookings] = useState<InspectionBookingRecord[]>([]);
  const [inspectors, setInspectors] = useState<AdminUserRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<InspectionStatusFilter>("ALL");
  const [typeFilter, setTypeFilter] = useState<InspectionTypeFilter>("ALL");
  const [resultFilter, setResultFilter] = useState("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isFormOpen, setFormOpen] = useState(false);
  const [isBookingFormOpen, setBookingFormOpen] = useState(false);
  const [rescheduleBooking, setRescheduleBooking] = useState<InspectionBookingRecord | null>(null);
  const { notice, notify, clear: dismissNotice } = useActionNotice();
  const { pending: pendingAction, run } = useActionRunner(notify);

  useEffect(() => {
    let active = true;
    const client = createHmsClient();
    setIsLoading(true); setError(null);
    void Promise.all([
      client.listInspections({ sort: "-created_at" }),
      client.listAllAssets({ sort: "asset_number" }),
      client.listInspectionBookings()
    ])
      .then(async ([inspectionResult, assetResult, bookingResult]) => {
        const userResult = canApproveBookings
          && bookingResult.items.some((booking) => booking.status === "PENDING_APPROVAL" || booking.changeRequests.some((change) => change.status === "PENDING_ADMIN_APPROVAL"))
            ? await client.listAdminUsers({ sort: "email", limit: 100 })
            : { items: [] as AdminUserRecord[] };
        if (!active) return;
        setInspections(inspectionResult.items); setAssets(assetResult.items); setBookings(bookingResult.items);
        setInspectors(userResult.items.filter((user) => user.role === "INSPECTOR" && user.accountStatus === "ACTIVE"));
      })
      .catch((reason: unknown) => { if (active) setError(friendlyApiError(reason, { fallback: "Inspection records could not be loaded." }).message); })
      .finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, [canApproveBookings]);

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
  async function openBooking() {
    if (canApproveBookings && inspectors.length === 0) {
      try {
        const users = await createHmsClient().listAdminUsers({ sort: "email", limit: 100 });
        setInspectors(users.items.filter((user) => user.role === "INSPECTOR" && user.accountStatus === "ACTIVE"));
      } catch (reason) {
        setError(friendlyApiError(reason, { fallback: "Inspectors could not be loaded." }).message);
        return;
      }
    }
    setRescheduleBooking(null); setBookingFormOpen(true);
  }
  function openReschedule(booking: InspectionBookingRecord) { setRescheduleBooking(booking); setBookingFormOpen(true); }
  function openDetail(inspection: InspectionRecord) { setSelectedId(inspection.id); }
  function closeDetail() { setSelectedId(null); }
  function replaceInspection(updated: InspectionRecord) { setInspections((current) => current.map((inspection) => inspection.id === updated.id ? updated : inspection)); setSelectedId(updated.id); }
  /** After a conflict the screen may be out of date: reload what the actions change. */
  const refreshBookingsAndInspections = useCallback(async () => {
    try {
      const client = createHmsClient();
      const [bookingResult, inspectionResult] = await Promise.all([client.listInspectionBookings(), client.listInspections({ sort: "-created_at" })]);
      setBookings(bookingResult.items);
      setInspections(inspectionResult.items);
    } catch {
      // The failure notice already explains the action; a failed refresh keeps what is on screen.
    }
  }, []);
  async function saveInspection(values: InspectionCreateValues) {
    const saved = await createHmsClient().createInspection(values);
    setInspections((current) => [saved, ...current]); setSelectedId(saved.id); setFormOpen(false); setQuery(""); setStatusFilter("ALL"); setTypeFilter("ALL"); setResultFilter("ALL");
    notify({ kind: "success", title: "Inspection created", message: `Inspection for ${assetLabel(saved.asset)} created successfully.` });
  }
  async function saveInspectionBooking(values: InspectionBookingCreateValues) {
    const saved = await createHmsClient().createInspectionBooking(values);
    setBookings((current) => [saved, ...current]);
    setBookingFormOpen(false);
    notify({ kind: "success", title: "Booking requested", message: `Booking at ${saved.location.name} requested successfully.` });
  }
  async function requestInspectionBookingReschedule(id: string, values: { availabilityQuoteId: string; reason: string | null; inspectorUserId: string | null }) {
    const client = createHmsClient();
    const change = await client.requestInspectionBookingReschedule(id, values);
    setBookings((current) => current.map((booking) => booking.id === id ? {
      ...booking,
      changeRequests: [...booking.changeRequests.filter((item) => item.id !== change.id), change]
    } : booking));
    setBookingFormOpen(false); setRescheduleBooking(null);
    notify({ kind: "success", title: "Reschedule requested", message: "The reschedule request was sent." });
  }
  const bookingFailure = (title: string) => ({ conflictNeedsRefresh: true, failureTitle: title, onError: () => void refreshBookingsAndInspections() });
  async function reloadBookingOf(changeId: string) {
    const client = createHmsClient();
    const changeBooking = bookings.find((booking) => booking.changeRequests.some((change) => change.id === changeId));
    if (!changeBooking) return;
    const saved = await client.getInspectionBooking(changeBooking.id);
    setBookings((current) => current.map((booking) => booking.id === saved.id ? saved : booking));
  }
  function confirmInspectionBookingReschedule(id: string) {
    return run(`confirm:${id}`, async () => {
      await createHmsClient().confirmInspectionBookingReschedule(id);
      await reloadBookingOf(id);
    }, { ...bookingFailure("Reschedule could not be confirmed"), fallback: "The reschedule could not be confirmed. Try again.", success: () => ({ title: "Reschedule confirmed", message: "The new time is confirmed." }) });
  }
  function approveInspectionBookingReschedule(id: string, inspectorUserId: string) {
    return run(`approve-change:${id}`, async () => {
      await createHmsClient().approveInspectionBookingReschedule(id, inspectorUserId);
      await reloadBookingOf(id);
    }, { ...bookingFailure("Reschedule could not be approved"), fallback: "The reschedule could not be approved. Try again.", success: () => ({ title: "Reschedule approved", message: "The reschedule was approved and sent to the customer to confirm." }) });
  }
  function approveInspectionBooking(id: string, inspectorUserId: string) {
    const booking = bookings.find((item) => item.id === id);
    return run(`approve:${id}`, async () => {
      const saved = await createHmsClient().approveInspectionBooking(id, inspectorUserId);
      setBookings((current) => current.map((item) => item.id === saved.id ? saved : item));
      const refreshed = await createHmsClient().listInspections({ sort: "-created_at" });
      setInspections(refreshed.items);
    }, { ...bookingFailure("Booking could not be approved"), fallback: "The booking could not be approved. Try again.", success: () => ({ title: "Booking approved", message: `Booking at ${booking?.location.name ?? "the site"} approved and an inspector assigned.` }) });
  }
  const bookingDecision = useConfirmedAction<{ action: "reject" | "cancel"; booking: InspectionBookingRecord }>(
    async ({ action, booking }) => {
      const client = createHmsClient();
      const saved = action === "reject" ? await client.rejectInspectionBooking(booking.id) : await client.cancelInspectionBooking(booking.id);
      setBookings((current) => current.map((item) => item.id === saved.id ? saved : item));
      notify({ kind: "success", title: action === "reject" ? "Booking declined" : "Booking cancelled", message: `Booking at ${booking.location.name} was ${action === "reject" ? "declined" : "cancelled"}.` });
    },
    ({ action, booking }) => ({ conflictNeedsRefresh: true, fallback: `The booking at ${booking.location.name} could not be ${action === "reject" ? "declined" : "cancelled"}. Try again.` })
  );
  async function saveInspectionUpdate(values: InspectionUpdateValues) {
    if (!selectedInspection) return;
    const saved = await createHmsClient().updateInspection(selectedInspection.id, values);
    replaceInspection(saved);
    notify({ kind: "success", title: "Draft saved", message: `Inspection for ${assetLabel(saved.asset)} saved successfully.` });
  }
  async function submitInspection(values?: InspectionUpdateValues) {
    if (!selectedInspection) return;
    const client = createHmsClient();
    if (values) await client.updateInspection(selectedInspection.id, values);
    const saved = await client.submitInspection(selectedInspection.id);
    replaceInspection(saved);
    notify({ kind: "success", title: "Inspection submitted", message: `Inspection for ${assetLabel(saved.asset)} submitted for review.` });
  }
  async function approveInspection() {
    if (!selectedInspection) return;
    const saved = await createHmsClient().approveInspection(selectedInspection.id);
    replaceInspection(saved);
    notify({ kind: "success", title: "Inspection approved", message: `Inspection for ${assetLabel(saved.asset)} approved.` });
  }
  function clearInspectionFilters() { setTypeFilter("ALL"); setResultFilter("ALL"); }
  const activeFilterCount = [typeFilter !== "ALL", resultFilter !== "ALL"].filter(Boolean).length;
  return { activeFilterCount, approveInspection, approveInspectionBooking, approveInspectionBookingReschedule, assetOptions: assets, bookingDecision, bookings, dismissNotice, notice, pendingAction, refreshBookingsAndInspections, clearInspectionFilters, closeDetail, confirmInspectionBookingReschedule, error, inspectors, inspections, isBookingFormOpen, isFormOpen, isLoading, openBooking, openCreate, openDetail, openReschedule, query, requestInspectionBookingReschedule, rescheduleBooking, resultFilter, resultOptions, saveInspection, saveInspectionBooking, saveInspectionUpdate, selectedInspection, setBookingFormOpen, setFormOpen, setQuery, setResultFilter, setStatusFilter, setTypeFilter, statusFilter, submitInspection, typeFilter, visibleInspections };
}
