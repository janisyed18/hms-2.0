import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ActionVariant = "primary" | "secondary" | "ghost" | "danger" | "icon";

/**
 * The one button contract. primary: Save/Create/Submit/Approve/Issue. secondary: Edit/Retry/
 * Reschedule. ghost: Close/Cancel/Back and other minor actions. danger: only the confirming
 * step of a destructive action. icon: compact toolbar and close controls (give it an aria-label).
 * While `pending` it is disabled, marked busy, and says what it is doing ("Saving…").
 */
export function ActionButton({
  children,
  className,
  disabled,
  pending = false,
  pendingLabel,
  type = "button",
  variant = "secondary",
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
  children: ReactNode;
  pending?: boolean;
  /** What to show while pending, e.g. "Saving…". Required wording, never a generic "Loading". */
  pendingLabel?: string;
  type?: "button" | "submit";
  variant?: ActionVariant;
}) {
  return (
    <button
      {...rest}
      aria-busy={pending || undefined}
      className={`action-button action-button--${variant}${pending ? " is-pending" : ""}${className ? ` ${className}` : ""}`}
      disabled={disabled || pending}
      type={type}
    >
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}
