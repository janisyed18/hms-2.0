import { act, renderHook, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HmsApp } from "../App";
import type { NotificationRecord, StaffSession } from "../domain/types";
import { NotificationsPage } from "../notifications/NotificationsPage";
import { exactTime, presentCategory, relativeTime } from "../notifications/presentation";
import { notificationTarget } from "../notifications/target";
import { NOTIFICATION_POLL_MS, useNotificationFeed } from "../notifications/useNotificationFeed";

const record = (id: string, patch: Partial<NotificationRecord> = {}): NotificationRecord => ({
  id, category: "INSPECTION_SUBMITTED", tier: "IMPORTANT", subject: `Subject ${id}`, body: `Body ${id}`,
  customerId: null, assetId: null, subjectType: null, subjectId: null,
  createdAt: "2026-07-17T09:00:00Z", readAt: null, ...patch
});

describe("presentation", () => {
  it("words a known category and falls back safely for an unknown one", () => {
    expect(presentCategory("CERTIFICATE_ISSUED")).toMatchObject({ icon: "certificate", title: "Certificate issued" });
    expect(presentCategory("SOMETHING_NEW_LATER")).toEqual({ icon: "general", title: "Something new later", action: "Open" });
    expect(presentCategory("")).toMatchObject({ icon: "general", title: "Update" });
  });
  it("reads times without ever printing Invalid Date", () => {
    const now = new Date("2026-07-17T09:05:00Z").getTime();
    expect(relativeTime("2026-07-17T09:00:00Z", now)).toMatch(/5 minutes ago/);
    expect(relativeTime("2026-07-17T09:04:50Z", now)).toBe("just now");
    expect(relativeTime("nonsense", now)).toBe("recently");
    expect(exactTime("nonsense")).toBe("Time unknown");
    expect(exactTime("2026-07-17T09:00:00Z")).not.toMatch(/Invalid/);
  });
});

describe("where a notification goes", () => {
  const n = (patch: Partial<NotificationRecord>) => notificationTarget(record("x", patch), "staff");
  it("follows the ids it carries, not its category", () => {
    expect(n({ category: "ANYTHING", subjectType: "inspection", subjectId: "i1" })).toEqual({ module: "inspections", inspectionId: "i1" });
    expect(n({ subjectType: "asset", subjectId: "a1" })).toEqual({ module: "assets", assetId: "a1" });
    expect(n({ subjectType: "inspection_booking", subjectId: "b1" })).toEqual({ module: "scheduling" });
    expect(n({ subjectType: "certificate", subjectId: "c1" })).toEqual({ module: "certificates" });
  });
  it("uses the portal's own workspaces", () => {
    const portal = (patch: Partial<NotificationRecord>) => notificationTarget(record("x", patch), "portal");
    expect(portal({ subjectType: "inspection_booking" })).toEqual({ module: "bookings" });
    expect(portal({ subjectType: "inspection", subjectId: "i1" })).toEqual({ module: "inspections", inspectionId: "i1" });
    expect(portal({ subjectType: "device" })).toBeNull(); // a customer has no device workspace
    expect(portal({ customerId: "c1" })).toBeNull();
  });
  it("falls back to the linked asset or customer, and to nowhere", () => {
    expect(n({ assetId: "a9" })).toEqual({ module: "assets", assetId: "a9" });
    expect(n({ customerId: "c9" })).toEqual({ module: "customers", customerId: "c9" });
    expect(n({ subjectType: "unheard_of", subjectId: "z" })).toBeNull();
  });
});

