import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "../App";
import { mockBootstrapResponse } from "../data/mockSync";
import { CONDITION_CHECKS } from "../domain/inspectionForm";
import { outboxStorageKey } from "../offline/outboxStore";

function memoryStorage(): Storage {
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

const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement | HTMLSelectElement;
const button = (name: string) => screen.getByRole("button", { name });

type Payload = Record<string, unknown> & {
  status?: string;
  result?: string;
  pressure_test: {
    applied_pressure_kpa: number;
    hold_time_seconds: number;
    passed: boolean;
    measurements: Record<string, unknown> & { conditions: Record<string, string> };
  };
};

function queuedOperations(): Array<{ entity: string; payload: Payload }> {
  const raw = localStorage.getItem(outboxStorageKey("test-inspector"));
  return raw ? JSON.parse(raw).operations : [];
}

async function open(user: ReturnType<typeof userEvent.setup>, assetNumber: string) {
  await user.click(await screen.findByRole("button", { name: new RegExp(`open ${assetNumber}`, "i") }));
}

async function fillWholeForm(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(field("Instruction"), "REPAIR");
  await user.selectOptions(field("Test time minutes"), "10");
  await user.selectOptions(field("Pressure test result"), "PASS");
  await user.type(field("Ohms end A"), "0.1");
  await user.type(field("Ohms end B"), "0.2");
  await user.type(field("Ohms total"), "0.3");
  await user.click(button("Pass all"));
  await user.selectOptions(field(CONDITION_CHECKS[3].label), "FAIL");
  await user.selectOptions(field("Certificate result"), "FAIL");
  await user.type(field("Notes"), "Kink near end B.");
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(mockBootstrapResponse), { status: 200 }))
  );
});

