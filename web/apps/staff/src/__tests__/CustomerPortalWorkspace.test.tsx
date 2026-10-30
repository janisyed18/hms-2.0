import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CustomerPortalWorkspace } from "../components/CustomerPortalWorkspace";
import type { StaffSession } from "../domain/types";
import { choose, openList } from "../test/choose";

const session: StaffSession = {
  userId: "customer-user",
  displayName: "Customer User",
  roles: ["CUSTOMER_USER"],
  permissions: ["customer:read", "asset:read", "inspection:book"],
  customerIds: ["customer-a", "customer-b"],
  authMode: "bearer"
};

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function customer(id: string, name: string) {
  return {
    id,
    code: id.toUpperCase(),
    name,
    notes: null,
    retest_enabled: true,
    default_retest_months: 12,
    locations: [{
      id: `location-${id}`,
      name: `${name} Site`,
      address_1: null,
      address_2: null,
      city: null,
      state: null,
      country: null,
      site_contact_name: null,
      site_contact_mobile: null,
      site_contact_email: null,
      ppe_requirements: [],
      additional_requirements: [],
      scheduling_timezone: "UTC",
      scheduling_open_time: "08:00",
      scheduling_close_time: "17:00",
      scheduling_weekdays: [0, 1, 2, 3, 4],
      scheduling_blackout_dates: []
    }],
    contacts: [],
    metrics: { asset_count: 1, in_service_count: 1 }
  };
}

function asset(customerId: string) {
  return {
    id: `asset-${customerId}`,
    asset_number: `ASSET-${customerId}`,
    customer_serial_no: null,
    purchase_order_number: null,
    tag: null,
    lifecycle_status: "IN_SERVICE",
    manufacture_date: null,
    installation_date: null,
    grave_date: null,
    next_retest_due_at: null,
    condemned_at: null,
    length_m: null,
    notes: null,
    description: null,
    customer: { id: customerId, code: customerId, name: customerId },
    product: { id: "product-1", code: "PRODUCT", name: "Product", category: "Hose" },
    location: { id: `location-${customerId}`, name: "Site", address_1: null, address_2: null, city: null, state: null, country: null, scheduling_timezone: "UTC" },
    retest_schedule: null,
    a_end: null,
    b_end: null,
    inspection_history: [],
    certificate_history: []
  };
}

function Harness() {
  const [customerId, setCustomerId] = useState<string | null>(null);
  return <CustomerPortalWorkspace activeModule="bookings" assetId={null} customerId={customerId} key={customerId ?? "customer"} onAssetChange={vi.fn()} onCustomerChange={setCustomerId} onModuleChange={vi.fn()} session={session} />;
}

function WorkspaceHarness({ activeModule }: { activeModule: "dashboard" | "bookings" | "notifications" }) {
  const [customerId, setCustomerId] = useState<string | null>("customer-a");
  return <CustomerPortalWorkspace activeModule={activeModule} assetId={null} customerId={customerId} key={customerId ?? "customer"} onAssetChange={vi.fn()} onCustomerChange={setCustomerId} onModuleChange={vi.fn()} session={session} />;
}

afterEach(() => vi.unstubAllGlobals());

