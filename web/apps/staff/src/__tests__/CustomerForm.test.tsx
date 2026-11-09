import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  afterEach(cleanup);
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
    await user.click(screen.getByRole("button", { name: "Add contact" }));
    await user.type(screen.getByRole("textbox", { name: "Contact 1 name" }), "Alex Nguyen");
    await user.type(screen.getByRole("textbox", { name: "Contact 1 phone" }), "+61 412 345 678");
    await user.type(screen.getByRole("textbox", { name: "Contact 1 email" }), "alex.nguyen@example.test");
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

  describe("several locations on the same form", () => {
    async function fillFirst(user: ReturnType<typeof userEvent.setup>) {
      await user.type(screen.getByRole("textbox", { name: "Name" }), "Summit Marine Group");
      await user.type(screen.getAllByRole("textbox", { name: "Location name" })[0], "Newcastle yard");
      await choose(user, screen.getAllByRole("combobox", { name: "Timezone" })[0], "Australia/Sydney");
    }

    it("adds a second location with its own values and saves both in one submission", async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      render(<CustomerForm customer={null} open onClose={vi.fn()} onSubmit={onSubmit} />);
      await fillFirst(user);

      await user.click(screen.getByRole("button", { name: "Add another location" }));
      const names = screen.getAllByRole("textbox", { name: "Location name" });
      expect(names).toHaveLength(2);
      expect(names[0]).toHaveValue("Newcastle yard");
      expect(names[1]).toHaveValue("");
      await user.type(names[1], "Botany terminal");
      await choose(user, screen.getAllByRole("combobox", { name: "Timezone" })[1], "Australia/Perth");
      await user.click(screen.getByRole("button", { name: "Save customer" }));

      expect(onSubmit).toHaveBeenCalledTimes(1);
      const saved = onSubmit.mock.calls[0][0];
      expect(saved.firstLocation).toEqual(expect.objectContaining({ name: "Newcastle yard", schedulingTimezone: "Australia/Sydney" }));
      expect(saved.additionalLocations).toEqual([expect.objectContaining({ name: "Botany terminal", schedulingTimezone: "Australia/Perth" })]);
    });

    it("reports a problem in the added location without touching the first one", async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      render(<CustomerForm customer={null} open onClose={vi.fn()} onSubmit={onSubmit} />);
      await fillFirst(user);
      await user.click(screen.getByRole("button", { name: "Add another location" }));
      await user.click(screen.getByRole("button", { name: "Save customer" }));

      expect(onSubmit).not.toHaveBeenCalled();
      // Only the added location is incomplete: one name error, and the first location keeps its value.
      expect(await screen.findAllByText("Enter the location name.")).toHaveLength(1);
      expect(screen.getAllByRole("textbox", { name: "Location name" })[0]).toHaveValue("Newcastle yard");
    });

    it("keeps each location's contacts and notes separate", async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      render(<CustomerForm customer={null} open onClose={vi.fn()} onSubmit={onSubmit} />);
      await fillFirst(user);
      await user.click(screen.getByRole("button", { name: "Add another location" }));
      await user.type(screen.getAllByRole("textbox", { name: "Location name" })[1], "Botany terminal");
      await choose(user, screen.getAllByRole("combobox", { name: "Timezone" })[1], "Australia/Perth");

      await user.click(screen.getAllByRole("button", { name: "Add contact" })[0]);
      await user.type(screen.getByRole("textbox", { name: "Contact 1 name" }), "Alex Nguyen");
      await user.type(screen.getAllByRole("textbox", { name: "Location Notes" })[0], "Gate 3 only");
      await user.click(screen.getAllByRole("button", { name: "Add contact" })[1]);
      const contactNames = screen.getAllByRole("textbox", { name: "Contact 1 name" });
      expect(contactNames).toHaveLength(2);
      await user.type(contactNames[1], "Sam Lee");
      await user.type(screen.getAllByRole("textbox", { name: "Location Notes" })[1], "Escort required");
      await user.click(screen.getByRole("button", { name: "Save customer" }));

      const saved = onSubmit.mock.calls[0][0];
      expect(saved.firstLocation).toEqual(expect.objectContaining({ notes: "Gate 3 only", contacts: [expect.objectContaining({ name: "Alex Nguyen" })] }));
      expect(saved.additionalLocations[0]).toEqual(expect.objectContaining({ notes: "Escort required", contacts: [expect.objectContaining({ name: "Sam Lee" })] }));
    });

    it("does not move one location's validation error onto another, and drops a removed location's errors", async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      render(<CustomerForm customer={null} open onClose={vi.fn()} onSubmit={onSubmit} />);
      await user.type(screen.getByRole("textbox", { name: "Name" }), "Summit Marine Group");
      await user.click(screen.getByRole("button", { name: "Add another location" }));
      // Complete only the second location; the first is the incomplete one.
      await user.type(screen.getAllByRole("textbox", { name: "Location name" })[1], "Botany terminal");
      await choose(user, screen.getAllByRole("combobox", { name: "Timezone" })[1], "Australia/Perth");
      await user.click(screen.getByRole("button", { name: "Save customer" }));

      const [first, second] = screen.getAllByRole("textbox", { name: "Location name" });
      await screen.findAllByText("Enter the location name.");
      expect(first).toHaveAttribute("aria-invalid", "true");
      expect(second).not.toHaveAttribute("aria-invalid", "true");

      // An incomplete added location is reported, then removing it removes its error too.
      await user.click(screen.getByRole("button", { name: "Add another location" }));
      await user.click(screen.getByRole("button", { name: "Save customer" }));
      await waitFor(() => expect(screen.getAllByRole("textbox", { name: "Location name" })[2]).toHaveAttribute("aria-invalid", "true"));
      await user.click(screen.getByRole("button", { name: "Remove location 3" }));
      expect(screen.getAllByRole("textbox", { name: "Location name" })).toHaveLength(2);
      expect(screen.getAllByText("Enter the location name.")).toHaveLength(1);
    });

    it("removes an added location, keeps the first required, and sends no extras", async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      render(<CustomerForm customer={null} open onClose={vi.fn()} onSubmit={onSubmit} />);
      await fillFirst(user);
      await user.click(screen.getByRole("button", { name: "Add another location" }));
      await user.click(screen.getByRole("button", { name: "Remove location 2" }));

      expect(screen.getAllByRole("textbox", { name: "Location name" })).toHaveLength(1);
      expect(screen.queryByRole("button", { name: /Remove location/ })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Save customer" }));
      expect(onSubmit.mock.calls[0][0].additionalLocations).toEqual([]);
    });

    it("does not offer extra locations when editing an existing customer", () => {
      render(<CustomerForm customer={customer} open onClose={vi.fn()} onSubmit={vi.fn()} />);
      expect(screen.queryByRole("button", { name: "Add another location" })).not.toBeInTheDocument();
    });
  });
});
