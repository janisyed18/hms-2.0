import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { mockBootstrapResponse } from "../data/mockSync";

describe("Inspector app", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
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
});
