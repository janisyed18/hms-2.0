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
import { loadActiveInspectors } from "../scheduling/roster";
import { addDays, addMonths, ymdOf } from "../scheduling/zonedTime";

export type SchedulingView = "calendar" | "list" | "pending";

/** The two work queues: new booking requests, and reschedules awaiting a decision. */
export type QueueKind = "requests" | "changes";

export interface Queue {
  items: InspectionBookingRecord[];
  /** The server's total for the whole queue, not the number loaded. */
  total: number | null;
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
}

export const EMPTY_QUEUE: Queue = { items: [], total: null, isLoading: false, isLoadingMore: false, error: null };
export const QUEUE_PAGE_SIZE = 50;
const QUEUE_FILTER = {
  requests: { status: "PENDING_APPROVAL" as const },
  changes: { hasPendingChange: true }
};

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
  const [queues, setQueues] = useState<Record<QueueKind, Queue>>({
    requests: EMPTY_QUEUE,
    changes: EMPTY_QUEUE
  });
  // Server totals for the badge, known even before the Pending tab is opened.
  const [queueTotals, setQueueTotals] = useState<Record<QueueKind, number | null>>({
    requests: null,
    changes: null
  });
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [rosterToken, setRosterToken] = useState(0);
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

  // The roster is read once per workspace (and on an explicit retry), not per date change.
  useEffect(() => {
    if (!canApprove) return;
    let active = true;
    void loadActiveInspectors((options) => createHmsClient().listAdminUsers(options)).then((result) => {
      if (!active) return;
      setRoster(result.inspectors);
      setRosterError(result.error);
    });
    return () => {
      active = false;
    };
  }, [canApprove, rosterToken]);

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

  const queueRequest = useRef<Record<QueueKind, number>>({ requests: 0, changes: 0 });

  const fetchQueue = useCallback(async (kind: QueueKind, mode: "first" | "more", offset: number) => {
    const current = ++queueRequest.current[kind];
    setQueues((all) => ({
      ...all,
      [kind]: { ...all[kind], isLoading: mode === "first", isLoadingMore: mode === "more", error: null }
    }));
    try {
      const result = await createHmsClient().listInspectionBookings({
        ...QUEUE_FILTER[kind],
        limit: QUEUE_PAGE_SIZE,
        offset
      });
      if (current !== queueRequest.current[kind]) return;
      setQueues((all) => {
        const kept = mode === "more" ? all[kind].items : [];
        const seen = new Set(kept.map((item) => item.id));
        const items = [...kept, ...result.items.filter((item) => !seen.has(item.id))];
        return { ...all, [kind]: { items, total: result.total, isLoading: false, isLoadingMore: false, error: null } };
      });
      setQueueTotals((all) => ({ ...all, [kind]: result.total }));
    } catch (reason) {
      if (current !== queueRequest.current[kind]) return;
      // Whatever was already loaded stays; only the status reports the failure.
      setQueues((all) => ({
        ...all,
        [kind]: {
          ...all[kind],
          isLoading: false,
          isLoadingMore: false,
          error: reason instanceof Error ? reason.message : "Pending requests could not be loaded."
        }
      }));
    }
  }, []);

  useEffect(() => {
    if (view === "pending") {
      void fetchQueue("requests", "first", 0);
      void fetchQueue("changes", "first", 0);
      return;
    }
    // Not looking at the queue: a one-row read is enough to keep the badge honest.
    let active = true;
    const client = createHmsClient();
    for (const kind of ["requests", "changes"] as const) {
      void client
        .listInspectionBookings({ ...QUEUE_FILTER[kind], limit: 1 })
        .then((result) => {
          if (active) setQueueTotals((all) => ({ ...all, [kind]: result.total }));
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
    };
  }, [view, reloadToken, fetchQueue]);

  const loadMoreQueue = (kind: QueueKind) => fetchQueue(kind, "more", queues[kind].items.length);
  const retryQueue = (kind: QueueKind) =>
    fetchQueue(kind, queues[kind].items.length > 0 ? "more" : "first", queues[kind].items.length);
  const retryRoster = () => setRosterToken((value) => value + 1);

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
    const fromQueues = [...queues.requests.items, ...queues.changes.items].find((b) => b.id === selectedId);
    return fromQueues ? toEntry(fromQueues, inspectorNames) : null;
  }, [allEntries, inspectorNames, queues.requests.items, queues.changes.items, selectedId]);

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
      setQueues((all) => ({
        requests: { ...all.requests, items: all.requests.items.map((booking) => (booking.id === id ? fresh : booking)) },
        changes: { ...all.changes, items: all.changes.items.map((booking) => (booking.id === id ? fresh : booking)) }
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
    loadMoreQueue,
    // A badge that sums only one side would understate the queue, so wait for both.
    pendingTotal:
      queueTotals.requests === null || queueTotals.changes === null
        ? null
        : queueTotals.requests + queueTotals.changes,
    queues,
    range,
    retryQueue,
    retryRoster,
    rosterError,
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
