import { screen, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

/**
 * Picks an option in a Select or Combobox, or in a native select where one is kept, the way a person
 * would: open it, pick it. `option` is the value the form stores, or the visible label.
 */
export async function choose(user: UserEvent, control: HTMLElement, option: string): Promise<void> {
  if (control.tagName === "SELECT") {
    await user.selectOptions(control, option);
    return;
  }
  await user.click(control);
  const list = await screen.findByRole("listbox");
  const byValue = Array.from(list.querySelectorAll<HTMLElement>("[data-value]")).find((el) => el.dataset.value === option);
  await user.click(byValue ?? within(list).getByRole("option", { name: option }));
}

/** The visible labels of every option a Select offers (opens it, reads it, closes it). */
export async function optionLabels(user: UserEvent, control: HTMLElement): Promise<string[]> {
  await user.click(control);
  const labels = within(await screen.findByRole("listbox")).getAllByRole("option").map((o) => o.textContent ?? "");
  await user.keyboard("{Escape}");
  return labels;
}

/** Opens a Select or Combobox and returns its list, so a test can look at what it offers. Close it with Escape. */
export async function openList(user: UserEvent, control: HTMLElement): Promise<HTMLElement> {
  await user.click(control);
  return screen.findByRole("listbox");
}
