import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CustomerForm } from "../components/CustomerForm";

describe("CustomerForm", () => {
  it("collects only customer profile fields and supports additional locations", async () => {
    const user = userEvent.setup();
    render(
      <CustomerForm
        customer={null}
        open
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByRole("textbox", { name: "Name" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Location" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Phone" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Email" })).toBeVisible();
    expect(screen.getByText("PPE Requirements")).toBeVisible();
    expect(screen.getByText("Additional Requirements")).toBeVisible();
    expect(screen.queryByText("Customer code")).not.toBeInTheDocument();
    expect(screen.queryByText("Customer notes")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add location" }));
    expect(screen.getByRole("textbox", { name: "Location 2" })).toBeVisible();
  });
});
