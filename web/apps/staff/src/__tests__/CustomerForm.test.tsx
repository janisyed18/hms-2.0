import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CustomerForm } from "../components/CustomerForm";

describe("CustomerForm", () => {
  it("preserves a location schedule when editing only customer notes", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <CustomerForm
        customer={{
          id: "customer-1",
          code: "CUST-1",
          name: "Harbour Operations",
          notes: "Original notes",
          retestEnabled: true,
          defaultRetestMonths: 12,
          contacts: [],
          status: "Active",
          riskLevel: "Low",
          industry: "",
          paymentTerms: "",
          contractStart: "",
          contractEnd: "",
          lastActivity: "",
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
          locations: [{
            id: "location-1",
            name: "Sydney terminal",
            address1: null,
            address2: null,
            city: null,
            state: null,
            country: null,
            siteContactName: "Avery",
            siteContactMobile: "+61 400 000 000",
            siteContactEmail: "avery@example.test",
            ppeRequirements: ["High Vis"],
            additionalRequirements: [],
            schedulingTimezone: "Australia/Sydney",
            schedulingOpenTime: "07:00",
            schedulingCloseTime: "15:00",
            schedulingWeekdays: [1, 2, 3, 4, 5],
            schedulingBlackoutDates: ["2027-01-26"]
          }]
        }}
        open
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />
    );

    await user.clear(screen.getByRole("textbox", { name: "Notes" }));
    await user.type(screen.getByRole("textbox", { name: "Notes" }), "Updated notes only");
    await user.click(screen.getByRole("button", { name: "Save customer" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      notes: "Updated notes only",
      locations: [expect.objectContaining({
        schedulingTimezone: "Australia/Sydney",
        schedulingOpenTime: "07:00",
        schedulingCloseTime: "15:00",
        schedulingWeekdays: [1, 2, 3, 4, 5],
        schedulingBlackoutDates: ["2027-01-26"]
      })]
    }));
  });

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
