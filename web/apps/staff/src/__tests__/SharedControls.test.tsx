import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActionButton } from "../components/interaction/ActionButton";
import { useActionNotice } from "../components/interaction/ActionNotice";
import { Combobox } from "../components/interaction/Combobox";
import { Field } from "../components/interaction/FormPrimitives";
import { Select } from "../components/interaction/Select";
import { ToastProvider, useOptionalToast } from "../components/interaction/Toast";

const ROLES = [
  { value: "REVIEWER", label: "Reviewer" },
  { value: "INSPECTOR", label: "Inspector" },
  { value: "ASSEMBLY", label: "Assembly", disabled: true },
  { value: "ADMIN", label: "HMS Admin" }
];

function RoleSelect({ onChange = () => undefined, ...rest }: Partial<React.ComponentProps<typeof Select>> & { onChange?: (value: string) => void }) {
  const [value, setValue] = useState("REVIEWER");
  return <Select aria-label="Role" onChange={(next) => { setValue(next); onChange(next); }} options={ROLES} value={value} {...rest} />;
}

describe("Select", () => {
  it("shows the chosen label, opens a labelled list, and marks the chosen option", async () => {
    const user = userEvent.setup();
    render(<RoleSelect />);
    const control = screen.getByRole("combobox", { name: "Role" });
    expect(control).toHaveTextContent("Reviewer");
    expect(control).toHaveAttribute("aria-expanded", "false");
    await user.click(control);
    expect(control).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByRole("listbox", { name: "Role" });
    expect(control).toHaveAttribute("aria-controls", list.id);
    expect(within(list).getByRole("option", { name: "Reviewer" })).toHaveAttribute("aria-selected", "true");
    expect(within(list).getByRole("option", { name: "Inspector" })).toHaveAttribute("aria-selected", "false");
    expect(control).toHaveFocus(); // focus stays on the control
  });

  it("is operated from the keyboard: arrows skip disabled options, Enter chooses, focus stays", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RoleSelect onChange={onChange} />);
    const control = screen.getByRole("combobox", { name: "Role" });
    control.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{ArrowDown}"); // Inspector
    expect(control.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: "Inspector" }).id);
    await user.keyboard("{ArrowDown}"); // Assembly is disabled: lands on HMS Admin
    expect(control.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: "HMS Admin" }).id);
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("ADMIN");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(control).toHaveFocus();
    expect(control).toHaveTextContent("HMS Admin");
  });

  it("jumps with Home and End, and by typing the start of a label", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RoleSelect onChange={onChange} />);
    const control = screen.getByRole("combobox", { name: "Role" });
    control.focus();
    await user.keyboard("{Enter}{End}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("ADMIN");
    await user.keyboard("{Enter}{Home}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("REVIEWER");
    await user.keyboard("ins"); // closed: typing selects the match
    expect(onChange).toHaveBeenLastCalledWith("INSPECTOR");
  });

  it("closes on Escape without letting the form behind it read that as leaving", async () => {
    const user = userEvent.setup();
    const formEscape = vi.fn();
    render(<div onKeyDown={(event) => { if (event.key === "Escape") formEscape(); }}><RoleSelect /></div>);
    const control = screen.getByRole("combobox", { name: "Role" });
    await user.click(control);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(formEscape).not.toHaveBeenCalled();
    await user.keyboard("{Escape}"); // closed now: the form hears it
    expect(formEscape).toHaveBeenCalledTimes(1);
  });

  it("chooses with the pointer, closes on an outside click, and reports only real changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<div><RoleSelect onChange={onChange} /><button type="button">elsewhere</button></div>);
    const control = screen.getByRole("combobox", { name: "Role" });
    await user.click(control);
    await user.click(screen.getByRole("option", { name: "Reviewer" })); // already chosen
    expect(onChange).not.toHaveBeenCalled();
    await user.click(control);
    await user.click(screen.getByRole("option", { name: "Assembly" })); // disabled
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.click(control);
    await user.click(screen.getByRole("option", { name: "Inspector" }));
    expect(onChange).toHaveBeenCalledWith("INSPECTOR");
  });

  it("does not open when disabled, and Tab closes it without choosing", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<RoleSelect disabled />);
    await user.click(screen.getByRole("combobox", { name: "Role" }));
    expect(screen.queryByRole("listbox")).toBeNull();
    rerender(<RoleSelect />);
    const onChange = vi.fn();
    rerender(<RoleSelect onChange={onChange} />);
    await user.click(screen.getByRole("combobox", { name: "Role" }));
    await user.keyboard("{ArrowDown}{Tab}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("can offer 'no choice' so a choice can be taken back, and shows it as the placeholder", async () => {
    const user = userEvent.setup();
    function Empty() {
      const [value, setValue] = useState("INSPECTOR");
      return <Select aria-label="Location" emptyLabel="Choose the location" onChange={setValue} options={ROLES} value={value} />;
    }
    render(<Empty />);
    const control = screen.getByRole("combobox", { name: "Location" });
    expect(control).toHaveTextContent("Inspector");
    await user.click(control);
    await user.click(screen.getByRole("option", { name: "Choose the location" }));
    expect(control).toHaveTextContent("Choose the location");
    expect(control.querySelector(".is-placeholder")).not.toBeNull();
  });

  it("carries the field's id, required, invalid and description, so it is a labelled control like any other", () => {
    render(
      <Field error="Choose a role." hint="What they can do." label="Role" name="role" required>
        {(props) => <Select {...props} aria-label="Role" onChange={() => undefined} options={ROLES} value="" />}
      </Field>
    );
    const control = screen.getByRole("combobox", { name: "Role" });
    expect(control).toHaveAttribute("aria-invalid", "true");
    expect(control).toHaveAttribute("aria-required", "true");
    expect(control).toHaveAccessibleDescription("Choose a role. What they can do.");
    expect(control).toHaveAttribute("data-field", "role");
  });
});

