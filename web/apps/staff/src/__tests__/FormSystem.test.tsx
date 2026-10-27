import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AssetForm } from "../components/AssetForm";
import { UserAdminDialog } from "../components/UserAdminDialog";
import type { AssetRecord } from "../domain/types";
import { guardNavigation } from "../routing/navigationGuard";
import "../routing/useHmsRoute";

const customerA = { id: "c1", code: "AGT1", name: "Vopak" };
const product = { id: "p1", code: "HOSE", name: "Hose", category: "Hose" };
const noEnd = { fitting: "", size: "", nominalBore: null, material: null, coupling: null, couplingAddOn: null, attachMethod: null };
const options = { materials: [], couplings: [], couplingAddOns: [], attachMethods: [], nominalBores: [] };

function asset(id: string, name: string): AssetRecord {
  return {
    id, assetNumber: `A-${id}`, assetName: name, customerSerialNo: `SN-${id}`, purchaseOrderNumber: null, tag: null,
    lifecycleStatus: "ACTIVE", manufactureDate: null, installationDate: null, graveDate: null, nextRetestDueAt: null,
    condemnedAt: null, lengthM: null, notes: null, description: null, customer: customerA, product,
    location: { id: "l1", name: "Dock" } as AssetRecord["location"], retestSchedule: null, aEnd: noEnd, bEnd: noEnd,
    inspectionHistory: [], certificateHistory: [], etag: "e"
  };
}

