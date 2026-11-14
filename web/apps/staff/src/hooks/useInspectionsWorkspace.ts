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

/**
 * What the Inspection Operations screen asks the server for. "Reschedule requested" is
 * a booking with an open change request rather than a booking status of its own, so it
 * maps to the server's pending-change filter.
 */
export type BookingStatusFilter =
  | "ALL" | "PENDING_APPROVAL" | "RESCHEDULE_REQUESTED" | "APPROVED" | "REJECTED" | "CANCELLED";

export interface BookingFilters {
  status: BookingStatusFilter;
  customerId: string;
  locationId: string;
  assetId: string;
  search: string;
}

export interface BookingFacet { id: string; name: string }
export interface BookingFacets { customers: BookingFacet[]; locations: BookingFacet[]; assets: BookingFacet[] }
const NO_FACETS: BookingFacets = { customers: [], locations: [], assets: [] };

export const NO_BOOKING_FILTERS: BookingFilters = {
  status: "ALL", customerId: "ALL", locationId: "ALL", assetId: "ALL", search: ""
};

const BOOKING_PAGE = 50;

function bookingRequest(filters: BookingFilters) {
  const chosen = (value: string) => (value === "ALL" ? undefined : value);
  return {
    status: filters.status === "ALL" || filters.status === "RESCHEDULE_REQUESTED"
      ? undefined
      : (filters.status as InspectionBookingRecord["status"]),
    hasPendingChange: filters.status === "RESCHEDULE_REQUESTED",
    customerId: chosen(filters.customerId),
    locationId: chosen(filters.locationId),
    assetId: chosen(filters.assetId),
    search: filters.search.trim() || undefined,
    limit: BOOKING_PAGE,
    offset: 0
  };
}

const INSPECTOR_PAGE = 100;
const INSPECTOR_PAGE_LIMIT = 50;

/** Active inspectors only, filtered by the server and read page by page so a large directory is not cut short. */
async function fetchActiveInspectors(client: ReturnType<typeof createHmsClient>): Promise<AdminUserRecord[]> {
  const found: AdminUserRecord[] = [];
  for (let page = 0; page < INSPECTOR_PAGE_LIMIT; page += 1) {
    const result = await client.listAdminUsers({ role: "INSPECTOR", accountStatus: "ACTIVE", sort: "email", limit: INSPECTOR_PAGE, offset: page * INSPECTOR_PAGE });
    found.push(...result.items);
    if (found.length >= result.total || result.items.length === 0) break;
  }
  return found;
}

