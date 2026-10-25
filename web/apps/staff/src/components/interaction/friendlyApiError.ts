import { HmsApiError } from "../../api/hmsClient";

export type FriendlyErrorKind =
  | "validation"
  | "auth"
  | "permission"
  | "missing"
  | "conflict"
  | "too-large"
  | "rate-limit"
  | "unavailable"
  | "unknown";

export interface FriendlyError {
  kind: FriendlyErrorKind;
  /** What to tell the user. Never a raw backend message, stack trace or internal detail. */
  message: string;
  status: number | null;
  /** Messages for individual form fields, keyed by the form's own field names. */
  fieldErrors: Record<string, string>;
  retryAfterSeconds: number | null;
  /** The record changed or vanished: the caller should refresh rather than retry as is. */
  needsRefresh: boolean;
}

export interface FriendlyErrorOptions {
  /** Used when nothing more specific is known: "The asset could not be saved." */
  fallback?: string;
  /** Maps backend field names (snake_case request fields) to the form's field names. */
  fieldMap?: Record<string, string>;
  /**
   * A 409 is an ordinary business-state conflict ("only a confirmed booking can be
   * rescheduled", "serial number already assigned"), so it does not mean "refresh" by itself.
   * A caller that knows its 409 means the record moved on (a slot taken meanwhile) says so here.
   */
  conflictNeedsRefresh?: boolean;
}

const UNSAFE = /^HMS API request failed|traceback|exception|sqlalchemy|psycopg|asyncpg|postgres|integrityerror|\b(select|insert|update|delete)\b.+\b(from|into|set)\b|internal server|arn:aws|amazonaws|errno|\bfile "|\bat \S+\(.+:\d+\)|\.py\b|[{}]\s*$/i;

/** A backend business message is shown only when it reads like one sentence meant for people. */
export function safeServerMessage(message: unknown): string | null {
  if (typeof message !== "string") return null;
  const text = message.trim();
  if (text.length < 4 || text.length > 240 || /[\r\n]/.test(text) || UNSAFE.test(text)) return null;
  return text;
}

function fieldMessage(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  if (/required|missing/i.test(text)) return "This field is required.";
  if (/email/i.test(text)) return "Enter a valid email address.";
  if (/at least|too short|empty/i.test(text)) return "This value is too short.";
  if (/at most|too long|maximum/i.test(text)) return "This value is too long.";
  return "Check this value.";
}

function fieldErrorsFrom(details: unknown, fieldMap: Record<string, string>): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!Array.isArray(details)) return errors;
  for (const item of details) {
    if (!item || typeof item !== "object") continue;
    const location = (item as { loc?: unknown }).loc;
    const field = Array.isArray(location) ? String(location[location.length - 1]) : null;
    const mapped = field ? fieldMap[field] : undefined;
    if (mapped && !errors[mapped]) errors[mapped] = fieldMessage((item as { msg?: unknown }).msg);
  }
  return errors;
}

function retryAfterOf(error: HmsApiError): number | null {
  const details = error.details as { retryAfterSeconds?: unknown } | null;
  const value = details && typeof details === "object" ? Number(details.retryAfterSeconds) : NaN;
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : null;
}

export function friendlyApiError(error: unknown, options: FriendlyErrorOptions = {}): FriendlyError {
  const fallback = options.fallback ?? "That did not work. Please try again.";
  const base = { fieldErrors: {}, retryAfterSeconds: null, needsRefresh: false };
  if (!(error instanceof HmsApiError)) {
    // fetch rejects with a TypeError when the network or the service is unreachable.
    return error instanceof TypeError
      ? { ...base, kind: "unavailable", status: null, message: "The service could not be reached. Check your connection and try again." }
      : { ...base, kind: "unknown", status: null, message: fallback };
  }
  const { status } = error;
  const server = safeServerMessage(error.message);
  if (status === 401) {
    return { ...base, kind: "auth", status, message: "Your session has ended. Sign in again to continue." };
  }
  if (status === 403) {
    return { ...base, kind: "permission", status, message: "You do not have permission to do this." };
  }
  if (status === 404) {
    return {
      ...base, kind: "missing", status, needsRefresh: true,
      message: "This item no longer exists. It may have been removed or archived by someone else. Refresh to see the current list."
    };
  }
  if (status === 412) {
    // An If-Match version no longer matches: the record was edited since it was loaded.
    return {
      ...base, kind: "conflict", status, needsRefresh: true,
      message: "This item was changed by someone else since you opened it. Refresh to review the latest version, then try again."
    };
  }
  if (status === 409) {
    const refresh = options.conflictNeedsRefresh === true;
    return {
      ...base, kind: "conflict", status, needsRefresh: refresh,
      message: server ?? (refresh ? `${fallback} Refresh to review the latest version.` : fallback)
    };
  }
  if (status === 413) {
    return { ...base, kind: "too-large", status, message: "That is too large to send. Reduce its size and try again." };
  }
  if (status === 429) {
    const retryAfterSeconds = retryAfterOf(error);
    return {
      ...base, kind: "rate-limit", status, retryAfterSeconds,
      message: retryAfterSeconds
        ? `Too many requests. Try again in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"}.`
        : "Too many requests. Wait a moment and try again."
    };
  }
  if (status === 400 || status === 422) {
    const fieldErrors = fieldErrorsFrom(error.details, options.fieldMap ?? {});
    return {
      ...base, kind: "validation", status, fieldErrors,
      message: server ?? (Object.keys(fieldErrors).length ? "Some details need attention. Check the highlighted fields." : fallback)
    };
  }
  if (status >= 500) {
    return { ...base, kind: "unavailable", status, message: "The service is unavailable right now. Try again in a moment." };
  }
  return { ...base, kind: "unknown", status, message: server ?? fallback };
}