function assetForm(overrides: Partial<React.ComponentProps<typeof AssetForm>> = {}) {
  return {
    asset: asset("1", "Hose One"),
    configurationOptions: options,
    customerOptions: [customerA],
    locationOptions: [{ customerId: "c1", locations: [{ id: "l1", name: "Dock" } as never] }],
    productOptions: [product],
    open: true,
    onClose: vi.fn(),
    onSubmit: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as React.ComponentProps<typeof AssetForm>;
}

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

const unsavedStatus = () => screen.queryByText("Unsaved changes");

describe("shared form behaviour on the Asset form", () => {
  it("is clean until the person changes something, and Cancel then leaves at once", async () => {
    const props = assetForm();
    const user = userEvent.setup();
    render(<AssetForm {...props} />);
    expect(unsavedStatus()).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("does not read late-arriving defaults as unsaved work", () => {
    const props = assetForm({ asset: null, customerOptions: [], productOptions: [], locationOptions: [] });
    const { rerender } = render(<AssetForm {...props} />);
    rerender(<AssetForm {...props} customerOptions={[customerA]} productOptions={[product]} locationOptions={[{ customerId: "c1", locations: [{ id: "l1", name: "Dock" } as never] }]} />);
    expect(screen.getByLabelText("Agent")).toHaveValue("c1");
    expect(unsavedStatus()).toBeNull();
  });

  it("asks before discarding a dirty form: Keep editing keeps the values, Discard closes", async () => {
    const props = assetForm();
    const user = userEvent.setup();
    render(<AssetForm {...props} />);
    await user.clear(screen.getByLabelText("Asset Name"));
    await user.type(screen.getByLabelText("Asset Name"), "Renamed");
    expect(unsavedStatus()).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog", { name: "Discard unsaved changes?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Asset Name")).toHaveValue("Renamed");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("does not let Escape silently discard dirty data", async () => {
    const props = assetForm();
    const user = userEvent.setup();
    render(<AssetForm {...props} />);
    await user.type(screen.getByLabelText("Serial Number"), "X");
    await user.keyboard("{Escape}");
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("is clean again when the edit is put back", async () => {
    const user = userEvent.setup();
    render(<AssetForm {...assetForm()} />);
    await user.type(screen.getByLabelText("Serial Number"), "X");
    expect(unsavedStatus()).not.toBeNull();
    await user.type(screen.getByLabelText("Serial Number"), "{Backspace}");
    expect(unsavedStatus()).toBeNull();
  });

  it("installs the browser unload prompt only while dirty", async () => {
    const user = userEvent.setup();
    render(<AssetForm {...assetForm()} />);
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    await user.type(screen.getByLabelText("Serial Number"), "X");
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });

  it("returns to clean after a successful save and removes the unload prompt", async () => {
    const props = assetForm();
    const user = userEvent.setup();
    render(<AssetForm {...props} />);
    await user.type(screen.getByLabelText("Serial Number"), "X");
    await user.click(screen.getByRole("button", { name: "Save asset" }));
    await waitFor(() => expect(unsavedStatus()).toBeNull());
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("keeps everything entered when the save fails, and the retry can succeed", async () => {
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error("Server unavailable")).mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<AssetForm {...assetForm({ onSubmit })} />);
    await user.type(screen.getByLabelText("Serial Number"), "-NEW");
    await user.click(screen.getByRole("button", { name: "Save asset" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByLabelText("Serial Number")).toHaveValue("SN-1-NEW");
    expect(unsavedStatus()).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Save asset" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(unsavedStatus()).toBeNull());
  });

  it("cannot be submitted twice while a save is in flight", async () => {
    let resolve: () => void = () => undefined;
    const onSubmit = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const user = userEvent.setup();
    render(<AssetForm {...assetForm({ onSubmit })} />);
    await user.type(screen.getByLabelText("Serial Number"), "X");
    const form = screen.getByRole("form", { name: "Edit Asset" });
    fireEvent.submit(form);
    fireEvent.submit(form);
    await user.click(screen.getByRole("button", { name: "Saving…" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
  });

  it("puts the error on the field, focuses the first invalid one, and lets the summary jump to it", async () => {
    const user = userEvent.setup();
    render(<AssetForm {...assetForm({ asset: null })} />);
    await user.click(screen.getByRole("button", { name: "Save asset" }));
    const name = screen.getByLabelText("Asset Name");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(name.getAttribute("aria-describedby") as string)).toHaveTextContent("Enter an asset name.");
    expect(name).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Serial Number" }));
    expect(screen.getByLabelText("Serial Number")).toHaveFocus();
  });

  it("keeps a typed value when the same record arrives again from a list refresh", async () => {
    const props = assetForm();
    const user = userEvent.setup();
    const { rerender } = render(<AssetForm {...props} />);
    await user.type(screen.getByLabelText("Serial Number"), "-TYPED");
    rerender(<AssetForm {...props} asset={{ ...asset("1", "Hose One"), lifecycleStatus: "ACTIVE", etag: "e2" }} customerOptions={[{ ...customerA }]} />);
    expect(screen.getByLabelText("Serial Number")).toHaveValue("SN-1-TYPED");
    expect(unsavedStatus()).not.toBeNull();
  });

  it("follows a refreshed record while nothing has been edited", () => {
    const props = assetForm();
    const { rerender } = render(<AssetForm {...props} />);
    rerender(<AssetForm {...props} asset={{ ...asset("1", "Hose One"), customerSerialNo: "SN-CHANGED" }} />);
    expect(screen.getByLabelText("Serial Number")).toHaveValue("SN-CHANGED");
  });

  it("ignores a slow save for record A once the form shows record B", async () => {
    let resolveA: () => void = () => undefined;
    const onSubmit = vi.fn(() => new Promise<void>((done) => { resolveA = done; }));
    const props = assetForm({ onSubmit });
    const user = userEvent.setup();
    const { rerender } = render(<AssetForm {...props} />);
    await user.type(screen.getByLabelText("Serial Number"), "X");
    await user.click(screen.getByRole("button", { name: "Save asset" }));
    let resolveB: () => void = () => undefined;
    const submitB = vi.fn(() => new Promise<void>((done) => { resolveB = done; }));
    rerender(<AssetForm {...props} asset={asset("2", "Hose Two")} onSubmit={submitB} />);
    await user.type(screen.getByLabelText("Serial Number"), "Y");
    await user.click(screen.getByRole("button", { name: "Save asset" }));
    await act(async () => resolveA());
    // A finishing says nothing about B: B is still saving and still holds its unsaved text.
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByLabelText("Serial Number")).toHaveValue("SN-2Y");
    expect(unsavedStatus()).not.toBeNull();
    await act(async () => resolveB());
    await waitFor(() => expect(unsavedStatus()).toBeNull());
  });

  it("does not show record A's save failure on record B", async () => {
    let rejectA: (reason: Error) => void = () => undefined;
    const onSubmit = vi.fn(() => new Promise<void>((_, reject) => { rejectA = reject; }));
    const props = assetForm({ onSubmit });
    const user = userEvent.setup();
    const { rerender } = render(<AssetForm {...props} />);
    await user.type(screen.getByLabelText("Serial Number"), "X");
    await user.click(screen.getByRole("button", { name: "Save asset" }));
    rerender(<AssetForm {...props} asset={asset("2", "Hose Two")} onSubmit={vi.fn()} />);
    await act(async () => rejectA(new Error("A failed")));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("holds in-app navigation while dirty and runs it only after Discard", async () => {
    const props = assetForm();
    const user = userEvent.setup();
    const { rerender } = render(<AssetForm {...props} />);
    const proceed = vi.fn();
    act(() => guardNavigation(proceed));
    expect(proceed).toHaveBeenCalledTimes(1); // clean: nothing to protect
    await user.type(screen.getByLabelText("Serial Number"), "X");
    proceed.mockClear();
    act(() => guardNavigation(proceed));
    expect(proceed).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    rerender(<AssetForm {...props} open={false} />);
  });

  it("puts the address back on Back/Forward while dirty, and replays the move on Discard", async () => {
    const user = userEvent.setup();
    window.history.pushState(null, "", "/?view=assets");
    window.dispatchEvent(new PopStateEvent("popstate")); // the address the person settled on
    render(<AssetForm {...assetForm()} />);
    await user.type(screen.getByLabelText("Serial Number"), "X");
    window.history.replaceState(null, "", "/?view=dashboard"); // the browser has gone Back
    act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(window.location.search).toBe("?view=assets");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Serial Number")).toHaveValue("SN-1X");
    act(() => { window.history.replaceState(null, "", "/?view=dashboard"); window.dispatchEvent(new PopStateEvent("popstate")); });
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(window.location.search).toBe("?view=dashboard");
  });

  it("keeps Tab inside the form", async () => {
    const user = userEvent.setup();
    render(<AssetForm {...assetForm()} />);
    const save = screen.getByRole("button", { name: "Save asset" });
    save.focus();
    await user.tab();
    expect(screen.getByRole("form", { name: "Edit Asset" }).contains(document.activeElement)).toBe(true);
    await user.tab({ shift: true });
    expect(screen.getByRole("form", { name: "Edit Asset" }).contains(document.activeElement)).toBe(true);
  });
});

describe("shared form behaviour on the User dialog", () => {
  const base = {
    open: true,
    mode: "edit" as const,
    actorRoles: ["SUPER_ADMIN" as const],
    customers: [{ id: "c1", name: "Vopak" }],
    onClose: vi.fn(),
    onSubmit: vi.fn().mockResolvedValue(undefined)
  };
  const initial = () => ({ email: "a@x.com", firstName: "Ada", lastName: "Lovelace", role: "HMS_ADMIN" as const, customerId: null, customerIds: [] });

  it("keeps what is being typed when the parent re-renders with a fresh `initial` object", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<UserAdminDialog {...base} initial={initial()} recordKey="u1" />);
    await user.type(screen.getByLabelText("First name"), "ZZ");
    rerender(<UserAdminDialog {...base} initial={initial()} recordKey="u1" />);
    expect(screen.getByLabelText("First name")).toHaveValue("AdaZZ");
    expect(unsavedStatus()).not.toBeNull();
  });

  it("asks before discarding, and closes at once when nothing changed", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<UserAdminDialog {...base} initial={initial()} onClose={onClose} recordKey="u1" />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    onClose.mockClear();
    await user.type(screen.getByLabelText("Last name"), "!");
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps values on a server failure, then returns to clean when the retry succeeds", async () => {
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error("nope")).mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<UserAdminDialog {...base} initial={initial()} onSubmit={onSubmit} recordKey="u1" />);
    await user.type(screen.getByLabelText("First name"), "Q");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByLabelText("First name")).toHaveValue("AdaQ");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(unsavedStatus()).toBeNull());
  });

  it("cannot be submitted twice, and ignores a slow save once it shows another user", async () => {
    let resolveFirst: () => void = () => undefined;
    const onSubmit = vi.fn(() => new Promise<void>((done) => { resolveFirst = done; }));
    const user = userEvent.setup();
    const { rerender } = render(<UserAdminDialog {...base} initial={initial()} onSubmit={onSubmit} recordKey="u1" />);
    await user.type(screen.getByLabelText("First name"), "Q");
    const form = screen.getByRole("form", { name: "Edit user" });
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    rerender(<UserAdminDialog {...base} initial={{ ...initial(), email: "b@x.com", firstName: "Bo" }} onSubmit={vi.fn()} recordKey="u2" />);
    await user.type(screen.getByLabelText("First name"), "W");
    await act(async () => resolveFirst());
    expect(screen.getByLabelText("First name")).toHaveValue("BoW");
    expect(unsavedStatus()).not.toBeNull();
  });

  it("does not show user A's save failure on user B, and keeps typing through a refreshed record", async () => {
    let rejectA: (reason: Error) => void = () => undefined;
    const onSubmit = vi.fn(() => new Promise<void>((_, reject) => { rejectA = reject; }));
    const user = userEvent.setup();
    const { rerender } = render(<UserAdminDialog {...base} initial={initial()} onSubmit={onSubmit} recordKey="u1" />);
    await user.type(screen.getByLabelText("First name"), "Q");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    rerender(<UserAdminDialog {...base} initial={{ ...initial(), email: "b@x.com", firstName: "Bo" }} onSubmit={vi.fn()} recordKey="u2" />);
    await act(async () => rejectA(new Error("A failed")));
    expect(screen.queryByRole("alert")).toBeNull();
    await user.type(screen.getByLabelText("First name"), "W");
    // The server's copy of the same user changed meanwhile (a refresh); the typed text stays.
    rerender(<UserAdminDialog {...base} initial={{ ...initial(), email: "b@x.com", firstName: "Bo", lastName: "Changed" }} onSubmit={vi.fn()} recordKey="u2" />);
    expect(screen.getByLabelText("First name")).toHaveValue("BoW");
    expect(unsavedStatus()).not.toBeNull();
  });

  it("links the summary to the invalid field and focuses it", async () => {
    const user = userEvent.setup();
    render(<UserAdminDialog {...base} mode="create" />);
    await user.click(screen.getByRole("button", { name: "Create user" }));
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Email")).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Last name" }));
    expect(screen.getByLabelText("Last name")).toHaveFocus();
  });
});
