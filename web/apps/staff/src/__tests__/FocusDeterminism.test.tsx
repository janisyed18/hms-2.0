import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { useFocusAfterRender } from "../components/forms/useFocusAfterRender";

/** A form that fails to save: the notice exists only after the failure has rendered. */
function Form({ onSave }: { onSave: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const [unrelated, setUnrelated] = useState(0);
  const focusAfterRender = useFocusAfterRender();
  const root = useRef<HTMLFormElement>(null);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        try {
          await onSave();
          setError(null);
        } catch {
          setError("It could not be saved.");
          focusAfterRender(() => root.current?.querySelector<HTMLElement>(".notice")?.focus());
        }
      }}
      ref={root}
    >
      {error ? <div className="notice" role="alert" tabIndex={-1}>{error}</div> : null}
      <button type="submit">Save</button>
      <button onClick={() => setUnrelated((n) => n + 1)} type="button">Rerender {unrelated}</button>
      <button onClick={() => setError(null)} type="button">Clear</button>
    </form>
  );
}

describe("focus follows the render that shows an error, without a timer", () => {
  it("has focus on the notice the moment the notice can be seen", async () => {
    const user = userEvent.setup();
    render(<Form onSave={() => Promise.reject(new Error("no"))} />);
    await user.click(screen.getByRole("button", { name: "Save" }));
    // No waitFor: whoever can find the notice already finds focus on it.
    expect(screen.getByRole("alert")).toHaveFocus();
  });

  it("needs no timer to get there: with every timer frozen, focus is already in place", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    try {
      render(<Form onSave={() => Promise.reject(new Error("no"))} />);
      await act(async () => (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).form?.requestSubmit());
      expect(screen.getByRole("alert")).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not take focus back on unrelated renders, or when the error clears", async () => {
    const user = userEvent.setup();
    render(<Form onSave={() => Promise.reject(new Error("no"))} />);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveFocus();

    const rerender = screen.getByRole("button", { name: /Rerender/ });
    await user.click(rerender);
    await user.click(screen.getByRole("button", { name: /Rerender/ }));
    expect(screen.getByRole("button", { name: /Rerender 2/ })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Clear" })).toHaveFocus();
  });

  it("moves focus again for a second failure, because the person tried again", async () => {
    const user = userEvent.setup();
    render(<Form onSave={() => Promise.reject(new Error("no"))} />);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Clear" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());
  });

  it("is already in place for a failure that resolves outside any event handler", async () => {
    let fail: () => void = () => undefined;
    render(<Form onSave={() => new Promise<void>((_, reject) => { fail = () => reject(new Error("late")); })} />);
    act(() => (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).form?.requestSubmit());
    await act(async () => fail());
    expect(screen.getByRole("alert")).toHaveFocus();
  });
});
