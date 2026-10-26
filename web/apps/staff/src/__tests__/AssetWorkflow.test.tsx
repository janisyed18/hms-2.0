import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HmsApiError } from "../api/hmsClient";
import { AssetWorkflowCard } from "../components/AssetWorkflowCard";
import type { AssetWorkflow, AssetWorkflowAction } from "../domain/types";

const client = vi.hoisted(() => ({ getAssetWorkflow: vi.fn() }));

vi.mock("../api/hmsClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/hmsClient")>()),
  createHmsClient: () => client
}));

const action = (over: Partial<AssetWorkflowAction> = {}): AssetWorkflowAction => ({
  code: "REVIEW_INSPECTION", label: "Review inspection", targetType: "INSPECTION", targetId: "insp-1", inspectionId: null, ...over
});
const workflow = (over: Partial<AssetWorkflow> = {}): AssetWorkflow => ({
  status: "AWAITING_REVIEW",
  label: "Inspection submitted — awaiting approval",
  detail: "The inspection was submitted and is waiting for an authorised reviewer.",
  attention: false,
  related: { bookingId: null, appointmentId: null, inspectionId: "insp-1", certificateId: null },
  context: { scheduledAt: null, dueAt: "2026-09-01", certificateNumber: null },
  nextAction: action(),
  ...over
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => client.getAssetWorkflow.mockReset());

const card = (props: { assetId?: string; canOpen?: (a: AssetWorkflowAction) => boolean; onAction?: (a: AssetWorkflowAction) => void } = {}) => (
  <AssetWorkflowCard assetId={props.assetId ?? "asset-1"} canOpen={props.canOpen ?? (() => true)} onAction={props.onAction ?? vi.fn()} />
);

describe("the workflow card", () => {
  it("shows the status, the explanation, the context and the next action", async () => {
    client.getAssetWorkflow.mockResolvedValue(workflow({ context: { scheduledAt: "2026-10-26T01:00:00Z", dueAt: "2026-09-01", certificateNumber: "CERT-7" } }));
    render(card());
    const region = await screen.findByRole("region", { name: "Workflow" });
    expect(await within(region).findByText("Inspection submitted — awaiting approval")).toBeInTheDocument();
    expect(within(region).getByText(/waiting for an authorised reviewer/)).toBeInTheDocument();
    expect(within(region).getByText("1 Sept 2026").closest("time")).toHaveAttribute("datetime", "2026-09-01");
    expect(within(region).getByText("CERT-7")).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Review inspection" })).toBeInTheDocument();
    expect(client.getAssetWorkflow).toHaveBeenCalledWith("asset-1");
  });

  it("hands the action it was given to the owner when the button is pressed", async () => {
    client.getAssetWorkflow.mockResolvedValue(workflow());
    const onAction = vi.fn();
    render(card({ onAction }));
    await userEvent.setup().click(await screen.findByRole("button", { name: "Review inspection" }));
    expect(onAction).toHaveBeenCalledWith(action());
  });

  it("offers no button when the API returns no next action, or this app has nowhere to open it", async () => {
    client.getAssetWorkflow.mockResolvedValue(workflow({ nextAction: null, label: "Certified" }));
    const first = render(card());
    await screen.findByText("Certified");
    expect(screen.queryByRole("button")).toBeNull();
    first.unmount();

    client.getAssetWorkflow.mockResolvedValue(workflow());
    render(card({ canOpen: () => false }));
    await screen.findByText("Inspection submitted — awaiting approval");
    expect(screen.queryByRole("button", { name: "Review inspection" })).toBeNull();
  });

  it("shows a skeleton while it loads", async () => {
    const pending = deferred<AssetWorkflow>();
    client.getAssetWorkflow.mockReturnValue(pending.promise);
    render(card());
    expect(await screen.findByRole("status", { name: "Loading workflow" })).toBeInTheDocument();
    await act(async () => pending.resolve(workflow({ label: "Loaded", nextAction: null })));
    expect(await screen.findByText("Loaded")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading workflow" })).toBeNull();
  });

  it("says it is unavailable, safely, and Retry asks again", async () => {
    client.getAssetWorkflow
      .mockRejectedValueOnce(new HmsApiError(500, "internal", "psycopg.errors.OperationalError: boom", null))
      .mockResolvedValueOnce(workflow());
    render(card());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Workflow status unavailable");
    expect(alert.textContent).not.toMatch(/psycopg/);
    await userEvent.setup().click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Inspection submitted — awaiting approval")).toBeInTheDocument();
    expect(client.getAssetWorkflow).toHaveBeenCalledTimes(2);
  });

  it("never lets a slow answer for asset A replace asset B", async () => {
    const a = deferred<AssetWorkflow>();
    const b = deferred<AssetWorkflow>();
    client.getAssetWorkflow.mockImplementation((id: string) => (id === "asset-a" ? a.promise : b.promise));
    const view = render(card({ assetId: "asset-a" }));
    await waitFor(() => expect(client.getAssetWorkflow).toHaveBeenCalledWith("asset-a"));
    view.rerender(card({ assetId: "asset-b" }));
    await waitFor(() => expect(client.getAssetWorkflow).toHaveBeenCalledWith("asset-b"));

    await act(async () => b.resolve(workflow({ label: "Asset B is certified", nextAction: null })));
    expect(await screen.findByText("Asset B is certified")).toBeInTheDocument();
    await act(async () => a.resolve(workflow({ label: "Asset A is overdue" })));
    expect(screen.getByText("Asset B is certified")).toBeInTheDocument();
    expect(screen.queryByText("Asset A is overdue")).toBeNull();
  });

  it("does not show asset A's summary while asset B's is still loading, and ignores A failing late", async () => {
    const a = deferred<AssetWorkflow>();
    const b = deferred<AssetWorkflow>();
    client.getAssetWorkflow.mockImplementation((id: string) => (id === "asset-a" ? a.promise : b.promise));
    const view = render(card({ assetId: "asset-a" }));
    await waitFor(() => expect(client.getAssetWorkflow).toHaveBeenCalledWith("asset-a"));
    await act(async () => a.resolve(workflow({ label: "Asset A is overdue" })));
    await screen.findByText("Asset A is overdue");
    view.rerender(card({ assetId: "asset-b" }));
    expect(screen.queryByText("Asset A is overdue")).toBeNull(); // not even for a moment
    expect(screen.getByRole("status", { name: "Loading workflow" })).toBeInTheDocument();
    await act(async () => b.resolve(workflow({ label: "Asset B is certified", nextAction: null })));
    await screen.findByText("Asset B is certified");
  });

  it("a late failure for an asset the person has left does not put an error on the new one", async () => {
    const a = deferred<AssetWorkflow>();
    const b = deferred<AssetWorkflow>();
    client.getAssetWorkflow.mockImplementation((id: string) => (id === "asset-a" ? a.promise : b.promise));
    const view = render(card({ assetId: "asset-a" }));
    await waitFor(() => expect(client.getAssetWorkflow).toHaveBeenCalledWith("asset-a"));
    view.rerender(card({ assetId: "asset-b" }));
    await act(async () => b.resolve(workflow({ label: "Asset B is certified", nextAction: null })));
    await screen.findByText("Asset B is certified");
    await act(async () => a.reject(new Error("boom")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Asset B is certified")).toBeInTheDocument();
  });
});
