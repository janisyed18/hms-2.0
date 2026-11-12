import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AssetDetail } from "../components/AssetDetail";
import type { AssetRecord } from "../domain/types";

vi.mock("../components/AssetWorkflowCard", () => ({ AssetWorkflowCard: () => null }));

const asset = {
  id: "asset-1",
  assetNumber: "HMS-1",
  assetName: "Transfer hose",
  customer: { id: "c1", code: "C1", name: "Vopak" },
  location: { id: "l1", name: "Port Botany" },
  product: { id: "p1", code: "P1", name: "Fuelflex" },
  aEnd: {}, bEnd: {}, inspectionHistory: [], certificateHistory: []
} as unknown as AssetRecord;

function renderDetail(onBookInspection?: (asset: AssetRecord) => void) {
  render(
    <AssetDetail
      asset={asset}
      canOpenWorkflowAction={() => false}
      canWrite
      onBack={vi.fn()}
      onBookInspection={onBookInspection}
      onCopy={vi.fn()}
      onEdit={vi.fn()}
      onWorkflowAction={vi.fn()}
    />
  );
}

describe("Book Inspection on the asset detail page", () => {
  it("hands this asset to the booking flow", async () => {
    const onBookInspection = vi.fn();
    renderDetail(onBookInspection);
    await userEvent.setup().click(screen.getByRole("button", { name: "Book Inspection" }));
    expect(onBookInspection).toHaveBeenCalledWith(asset);
  });

  it("is not offered to someone who cannot book inspections", () => {
    renderDetail(undefined);
    expect(screen.queryByRole("button", { name: "Book Inspection" })).toBeNull();
  });
});