describe("CustomerPortalWorkspace", () => {
  it("does not auto-select assets and clears the booking quote when the organisation changes", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url), "http://test");
      requested.push(requestUrl.toString());
      if (requestUrl.pathname === "/api/v1/customers") {
        return response({ total: 2, limit: 100, offset: 0, items: [customer("customer-a", "Customer A"), customer("customer-b", "Customer B")] });
      }
      if (requestUrl.pathname === "/api/v1/assets") {
        const id = requestUrl.searchParams.get("customer_id") ?? "customer-a";
        return response({ total: 1, limit: 100, offset: 0, items: [asset(id)] });
      }
      if (requestUrl.pathname === "/api/v1/inspection-availability") {
        return response({ items: [{ quote_id: "quote-1", starts_at: "2026-10-22T10:00:00Z", ends_at: "2026-10-22T11:00:00Z", expires_at: "2099-01-01T00:00:00Z" }] });
      }
      if (requestUrl.pathname === "/api/v1/notifications/me") return response({ total: 0, unread_total: 0, limit: 12, offset: 0, items: [] });
      return response({ total: 0, limit: 100, offset: 0, items: [] });
    }));

    const user = userEvent.setup();
    render(<Harness />);

    const organisation = await screen.findByRole("combobox", { name: "Organisation" });
    const location = screen.getByRole("combobox", { name: "Booking location" });
    await choose(user, location, "location-customer-a");
    const bookingAsset = screen.getByRole("combobox", { name: "Booking asset" });
    expect(bookingAsset).toHaveValue("");
    expect(screen.getByRole("button", { name: "Find availability" })).toBeDisabled();

    await choose(user, bookingAsset, "asset-customer-a");
    fireEvent.change(screen.getByLabelText("Preferred date"), { target: { value: "2026-10-25" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Find availability" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Find availability" }));
    expect(await screen.findByRole("radio")).toBeInTheDocument();

    await choose(user, organisation, "customer-b");
    expect(await screen.findByRole("heading", { name: "Request an inspection" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Booking location" })).toHaveValue("");
    expect(screen.queryByRole("radio")).toBeNull();
    await waitFor(() => expect(requested.some((value) => value.includes("customer_id=customer-b"))).toBe(true));
  });

  it("loads every customer record page and uses server metrics instead of a truncated asset page", async () => {
    const requested: string[] = [];
    const assets = Array.from({ length: 150 }, (_, index) => ({
      ...asset("customer-a"),
      id: `asset-${index + 1}`,
      asset_number: `ASSET-${index + 1}`
    }));
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url), "http://test");
      requested.push(requestUrl.toString());
      if (requestUrl.pathname === "/api/v1/customers") {
        return response({ total: 1, limit: 100, offset: 0, items: [{ ...customer("customer-a", "Customer A"), metrics: { asset_count: 150, in_service_count: 123 } }] });
      }
      if (requestUrl.pathname === "/api/v1/assets") {
        const offset = Number(requestUrl.searchParams.get("offset") ?? "0");
        return response({ total: 150, limit: 100, offset, items: assets.slice(offset, offset + 100) });
      }
      return response({ total: 0, limit: 100, offset: 0, items: [] });
    }));

    render(<WorkspaceHarness activeModule="dashboard" />);

    await screen.findByRole("button", { name: "View assets" });
    expect(screen.getByText("Assets").closest("article")).toHaveTextContent("150");
    expect(screen.getByText("In service").closest("article")).toHaveTextContent("123");
    await waitFor(() => expect(requested.some((value) => value.includes("/api/v1/assets") && value.includes("offset=100"))).toBe(true));
  });

  it("keeps approved booking location and assets fixed and renders the recorded site-local appointment", async () => {
    const booking = {
      id: "booking-1",
      customer: { id: "customer-a", code: "CUSTOMER-A", name: "Customer A" },
      location: { id: "location-customer-a", name: "Customer A Site", address_1: null, address_2: null, city: null, state: null, country: null, scheduling_timezone: "Australia/Sydney" },
      assets: [{ id: "asset-customer-a", asset_number: "ASSET-customer-a", tag: null, lifecycle_status: "IN_SERVICE" }],
      scheduled_at: "2027-10-04T00:00:00Z",
      scheduled_end_at: "2027-10-04T01:00:00Z",
      additional_information: null,
      status: "APPROVED",
      requested_by_user_id: "customer-user",
      inspector_user_id: "inspector-1",
      reviewed_by_user_id: "admin-1",
      reviewed_at: "2027-10-01T00:00:00Z",
      rejection_reason: null,
      created_at: "2027-10-01T00:00:00Z",
      appointment: {
        id: "appointment-1",
        status: "CONFIRMED",
        starts_at: "2027-10-04T00:00:00Z",
        ends_at: "2027-10-04T01:00:00Z",
        revision_number: 1,
        timezone_id: "Australia/Sydney",
        local_start_snapshot: "2027-10-04T11:00:00",
        local_end_snapshot: "2027-10-04T12:00:00",
        utc_offset_start: "+11:00",
        utc_offset_end: "+11:00",
        tzdata_version: "2026a"
      },
      change_requests: []
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url), "http://test");
      if (requestUrl.pathname === "/api/v1/customers") return response({ total: 1, limit: 100, offset: 0, items: [customer("customer-a", "Customer A")] });
      if (requestUrl.pathname === "/api/v1/assets") return response({ total: 1, limit: 100, offset: 0, items: [asset("customer-a")] });
      if (requestUrl.pathname === "/api/v1/inspection-bookings") return response({ total: 1, limit: 100, offset: 0, items: [booking] });
      if (requestUrl.pathname === "/api/v1/notifications/me") return response({ total: 0, unread_total: 0, limit: 100, offset: 0, items: [] });
      return response({ total: 0, limit: 100, offset: 0, items: [] });
    }));

    const user = userEvent.setup();
    render(<WorkspaceHarness activeModule="bookings" />);

    await screen.findByText(/Australia\/Sydney/);
    expect(screen.getByText(/11:00/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Request reschedule" }));
    expect(screen.getByRole("combobox", { name: "Booking location" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Booking asset" })).toBeDisabled();
  });
});

// --- final scheduling UX: availability, submission, history, hard dates ----------------

type Json = Record<string, unknown>;

function rawBooking(overrides: Json = {}, zone = "Australia/Sydney"): Json {
  return {
    id: "booking-1",
    customer: { id: "customer-a", code: "CUSTOMER-A", name: "Customer A" },
    location: { id: "location-customer-a", name: "Customer A Site", address_1: null, address_2: null, city: null, state: null, country: null, scheduling_timezone: zone },
    assets: [{ id: "asset-customer-a", asset_number: "ASSET-customer-a", tag: null, lifecycle_status: "IN_SERVICE" }],
    scheduled_at: "2027-10-04T00:00:00Z",
    scheduled_end_at: "2027-10-04T01:00:00Z",
    additional_information: null,
    status: "PENDING_APPROVAL",
    requested_by_user_id: "customer-user",
    inspector_user_id: null,
    reviewed_by_user_id: null,
    reviewed_at: null,
    rejection_reason: null,
    created_at: "2027-10-01T00:00:00Z",
    appointment: null,
    change_requests: [],
    ...overrides
  };
}

function confirmedAppointment(start: string, end: string, zone = "Australia/Sydney", offset = "+11:00"): Json {
  return {
    id: "appointment-1", status: "CONFIRMED", starts_at: "2027-10-04T00:00:00Z", ends_at: "2027-10-04T01:00:00Z",
    revision_number: 1, timezone_id: zone, local_start_snapshot: start, local_end_snapshot: end,
    utc_offset_start: offset, utc_offset_end: offset, tzdata_version: "2026a"
  };
}

function slot(id: string, start: string, end: string, expires = "2099-01-01T00:00:00Z"): Json {
  return { quote_id: id, starts_at: start, ends_at: end, expires_at: expires };
}

interface Stub {
  bookings: Json[];
  availability: Array<Json[] | number>;
  posts: Array<{ path: string; status: number }>;
  calls: string[];
  customerJson: Json;
  failBookingsFrom?: number;
  postDelayMs?: number;
  assetName?: string | null;
}

function stubPortal(options: Partial<Stub> = {}): Stub {
  const state: Stub = {
    bookings: [], availability: [], posts: [], calls: [], customerJson: customer("customer-a", "Customer A"), ...options
  };
  let bookingReads = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const requestUrl = new URL(String(url), "http://test");
    const path = requestUrl.pathname;
    state.calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/api/v1/customers") return response({ total: 1, limit: 100, offset: 0, items: [state.customerJson] });
    if (path === "/api/v1/assets") return response({ total: 1, limit: 100, offset: 0, items: [{ ...asset("customer-a"), asset_name: state.assetName ?? null }] });
    if (path === "/api/v1/inspection-availability") {
      const next = state.availability.shift();
      if (typeof next === "number") return new Response(JSON.stringify({ error: { code: "server", message: "Availability service unavailable" } }), { status: next });
      return response({ items: next ?? [] });
    }
    if (path === "/api/v1/inspection-bookings" && (init?.method ?? "GET") === "GET") {
      bookingReads += 1;
      if (state.failBookingsFrom && bookingReads >= state.failBookingsFrom) {
        return new Response(JSON.stringify({ error: { code: "server", message: "Bookings are temporarily unavailable" } }), { status: 503 });
      }
      return response({ total: state.bookings.length, limit: 100, offset: 0, items: state.bookings });
    }
    if (init?.method === "POST") {
      if (state.postDelayMs) await new Promise((resolve) => setTimeout(resolve, state.postDelayMs));
      const planned = state.posts.shift();
      if (planned && planned.status >= 400) {
        return new Response(JSON.stringify({ detail: "The selected availability is no longer valid. Choose another time." }), { status: planned.status });
      }
      return response(rawBooking({ status: "CANCELLED" }));
    }
    if (path === "/api/v1/notifications/me") return response({ total: 0, unread_total: 0, limit: 100, offset: 0, items: [] });
    return response({ total: 0, limit: 100, offset: 0, items: [] });
  }));
  return state;
}

