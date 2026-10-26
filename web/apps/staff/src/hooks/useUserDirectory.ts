import { useCallback, useEffect, useRef, useState } from "react";

import { createHmsClient, type AdminUserSummary } from "../api/hmsClient";
import type { AdminUserRecord } from "../domain/types";
import { friendlyApiError } from "../components/interaction/friendlyApiError";

export interface UserFilters {
  search: string;
  role: string;
  accountStatus: "" | "ACTIVE" | "LOCKED" | "DISABLED";
  mfa: "" | "enabled" | "setup_required";
  customerId: string;
  sort: "name" | "email" | "role" | "-last_login_at";
}

export const emptyUserFilters: UserFilters = {
  search: "",
  role: "",
  accountStatus: "",
  mfa: "",
  customerId: "",
  sort: "name"
};

const DEFAULT_PAGE_SIZE = 10;
const SEARCH_DELAY_MS = 300;

export function hasActiveFilters(filters: UserFilters): boolean {
  return Boolean(filters.search.trim() || filters.role || filters.accountStatus || filters.mfa || filters.customerId);
}

/**
 * The user directory as the server describes it: one page of the users that match the filters,
 * the size of the whole matching set, and directory-wide counts that ignore both.
 */
export function useUserDirectory(enabled: boolean) {
  const [filters, setFilters] = useState<UserFilters>(emptyUserFilters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [users, setUsers] = useState<AdminUserRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<AdminUserSummary | null>(null);
  const [reloads, setReloads] = useState(0);
  // The text actually sent: typing waits briefly so each keystroke is not a request.
  const [sentSearch, setSentSearch] = useState("");
  const latest = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setSentSearch(filters.search), filters.search === "" ? 0 : SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [filters.search]);

  useEffect(() => {
    if (!enabled) return;
    const request = ++latest.current;
    setStatus("loading");
    createHmsClient()
      .listAdminUsers({
        search: sentSearch,
        role: filters.role,
        accountStatus: filters.accountStatus || undefined,
        mfa: filters.mfa || undefined,
        customerId: filters.customerId,
        sort: filters.sort,
        limit: pageSize,
        offset: (page - 1) * pageSize
      })
      .then((result) => {
        if (request !== latest.current) return;
        // Removing the last row of the last page (or a filter narrowing the set) can leave this page
        // past the end: go to the last page that exists and ask again.
        const lastPage = Math.max(1, Math.ceil(result.total / pageSize));
        if (page > lastPage) {
          setPage(lastPage);
          return;
        }
        setUsers(result.items);
        setTotal(result.total);
        setError(null);
        setStatus("ready");
      })
      .catch((reason: unknown) => {
        if (request !== latest.current) return;
        setError(friendlyApiError(reason, { fallback: "The user list could not be loaded." }).message);
        setStatus("error");
      });
  }, [enabled, sentSearch, filters.role, filters.accountStatus, filters.mfa, filters.customerId, filters.sort, page, pageSize, reloads]);

  const reloadSummary = useCallback(() => {
    // Counts are secondary: if they cannot be refreshed the last good numbers stay.
    createHmsClient().getAdminUserSummary().then(setSummary).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (enabled) reloadSummary();
  }, [enabled, reloadSummary]);

  function changeFilters(next: Partial<UserFilters>) {
    setFilters((current) => ({ ...current, ...next }));
    setPage(1);
  }

  return {
    filters,
    changeFilters,
    clearFilters: () => {
      setFilters(emptyUserFilters);
      setSentSearch("");
      setPage(1);
    },
    page,
    setPage,
    pageSize,
    setPageSize: (size: number) => {
      setPageSize(size);
      setPage(1);
    },
    users,
    total,
    status,
    error,
    summary,
    /**
     * A user changed: show the server's answer for that row at once, then ask the server for the
     * page again, because the change may move it out of the current filter, order or page.
     */
    replaceUser: (updated: AdminUserRecord) => {
      setUsers((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setReloads((count) => count + 1);
      reloadSummary();
    },
    /** The set itself changed (a user was added): ask the server again. */
    reload: () => {
      setReloads((count) => count + 1);
      reloadSummary();
    }
  };
}
