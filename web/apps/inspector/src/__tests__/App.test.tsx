import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { mockBootstrapResponse } from "../data/mockSync";

describe("Inspector app", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens to the queue-first work dashboard", async () => {
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "BAT Inspector" })
    ).toBeInTheDocument();
    expect(screen.getByText("Assigned")).toBeInTheDocument();
    expect(screen.getByText("Queued")).toBeInTheDocument();
  });

  it("saves a pressure test draft into the local queue", async () => {
    const user = userEvent.setup();
    render(<App />);

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
    render(<App />);

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

  it("filters the field work queue by search text and urgency", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "BAT Inspector" });

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

    render(<App />);

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

    render(<App />);

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
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const path = String(url);

      if (path.endsWith("/api/v1/sync/bootstrap")) {
        return new Response(JSON.stringify(mockBootstrapResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      if (path.endsWith("/api/v1/sync/changes?since=8")) {
        return new Response(
          JSON.stringify({
            cursor: 9,
            has_more: false,
            changes: [
              {
                seq: 9,
                entity: "RetestSchedule",
                entity_id: "schedule-0891",
                op: "upsert",
                version: 3,
                changed_at: "2026-07-04T01:00:00.000Z",
                payload: {
                  id: "schedule-0891",
                  asset_id: "asset-0891",
                  due_at: "2026-07-04",
                  status: "DUE"
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response("Not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

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
