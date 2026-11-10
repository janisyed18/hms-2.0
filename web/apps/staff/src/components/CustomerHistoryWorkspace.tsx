import { Building2, ChevronRight, Download, Eye, Search, ShieldCheck, Trash2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { createHmsClient } from "../api/hmsClient";
import type { CustomerDeletionDetail, CustomerDeletionRecord, CustomerDeletionSummary } from "../domain/types";
import { formatDateTime } from "../utils/dateTime";
import { PaginationControls } from "./Pagination";
import { WorkspaceState } from "./WorkspaceState";
import { ActionButton } from "./interaction/ActionButton";
import { ActionNotice } from "./interaction/ActionNotice";
import { friendlyApiError } from "./interaction/friendlyApiError";

type RangeKey = "all" | "30d" | "12m";
const RANGES: { key: RangeKey; label: string }[] = [
  { key: "all", label: "All Time" },
  { key: "30d", label: "Last 30 days" },
  { key: "12m", label: "Last 12 months" }
];

function fromDateFor(range: RangeKey): string | undefined {
  if (range === "all") return undefined;
  const date = new Date();
  if (range === "30d") date.setUTCDate(date.getUTCDate() - 30);
  else date.setUTCFullYear(date.getUTCFullYear() - 1);
  return date.toISOString().slice(0, 10);
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Deleted Customers (History): the read-only archive of customers removed from active HMS. Only Super Admins
 * are offered it, and the server refuses everyone else. Nothing here edits, restores or purges a record.
 */
export function CustomerHistoryWorkspace({ initialBatchId, onBack }: { initialBatchId?: string | null; onBack: () => void }) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [range, setRange] = useState<RangeKey>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [items, setItems] = useState<CustomerDeletionSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [openId, setOpenId] = useState<string | null>(initialBatchId ?? null);

  useEffect(() => {
    const timer = window.setTimeout(() => { setDebounced(query); setPage(1); }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    createHmsClient()
      .listCustomerDeletions({ q: debounced, fromDate: fromDateFor(range), limit: pageSize, offset: (page - 1) * pageSize })
      .then((result) => {
        if (!active) return;
        setItems(result.items);
        setTotal(result.total);
        setError(null);
      })
      .catch((reason: unknown) => active && setError(friendlyApiError(reason, { fallback: "Deleted customers could not be loaded. Try again." }).message))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [debounced, range, page, pageSize, reload]);

  const filtered = debounced.trim() !== "" || range !== "all";
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <section aria-label="Deleted customers" className="management-workspace customer-history">
      <nav aria-label="Breadcrumb" className="customer-history__crumbs">
        <button className="link-button" onClick={onBack} type="button">Customers</button>
        <ChevronRight aria-hidden="true" size={14} />
        <span aria-current="page">Deleted Customers (History)</span>
      </nav>
      <header className="customer-history__header">
        <span aria-hidden="true" className="dialog-icon"><Trash2 size={22} /></span>
        <div>
          <h1>Deleted Customers (History)</h1>
          <p>Customers and their records that have been removed from active HMS. Data is read-only and retained for audit and compliance.</p>
        </div>
      </header>
      <div className="customer-console-toolbar">
        <label className="field search-field">
          <Search aria-hidden="true" size={17} />
          <span className="sr-only">Search deleted customers</span>
          <input
            aria-label="Search deleted customers"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search deleted customers…"
            value={query}
          />
          {query ? (
            <button aria-label="Clear search" className="search-clear" onClick={() => setQuery("")} type="button">
              <X aria-hidden="true" size={15} />
            </button>
          ) : null}
        </label>
        <label className="field customer-history__range">
          <span className="sr-only">Deleted in</span>
          <select aria-label="Deleted in" onChange={(event) => { setRange(event.target.value as RangeKey); setPage(1); }} value={range}>
            {RANGES.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
          </select>
        </label>
      </div>

      {error ? (
        <WorkspaceState
          action={<ActionButton onClick={() => setReload((value) => value + 1)} variant="secondary">Try again</ActionButton>}
          title="Deleted customers unavailable"
          tone="error"
        >
          {error}
        </WorkspaceState>
      ) : loading && items.length === 0 ? (
        <div aria-label="Loading deleted customers" className="user-skeleton" role="status"><i /><i /><i /></div>
      ) : items.length === 0 ? (
        <WorkspaceState title={filtered ? "No deleted customers match" : "No customers have been deleted"} tone="empty">
          {filtered
            ? "Try a different name, deletion ID or date range."
            : "When a Super Admin deletes a customer, a read-only copy of it and its records appears here."}
        </WorkspaceState>
      ) : (
        <div aria-busy={loading || undefined} className="table-frame customer-history__table">
          <table aria-label="Deleted customers" className="console-table">
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th scope="col">Records</th>
                <th scope="col">Deleted On</th>
                <th scope="col">Deleted By</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <span className="customer-history__identity">
                      <Building2 aria-hidden="true" size={18} />
                      <span><strong>{item.customerName}</strong><small>{item.customerCode} · {item.deletionNumber}</small></span>
                    </span>
                  </td>
                  <td><span className="customer-delete__count">{item.totalRecords}</span></td>
                  <td>{formatDateTime(item.deletedAt)}</td>
                  <td>{item.actorName}</td>
                  <td>
                    <button aria-label={`View records for ${item.customerName}`} className="secondary-button compact-action" onClick={() => setOpenId(item.id)} type="button">
                      <Eye aria-hidden="true" size={15} /> View Records
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <PaginationControls
            label="Deleted customers"
            onPageChange={setPage}
            onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
            page={page}
            pageCount={pageCount}
            pageSize={pageSize}
            start={(page - 1) * pageSize}
            total={total}
          />
        </div>
      )}
      {openId ? <DeletionRecordsDialog batchId={openId} onClose={() => setOpenId(null)} /> : null}
    </section>
  );
}

/** One deletion: what was archived, the certificate evidence, and every snapshotted record. */
function DeletionRecordsDialog({ batchId, onClose }: { batchId: string; onClose: () => void }) {
  const ids = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<CustomerDeletionDetail | null>(null);
  const [records, setRecords] = useState<CustomerDeletionRecord[]>([]);
  const [recordTotal, setRecordTotal] = useState(0);
  const [recordType, setRecordType] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [verified, setVerified] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    createHmsClient().getCustomerDeletion(batchId)
      .then((result) => active && setDetail(result))
      .catch((reason: unknown) => active && setError(friendlyApiError(reason, { fallback: "This deletion record could not be loaded." }).message));
    return () => { active = false; };
  }, [batchId]);

  useEffect(() => {
    let active = true;
    createHmsClient().listCustomerDeletionRecords(batchId, { recordType, limit: 25 })
      .then((result) => { if (active) { setRecords(result.items); setRecordTotal(result.total); } })
      .catch((reason: unknown) => active && setError(friendlyApiError(reason, { fallback: "The archived records could not be loaded." }).message));
    return () => { active = false; };
  }, [batchId, recordType]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
    return () => { if (opener && document.contains(opener)) opener.focus(); };
  }, []);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const next = await createHmsClient().listCustomerDeletionRecords(batchId, { recordType, limit: 25, offset: records.length });
      setRecords((current) => [...current, ...next.items]);
    } catch (reason) {
      setError(friendlyApiError(reason, { fallback: "More records could not be loaded." }).message);
    } finally {
      setLoadingMore(false);
    }
  }

  async function download(evidenceId: string, label: string, contentType: string) {
    setDownloading(evidenceId);
    setDownloadError(null);
    try {
      const blob = await createHmsClient().downloadCustomerDeletionEvidence(batchId, evidenceId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${label}${contentType === "application/pdf" ? ".pdf" : ""}`;
      anchor.click();
      URL.revokeObjectURL(url);
      setVerified(label);
    } catch (reason) {
      setDownloadError(friendlyApiError(reason, { fallback: "The archived file could not be retrieved." }).message);
    } finally {
      setDownloading(null);
    }
  }

  return createPortal(
    <div className="confirm-backdrop confirm-backdrop--elevated" role="presentation">
      <div
        aria-labelledby={`${ids}-title`}
        aria-modal="true"
        className="confirm-dialog customer-history-dialog"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") onClose();
        }}
        ref={dialog}
        role="dialog"
      >
        <header className="change-inspector__header">
          <span aria-hidden="true" className="dialog-icon"><ShieldCheck size={20} /></span>
          <div>
            <h2 id={`${ids}-title`}>{detail ? `${detail.customerName} · ${detail.deletionNumber}` : "Deleted customer"}</h2>
            {detail ? <p className="field-hint">Read-only archive. Deleted {formatDateTime(detail.deletedAt)} by {detail.actorName}.</p> : null}
          </div>
          <button aria-label="Close" className="dialog-close" data-initial-focus onClick={onClose} type="button"><X aria-hidden="true" size={18} /></button>
        </header>
        {error ? <ActionNotice kind="error" title="Could not load">{error}</ActionNotice> : null}
        {!detail && !error ? <div aria-label="Loading deleted customer" className="user-skeleton" role="status"><i /><i /></div> : null}
        {detail ? (
          <>
            <dl className="removal-facts">
              <div><dt>Customer code</dt><dd>{detail.customerCode}</dd></div>
              <div><dt>Related records archived</dt><dd>{detail.totalRecords}</dd></div>
              {detail.reason ? <div><dt>Reason</dt><dd>{detail.reason}</dd></div> : null}
              {detail.retentionUntil ? <div><dt>Evidence retained until</dt><dd>{detail.retentionUntil}</dd></div> : null}
              {detail.manifestSha256 ? <div><dt>Archive fingerprint</dt><dd className="mono" title={detail.manifestSha256}>{detail.manifestSha256.slice(0, 16)}…</dd></div> : null}
            </dl>
            {detail.retentionBasis ? <p className="field-hint">{detail.retentionBasis}</p> : null}

            <section aria-labelledby={`${ids}-evidence`}>
              <h3 id={`${ids}-evidence`}>Certificate and photo evidence</h3>
              {detail.evidence.length === 0 ? (
                <p className="field-hint">No files were attached to this customer's records.</p>
              ) : (
                <ul className="customer-history__evidence">
                  {detail.evidence.map((item) => (
                    <li key={item.id}>
                      <span><strong>{item.label}</strong><small>{item.kind === "CERTIFICATE_PDF" ? "Certificate PDF" : "Inspection photo"} · {formatBytes(item.sizeBytes)} · SHA-256 {item.sha256.slice(0, 12)}…</small></span>
                      <ActionButton onClick={() => void download(item.id, item.label, item.contentType)} pending={downloading === item.id} pendingLabel="Retrieving…" variant="secondary">
                        <Download aria-hidden="true" size={15} /> Download
                      </ActionButton>
                    </li>
                  ))}
                </ul>
              )}
              {verified ? <p className="field-hint" role="status">{verified} was retrieved and its hash verified.</p> : null}
              {downloadError ? <ActionNotice kind="error" title="Could not retrieve file">{downloadError}</ActionNotice> : null}
            </section>

            <section aria-labelledby={`${ids}-records`}>
              <header className="customer-history__records-head">
                <h3 id={`${ids}-records`}>Archived records ({recordTotal})</h3>
                <label className="field">
                  <span className="sr-only">Record type</span>
                  <select aria-label="Record type" onChange={(event) => setRecordType(event.target.value)} value={recordType}>
                    <option value="">All record types</option>
                    <option value="customers">Customer</option>
                    {detail.recordCounts.map((item) => <option key={item.kind} value={item.kind}>{item.label} ({item.count})</option>)}
                  </select>
                </label>
              </header>
              <ul className="customer-history__records">
                {records.map((record) => (
                  <li key={record.id}>
                    <details>
                      <summary><strong>{record.label}</strong><small>{record.typeLabel}</small></summary>
                      <pre aria-label={`${record.label} snapshot`}>{JSON.stringify(record.payload, null, 2)}</pre>
                    </details>
                  </li>
                ))}
              </ul>
              {records.length < recordTotal ? (
                <ActionButton onClick={() => void loadMore()} pending={loadingMore} pendingLabel="Loading…" variant="secondary">Load more</ActionButton>
              ) : null}
            </section>
          </>
        ) : null}
      </div>
    </div>,
    document.body
  );
}
