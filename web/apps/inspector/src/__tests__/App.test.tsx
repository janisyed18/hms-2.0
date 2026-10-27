import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { BrowserAuthClient } from "../auth/browserAuthClient";
import { mockBootstrapResponse } from "../data/mockSync";
import { bootstrapCalls, bootstrapOnly, bootstrapSequence, withChangeFeed } from "../test/syncFetch";
import {
  createInspectionOperation,
  createPressureTestOperation,
  outboxStorageKey,
  saveOutbox
} from "../offline/outboxStore";
import { defaultSyncStore, resetDefaultSyncStore } from "../offline/syncStore";

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

// The form starts unanswered: a draft needs the pressure test core, a submission needs
// the whole customer form.
async function fillDraftCore(user: ReturnType<typeof userEvent.setup>) {
  // The form is read-only until the inspection is started.
  const start = screen.queryByRole("button", { name: "Start inspection" });
  if (start) await user.click(start);
  await user.selectOptions(screen.getByLabelText("Test time minutes"), "5");
  await user.selectOptions(screen.getByLabelText("Pressure test result"), "PASS");
}

async function fillWholeForm(user: ReturnType<typeof userEvent.setup>) {
  await fillDraftCore(user);
  await user.selectOptions(screen.getByLabelText("Instruction"), "PASS");
  await user.type(screen.getByLabelText("Ohms end A"), "0.1");
  await user.type(screen.getByLabelText("Ohms end B"), "0.2");
  await user.type(screen.getByLabelText("Ohms total"), "0.3");
  await user.click(screen.getByRole("button", { name: "Pass all" }));
  await user.selectOptions(screen.getByLabelText("Certificate result"), "PASS");
}

