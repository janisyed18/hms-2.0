import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CustomerForm } from "../components/CustomerForm";
import { choose } from "../test/choose";
import type { CustomerRecord } from "../domain/types";

const customer: CustomerRecord = {
  id: "customer-1",
  code: "CUST-1",
  name: "Harbour Operations",
  notes: "Original notes",
  retestEnabled: true,
  defaultRetestMonths: 12,
  contacts: [],
  status: "Active",
  archivedAt: null,
  metrics: {
    assetCount: 0,
    inServiceCount: 0,
    inspectionDueCount: 0,
    inspectionDueLabel: "",
    certificateValidPercent: 0,
    certificateStatusLabel: "",
    recentInspections: [],
    activity: []
  },
  locations: []
};

describe("CustomerForm", () => {
  it("edits only the customer's own fields; locations and contacts live in Customer Details", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<CustomerForm customer={customer} open onClose={vi.fn()} onSubmit={onSubmit} />);

    expect(screen.queryByRole("textbox", { name: "Location name" })).not.toBeInTheDocument();
    await user.clear(screen.getByRole("textbox", { name: "Notes" }));
    await user.type(screen.getByRole("textbox", { name: "Notes" }), "Updated notes only");
    await user.click(screen.getByRole("button", { name: "Save customer" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ name: "Harbour Operations", notes: "Updated notes only" }));
  });

  it("refuses to create a customer without a first location and says what is missing", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<CustomerForm customer={null} open onClose={vi.fn()} onSubmit={onSubmit} />);

    await user.type(screen.getByRole("textbox", { name: "Name" }), "Summit Marine Group");
    await user.click(screen.getByRole("button", { name: "Save customer" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByText("Enter the location name.")).toBeVisible();
    expect(screen.getByText("Select the timezone this location is in.")).toBeVisible();
  });

  it("shows scheduling instead of hiding UTC and office hours, and creates with one explicit location", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<CustomerForm customer={null} open onClose={vi.fn()} onSubmit={onSubmit} />);

    // Nothing is chosen for the timezone; the working week and hours are visible and editable.
    expect(screen.getByRole("combobox", { name: "Timezone" })).toHaveValue("");
    expect(screen.getByLabelText("Opening time")).toHaveValue("08:00");
    expect(screen.getByLabelText("Closing time")).toHaveValue("17:00");

    await user.type(screen.getByRole("textbox", { name: "Name" }), "Summit Marine Group");
    await user.type(screen.getByRole("textbox", { name: "Notes" }), "Coordinate access with the terminal team.");
    await user.type(screen.getByRole("textbox", { name: "Location name" }), "Newcastle operations yard");
    await user.type(screen.getByRole("textbox", { name: "Site contact name" }), "Alex Nguyen");
    await user.type(screen.getByRole("textbox", { name: "Site contact mobile" }), "+61 412 345 678");
    await user.type(screen.getByRole("textbox", { name: "Site contact email" }), "alex.nguyen@example.test");
    await user.click(screen.getByRole("checkbox", { name: "High Vis" }));
    await choose(user, screen.getByRole("combobox", { name: "Timezone" }), "Australia/Sydney");
    await user.click(screen.getByRole("button", { name: "Save customer" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      name: "Summit Marine Group",
      notes: "Coordinate access with the terminal team.",
      firstLocation: expect.objectContaining({
        name: "Newcastle operations yard",
        ppeRequirements: ["High Vis"],
        schedulingTimezone: "Australia/Sydney",
        schedulingOpenTime: "08:00",
        schedulingCloseTime: "17:00"
      })
    }));
  });
});
