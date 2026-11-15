import { Boxes, Check, Search, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { createHmsClient } from "../api/hmsClient";
import type { AssetRecord } from "../domain/types";
import { ActionButton } from "./interaction/ActionButton";
import { assetLabel } from "../utils/identity";

const PAGE_SIZE = 25;

interface Page {
  items: AssetRecord[];
  total: number;
  loading: boolean;
  error: string | null;
}

const EMPTY: Page = { items: [], total: 0, loading: false, error: null };

/**
 * Picks the assets one booking covers.
 *
 * Every read is scoped to the chosen customer **and** location, so nothing from another
 * customer, or from the same customer's other sites, can appear here or be selected —
 * including by "Select all", which asks the server for that same scope rather than
 * ticking whatever happens to be on screen. Searching narrows within that scope on the
 * server, so a site with hundreds of assets is found by typing rather than scrolling.
 */
export function BookingAssetPicker({
  customerId,
  customerName,
  locationId,
  locationName,
  onClose,
  onConfirm,
  open,
  selected
}: {
  customerId: string;
  customerName: string;
  locationId: string;
  locationName: string;
  onClose: () => void;
  /** The chosen assets, in the order they were picked, once the person is done. */
  onConfirm: (assets: AssetRecord[]) => void;
  open: boolean;
  selected: AssetRecord[];
}) {
  if (!open) return null;
  return (
    <PickerBody
      customerId={customerId}
      customerName={customerName}
      locationId={locationId}
      locationName={locationName}
      onClose={onClose}
      onConfirm={onConfirm}
      selected={selected}
    />
  );
}

function PickerBody({
  customerId,
  customerName,
  locationId,
  locationName,
  onClose,
  onConfirm,
  selected
}: Omit<Parameters<typeof BookingAssetPicker>[0], "open">) {
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const dialog = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<Page>(EMPTY);
  const [bulkPending, setBulkPending] = useState(false);
  // Kept by id so a selection survives searching away from it and back again, and so the
  // count can name assets that are not on the current page of results.
  const [picked, setPicked] = useState<Record<string, AssetRecord>>(
    Object.fromEntries(selected.map((asset) => [asset.id, asset]))
  );
  const [order, setOrder] = useState<string[]>(selected.map((asset) => asset.id));

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    search.current?.focus();
    return () => { if (opener && document.contains(opener)) opener.focus(); };
  }, []);

  // Typing narrows the list on the server, debounced so a search is one request rather
  // than one per keystroke. Clearing it reads the site's assets again straight away.
  useEffect(() => {
    let active = true;
    setPage((current) => ({ ...current, loading: true, error: null }));
    const timer = window.setTimeout(() => {
      createHmsClient()
        .listAssets({ customerId, locationId, search: query, newWorkOnly: true, sort: "asset_number", limit: PAGE_SIZE, offset: 0 })
        .then((result) => { if (active) setPage({ items: result.items, total: result.total, loading: false, error: null }); })
        .catch(() => { if (active) setPage({ ...EMPTY, error: "Assets could not be loaded." }); });
    }, query.trim() ? 250 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [customerId, locationId, query]);

  async function showMore() {
    setPage((current) => ({ ...current, loading: true, error: null }));
    try {
      const next = await createHmsClient().listAssets({
        customerId, locationId, search: query, newWorkOnly: true, sort: "asset_number", limit: PAGE_SIZE, offset: page.items.length
      });
      setPage((current) => ({
        items: [...current.items, ...next.items.filter((item) => !current.items.some((known) => known.id === item.id))],
        total: next.total,
        loading: false,
        error: null
      }));
    } catch {
      setPage((current) => ({ ...current, loading: false, error: "More assets could not be loaded." }));
    }
  }

  function toggle(asset: AssetRecord) {
    setPicked((current) => {
      const next = { ...current };
      if (next[asset.id]) delete next[asset.id];
      else next[asset.id] = asset;
      return next;
    });
    setOrder((current) => (current.includes(asset.id) ? current.filter((item) => item !== asset.id) : [...current, asset.id]));
  }

  /** Everything the current search matches, asked of the server rather than read off the page. */
  async function selectAllMatching() {
    setBulkPending(true);
    try {
      const all = await createHmsClient().listAllAssets({ customerId, locationId, search: query, newWorkOnly: true, sort: "asset_number" });
      setPicked((current) => ({ ...current, ...Object.fromEntries(all.items.map((asset) => [asset.id, asset])) }));
      setOrder((current) => [...current, ...all.items.map((asset) => asset.id).filter((assetId) => !current.includes(assetId))]);
    } catch {
      setPage((current) => ({ ...current, error: "Every matching asset could not be selected." }));
    } finally {
      setBulkPending(false);
    }
  }

  function clearAll() {
    setPicked({});
    setOrder([]);
  }

  const chosen = order.map((assetId) => picked[assetId]).filter(Boolean);
  const searching = query.trim().length > 0;
  const countLabel = page.loading && page.items.length === 0
    ? "Searching assets"
    : searching
      ? `${page.total} matching${page.total > page.items.length ? `, ${page.items.length} shown` : ""}`
      : `${page.total} asset${page.total === 1 ? "" : "s"} at this location${page.total > page.items.length ? `, ${page.items.length} shown` : ""}`;

  return createPortal(
    <div className="confirm-backdrop confirm-backdrop--elevated" role="presentation">
      <div
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="confirm-dialog asset-picker"
        onKeyDown={(event) => {
          // Nothing behind a modal dialog should react to its keys (the booking drawer closes on Escape).
          event.stopPropagation();
          if (event.key === "Escape") onClose();
          if (event.key !== "Tab" || !dialog.current) return;
          const controls = Array.from(dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)"));
          if (controls.length === 0) return;
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }}
        ref={dialog}
        role="dialog"
      >
        <header className="asset-picker__header">
          <span aria-hidden="true" className="dialog-icon"><Boxes size={20} /></span>
          <div>
            <h2 id={titleId}>Choose assets</h2>
            <p className="field-hint" id={descriptionId}>
              Only assets at {locationName} for {customerName} can be chosen. One booking is one visit to one site.
            </p>
          </div>
          <button aria-label="Close dialog" className="dialog-close" onClick={onClose} type="button">
            <X aria-hidden="true" size={18} />
          </button>
        </header>

        <div className="asset-picker__search">
          <Search aria-hidden="true" size={16} />
          <input
            aria-label="Search assets"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by asset number, name or tag"
            ref={search}
            type="search"
            value={query}
          />
        </div>

        <div className="asset-picker__toolbar">
          <p className="field-hint" role="status">
            {countLabel}
            {chosen.length ? ` · ${chosen.length} selected` : ""}
          </p>
          <span className="row-actions">
            <button className="secondary-button" disabled={bulkPending || page.total === 0} onClick={() => void selectAllMatching()} type="button">
              {bulkPending ? "Selecting…" : searching ? `Select all ${page.total} matching` : "Select all"}
            </button>
            <button className="ghost-button" disabled={chosen.length === 0} onClick={clearAll} type="button">Clear all</button>
          </span>
        </div>

        {page.error ? <p className="field-error" role="alert">{page.error}</p> : null}

        <div className="asset-picker__list">
          {!page.loading && !page.error && page.items.length === 0 ? (
            <p className="field-hint">
              {searching ? `No assets at ${locationName} match “${query.trim()}”.` : "No assets are assigned to this location."}
            </p>
          ) : null}
          {page.items.map((asset) => (
            <label className="checkbox-field" key={asset.id}>
              <input checked={Boolean(picked[asset.id])} onChange={() => toggle(asset)} type="checkbox" />
              <span>{assetLabel(asset)}</span>
            </label>
          ))}
          {page.items.length < page.total ? (
            <button className="secondary-button" disabled={page.loading} onClick={() => void showMore()} type="button">
              {page.loading ? "Loading…" : "Show more assets"}
            </button>
          ) : null}
        </div>

        <footer className="asset-picker__footer">
          <button className="action-button action-button--ghost" onClick={onClose} type="button">Cancel</button>
          <ActionButton onClick={() => onConfirm(chosen)} variant="primary">
            <Check aria-hidden="true" size={15} /> {chosen.length ? `Use ${chosen.length} asset${chosen.length === 1 ? "" : "s"}` : "Use no assets"}
          </ActionButton>
        </footer>
      </div>
    </div>,
    document.body
  );
}
