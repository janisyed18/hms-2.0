/** Capture a reset token once, then remove it from the visible URL/history. */
export function capturePasswordResetToken(): string | null {
  if (typeof window === "undefined" || window.location.pathname !== "/reset-password") {
    return null;
  }
  const token = new URLSearchParams(window.location.search).get("token");
  if (!token) {
    return null;
  }
  window.history.replaceState({}, "", "/reset-password");
  return token;
}
