import { act, render, screen, waitFor, within } from "@testing-library/react";
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

/** Assets are chosen in the picker dialog now, so these drive it the way a person does. */
async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /Choose assets|Change assets/ }));
  return within(await screen.findByRole("dialog", { name: "Choose assets" }));
}

/** Leaves the picker without changing the booking. */
async function cancelPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(screen.getByRole("dialog", { name: "Choose assets" })).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose assets" })).not.toBeInTheDocument());
}

/** Confirms the picker and returns to the form. */
async function confirmPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /^Use \d+ asset|^Use no assets$/ }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose assets" })).not.toBeInTheDocument());
}

/** Opens the picker, ticks the named assets and confirms, the way a person would. */
async function pickAssets(user: ReturnType<typeof userEvent.setup>, labels: string[]) {
  const picker = await openPicker(user);
  for (const label of labels) await user.click(await picker.findByRole("checkbox", { name: label }));
  await confirmPicker(user);
}

async function assetBoxes(user: ReturnType<typeof userEvent.setup>) {
  const picker = await openPicker(user);
  await waitFor(() => expect(picker.getAllByRole("checkbox").length).toBeGreaterThan(0));
  return picker.getAllByRole("checkbox").map((box) => (box as HTMLInputElement).labels?.[0]?.textContent);
}

/** What the form says it is carrying, which is what a submit will send. */
const chosenAssets = () =>
  Array.from(document.querySelectorAll(".booking-asset-chosen li span")).map((row) => row.textContent?.trim() ?? "");

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

describe("booking started from an asset", () => {
  it("chooses the asset's customer, location and the asset itself, and leaves everything else blank", async () => {
    renderForm({ initialAsset: assets.find((item) => item.id === "a3") });

    expect(screen.getByRole("combobox", { name: "Booking customer" })).toHaveValue("TH Industries");
    await waitFor(() => expect(screen.getByLabelText("Booking location")).toHaveTextContent("Harris Park"));
    await waitFor(() => expect(chosenAssets()).toEqual(["ASSET-A3"]));
    expect(screen.getByLabelText("Preferred inspection date")).toHaveValue("");
    expect(screen.getByLabelText("Additional inspection information")).toHaveValue("");
    expect(submitButton()).toBeDisabled();
  });

  it("submits the asset's own customer, location and id once a time is chosen", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm({ initialAsset: assets.find((item) => item.id === "a3") });
    await screen.findByRole("button", { name: /Choose assets|Change assets/ });
    await user.type(screen.getByLabelText("Preferred inspection date"), "2030-01-07");
    await choose(user, await screen.findByLabelText("Available inspection time"), "loc-a-quote-1");
    await user.click(submitButton());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ customerId: "cust-1", locationId: "loc-a", assetIds: ["a3"], availabilityQuoteId: "loc-a-quote-1" }));
  });

  it("leaves the location and assets blank for an asset that has no location", async () => {
    const unplaced = { ...assets[0], id: "z1", assetNumber: "ASSET-Z1", location: null } as unknown as AssetRecord;
    renderForm({ initialAsset: unplaced });
    expect(screen.getByRole("combobox", { name: "Booking customer" })).toHaveValue("TH Industries");
    expect(screen.getByText("Choose a location to see its assets.")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("ASSET-Z1 has no location recorded");
    expect(chosenAssets()).toHaveLength(0);
  });
});