describe("the feed", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const feedClient = (overrides: Record<string, unknown> = {}) => ({
    listNotifications: vi.fn().mockResolvedValue({ total: 2, unreadTotal: 2, items: [record("a"), record("b")] }),
    markNotificationRead: vi.fn(async (id: string) => record(id, { readAt: "2026-07-17T09:10:00Z" })),
    markAllNotificationsRead: vi.fn().mockResolvedValue({ updated: 2, unreadTotal: 0 }),
    ...overrides
  });
  const setVisibility = (state: "visible" | "hidden") =>
    Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  afterEach(() => setVisibility("visible"));

  it("loads at once, shows the exact unread count, and polls on a timer", async () => {
    const client = feedClient();
    const { result } = renderHook(() => useNotificationFeed({ client }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.items).toHaveLength(2);
    expect(result.current.unreadTotal).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(NOTIFICATION_POLL_MS); });
    expect(client.listNotifications).toHaveBeenCalledTimes(2);
  });

  it("never runs two requests at once", async () => {
    let release: () => void = () => undefined;
    const client = feedClient({
      listNotifications: vi.fn(() => new Promise((resolve) => {
        release = () => resolve({ total: 0, unreadTotal: 0, items: [] });
      }))
    });
    renderHook(() => useNotificationFeed({ client }));
    await act(async () => { await vi.advanceTimersByTimeAsync(NOTIFICATION_POLL_MS * 3); });
    expect(client.listNotifications).toHaveBeenCalledTimes(1); // the first is still in flight
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });
  });

  it("does not poll while the page is hidden, and catches up when it is shown again", async () => {
    const client = feedClient();
    renderHook(() => useNotificationFeed({ client }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    setVisibility("hidden");
    await act(async () => { await vi.advanceTimersByTimeAsync(NOTIFICATION_POLL_MS * 4); });
    expect(client.listNotifications).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(client.listNotifications).toHaveBeenCalledTimes(2);
  });

  it("keeps the list on screen when a refresh fails, and says so", async () => {
    const client = feedClient();
    const { result } = renderHook(() => useNotificationFeed({ client }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    client.listNotifications.mockRejectedValue(new Error("503"));
    await act(async () => { await vi.advanceTimersByTimeAsync(NOTIFICATION_POLL_MS); });
    expect(result.current.items).toHaveLength(2);
    expect(result.current.unreadTotal).toBe(2);
    expect(result.current.status).toBe("ready");
    expect(result.current.error).toMatch(/could not be refreshed/);
    client.listNotifications.mockResolvedValue({ total: 2, unreadTotal: 1, items: [record("a"), record("b")] });
    await act(async () => { await vi.advanceTimersByTimeAsync(NOTIFICATION_POLL_MS); });
    expect(result.current.error).toBeNull();
    expect(result.current.unreadTotal).toBe(1);
  });

  it("reports a first failure as an error with nothing shown", async () => {
    const client = feedClient({ listNotifications: vi.fn().mockRejectedValue(new Error("down")) });
    const { result } = renderHook(() => useNotificationFeed({ client }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toMatch(/could not be loaded/);
  });

  it("marks one read on the server first, and a read one is not sent again", async () => {
    const client = feedClient();
    const { result } = renderHook(() => useNotificationFeed({ client }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await result.current.markRead(result.current.items[0]); });
    expect(client.markNotificationRead).toHaveBeenCalledTimes(1);
    expect(result.current.unreadTotal).toBe(1);
    await act(async () => { await result.current.markRead(result.current.items[0]); });
    expect(client.markNotificationRead).toHaveBeenCalledTimes(1); // already read: nothing to do
    expect(result.current.unreadTotal).toBe(1);
  });

  it("leaves a notification unread when the server refuses", async () => {
    const client = feedClient({ markNotificationRead: vi.fn().mockRejectedValue(new Error("500")) });
    const { result } = renderHook(() => useNotificationFeed({ client }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    let ok = true;
    await act(async () => { ok = await result.current.markRead(result.current.items[0]); });
    expect(ok).toBe(false);
    expect(result.current.unreadTotal).toBe(2);
    expect(result.current.items[0].readAt).toBeNull();
  });

  it("marks everything read with one call, taking the count from the server", async () => {
    // One more unread remains somewhere the server did not touch (another organisation's feed).
    const client = feedClient({ markAllNotificationsRead: vi.fn().mockResolvedValue({ updated: 2, unreadTotal: 1 }) });
    const { result } = renderHook(() => useNotificationFeed({ client, customerId: "c1" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await result.current.markAllRead(); });
    expect(client.markAllNotificationsRead).toHaveBeenCalledTimes(1);
    expect(client.markAllNotificationsRead).toHaveBeenCalledWith({ customerId: "c1" });
    expect(client.markNotificationRead).not.toHaveBeenCalled();
    expect(result.current.unreadTotal).toBe(1);
    expect(result.current.items.every((item) => item.readAt !== null)).toBe(true);
  });

  it("asks for nothing until an organisation is chosen", async () => {
    const client = feedClient();
    const { result } = renderHook(() => useNotificationFeed({ client, customerId: null }));
    await act(async () => { await vi.advanceTimersByTimeAsync(NOTIFICATION_POLL_MS); });
    expect(client.listNotifications).not.toHaveBeenCalled();
    expect(result.current.status).toBe("ready");
    expect(result.current.items).toEqual([]);
  });
});

function json(body: unknown) {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) };
}
const adminSession: StaffSession = {
  userId: "admin-1", displayName: "Sam Admin", roles: ["SUPER_ADMIN"], permissions: [], customerIds: [], authMode: "dev"
};
function api(feed: Array<Record<string, unknown>>) {
  const posts: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url), "http://test");
    if (u.pathname === "/api/v1/notifications/me") {
      return json({ total: feed.length, unread_total: feed.filter((n) => !n.read_at).length, limit: 12, offset: 0, items: feed });
    }
    if (u.pathname === "/api/v1/notifications/me/read-all" && init?.method === "POST") {
      posts.push("read-all");
      feed.forEach((n) => { n.read_at = "2026-07-17T10:00:00Z"; });
      return json({ updated: feed.length, unread_total: 0 });
    }
    const read = u.pathname.match(/^\/api\/v1\/notifications\/([^/]+)\/read$/);
    if (read && init?.method === "POST") {
      posts.push(read[1]);
      const found = feed.find((n) => n.id === read[1]);
      if (found) found.read_at = "2026-07-17T10:00:00Z";
      return json(found);
    }
    return json({ total: 0, limit: 50, offset: 0, items: [] });
  });
  return { fetchMock, posts };
}
const wire = (patch: Record<string, unknown>) => ({
  id: "n1", event_ref: "e", category: "INSPECTION_SUBMITTED", tier: "IMPORTANT", channel: "IN_APP", recipient_type: "USER",
  recipient_id: "admin-1", recipient_address: null, subject: "Inspection awaiting review", body: "Ready for review.",
  status: "SENT", attempts: 1, provider_message_id: null, error: null, customer_id: null, asset_id: null,
  subject_type: null, subject_id: null, created_at: "2026-07-17T09:00:00Z", sent_at: null, read_at: null, ...patch
});

describe("the bell in the Staff shell", () => {
  beforeEach(() => window.history.replaceState(null, "", "/?view=dashboard"));
  afterEach(() => vi.unstubAllGlobals());

  it("shows the unread count to everyone, and opens an inspection notification on its record", async () => {
    const { fetchMock, posts } = api([wire({ id: "n1", subject_type: "inspection", subject_id: "insp-42" })]);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<HmsApp session={adminSession} />);
    const bell = await screen.findByRole("button", { name: "Notifications, 1 unread" });
    await user.click(bell);
    const panel = screen.getByRole("dialog", { name: "Notifications" });
    await user.click(within(panel).getByRole("button", { name: "Open unread notification Inspection awaiting review" }));
    await waitFor(() => expect(posts).toEqual(["n1"]));
    await waitFor(() => expect(window.location.search).toContain("view=inspections"));
    expect(window.location.search).toContain("inspection=insp-42");
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
  });

  it("marks all read in one call and closes with Escape, returning focus to the bell", async () => {
    const { fetchMock, posts } = api([wire({ id: "n1" }), wire({ id: "n2" }), wire({ id: "n3" })]);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<HmsApp session={adminSession} />);
    await user.click(await screen.findByRole("button", { name: "Notifications, 3 unread" }));
    const panel = screen.getByRole("dialog", { name: "Notifications" });
    await user.click(within(panel).getByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument());
    expect(posts).toEqual(["read-all"]); // not one call per notification
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    expect(screen.getByRole("button", { name: "Notifications" })).toHaveFocus();
  });

  it("opens from the keyboard and renders an unknown category without crashing", async () => {
    const { fetchMock } = api([wire({ id: "n1", category: "A_BRAND_NEW_EVENT", subject: null, body: "Something happened." })]);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<HmsApp session={adminSession} />);
    const bell = await screen.findByRole("button", { name: /^Notifications/ });
    bell.focus();
    await user.keyboard("{Enter}");
    const panel = screen.getByRole("dialog", { name: "Notifications" });
    expect(within(panel).getByText("A brand new event")).toBeInTheDocument();
    expect(within(panel).getByText("Something happened.")).toBeInTheDocument();
  });

  it("has a page that lists everything, with an exact timestamp for assistive technology", async () => {
    const { fetchMock } = api([wire({ id: "n1" }), wire({ id: "n2", read_at: "2026-07-17T09:30:00Z" })]);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<HmsApp session={adminSession} />);
    await user.click(await screen.findByRole("button", { name: /^Notifications/ }));
    await user.click(within(screen.getByRole("dialog", { name: "Notifications" })).getByRole("button", { name: "View all notifications" }));
    expect(await screen.findByRole("region", { name: "All notifications" })).toBeInTheDocument();
    expect(window.location.search).toContain("view=notifications");
    const page = screen.getByRole("region", { name: "All notifications" });
    await user.click(within(page).getByRole("button", { name: /^Unread/ }));
    expect(within(page).getAllByRole("button", { name: /^Open/ })).toHaveLength(1);
    expect(page.querySelector("time")?.getAttribute("title")).toBeTruthy();
  });
});

describe("the full page", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("asks for older notifications by raising the limit", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const u = new URL(String(url), "http://test");
      seen.push(u.search);
      const limit = Number(u.searchParams.get("limit"));
      const items = Array.from({ length: limit }, (_, i) => wire({ id: `n${i}` }));
      return json({ total: 200, unread_total: limit, limit, offset: 0, items });
    }));
    const user = userEvent.setup();
    render(<NotificationsPage onOpen={vi.fn()} />);
    await screen.findAllByRole("button", { name: /^Open/ });
    await user.click(screen.getByRole("button", { name: "Show older notifications" }));
    await waitFor(() => expect(seen.some((s) => s.includes("limit=100"))).toBe(true));
  });
  it("shows an empty feed as caught up", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ total: 0, unread_total: 0, limit: 50, offset: 0, items: [] })));
    render(<NotificationsPage onOpen={vi.fn()} />);
    expect(await screen.findByText("You are all caught up.")).toBeInTheDocument();
  });
});