function withZone(zone: string | null): Json {
  const base = customer("customer-a", "Customer A") as unknown as { locations: Array<Json> };
  return { ...base, locations: base.locations.map((location) => ({ ...location, scheduling_timezone: zone })) };
}

async function pickSlotSearch(user: ReturnType<typeof userEvent.setup>, date = "2027-10-04") {
  await choose(user, await screen.findByRole("combobox", { name: "Booking location" }), "location-customer-a");
  await choose(user, screen.getByRole("combobox", { name: "Booking asset" }), "asset-customer-a");
  fireEvent.change(screen.getByLabelText("Preferred date"), { target: { value: date } });
  await user.click(screen.getByRole("button", { name: "Find availability" }));
}

describe("availability selection", () => {
  it("says so when a date has no times, and when availability cannot be loaded, with a working retry", async () => {
    const stub = stubPortal({ customerJson: withZone("Australia/Sydney"), availability: [[], 503, [slot("q1", "2027-10-03T21:00:00Z", "2027-10-03T22:00:00Z")]] });
    const user = userEvent.setup();
    render(<WorkspaceHarness activeModule="bookings" />);
    await pickSlotSearch(user);
    expect(await screen.findByText(/No times are available on Monday 4 October 2027 at Customer A Site/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Find availability" }));
    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent(/Availability could not be loaded: Availability service unavailable/);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("radio")).toBeInTheDocument();
    expect(stub.calls.filter((call) => call.endsWith("inspection-availability"))).toHaveLength(3);
  });

  it("shows the site's time zone next to the times, whatever zone the browser is in", async () => {
    stubPortal({ customerJson: withZone("Australia/Perth"), availability: [[slot("q1", "2027-10-04T01:00:00Z", "2027-10-04T02:00:00Z")]] });
    const user = userEvent.setup();
    render(<WorkspaceHarness activeModule="bookings" />);
    await pickSlotSearch(user);
    const group = await screen.findByRole("group", { name: /Available times on Monday 4 October 2027/ });
    expect(group).toHaveTextContent("Australia/Perth");
    expect(within(group).getByText(/9:00\s?am to 10:00\s?am/i)).toBeInTheDocument(); // 01:00Z is 09:00 in Perth (UTC+8)
  });

  it("labels the two 2:30 times on a Sydney fall-back day by their offsets, and the spring-forward day without the missing hour", async () => {
    stubPortal({
      customerJson: withZone("Australia/Sydney"),
      availability: [[slot("q1", "2027-10-02T16:00:00Z", "2027-10-02T17:00:00Z")], [slot("q2", "2027-04-03T15:30:00Z", "2027-04-03T16:30:00Z")]]
    });
    const user = userEvent.setup();
    render(<WorkspaceHarness activeModule="bookings" />);
    await pickSlotSearch(user, "2027-10-03");
    // Clocks went forward at 2:00 am, so the first bookable hour after it is 3:00 am (AEDT).
    const spring = await screen.findByRole("group", { name: /Sunday 3 October 2027/ });
    expect(within(spring).getByText(/3:00\s?am to 4:00\s?am/i)).toBeInTheDocument();
    expect(spring).toHaveTextContent(/AEDT|GMT\+11/);

    fireEvent.change(screen.getByLabelText("Preferred date"), { target: { value: "2027-04-04" } });
    await user.click(screen.getByRole("button", { name: "Find availability" }));
    const fall = await screen.findByRole("group", { name: /Sunday 4 April 2027/ });
    // 2:30 happens twice that night: the label says which one this slot is.
    expect(within(fall).getByText(/2:30\s?am (AEDT|GMT\+11) to 2:30\s?am (AEST|GMT\+10)/i)).toBeInTheDocument();
  });

  it("shows what will be requested before it is sent, and clears the choice when the date changes", async () => {
    stubPortal({ customerJson: withZone("Australia/Sydney"), availability: [[slot("q1", "2027-10-03T21:00:00Z", "2027-10-03T22:00:00Z")]] });
    const user = userEvent.setup();
    render(<WorkspaceHarness activeModule="bookings" />);
    await pickSlotSearch(user);
    const submit = screen.getByRole("button", { name: "Submit booking request" });
    expect(submit).toBeDisabled();
    await user.click(await screen.findByRole("radio"));
    expect(submit).toBeEnabled();
    expect(screen.getByText(/You are requesting/)).toHaveTextContent(/Customer A Site.*ASSET-customer-a.*Monday 4 October 2027, 8:00\s?am to 9:00\s?am/i);

    fireEvent.change(screen.getByLabelText("Preferred date"), { target: { value: "2027-10-05" } });
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByText(/You are requesting/)).toBeNull();
    expect(submit).toBeDisabled();
  });

  // Expiry is driven by the page's clock, so the tests own that clock: the time to live is generous and the
  // test moves the clock past it, which no slow machine can get wrong.
  async function withClock(run: (user: ReturnType<typeof userEvent.setup>, expiresAt: string) => Promise<void>) {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
      await run(user, new Date(Date.now() + 60_000).toISOString());
    } finally {
      vi.useRealTimers();
    }
  }

  it("drops times that expire while on screen and asks for a fresh search", async () => {
    await withClock(async (user, expiresAt) => {
      stubPortal({ customerJson: withZone("Australia/Sydney"), availability: [[slot("q1", "2027-10-03T21:00:00Z", "2027-10-03T22:00:00Z", expiresAt)]] });
      render(<WorkspaceHarness activeModule="bookings" />);
      await pickSlotSearch(user);
      await user.click(await screen.findByRole("radio"));
      expect(screen.queryByText(/have expired/)).toBeNull();
      await act(async () => { vi.advanceTimersByTime(61_000); });
      expect(await screen.findByText(/have expired/)).toBeInTheDocument();
      expect(screen.queryByRole("radio")).toBeNull();
      expect(screen.getByRole("button", { name: "Submit booking request" })).toBeDisabled();
    });
  });

  it("drops expired times even when none was selected", async () => {
    await withClock(async (user, expiresAt) => {
      stubPortal({ customerJson: withZone("Australia/Sydney"), availability: [[slot("q1", "2027-10-03T21:00:00Z", "2027-10-03T22:00:00Z", expiresAt)]] });
      render(<WorkspaceHarness activeModule="bookings" />);
      await pickSlotSearch(user);
      expect(await screen.findByRole("radio")).toBeInTheDocument();
      await act(async () => { vi.advanceTimersByTime(61_000); });
      expect(await screen.findByText(/have expired/)).toBeInTheDocument();
      expect(screen.queryByRole("radio")).toBeNull();
    });
  });

  it("explains an empty organisation and a location with no assets", async () => {
    stubPortal({ customerJson: { ...(customer("customer-a", "Customer A") as object), locations: [] } });
    const first = render(<WorkspaceHarness activeModule="bookings" />);
    expect(await screen.findByText(/No approved locations are available/)).toBeInTheDocument();
    first.unmount();

    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url), "http://test").pathname;
      if (path === "/api/v1/customers") return response({ total: 1, limit: 100, offset: 0, items: [customer("customer-a", "Customer A")] });
      return response({ total: 0, limit: 100, offset: 0, items: [] });
    }));
    const user = userEvent.setup();
    render(<WorkspaceHarness activeModule="bookings" />);
    await choose(user, await screen.findByRole("combobox", { name: "Booking location" }), "location-customer-a");
    expect(screen.getByText(/No assets are assigned to this location/)).toBeInTheDocument();
  });
});

