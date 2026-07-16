import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AuthFlow } from "../auth/AuthFlow";
import { AuthProvider } from "../auth/AuthProvider";
import type { BrowserAuthClient } from "../auth/authClient";
import { BrowserAuthError } from "../auth/authTypes";
import { estimatePasswordStrength } from "../auth/authUi";

const ME = {
  user_id: "u-1",
  email: "user@example.com",
  display_name: "Alex Reviewer",
  account_status: "ACTIVE",
  roles: ["REVIEWER"],
  permissions: ["asset:read"],
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
    requestPasswordReset: vi.fn(),
    confirmPasswordReset: vi.fn(),
    refresh: vi.fn().mockRejectedValue(new BrowserAuthError("No session", 401)),
    logout: vi.fn().mockResolvedValue(undefined),
    me: vi.fn().mockResolvedValue(ME),
    ...overrides
  } as unknown as BrowserAuthClient;
}

function renderFlow(client: BrowserAuthClient) {
  return render(
    <AuthProvider client={client}>
      <AuthFlow>
        <div data-testid="app">HMS App</div>
      </AuthFlow>
    </AuthProvider>
  );
}

async function typeInto(label: RegExp, value: string) {
  const input = screen
    .getAllByLabelText(label)
    .find((element) => element instanceof HTMLInputElement);
  if (!input) {
    throw new Error(`No input found for ${label}`);
  }
  fireEvent.change(input, { target: { value } });
}

describe("AuthFlow", () => {
  it("does not rate a long repeated common password as strong", () => {
    expect(estimatePasswordStrength("Password123!Password123!").score).toBeLessThanOrEqual(1);
  });

  it("shows the sign-in screen when signed out and disables submit until filled", async () => {
    renderFlow(fakeClient());
    const button = await screen.findByRole("button", { name: /sign in/i });
    expect(button).toBeDisabled();
    await typeInto(/email/i, "user@example.com");
    await typeInto(/password/i, "secret");
    expect(button).not.toBeDisabled();
  });

  it("opens the forgot-password screen and shows generic reset confirmation", async () => {
    const client = fakeClient({
      requestPasswordReset: vi.fn().mockResolvedValue({
        message: "If that email exists, a password reset link has been sent."
      })
    });
    renderFlow(client);
    await screen.findByRole("button", { name: /sign in/i });
    fireEvent.click(screen.getByRole("button", { name: /forgot password/i }));
    expect(screen.getByRole("heading", { name: /reset your password/i })).toBeInTheDocument();
    await typeInto(/email address/i, "user@example.com");
    fireEvent.click(screen.getByRole("button", { name: /send reset link/i }));
    expect(await screen.findByText(/if that email exists/i)).toBeInTheDocument();
  });

  it("supports password visibility and a reset link returning to sign-in", async () => {
    window.history.pushState({}, "", "/reset-password?token=token-1");
    const client = fakeClient({
      confirmPasswordReset: vi.fn().mockResolvedValue({
        message: "Password reset. You can now sign in."
      })
    });
    renderFlow(client);
    await screen.findByRole("heading", { name: /choose a new password/i });
    const password = screen.getByLabelText(/new password/i);
    expect(password).toHaveAttribute("type", "password");
    fireEvent.click(screen.getAllByRole("button", { name: /show password/i })[0]);
    expect(password).toHaveAttribute("type", "text");
    await typeInto(/new password/i, "A-New-Reset-Passphrase-9!");
    await typeInto(/confirm password/i, "A-New-Reset-Passphrase-9!");
    fireEvent.click(screen.getByRole("button", { name: /reset password/i }));
    expect(await screen.findByText(/password reset/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /return to sign in/i }));
    expect(await screen.findByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("surfaces a generic error on bad credentials and stays on sign-in", async () => {
    const client = fakeClient({
      login: vi
        .fn()
        .mockRejectedValue(new BrowserAuthError("Invalid email or password", 401))
    });
    renderFlow(client);
    await screen.findByRole("button", { name: /sign in/i });
    await typeInto(/email/i, "user@example.com");
    await typeInto(/password/i, "wrong");
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid email or password"
    );
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("renders a QR code and manual key during MFA enrollment", async () => {
    const client = fakeClient({
      login: vi.fn().mockResolvedValue({
        next_step: "MFA_ENROLLMENT_REQUIRED",
        challenge: "c1",
        expires_in: 600
      }),
      startEnrollment: vi.fn().mockResolvedValue({
        next_step: "MFA_ENROLLMENT_REQUIRED",
        challenge: "c1",
        otpauth_uri: "otpauth://totp/HMS:user?secret=ABC",
        manual_key: "ABCDEF"
      })
    });
    renderFlow(client);
    await screen.findByRole("button", { name: /sign in/i });
    await typeInto(/email/i, "user@example.com");
    await typeInto(/password/i, "secret");
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    // Enrollment auto-starts and renders the QR (an <svg>) + manual key.
    const qr = await screen.findByTestId("auth-qr");
    expect(qr.querySelector("svg")).not.toBeNull();
    expect(screen.getByText(/ABCDEF/)).toBeInTheDocument();
  });

  it("completes enrollment then shows recovery codes and continues to the app", async () => {
    const client = fakeClient({
      login: vi.fn().mockResolvedValue({
        next_step: "MFA_ENROLLMENT_REQUIRED",
        challenge: "c1",
        expires_in: 600
      }),
      startEnrollment: vi.fn().mockResolvedValue({
        next_step: "MFA_ENROLLMENT_REQUIRED",
        challenge: "c1",
        otpauth_uri: "otpauth://totp/HMS:user?secret=ABC",
        manual_key: "ABCDEF"
      }),
      confirmMfa: vi.fn().mockResolvedValue({
        next_step: "RECOVERY_CODES",
        access_token: "access-2",
        expires_in: 900,
        recovery_codes: ["AAAA-BBBB-CCCC", "DDDD-EEEE-FFFF"]
      })
    });
    renderFlow(client);
    await screen.findByRole("button", { name: /sign in/i });
    await typeInto(/email/i, "user@example.com");
    await typeInto(/password/i, "secret");
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await screen.findByTestId("auth-qr");
    await typeInto(/authentication code/i, "123456");
    fireEvent.click(screen.getByRole("button", { name: /verify & finish/i }));

    const codes = await screen.findByTestId("recovery-codes");
    expect(codes).toHaveTextContent("AAAA-BBBB-CCCC");

    // Must acknowledge before continuing.
    const continueButton = screen.getByRole("button", {
      name: /continue to hms/i
    });
    expect(continueButton).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/i have saved my recovery codes/i));
    fireEvent.click(continueButton);
    expect(await screen.findByTestId("app")).toBeInTheDocument();
  });

  it("lets a returning user switch to a recovery code on the MFA challenge", async () => {
    const client = fakeClient({
      login: vi.fn().mockResolvedValue({
        next_step: "MFA_REQUIRED",
        challenge: "c9",
        expires_in: 600
      })
    });
    renderFlow(client);
    await screen.findByRole("button", { name: /sign in/i });
    await typeInto(/email/i, "user@example.com");
    await typeInto(/password/i, "secret");
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await screen.findByText(/two-factor authentication/i);
    fireEvent.click(screen.getByRole("button", { name: /use a recovery code/i }));
    expect(screen.getByLabelText(/recovery code/i)).toBeInTheDocument();
  });
});
