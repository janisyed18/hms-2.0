import { History, KeyRound, ListFilter, ShieldCheck, UsersRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { createHmsClient, HmsApiError } from "../api/hmsClient";
import type { AuditEventRecord } from "../domain/types";
import { formatDateTime } from "../utils/dateTime";
import { ManagementHeader, ManagementMetric, ManagementMetricStrip } from "./ManagementPrimitives";
import { ModuleTable, type ModuleColumn } from "./ModuleTable";

function actionLabel(action: string) {
  return action.split(".").map((part, index) => (
    index === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part
  )).join(" ");
}

function errorMessage(error: unknown) {
  if (error instanceof HmsApiError || error instanceof Error) return error.message;
  return "Audit events could not be loaded.";
}

export function AuditWorkspace() {
  const [events, setEvents] = useState<AuditEventRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [entity, setEntity] = useState("ALL");
  const [action, setAction] = useState("ALL");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    createHmsClient().listAuditEvents({ limit: 100, sort: "-sequence" })
      .then((result) => {
        if (!active) return;
        setEvents(result.items);
        setTotal(result.total);
        setError(null);
      })
      .catch((loadError: unknown) => active && setError(errorMessage(loadError)))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  const entities = useMemo(() => Array.from(new Set(events.map((event) => event.entity))).sort(), [events]);
  const actions = useMemo(() => Array.from(new Set(events.map((event) => event.action))).sort(), [events]);
  const visibleEvents = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return events.filter((event) => {
      const day = event.timestamp.slice(0, 10);
      return (entity === "ALL" || event.entity === entity)
        && (action === "ALL" || event.action === action)
        && (!from || day >= from)
        && (!to || day <= to)
        && (!normalized || [event.action, event.entity, event.entityId, event.actorId]
          .some((value) => value.toLowerCase().includes(normalized)));
    });
  }, [action, entity, events, from, query, to]);
  const activeFilters = [entity !== "ALL", action !== "ALL", Boolean(from), Boolean(to)].filter(Boolean).length;
  const uniqueActors = new Set(visibleEvents.map((event) => event.actorId)).size;
  const authEvents = visibleEvents.filter((event) => event.action.startsWith("auth.")).length;
  const columns: ModuleColumn<AuditEventRecord>[] = [
    { header: "Event", render: (event) => <strong>{actionLabel(event.action)}</strong> },
    { header: "Actor", render: (event) => event.actorId },
    { header: "Record", render: (event) => `${event.entity}:${event.entityId}` },
    { header: "Details", render: (event) => event.hash.slice(0, 12) },
    { header: "Time", render: (event) => formatDateTime(event.timestamp) }
  ];

  return (
    <section className="audit-workspace management-workspace" aria-label="Audit workspace">
      <ManagementHeader
        eyebrow="Governance"
        title="Activity history"
        description="Track immutable system activity across inspections, certificates, assets, and access."
        context={<><ShieldCheck aria-hidden="true" size={20} /><span><strong>Complete audit history</strong><small>Actions are recorded immutably</small></span></>}
      />
      <ManagementMetricStrip>
        <ManagementMetric icon={History} label="Audit Events" value={total} detail="Recorded workspace events" />
        <ManagementMetric icon={UsersRound} label="Actors" value={uniqueActors} detail="In the current view" tone="green" />
        <ManagementMetric icon={KeyRound} label="Access Events" value={authEvents} detail="Authentication-related activity" tone="amber" />
        <ManagementMetric icon={ListFilter} label="Visible Events" value={visibleEvents.length} detail="Matching this view" tone="violet" />
      </ManagementMetricStrip>
      <ModuleTable
        className="audit-events-table"
        columns={columns}
        countLabel={`${visibleEvents.length} audit events`}
        emptyLabel="No audit events match the current filters."
        error={error}
        exportRows={(event) => [actionLabel(event.action), event.actorId, `${event.entity}:${event.entityId}`, event.hash, event.timestamp]}
        filterControls={<>
          <label className="filter-field"><span>Event type</span><select aria-label="Audit event type" value={action} onChange={(event) => setAction(event.target.value)}><option value="ALL">All events</option>{actions.map((value) => <option key={value} value={value}>{actionLabel(value)}</option>)}</select></label>
          <label className="filter-field"><span>Record type</span><select aria-label="Audit record type" value={entity} onChange={(event) => setEntity(event.target.value)}><option value="ALL">All records</option>{entities.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <label className="filter-field"><span>From date</span><input aria-label="Audit events from date" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
          <label className="filter-field"><span>To date</span><input aria-label="Audit events to date" type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
          <button className="secondary-button filter-clear" type="button" onClick={() => { setEntity("ALL"); setAction("ALL"); setFrom(""); setTo(""); }}>Reset audit filters</button>
        </>}
        activeFilterCount={activeFilters}
        filtersInitiallyOpen
        getRowKey={(event) => String(event.sequence)}
        items={visibleEvents}
        loading={loading}
        onQueryChange={setQuery}
        query={query}
        searchLabel="Search audit events"
        searchPlaceholder="Search events, actors, or records..."
        tableLabel="Audit trail events"
      />
    </section>
  );
}
