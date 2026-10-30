import type { Locator } from "@playwright/test";

export type Pick = string | { label: string } | { first: true };

/**
 * Picks an option in a Select or Combobox the way a person does (open it, choose from the list), or in a
 * native select where one is kept. A string is the value the form stores; `{ label }` is visible text.
 */
export async function chooseOption(control: Locator, pick: Pick): Promise<void> {
  const native = await control.evaluate((element) => element.tagName === "SELECT");
  if (native) {
    if (typeof pick === "string") await control.selectOption(pick);
    else if ("label" in pick) await control.selectOption({ label: pick.label });
    else await control.selectOption({ index: 1 });
    return;
  }
  await control.click();
  const list = control.page().getByRole("listbox");
  if (typeof pick === "string") await list.locator(`[data-value="${pick}"]`).click();
  else if ("label" in pick) await list.getByRole("option").filter({ hasText: pick.label }).first().click();
  else await list.locator('[data-value]:not([data-value=""])').first().click();
}

/** The visible text of every option a Select or Combobox offers (opens it, reads it, closes it). */
export async function optionTexts(control: Locator): Promise<string[]> {
  await control.click();
  const texts = await control.page().getByRole("listbox").getByRole("option").allTextContents();
  await control.page().keyboard.press("Escape");
  return texts;
}
