import { ArrowLeftRight, Check, CalendarDays, ChevronDown, MapPin, Search, TriangleAlert, User, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { InspectorAvailability } from "../../domain/types";
import { ActionButton } from "./ActionButton";
import { ActionNotice } from "./ActionNotice";

export interface InspectorChoice {
  id: string;
  name: string;
}

const BUSY_MESSAGE = "This inspector is already scheduled during the selected time. Choose another inspector or reschedule the inspection.";
const ASSET_MESSAGE = "An asset on this booking is already scheduled during this time, so no inspector can take it until it is rescheduled.";
const UNVERIFIED_MESSAGE = "We could not check this inspector's availability, so the change cannot be saved yet.";

/** What the server said about one inspector for this booking, shown as a chip in the list. */
type Standing = "checking" | "available" | "busy" | "unknown";
/** Only this many replacements are checked up front; any other is still checked when chosen. */
const PREVIEW_LIMIT = 12;

type Check =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "failed" }
  | { state: "done"; result: InspectorAvailability };

/**
 * The one way to change who inspects a confirmed booking, used by the Inspections workspace and the
 * Scheduling drawer. Choosing a replacement asks the server whether that inspector is free for the
 * booking's existing time; only a verified "Available" can be saved, and the check is repeated on
 * Save. `onSave` resolves to null once saved, or to the message to show when the server refused it;
 * a refusal keeps the dialog open with the chosen replacement still selected.
 */
export function ChangeInspectorDialog({
  checkAvailability,
  currentInspectorId,
  currentInspectorName,
  inspectors,
  onClose,
  onSave,
  open,
  siteName,
  whenLabel
}: {
  /** Asks the server about one replacement. A rejection means "could not verify". */
  checkAvailability: (inspectorId: string) => Promise<InspectorAvailability>;
  currentInspectorId: string | null;
  currentInspectorName: string;
  inspectors: InspectorChoice[];
  onClose: () => void;
  onSave: (inspectorId: string) => Promise<string | null>;
  open: boolean;
  siteName: string;
  /** The booking's date and time, already formatted for its site. */
  whenLabel?: string;
}) {
  if (!open) return null;
  return (
    <DialogBody
      checkAvailability={checkAvailability}
      currentInspectorId={currentInspectorId}
      currentInspectorName={currentInspectorName}
      inspectors={inspectors}
      onClose={onClose}
      onSave={onSave}
      siteName={siteName}
      whenLabel={whenLabel}
    />
  );
}

function StandingChip({ standing }: { standing: Standing | undefined }) {
  // Each state has its own icon and words, so it never depends on colour alone.
  if (standing === "available") return <span className="change-inspector__chip"><Check aria-hidden="true" size={12} /> Available</span>;
  if (standing === "busy") return <span className="change-inspector__chip change-inspector__chip--busy"><TriangleAlert aria-hidden="true" size={12} /> Busy at this time</span>;
  if (standing === "checking") return <span className="change-inspector__chip change-inspector__chip--info">Checking…</span>;
  return null;
}

