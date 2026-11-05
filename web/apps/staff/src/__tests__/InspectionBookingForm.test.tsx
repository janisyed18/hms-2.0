import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InspectionBookingForm } from "../components/InspectionBookingForm";
import type {
  AssetRecord,
  InspectionAvailabilitySlot,
  InspectionBookingRecord
} from "../domain/types";
import { choose } from "../test/choose";

const listInspectionAvailability = vi.hoisted(() => vi.fn());
const listCustomers = vi.hoisted(() => vi.fn());
const getCustomer = vi.hoisted(() => vi.fn());
const listAssets = vi.hoisted(() => vi.fn());
const listAllAssets = vi.hoisted(() => vi.fn());

vi.mock("../api/hmsClient", () => ({
  createHmsClient: () => ({ listInspectionAvailability, listCustomers, getCustomer, listAssets, listAllAssets })
}));

function asset(id: string, number: string, customerId: string, customerName: string, locationId: string, locationName: string): AssetRecord {
  return {
    id,
    assetNumber: number,
    customer: { id: customerId, code: customerId, name: customerName },
    location: { id: locationId, name: locationName, schedulingTimezone: "Australia/Perth" }
  } as unknown as AssetRecord;
}

// 60 assets at Harris Park: more than one page of the lookup, so a later page has to be reachable.
const assets = [
  ...Array.from({ length: 60 }, (_, index) => asset(`a${index + 1}`, `ASSET-A${index + 1}`, "cust-1", "TH Industries", "loc-a", "Harris Park")),
  asset("b1", "ASSET-B1", "cust-1", "TH Industries", "loc-b", "Preston"),
  // 150 at Welshpool: Select All has to read past the 100-row page to reach them all.
  ...Array.from({ length: 150 }, (_, index) => asset(`c${index + 1}`, `ASSET-C${index + 1}`, "cust-1", "TH Industries", "loc-c", "Welshpool"))
];
const customers = [
  { id: "cust-1", code: "cust-1", name: "TH Industries", locations: [{ id: "loc-a", name: "Harris Park", schedulingTimezone: "Australia/Perth" }, { id: "loc-b", name: "Preston", schedulingTimezone: "Australia/Perth" }, { id: "loc-c", name: "Welshpool", schedulingTimezone: "Australia/Perth" }] },
  { id: "cust-2", code: "cust-2", name: "Other Co", locations: [{ id: "loc-d", name: "Elsewhere", schedulingTimezone: "Australia/Perth" }] }
];

/** Stands in for the server: it filters by customer, location and search, and pages by offset and limit. */
function serveLookups() {
  listCustomers.mockImplementation(async ({ search = "" }: { search?: string }) => ({
    total: customers.length,
    items: customers.filter((customer) => customer.name.toLowerCase().includes(search.toLowerCase()))
  }));
  getCustomer.mockImplementation(async (id: string) => customers.find((customer) => customer.id === id));
  listAssets.mockImplementation(async (options: { customerId?: string; locationId?: string; search?: string; limit?: number; offset?: number }) => {
    const matching = assets.filter((item) =>
      (!options.customerId || item.customer.id === options.customerId)
      && (!options.locationId || item.location?.id === options.locationId)
      && (!options.search || item.assetNumber.toLowerCase().includes(options.search.toLowerCase())));
    const offset = options.offset ?? 0;
    return { total: matching.length, items: matching.slice(offset, offset + (options.limit ?? 50)) };
  });
  // The real client pages this itself, 100 at a time, so page the stub the same way.
  listAllAssets.mockImplementation(async (options: { customerId?: string; locationId?: string }) => {
    const pageSize = 100;
    const items: AssetRecord[] = [];
    for (;;) {
      const page = await listAssets({ ...options, limit: pageSize, offset: items.length });
      items.push(...page.items);
      if (items.length >= page.total || page.items.length === 0) return { total: page.total, items };
    }
  });
}

async function pickCustomer(user: ReturnType<typeof userEvent.setup>, id: string) {
  await choose(user, screen.getByRole("combobox", { name: "Booking customer" }), id);
}

