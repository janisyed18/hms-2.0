import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useReducedMotionConfig } from "motion/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../App";
import type { BrowserAuthClient } from "../auth/authClient";
import { BrowserAuthError } from "../auth/authTypes";
import { MotionProvider } from "../motion/MotionProvider";

const ME = {
  user_id: "u-1",
  email: "admin@example.com",
  display_name: "Sam Admin",
  account_status: "ACTIVE",
  roles: ["SUPER_ADMIN"],
  permissions: ["asset:read", "user:admin"],
  customer_ids: []
};

function fakeClient(overrides: Partial<BrowserAuthClient> = {}): BrowserAuthClient {
  return {
    login: vi.fn(),
    changePassword: vi.fn(),
    startEnrollment: vi.fn(),
    confirmMfa: vi.fn(),
    verifyMfa: vi.fn(),
    verifyRecovery: vi.fn(),
    refresh: vi.fn().mockRejectedValue(new BrowserAuthError("No session", 401)),
    logout: vi.fn().mockResolvedValue(undefined),
    me: vi.fn().mockResolvedValue(ME),
    ...overrides
  } as unknown as BrowserAuthClient;
}

function ReducedMotionProbe() {
  return <output aria-label="Reduced motion">{String(useReducedMotionConfig())}</output>;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("App auth gating", () => {
  it("renders authentication with reduced motion enabled", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn()
      }))
    );

    render(
      <MotionProvider>
        <ReducedMotionProbe />
        <App authClient={fakeClient()} />
      </MotionProvider>
    );

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(screen.getByRole("status", { name: "Reduced motion" })).toHaveTextContent("true");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Reduced Motion enabled"));
  });

  it("shows only the sign-in screen when unauthenticated (no app shell)", async () => {
    render(<App authClient={fakeClient()} />);
    expect(await screen.findByRole("button", { name: /sign in/i })).toBeInTheDocument();
    // The workspace nav is not rendered for an unauthenticated user.
    expect(screen.queryByText("Asset Register")).toBeNull();
  });

  it("renders the app shell once the cookie session is restored", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Backend unavailable")));
    const client = fakeClient({
      refresh: vi.fn().mockResolvedValue({
        next_step: "AUTHENTICATED",
        access_token: "access-1",
        token_type: "bearer",
        expires_in: 900
      })
    });
    render(<App authClient={client} />);
    // The authenticated shell shows the resolved session's display name.
    expect(await screen.findAllByText("Sam Admin")).not.toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Customers" }));
    expect(await screen.findByText("Customer data unavailable")).toBeVisible();
  });

  it("signs out from the sidebar control back to the login screen", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Backend unavailable")));
    const client = fakeClient({
      refresh: vi.fn().mockResolvedValue({
        next_step: "AUTHENTICATED",
        access_token: "access-1",
        token_type: "bearer",
        expires_in: 900
      })
    });
    render(<App authClient={client} />);
    await screen.findAllByText("Sam Admin");

    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument()
    );
    expect(client.logout).toHaveBeenCalled();
  });
});
