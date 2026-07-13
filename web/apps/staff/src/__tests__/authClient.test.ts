import { describe, expect, it, vi } from "vitest";

import { createBrowserAuthClient } from "../auth/authClient";

describe("browser auth password reset client", () => {
  it("posts a reset request to the browser-auth endpoint", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          message: "If that email exists, a password reset link has been sent."
        }),
        { status: 202, headers: { "Content-Type": "application/json" } }
      )
    );
    const client = createBrowserAuthClient({ fetcher });

    await client.requestPasswordReset("User@Example.com");

    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/auth/browser/password/reset-request",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "User@Example.com" })
      })
    );
  });

  it("posts the one-time token and new password to confirm reset", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "Password reset." }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    const client = createBrowserAuthClient({ fetcher });

    await client.confirmPasswordReset("opaque-token", "A-New-Password-9!");

    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/auth/browser/password/reset-confirm",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          token: "opaque-token",
          new_password: "A-New-Password-9!"
        })
      })
    );
  });
});
