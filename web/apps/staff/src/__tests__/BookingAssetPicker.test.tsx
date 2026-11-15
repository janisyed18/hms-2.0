import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BookingAssetPicker } from "../components/BookingAssetPicker";
import type { AssetRecord } from "../domain/types";

const client = {
  listAssets: vi.fn(),
  listAllAssets: vi.fn()
};

vi.mock("../api/hmsClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/hmsClient")>()),
  createHmsClient: () => client
}));

const asset = (n: number): AssetRecord =>
  ({ id: `a${n}`, assetNumber: `HMS-${n}`, assetName: `Asset ${n}`, tag: null, lifecycleStatus: "IN_SERVICE" }) as unknown as AssetRecord;

const page = (items: AssetRecord[], total = items.length) => ({ total, etag: null, items });

function setup(props: Partial<Parameters<typeof BookingAssetPicker>[0]> = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(
    <BookingAssetPicker
      customerId="cust-1"
      customerName="Vopak"
      locationId="loc-1"
      locationName="Port Botany"
      onClose={onClose}
      onConfirm={onConfirm}
      open
      selected={[]}
      {...props}
    />
  );
  return { onConfirm, onClose, user: userEvent.setup() };
}

beforeEach(() => {
  client.listAssets.mockReset();
  client.listAllAssets.mockReset();
  client.listAssets.mockResolvedValue(page([asset(1), asset(2), asset(96)]));
  client.listAllAssets.mockResolvedValue(page([asset(1), asset(2), asset(96)]));
});

describe("BookingAssetPicker", () => {
  it("asks the server only for this customer's assets at this location", async () => {
    setup();
    await screen.findByText("Asset 1 — HMS-1");
    expect(client.listAssets).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cust-1", locationId: "loc-1", newWorkOnly: true })
    );
    // Every call, not just the first: a search must not widen the scope.
    for (const call of client.listAssets.mock.calls) {
      expect(call[0]).toMatchObject({ customerId: "cust-1", locationId: "loc-1" });
    }
  });

  it("says whose assets these are, so the scope is not left to be assumed", async () => {
    setup();
    expect(await screen.findByText(/Only assets at Port Botany for Vopak can be chosen/)).toBeVisible();
  });

  it("searches on the server within that scope as you type", async () => {
    const { user } = setup();
    await screen.findByText("Asset 1 — HMS-1");
    client.listAssets.mockResolvedValue(page([asset(96)]));
    await user.type(screen.getByRole("searchbox", { name: "Search assets" }), "96");
    await waitFor(() =>
      expect(client.listAssets).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: "96", customerId: "cust-1", locationId: "loc-1" })
      )
    );
    expect(await screen.findByText("Asset 96 — HMS-96")).toBeVisible();
  });

  it("selects and deselects one asset at a time, and hands back what was chosen", async () => {
    const { user, onConfirm } = setup();
    await screen.findByText("Asset 1 — HMS-1");
    await user.click(screen.getByRole("checkbox", { name: "Asset 1 — HMS-1" }));
    await user.click(screen.getByRole("checkbox", { name: "Asset 96 — HMS-96" }));
    await user.click(screen.getByRole("checkbox", { name: "Asset 1 — HMS-1" }));
    await user.click(screen.getByRole("button", { name: /^Use 1 asset$/ }));
    expect(onConfirm).toHaveBeenCalledWith([expect.objectContaining({ id: "a96" })]);
  });

  it("selects every match from the server, not only the rows on screen", async () => {
    const { user, onConfirm } = setup();
    // Ten match the search; only the first page is listed.
    const matches = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(asset);
    client.listAssets.mockResolvedValue(page(matches.slice(0, 3), 10));
    client.listAllAssets.mockResolvedValue(page(matches, 10));
    await user.type(screen.getByRole("searchbox", { name: "Search assets" }), "Asset");
    await screen.findByRole("button", { name: "Select all 10 matching" });
    await user.click(screen.getByRole("button", { name: "Select all 10 matching" }));
    await waitFor(() => expect(screen.getByText(/10 selected/)).toBeVisible());
    expect(client.listAllAssets).toHaveBeenCalledWith(
      expect.objectContaining({ search: "Asset", customerId: "cust-1", locationId: "loc-1" })
    );
    await user.click(screen.getByRole("button", { name: /^Use 10 assets$/ }));
    expect(onConfirm.mock.calls[0][0]).toHaveLength(10);
  });

  it("clears every selection, including ones made before the current search", async () => {
    const { user } = setup({ selected: [asset(1)] });
    await screen.findByText("Asset 1 — HMS-1");
    expect(screen.getByText(/1 selected/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear all" })).toBeDisabled();
  });

  it("keeps a selection made before a search that hides it", async () => {
    client.listAssets.mockResolvedValue(page([asset(1), asset(2)]));
    const { user, onConfirm } = setup();
    await screen.findByText("Asset 1 — HMS-1");
    await user.click(screen.getByRole("checkbox", { name: "Asset 1 — HMS-1" }));
    client.listAssets.mockResolvedValue(page([asset(96)]));
    await user.type(screen.getByRole("searchbox", { name: "Search assets" }), "96");
    await screen.findByText("Asset 96 — HMS-96");
    // The search replaced the list, so the chosen asset is no longer on screen.
    await waitFor(() => expect(screen.queryByText("Asset 1 — HMS-1")).not.toBeInTheDocument());
    expect(screen.getByText(/1 selected/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: /^Use 1 asset$/ }));
    expect(onConfirm).toHaveBeenCalledWith([expect.objectContaining({ id: "a1" })]);
  });

  it("says when a search matches nothing at this location, naming the place", async () => {
    const { user } = setup();
    await screen.findByText("Asset 1 — HMS-1");
    client.listAssets.mockResolvedValue(page([]));
    await user.type(screen.getByRole("searchbox", { name: "Search assets" }), "zzz");
    expect(await screen.findByText(/No assets at Port Botany match/)).toBeVisible();
  });

  it("reports a failed read instead of showing an empty list as if there were none", async () => {
    client.listAssets.mockRejectedValue(new Error("boom"));
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("Assets could not be loaded.");
  });

  it("loads further pages on request, within the same scope", async () => {
    const { user } = setup();
    client.listAssets.mockResolvedValue(page([asset(1), asset(2)], 5));
    await screen.findByRole("button", { name: "Show more assets" });
    client.listAssets.mockResolvedValue(page([asset(3), asset(4)], 5));
    await user.click(screen.getByRole("button", { name: "Show more assets" }));
    await waitFor(() =>
      expect(client.listAssets).toHaveBeenLastCalledWith(
        expect.objectContaining({ offset: 2, customerId: "cust-1", locationId: "loc-1" })
      )
    );
    expect(await screen.findByText("Asset 3 — HMS-3")).toBeVisible();
  });

  it("closes without changing anything when cancelled", async () => {
    const { user, onClose, onConfirm } = setup();
    await screen.findByText("Asset 1 — HMS-1");
    await user.click(screen.getByRole("checkbox", { name: "Asset 1 — HMS-1" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
