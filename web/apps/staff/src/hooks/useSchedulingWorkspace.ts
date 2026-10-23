import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createHmsClient, HmsApiError } from "../api/hmsClient";
import type {
  AssetRecord,
  InspectionBookingCreateValues,
  InspectionBookingRecord,
  ScheduleInspector
} from "../domain/types";
import {
  EMPTY_FILTERS,
  activeFilterCount,
  applyFilters,
  rangeFor,
  toEntry,
  type CalendarMode,
  type InspectorOption,
  type ScheduleEntry,
  type ScheduleFilters
} from "../scheduling/scheduleModel";
import { addDays, addMonths, ymdOf } from "../scheduling/zonedTime";

export type SchedulingView = "calendar" | "list" | "pending";

/** Australia-first: the calendar's default zone, changeable in the toolbar. */
export const DEFAULT_SCHEDULE_ZONE = "Australia/Sydney";

export interface ActionNotice {
  kind: "success" | "conflict" | "error";
  message: string;
}

interface FormState {
  open: boolean;
  reschedule: InspectionBookingRecord | null;
  initialDate: string;
}

const CONFLICT_COPY =
  "This booking changed while you were working on it. It has been refreshed below; check the new details and try again.";

export function useSchedulingWorkspace({
  canApprove,
  initialDate
}: {
  canApprove: boolean;
  /** Test seam: the anchor date (YYYY-MM-DD) instead of today. */
  initialDate?: string;
}) {
  const [view, setView] = useState<SchedulingView>("calendar");
  const [mode, setMode] = useState<CalendarMode>("day");
  const [timeZone, setTimeZone] = useState(DEFAULT_SCHEDULE_ZONE);
  const [anchor, setAnchor] = useState(
    () => initialDate ?? ymdOf(new Date(), DEFAULT_SCHEDULE_ZONE)
  );
  const [filters, setFilters] = useState<ScheduleFilters>(EMPTY_FILTERS);
  const [bookings, setBookings] = useState<InspectionBookingRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(500);
  const [lanesFromApi, setLanesFromApi] = useState<ScheduleInspector[]>([]);
  const [roster, setRoster] = useState<InspectorOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    bookings: InspectionBookingRecord[];
    changes: InspectionBookingRecord[];
    isLoading: boolean;
    error: string | null;
  }>({ bookings: [], changes: [], isLoading: false, error: null });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  const [form, setForm] = useState<FormState>({ open: false, reschedule: null, initialDate: "" });
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [reloadToken, setReloadToken] = useState(0);
  // Filter choices accumulate as the user browses, so choosing one never removes the
  // others from the list.
  const [known, setKnown] = useState<{
    customers: Record<string, string>;
    locations: Record<string, string>;
  }>({ customers: {}, locations: {} });
  const requestId = useRef(0);

  const range = useMemo(() => rangeFor(mode, anchor, timeZone), [mode, anchor, timeZone]);
  // What the API is asked for. Status is a presentation group, so it is applied after.
  const serverFilters = useMemo(
    () => ({
      customerId: filters.customerId || undefined,
      locationId: filters.locationId || undefined,
      inspectorUserId: filters.inspectorId || undefined,
      unassigned: filters.assignment === "unassigned"
    }),
    [filters.customerId, filters.inspectorId, filters.locationId, filters.assignment]
  );

  useEffect(() => {
    if (!canApprove) return;
    let active = true;
    void createHmsClient()
      .listAdminUsers({ sort: "email", limit: 100 })
      .then((result) => {
        if (!active) return;
        setRoster(
          result.items
            .filter((user) => user.role === "INSPECTOR" && user.accountStatus === "ACTIVE")
            .map((user) => ({ id: user.id, name: user.displayName }))
        );
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [canApprove]);

  useEffect(() => {
    if (view === "pending") return;
    const current = ++requestId.current;
    setIsLoading(true);
    setError(null);
    void createHmsClient()
      .listInspectionSchedule({ start: range.start, end: range.end, ...serverFilters })
      .then((result) => {
        if (current !== requestId.current) return;
        setKnown((current) => {
          const customers = { ...current.customers };
          const locations = { ...current.locations };
          for (const booking of result.items) {
            customers[booking.customer.id] = booking.customer.name;
            locations[booking.location.id] = booking.location.name;
          }
          return { customers, locations };
        });
        setBookings(result.items);
        setTotal(result.total);
        setLimit(result.limit);
        setLanesFromApi(result.inspectors);
        setHasLoaded(true);
      })
      .catch((reason: unknown) => {
        if (current !== requestId.current) return;
        // The previous results stay on screen; only the status line reports it.
        setError(reason instanceof Error ? reason.message : "The schedule could not be loaded.");
      })
      .finally(() => {
        if (current === requestId.current) setIsLoading(false);
      });
  }, [range, serverFilters, view, reloadToken]);

  useEffect(() => {
    if (view !== "pending") return;
    let active = true;
    setPending((current) => ({ ...current, isLoading: true, error: null }));
    const client = createHmsClient();
    void Promise.all([
      client.listInspectionBookings({ status: "PENDING_APPROVAL", limit: 100 }),
      client.listInspectionBookings({ hasPendingChange: true, limit: 100 })
    ])
      .then(([requests, changes]) => {
        if (!active) return;
        setPending({ bookings: requests.items, changes: changes.items, isLoading: false, error: null });
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setPending((current) => ({
          ...current,
          isLoading: false,
          error: reason instanceof Error ? reason.message : "Pending requests could not be loaded."
        }));
      });
    return () => {
      active = false;
    };
  }, [view, reloadToken]);

  const inspectors: InspectorOption[] = useMemo(() => {
    const merged = new Map<string, string>();
    for (const inspector of lanesFromApi) merged.set(inspector.id, inspector.displayName);
    for (const inspector of roster) merged.set(inspector.id, inspector.name);
    return [...merged].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [lanesFromApi, roster]);
  const inspectorNames = useMemo(
    () => new Map(inspectors.map((inspector) => [inspector.id, inspector.name])),
    [inspectors]
  );

  const allEntries = useMemo(
    () => bookings.map((booking) => toEntry(booking, inspectorNames)),
    [bookings, inspectorNames]
  );
  const entries = useMemo(() => applyFilters(allEntries, filters), [allEntries, filters]);

  const selected: ScheduleEntry | null = useMemo(() => {
    if (!selectedId) return null;
    const found = allEntries.find((entry) => entry.id === selectedId);
    if (found) return found;
    const fromPending = [...pending.bookings, ...pending.changes].find((b) => b.id === selectedId);
    return fromPending ? toEntry(fromPending, inspectorNames) : null;
  }, [allEntries, inspectorNames, pending.bookings, pending.changes, selectedId]);

  const refresh = useCallback(() => setReloadToken((value) => value + 1), []);

  // --- navigation -------------------------------------------------------------------

  function shift(direction: 1 | -1) {
    setAnchor((current) =>
      mode === "day"
        ? addDays(current, direction)
        : mode === "week"
          ? addDays(current, direction * 7)
          : addMonths(current, direction)
    );
  }
  function goToToday() {
    setAnchor(ymdOf(new Date(), timeZone));
  }
  function jumpTo(ymd: string) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(ymd)) setAnchor(ymd);
  }
  function openDay(ymd: string) {
    setAnchor(ymd);
    setMode("day");
    setView("calendar");
  }
  function changeTimeZone(next: string) {
    // Keep looking at the same calendar day when the grid's zone changes.
    setTimeZone(next);
  }

  // --- filters ----------------------------------------------------------------------

  function updateFilters(patch: Partial<ScheduleFilters>) {
    setFilters((current) => ({ ...current, ...patch }));
  }
  function resetFilters() {
    setFilters(EMPTY_FILTERS);
  }

  const customers = useMemo(
    () =>
      Object.entries(known.customers)
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [known.customers]
  );
  const locations = useMemo(
    () =>
      Object.entries(known.locations)
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [known.locations]
  );

  // --- actions: all go through the existing validated endpoints ----------------------

  async function reloadBooking(id: string) {
    try {
      const fresh = await createHmsClient().getInspectionBooking(id);
      setBookings((current) => current.map((booking) => (booking.id === id ? fresh : booking)));
      setPending((current) => ({
        ...current,
        bookings: current.bookings.map((booking) => (booking.id === id ? fresh : booking)),
        changes: current.changes.map((booking) => (booking.id === id ? fresh : booking))
      }));
    } catch {
      /* the broader refresh below still runs */
    }
  }

  async function run(bookingId: string | null, success: string, action: () => Promise<unknown>) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      setNotice({ kind: "success", message: success });
      if (bookingId) await reloadBooking(bookingId);
      refresh();
      return true;
    } catch (reason) {
      const conflict =
        reason instanceof HmsApiError && (reason.status === 409 || reason.status === 404);
      setNotice({
        kind: conflict ? "conflict" : "error",
        message: conflict
          ? `${CONFLICT_COPY} (${reason.message})`
          : reason instanceof Error
            ? reason.message
            : "The action could not be completed."
      });
      // Show what the server now says, keeping the user where they are.
      if (bookingId) await reloadBooking(bookingId);
      refresh();
      return false;
    } finally {
      setBusy(false);
    }
  }

  const approveBooking = (id: string, inspectorUserId: string) =>
    run(id, "Booking approved and inspector assigned.", () =>
      createHmsClient().approveInspectionBooking(id, inspectorUserId)
    );
  const declineBooking = (id: string) =>
    run(id, "Booking declined.", () => createHmsClient().rejectInspectionBooking(id));
  const cancelBooking = (id: string) =>
    run(id, "Booking cancelled.", () => createHmsClient().cancelInspectionBooking(id));
  const approveReschedule = (bookingId: string, changeId: string, inspectorUserId: string) =>
    run(bookingId, "Reschedule approved.", () =>
      createHmsClient().approveInspectionBookingReschedule(changeId, inspectorUserId)
    );

  async function ensureAssets() {
    if (assets.length > 0) return;
    try {
      setAssets((await createHmsClient().listAllAssets({ sort: "asset_number" })).items);
    } catch (reason) {
      setNotice({
        kind: "error",
        message: reason instanceof Error ? reason.message : "Assets could not be loaded."
      });
    }
  }

  /** "Book inspection": the existing flow, with the viewed date offered as its date. */
  async function openBooking(date?: string) {
    await ensureAssets();
    setForm({ open: true, reschedule: null, initialDate: date ?? (mode === "day" ? anchor : "") });
  }
  async function openReschedule(booking: InspectionBookingRecord) {
    await ensureAssets();
    setForm({ open: true, reschedule: booking, initialDate: "" });
  }
  function closeForm() {
    setForm((current) => ({ ...current, open: false }));
  }
  async function submitBooking(values: InspectionBookingCreateValues) {
    await createHmsClient().createInspectionBooking(values);
    setNotice({ kind: "success", message: "Booking requested." });
    closeForm();
    refresh();
  }
  async function submitReschedule(
    id: string,
    values: { availabilityQuoteId: string; reason: string | null; inspectorUserId: string | null }
  ) {
    try {
      await createHmsClient().requestInspectionBookingReschedule(id, values);
    } catch (reason) {
      if (reason instanceof HmsApiError && (reason.status === 409 || reason.status === 404)) {
        setNotice({ kind: "conflict", message: `${CONFLICT_COPY} (${reason.message})` });
        await reloadBooking(id);
        refresh();
      }
      throw reason;
    }
    setNotice({ kind: "success", message: "Reschedule requested." });
    closeForm();
    await reloadBooking(id);
    refresh();
  }

  return {
    activeFilterCount: activeFilterCount(filters),
    anchor,
    approveBooking,
    approveReschedule,
    assets,
    busy,
    cancelBooking,
    changeTimeZone,
    closeForm,
    customers,
    declineBooking,
    entries,
    error,
    filters,
    form,
    goToToday,
    hasLoaded,
    inspectors,
    isLoading,
    jumpTo,
    limit,
    locations,
    mode,
    notice,
    openBooking,
    openDay,
    openReschedule,
    pending,
    range,
    refresh,
    resetFilters,
    selected,
    setMode,
    setNotice,
    setSelectedId,
    setView,
    shift,
    submitBooking,
    submitReschedule,
    timeZone,
    total,
    updateFilters,
    view
  };
}