export function useInspectionsWorkspace(
  canApproveBookings: boolean,
  /** The inspection the URL names; the URL is the record of which one is open. */
  routeInspectionId?: string | null,
  onInspectionRouteChange?: (inspectionId: string | null, options?: { replace?: boolean }) => void
) {
  const [inspections, setInspections] = useState<InspectionRecord[]>([]);
  const [serverTotal, setServerTotal] = useState<number | undefined>(undefined);
  // The pressure rating of the open inspection's asset, read from that one asset rather than a loaded list.
  const [ratings, setRatings] = useState<Record<string, AssetRecord["pressureRating"] | null>>({});
  const [bookings, setBookings] = useState<InspectionBookingRecord[]>([]);
  const [inspectors, setInspectors] = useState<AdminUserRecord[]>([]);
  const [bookingTotal, setBookingTotal] = useState(0);
  const [bookingFilters, setBookingFilters] = useState<BookingFilters>(NO_BOOKING_FILTERS);
  const [bookingFacets, setBookingFacets] = useState<BookingFacets>(NO_FACETS);
  const [bookingsLoading, setBookingsLoading] = useState(true);
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
    void client.listInspections({ sort: "-created_at" })
      .then((inspectionResult) => {
        if (!active) return;
        setInspections(inspectionResult.items); setServerTotal(inspectionResult.total);
      })
      .catch((reason: unknown) => { if (active) setError(friendlyApiError(reason, { fallback: "Inspection records could not be loaded." }).message); })
      .finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, []);

  // The filter dropdowns offer every customer, site and asset seen in any booking read
  // so far, kept as the filters narrow: an option list rebuilt from the current, already
  // filtered page would drop the very choice needed to widen the search again.
  const rememberFacets = useCallback((items: InspectionBookingRecord[]) => {
    setBookingFacets((current) => {
      const merge = (known: BookingFacet[], found: BookingFacet[]) => {
        const next = new Map(known.map((entry) => [entry.id, entry]));
        found.forEach((entry) => next.set(entry.id, entry));
        return [...next.values()].sort((left, right) => left.name.localeCompare(right.name));
      };
      return {
        customers: merge(current.customers, items.map((booking) => ({ id: booking.customer.id, name: booking.customer.name }))),
        locations: merge(current.locations, items.map((booking) => ({ id: booking.location.id, name: booking.location.name }))),
        assets: merge(current.assets, items.flatMap((booking) => booking.assets.map((asset) => ({ id: asset.id, name: assetLabel(asset) }))))
      };
    });
  }, []);

  // Bookings are read with the filters applied, so the server decides what matches
  // across every page instead of the screen narrowing whatever the first page held.
  // ``bookingTotal`` is then the number of matching bookings, not the catalogue size.
  const bookingQuery = useMemo(() => bookingRequest(bookingFilters), [bookingFilters]);
  const bookingQueryKey = JSON.stringify(bookingQuery);
  useEffect(() => {
    let active = true;
    setBookingsLoading(true);
    // Typing should not fire a request per keystroke; a filter chosen from a list applies at once.
    const delay = bookingQuery.search ? 250 : 0;
    const timer = setTimeout(() => {
      void createHmsClient().listInspectionBookings(bookingQuery)
        .then((result) => {
          if (!active) return;
          setBookings(result.items); setBookingTotal(result.total); rememberFacets(result.items);
        })
        .catch((reason: unknown) => { if (active) setError(friendlyApiError(reason, { fallback: "Inspection bookings could not be loaded." }).message); })
        .finally(() => { if (active) setBookingsLoading(false); });
    }, delay);
    return () => { active = false; clearTimeout(timer); };
    // bookingQuery is rebuilt with the filters; the serialised key is what actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingQueryKey]);


  const visibleInspections = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return inspections.filter((inspection) => (
      (statusFilter === "ALL" || inspection.status === statusFilter) &&
      (typeFilter === "ALL" || inspection.inspectionType === typeFilter) &&
      (resultFilter === "ALL" || (inspection.result ?? "PENDING") === resultFilter) &&
      (!normalized || [inspection.asset.assetNumber, inspection.asset.assetName, inspection.asset.tag, inspection.customer.code, inspection.customer.name, inspection.product.code, inspection.product.name, inspection.inspectionType, inspection.status, inspection.result].filter(Boolean).some((value) => value?.toLowerCase().includes(normalized)))
    ));
  }, [inspections, query, resultFilter, statusFilter, typeFilter]);
  const resultOptions = useMemo(() => Array.from(new Set(inspections.map((inspection) => inspection.result ?? "PENDING"))).sort(), [inspections]);
  const selectedInspection = useMemo(() => inspections.find((inspection) => inspection.id === selectedId) ?? null, [inspections, selectedId]);
  const selectedAssetId = selectedInspection?.assetId ?? null;
  useEffect(() => {
    if (!selectedAssetId || selectedAssetId in ratings) return;
    let active = true;
    createHmsClient().getAsset(selectedAssetId)
      .then((asset) => asset.pressureRating ?? null)
      .catch(() => null)
      .then((rating) => { if (active) setRatings((current) => ({ ...current, [selectedAssetId]: rating })); });
    return () => { active = false; };
  }, [selectedAssetId, ratings]);
  const ratingReady = selectedAssetId === null || selectedAssetId in ratings;
  const ratingFor = useCallback((assetId: string) => ratings[assetId] ?? null, [ratings]);

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
  /** The active inspectors an administrator can assign. Loaded on first need; false when they could not be. */
  async function loadInspectors(): Promise<boolean> {
    if (!canApproveBookings || inspectors.length > 0) return true;
    try {
      setInspectors(await fetchActiveInspectors(createHmsClient()));
      return true;
    } catch (reason) {
      setError(friendlyApiError(reason, { fallback: "Inspectors could not be loaded." }).message);
      return false;
    }
  }
  async function openBooking(): Promise<boolean> {
    if (!(await loadInspectors())) return false;
    setRescheduleBooking(null); setBookingFormOpen(true);
    return true;
  }
  function openReschedule(booking: InspectionBookingRecord) { setRescheduleBooking(booking); setBookingFormOpen(true); }
  function openDetail(inspection: InspectionRecord) { setSelectedId(inspection.id); }
  function closeDetail() { setSelectedId(null); }
  function replaceInspection(updated: InspectionRecord) { setInspections((current) => current.map((inspection) => inspection.id === updated.id ? updated : inspection)); setSelectedId(updated.id); }
  /** After a conflict the screen may be out of date: reload what the actions change. */
  const refreshBookingsAndInspections = useCallback(async () => {
    try {
      const client = createHmsClient();
      const [bookingResult, inspectionResult] = await Promise.all([client.listInspectionBookings(bookingQuery), client.listInspections({ sort: "-created_at" })]);
      setBookings(bookingResult.items);
      setBookingTotal(bookingResult.total);
      rememberFacets(bookingResult.items);
      setInspections(inspectionResult.items);
    } catch {
      // The failure notice already explains the action; a failed refresh keeps what is on screen.
    }
  }, [bookingQuery, rememberFacets]);
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
  /**
   * Changes who attends a confirmed booking; the appointment time is untouched. A busy inspector is a 409 shown as stated.
   * The server also moves the booking's draft inspections to the new inspector, so the inspection list is reloaded; if only
   * that reload fails the change still stands and is reported with a refresh warning.
   */
  function reassignInspectionBookingInspector(id: string, inspectorUserId: string) {
    const booking = bookings.find((item) => item.id === id);
    return run(`reassign:${id}`, async () => {
      const saved = await createHmsClient().reassignInspectionBookingInspector(id, inspectorUserId);
      setBookings((current) => current.map((item) => item.id === saved.id ? saved : item));
      return tryRefresh(async () => {
        const refreshed = await createHmsClient().listInspections({ sort: "-created_at" });
        setInspections(refreshed.items);
      });
    }, { ...bookingFailure("Inspector could not be reassigned"), fallback: "The inspector could not be reassigned. Try again.", success: outcome("Inspector reassigned", `The inspector for ${booking?.location.name ?? "the site"} was changed; the inspection time is unchanged`) });
  }
  /** Asks the server whether an inspector is free for a booking's existing time. Rejects when it cannot be verified. */
  function checkInspectorAvailability(id: string, inspectorUserId: string) {
    return createHmsClient().getInspectorAvailability(id, inspectorUserId);
  }
  /** The next page of bookings, so a confirmed booking beyond the first page can still be reached from this screen. */
  async function loadMoreBookings() {
    try {
      const next = await createHmsClient().listInspectionBookings({ ...bookingQuery, offset: bookings.length });
      setBookings((current) => [...current, ...next.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
      setBookingTotal(next.total);
      rememberFacets(next.items);
    } catch (reason) {
      setError(friendlyApiError(reason, { fallback: "More bookings could not be loaded." }).message);
    }
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
  function setBookingFilter<K extends keyof BookingFilters>(key: K, value: BookingFilters[K]) {
    setBookingFilters((current) => ({ ...current, [key]: value }));
  }
  function clearBookingFilters() { setBookingFilters(NO_BOOKING_FILTERS); }
  const hasBookingFilters = (Object.keys(NO_BOOKING_FILTERS) as Array<keyof BookingFilters>)
    .some((key) => bookingFilters[key] !== NO_BOOKING_FILTERS[key]);

  return { bookingFacets, bookingFilters, bookingsLoading, clearBookingFilters, hasBookingFilters, setBookingFilter, checkInspectorAvailability, serverTotal, activeFilterCount, approveInspection, beginInspectionRework, rejectInspection, startInspection, approveInspectionBooking, approveInspectionBookingReschedule, loadInspectors, loadMoreBookings, bookingTotal, reassignInspectionBookingInspector, ratingFor, ratingReady, bookingDecision, bookings, dismissNotice, notice, pendingAction, refreshBookingsAndInspections, clearInspectionFilters, closeDetail, confirmInspectionBookingReschedule, error, inspectors, inspections, isBookingFormOpen, isFormOpen, isLoading, openBooking, openCreate, openDetail, openReschedule, query, requestInspectionBookingReschedule, rescheduleBooking, resultFilter, resultOptions, saveInspection, saveInspectionBooking, saveInspectionUpdate, selectedInspection, setBookingFormOpen, setFormOpen, setQuery, setResultFilter, setStatusFilter, setTypeFilter, statusFilter, submitInspection, typeFilter, visibleInspections };
}