describe("inspection capture (inspector)", () => {
  it("prefills the pressures from the product rating and leaves everything else unanswered", async () => {
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await open(user, "HOS-2024-0891");

    expect(field("Working pressure kPa")).toHaveValue("1500");
    expect(field("Test pressure kPa")).toHaveValue("2250");
    expect(screen.getByText(/Product rating: 1500 kPa working, 2250 kPa test/)).toBeVisible();
    for (const label of ["Instruction", "Test time minutes", "Pressure test result", "Certificate result"]) {
      expect(field(label)).toHaveValue("");
    }
    for (const { label } of CONDITION_CHECKS) expect(field(label)).toHaveValue("");
    expect(field("Ohms end A")).toHaveValue("");
    expect(button("Save Draft")).toBeDisabled();
    expect(button("Submit")).toBeDisabled();
  });

  it("invents no pressure for a product without a rating", async () => {
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await open(user, "HOS-2025-0201");

    expect(field("Working pressure kPa")).toHaveValue("");
    expect(field("Test pressure kPa")).toHaveValue("");
    expect(screen.getByText(/no rating for the hose's bore/)).toBeVisible();
  });

  it("offers 1, 5 and 10 minutes and marks an override of the rated pressure", async () => {
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await open(user, "HOS-2024-0891");

    expect(within(field("Test time minutes")).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Select",
      "1 min",
      "5 min",
      "10 min"
    ]);
    await user.clear(field("Working pressure kPa"));
    await user.type(field("Working pressure kPa"), "1400");
    expect(screen.getByText(/Overridden\. Product rating: 1500 kPa working/)).toBeVisible();
  });

  it("queues every field of the form under the documented schema", async () => {
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await open(user, "HOS-2024-0891");
    await fillWholeForm(user);
    await user.click(button("Save Draft"));

    const [operation] = queuedOperations().filter((op) => op.entity === "Inspection");
    expect(operation.payload).toMatchObject({ status: "DRAFT", result: "REPAIR" });
    expect(operation.payload.pressure_test).toMatchObject({
      applied_pressure_kpa: 2250,
      hold_time_seconds: 600,
      passed: true
    });
    const measurements = operation.payload.pressure_test.measurements;
    expect(measurements).toMatchObject({
      schema_version: 1,
      working_pressure_kpa: 1500,
      rated_working_pressure_kpa: 1500,
      rated_test_pressure_kpa: 2250,
      test_duration_minutes: 10,
      ohms_end_a: 0.1,
      ohms_end_b: 0.2,
      ohms_total: 0.3,
      certificate_result: "FAIL",
      notes: "Kink near end B."
    });
    expect(measurements.conditions.kink_or_dent).toBe("FAIL");
    expect(measurements.conditions.chemical_attack).toBe("PASS");
    expect(Object.keys(measurements.conditions)).toHaveLength(7);
    // Nothing from the old shape survives.
    expect(operation.payload).not.toHaveProperty("notes");
    expect(operation.payload.pressure_test).not.toHaveProperty("required_pressure_kpa");
  });

  it("reopens a saved draft exactly as it was left, from the local queue", async () => {
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await open(user, "HOS-2024-0891");
    await fillWholeForm(user);
    await user.click(button("Save Draft"));
    await user.click(button("Work queue"));
    await open(user, "HOS-2024-0891");

    expect(field("Instruction")).toHaveValue("REPAIR");
    expect(field("Test time minutes")).toHaveValue("10");
    expect(field("Ohms total")).toHaveValue("0.3");
    expect(field(CONDITION_CHECKS[3].label)).toHaveValue("FAIL");
    expect(field(CONDITION_CHECKS[0].label)).toHaveValue("PASS");
    expect(field("Certificate result")).toHaveValue("FAIL");
    expect(field("Notes")).toHaveValue("Kink near end B.");
  });

  it("shows a draft the server already holds when none is queued on this device", async () => {
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await open(user, "HOS-2025-0156");

    expect(field("Instruction")).toHaveValue("REPAIR");
    expect(field("Working pressure kPa")).toHaveValue("1200");
    expect(field("Test pressure kPa")).toHaveValue("1800");
    expect(field("Test time minutes")).toHaveValue("10");
    expect(field("Pressure test result")).toHaveValue("FAIL");
    expect(field("Ohms end A")).toHaveValue("0.4");
    expect(field(CONDITION_CHECKS[3].label)).toHaveValue("FAIL");
    expect(field("Notes")).toHaveValue("Kink at end B.");
  });

  it("only submits once the whole customer form is filled in", async () => {
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await open(user, "HOS-2024-0891");

    await user.selectOptions(field("Test time minutes"), "5");
    await user.selectOptions(field("Pressure test result"), "PASS");
    expect(button("Save Draft")).toBeEnabled();
    expect(button("Submit")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/To submit, still needed:/);

    await fillWholeFormAfterCore(user);
    expect(button("Submit")).toBeEnabled();
    await user.click(button("Submit"));

    const submitted = queuedOperations().find((op) => op.entity === "Inspection");
    expect(submitted?.payload.status).toBe("SUBMITTED");
    expect(submitted?.payload.pressure_test.measurements.certificate_result).toBe("PASS");
  });

  it("shows an inspection the server already holds as submitted read-only", async () => {
    const user = userEvent.setup();
    const submitted = {
      ...mockBootstrapResponse,
      records: mockBootstrapResponse.records.map((record) =>
        record.entity === "Inspection" && record.entity_id === "inspection-0156"
          ? { ...record, payload: { ...record.payload, status: "SUBMITTED" } }
          : record
      )
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(submitted), { status: 200 })));
    render(<App initialAccessToken="test-access-token" />);
    await open(user, "HOS-2025-0156");

    expect(screen.getByRole("status")).toHaveTextContent(/submitted for review/);
    expect(field("Notes")).toBeDisabled();
    expect(field("Instruction")).toBeDisabled();
    expect(field(CONDITION_CHECKS[3].label)).toBeDisabled();
    expect(field(CONDITION_CHECKS[3].label)).toHaveValue("FAIL");
    expect(screen.queryByRole("button", { name: "Save Draft" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit" })).not.toBeInTheDocument();
  });

  it("sends the structured form to the server when the queue is pushed", async () => {
    const user = userEvent.setup();
    const pushed: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const path = String(url);
        if (path.endsWith("/api/v1/sync/push")) {
          const body = JSON.parse(String(init?.body)) as { operations: Array<{ op_id: string; idempotency_key: string }> };
          pushed.push(body);
          return new Response(
            JSON.stringify({
              cursor: 12,
              results: body.operations.map((operation) => ({
                op_id: operation.op_id,
                idempotency_key: operation.idempotency_key,
                entity: "Inspection",
                entity_id: "x",
                status: "applied",
                version: 2,
                current_version: null,
                payload: null,
                error: null
              }))
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify(mockBootstrapResponse), { status: 200 });
      })
    );
    render(<App initialAccessToken="test-access-token" />);
    await open(user, "HOS-2024-0891");
    await fillWholeForm(user);
    await user.click(button("Save Draft"));
    await user.click(button("Queue"));
    await user.click(button("Push Changes"));

    await waitFor(() => expect(pushed).toHaveLength(1));
    const operation = (pushed[0] as { operations: Array<{ payload: Payload }> }).operations[0];
    expect(operation.payload.result).toBe("REPAIR");
    expect(operation.payload.pressure_test.measurements.ohms_total).toBe(0.3);
    expect(operation.payload.pressure_test.hold_time_seconds).toBe(600);
  });
});

async function fillWholeFormAfterCore(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(field("Instruction"), "PASS");
  await user.type(field("Ohms end A"), "0.1");
  await user.type(field("Ohms end B"), "0.2");
  await user.type(field("Ohms total"), "0.3");
  await user.click(button("Pass all"));
  await user.selectOptions(field("Certificate result"), "PASS");
}
