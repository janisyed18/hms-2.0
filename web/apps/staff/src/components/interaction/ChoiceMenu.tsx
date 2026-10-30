import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";

export interface ChoiceOption {
  value: string;
  label: string;
  /** A second line under the label (a code, a customer), never an internal id. */
  description?: string;
  disabled?: boolean;
  /** Extra text the Combobox matches while typing, beyond the label and description. */
  searchText?: string;
}

const GAP = 4;
const MAX_HEIGHT = 288;
const MIN_FLIP_SPACE = 168;

/** Fixed placement under (or, with no room, over) the control, as wide as the control. */
function useMenuPlacement(anchor: RefObject<HTMLElement | null>, open: boolean): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties>();
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const el = anchor.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - GAP - 8;
      const above = rect.top - GAP - 8;
      const flip = below < MIN_FLIP_SPACE && above > below;
      const room = Math.max(120, flip ? above : below);
      const width = Math.max(rect.width, 200);
      const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
      setStyle({
        left,
        maxHeight: Math.min(MAX_HEIGHT, room),
        minWidth: width,
        width: rect.width,
        ...(flip ? { bottom: window.innerHeight - rect.top + GAP } : { top: rect.bottom + GAP })
      });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, open]);
  return open ? style : undefined;
}

/**
 * The open list of a Select or Combobox. It is portalled to the page so no drawer or dialog clips
 * it, and focus never enters it: the control keeps focus and points at the active option with
 * aria-activedescendant. Clicking an option does not move focus off the control.
 */
export function ChoiceMenu({
  active,
  anchor,
  emptyText,
  idPrefix,
  listId,
  loading,
  loadingText = "Loading…",
  onActivate,
  onPick,
  open,
  options,
  selected,
  label
}: {
  active: number;
  anchor: RefObject<HTMLElement | null>;
  emptyText?: string;
  idPrefix: string;
  listId: string;
  loading?: boolean;
  loadingText?: string;
  onActivate: (index: number) => void;
  onPick: (option: ChoiceOption) => void;
  open: boolean;
  options: ChoiceOption[];
  selected: string;
  label: string;
}) {
  const style = useMenuPlacement(anchor, open);
  useLayoutEffect(() => {
    if (!open) return;
    document.getElementById(`${idPrefix}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, idPrefix, open]);
  if (!open || !style) return null;
  return createPortal(
    <div className="choice-menu" data-choice-menu onMouseDown={(event) => event.preventDefault()} style={style}>
      <ul aria-label={label} className="choice-menu__list" id={listId} role="listbox">
        {options.map((option, index) => (
          <li
            aria-disabled={option.disabled || undefined}
            aria-selected={option.value === selected}
            className={`choice-menu__option${index === active ? " is-active" : ""}${option.value === selected ? " is-selected" : ""}${option.disabled ? " is-disabled" : ""}`}
            data-value={option.value}
            id={`${idPrefix}-${index}`}
            key={option.value}
            // Keep focus on the control: pressing an option must not blur it.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (!option.disabled) onPick(option);
            }}
            onMouseMove={() => {
              if (!option.disabled && index !== active) onActivate(index);
            }}
            role="option"
          >
            <span className="choice-menu__text">
              <span className="choice-menu__label">{option.label}</span>
              {option.description ? <span className="choice-menu__description">{option.description}</span> : null}
            </span>
            {option.value === selected ? <Check aria-hidden="true" className="choice-menu__check" size={16} /> : null}
          </li>
        ))}
      </ul>
      {options.length === 0 ? <p className="choice-menu__empty" role="status">{loading ? loadingText : (emptyText ?? "No matches")}</p> : null}
      {options.length > 0 && loading ? <p className="choice-menu__empty" role="status">{loadingText}</p> : null}
    </div>,
    document.body
  );
}

/** Next enabled index from `from` in `step` direction, wrapping not allowed (stops at the ends). */
export function nextEnabled(options: ChoiceOption[], from: number, step: 1 | -1): number {
  for (let i = from + step; i >= 0 && i < options.length; i += step) {
    if (!options[i].disabled) return i;
  }
  return from;
}

export function firstEnabled(options: ChoiceOption[]): number {
  const index = options.findIndex((option) => !option.disabled);
  return index < 0 ? 0 : index;
}

export function lastEnabled(options: ChoiceOption[]): number {
  for (let i = options.length - 1; i >= 0; i -= 1) if (!options[i].disabled) return i;
  return 0;
}
