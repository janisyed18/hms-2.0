import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { HmsApiError, createHmsClient } from "../api/hmsClient";
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
  /** The inspection the URL names; the URL is the record of which one is open. */
  routeInspectionId?: string | null,
  onInspectionRouteChange?: (inspectionId: string | null, options?: { replace?: boolean }) => void
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

  // Each direction reacts only to its own side changing, so the URL and the screen cannot chase each other.
  const live = useRef({ routeInspectionId, selectedId, onInspectionRouteChange, notify });
  useEffect(() => {
    live.current = { routeInspectionId, selectedId, onInspectionRouteChange, notify };
  });
  const previousSelected = useRef(selectedId);

  // URL to screen: a link, or Back/Forward, opens or closes the detail. The list holds one page, so an
  // inspection that is not in it is asked for by id: only if that read fails (missing, or not theirs) is
  // it "unavailable". What comes back is used only if the URL still asks for it.
  const fetching = useRef<string | null>(null);
  const previousRoute = useRef(routeInspectionId);
  useEffect(() => {
    // The list changing (an inspection was just created) is not the URL changing: only a URL that has
    // moved to "nothing open" closes the detail, or a newly selected inspection would be closed before
    // the address catches up with it, and the two would chase each other.
    const routeChanged = previousRoute.current !== routeInspectionId;
    previousRoute.current = routeInspectionId;
    if (isLoading) return;
    const open = live.current.selectedId;
    if (routeInspectionId && routeInspectionId !== open) {
      if (inspections.some((inspection) => inspection.id === routeInspectionId)) {
        setSelectedId(routeInspectionId);
      } else if (fetching.current !== routeInspectionId) {
        fetching.current = routeInspectionId;
        createHmsClient().getInspection(routeInspectionId)
          .then((found) => {
            if (live.current.routeInspectionId !== routeInspectionId) return;
            setInspections((current) => (current.some((inspection) => inspection.id === found.id) ? current : [found, ...current]));
            setSelectedId(found.id);
          })
          .catch(() => {
            if (live.current.routeInspectionId !== routeInspectionId) return;
            live.current.notify({ kind: "error", title: "Inspection unavailable", message: "That inspection could not be found, or you do not have access to it." });
            live.current.onInspectionRouteChange?.(null, { replace: true });
          })
          .finally(() => {
            if (fetching.current === routeInspectionId) fetching.current = null;
          });
      }
    } else if (!routeInspectionId && open && routeChanged) {
      setSelectedId(null);
    }
  }, [routeInspectionId, isLoading, inspections]);

  // Screen to URL: opening or closing the detail by hand updates the address.
  useEffect(() => {
    if (previousSelected.current === selectedId) return;
    previousSelected.current = selectedId;
    if (selectedId !== live.current.routeInspectionId) live.current.onInspectionRouteChange?.(selectedId);
  }, [selectedId]);

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
  /**
   * The mutation is what the user asked for; reloading afterwards is secondary. A reload that fails
   * after a successful mutation is reported as a refresh problem, never as a failed action.
   */
  const REFRESH_WARNING = "but the latest view could not be refreshed. Reload to see the current state.";
  async function tryRefresh(refresh: () => Promise<void>): Promise<boolean> {
    try { await refresh(); return false; } catch { return true; }
  }
  const outcome = (title: string, done: string) => (refreshFailed: boolean) =>
    refreshFailed ? { kind: "warning" as const, title, message: `${done}, ${REFRESH_WARNING}` } : { title, message: `${done}.` };
  function confirmInspectionBookingReschedule(id: string) {
    return run(`confirm:${id}`, async () => {
      await createHmsClient().confirmInspectionBookingReschedule(id);
      return tryRefresh(() => reloadBookingOf(id));
    }, { ...bookingFailure("Reschedule could not be confirmed"), fallback: "The reschedule could not be confirmed. Try again.", success: outcome("Reschedule confirmed", "The new time is confirmed") });
  }
  function approveInspectionBookingReschedule(id: string, inspectorUserId: string) {
    return run(`approve-change:${id}`, async () => {
      await createHmsClient().approveInspectionBookingReschedule(id, inspectorUserId);
      return tryRefresh(() => reloadBookingOf(id));
    }, { ...bookingFailure("Reschedule could not be approved"), fallback: "The reschedule could not be approved. Try again.", success: outcome("Reschedule approved", "The reschedule was approved and sent to the customer to confirm") });
  }
  function approveInspectionBooking(id: string, inspectorUserId: string) {
    const booking = bookings.find((item) => item.id === id);
    return run(`approve:${id}`, async () => {
      // The approval returns the updated booking, so it is applied at once; the inspection list is secondary.
      const saved = await createHmsClient().approveInspectionBooking(id, inspectorUserId);
      setBookings((current) => current.map((item) => item.id === saved.id ? saved : item));
      return tryRefresh(async () => {
        const refreshed = await createHmsClient().listInspections({ sort: "-created_at" });
        setInspections(refreshed.items);
      });
    }, { ...bookingFailure("Booking could not be approved"), fallback: "The booking could not be approved. Try again.", success: outcome("Booking approved", `Booking at ${booking?.location.name ?? "the site"} approved and an inspector assigned`) });
  }
  // Declining and cancelling are not availability actions: a 409 is an ordinary state conflict and is
  // shown as stated. The booking is reloaded separately, so a failed reload never changes that message.
  const bookingDecision = useConfirmedAction<{ action: "reject" | "cancel"; booking: InspectionBookingRecord }>(
    async ({ action, booking }) => {
      const client = createHmsClient();
      let saved: InspectionBookingRecord;
      try {
        saved = action === "reject" ? await client.rejectInspectionBooking(booking.id) : await client.cancelInspectionBooking(booking.id);
      } catch (reason) {
        if (reason instanceof HmsApiError && [404, 409, 412].includes(reason.status)) void refreshBookingsAndInspections();
        throw reason;
      }
      setBookings((current) => current.map((item) => item.id === saved.id ? saved : item));
      notify({ kind: "success", title: action === "reject" ? "Booking declined" : "Booking cancelled", message: `Booking at ${booking.location.name} was ${action === "reject" ? "declined" : "cancelled"}.` });
    },
    ({ action, booking }) => ({ fallback: `The booking at ${booking.location.name} could not be ${action === "reject" ? "declined" : "cancelled"}. Try again.` })
  );
  async function saveInspectionUpdate(values: InspectionUpdateValues) {
    if (!selectedInspection) return;
    const saved = await createHmsClient().updateInspection(selectedInspection.id, values);
    replaceInspection(saved);
    notify({ kind: "success", title: "Draft saved", message: `Inspection for ${assetLabel(saved.asset)} saved successfully.` });
  }
  async function startInspection() {
    if (!selectedInspection) return;
    const saved = await createHmsClient().startInspection(selectedInspection.id);
    replaceInspection(saved);
    notify({ kind: "success", title: "Inspection started", message: `Inspection for ${assetLabel(saved.asset)} is in progress.` });
  }
  async function beginInspectionRework() {
    if (!selectedInspection) return;
    const saved = await createHmsClient().beginInspectionRework(selectedInspection.id);
    replaceInspection(saved);
    notify({ kind: "success", title: "Rework started", message: `Inspection for ${assetLabel(saved.asset)} can be edited again.` });
  }
  async function rejectInspection(reason: string) {
    if (!selectedInspection) return;
    const saved = await createHmsClient().rejectInspection(selectedInspection.id, reason);
    replaceInspection(saved);
    notify({ kind: "success", title: "Changes requested", message: `Inspection for ${assetLabel(saved.asset)} was sent back to the inspector.` });
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
  return { activeFilterCount, approveInspection, beginInspectionRework, rejectInspection, startInspection, approveInspectionBooking, approveInspectionBookingReschedule, assetOptions: assets, bookingDecision, bookings, dismissNotice, notice, pendingAction, refreshBookingsAndInspections, clearInspectionFilters, closeDetail, confirmInspectionBookingReschedule, error, inspectors, inspections, isBookingFormOpen, isFormOpen, isLoading, openBooking, openCreate, openDetail, openReschedule, query, requestInspectionBookingReschedule, rescheduleBooking, resultFilter, resultOptions, saveInspection, saveInspectionBooking, saveInspectionUpdate, selectedInspection, setBookingFormOpen, setFormOpen, setQuery, setResultFilter, setStatusFilter, setTypeFilter, statusFilter, submitInspection, typeFilter, visibleInspections };
}
