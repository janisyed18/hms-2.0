import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AuthProvider, useAuth } from "../auth/AuthProvider";
import type { BrowserAuthClient } from "../auth/authClient";
import { BrowserAuthError } from "../auth/authTypes";
import { createHmsClient } from "../api/hmsClient";

const ME = {
  user_id: "u-1",
  email: "user@example.com",
  display_name: "Alex Reviewer",
  account_status: "ACTIVE",
  roles: ["REVIEWER"],
  permissions: ["asset:read", "certificate:approve"],
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

function Harness() {
  const auth = useAuth();
  const s = auth.state;
  return (
    <div>
      <div data-testid="status">{s.status}</div>
      <div data-testid="token">{auth.getAccessToken() ?? "none"}</div>
      {s.status === "authenticated" ? (
        <div data-testid="name">{s.session.displayName}</div>
      ) : null}
      {s.status === "mfa-enrollment" && s.otpauthUri ? (
        <div data-testid="otpauth">{s.otpauthUri}</div>
      ) : null}
      {s.status === "recovery-codes" ? (
        <div data-testid="codes">{s.recoveryCodes.join(",")}</div>
      ) : null}
      {"message" in s && s.message ? (
        <div data-testid="message">{s.message}</div>
      ) : null}
      <button onClick={() => auth.login("user@example.com", "pw")}>login</button>
      <button onClick={() => auth.changeRequiredPassword("A-New-Passphrase-9")}>
        change
      </button>
      <button onClick={() => auth.startMfaEnrollment()}>enroll</button>
      <button onClick={() => auth.confirmMfa("123456")}>confirm</button>
      <button onClick={() => auth.verifyMfa("123456")}>verify</button>
      <button onClick={() => auth.acknowledgeRecoveryCodes()}>ack</button>
      <button onClick={() => auth.logout()}>logout</button>
    </div>
  );
}

function renderWith(client: BrowserAuthClient) {
  return render(
    <AuthProvider client={client}>
      <Harness />
    </AuthProvider>
  );
}

function ProtectedRequestHarness({ fetcher }: { fetcher: typeof fetch }) {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="protected-status">{auth.state.status}</span>
      <button
        type="button"
        onClick={() => void createHmsClient({ fetcher }).listCustomers()}
      >
        load protected data
      </button>
    </div>
  );
}

