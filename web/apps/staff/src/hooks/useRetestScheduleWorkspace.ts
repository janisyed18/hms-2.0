import { useEffect, useMemo, useState } from "react";

import { createHmsClient } from "../api/hmsClient";
import type { RetestScheduleRecord, RetestScheduleStatus, RetestScheduleUpdateValues } from "../domain/types";

export type RetestScheduleStatusFilter = "ALL" | RetestScheduleStatus;

export function useRetestScheduleWorkspace() {
  const [schedules, setSchedules] = useState<RetestScheduleRecord[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<RetestScheduleStatusFilter>("ALL");
  const [dueFrom, setDueFrom] = useState("");
  const [dueTo, setDueTo] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void createHmsClient().listRetestSchedules({ sort: "due_at" }).then((result) => {
      if (active) setSchedules(result.items);
    });
    return () => { active = false; };
  }, []);

  const visibleSchedules = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return schedules.filter((schedule) => (
      (statusFilter === "ALL" || schedule.status === statusFilter) &&
      (!dueFrom || schedule.dueAt >= dueFrom) &&
      (!dueTo || schedule.dueAt <= dueTo) &&
      (!normalized || [schedule.asset.assetNumber, schedule.asset.tag, schedule.customer.code, schedule.customer.name, schedule.product.code, schedule.product.name, schedule.status, schedule.dueAt].filter(Boolean).some((value) => value?.toLowerCase().includes(normalized)))
    ));
  }, [dueFrom, dueTo, query, schedules, statusFilter]);
  const selectedSchedule = useMemo(() => schedules.find((schedule) => schedule.id === selectedId) ?? null, [schedules, selectedId]);
  function openDetail(schedule: RetestScheduleRecord) { setSelectedId(schedule.id); }
  function closeDetail() { setSelectedId(null); }
  function replaceSchedule(updated: RetestScheduleRecord) { setSchedules((current) => current.map((schedule) => schedule.id === updated.id ? updated : schedule)); setSelectedId(updated.id); }
  async function saveSchedule(values: RetestScheduleUpdateValues) {
    if (selectedSchedule) replaceSchedule(await createHmsClient().updateRetestSchedule(selectedSchedule.id, values, selectedSchedule.etag));
  }
  function clearDateFilters() { setDueFrom(""); setDueTo(""); }
  const activeFilterCount = [Boolean(dueFrom), Boolean(dueTo)].filter(Boolean).length;
  return { activeFilterCount, clearDateFilters, closeDetail, dueFrom, dueTo, openDetail, query, saveSchedule, schedules, selectedSchedule, setQuery, setDueFrom, setDueTo, setStatusFilter, statusFilter, visibleSchedules };
}
