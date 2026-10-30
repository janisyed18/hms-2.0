import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";

import { ChoiceMenu, firstEnabled, lastEnabled, nextEnabled, type ChoiceOption } from "./ChoiceMenu";

export type { ChoiceOption as ComboboxOption } from "./ChoiceMenu";

function matches(option: ChoiceOption, needle: string): boolean {
  if (!needle) return true;
  const haystack = `${option.label} ${option.description ?? ""} ${option.searchText ?? ""}`.toLowerCase();
  return needle.split(/\s+/).every((word) => haystack.includes(word));
}

/**
 * A searchable list for choosing a record (a customer, an asset, a product): type to narrow it,
 * Up/Down to move, Enter to choose, Escape to close. The ARIA editable combobox with list
 * autocomplete. It shows the chosen option's label when idle and puts it back if the person
 * leaves with half-typed text. Options are given human labels, never ids.
 */
export function Combobox({
  className,
  disabled = false,
  emptyText = "No matches",
  loading = false,
  onChange,
  options,
  placeholder = "Search…",
  value,
  ...aria
}: {
  className?: string;
  disabled?: boolean;
  emptyText?: string;
  loading?: boolean;
  onChange: (value: string) => void;
  options: ChoiceOption[];
  placeholder?: string;
  value: string;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "aria-required"?: boolean | "true" | "false";
  "data-field"?: string;
  required?: boolean;
}) {
  const generated = useId();
  const listId = `${generated}-list`;
  const optionPrefix = `${generated}-opt`;
  const input = useRef<HTMLInputElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? null;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null); // null: showing the chosen label
  const [active, setActive] = useState(0);
  const { required, ...rest } = aria;

  const query = (text ?? "").trim().toLowerCase();
  const shown = useMemo(() => options.filter((option) => matches(option, query)), [options, query]);
  const shownActive = Math.min(active, Math.max(shown.length - 1, 0));

  function close() {
    setOpen(false);
    setText(null);
  }

  function pick(option: ChoiceOption) {
    close();
    if (option.value !== value) onChange(option.value);
  }

  function openList() {
    if (disabled) return;
    const index = shown.findIndex((option) => option.value === value);
    setActive(index >= 0 ? index : firstEnabled(shown));
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function away(event: MouseEvent) {
      const target = event.target as Node;
      if (shell.current?.contains(target)) return;
      if ((target as Element).closest?.("[data-choice-menu]")) return;
      close();
    }
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  function onInput(event: ChangeEvent<HTMLInputElement>) {
    setText(event.target.value);
    setActive(0);
    setOpen(true);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    const { key } = event;
    if (key === "ArrowDown") {
      event.preventDefault();
      if (!open) openList();
      else setActive(nextEnabled(shown, shownActive, 1));
    } else if (key === "ArrowUp") {
      event.preventDefault();
      if (!open) openList();
      else setActive(nextEnabled(shown, shownActive, -1));
    } else if (key === "Home" && open) {
      event.preventDefault();
      setActive(firstEnabled(shown));
    } else if (key === "End" && open) {
      event.preventDefault();
      setActive(lastEnabled(shown));
    } else if (key === "Enter") {
      if (open) {
        // Enter chooses while the list is open; it must not submit the form behind it.
        event.preventDefault();
        const option = shown[shownActive];
        if (option && !option.disabled) pick(option);
      }
    } else if (key === "Escape") {
      if (open || text !== null) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    } else if (key === "Tab") {
      close();
    }
  }

  const display = text ?? selected?.label ?? "";
  return (
    <div className={`choice-control choice-control--combobox${className ? ` ${className}` : ""}${disabled ? " is-disabled" : ""}`} ref={shell}>
      <input
        {...rest}
        aria-activedescendant={open && shown.length > 0 ? `${optionPrefix}-${shownActive}` : undefined}
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-required={required ? true : rest["aria-required"]}
        autoComplete="off"
        className="choice-control__input"
        disabled={disabled}
        onBlur={close}
        onChange={onInput}
        onClick={() => (open ? undefined : openList())}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        ref={input}
        role="combobox"
        spellCheck={false}
        type="text"
        value={display}
      />
      <ChevronDown aria-hidden="true" className="choice-control__chevron" size={16} />
      <ChoiceMenu
        active={shownActive}
        anchor={shell}
        emptyText={emptyText}
        idPrefix={optionPrefix}
        label={rest["aria-label"] ?? "Options"}
        listId={listId}
        loading={loading}
        onActivate={setActive}
        onPick={pick}
        open={open}
        options={shown}
        selected={value}
      />
    </div>
  );
}
