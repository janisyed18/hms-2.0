import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { BrowserAuthClient } from "../auth/browserAuthClient";
import { mockBootstrapResponse } from "../data/mockSync";
import { outboxStorageKey } from "../offline/outboxStore";

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  };
}

function createAuthClient(
  roles: string[],
  userId = "inspector-1"
): BrowserAuthClient {
  return {
    login: vi.fn().mockResolvedValue({
      next_step: "AUTHENTICATED",
      access_token: "inspector-access-token",
      token_type: "bearer",
      expires_in: 900
    }),
    requestPasswordReset: vi.fn(),
    changePassword: vi.fn(),
    startEnrollment: vi.fn(),
    confirmMfa: vi.fn(),
    verifyMfa: vi.fn(),
    verifyRecovery: vi.fn(),
    refresh: vi.fn().mockRejectedValue(new Error("No refresh session")),
    logout: vi.fn().mockResolvedValue(undefined),
    me: vi.fn().mockResolvedValue({
      user_id: userId,
      email: "inspector@example.test",
      display_name: "Field Inspector",
      roles
    })
  };
}

describe("Inspector app", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.stubGlobal("localStorage", createMemoryStorage());
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify(mockBootstrapResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    ));
  });

  it("requires secure inspector sign-in before showing field work", async () => {
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Inspector sign in" })
    ).toBeInTheDocument();
    expect(screen.queryByText("Assigned")).not.toBeInTheDocument();
    expect(screen.queryByText("Queued")).not.toBeInTheDocument();
  });

  it("does not display mock jobs when bootstrap fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Offline")));
    render(<App initialAccessToken="test-access-token" />);

    expect(await screen.findByText(/unable to load assigned work/i)).toBeInTheDocument();
    expect(screen.queryByText("HOS-2024-0891")).not.toBeInTheDocument();
    expect(screen.queryByText("HOS-2025-0201")).not.toBeInTheDocument();
  });

  it("hides reassigned work on reconnect without deleting its queued draft", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(mockBootstrapResponse), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...mockBootstrapResponse, records: [], work_contexts: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialAccessToken="test-access-token" />);

    await user.click(await screen.findByRole("button", { name: /open HOS-2024-0891/i }));
    await user.click(screen.getByRole("button", { name: "Save Draft" }));
    fireEvent(window, new Event("online"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Queue" }));
    expect(await screen.findByText("No queued work")).toBeInTheDocument();
    expect(screen.getByText(/draft.*preserved.*cannot be submitted/i)).toBeInTheDocument();
    expect(screen.queryByText("HOS-2024-0891")).not.toBeInTheDocument();
    expect(localStorage.getItem(outboxStorageKey("test-inspector"))).toContain("HOS-2024-0891");
  });

  it("closes the selected work item when its appointment revision changes", async () => {
    const user = userEvent.setup();
    const revised = {
      ...mockBootstrapResponse,
      work_contexts: mockBootstrapResponse.work_contexts?.map((context) => ({
        ...context, revision_id: `new-${context.revision_id}`
      }))
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(mockBootstrapResponse), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(revised), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialAccessToken="test-access-token" />);
    await user.click(await screen.findByRole("button", { name: /open HOS-2024-0891/i }));
    fireEvent(window, new Event("online"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "Save Draft" })).not.toBeInTheDocument();
  });

  it("expires access after the server-provided offline window", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...mockBootstrapResponse,
      device: { ...mockBootstrapResponse.device, offline_window_days: 0 }
    }), { status: 200 })));
    render(<App initialAccessToken="test-access-token" />);

    expect(await screen.findByText(/offline access expired/i)).toBeInTheDocument();
    expect(screen.queryByText("HOS-2024-0891")).not.toBeInTheDocument();
  });

  it("opens the workspace only after browser authentication confirms the Inspector role", async () => {
    const user = userEvent.setup();
    const authClient = createAuthClient(["INSPECTOR"]);
    render(<App authClient={authClient} />);

    await user.type(screen.getByLabelText("Email"), "inspector@example.test");
    await user.type(screen.getByLabelText("Password"), "correct-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("heading", { name: "Inspector" })).toBeInTheDocument();
    expect(authClient.me).toHaveBeenCalledWith("inspector-access-token");
  });

  it("denies an authenticated user without the Inspector role", async () => {
    const authClient = createAuthClient(["HMS_ADMIN"]);
    vi.mocked(authClient.refresh).mockResolvedValueOnce({
      next_step: "AUTHENTICATED",
      access_token: "admin-access-token",
      token_type: "bearer",
      expires_in: 900
    });
    render(<App authClient={authClient} />);

    expect(
      await screen.findByRole("heading", { name: "Inspector access required" })
    ).toBeInTheDocument();
    expect(screen.queryByText("Assigned")).not.toBeInTheDocument();
    expect(authClient.logout).toHaveBeenCalledOnce();
  });

  it("isolates offline work between inspector sessions on a shared browser", async () => {
    const user = userEvent.setup();
    const inspectorA = createAuthClient(["INSPECTOR"], "inspector-a");
    const firstSession = render(<App authClient={inspectorA} />);

    await user.type(screen.getByLabelText("Email"), "a@example.test");
    await user.type(screen.getByLabelText("Password"), "correct-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await user.click(
      await screen.findByRole("button", { name: /open HOS-2024-0891/i })
    );
    await user.click(screen.getByRole("button", { name: "Save Draft" }));
    await user.click(screen.getByRole("button", { name: "Queue" }));

    expect(screen.getByText("1 pending")).toBeInTheDocument();
    expect(localStorage.getItem(outboxStorageKey("inspector-a"))).not.toBeNull();

    firstSession.unmount();

    const inspectorB = createAuthClient(["INSPECTOR"], "inspector-b");
    const secondSession = render(<App authClient={inspectorB} />);

    await user.type(screen.getByLabelText("Email"), "b@example.test");
    await user.type(screen.getByLabelText("Password"), "correct-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await user.click(screen.getByRole("button", { name: "Queue" }));

    expect(await screen.findByText("No queued work")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Push Changes" })).toBeDisabled();

    secondSession.unmount();

    const returnSession = render(<App authClient={createAuthClient(["INSPECTOR"], "inspector-a")} />);

    await user.type(screen.getByLabelText("Email"), "a@example.test");
    await user.type(screen.getByLabelText("Password"), "correct-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await user.click(screen.getByRole("button", { name: "Queue" }));

    expect(await screen.findByText("1 pending")).toBeInTheDocument();
    returnSession.unmount();
  });

  it("syncs each inspector on a shared browser under their own device id", async () => {
    const user = userEvent.setup();
    const signIn = async (subject: string, email: string) => {
      const session = render(
        <App authClient={createAuthClient(["INSPECTOR"], subject)} />
      );
      await user.type(screen.getByLabelText("Email"), email);
      await user.type(screen.getByLabelText("Password"), "correct-password");
      await user.click(screen.getByRole("button", { name: "Sign in" }));
      await screen.findByRole("button", { name: /open HOS-2024-0891/i });
      session.unmount();
    };
    const deviceIds = () =>
      vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => String(url).includes("/api/v1/sync/"))
        .map(([, init]) => (init?.headers as Record<string, string>)["X-HMS-Device-Id"]);

    await signIn("inspector-a", "a@example.test");
    const [firstA] = deviceIds();
    await signIn("inspector-b", "b@example.test");
    const idsAfterB = deviceIds();
    await signIn("inspector-a", "a@example.test");
    const idsAfterReturn = deviceIds();

    // The server refuses a device id registered to another user, so a shared browser
    // profile must not send one inspector's id for another.
    expect(idsAfterB[idsAfterB.length - 1]).not.toEqual(firstA);
    // The same inspector keeps the same device across sessions.
    expect(idsAfterReturn[idsAfterReturn.length - 1]).toEqual(firstA);
    expect(firstA).toMatch(/^inspector-browser-/);
  });

  it("saves a pressure test draft into the local queue", async () => {
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);

    await user.click(
      await screen.findByRole("button", { name: /open HOS-2024-0891/i })
    );
    await user.clear(screen.getByLabelText("Applied pressure"));
    await user.type(screen.getByLabelText("Applied pressure"), "30.2");
    await user.clear(screen.getByLabelText("Hold time"));
    await user.type(screen.getByLabelText("Hold time"), "300");
    await user.click(screen.getByRole("button", { name: "Save Draft" }));
    await user.click(screen.getByRole("button", { name: "Queue" }));

    expect(screen.getByText("1 pending")).toBeInTheDocument();
    expect(screen.getByText("HOS-2024-0891")).toBeInTheDocument();
  });

  it("queues asset metadata changes from capture", async () => {
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);

    await user.click(
      await screen.findByRole("button", { name: /open HOS-2024-0891/i })
    );
    await user.clear(screen.getByLabelText("Customer serial number"));
    await user.type(screen.getByLabelText("Customer serial number"), "FIELD-SN-0891");
    await user.clear(screen.getByLabelText("Asset tag"));
    await user.type(screen.getByLabelText("Asset tag"), "FIELD-TAG-0891");
    await user.click(screen.getByRole("button", { name: "Queue Asset Details" }));
    await user.click(screen.getByRole("button", { name: "Queue" }));

    expect(screen.getByText("1 pending")).toBeInTheDocument();
    expect(screen.getByText("Asset · update · asset-0891")).toBeInTheDocument();
  });

  it("keeps a pressure result queued with its unsynced inspection", async () => {
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await user.click(await screen.findByRole("button", { name: /open HOS-2024-0891/i }));
    await user.click(screen.getByRole("button", { name: "Save Draft" }));
    await user.click(screen.getByRole("button", { name: "Queue Test Result" }));
    await user.click(screen.getByRole("button", { name: "Queue" }));
    expect(screen.getByText("2 pending")).toBeInTheDocument();
    expect(screen.queryByText(/draft.*preserved.*cannot be submitted/i)).not.toBeInTheDocument();
  });

  it("filters the field work queue by search text and urgency", async () => {
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);

    await screen.findByRole("heading", { name: "Inspector" });

    await user.type(screen.getByLabelText("Search work"), "Pacific");

    expect(screen.getByText("HOS-2025-0201")).toBeInTheDocument();
    expect(screen.queryByText("HOS-2024-0891")).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText("Search work"));
    await user.click(screen.getByRole("button", { name: "Drafts" }));

    expect(screen.getByText("HOS-2025-0156")).toBeInTheDocument();
    expect(screen.queryByText("HOS-2024-0891")).not.toBeInTheDocument();
  });

  it("lets rejected sync operations be pushed again", async () => {
    const user = userEvent.setup();
    let pushAttempts = 0;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);

      if (path.endsWith("/api/v1/sync/bootstrap")) {
        return new Response(JSON.stringify(mockBootstrapResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      if (path.endsWith("/api/v1/sync/push")) {
        pushAttempts += 1;

        if (pushAttempts === 1) {
          return new Response("temporary outage", { status: 503 });
        }

        const body = JSON.parse(String(init?.body)) as {
          operations: Array<{ op_id: string; idempotency_key: string }>;
        };
        return new Response(
          JSON.stringify({
            cursor: 11,
            results: [
              {
                op_id: body.operations[0].op_id,
                idempotency_key: body.operations[0].idempotency_key,
                entity: "Inspection",
                entity_id: "local-hos-2024-0891",
                status: "applied",
                version: 5,
                current_version: null,
                payload: null,
                error: null
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response("Not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialAccessToken="test-access-token" />);

    await user.click(
      await screen.findByRole("button", { name: /open HOS-2024-0891/i })
    );
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await user.click(screen.getByRole("button", { name: "Queue" }));
    await user.click(screen.getByRole("button", { name: "Push Changes" }));

    expect(await screen.findByText("Rejected")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Push Changes" }));

    expect(await screen.findByText("Applied")).toBeInTheDocument();
    expect(pushAttempts).toBe(2);
  });

  it("shows server conflicts returned from sync push", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);

      if (path.endsWith("/api/v1/sync/bootstrap")) {
        return new Response(JSON.stringify(mockBootstrapResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      if (path.endsWith("/api/v1/sync/push")) {
        const body = JSON.parse(String(init?.body)) as {
          operations: Array<{ op_id: string; idempotency_key: string }>;
        };
        return new Response(
          JSON.stringify({
            cursor: 10,
            results: [
              {
                op_id: body.operations[0].op_id,
                idempotency_key: body.operations[0].idempotency_key,
                entity: "Inspection",
                entity_id: "local-hos-2024-0891",
                status: "conflict",
                version: null,
                current_version: 4,
                payload: { result: "SERVER_VERSION" },
                error: null
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response("Not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialAccessToken="test-access-token" />);

    await user.click(
      await screen.findByRole("button", { name: /open HOS-2024-0891/i })
    );
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await user.click(screen.getByRole("button", { name: "Queue" }));
    await user.click(screen.getByRole("button", { name: "Push Changes" }));

    expect(await screen.findByText("Conflict")).toBeInTheDocument();
    expect(screen.getByText("Server version 4")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep Local Draft" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Accept Server State" })
    ).toBeInTheDocument();
  });

  it("pulls backend changes into the visible work queue", async () => {
    const user = userEvent.setup();
    let bootstraps = 0;
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const path = String(url);

      if (path.endsWith("/api/v1/sync/bootstrap")) {
        bootstraps += 1;
        const records = mockBootstrapResponse.records.map((record) =>
          bootstraps > 1 && record.entity_id === "schedule-0891"
            ? { ...record, payload: { ...record.payload, status: "DUE", due_at: "2026-07-04" } }
            : record
        );
        return new Response(JSON.stringify({ ...mockBootstrapResponse, records }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      return new Response("Not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialAccessToken="test-access-token" />);

    const assetBefore = await screen.findByRole("heading", {
      name: "HOS-2024-0891"
    });
    expect(within(assetBefore.closest("article")!).getByText("Overdue retest"))
      .toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Queue" }));
    await user.click(screen.getByRole("button", { name: "Pull Updates" }));
    await user.click(screen.getByRole("button", { name: "Work" }));

    await waitFor(() => {
      const assetAfter = screen.getByRole("heading", {
        name: "HOS-2024-0891"
      });
      expect(within(assetAfter.closest("article")!).getByText("Due today"))
        .toBeInTheDocument();
    });
  });
});
