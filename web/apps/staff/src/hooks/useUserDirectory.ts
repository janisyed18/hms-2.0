import { useCallback, useEffect, useRef, useState } from "react";

import { createHmsClient, type AdminUserSummary } from "../api/hmsClient";
import type { AdminUserRecord } from "../domain/types";
import { friendlyApiError } from "../components/interaction/friendlyApiError";
import { DEFAULT_USERS_QUERY, type UsersRouteQuery } from "../routing/routeTypes";

export interface UserFilters {
  search: string;
  role: string;
  accountStatus: UsersRouteQuery["status"];
  mfa: UsersRouteQuery["mfa"];
  customerId: string;
  sort: UsersRouteQuery["sort"];
}

const SEARCH_DELAY_MS = 300;

export function hasActiveFilters(filters: UserFilters): boolean {
  return Boolean(filters.search.trim() || filters.role || filters.accountStatus || filters.mfa || filters.customerId);
}

/** Where the directory's query lives. Given by the URL when there is one; otherwise the hook keeps its own. */
export interface UsersRouteControl {
  query: UsersRouteQuery;
  onChange: (patch: Partial<UsersRouteQuery>, options?: { replace?: boolean }) => void;
}

/**
 * The user directory as the server describes it: one page of the users that match the query, the size
 * of the whole matching set, and directory-wide counts that ignore both. The query is the URL's.
 */
export function useUserDirectory(enabled: boolean, control?: UsersRouteControl) {
  const [localQuery, setLocalQuery] = useState<UsersRouteQuery>(DEFAULT_USERS_QUERY);
  const query = control?.query ?? localQuery;
  const live = useRef({ control, query });
  useEffect(() => {
    live.current = { control, query };
  });
  const change = useCallback((patch: Partial<UsersRouteQuery>, options?: { replace?: boolean }) => {
    const owner = live.current.control;
    if (owner) owner.onChange(patch, options);
    else setLocalQuery((current) => ({ ...current, ...patch }));
  }, []);

  const [users, setUsers] = useState<AdminUserRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<AdminUserSummary | null>(null);
  const [reloads, setReloads] = useState(0);
  const latest = useRef(0);

  // Typing is held in the box at once and reaches the query (and so the URL) after a short pause, as a
  // replacement of the current history entry, so four keystrokes are not four Back presses.
  const [searchText, setSearchText] = useState(query.q);
  const lastSent = useRef(query.q);
  useEffect(() => {
    if (query.q !== lastSent.current) {
      // The query changed from outside (Back/Forward, a link, Clear): the box follows it.
      lastSent.current = query.q;
      setSearchText(query.q);
    }
  }, [query.q]);
  useEffect(() => {
    const wanted = searchText.trim();
    if (wanted === live.current.query.q) return;
    const timer = window.setTimeout(() => {
      lastSent.current = wanted;
      change({ q: wanted, page: 1 }, { replace: true });
    }, wanted === "" ? 0 : SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [searchText, change]);

  const { q, role, status: accountStatus, mfa, customer, sort, page, pageSize } = query;
  useEffect(() => {
    if (!enabled) return;
    const request = ++latest.current;
    setStatus("loading");
    createHmsClient()
      .listAdminUsers({
        search: q,
        role,
        accountStatus: accountStatus || undefined,
        mfa: mfa || undefined,
        customerId: customer,
        sort,
        limit: pageSize,
        offset: (page - 1) * pageSize
      })
      .then((result) => {
        if (request !== latest.current) return;
        // Removing the last row of the last page (or a filter narrowing the set) can leave this page
        // past the end: go to the last page that exists, which also corrects the URL, and ask again.
        const lastPage = Math.max(1, Math.ceil(result.total / pageSize));
        if (page > lastPage) {
          change({ page: lastPage }, { replace: true });
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
  }, [enabled, q, role, accountStatus, mfa, customer, sort, page, pageSize, reloads, change]);

  const reloadSummary = useCallback(() => {
    // Counts are secondary: if they cannot be refreshed the last good numbers stay.
    createHmsClient().getAdminUserSummary().then(setSummary).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (enabled) reloadSummary();
  }, [enabled, reloadSummary]);

  const filters: UserFilters = { search: searchText, role, accountStatus, mfa, customerId: customer, sort };

  return {
    filters,
    changeFilters: (next: Partial<UserFilters>) => {
      if (next.search !== undefined) setSearchText(next.search);
      const patch: Partial<UsersRouteQuery> = {};
      if (next.role !== undefined) patch.role = next.role;
      if (next.accountStatus !== undefined) patch.status = next.accountStatus;
      if (next.mfa !== undefined) patch.mfa = next.mfa;
      if (next.customerId !== undefined) patch.customer = next.customerId;
      if (next.sort !== undefined) patch.sort = next.sort;
      // Any change to what is asked for starts again from the first page.
      if (Object.keys(patch).length > 0) change({ ...patch, page: 1 });
    },
    clearFilters: () => {
      lastSent.current = "";
      setSearchText("");
      change({ q: "", role: "", status: "", mfa: "", customer: "", page: 1 });
    },
    page,
    setPage: (next: number) => change({ page: next }),
    pageSize,
    setPageSize: (size: number) => change({ pageSize: size, page: 1 }),
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
