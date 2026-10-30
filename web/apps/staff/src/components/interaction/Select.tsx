import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { ChoiceMenu, firstEnabled, lastEnabled, nextEnabled, type ChoiceOption } from "./ChoiceMenu";

export type { ChoiceOption as SelectOption } from "./ChoiceMenu";

/**
 * A small fixed list of choices (a role, a status). The ARIA select-only combobox: a button that
 * opens a listbox; Up/Down/Home/End move, Enter or Space choose, Escape closes, typing jumps to a
 * match. It spreads the props `Field` hands to a control (id, data-field, aria-*), so it is used
 * the way a native select was.
 */
export function Select({
  className,
  disabled = false,
  emptyLabel,
  icon,
  onChange,
  options: given,
  placeholder = "Select…",
  value,
  ...aria
}: {
  className?: string;
  disabled?: boolean;
  /** Offers "no choice" as the first entry, with this wording, so a chosen value can be taken back. */
  emptyLabel?: string;
  /** A decorative icon at the start of the control. */
  icon?: ReactNode;
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
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const typed = useRef({ text: "", at: 0 });
  const options = emptyLabel === undefined ? given : [{ value: "", label: emptyLabel }, ...given];
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;
  const { required, ...rest } = aria;

  function show(start?: number) {
    setActive(start ?? (selectedIndex >= 0 ? selectedIndex : firstEnabled(options)));
    setOpen(true);
  }

  function pick(option: ChoiceOption) {
    setOpen(false);
    if (option.value !== value) onChange(option.value);
  }

  // A click anywhere outside the control and its list closes it.
  useEffect(() => {
    if (!open) return;
    function away(event: MouseEvent) {
      const target = event.target as Node;
      if (trigger.current?.contains(target)) return;
      if ((target as Element).closest?.("[data-choice-menu]")) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  function typeAhead(character: string) {
    const now = Date.now();
    typed.current.text = now - typed.current.at > 700 ? character : typed.current.text + character;
    typed.current.at = now;
    const needle = typed.current.text.toLowerCase();
    const from = open ? active : Math.max(selectedIndex, 0);
    const order = [...options.keys()].map((i) => (i + from + (needle.length === 1 ? 1 : 0)) % options.length);
    const hit = order.find((i) => !options[i].disabled && options[i].label.toLowerCase().startsWith(needle));
    if (hit === undefined) return;
    if (open) setActive(hit);
    else pick(options[hit]);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    const { key } = event;
    if (!open) {
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") {
        event.preventDefault();
        show();
      } else if (key === "Home") {
        event.preventDefault();
        show(firstEnabled(options));
      } else if (key === "End") {
        event.preventDefault();
        show(lastEnabled(options));
      } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        typeAhead(key);
      }
      return;
    }
    if (key === "ArrowDown") { event.preventDefault(); setActive((i) => nextEnabled(options, i, 1)); }
    else if (key === "ArrowUp") { event.preventDefault(); setActive((i) => nextEnabled(options, i, -1)); }
    else if (key === "Home") { event.preventDefault(); setActive(firstEnabled(options)); }
    else if (key === "End") { event.preventDefault(); setActive(lastEnabled(options)); }
    else if (key === "Enter" || key === " ") {
      event.preventDefault();
      if (options[active] && !options[active].disabled) pick(options[active]);
    } else if (key === "Escape") {
      // Closes the list only: the form around it must not read this as "leave the form".
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (key === "Tab") {
      setOpen(false);
    } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      typeAhead(key);
    }
  }

  return (
    <>
      <button
        {...rest}
        aria-activedescendant={open ? `${optionPrefix}-${active}` : undefined}
        aria-controls={open ? listId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-required={required ? true : rest["aria-required"]}
        className={`choice-control choice-control--select${className ? ` ${className}` : ""}`}
        disabled={disabled}
        onBlur={() => setOpen(false)}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        ref={trigger}
        role="combobox"
        type="button"
      >
        {icon ? <span aria-hidden="true" className="choice-control__icon">{icon}</span> : null}
        <span className={`choice-control__value${selected && selected.value !== "" ? "" : " is-placeholder"}`}>{selected ? selected.label : placeholder}</span>
        <ChevronDown aria-hidden="true" className="choice-control__chevron" size={16} />
      </button>
      <ChoiceMenu
        active={active}
        anchor={trigger}
        idPrefix={optionPrefix}
        label={rest["aria-label"] ?? "Options"}
        listId={listId}
        onActivate={setActive}
        onPick={pick}
        open={open}
        options={options}
        selected={value}
      />
    </>
  );
}
