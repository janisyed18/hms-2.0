import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NotificationItem } from "../domain/types";

const api = {
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn()
};
vi.mock("../api/syncClient", () => ({ createSyncClient: () => api }));

import {
  NOTIFICATION_POLL_MS,
  useInspectorNotifications
} from "../notifications/useInspectorNotifications";

const item = (id: string, patch: Partial<NotificationItem> = {}): NotificationItem => ({
  id, category: "INSPECTION_SUBMITTED", subject: `S ${id}`, body: "B", assetId: null, customerId: null,
  subjectType: null, subjectId: null, createdAt: "2026-07-17T09:00:00Z", readAt: null, ...patch
});
const setVisibility = (state: "visible" | "hidden") =>
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });

beforeEach(() => {
  vi.useFakeTimers();
  api.listNotifications.mockReset().mockResolvedValue({ total: 2, unreadTotal: 2, items: [item("a"), item("b")] });
  api.markNotificationRead.mockReset().mockImplementation(async (id: string) => item(id, { readAt: "2026-07-17T09:30:00Z" }));
  api.markAllNotificationsRead.mockReset().mockResolvedValue({ updated: 2, unreadTotal: 0 });
});
afterEach(() => {
  setVisibility("visible");
  vi.useRealTimers();
});

const mount = (isOnline = true) =>
  renderHook(({ online }) => useInspectorNotifications({ isOnline: online, userId: "inspector-1" }), {
    initialProps: { online: isOnline }
  });
const settle = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("inspector notifications", () => {
  it("loads once online, keeps an exact unread count, and polls", async () => {
    const { result } = mount();
    await settle();
    expect(result.current.unreadTotal).toBe(2);
    await settle(NOTIFICATION_POLL_MS);
    expect(api.listNotifications).toHaveBeenCalledTimes(2);
  });

  it("makes no request while offline, keeps what it has, and refreshes on reconnect", async () => {
    const { result, rerender } = mount();
    await settle();
    rerender({ online: false });
    await settle(NOTIFICATION_POLL_MS * 3);
    expect(api.listNotifications).toHaveBeenCalledTimes(1);
    expect(result.current.items).toHaveLength(2); // the cached list stays visible
    rerender({ online: true });
    await settle();
    expect(api.listNotifications).toHaveBeenCalledTimes(2);
  });

  it("does not pretend an item was read while offline", async () => {
    const { result, rerender } = mount();
    await settle();
    rerender({ online: false });
    let ok = true;
    await act(async () => { ok = await result.current.markRead(result.current.items[0]); });
    expect(ok).toBe(false);
    let all = true;
    await act(async () => { all = await result.current.markAllRead(); });
    expect(all).toBe(false);
    expect(api.markNotificationRead).not.toHaveBeenCalled();
    expect(api.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(result.current.unreadTotal).toBe(2);
    expect(result.current.items.every((entry) => entry.readAt === null)).toBe(true);
  });

  it("never overlaps requests, and pauses while hidden", async () => {
    let release: () => void = () => undefined;
    api.listNotifications.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ total: 0, unreadTotal: 0, items: [] });
    }));
    mount();
    await settle(NOTIFICATION_POLL_MS * 3);
    expect(api.listNotifications).toHaveBeenCalledTimes(1);
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });
    setVisibility("hidden");
    await settle(NOTIFICATION_POLL_MS * 4);
    expect(api.listNotifications).toHaveBeenCalledTimes(1);
  });

  it("keeps the list through a failed refresh", async () => {
    const { result } = mount();
    await settle();
    api.listNotifications.mockRejectedValue(new Error("503"));
    await settle(NOTIFICATION_POLL_MS);
    expect(result.current.items).toHaveLength(2);
    expect(result.current.status).toBe("ready");
    expect(result.current.error).toMatch(/could not be refreshed/);
  });

  it("marks one read, then all read in one call", async () => {
    const { result } = mount();
    await settle();
    await act(async () => { await result.current.markRead(result.current.items[0]); });
    expect(result.current.unreadTotal).toBe(1);
    api.markAllNotificationsRead.mockResolvedValue({ updated: 1, unreadTotal: 2 }); // the server's count wins
    await act(async () => { await result.current.markAllRead(); });
    expect(api.markAllNotificationsRead).toHaveBeenCalledTimes(1);
    expect(result.current.unreadTotal).toBe(2);
    expect(result.current.items.every((entry) => entry.readAt)).toBe(true);
  });

  it("leaves it unread when the server refuses", async () => {
    api.markNotificationRead.mockRejectedValue(new Error("500"));
    const { result } = mount();
    await settle();
    await act(async () => { await result.current.markRead(result.current.items[0]); });
    expect(result.current.unreadTotal).toBe(2);
    expect(result.current.error).toMatch(/could not be marked as read/);
  });
});
