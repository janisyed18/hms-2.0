import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { createHmsClient } from "../api/hmsClient";
import { AuthProvider, useAuth } from "../auth/AuthProvider";
import type { BrowserAuthClient } from "../auth/authClient";
import { BrowserAuthError } from "../auth/authTypes";

const ME = {
  user_id: "u-1",
  email: "admin@example.com",
  display_name: "Alex Admin",
  account_status: "ACTIVE",
  roles: ["HMS_ADMIN"],
  permissions: [],
  customer_ids: []
};

const REAUTH_REFUSAL = {
  ok: false,
  status: 403,
  headers: new Headers(),
  json: async () => ({
    detail: { code: "REAUTH_REQUIRED", message: "Confirm your password to continue.", method: "password" },
    error: {
      code: "forbidden",
      message: "Request failed",
      details: { code: "REAUTH_REQUIRED", message: "Confirm your password to continue.", method: "password" }
    }
  })
};

const OK = {
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => ({ total: 0, limit: 50, offset: 0, items: [] })
};

function authClient(reauth: BrowserAuthClient["reauth"]): BrowserAuthClient {
  return {
    refresh: vi.fn().mockResolvedValue({ access_token: "access-1" }),
    me: vi.fn().mockResolvedValue(ME),
    logout: vi.fn().mockResolvedValue(undefined),
    reauth
  } as unknown as BrowserAuthClient;
}

function Harness({ fetcher }: { fetcher: typeof fetch }) {
  const auth = useAuth();
  const [outcome, setOutcome] = useState("idle");
  return (
    <div>
      <span data-testid="status">{auth.state.status}</span>
      <span data-testid="outcome">{outcome}</span>
      <button
        type="button"
        onClick={() =>
          createHmsClient({ fetcher })
            .listCustomers()
            .then(() => setOutcome("done"), (error: Error) => setOutcome(`failed: ${error.message}`))
        }
      >
        do sensitive thing
      </button>
    </div>
  );
}

async function renderSignedIn(client: BrowserAuthClient, fetcher: typeof fetch) {
  render(
    <AuthProvider client={client}>
      <Harness fetcher={fetcher} />
    </AuthProvider>
  );
  await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("authenticated"));
}

function authorization(fetcher: ReturnType<typeof vi.fn>, call: number): string {
  return (fetcher.mock.calls[call][1]?.headers as Record<string, string>).authorization;
}

function fillAndConfirm(password: string, code: string) {
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Authenticator code"), { target: { value: code } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
}

describe("step-up reauthentication", () => {
  it("asks for the password, then retries the original request once with the fresh token", async () => {
    const reauth = vi.fn().mockResolvedValue({ access_token: "access-fresh" });
    const fetcher = vi.fn().mockResolvedValueOnce(REAUTH_REFUSAL).mockResolvedValueOnce(OK);
    await renderSignedIn(authClient(reauth), fetcher as unknown as typeof fetch);

    fireEvent.click(screen.getByText("do sensitive thing"));
    expect(await screen.findByRole("dialog", { name: "Confirm it is you" })).toBeTruthy();
    fillAndConfirm("hunter2-correct", "123456");

    await waitFor(() => expect(screen.getByTestId("outcome").textContent).toBe("done"));
    expect(reauth).toHaveBeenCalledWith("access-1", "hunter2-correct", "123456");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(authorization(fetcher, 0)).toBe("Bearer access-1");
    expect(authorization(fetcher, 1)).toBe("Bearer access-fresh");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays open with the reason after a wrong password and does not retry yet", async () => {
    const reauth = vi
      .fn()
      .mockRejectedValueOnce(new BrowserAuthError("That password or code was not correct.", 400))
      .mockResolvedValueOnce({ access_token: "access-fresh" });
    const fetcher = vi.fn().mockResolvedValueOnce(REAUTH_REFUSAL).mockResolvedValueOnce(OK);
    await renderSignedIn(authClient(reauth), fetcher as unknown as typeof fetch);

    fireEvent.click(screen.getByText("do sensitive thing"));
    await screen.findByRole("dialog");
    fillAndConfirm("wrong", "000000");

    expect(await screen.findByText("That password or code was not correct.")).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("status").textContent).toBe("authenticated");

    fillAndConfirm("hunter2-correct", "123456");
    await waitFor(() => expect(screen.getByTestId("outcome").textContent).toBe("done"));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("surfaces the original refusal and makes no retry when the user cancels", async () => {
    const reauth = vi.fn();
    const fetcher = vi.fn().mockResolvedValue(REAUTH_REFUSAL);
    await renderSignedIn(authClient(reauth), fetcher as unknown as typeof fetch);

    fireEvent.click(screen.getByText("do sensitive thing"));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.getByTestId("outcome").textContent).toMatch(/^failed/));
    expect(reauth).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("submits once even if confirm is pressed repeatedly while the check is running", async () => {
    let finish!: (value: { access_token: string }) => void;
    const reauth = vi.fn().mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const fetcher = vi.fn().mockResolvedValueOnce(REAUTH_REFUSAL).mockResolvedValueOnce(OK);
    await renderSignedIn(authClient(reauth), fetcher as unknown as typeof fetch);

    fireEvent.click(screen.getByText("do sensitive thing"));
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2-correct" } });
    const form = screen.getByLabelText("Password").closest("form") as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(reauth).toHaveBeenCalledTimes(1);

    finish({ access_token: "access-fresh" });
    await waitFor(() => expect(screen.getByTestId("outcome").textContent).toBe("done"));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not loop when the retried request is refused again", async () => {
    const reauth = vi.fn().mockResolvedValue({ access_token: "access-fresh" });
    const fetcher = vi.fn().mockResolvedValue(REAUTH_REFUSAL);
    await renderSignedIn(authClient(reauth), fetcher as unknown as typeof fetch);

    fireEvent.click(screen.getByText("do sensitive thing"));
    await screen.findByRole("dialog");
    fillAndConfirm("hunter2-correct", "123456");

    await waitFor(() => expect(screen.getByTestId("outcome").textContent).toMatch(/^failed/));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(reauth).toHaveBeenCalledTimes(1);
  });

  it("signs out when the server says the session itself has ended", async () => {
    const reauth = vi.fn().mockRejectedValue(new BrowserAuthError("Your session has expired; please sign in again.", 401));
    const fetcher = vi.fn().mockResolvedValue(REAUTH_REFUSAL);
    await renderSignedIn(authClient(reauth), fetcher as unknown as typeof fetch);

    fireEvent.click(screen.getByText("do sensitive thing"));
    await screen.findByRole("dialog");
    fillAndConfirm("hunter2-correct", "123456");

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed-out"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
