import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { HmsApiError } from "../api/hmsClient";
import { InspectionDetail } from "../components/InspectionDetail";
import type { InspectionRecord } from "../domain/types";

function inspection(status: InspectionRecord["status"], extra: Partial<InspectionRecord> = {}): InspectionRecord {
  return {
    id: "insp-1", assetId: "a1", inspectionType: "SERVICE", status, result: "PASS",
    inspectorUserId: "inspector-1", reviewerUserId: null, startedAt: null, submittedAt: null,
    approvedAt: null, rejectedAt: null, rejectionReason: null,
    asset: { id: "a1", assetNumber: "HMS-1", assetName: "Main Pump Hose", tag: null, lifecycleStatus: "IN_SERVICE" },
    customer: { id: "c1", code: "C", name: "Acme" }, product: { id: "p1", code: "P", name: "Hose", category: "Hose" },
    pressureTest: null, ...extra
  } as unknown as InspectionRecord;
}

function setup(record: InspectionRecord, extra: Partial<React.ComponentProps<typeof InspectionDetail>> = {}) {
  const props = {
    canApprove: false, canWrite: true, inspection: record,
    onApprove: vi.fn().mockResolvedValue(undefined),
    onBeginRework: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
    onReject: vi.fn().mockResolvedValue(undefined),
    onSaveDraft: vi.fn().mockResolvedValue(undefined),
    onStart: vi.fn().mockResolvedValue(undefined),
    onSubmit: vi.fn().mockResolvedValue(undefined),
    ...extra
  };
  render(<InspectionDetail {...props} />);
  return props;
}

const button = (name: string) => screen.queryByRole("button", { name });
const formLocked = () => screen.getByLabelText("Inspection notes").hasAttribute("disabled");

describe("what each state offers", () => {
  it("DRAFT is read-only and offers only Start", () => {
    setup(inspection("DRAFT"));
    expect(button("Start inspection")).toBeInTheDocument();
    for (const name of ["Save progress", "Submit inspection", "Begin rework", "Approve inspection", "Request changes"]) {
      expect(button(name)).toBeNull();
    }
    expect(formLocked()).toBe(true);
  });

  it("IN_PROGRESS is editable with Save progress and Submit, and no Start", () => {
    setup(inspection("IN_PROGRESS", { startedAt: "2026-10-26T01:00:00Z" }));
    expect(formLocked()).toBe(false);
    expect(button("Save progress")).toBeInTheDocument();
    expect(button("Submit inspection")).toBeInTheDocument();
    expect(button("Start inspection")).toBeNull();
    expect(screen.getByText("In progress")).toBeInTheDocument();
  });

  it("SUBMITTED is locked for the inspector and offers the reviewer Approve and Request changes", () => {
    setup(inspection("SUBMITTED"), { canApprove: true, canWrite: false });
    expect(formLocked()).toBe(true);
    expect(button("Approve inspection")).toBeInTheDocument();
    expect(button("Request changes")).toBeInTheDocument();
    for (const name of ["Start inspection", "Save progress", "Submit inspection", "Begin rework"]) {
      expect(button(name)).toBeNull();
    }
  });

  it("the reviewer's actions appear only for SUBMITTED, and only with the capability", () => {
    for (const status of ["DRAFT", "IN_PROGRESS", "REJECTED", "APPROVED"] as const) {
      const { unmount } = render(<div />);
      unmount();
      const view = render(<InspectionDetail {...baseProps(inspection(status), { canApprove: true })} />);
      expect(button("Approve inspection")).toBeNull();
      expect(button("Request changes")).toBeNull();
      view.unmount();
    }
    const view = render(<InspectionDetail {...baseProps(inspection("SUBMITTED"), { canApprove: false })} />);
    expect(button("Approve inspection")).toBeNull();
    view.unmount();
  });

  it("REJECTED is locked, shows Changes required with the reason, and offers Begin rework", () => {
    setup(inspection("REJECTED", { rejectionReason: "Re-test the hold time" }));
    expect(formLocked()).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent("Changes required");
    expect(screen.getByRole("status")).toHaveTextContent("Re-test the hold time");
    expect(button("Begin rework")).toBeInTheDocument();
    for (const name of ["Save progress", "Submit inspection", "Start inspection"]) expect(button(name)).toBeNull();
  });

  it("REJECTED without the write capability shows the reason and no rework", () => {
    setup(inspection("REJECTED", { rejectionReason: "Re-test" }), { canWrite: false, canApprove: true });
    expect(screen.getByRole("status")).toHaveTextContent("Re-test");
    expect(button("Begin rework")).toBeNull();
  });

  it("APPROVED is final: locked, nothing to do", () => {
    setup(inspection("APPROVED"), { canApprove: true });
    expect(formLocked()).toBe(true);
    for (const name of ["Start inspection", "Save progress", "Submit inspection", "Begin rework", "Approve inspection", "Request changes"]) {
      expect(button(name)).toBeNull();
    }
  });
});

function baseProps(record: InspectionRecord, extra: Partial<React.ComponentProps<typeof InspectionDetail>> = {}) {
  return {
    canApprove: false, canWrite: true, inspection: record,
    onApprove: vi.fn(), onBeginRework: vi.fn(), onClose: vi.fn(), onReject: vi.fn(),
    onSaveDraft: vi.fn(), onStart: vi.fn(), onSubmit: vi.fn(), ...extra
  };
}

describe("the transitions", () => {
  it("Start asks the owner to start, with a pending label", async () => {
    let finish!: () => void;
    const onStart = vi.fn().mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    setup(inspection("DRAFT"), { onStart });
    await userEvent.setup().click(button("Start inspection")!);
    expect(await screen.findByRole("button", { name: "Starting…" })).toBeDisabled();
    expect(onStart).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  it("Begin rework asks the owner to begin it", async () => {
    const props = setup(inspection("REJECTED", { rejectionReason: "x" }));
    await userEvent.setup().click(button("Begin rework")!);
    expect(props.onBeginRework).toHaveBeenCalledTimes(1);
  });

  it("Request changes needs a reason before anything is sent, then sends it", async () => {
    const user = userEvent.setup();
    const props = setup(inspection("SUBMITTED"), { canApprove: true, canWrite: false });
    await user.click(button("Request changes")!);
    await user.click(button("Send back for changes")!);
    expect(props.onReject).not.toHaveBeenCalled();
    expect(screen.getByLabelText("What needs to change")).toHaveAccessibleDescription(/Say what needs to change/);
    await user.type(screen.getByLabelText("What needs to change"), "  Hold time too short ");
    await user.click(button("Send back for changes")!);
    expect(props.onReject).toHaveBeenCalledWith("Hold time too short");
  });

  it("a conflict (the record moved on) is shown as the server states it and refreshes the list", async () => {
    const onRefresh = vi.fn();
    const onStart = vi.fn().mockRejectedValue(new HmsApiError(409, "conflict", "Only a draft inspection can be started", null));
    setup(inspection("DRAFT"), { onStart, onRefresh });
    await userEvent.setup().click(button("Start inspection")!);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Only a draft inspection can be started");
    expect(onRefresh).toHaveBeenCalled();
    await waitFor(() => expect(button("Start inspection")).toBeEnabled());
  });
});
