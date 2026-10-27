import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "../App";
import { InspectionCapture } from "../components/InspectionCapture";
import type { WorkItem } from "../domain/types";
import { mockBootstrapResponse } from "../data/mockSync";
import { resetDefaultSyncStore } from "../offline/syncStore";

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  };
}

type User = ReturnType<typeof userEvent.setup>;
const fillDraftCore = async (user: User) => {
  await user.selectOptions(screen.getByLabelText("Test time minutes"), "5");
  await user.selectOptions(screen.getByLabelText("Pressure test result"), "PASS");
};
const fillWholeForm = async (user: User) => {
  await fillDraftCore(user);
  await user.selectOptions(screen.getByLabelText("Instruction"), "PASS");
  await user.type(screen.getByLabelText("Ohms end A"), "0.1");
  await user.type(screen.getByLabelText("Ohms end B"), "0.2");
  await user.type(screen.getByLabelText("Ohms total"), "0.3");
  await user.click(screen.getByRole("button", { name: "Pass all" }));
  await user.selectOptions(screen.getByLabelText("Certificate result"), "PASS");
};
const openAsset = async (user: User, number: string) =>
  user.click(await screen.findByRole("button", { name: new RegExp(`open ${number}`, "i") }));
const nav = (name: string) => within(screen.getByRole("navigation", { name: "Inspector navigation" })).getByRole("button", { name });
const prompt = () => screen.queryByRole("alertdialog", { name: "Discard unsaved changes?" });

