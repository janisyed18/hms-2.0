import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ActionButton } from "../../components/interaction/ActionButton";
import { ActionNotice } from "../../components/interaction/ActionNotice";
import { ConfirmDialog } from "../../components/interaction/ConfirmDialog";
import { Field, RequiredNote } from "../../components/interaction/FormPrimitives";

describe("ActionNotice", () => {
  it("announces errors as alerts and everything else as status, and says what kind it is in words", () => {
    const { rerender } = render(<ActionNotice kind="error">Could not save.</ActionNotice>);
    expect(screen.getByRole("alert")).toHaveTextContent("Error. Could not save.");
    rerender(<ActionNotice kind="success" title="Asset saved">Done.</ActionNotice>);
    expect(screen.getByRole("status")).toHaveTextContent("Asset saved. Done.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("can be dismissed and can take focus", async () => {
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(<ActionNotice focus kind="error" onDismiss={onDismiss}>Nope.</ActionNotice>);
    expect(screen.getByRole("alert")).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Dismiss message" }));
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe("ActionButton", () => {
  it("shows what it is doing while pending, and cannot be pressed again", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<ActionButton onClick={onClick} pending pendingLabel="Saving…" variant="primary">Save asset</ActionButton>);
    const button = screen.getByRole("button", { name: "Saving…" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("carries its variant for styling", () => {
    render(<><ActionButton variant="danger">Archive</ActionButton><ActionButton variant="ghost">Cancel</ActionButton></>);
    expect(screen.getByRole("button", { name: "Archive" })).toHaveClass("action-button--danger");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass("action-button--ghost");
  });
});

describe("Field", () => {
  it("gives a required control native and ARIA required semantics and a hidden asterisk", () => {
    render(<><RequiredNote /><Field label="Asset Name" name="assetName" required>{(props) => <input {...props} />}</Field></>);
    const input = screen.getByLabelText(/Asset Name/);
    expect(input).toBeRequired();
    expect(input).toHaveAttribute("aria-required", "true");
    expect(input).toHaveAttribute("data-field", "assetName");
    const mark = screen.getByText("Asset Name").querySelector(".required-mark");
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Required fields", { exact: false })).toHaveTextContent("* Required fields");
  });

  it("links an error to its control", () => {
    render(<Field error="Enter an asset name." label="Asset Name" name="assetName" required>{(props) => <input {...props} />}</Field>);
    const input = screen.getByLabelText(/Asset Name/);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Enter an asset name.");
  });

  it("does not mark an optional field", () => {
    render(<Field label="Notes" name="notes">{(props) => <input {...props} />}</Field>);
    const input = screen.getByLabelText("Notes");
    expect(input).not.toBeRequired();
    expect(input).not.toHaveAttribute("aria-invalid");
  });
});

function Harness({ error = null, pending = false, onConfirm = vi.fn() }: { error?: string | null; pending?: boolean; onConfirm?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">Open</button>
      <ConfirmDialog
        confirmLabel="Archive asset" error={error} message="It leaves the register." onCancel={() => setOpen(false)}
        onConfirm={onConfirm} open={open} pending={pending} pendingLabel="Archiving…" title="Archive Main Pump Hose — HMS-001842?"
      />
    </>
  );
}

describe("ConfirmDialog", () => {
  it("is a labelled modal that starts on the safe choice, cancels with Escape and returns focus", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    const dialog = screen.getByRole("alertdialog", { name: "Archive Main Pump Hose — HMS-001842?" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("It leaves the register.");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Open" })).toHaveFocus();
  });

  it("keeps Tab inside the dialog", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    const dialog = screen.getByRole("alertdialog");
    await user.tab();
    expect(within(dialog).getByRole("button", { name: "Archive asset" })).toHaveFocus();
    await user.tab();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(within(dialog).getByRole("button", { name: "Archive asset" })).toHaveFocus();
  });

  it("shows a failure inside the dialog and a pending state that blocks a second press", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Harness error="Could not archive." onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Could not archive.");
    rerender(<Harness onConfirm={onConfirm} pending />);
    const busy = screen.getByRole("button", { name: "Archiving…" });
    expect(busy).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument(); // cannot be dismissed mid-request
  });
});
