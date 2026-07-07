import { useEffect, useMemo, useState } from "react";

import {
  createHmsClient,
  loadRetestSchedulesWithFallback
} from "../api/hmsClient";
import type {
  DataSource,
  RetestScheduleRecord,
  RetestScheduleStatus,
  RetestScheduleUpdateValues
} from "../domain/types";

export type RetestScheduleStatusFilter = "ALL" | RetestScheduleStatus;

function localScheduleUpdate(
  schedule: RetestScheduleRecord,
  values: RetestScheduleUpdateValues
): RetestScheduleRecord {
  return {
    ...schedule,
    dueAt: values.dueAt,
    status: values.status,
    reminderIntervalDays: values.reminderIntervalDays,
    escalationIntervalDays: values.escalationIntervalDays
  };
}

export function useRetestScheduleWorkspace() {
  const [schedules, setSchedules] = useState<RetestScheduleRecord[]>([]);
  const [source, setSource] = useState<DataSource>("mock");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] =
    useState<RetestScheduleStatusFilter>("ALL");
  const [dueFrom, setDueFrom] = useState("");
  const [dueTo, setDueTo] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    loadRetestSchedulesWithFallback({ sort: "due_at" }).then((result) => {
      if (!active) {
        return;
      }
      setSchedules(result.items);
      setSource(result.source);
    });
    return () => {
      active = false;
    };
  }, []);

  const visibleSchedules = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return schedules.filter((schedule) => {
      const matchesStatus =
        statusFilter === "ALL" || schedule.status === statusFilter;
      const matchesDueFrom = !dueFrom || schedule.dueAt >= dueFrom;
      const matchesDueTo = !dueTo || schedule.dueAt <= dueTo;
      const matchesSearch =
        !normalized ||
        [
          schedule.asset.assetNumber,
          schedule.asset.tag,
          schedule.customer.code,
          schedule.customer.name,
          schedule.product.code,
          schedule.product.name,
          schedule.status,
          schedule.dueAt
        ]
          .filter(Boolean)
          .some((value) => value?.toLowerCase().includes(normalized));
      return matchesStatus && matchesDueFrom && matchesDueTo && matchesSearch;
    });
  }, [dueFrom, dueTo, query, schedules, statusFilter]);

  const selectedSchedule = useMemo(
    () => schedules.find((schedule) => schedule.id === selectedId) ?? null,
    [schedules, selectedId]
  );

  function openDetail(schedule: RetestScheduleRecord) {
    setSelectedId(schedule.id);
  }

  function closeDetail() {
    setSelectedId(null);
  }

  function replaceSchedule(updated: RetestScheduleRecord) {
    setSchedules((current) =>
      current.map((schedule) =>
        schedule.id === updated.id ? updated : schedule
      )
    );
    setSelectedId(updated.id);
  }

  async function saveSchedule(values: RetestScheduleUpdateValues) {
    if (!selectedSchedule) {
      return;
    }
    let saved = localScheduleUpdate(selectedSchedule, values);
    if (source === "api") {
      try {
        saved = await createHmsClient().updateRetestSchedule(
          selectedSchedule.id,
          values,
          selectedSchedule.etag
        );
      } catch {
        saved = localScheduleUpdate(selectedSchedule, values);
      }
    }
    replaceSchedule(saved);
  }

  function clearDateFilters() {
    setDueFrom("");
    setDueTo("");
  }

  const activeFilterCount = [Boolean(dueFrom), Boolean(dueTo)].filter(Boolean).length;

  return {
    activeFilterCount,
    clearDateFilters,
    closeDetail,
    dueFrom,
    dueTo,
    openDetail,
    query,
    saveSchedule,
    schedules,
    selectedSchedule,
    setQuery,
    setDueFrom,
    setDueTo,
    setStatusFilter,
    source,
    statusFilter,
    visibleSchedules
  };
}