function DialogBody({
  checkAvailability,
  currentInspectorId,
  currentInspectorName,
  inspectors,
  onClose,
  onSave,
  siteName,
  whenLabel
}: Omit<Parameters<typeof ChangeInspectorDialog>[0], "open">) {
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const dialog = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [listOpen, setListOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);
  const [standing, setStanding] = useState<Record<string, Standing>>({});
  const latest = useRef(0);
  const [choice, setChoice] = useState("");
  const [check, setCheck] = useState<Check>({ state: "idle" });
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const replacements = inspectors.filter((inspector) => inspector.id !== currentInspectorId);
  const nameOf = (inspectorId: string) => inspectors.find((inspector) => inspector.id === inspectorId)?.name ?? "Inspector";

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    trigger.current?.focus();
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  // Ask about the first few replacements up front so the list can say who is free; a failure shows no chip, never "Available".
  useEffect(() => {
    let alive = true;
    const ids = replacements.slice(0, PREVIEW_LIMIT).map((inspector) => inspector.id);
    setStanding(Object.fromEntries(ids.map((inspectorId) => [inspectorId, "checking" as Standing])));
    for (const inspectorId of ids) {
      checkAvailability(inspectorId).then(
        (result) => alive && setStanding((current) => ({ ...current, [inspectorId]: result.eligible && result.available === true ? "available" : result.eligible && result.available === false ? "busy" : "unknown" })),
        () => alive && setStanding((current) => ({ ...current, [inspectorId]: "unknown" }))
      );
    }
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Asks the server; only the newest question may change what is shown. */
  async function verify(inspectorId: string): Promise<InspectorAvailability | null> {
    const ticket = ++latest.current;
    setCheck({ state: "checking" });
    try {
      const result = await checkAvailability(inspectorId);
      if (ticket !== latest.current) return null;
      setCheck({ state: "done", result });
      return result;
    } catch {
      if (ticket !== latest.current) return null;
      setCheck({ state: "failed" });
      return null;
    }
  }

  const shown = replacements.filter((inspector) => inspector.name.toLowerCase().includes(filter.trim().toLowerCase()));
  useEffect(() => {
    // Keep the arrow-key position visible in a long list.
    if (listOpen && shown[active]) document.getElementById(`${id}-opt-${shown[active].id}`)?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, listOpen]);
  function openList() {
    setListOpen(true);
    setFilter("");
    setActive(0);
    setTimeout(() => search.current?.focus(), 0);
  }
  function closeList() {
    setListOpen(false);
    trigger.current?.focus();
  }
  function pick(inspectorId: string) {
    setListOpen(false);
    trigger.current?.focus();
    choose(inspectorId);
  }

  function choose(inspectorId: string) {
    setChoice(inspectorId);
    setRefusal(null);
    if (!inspectorId) {
      latest.current += 1;
      setCheck({ state: "idle" });
      return;
    }
    void verify(inspectorId);
  }

  async function save() {
    if (pending || !choice) return;
    setPending(true);
    setRefusal(null);
    // Someone may have booked this inspector since the first check, so ask again before changing anything.
    const fresh = await verify(choice);
    if (!fresh || fresh.available !== true) {
      setPending(false);
      return;
    }
    const failure = await onSave(choice);
    setPending(false);
    // On success the caller closes this dialog by leaving `open`; on refusal it stays, selection intact.
    if (failure) setRefusal(failure);
  }

  const result = check.state === "done" ? check.result : null;
  const verified = result?.available === true;
  const blocked = result !== null && (!result.eligible || result.available === false);
  const suggestions = (result?.suggestedInspectorIds ?? []).filter((inspectorId) => inspectorId !== choice && inspectorId !== currentInspectorId).slice(0, 3);

  return createPortal(
    <div className="confirm-backdrop confirm-backdrop--elevated" role="presentation">
      <div
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="confirm-dialog change-inspector"
        onKeyDown={(event) => {
          // Nothing behind a modal dialog should react to its keys (a drawer closes on Escape).
          event.stopPropagation();
          if (event.key === "Escape" && !pending) {
            if (listOpen) closeList();
            else onClose();
          }
          if (event.key !== "Tab" || !dialog.current) return;
          const controls = Array.from(dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)"));
          if (controls.length === 0) return;
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        ref={dialog}
        role="dialog"
      >
        <header className="change-inspector__header">
          <span aria-hidden="true" className="dialog-icon"><ArrowLeftRight size={20} /></span>
          <div>
            <h2 id={titleId}>Change inspector</h2>
            <p className="field-hint" id={descriptionId}>
              The appointment date, time, location and assets stay the same. Only the inspector changes.
            </p>
          </div>
          <button aria-label="Close dialog" className="dialog-close" disabled={pending} onClick={onClose} type="button">
            <X aria-hidden="true" size={18} />
          </button>
        </header>

        <dl className="change-inspector__summary">
          <div><dt><MapPin aria-hidden="true" size={15} /> Site</dt><dd>{siteName}</dd></div>
          <div><dt><User aria-hidden="true" size={15} /> Current inspector</dt><dd>{currentInspectorName}</dd></div>
          {whenLabel ? <div><dt><CalendarDays aria-hidden="true" size={15} /> Date and time</dt><dd>{whenLabel}</dd></div> : null}
        </dl>

        <div className="change-inspector__field">
          <span id={`${id}-label`}>New inspector <span aria-hidden="true" className="change-inspector__required">*</span></span>
          <button
            aria-controls={`${id}-list`}
            aria-describedby={`${id}-status`}
            aria-expanded={listOpen}
            aria-haspopup="listbox"
            aria-labelledby={`${id}-label ${id}-value`}
            className={`change-inspector__trigger${blocked ? " change-inspector__trigger--warn" : ""}`}
            disabled={pending || replacements.length === 0}
            onClick={() => (listOpen ? closeList() : openList())}
            onKeyDown={(event) => {
              if (!listOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); openList(); }
            }}
            ref={trigger}
            role="combobox"
            type="button"
          >
            <User aria-hidden="true" size={16} />
            <span className={choice ? undefined : "change-inspector__placeholder"} id={`${id}-value`}>{choice ? nameOf(choice) : "Choose a replacement"}</span>
            <ChevronDown aria-hidden="true" className="change-inspector__chevron" size={18} />
          </button>
          {listOpen ? (
            <div className="change-inspector__popover">
              <label className="change-inspector__search">
                <Search aria-hidden="true" size={16} />
                <input
                  aria-activedescendant={shown[active] ? `${id}-opt-${shown[active].id}` : undefined}
                  aria-controls={`${id}-list`}
                  aria-label="Search inspectors"
                  onChange={(event) => { setFilter(event.target.value); setActive(0); }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => Math.min(index + 1, shown.length - 1)); }
                    if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); }
                    if (event.key === "Enter" && shown[active]) { event.preventDefault(); pick(shown[active].id); }
                  }}
                  placeholder="Search inspectors…"
                  ref={search}
                  value={filter}
                />
              </label>
              <div className="change-inspector__current">
                <span><User aria-hidden="true" size={15} /> {currentInspectorName}<small>Current inspector</small></span>
                <span className="change-inspector__chip change-inspector__chip--info">Current</span>
              </div>
              <ul aria-labelledby={`${id}-label`} className="change-inspector__options" id={`${id}-list`} role="listbox">
                {shown.map((inspector, index) => (
                  <li
                    aria-selected={inspector.id === choice}
                    className={`change-inspector__option${index === active ? " is-active" : ""}`}
                    id={`${id}-opt-${inspector.id}`}
                    key={inspector.id}
                    onClick={() => pick(inspector.id)}
                    onMouseEnter={() => setActive(index)}
                    role="option"
                  >
                    <span><User aria-hidden="true" size={15} /> {inspector.name}</span>
                    <StandingChip standing={standing[inspector.id]} />
                    {inspector.id === choice ? <Check aria-hidden="true" size={16} /> : null}
                  </li>
                ))}
              </ul>
              {shown.length === 0 ? <p className="field-hint">No inspector matches.</p> : null}
            </div>
          ) : null}
        </div>
        {replacements.length === 0 ? <p className="field-hint">No other active inspector is available to take this booking.</p> : null}

        <div aria-live="polite" id={`${id}-status`}>
          {check.state === "checking" ? <p className="change-inspector__status">Checking availability…</p> : null}
          {verified ? (
            <p className="change-inspector__status change-inspector__status--ok">
              <Check aria-hidden="true" size={15} /> Available
            </p>
          ) : null}
          {check.state === "failed" ? (
            <div className="change-inspector__warning" role="alert">
              <TriangleAlert aria-hidden="true" size={18} />
              <div>
                <p>{UNVERIFIED_MESSAGE}</p>
                <button className="link-button" onClick={() => choice && void verify(choice)} type="button">Check again</button>
              </div>
            </div>
          ) : null}
          {blocked ? (
            <div className="change-inspector__warning" role="alert">
              <TriangleAlert aria-hidden="true" size={18} />
              <p>
                {!result.eligible
                  ? result.blockedReason ?? "This booking cannot be reassigned."
                  : result.reason === "asset_unavailable"
                    ? ASSET_MESSAGE
                    : BUSY_MESSAGE}
              </p>
            </div>
          ) : null}
        </div>

        {blocked && result.eligible && suggestions.length > 0 ? (
          <fieldset className="change-inspector__suggestions">
            <legend>Choose another inspector</legend>
            {suggestions.map((inspectorId) => (
              <button className="change-inspector__suggestion" disabled={pending} key={inspectorId} onClick={() => choose(inspectorId)} type="button">
                <span><User aria-hidden="true" size={15} /> {nameOf(inspectorId)}</span>
                <span className="change-inspector__chip">Available</span>
              </button>
            ))}
          </fieldset>
        ) : null}

        {refusal ? <ActionNotice kind="error" title="Inspector not changed">{refusal}</ActionNotice> : null}
        <div className="confirm-dialog__actions">
          <button className="action-button action-button--ghost" disabled={pending} onClick={onClose} type="button">Cancel</button>
          <ActionButton disabled={!verified || pending} onClick={() => void save()} pending={pending} pendingLabel="Saving…" variant="primary">
            <Check aria-hidden="true" size={15} /> Save change
          </ActionButton>
        </div>
      </div>
    </div>,
    document.body
  );
}
