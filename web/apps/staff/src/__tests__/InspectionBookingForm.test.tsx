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

vi.mock("../api/hmsClient", () => ({
  createHmsClient: () => ({ listInspectionAvailability })
}));

function asset(id: string, number: string, customerId: string, customerName: string, locationId: string, locationName: string): AssetRecord {
  return {
    id,
    assetNumber: number,
    customer: { id: customerId, code: customerId, name: customerName },
    location: { id: locationId, name: locationName, schedulingTimezone: "Australia/Perth" }
  } as unknown as AssetRecord;
}

const assets = [
  asset("a1", "ASSET-A1", "cust-1", "TH Industries", "loc-a", "Harris Park"),
  asset("a2", "ASSET-A2", "cust-1", "TH Industries", "loc-a", "Harris Park"),
  asset("b1", "ASSET-B1", "cust-2", "Other Co", "loc-b", "Preston")
];

function slots(prefix: string): InspectionAvailabilitySlot[] {
  return [
    { quoteId: `${prefix}-quote-1`, startsAt: "2030-01-07T00:00:00Z", endsAt: "2030-01-07T01:00:00Z", expiresAt: "2030-01-07T00:10:00Z" }
  ];
}

function renderForm(overrides: Partial<React.ComponentProps<typeof InspectionBookingForm>> = {}) {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onReschedule = vi.fn().mockResolvedValue(undefined);
  const props = {
    assetOptions: assets,
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
  listInspectionAvailability.mockReset();
  listInspectionAvailability.mockImplementation(async ({ locationId }: { locationId: string }) => slots(locationId));
});

describe("new booking", () => {
  it("starts with no location, no assets and nothing submittable", () => {
    renderForm();

    const location = screen.getByLabelText("Booking location");
    expect(location).toHaveTextContent("Choose the location");
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByText("Choose a location to see its assets.")).toBeVisible();
    expect(submitButton()).toBeDisabled();
    expect(listInspectionAvailability).not.toHaveBeenCalled();
  });

  it("lists only the chosen location's assets and selects none of them", async () => {
    const user = userEvent.setup();
    renderForm();

    await choose(user, screen.getByLabelText("Booking location"), "loc-a");

    expect(screen.getAllByRole("checkbox").map((box) => (box as HTMLInputElement).labels?.[0]?.textContent))
      .toEqual(["ASSET-A1", "ASSET-A2"]);
    screen.getAllByRole("checkbox").forEach((box) => expect(box).not.toBeChecked());
    expect(submitButton()).toBeDisabled();
  });

  it("books after the user explicitly picks location, asset, date and a quoted time", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();

    await choose(user, screen.getByLabelText("Booking location"), "loc-a");
    await user.click(screen.getByRole("checkbox", { name: "ASSET-A2" }));
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

  it("clears assets, date, times and the quote when the location changes", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();

    await choose(user, screen.getByLabelText("Booking location"), "loc-a");
    await user.click(screen.getByRole("checkbox", { name: "ASSET-A1" }));
    await user.type(screen.getByLabelText("Preferred inspection date"), "2030-01-07");
    await waitFor(() => expect(screen.getByLabelText("Available inspection time")).toBeEnabled());
    await choose(user, screen.getByLabelText("Available inspection time"), "loc-a-quote-1");
    expect(submitButton()).toBeEnabled();

    await choose(user, screen.getByLabelText("Booking location"), "loc-b");

    expect(screen.getAllByRole("checkbox").map((box) => (box as HTMLInputElement).labels?.[0]?.textContent)).toEqual(["ASSET-B1"]);
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

    await choose(user, screen.getByLabelText("Booking location"), "loc-a");
    await user.click(screen.getByRole("checkbox", { name: "ASSET-A1" }));
    await user.type(screen.getByLabelText("Preferred inspection date"), "2030-01-07");
    await choose(user, screen.getByLabelText("Booking location"), "loc-b");
    await user.click(screen.getByRole("checkbox", { name: "ASSET-B1" }));
    await act(async () => resolveSlow(slots("loc-a-stale")));

    expect(screen.queryByRole("option", { name: /loc-a-stale/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Available inspection time")).not.toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("drops the chosen time when the date changes, so an old quote cannot be submitted", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();

    await choose(user, screen.getByLabelText("Booking location"), "loc-a");
    await user.click(screen.getByRole("checkbox", { name: "ASSET-A1" }));
    const date = screen.getByLabelText("Preferred inspection date");
    await user.type(date, "2030-01-07");
    await waitFor(() => expect(screen.getByLabelText("Available inspection time")).toBeEnabled());
    await choose(user, screen.getByLabelText("Available inspection time"), "loc-a-quote-1");
    expect(submitButton()).toBeEnabled();

    await user.clear(date);

    expect(submitButton()).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps the user's selections when the asset list is refreshed while the form is open", async () => {
    const user = userEvent.setup();
    const { rerender, props } = renderForm();

    await choose(user, screen.getByLabelText("Booking location"), "loc-a");
    await user.click(screen.getByRole("checkbox", { name: "ASSET-A2" }));
    rerender(<InspectionBookingForm {...props} assetOptions={[...assets]} />);

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