describe("changing what an asset started", () => {
  it("clears the assets, date and chosen time when the location is changed after the prefill", async () => {
    const user = userEvent.setup();
    renderForm({ initialAsset: assets.find((item) => item.id === "a3") });
    await screen.findByRole("button", { name: /Choose assets|Change assets/ });
    await user.type(screen.getByLabelText("Preferred inspection date"), "2030-01-07");
    await choose(user, await screen.findByLabelText("Available inspection time"), "loc-a-quote-1");
    await choose(user, screen.getByLabelText("Booking location"), "loc-b");
    await waitFor(() => expect(screen.getByLabelText("Preferred inspection date")).toHaveValue(""));
    expect(chosenAssets()).toHaveLength(0);
    expect(submitButton()).toBeDisabled();
  });

  it("clears the location and assets when the customer is changed after the prefill", async () => {
    const user = userEvent.setup();
    renderForm({ initialAsset: assets.find((item) => item.id === "a3") });
    await screen.findByRole("button", { name: /Choose assets|Change assets/ });
    await pickCustomer(user, "cust-2");
    expect(screen.getByLabelText("Booking location")).not.toHaveTextContent("Harris Park");
    expect(chosenAssets()).toHaveLength(0);
    expect(submitButton()).toBeDisabled();
  });

  it("reloads every field for a different asset, even after the first one was edited", async () => {
    const user = userEvent.setup();
    const { rerender, props } = renderForm({ initialAsset: assets.find((item) => item.id === "a3") });
    await screen.findByRole("button", { name: /Choose assets|Change assets/ });
    await user.type(screen.getByLabelText("Additional inspection information"), "gate code 12");
    rerender(<InspectionBookingForm {...props} initialAsset={assets.find((item) => item.id === "b1")} />);
    await waitFor(() => expect(screen.getByLabelText("Booking location")).toHaveTextContent("Preston"));
    expect(screen.getByLabelText("Additional inspection information")).toHaveValue("");
    await waitFor(() => expect(chosenAssets()).toHaveLength(1));
  });
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

    const picker = await openPicker(user);
    await waitFor(() => expect(picker.getAllByRole("checkbox")).toHaveLength(25));
    expect(picker.getAllByRole("checkbox")[0]).toHaveAccessibleName("ASSET-A1");
    picker.getAllByRole("checkbox").forEach((box) => expect(box).not.toBeChecked());
    expect(picker.getByText(/60 assets at this location, 25 shown/)).toBeVisible();
    // Only assets that can take new work, at this customer's chosen location, are asked for.
    expect(listAssets).toHaveBeenCalledWith(expect.objectContaining({ customerId: "cust-1", locationId: "loc-a", newWorkOnly: true, limit: 25, offset: 0 }));
    expect(chosenAssets()).toHaveLength(0);
    expect(submitButton()).toBeDisabled();
  });

  it("reaches an asset beyond the first page, by paging and by searching", async () => {
    const user = userEvent.setup();
    renderForm();

    await pickCustomer(user, "cust-1");
    await choose(user, screen.getByLabelText("Booking location"), "loc-a");
    const picker = await openPicker(user);
    expect(picker.queryByRole("checkbox", { name: "ASSET-A60" })).not.toBeInTheDocument();

    await user.click(await picker.findByRole("button", { name: "Show more assets" }));
    await user.click(await picker.findByRole("button", { name: "Show more assets" }));
    await user.click(await picker.findByRole("checkbox", { name: "ASSET-A60" }));
    expect(picker.getByRole("checkbox", { name: "ASSET-A60" })).toBeChecked();

    // Searching moves the page on; the asset chosen before it is still counted.
    await user.type(picker.getByRole("searchbox", { name: "Search assets" }), "ASSET-A5");
    await waitFor(() => expect(picker.getByRole("status")).toHaveTextContent(/11 matching/));
    expect(picker.getByText(/1 selected/)).toBeVisible();
    await confirmPicker(user);
    expect(chosenAssets()).toEqual(["ASSET-A60"]);
  });

  it("books after the user explicitly picks location, asset, date and a quoted time", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();

    await pickCustomer(user, "cust-1");
    await choose(user, screen.getByLabelText("Booking location"), "loc-a");
    await pickAssets(user, ["ASSET-A2"]);
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
    const picker = await openPicker(user);
    await waitFor(() => expect(picker.getByText(/150 assets at this location, 25 shown/)).toBeVisible());

    await user.click(picker.getByRole("button", { name: "Select all" }));

    // All 150 are held, not just the 25 on screen: the server was asked for the rest.
    await waitFor(() => expect(picker.getByText(/150 selected/)).toBeVisible());
    expect(listAllAssets).toHaveBeenCalledWith(expect.objectContaining({
      customerId: "cust-1",
      locationId: "loc-c",
      newWorkOnly: true
    }));

    // Untick two: one on the visible page, one only Select All brought in.
    await user.click(picker.getByRole("checkbox", { name: "ASSET-C1" }));
    await waitFor(() => expect(picker.getByText(/149 selected/)).toBeVisible());
    await user.type(picker.getByRole("searchbox", { name: "Search assets" }), "ASSET-C150");
    await user.click(await picker.findByRole("checkbox", { name: "ASSET-C150" }));
    await waitFor(() => expect(picker.getByText(/148 selected/)).toBeVisible());
    await confirmPicker(user);

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
    await pickAssets(user, ["ASSET-A1"]);
    await user.type(screen.getByLabelText("Preferred inspection date"), "2030-01-07");
    await waitFor(() => expect(screen.getByLabelText("Available inspection time")).toBeEnabled());
    await choose(user, screen.getByLabelText("Available inspection time"), "loc-a-quote-1");
    expect(submitButton()).toBeEnabled();

    await choose(user, screen.getByLabelText("Booking location"), "loc-b");

    expect(chosenAssets()).toHaveLength(0);
    expect(await assetBoxes(user)).toEqual(["ASSET-B1"]);
    expect(screen.getByRole("checkbox", { name: "ASSET-B1" })).not.toBeChecked();
    await cancelPicker(user);
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
    await pickAssets(user, ["ASSET-A1"]);
    await user.type(screen.getByLabelText("Preferred inspection date"), "2030-01-07");
    await choose(user, screen.getByLabelText("Booking location"), "loc-b");
    await pickAssets(user, ["ASSET-B1"]);
    await act(async () => resolveSlow(slots("loc-a-stale")));

    expect(screen.queryByRole("option", { name: /loc-a-stale/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Available inspection time")).not.toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("ignores a Select All that finishes after the picker closed and the location changed", async () => {
    let releaseSlow: (value: { total: number; items: AssetRecord[] }) => void = () => undefined;
    listAllAssets.mockImplementationOnce(
      () => new Promise<{ total: number; items: AssetRecord[] }>((resolve) => { releaseSlow = resolve; })
    );
    const user = userEvent.setup();
    const { onSubmit } = renderForm();

    await pickCustomer(user, "cust-1");
    await choose(user, screen.getByLabelText("Booking location"), "loc-a");
    const picker = await openPicker(user);
    await user.click(await picker.findByRole("button", { name: "Select all" }));
    // Leave before the answer comes back, then move the booking to another site.
    await cancelPicker(user);
    await choose(user, screen.getByLabelText("Booking location"), "loc-b");

    // Harris Park's answer arrives only now, with Preston on screen.
    const harrisPark = assets.filter((item) => item.location?.id === "loc-a");
    await act(async () => releaseSlow({ total: harrisPark.length, items: harrisPark }));

    // Nothing from the place the user left is carried into the booking.
    expect(chosenAssets()).toHaveLength(0);
    expect(await assetBoxes(user)).toEqual(["ASSET-B1"]);
    await cancelPicker(user);

    await pickAssets(user, ["ASSET-B1"]);
    await user.type(screen.getByLabelText("Preferred inspection date"), "2030-01-07");
    await waitFor(() => expect(screen.getByLabelText("Available inspection time")).toBeEnabled());
    await choose(user, screen.getByLabelText("Available inspection time"), "loc-b-quote-1");
    await user.click(submitButton());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submitted = onSubmit.mock.calls[0][0] as { locationId: string; assetIds: string[] };
    expect(submitted.locationId).toBe("loc-b");
    expect(submitted.assetIds).toEqual(["b1"]);
  });

  it("drops the chosen time when the date changes, so an old quote cannot be submitted", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();

    await pickCustomer(user, "cust-1");
    await choose(user, screen.getByLabelText("Booking location"), "loc-a");
    await pickAssets(user, ["ASSET-A1"]);
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
    await pickAssets(user, ["ASSET-A2"]);
    rerender(<InspectionBookingForm {...props} />);

    expect(screen.getByLabelText("Booking location")).toHaveTextContent("Harris Park");
    expect(chosenAssets()).toEqual(["ASSET-A2"]);
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
    // A reschedule keeps the booking's own assets: they are stated, not re-chosen.
    expect(screen.getByText("ASSET-A1")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Choose assets|Change assets/ })).not.toBeInTheDocument();
    expect(submitButton()).toBeDisabled();

    await user.type(screen.getByLabelText("Preferred inspection date"), "2030-01-08");
    await waitFor(() => expect(screen.getByLabelText("Available inspection time")).toBeEnabled());
    expect(listInspectionAvailability).toHaveBeenCalledWith(expect.objectContaining({ customerId: "cust-1", locationId: "loc-a" }));
    await choose(user, screen.getByLabelText("Available inspection time"), "loc-a-quote-1");
    await user.click(submitButton());
    expect(onReschedule).toHaveBeenCalledWith("booking-1", { availabilityQuoteId: "loc-a-quote-1", reason: null, inspectorUserId: null });
  });
});