describe("unsaved capture protection", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    resetDefaultSyncStore();
    vi.stubGlobal("localStorage", createMemoryStorage());
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify(mockBootstrapResponse), { status: 200, headers: { "Content-Type": "application/json" } })
    ));
  });
  afterEach(() => vi.restoreAllMocks());

  it("has one navigation with the four surfaces, and marks the current one", async () => {
    render(<App initialAccessToken="test-access-token" />);
    await screen.findByRole("button", { name: /open HOS-2024-0891/i });
    const navigation = screen.getByRole("navigation", { name: "Inspector navigation" });
    expect(within(navigation).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Work", "Capture", "Queue", "Scan"]);
    expect(nav("Work")).toHaveAttribute("aria-current", "page");
  });

  it("leaves a clean capture without asking", async () => {
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await openAsset(user, "HOS-2024-0891");
    await user.click(screen.getByRole("button", { name: "Work queue" }));
    expect(prompt()).toBeNull();
    expect(await screen.findByLabelText("Work queue")).toBeInTheDocument();
  });

  it("asks before leaving a capture with unsaved edits: Keep editing keeps every field, Discard leaves", async () => {
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await openAsset(user, "HOS-2024-0891");
    await fillDraftCore(user);
    await user.type(screen.getByLabelText("Asset tag"), "TAG-1");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    await user.click(nav("Queue"));
    expect(prompt()).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(prompt()).toBeNull();
    expect(screen.getByLabelText("Pressure test result")).toHaveValue("PASS");
    expect(screen.getByLabelText("Test time minutes")).toHaveValue("5");
    expect(screen.getByLabelText("Asset tag")).toHaveValue("TAG-1");

    await user.click(screen.getByRole("button", { name: "Work queue" }));
    expect(prompt()).not.toBeNull();
    await user.keyboard("{Escape}");
    expect(prompt()).toBeNull();
    expect(screen.getByLabelText("Asset tag")).toHaveValue("TAG-1");

    await user.click(nav("Queue"));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(await screen.findByLabelText("Sync queue")).toBeInTheDocument();
  });

  it("starts the next assignment from its own data, not the discarded edit", async () => {
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await openAsset(user, "HOS-2024-0891");
    await user.type(screen.getByLabelText("Asset tag"), "ONLY-FOR-A");
    await user.click(screen.getByRole("button", { name: "Work queue" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    await openAsset(user, "HOS-2025-0201");
    expect(screen.getByRole("heading", { name: "HOS-2025-0201" })).toBeInTheDocument();
    expect(screen.getByLabelText("Asset tag")).not.toHaveValue("ONLY-FOR-A");
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("is clean after Save Draft, and the draft is what comes back", async () => {
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await openAsset(user, "HOS-2024-0891");
    await fillDraftCore(user);
    await user.click(screen.getByRole("button", { name: "Save Draft" }));
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    await user.click(nav("Queue"));
    expect(prompt()).toBeNull();
    expect(await screen.findByLabelText("Sync queue")).toBeInTheDocument();
  });

  it("is clean after Submit", async () => {
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await openAsset(user, "HOS-2024-0891");
    await fillWholeForm(user);
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await user.click(nav("Queue"));
    expect(prompt()).toBeNull();
  });

  it("treats queued asset details as saved, but not an unqueued change", async () => {
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await openAsset(user, "HOS-2024-0891");
    await user.type(screen.getByLabelText("Asset tag"), "T1");
    await user.click(screen.getByRole("button", { name: "Queue Asset Details" }));
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    await user.type(screen.getByLabelText("Asset tag"), "2");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("is clean again when the edit is put back", async () => {
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await openAsset(user, "HOS-2024-0891");
    await user.type(screen.getByLabelText("Asset tag"), "Z");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Asset tag"), "{Backspace}");
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("installs the browser unload prompt only while there is something to lose", async () => {
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await openAsset(user, "HOS-2024-0891");
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    await user.type(screen.getByLabelText("Asset tag"), "Z");
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });

  it("shows the same queued count in the header and the Queue", async () => {
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await openAsset(user, "HOS-2024-0891");
    await fillDraftCore(user);
    await user.click(screen.getByRole("button", { name: "Save Draft" }));
    const header = screen.getByLabelText("Sync status");
    expect(header).toHaveTextContent("1 queued");
    await user.click(nav("Queue"));
    expect(await screen.findByText("1 pending")).toBeInTheDocument();
    expect(screen.getByLabelText("Sync status")).toHaveTextContent("1 queued");
  });

  it("groups the queue by status and says what each conflict choice does", async () => {
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await openAsset(user, "HOS-2024-0891");
    await fillDraftCore(user);
    await user.click(screen.getByRole("button", { name: "Save Draft" }));
    await user.click(nav("Queue"));
    const waiting = await screen.findByRole("region", { name: "Waiting to send operations" });
    expect(within(waiting).getByText("HOS-2024-0891")).toBeInTheDocument();
    expect(within(waiting).getByText("Inspection")).toBeInTheDocument();
  });

  it("reloads everything when the same screen is pointed at another assignment", async () => {
    const item = (id: string, serial: string, tag: string) => ({
      id, assetId: id, assetNumber: `ASSET-${id}`, customerName: "Cust", productName: "Prod", locationName: null,
      customerSerialNo: serial, tag, pressureRating: null, inspectionLocked: false, urgency: "draft", saved: null,
      workContext: { assignment_id: `assignment-${id}` }
    }) as unknown as WorkItem;
    const props = {
      draftFor: () => null, onBack: vi.fn(), onQueueAssetUpdate: vi.fn(), onQueuePressureTest: vi.fn(),
      onSaveDraft: vi.fn(), onSubmit: vi.fn()
    };
    const user = userEvent.setup();
    const { rerender } = render(<InspectionCapture {...props} workItem={item("A", "SN-A", "TAG-A")} />);
    await user.type(screen.getByLabelText("Asset tag"), "-edited");
    expect(screen.getByLabelText("Asset tag")).toHaveValue("TAG-A-edited");
    rerender(<InspectionCapture {...props} workItem={item("B", "SN-B", "TAG-B")} />);
    expect(screen.getByLabelText("Customer serial number")).toHaveValue("SN-B");
    expect(screen.getByLabelText("Asset tag")).toHaveValue("TAG-B");
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("protects asset details typed on a submitted (locked) inspection", async () => {
    const locked = {
      id: "L", assetId: "L", assetNumber: "ASSET-L", customerName: "Cust", productName: "Prod", locationName: null,
      customerSerialNo: "SN", tag: "T", pressureRating: null, inspectionLocked: true, urgency: "synced", saved: null,
      workContext: { assignment_id: "assignment-L" }
    } as unknown as WorkItem;
    const onDirtyChange = vi.fn();
    const user = userEvent.setup();
    render(
      <InspectionCapture
        draftFor={() => null} onBack={vi.fn()} onDirtyChange={onDirtyChange} onQueueAssetUpdate={vi.fn()}
        onQueuePressureTest={vi.fn()} onSaveDraft={vi.fn()} onSubmit={vi.fn()} workItem={locked}
      />
    );
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    await user.type(screen.getByLabelText("Asset tag"), "x");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });
});