describe("submitting a booking", () => {
  it("sends it once even when the button is pressed twice, and confirms with a focused notice", async () => {
    const stub = stubPortal({ customerJson: withZone("Australia/Sydney"), availability: [[slot("q1", "2027-10-03T21:00:00Z", "2027-10-03T22:00:00Z")]], postDelayMs: 50 });
    const user = userEvent.setup();
    render(<WorkspaceHarness activeModule="bookings" />);
    await pickSlotSearch(user);
    await user.click(await screen.findByRole("radio"));
    const submit = screen.getByRole("button", { name: "Submit booking request" });
    // Two clicks before React can re-render: only a lock, not the disabled button, stops the second.
    act(() => {
      fireEvent.click(submit);
      fireEvent.click(submit);
    });
    const notice = await screen.findByText("Your inspection request was submitted for approval.");
    expect(stub.calls.filter((call) => call === "POST /api/v1/inspection-bookings")).toHaveLength(1);
    await waitFor(() => expect(notice).toHaveFocus());
    expect(screen.queryByRole("radio")).toBeNull(); // the form starts fresh
  });

  it.each([422, 409])("keeps the site, asset and date and demands fresh times when the server returns %i", async (status) => {
    stubPortal({
      customerJson: withZone("Australia/Sydney"),
      availability: [[slot("q1", "2027-10-03T21:00:00Z", "2027-10-03T22:00:00Z")]],
      posts: [{ path: "create", status }]
    });
    const user = userEvent.setup();
    render(<WorkspaceHarness activeModule="bookings" />);
    await pickSlotSearch(user);
    await user.click(await screen.findByRole("radio"));
    await user.click(screen.getByRole("button", { name: "Submit booking request" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/no longer available/);
    expect(alert).toHaveTextContent(/check availability again/);
    expect(screen.getByRole("combobox", { name: "Booking location" })).toHaveTextContent("Customer A Site");
    expect(screen.getByRole("combobox", { name: "Booking asset" })).toHaveValue("ASSET-customer-a");
    expect(screen.getByLabelText("Preferred date")).toHaveValue("2027-10-04");
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByRole("button", { name: "Submit booking request" })).toBeDisabled();
  });
});

describe("booking history", () => {
  it("uses plain wording for every state instead of backend codes", async () => {
    stubPortal({
      bookings: [
        rawBooking({ id: "b-pending" }),
        rawBooking({ id: "b-confirmed", status: "APPROVED", appointment: confirmedAppointment("2027-10-04T11:00:00", "2027-10-04T12:00:00") }),
        rawBooking({ id: "b-rejected", status: "REJECTED", rejection_reason: "No inspector is free that day." }),
        rawBooking({ id: "b-cancelled", status: "CANCELLED" })
      ]
    });
    render(<WorkspaceHarness activeModule="bookings" />);
    const list = await screen.findByRole("list");
    for (const label of ["Awaiting approval", "Confirmed", "Declined", "Cancelled"]) {
      expect(within(list).getByText(label)).toBeInTheDocument();
    }
    expect(list).not.toHaveTextContent(/PENDING_APPROVAL|APPROVED|REJECTED|CANCELLED/);
    expect(list).toHaveTextContent("Reason: No inspector is free that day.");
  });

  it("shows the recorded site-local time, including a visit that runs past midnight", async () => {
    stubPortal({
      bookings: [rawBooking({ status: "APPROVED", appointment: confirmedAppointment("2027-10-04T23:30:00", "2027-10-05T00:30:00") })]
    });
    render(<WorkspaceHarness activeModule="bookings" />);
    const card = (await screen.findByText(/Australia\/Sydney \(UTC\+11:00\)/)).closest("li") as HTMLElement;
    expect(card).toHaveTextContent(/Monday 4 October 2027, 11:30\s?pm to Tuesday 5 October 2027, 12:30\s?am/i);
  });

  it("shows a proposed new time before asking the customer to confirm it, then confirms it", async () => {
    const stub = stubPortal({
      bookings: [rawBooking({
        status: "APPROVED",
        appointment: confirmedAppointment("2027-10-04T11:00:00", "2027-10-04T12:00:00"),
        change_requests: [{ id: "change-1", status: "PENDING_CUSTOMER_CONFIRMATION", starts_at: "2027-10-05T00:00:00Z", ends_at: "2027-10-05T01:00:00Z", reason: "Site closed", emergency: false, created_at: "2027-10-01T00:00:00Z" }]
      })]
    });
    const user = userEvent.setup();
    render(<WorkspaceHarness activeModule="bookings" />);
    const proposal = await screen.findByText(/Proposed new time:/);
    expect(proposal).toHaveTextContent(/Tuesday 5 October 2027, 11:00\s?am/i);
    expect(screen.queryByRole("button", { name: "Request reschedule" })).toBeNull(); // one change at a time
    await user.click(screen.getByRole("button", { name: "Confirm new time" }));
    expect(await screen.findByText("The new time is confirmed.")).toBeInTheDocument();
    expect(stub.calls).toContain("POST /api/v1/inspection-booking-change-requests/change-1/confirm");
  });

  it("asks before cancelling, lets the customer back out, and refreshes when the booking has already changed", async () => {
    const stub = stubPortal({ bookings: [rawBooking()], posts: [{ path: "cancel", status: 409 }] });
    const user = userEvent.setup();
    render(<WorkspaceHarness activeModule="bookings" />);
    await user.click(await screen.findByRole("button", { name: "Cancel booking" }));
    expect(stub.calls.some((call) => call.endsWith("/cancel"))).toBe(false);
    await user.click(screen.getByRole("button", { name: "Keep booking" }));
    expect(screen.getByRole("button", { name: "Cancel booking" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel booking" }));
    const readsBefore = stub.calls.filter((call) => call === "GET /api/v1/inspection-bookings").length;
    await user.click(screen.getByRole("button", { name: "Yes, cancel this booking" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/has changed since you opened it, so nothing was cancelled/);
    await waitFor(() => expect(alert).toHaveFocus());
    await waitFor(() => expect(stub.calls.filter((call) => call === "GET /api/v1/inspection-bookings").length).toBeGreaterThan(readsBefore));
  });

  it("keeps the last loaded bookings, and says so, when a later refresh fails", async () => {
    const stub = stubPortal({ bookings: [rawBooking()], failBookingsFrom: 2 });
    const user = userEvent.setup();
    render(<WorkspaceHarness activeModule="bookings" />);
    await user.click(await screen.findByRole("button", { name: "Cancel booking" }));
    await user.click(screen.getByRole("button", { name: "Yes, cancel this booking" }));
    const banner = await screen.findByText(/could not be refreshed, so the last loaded data is shown/);
    expect(banner).toHaveTextContent("Bookings are temporarily unavailable");
    expect(screen.getByText("Customer A Site", { selector: "strong" })).toBeInTheDocument(); // not blanked
    expect(stub.calls).toContain("POST /api/v1/inspection-bookings/booking-1/cancel");
  });
});

describe("keyboard use and long names", () => {
  it("can book from the keyboard alone", async () => {
    stubPortal({ customerJson: withZone("Australia/Sydney"), availability: [[slot("q1", "2027-10-03T21:00:00Z", "2027-10-03T22:00:00Z")]] });
    const user = userEvent.setup();
    render(<WorkspaceHarness activeModule="bookings" />);
    const location = await screen.findByRole("combobox", { name: "Booking location" });
    await choose(user, location, "location-customer-a");
    await user.tab();
    expect(screen.getByRole("combobox", { name: "Booking asset" })).toHaveFocus();
    await choose(user, screen.getByRole("combobox", { name: "Booking asset" }), "asset-customer-a");
    fireEvent.change(screen.getByLabelText("Preferred date"), { target: { value: "2027-10-04" } });
    const find = screen.getByRole("button", { name: "Find availability" });
    find.focus();
    await user.keyboard("{Enter}");
    const radio = await screen.findByRole("radio");
    radio.focus();
    await user.keyboard(" ");
    expect(radio).toBeChecked();
    const submit = screen.getByRole("button", { name: "Submit booking request" });
    submit.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByText("Your inspection request was submitted for approval.")).toBeInTheDocument();
  });

  it("keeps very long location and asset names whole in the form and the history", async () => {
    const longName = "Port Botany Bulk Liquids Terminal Berth 4 Extended Operations Name With Many Words";
    const base = customer("customer-a", "Customer A") as unknown as { locations: Array<Json> };
    stubPortal({
      customerJson: { ...base, locations: base.locations.map((location) => ({ ...location, name: longName })) },
      bookings: [rawBooking({ location: { id: "location-customer-a", name: longName, address_1: null, address_2: null, city: null, state: null, country: null, scheduling_timezone: "Australia/Sydney" } })]
    });
    const user = userEvent.setup();
    render(<WorkspaceHarness activeModule="bookings" />);
    const list = await openList(user, await screen.findByRole("combobox", { name: "Booking location" }));
    expect(within(list).getByRole("option", { name: longName })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByText(longName, { selector: "strong" })).toBeInTheDocument();
  });
});

describe("asset identity and required fields", () => {
  const NAME = "Main Pump Discharge Hose";

  it("leads with the asset's name and keeps the HMS number beside it, in the picker, the summary and the history", async () => {
    stubPortal({
      customerJson: withZone("Australia/Sydney"),
      assetName: NAME,
      availability: [[slot("q1", "2027-10-03T21:00:00Z", "2027-10-03T22:00:00Z")]],
      bookings: [rawBooking()]
    });
    const user = userEvent.setup();
    render(<WorkspaceHarness activeModule="bookings" />);
    const label = `${NAME} — ASSET-customer-a`;
    const picker = await screen.findByRole("combobox", { name: "Booking asset" });
    await choose(user, await screen.findByRole("combobox", { name: "Booking location" }), "location-customer-a");
    const offered = await openList(user, picker);
    // The name leads and the number sits beside it, in that order.
    expect(within(offered).getByRole("option", { name: new RegExp(`^${NAME}.*ASSET-customer-a`) })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await choose(user, picker, "asset-customer-a");
    fireEvent.change(screen.getByLabelText("Preferred date"), { target: { value: "2027-10-04" } });
    await user.click(screen.getByRole("button", { name: "Find availability" }));
    await user.click(await screen.findByRole("radio"));
    expect(screen.getByText(/You are requesting/)).toHaveTextContent(label);

    const history = screen.getByRole("list");
    expect(within(history).getByText(`Assets: ${label}`)).toBeInTheDocument();
    expect(history.textContent!.indexOf(NAME)).toBeLessThan(history.textContent!.indexOf("ASSET-customer-a"));
  });

  it("falls back to the number alone when an asset has no name, or a booked asset is not in the loaded list", async () => {
    stubPortal({
      customerJson: withZone("Australia/Sydney"),
      bookings: [
        rawBooking({ id: "b-known" }),
        rawBooking({ id: "b-unknown", assets: [{ id: "asset-elsewhere", asset_number: "ASSET-elsewhere", tag: null, lifecycle_status: "IN_SERVICE" }] })
      ]
    });
    const user = userEvent.setup();
    render(<WorkspaceHarness activeModule="bookings" />);
    expect(await screen.findByText("Assets: ASSET-customer-a")).toBeInTheDocument();
    expect(screen.getByText("Assets: ASSET-elsewhere")).toBeInTheDocument();
    await choose(user, await screen.findByRole("combobox", { name: "Booking location" }), "location-customer-a");
    const offered = await openList(user, screen.getByRole("combobox", { name: "Booking asset" }));
    expect(within(offered).getByRole("option", { name: "ASSET-customer-a" })).toBeInTheDocument();
  });

  it("marks location, asset and date as required, visibly and to assistive technology", async () => {
    stubPortal({ customerJson: withZone("Australia/Sydney") });
    render(<WorkspaceHarness activeModule="bookings" />);
    for (const name of ["Booking location", "Booking asset", "Preferred date"]) {
      const field = await screen.findByLabelText(name);
      expect(field).toBeRequired();
      expect(field).toHaveAttribute("aria-required", "true");
      expect(field.closest("label")).toHaveTextContent("*");
    }
    expect(screen.getByText("Required fields", { exact: false })).toHaveTextContent("* Required fields");
    expect(screen.getByLabelText("Notes (optional)")).not.toBeRequired();
  });
});

describe("asset and company identity in the portal", () => {
  function stubApi(assetBody: Record<string, unknown>[]) {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url), "http://test").pathname;
      if (path === "/api/v1/customers") {
        return response({ total: 1, limit: 100, offset: 0, items: [customer("customer-a", "XERO PTY Ltd")] });
      }
      if (path === "/api/v1/assets") return response({ total: assetBody.length, limit: 100, offset: 0, items: assetBody });
      return response({ total: 0, limit: 100, offset: 0, items: [] });
    }));
  }
  function Assets({ assetId = null }: { assetId?: string | null }) {
    return <CustomerPortalWorkspace activeModule="assets" assetId={assetId} customerId="customer-a" onAssetChange={vi.fn()} onCustomerChange={vi.fn()} onModuleChange={vi.fn()} session={session} />;
  }

  it("shows the company's initials, hidden from assistive technology, beside its full name", async () => {
    stubApi([]);
    render(<Assets />);
    const header = (await screen.findByText("Customer workspace")).closest("header") as HTMLElement;
    expect(within(header).getByText("XP")).toHaveAttribute("aria-hidden", "true");
    expect(within(header).getByText("XERO PTY Ltd")).toBeInTheDocument();
    // The signed-in person is not the company: the footer still names them.
    expect(screen.getByText("Signed in as Customer User.")).toBeInTheDocument();
  });

  it("lists assets by name with the number underneath, and finds them by either", async () => {
    const user = userEvent.setup();
    stubApi([
      { ...asset("customer-a"), asset_name: "Main Transfer Hose" },
      { ...asset("customer-a"), id: "asset-2", asset_number: "ASSET-2", asset_name: null }
    ]);
    render(<Assets />);
    const named = (await screen.findByText("Main Transfer Hose")).closest("button") as HTMLElement;
    expect(within(named).getByText("Asset #ASSET-customer-a")).toBeInTheDocument();
    // No name: the number is the label, once.
    expect(screen.getAllByText("ASSET-2")).toHaveLength(1);

    const search = screen.getByLabelText("Search assets");
    await user.type(search, "transfer");
    expect(screen.getByText("Main Transfer Hose")).toBeInTheDocument();
    expect(screen.queryByText("ASSET-2")).toBeNull();
    await user.clear(search);
    await user.type(search, "ASSET-2");
    expect(screen.getByText("ASSET-2")).toBeInTheDocument();
    expect(screen.queryByText("Main Transfer Hose")).toBeNull();
  });

  it("titles the asset page with its name and keeps the number beside the product", async () => {
    stubApi([{ ...asset("customer-a"), asset_name: "Main Transfer Hose" }]);
    render(<Assets assetId="asset-customer-a" />);
    expect(await screen.findByRole("heading", { name: "Main Transfer Hose" })).toBeInTheDocument();
    expect(screen.getByText(/Asset #ASSET-customer-a · Product/)).toBeInTheDocument();
  });
});
