import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createHmsClient } from "../api/hmsClient";
import { useActionNotice } from "../components/interaction/ActionNotice";
import { friendlyApiError } from "../components/interaction/friendlyApiError";
import { customerLabel } from "../utils/identity";
import type { CustomerFormValues, CustomerRecord, CustomerSummary } from "../domain/types";

export type CustomerLifecycleFilter = "active" | "archived" | "all";
export type CustomerLifecycleAction = "archive" | "restore" | "delete";

const SEARCH_DELAY_MS = 250;

/**
 * Customers are searched, filtered and paged on the server, so a search or a total always describes the
 * whole system rather than the first page that happened to load. `summary` carries the system totals.
 *
 * `onSelectedChange` lets the owner of the URL decide what selecting (or closing) a customer does;
 * the selection itself then comes back in through `setSelectedId`. Without it the hook keeps its own.
 * `active` is whether the Customers workspace is on screen: each time it becomes so, the figures are re-read.
 */
export function useCustomerWorkspace(options: { active?: boolean; onSelectedChange?: (id: string | null) => void } = {}) {
  const { active = false, onSelectedChange } = options;
  const [pageItems, setPageItems] = useState<CustomerRecord[]>([]);
  // Customers read individually (a deep link to one that is not on this page) and the one just saved.
  const [extraCustomers, setExtraCustomers] = useState<CustomerRecord[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [summary, setSummary] = useState<CustomerSummary | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQueryState] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [lifecycle, setLifecycleState] = useState<CustomerLifecycleFilter>("active");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(10);
  const [reloadToken, setReloadToken] = useState(0);
  const [activeTab, setActiveTab] = useState("Overview");
  const [isFormOpen, setFormOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<CustomerRecord | null>(null);
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lifecycleTarget, setLifecycleTarget] = useState<{ action: CustomerLifecycleAction; customer: CustomerRecord } | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [isChangingLifecycle, setChangingLifecycle] = useState(false);
  const { notice, notify, clear: dismissNotice } = useActionNotice();

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // The search, filter and page the list on screen answers. A failed re-read of that same list keeps it;
  // a failure for anything else must not leave the old list standing as if it answered the new question.
  const shownKey = useRef<string | null>(null);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    const client = createHmsClient();
    const key = JSON.stringify([debouncedQuery, lifecycle, page, pageSize]);
    void client.listCustomers({ search: debouncedQuery, lifecycle, limit: pageSize, offset: (page - 1) * pageSize, sort: "name" })
      .then((result) => {
        if (!current) return;
        shownKey.current = key;
        setPageItems(result.items);
        setTotalCount(result.total);
      })
      .catch(() => {
        if (current && shownKey.current !== key) setError("Unable to load customer records from the HMS API.");
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [debouncedQuery, lifecycle, page, pageSize, reloadToken]);

  useEffect(() => {
    let current = true;
    void createHmsClient().getCustomerSummary()
      .then((result) => { if (current) setSummary(result); })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [reloadToken]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);
  /** Counts live in the customer list, but assets are created and moved elsewhere, so entering Customers re-reads them. */
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) reload();
    wasActive.current = active;
  }, [active, reload]);

  const customers = useMemo(() => {
    const onPage = new Set(pageItems.map((customer) => customer.id));
    return [...pageItems, ...extraCustomers.filter((customer) => !onPage.has(customer.id))];
  }, [extraCustomers, pageItems]);

  const selectedCustomer = selectedId ? customers.find((customer) => customer.id === selectedId) ?? null : null;

  function select(id: string | null) { if (onSelectedChange) onSelectedChange(id); else setSelectedId(id); }
  const addCustomer = useCallback((customer: CustomerRecord) => {
    setExtraCustomers((current) => (current.some((item) => item.id === customer.id) ? current : [customer, ...current]));
  }, []);
  /** Replaces a customer wherever it is held, after something about it (a location, a contact, its status) changed. */
  const replaceCustomer = useCallback((updated: CustomerRecord) => {
    setPageItems((current) => current.map((customer) => customer.id === updated.id ? updated : customer));
    setExtraCustomers((current) => current.some((customer) => customer.id === updated.id)
      ? current.map((customer) => customer.id === updated.id ? updated : customer)
      : [updated, ...current]);
  }, []);
  function setQuery(value: string) { setQueryState(value); setPage(1); }
  function setLifecycle(value: CustomerLifecycleFilter) { setLifecycleState(value); setPage(1); }
  function setPageSize(size: number) { setPageSizeState(size); setPage(1); }
  function closeDetail() { select(null); }
  function closeCustomerForm() { setEditingCustomer(null); setFormOpen(false); }
  function openCreateCustomer() { setEditingCustomer(null); setFormOpen(true); }
  function openEditCustomer(customer: CustomerRecord) { setEditingCustomer(customer); setFormOpen(true); }
  function selectCustomer(id: string) { select(id); setActiveTab("Overview"); }

  async function saveCustomer(values: CustomerFormValues) {
    const client = createHmsClient();
    const saved = editingCustomer
      ? await client.updateCustomer(editingCustomer.id, values, editingCustomer.etag)
      : await client.createCustomer(values);
    replaceCustomer(saved);
    if (!editingCustomer) {
      setQueryState("");
      setDebouncedQuery("");
      setLifecycleState("active");
      setPage(1);
    }
    reload();
    select(saved.id);
    closeCustomerForm();
    notify({ kind: "success", message: `${customerLabel(saved)} ${editingCustomer ? "updated" : "created"} successfully.`, title: "Customer saved" });
  }

  function requestLifecycle(action: CustomerLifecycleAction, customer: CustomerRecord) {
    setLifecycleError(null);
    setLifecycleTarget({ action, customer });
  }
  function cancelLifecycle() { if (!isChangingLifecycle) { setLifecycleTarget(null); setLifecycleError(null); } }
  async function confirmLifecycle() {
    if (!lifecycleTarget || isChangingLifecycle) return;
    const { action, customer } = lifecycleTarget;
    setChangingLifecycle(true);
    setLifecycleError(null);
    try {
      const client = createHmsClient();
      if (action === "delete") {
        await client.deleteCustomer(customer.id, customer.etag);
        setPageItems((current) => current.filter((item) => item.id !== customer.id));
        setExtraCustomers((current) => current.filter((item) => item.id !== customer.id));
        select(null);
      } else {
        replaceCustomer(action === "archive" ? await client.archiveCustomer(customer.id) : await client.restoreCustomer(customer.id));
      }
      reload();
      setLifecycleTarget(null);
      const done = { archive: "archived", restore: "restored", delete: "deleted" }[action];
      notify({ kind: "success", message: `${customerLabel(customer)} was ${done}.`, title: `Customer ${done}` });
    } catch (reason) {
      // Nothing changed on the server, so nothing changes here.
      setLifecycleError(friendlyApiError(reason, { fallback: `${customerLabel(customer)} could not be ${action}d. Try again.` }).message);
    } finally {
      setChangingLifecycle(false);
    }
  }

  return {
    activeTab, addCustomer, cancelLifecycle, closeCustomerForm, closeDetail, confirmLifecycle, customers, dismissNotice,
    editingCustomer, error, isChangingLifecycle, isFormOpen, isLoading, lifecycle, lifecycleError, lifecycleTarget, notice, openCreateCustomer,
    openEditCustomer, page, pageSize, query, refreshMetrics: reload, replaceCustomer, requestLifecycle, saveCustomer, selectCustomer,
    selectedCustomer, setActiveTab, setLifecycle, setPage, setPageSize, setQuery, setSelectedId, summary, totalCount, visibleCustomers: pageItems
  };
}