async function assetBoxes() {
  await waitFor(() => expect(screen.getAllByRole("checkbox").length).toBeGreaterThan(0));
  return screen.getAllByRole("checkbox").map((box) => (box as HTMLInputElement).labels?.[0]?.textContent);
}

function slots(prefix: string): InspectionAvailabilitySlot[] {
  return [
    { quoteId: `${prefix}-quote-1`, startsAt: "2030-01-07T00:00:00Z", endsAt: "2030-01-07T01:00:00Z", expiresAt: "2030-01-07T00:10:00Z" }
  ];
}

function renderForm(overrides: Partial<React.ComponentProps<typeof InspectionBookingForm>> = {}) {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onReschedule = vi.fn().mockResolvedValue(undefined);
  const props = {
    open: true,
    onClose: vi.fn(),
    onSubmit,
    onReschedule,
    ...overrides
  };
  const view = render(<InspectionBookingForm {...props} />);
  return { ...view, onSubmit, onReschedule, props };
}

const submitButton = () => screen.getByRole("button", { name: /Create booking|Request reschedule/ });

beforeEach(() => {
  listCustomers.mockReset(); getCustomer.mockReset(); listAssets.mockReset(); listAllAssets.mockReset();
  serveLookups();
  listInspectionAvailability.mockReset();
  listInspectionAvailability.mockImplementation(async ({ locationId }: { locationId: string }) => slots(locationId));
});