const CUSTOMERS = [
  { value: "c1", label: "Xero Pty Ltd", description: "XERO" },
  { value: "c2", label: "Orica Mining Services", description: "ORIC", searchText: "kooragang" },
  { value: "c3", label: "Vopak", description: "VOPA" }
];

function CustomerPick({ onChange = () => undefined, ...rest }: Partial<React.ComponentProps<typeof Combobox>> & { onChange?: (value: string) => void }) {
  const [value, setValue] = useState("");
  return <Combobox aria-label="Customer" onChange={(next) => { setValue(next); onChange(next); }} options={CUSTOMERS} value={value} {...rest} />;
}

describe("Combobox", () => {
  it("narrows the list as you type, over the label, the code and the extra search text", async () => {
    const user = userEvent.setup();
    render(<CustomerPick />);
    const input = screen.getByRole("combobox", { name: "Customer" });
    await user.click(input);
    expect(screen.getAllByRole("option")).toHaveLength(3);
    await user.type(input, "ori");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Orica Mining ServicesORIC"]);
    await user.clear(input);
    await user.type(input, "vopa");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await user.clear(input);
    await user.type(input, "kooragang");
    expect(screen.getByRole("option", { name: /Orica/ })).toBeInTheDocument();
  });

  it("says so when nothing matches, and chooses nothing on Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CustomerPick emptyText="No customers match" onChange={onChange} />);
    const input = screen.getByRole("combobox", { name: "Customer" });
    await user.type(input, "zzz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByRole("status")).toHaveTextContent("No customers match");
    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("moves with the arrows and chooses with Enter, without submitting the form behind it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(<form onSubmit={submit}><CustomerPick onChange={onChange} /></form>);
    const input = screen.getByRole("combobox", { name: "Customer" });
    input.focus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(input.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: /Orica/ }).id);
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("c2");
    expect(submit).not.toHaveBeenCalled();
    expect(input).toHaveValue("Orica Mining Services");
    expect(input).toHaveFocus();
  });

  it("Escape closes and puts the chosen label back; only then does the next Escape reach the form", async () => {
    const user = userEvent.setup();
    const formEscape = vi.fn();
    render(<div onKeyDown={(event) => { if (event.key === "Escape") formEscape(); }}><CustomerPick /></div>);
    const input = screen.getByRole("combobox", { name: "Customer" });
    await user.click(input);
    await user.click(screen.getByRole("option", { name: /Vopak/ }));
    await user.click(input);
    await user.clear(input);
    await user.type(input, "xe");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input).toHaveValue("Vopak");
    expect(formEscape).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(formEscape).toHaveBeenCalledTimes(1);
  });

  it("puts the chosen label back when focus leaves with half-typed text", async () => {
    const user = userEvent.setup();
    render(<div><CustomerPick /><button type="button">next</button></div>);
    const input = screen.getByRole("combobox", { name: "Customer" });
    await user.click(input);
    await user.click(screen.getByRole("option", { name: /Xero/ }));
    await user.clear(input);
    await user.type(input, "ori");
    await user.click(screen.getByRole("button", { name: "next" }));
    expect(input).toHaveValue("Xero Pty Ltd");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("puts the chosen label back and closes when focus is taken away by anything, not only a click", async () => {
    const user = userEvent.setup();
    render(<CustomerPick />);
    const input = screen.getByRole("combobox", { name: "Customer" });
    await user.click(input);
    await user.click(screen.getByRole("option", { name: /Vopak/ }));
    await user.click(input);
    await user.clear(input);
    await user.type(input, "ori");
    act(() => input.blur());
    expect(input).toHaveValue("Vopak");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("exposes the editable-combobox ARIA contract and the disabled state", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<CustomerPick required aria-invalid="true" />);
    const input = screen.getByRole("combobox", { name: "Customer" });
    expect(input).toHaveAttribute("aria-autocomplete", "list");
    expect(input).toHaveAttribute("aria-haspopup", "listbox");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).toHaveAttribute("aria-required", "true");
    expect(input).toHaveAttribute("aria-invalid", "true");
    await user.click(input);
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input.getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
    rerender(<CustomerPick disabled />);
    expect(screen.getByRole("combobox", { name: "Customer" })).toBeDisabled();
  });

  it("shows a loading line while options are still arriving", async () => {
    const user = userEvent.setup();
    render(<CustomerPick loading options={[]} />);
    await user.click(screen.getByRole("combobox", { name: "Customer" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
  });
});

function Saver({ onDone }: { onDone?: () => void }) {
  const toast = useOptionalToast();
  return <button onClick={() => { toast?.success({ message: "Asset created successfully." }); onDone?.(); }} type="button">save</button>;
}

describe("Toast", () => {
  afterEach(() => vi.useRealTimers());

  it("confirms a success where it can be seen and announced, and says what happened", async () => {
    const user = userEvent.setup();
    render(<ToastProvider><Saver /></ToastProvider>);
    await user.click(screen.getByRole("button", { name: "save" }));
    const toast = screen.getByRole("status");
    expect(toast).toHaveTextContent("Asset created successfully.");
    expect(toast).toHaveTextContent("Success."); // not by colour or icon alone
  });

  it("goes away by itself after about four seconds, and by its close button", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    render(<ToastProvider><Saver /></ToastProvider>);
    await user.click(screen.getByRole("button", { name: "save" }));
    await act(async () => { vi.advanceTimersByTime(3500); });
    expect(screen.getByRole("status")).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(screen.queryByRole("status")).toBeNull();

    await user.click(screen.getByRole("button", { name: "save" }));
    await user.click(screen.getByRole("button", { name: "Dismiss confirmation" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("stays while the pointer or keyboard focus is on it, and then finishes its time", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ToastProvider><Saver /></ToastProvider>);
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    const toast = screen.getByRole("status");
    await act(async () => { vi.advanceTimersByTime(2000); });
    fireEvent.mouseEnter(toast);
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByRole("status")).toBeInTheDocument();
    fireEvent.mouseLeave(toast);
    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(screen.getByRole("status")).toBeInTheDocument(); // about 2s of its 4s were left
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "save" }));
    fireEvent.focus(screen.getByRole("button", { name: "Dismiss confirmation" }));
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("keeps the newest few and does not pile up", async () => {
    const user = userEvent.setup();
    function Many() {
      const toast = useOptionalToast();
      return <button onClick={() => ["one", "two", "three", "four"].forEach((message) => toast?.success({ message }))} type="button">many</button>;
    }
    render(<ToastProvider><Many /></ToastProvider>);
    await user.click(screen.getByRole("button", { name: "many" }));
    expect(screen.getAllByRole("status").map((el) => el.textContent)).toEqual([
      expect.stringContaining("two"), expect.stringContaining("three"), expect.stringContaining("four")
    ]);
  });

  it("outlives the screen that raised it: the form can close and a record can open", async () => {
    const user = userEvent.setup();
    function Screen() {
      const [open, setOpen] = useState(true);
      const toast = useOptionalToast();
      return open ? <button onClick={() => { toast?.success({ message: "Saved." }); setOpen(false); }} type="button">save and close</button> : <p>The record is open.</p>;
    }
    render(<ToastProvider><Screen /></ToastProvider>);
    await user.click(screen.getByRole("button", { name: "save and close" }));
    expect(screen.getByText("The record is open.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Saved.");
  });

  it("is where a workspace's success notice goes when the shell provides it, and errors stay beside the work", async () => {
    const user = userEvent.setup();
    function Workspace() {
      const { notice, notify } = useActionNotice();
      return (
        <div>
          <button onClick={() => notify({ kind: "success", message: "Customer updated successfully.", title: "Customer saved" })} type="button">ok</button>
          <button onClick={() => notify({ kind: "error", message: "Not saved.", title: "Customer not saved" })} type="button">fail</button>
          {notice ? <p data-testid="inline">{notice.message}</p> : null}
        </div>
      );
    }
    render(<ToastProvider><Workspace /></ToastProvider>);
    await user.click(screen.getByRole("button", { name: "ok" }));
    expect(screen.getByRole("status")).toHaveTextContent("Customer updated successfully.");
    expect(screen.queryByTestId("inline")).toBeNull();
    await user.click(screen.getByRole("button", { name: "fail" }));
    expect(screen.getByTestId("inline")).toHaveTextContent("Not saved.");
    expect(screen.getAllByRole("status")).toHaveLength(1); // the error did not become a disappearing toast
  });

  it("falls back to the inline notice where no shell provides toasts", async () => {
    const user = userEvent.setup();
    function Workspace() {
      const { notice, notify } = useActionNotice();
      return <div><button onClick={() => notify({ kind: "success", message: "Done." })} type="button">ok</button>{notice ? <p data-testid="inline">{notice.message}</p> : null}</div>;
    }
    render(<Workspace />);
    await user.click(screen.getByRole("button", { name: "ok" }));
    expect(screen.getByTestId("inline")).toHaveTextContent("Done.");
  });

  it("is not animated for people who ask for less motion", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles/controls.css"), "utf8");
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    for (const selector of [".toast", ".choice-menu", ".choice-control", ".action-button"]) expect(reduced).toContain(selector);
  });
});

describe("ActionButton", () => {
  it.each(["primary", "secondary", "ghost", "danger", "icon"] as const)("the %s variant carries its class", (variant) => {
    render(<ActionButton aria-label="x" variant={variant}>label</ActionButton>);
    expect(screen.getByRole("button")).toHaveClass("action-button", `action-button--${variant}`);
  });

  it("says what it is doing while pending, is busy and cannot be pressed again", () => {
    const onClick = vi.fn();
    render(<ActionButton onClick={onClick} pending pendingLabel="Saving…" variant="primary">Save</ActionButton>);
    const button = screen.getByRole("button", { name: "Saving…" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("is a plain button by default, so it never submits a form by accident", () => {
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(<form onSubmit={submit}><ActionButton>Cancel</ActionButton></form>);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(submit).not.toHaveBeenCalled();
  });

  it("is disabled when told to be", async () => {
    render(<ActionButton disabled>Go</ActionButton>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Go" })).toBeDisabled());
  });
});
