import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MyWorkWorkspace } from "../components/MyWorkWorkspace";
import type { MyWorkItem } from "../domain/types";

const client = vi.hoisted(() => ({ getMyWork: vi.fn() }));

vi.mock("../api/hmsClient", () => ({ createHmsClient: () => client }));

const feed = (items: MyWorkItem[] = []) => ({
  summary: { total: items.length, urgent: 0, dueSoon: 0, normal: items.length },
  items,
  limit: 50,
  sourceLimit: 500,
  sourceLimited: false
});

describe("MyWorkWorkspace", () => {
  beforeEach(() => client.getMyWork.mockReset());

  it("renders an authoritative action and routes only from its target metadata", async () => {
    const onOpen = vi.fn();
    client.getMyWork.mockResolvedValue(
      feed([
        {
          id: "REVIEW_INSPECTION:INSPECTION:inspection-1",
          kind: "INSPECTION",
          state: "AWAITING_REVIEW",
          priority: "DUE_SOON",
          title: "Awaiting review",
          summary: "The inspection was submitted and is waiting for an authorised reviewer.",
          customerId: "customer-1",
          customerName: "Mine Ltd",
          assetId: "asset-1",
          assetNumber: "A-100",
          inspectionId: "inspection-1",
          bookingId: null,
          certificateId: null,
          dueAt: null,
          updatedAt: "2026-10-01T00:00:00Z",
          nextAction: {
            code: "REVIEW_INSPECTION",
            label: "Review inspection",
            targetType: "INSPECTION",
            targetId: "inspection-1",
            inspectionId: null
          }
        }
      ])
    );

    render(<MyWorkWorkspace onOpen={onOpen} />);

    expect(await screen.findByRole("heading", { name: "My Work" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review inspection" }));
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ nextAction: expect.objectContaining({ targetId: "inspection-1" }) })
    );
  });

  it("keeps existing work visible when a refresh fails", async () => {
    client.getMyWork.mockResolvedValueOnce(
      feed([
        {
          id: "CONTINUE_INSPECTION:INSPECTION:inspection-1",
          kind: "INSPECTION",
          state: "IN_PROGRESS",
          priority: "NORMAL",
          title: "In progress",
          summary: "Continue the inspection.",
          customerId: "customer-1",
          customerName: "Mine Ltd",
          assetId: "asset-1",
          assetNumber: "A-100",
          inspectionId: "inspection-1",
          bookingId: null,
          certificateId: null,
          dueAt: null,
          updatedAt: "2026-10-01T00:00:00Z",
          nextAction: {
            code: "CONTINUE_INSPECTION",
            label: "Continue inspection",
            targetType: "INSPECTION",
            targetId: "inspection-1",
            inspectionId: null
          }
        }
      ])
    ).mockRejectedValueOnce(new Error("offline"));

    render(<MyWorkWorkspace onOpen={vi.fn()} pollMs={60_000} />);
    expect(await screen.findByText("In progress")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh My Work" }));
    await waitFor(() => expect(screen.getByText(/could not be refreshed/i)).toBeInTheDocument());
    expect(screen.getByText("Continue the inspection.")).toBeInTheDocument();
  });

  it("does not claim the user is caught up when the bounded source scan is partial", async () => {
    client.getMyWork.mockResolvedValue({
      ...feed(),
      sourceLimited: true
    });

    render(<MyWorkWorkspace onOpen={vi.fn()} />);

    expect(await screen.findByText(/additional assets were not scanned/i)).toBeInTheDocument();
    expect(screen.queryByText("You're caught up")).not.toBeInTheDocument();
  });
});