describe("new booking", () => {
  it("starts with no customer, no location, no assets and nothing submittable", () => {
    renderForm();

    const location = screen.getByLabelText("Booking location");
    expect(location).toHaveTextContent("Choose a customer first");
    expect(location).toBeDisabled();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByText("Choose a location to see its assets.")).toBeVisible();
    expect(submitButton()).toBeDisabled();
    expect(listInspectionAvailability).not.toHaveBeenCalled();
    expect(listAssets).not.toHaveBeenCalled();
  });

  it("lists the chosen location's assets a page at a time and selects none of them", async () => {
    const user = userEvent.setup();
    renderForm();

    await pickCustomer(user, "cust-1");
    await choose(user, screen.getByLabelText("Booking location"), "loc-a");

    const labels = await assetBoxes();
    expect(labels).toHaveLength(25);
    expect(labels[0]).toBe("ASSET-A1");
    screen.getAllByRole("checkbox").forEach((box) => expect(box).not.toBeChecked());
    expect(screen.getByText(/25 of 60 assets shown/)).toBeVisible();
    // Only assets that can take new work are asked for.
    expect(listAssets).toHaveBeenCalledWith(expect.objectContaining({ customerId: "cust-1", locationId: "loc-a", newWorkOnly: true, limit: 25, offset: 0 }));
    expect(submitButton()).toBeDisabled();
  });

  it("reaches an asset beyond the first page, by paging and by searching", async () => {
    const user = userEvent.setup();
    renderForm();

    await pickCustomer(user, "cust-1");
    await choose(user, screen.getByLabelText("Booking location"), "loc-a");
    await assetBoxes();
    expect(screen.queryByRole("checkbox", { name: "ASSET-A60" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show more assets" }));
    await user.click(await screen.findByRole("button", { name: "Show more assets" }));
    await user.click(await screen.findByRole("checkbox", { name: "ASSET-A60" }));
    expect(screen.getByRole("checkbox", { name: "ASSET-A60" })).toBeChecked();

    // Searching moves the page on, and the ticked asset is still counted and still shown.
    await user.type(screen.getByLabelText("Search assets"), "ASSET-A5");
    await waitFor(() => expect(screen.getByText(/11 matching/)).toBeVisible());
    expect(screen.getByRole("checkbox", { name: "ASSET-A60" })).toBeChecked();
    expect(screen.getByText(/1 selected/)).toBeVisible();
  });

  it("books after the user explicitly picks location, asset, date and a quoted time", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();

    await pickCustomer(user, "cust-1");
    await choose(user, screen.getByLabelText("Booking location"), "loc-a");
    await user.click(await screen.findByRole("checkbox", { name: "ASSET-A2" }));
    expect(submitButton()).toBeDisabled();
    await user.type(screen.getByLabelText("Preferred inspection date"), "2030-01-07");
    await waitFor(() => expect(screen.getByLabelText("Available inspection time")).toBeEnabled());
    expect(listInspectionAvailability).toHaveBeenCalledWith({
      customerId: "cust-1",
      locationId: "loc-a",
      localDate: "2030-01-07",
      durationMinutes: 60
    });
    expect(submitButton()).toBeDisabled();
    await choose(user, screen.getByLabelText("Available inspection time"), "loc-a-quote-1");
    expect(submitButton()).toBeEnabled();
    await user.click(submitButton());

    expect(onSubmit).toHaveBeenCalledWith({
      customerId: "cust-1",
      locationId: "loc-a",
      assetIds: ["a2"],
      availabilityQuoteId: "loc-a-quote-1",
      additionalInformation: null
    });
  });

  it("selects every eligible asset beyond the first page, and submits exactly what stays ticked", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();

    await pickCustomer(user, "cust-1");
    await choose(user, screen.getByLabelText("Booking location"), "loc-c");
    await assetBoxes();
    expect(screen.getByText(/25 of 150 assets shown/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Select all assets" }));

    // All 150 are held, not just the 100 of the first page or the 25 on screen.
    await waitFor(() => expect(screen.getByText(/150 selected/)).toBeVisible());
    expect(listAllAssets).toHaveBeenCalledWith(expect.objectContaining({
      customerId: "cust-1",
      locationId: "loc-c",
      newWorkOnly: true
    }));
    // An asset from the second Select All page is ticked and shown, though the visible
    // page never reached it.
    expect(screen.getByRole("checkbox", { name: "ASSET-C150" })).toBeChecked();

    // Untick two: one on the first page, one only Select All brought in.
    await user.click(screen.getByRole("checkbox", { name: "ASSET-C1" }));
    await user.click(screen.getByRole("checkbox", { name: "ASSET-C150" }));
    await waitFor(() => expect(screen.getByText(/148 selected/)).toBeVisible());
    // The one on the visible page stays, unticked; the off-page one only had a row
    // because it was selected, so unticking it takes the row away.
    expect(screen.getByRole("checkbox", { name: "ASSET-C1" })).not.toBeChecked();
    expect(screen.queryByRole("checkbox", { name: "ASSET-C150" })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Preferred inspection date"), "2030-01-07");
    await waitFor(() => expect(screen.getByLabelText("Available inspection time")).toBeEnabled());
    await choose(user, screen.getByLabelText("Available inspection time"), "loc-c-quote-1");
    await user.click(submitButton());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submitted = onSubmit.mock.calls[0][0] as { assetIds: string[] };
    // What was submitted is the whole eligible set for this location, less the two
    // that were unticked: 150 - 2. Derived from the fixture, so the count cannot drift.
    const eligible = assets.filter((item) => item.location?.id === "loc-c").map((item) => item.id);
    const deselected = ["c1", "c150"];
    expect(eligible).toHaveLength(150);
    expect(submitted.assetIds).toEqual(eligible.filter((id) => !deselected.includes(id)));
    expect(submitted.assetIds).toHaveLength(148);
    // Nothing is sent twice, and neither unticked asset rides along.
    expect(new Set(submitted.assetIds).size).toBe(148);
    for (const id of deselected) expect(submitted.assetIds).not.toContain(id);
  });

  it("clears assets, date, times and the quote when the location changes", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();

    await pickCustomer(user, "cust-1");
    await choose(user, screen.getByLabelText("Booking location"), "loc-a");
    await user.click(await screen.findByRole("checkbox", { name: "ASSET-A1" }));
    await user.type(screen.getByLabelText("Preferred inspection date"), "2030-01-07");
    await waitFor(() => expect(screen.getByLabelText("Available inspection time")).toBeEnabled());
    await choose(user, screen.getByLabelText("Available inspection time"), "loc-a-quote-1");
    expect(submitButton()).toBeEnabled();

    await choose(user, screen.getByLabelText("Booking location"), "loc-b");

    expect(await assetBoxes()).toEqual(["ASSET-B1"]);
    expect(screen.getByRole("checkbox", { name: "ASSET-B1" })).not.toBeChecked();
    expect(screen.getByLabelText("Preferred inspection date")).toHaveValue("");
    expect(screen.queryByLabelText("Available inspection time")).not.toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
    await user.click(submitButton());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("ignores availability that arrives for a location the user has already left", async () => {
    let resolveSlow: (value: InspectionAvailabilitySlot[]) => void = () => undefined;
    listInspectionAvailability.mockImplementationOnce(
      () => new Promise<InspectionAvailabilitySlot[]>((resolve) => { resolveSlow = resolve; })
    );
    const user = userEvent.setup();
    const { onSubmit } = renderForm();

    await pickCustomer(user, "cust-1");
    await choose(user, screen.getByLabelText("Booking location"), "loc-a");
    await user.click(await screen.findByRole("checkbox", { name: "ASSET-A1" }));
    await user.type(screen.getByLabelText("Preferred inspection date"), "2030-01-07");
    await choose(user, screen.getByLabelText("Booking location"), "loc-b");
    await user.click(await screen.findByRole("checkbox", { name: "ASSET-B1" }));
    await act(async () => resolveSlow(slots("loc-a-stale")));

    expect(screen.queryByRole("option", { name: /loc-a-stale/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Available inspection time")).not.toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("drops the chosen time when the date changes, so an old quote cannot be submitted", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();

    await pickCustomer(user, "cust-1");
    await choose(user, screen.getByLabelText("Booking location"), "loc-a");
    await user.click(await screen.findByRole("checkbox", { name: "ASSET-A1" }));
    const date = screen.getByLabelText("Preferred inspection date");
    await user.type(date, "2030-01-07");
    await waitFor(() => expect(screen.getByLabelText("Available inspection time")).toBeEnabled());
    await choose(user, screen.getByLabelText("Available inspection time"), "loc-a-quote-1");
    expect(submitButton()).toBeEnabled();

    await user.clear(date);

    expect(submitButton()).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps the user's selections when the form re-renders while open", async () => {
    const user = userEvent.setup();
    const { rerender, props } = renderForm();

    await pickCustomer(user, "cust-1");
    await choose(user, screen.getByLabelText("Booking location"), "loc-a");
    await user.click(await screen.findByRole("checkbox", { name: "ASSET-A2" }));
    rerender(<InspectionBookingForm {...props} />);

    expect(screen.getByLabelText("Booking location")).toHaveTextContent("Harris Park");
    expect(screen.getByRole("checkbox", { name: "ASSET-A2" })).toBeChecked();
  });
});

describe("reschedule", () => {
  const booking = {
    id: "booking-1",
    customer: { id: "cust-1", code: "cust-1", name: "TH Industries" },
    location: { id: "loc-a", name: "Harris Park", schedulingTimezone: "Australia/Perth" },
    assets: [{ id: "a1", assetNumber: "ASSET-A1" }],
    status: "APPROVED",
    appointment: { id: "app-1", status: "CONFIRMED", startsAt: "2030-01-06T00:00:00Z", endsAt: "2030-01-06T01:00:00Z", revisionNumber: 1 },
    changeRequests: []
  } as unknown as InspectionBookingRecord;

  it("keeps the existing location and assets, locked, instead of blanking them", async () => {
    const user = userEvent.setup();
    const { onReschedule } = renderForm({ rescheduleBooking: booking });

    const location = screen.getByLabelText("Booking location");
    expect(location).toHaveTextContent("Harris Park");
    expect(location).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "ASSET-A1" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "ASSET-A1" })).toBeDisabled();
    expect(submitButton()).toBeDisabled();

    await user.type(screen.getByLabelText("Preferred inspection date"), "2030-01-08");
    await waitFor(() => expect(screen.getByLabelText("Available inspection time")).toBeEnabled());
    expect(listInspectionAvailability).toHaveBeenCalledWith(expect.objectContaining({ customerId: "cust-1", locationId: "loc-a" }));
    await choose(user, screen.getByLabelText("Available inspection time"), "loc-a-quote-1");
    await user.click(submitButton());
    expect(onReschedule).toHaveBeenCalledWith("booking-1", { availabilityQuoteId: "loc-a-quote-1", reason: null, inspectorUserId: null });
  });
});
