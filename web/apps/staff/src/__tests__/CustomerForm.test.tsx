import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CustomerForm } from "../components/CustomerForm";

describe("CustomerForm", () => {
  it("keeps access requirements with each customer location", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <CustomerForm
        customer={null}
        open
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />
    );

    expect(screen.getByRole("textbox", { name: "Name" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Location" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Site contact name" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Site contact mobile" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Site contact email" })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Phone" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Email" })).not.toBeInTheDocument();
    expect(screen.getByText("PPE requirements")).toBeVisible();
    expect(screen.getByText("Additional requirements")).toBeVisible();
    expect(screen.queryByText("Customer code")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Notes" })).toBeVisible();

    await user.type(screen.getByRole("textbox", { name: "Name" }), "Summit Marine Group");
    await user.type(screen.getByRole("textbox", { name: "Notes" }), "Coordinate access with the terminal team.");
    await user.type(screen.getByRole("textbox", { name: "Location" }), "Newcastle operations yard");
    await user.type(screen.getByRole("textbox", { name: "Site contact name" }), "Alex Nguyen");
    await user.type(screen.getByRole("textbox", { name: "Site contact mobile" }), "+61 412 345 678");
    await user.type(screen.getByRole("textbox", { name: "Site contact email" }), "alex.nguyen@example.test");
    await user.click(screen.getByRole("checkbox", { name: "High Vis" }));
    await user.click(screen.getByRole("button", { name: "Save customer" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      name: "Summit Marine Group",
      notes: "Coordinate access with the terminal team.",
      locations: [expect.objectContaining({ ppeRequirements: ["High Vis"] })]
    }));

    await user.click(screen.getByRole("button", { name: "Add location" }));
    expect(screen.getByRole("textbox", { name: "Location 2" })).toBeVisible();
  });
});
