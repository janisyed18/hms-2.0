import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssetForm } from "../components/AssetForm";
import { lookups, resetLookups } from "../test/lookupClient";

vi.mock("../api/hmsClient", async (original) => {
  const { lookupClient } = await import("../test/lookupClient");
  return { ...(await original<typeof import("../api/hmsClient")>()), createHmsClient: () => lookupClient };
});

const options = { materials: [], couplings: [], couplingAddOns: [], attachMethods: [], nominalBores: [] };

beforeEach(() => { resetLookups(); lookups.customers = []; lookups.products = []; lookups.locations = {}; });
afterEach(() => { vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });

const renderNew = () => render(<AssetForm asset={null} configurationOptions={options} open onClose={vi.fn()} onSubmit={vi.fn().mockResolvedValue(undefined)} />);

describe("Asset form layout", () => {
  it("offers a compact Automatic / Manual choice and only shows the number input for Manual", async () => {
    const user = userEvent.setup();
    renderNew();
    const group = await screen.findByRole("group", { name: "Asset Number" });
    expect(within(group).getByRole("radio", { name: "Automatic" })).toBeChecked();
    expect(within(group).getByText("Generated when saved")).toBeVisible();
    expect(within(group).queryByRole("textbox", { name: "Asset Number" })).not.toBeInTheDocument();

    await user.click(within(group).getByRole("radio", { name: "Manual" }));
    expect(within(group).getByRole("textbox", { name: "Asset Number" })).toBeVisible();
    expect(within(group).queryByText("Generated when saved")).not.toBeInTheDocument();
    // The name stays independently editable.
    await user.type(screen.getByRole("textbox", { name: "Asset Name" }), "Main hose");
    expect(screen.getByRole("textbox", { name: "Asset Name" })).toHaveValue("Main hose");
  });

  it.each(["A", "B"] as const)("groups End %s into its own panel, in a fixed order, with no fields from the other end", async (end) => {
    renderNew();
    const panel = await screen.findByRole("group", { name: `End ${end}` });
    const labels = within(panel).getAllByRole("combobox").map((field) => field.getAttribute("aria-label"));
    expect(labels).toEqual([
      `Material (${end})`, `Nominal Bore (${end})`, `Coupling (${end})`, `Add-ons (${end})`, `Attach Methods (${end})`
    ]);
  });
});

describe("End A and End B stay independent", () => {
  it("changing one end's selections never changes the other", async () => {
    const user = userEvent.setup();
    const material = { id: "m1", name: "Rubber", code: "RUB" };
    const bore = { id: "b1", name: "50 mm", code: "50" };
    render(
      <AssetForm
        asset={null}
        configurationOptions={{ ...options, materials: [material], nominalBores: [bore] } as never}
        open
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />
    );
    const endA = await screen.findByRole("group", { name: "End A" });
    const endB = screen.getByRole("group", { name: "End B" });
    await user.selectOptions(within(endA).getByLabelText("Material (A)"), "m1");
    await user.selectOptions(within(endB).getByLabelText("Nominal Bore (B)"), "b1");

    expect(within(endA).getByLabelText("Material (A)")).toHaveValue("m1");
    expect(within(endA).getByLabelText("Nominal Bore (A)")).toHaveValue("");
    expect(within(endB).getByLabelText("Material (B)")).toHaveValue("");
    expect(within(endB).getByLabelText("Nominal Bore (B)")).toHaveValue("b1");
  });
});
