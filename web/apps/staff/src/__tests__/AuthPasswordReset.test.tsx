import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AuthProvider, useAuth } from "../auth/AuthProvider";
import type { BrowserAuthClient } from "../auth/authClient";
import { BrowserAuthError } from "../auth/authTypes";

function fakeClient(overrides: Partial<BrowserAuthClient> = {}): BrowserAuthClient {
  return {
    login: vi.fn(),
    changePassword: vi.fn(),
    startEnrollment: vi.fn(),
    confirmMfa: vi.fn(),
    verifyMfa: vi.fn(),
    verifyRecovery: vi.fn(),
    requestPasswordReset: vi.fn(),
    confirmPasswordReset: vi.fn(),
    refresh: vi.fn().mockRejectedValue(new BrowserAuthError("No session", 401)),
    logout: vi.fn().mockResolvedValue(undefined),
    me: vi.fn(),
    ...overrides
  } as unknown as BrowserAuthClient;
}

function Harness() {
  const auth = useAuth();
  return (
    <div>
      <div data-testid="status">{auth.state.status}</div>
      {"message" in auth.state && auth.state.message ? (
        <div data-testid="message">{auth.state.message}</div>
      ) : null}
      <button type="button" onClick={auth.showForgotPassword}>
        forgot
      </button>
      <button
        type="button"
        onClick={() => void auth.requestPasswordReset("user@example.com")}
      >
        request
      </button>
      <button
        type="button"
        onClick={() => void auth.confirmPasswordReset("A-New-Password-9!")}
      >
        confirm
      </button>
      <button type="button" onClick={auth.showSignIn}>
        sign in
      </button>
    </div>
  );
}

function renderProvider(client: BrowserAuthClient) {
  return render(
    <AuthProvider client={client}>
      <Harness />
    </AuthProvider>
  );
}

describe("AuthProvider password reset states", () => {
  it("captures a reset token and removes it from browser history", async () => {
    window.history.pushState({}, "", "/reset-password?token=token-1");
    const replaceState = vi.spyOn(window.history, "replaceState");
    renderProvider(fakeClient());

    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("password-reset")
    );
    expect(replaceState).toHaveBeenCalledWith({}, "", "/reset-password");
    expect(window.location.search).toBe("");
  });

  it("moves through request, confirmation, and back to sign-in", async () => {
    window.history.pushState({}, "", "/");
    const client = fakeClient({
      requestPasswordReset: vi.fn().mockResolvedValue({
        message: "If that email exists, a password reset link has been sent."
      }),
      confirmPasswordReset: vi.fn().mockResolvedValue({
        message: "Password reset. You can now sign in."
      })
    });
    renderProvider(client);

    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("signed-out")
    );
    fireEvent.click(screen.getByRole("button", { name: "forgot" }));
    expect(screen.getByTestId("status").textContent).toBe("forgot-password");
    fireEvent.click(screen.getByRole("button", { name: "request" }));
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("password-reset-sent")
    );
    fireEvent.click(screen.getByRole("button", { name: "sign in" }));
    expect(screen.getByTestId("status").textContent).toBe("signed-out");
  });
});