describe("Inspector app", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetDefaultSyncStore();
    vi.stubGlobal("localStorage", createMemoryStorage());
    vi.stubGlobal("fetch", bootstrapOnly());
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
    const fetchMock = bootstrapSequence(
      mockBootstrapResponse,
      { ...mockBootstrapResponse, records: [], work_contexts: [] }
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialAccessToken="test-access-token" />);

    await user.click(await screen.findByRole("button", { name: /open HOS-2024-0891/i }));
    await fillDraftCore(user);
    await user.click(screen.getByRole("button", { name: "Save progress" }));
    fireEvent(window, new Event("online"));
    await waitFor(() => expect(bootstrapCalls(fetchMock)).toBe(2));
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
    const fetchMock = bootstrapSequence(mockBootstrapResponse, revised);
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialAccessToken="test-access-token" />);
    await user.click(await screen.findByRole("button", { name: /open HOS-2024-0891/i }));
    fireEvent(window, new Event("online"));
    await waitFor(() => expect(bootstrapCalls(fetchMock)).toBe(2));
    expect(screen.queryByRole("button", { name: "Save progress" })).not.toBeInTheDocument();
  });

  it("expires access after the server-provided offline window", async () => {
    vi.stubGlobal("fetch", bootstrapOnly({
      ...mockBootstrapResponse,
      device: { ...mockBootstrapResponse.device, offline_window_days: 0 }
    }));
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

  it("keeps the sign-in form disabled while browser authentication is pending", async () => {
    const user = userEvent.setup();
    const authClient = createAuthClient(["INSPECTOR"]);
    let completeLogin: (response: Awaited<ReturnType<BrowserAuthClient["login"]>>) => void;
    vi.mocked(authClient.login).mockImplementation(
      () => new Promise((resolve) => { completeLogin = resolve; })
    );
    render(<App authClient={authClient} />);

    await user.type(screen.getByLabelText("Email"), "inspector@example.test");
    await user.type(screen.getByLabelText("Password"), "correct-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(screen.getByRole("button", { name: "Signing in…" })).toBeDisabled();
    expect(screen.getByLabelText("Email").closest("form")).toHaveAttribute("aria-busy", "true");

    completeLogin!({
      next_step: "AUTHENTICATED",
      access_token: "inspector-access-token",
      token_type: "bearer",
      expires_in: 900
    });

    expect(await screen.findByRole("heading", { name: "Inspector" })).toBeInTheDocument();
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
    await fillDraftCore(user);
    await user.click(screen.getByRole("button", { name: "Save progress" }));
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

  it("removes the previous inspector's saved assignments when someone else signs in, but not their queue", async () => {
    const user = userEvent.setup();
    const authClient = createAuthClient(["INSPECTOR"], "inspector-a");
    render(<App authClient={authClient} />);
    await user.type(screen.getByLabelText("Email"), "a@example.test");
    await user.type(screen.getByLabelText("Password"), "correct-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await user.click(await screen.findByRole("button", { name: /open HOS-2024-0891/i }));
    await fillDraftCore(user);
    await user.click(screen.getByRole("button", { name: "Save progress" }));
    await user.click(screen.getByRole("button", { name: "Queue" }));
    const store = defaultSyncStore();
    const sent = vi.mocked(fetch).mock.calls[0][1] as { headers: Record<string, string> };
    const deviceId = sent.headers["X-HMS-Device-Id"];
    const savedFor = (userId: string) =>
      store.loadActive({ userId, deviceId, protocol: 3 });
    await waitFor(async () => expect(await savedFor("inspector-a")).not.toBeNull());

    // The session ends (the server refuses the token and the refresh), then B signs in.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("no", { status: 401 })));
    fireEvent(window, new Event("online"));
    await screen.findByLabelText("Email");
    vi.mocked(authClient.me).mockResolvedValue({
      user_id: "inspector-b",
      email: "b@example.test",
      display_name: "B",
      roles: ["INSPECTOR"]
    });
    vi.stubGlobal("fetch", bootstrapOnly());
    await user.type(screen.getByLabelText("Email"), "b@example.test");
    await user.type(screen.getByLabelText("Password"), "correct-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("heading", { name: "Inspector" });

    await waitFor(async () => expect(await savedFor("inspector-a")).toBeNull());
    expect(localStorage.getItem(outboxStorageKey("inspector-a"))).not.toBeNull();
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
    await user.click(screen.getByRole("button", { name: "Start inspection" }));
    await user.clear(screen.getByLabelText("Test pressure kPa"));
    await user.type(screen.getByLabelText("Test pressure kPa"), "2400");
    await user.selectOptions(screen.getByLabelText("Test time minutes"), "5");
    await user.selectOptions(screen.getByLabelText("Pressure test result"), "PASS");
    await fillDraftCore(user);
    await user.click(screen.getByRole("button", { name: "Save progress" }));
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

  it("drains operations queued by app 0.2.0 after an upgrade, the inspection before its pressure test", async () => {
    const user = userEvent.setup();
    const context = {
      appointment_id: "appointment-asset-0891", booking_id: "booking-asset-0891",
      revision_id: "revision-asset-0891", assignment_id: "assignment-asset-0891", asset_id: "asset-0891"
    };
    const measurements = { schema_version: 1, working_pressure_kpa: 1500, test_duration_minutes: 5 };
    const inspection = createInspectionOperation({
      workContext: context, assetId: "asset-0891", assetNumber: "HOS-2024-0891", customerName: "North Sea Shipping Ltd",
      inspectionId: "local-old-1", baseVersion: null, lifecycleActions: [], result: "PASS",
      pressureTest: { appliedPressureKpa: 2250, holdTimeSeconds: 300, passed: true, measurements }
    });
    // The shape app 0.2.0 stored: a status in the payload and no lifecycle actions.
    const legacyInspection = { ...inspection, lifecycleActions: undefined, payload: { ...inspection.payload, status: "DRAFT" } };
    const pressure = createPressureTestOperation({
      workContext: context, assetId: "asset-0891", assetNumber: "HOS-2024-0891", customerName: "North Sea Shipping Ltd",
      inspectionId: "local-old-1", pressureTestId: "local-old-pressure", baseVersion: null,
      appliedPressureKpa: 2250, holdTimeSeconds: 300, passed: true, measurements
    });
    // Stored with the pressure test ahead of the inspection it refers to.
    saveOutbox("test-inspector", [pressure, legacyInspection]);
    const pushed: Array<{ entity: string; lifecycle_actions?: unknown; payload: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(withChangeFeed(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/v1/sync/push")) {
        const body = JSON.parse(String(init?.body)) as { operations: Array<{ op_id: string; idempotency_key: string; entity: string; entity_id: string; lifecycle_actions?: unknown; payload: Record<string, unknown> }> };
        pushed.push(...body.operations);
        return new Response(JSON.stringify({
          cursor: 9,
          results: body.operations.map((operation) => ({
            op_id: operation.op_id, idempotency_key: operation.idempotency_key, entity: operation.entity,
            entity_id: operation.entity_id, status: "applied", version: 1, current_version: 1, payload: null, error: null
          }))
        }), { status: 200 });
      }
      return new Response(JSON.stringify(mockBootstrapResponse), { status: 200 });
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialAccessToken="test-access-token" />);
    await screen.findByRole("button", { name: /open HOS-2024-0891/i });
    await user.click(screen.getByRole("button", { name: "Queue" }));
    expect(screen.getByText("2 pending")).toBeInTheDocument();
    expect(screen.queryByText(/draft.*preserved.*cannot be submitted/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Push Changes" }));
    await waitFor(() => expect(pushed).toHaveLength(2));
    // The inspection goes first, in the shape it was queued in: no lifecycle actions invented.
    expect(pushed.map((operation) => operation.entity)).toEqual(["Inspection", "PressureTestResult"]);
    expect(pushed[0]).not.toHaveProperty("lifecycle_actions");
    expect(pushed[0].payload.status).toBe("DRAFT");
  });

  it("filters the field work queue by search text and urgency", async () => {
    const user = userEvent.setup();
    const started = {
      ...mockBootstrapResponse,
      records: mockBootstrapResponse.records.map((record) =>
        record.entity === "Inspection" && record.entity_id === "inspection-0156"
          ? { ...record, payload: { ...record.payload, status: "IN_PROGRESS" } }
          : record
      )
    };
    vi.stubGlobal("fetch", bootstrapOnly(started));
    render(<App initialAccessToken="test-access-token" />);

    await screen.findByRole("heading", { name: "Inspector" });

    await user.type(screen.getByLabelText("Search work"), "Pacific");

    expect(screen.getByText("HOS-2025-0201")).toBeInTheDocument();
    expect(screen.queryByText("HOS-2024-0891")).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText("Search work"));
    await user.click(screen.getByRole("button", { name: "In progress" }));

    expect(screen.getByText("HOS-2025-0156")).toBeInTheDocument();
    expect(screen.queryByText("HOS-2024-0891")).not.toBeInTheDocument();
  });

  it("lets rejected sync operations be pushed again", async () => {
    const user = userEvent.setup();
    let pushAttempts = 0;
    const fetchMock = vi.fn(withChangeFeed(async (url: RequestInfo | URL, init?: RequestInit) => {
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
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialAccessToken="test-access-token" />);

    await user.click(
      await screen.findByRole("button", { name: /open HOS-2024-0891/i })
    );
    await fillWholeForm(user);
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
    const fetchMock = vi.fn(withChangeFeed(async (url: RequestInfo | URL, init?: RequestInit) => {
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
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialAccessToken="test-access-token" />);

    await user.click(
      await screen.findByRole("button", { name: /open HOS-2024-0891/i })
    );
    await fillWholeForm(user);
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
    const fetchMock = vi.fn(withChangeFeed(async (url: RequestInfo | URL) => {
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
    }));
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