describe("AuthProvider", () => {
  it("restores an authenticated session from the refresh cookie on mount", async () => {
    const client = fakeClient({
      refresh: vi.fn().mockResolvedValue({
        next_step: "AUTHENTICATED",
        access_token: "access-1",
        token_type: "bearer",
        expires_in: 900
      })
    });
    renderWith(client);
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("authenticated")
    );
    expect(screen.getByTestId("name").textContent).toBe("Alex Reviewer");
    expect(screen.getByTestId("token").textContent).toBe("access-1");
  });

  it("falls back to signed-out when the cookie refresh fails", async () => {
    renderWith(fakeClient());
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("signed-out")
    );
    expect(screen.getByTestId("token").textContent).toBe("none");
  });

  it("drives the full first-login flow to recovery codes then authenticated", async () => {
    const client = fakeClient({
      login: vi.fn().mockResolvedValue({
        next_step: "PASSWORD_CHANGE_REQUIRED",
        challenge: "c1",
        expires_in: 600
      }),
      changePassword: vi.fn().mockResolvedValue({
        next_step: "MFA_ENROLLMENT_REQUIRED",
        challenge: "c2",
        expires_in: 600
      }),
      startEnrollment: vi.fn().mockResolvedValue({
        next_step: "MFA_ENROLLMENT_REQUIRED",
        challenge: "c2",
        otpauth_uri: "otpauth://totp/HMS:user?secret=ABC",
        manual_key: "ABC"
      }),
      confirmMfa: vi.fn().mockResolvedValue({
        next_step: "RECOVERY_CODES",
        access_token: "access-2",
        expires_in: 900,
        recovery_codes: ["AAAA-BBBB-CCCC", "DDDD-EEEE-FFFF"]
      })
    });
    renderWith(client);
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("signed-out")
    );

    fireEvent.click(screen.getByText("login"));
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("password-change")
    );

    fireEvent.click(screen.getByText("change"));
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("mfa-enrollment")
    );

    fireEvent.click(screen.getByText("enroll"));
    await waitFor(() =>
      expect(screen.getByTestId("otpauth").textContent).toContain("otpauth://")
    );

    fireEvent.click(screen.getByText("confirm"));
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("recovery-codes")
    );
    expect(screen.getByTestId("codes").textContent).toContain("AAAA-BBBB-CCCC");
    expect(screen.getByTestId("token").textContent).toBe("access-2");

    fireEvent.click(screen.getByText("ack"));
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("authenticated")
    );
  });

  it("verifies MFA for a returning user", async () => {
    const client = fakeClient({
      login: vi.fn().mockResolvedValue({
        next_step: "MFA_REQUIRED",
        challenge: "c9",
        expires_in: 600
      }),
      verifyMfa: vi.fn().mockResolvedValue({
        next_step: "AUTHENTICATED",
        access_token: "access-9",
        token_type: "bearer",
        expires_in: 900
      })
    });
    renderWith(client);
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("signed-out")
    );
    fireEvent.click(screen.getByText("login"));
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("mfa-challenge")
    );
    fireEvent.click(screen.getByText("verify"));
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("authenticated")
    );
    expect(screen.getByTestId("token").textContent).toBe("access-9");
  });

  it("shows a generic message and stays signed-out on bad credentials", async () => {
    const client = fakeClient({
      login: vi.fn().mockRejectedValue(
        new BrowserAuthError("Invalid email or password", 401)
      )
    });
    renderWith(client);
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("signed-out")
    );
    fireEvent.click(screen.getByText("login"));
    await waitFor(() =>
      expect(screen.getByTestId("message").textContent).toBe(
        "Invalid email or password"
      )
    );
  });

  it("clears the access token on logout", async () => {
    const client = fakeClient({
      refresh: vi.fn().mockResolvedValue({
        next_step: "AUTHENTICATED",
        access_token: "access-1",
        token_type: "bearer",
        expires_in: 900
      })
    });
    renderWith(client);
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("authenticated")
    );
    fireEvent.click(screen.getByText("logout"));
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("signed-out")
    );
    expect(screen.getByTestId("token").textContent).toBe("none");
    expect(client.logout).toHaveBeenCalled();
  });

  it("connects protected API requests to the in-memory token and refresh flow", async () => {
    const refresh = vi
      .fn()
      .mockResolvedValueOnce({
        next_step: "AUTHENTICATED",
        access_token: "access-1",
        token_type: "bearer",
        expires_in: 900
      })
      .mockResolvedValueOnce({
        next_step: "AUTHENTICATED",
        access_token: "access-2",
        token_type: "bearer",
        expires_in: 900
      });
    const client = fakeClient({ refresh });
    const dataFetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: new Headers(),
        json: async () => ({ detail: "Expired" })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ total: 0, limit: 50, offset: 0, items: [] })
      });

    render(
      <AuthProvider client={client}>
        <ProtectedRequestHarness fetcher={dataFetcher as typeof fetch} />
      </AuthProvider>
    );
    await waitFor(() =>
      expect(screen.getByTestId("protected-status").textContent).toBe("authenticated")
    );

    fireEvent.click(screen.getByText("load protected data"));
    await waitFor(() => expect(dataFetcher).toHaveBeenCalledTimes(2));

    expect(refresh).toHaveBeenCalledTimes(2);
    expect((dataFetcher.mock.calls[0][1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer access-1");
    expect((dataFetcher.mock.calls[1][1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer access-2");
  });
});
