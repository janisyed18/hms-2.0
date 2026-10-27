import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "../App";
import { mockBootstrapResponse } from "../data/mockSync";
import { resetDefaultSyncStore } from "../offline/syncStore";
import { withChangeFeed } from "../test/syncFetch";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  };
}

const wire = (id: string, patch: Record<string, unknown> = {}) => ({
  id, event_ref: "e", category: "INSPECTION_SUBMITTED", tier: "IMPORTANT", channel: "IN_APP",
  subject: `Subject ${id}`, body: `Body ${id}`, customer_id: null, asset_id: null,
  subject_type: null, subject_id: null, created_at: "2026-07-17T09:00:00Z", read_at: null as string | null, ...patch
});

function install(feed: Array<ReturnType<typeof wire>>) {
  const posts: string[] = [];
  let bootstraps = 0;
  const fetchMock = vi.fn(withChangeFeed(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url), "http://test").pathname;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (path === "/api/v1/sync/bootstrap") {
      bootstraps += 1;
      return json(mockBootstrapResponse);
    }
    if (path === "/api/v1/notifications/me") {
      return json({ total: feed.length, unread_total: feed.filter((n) => !n.read_at).length, items: feed });
    }
    if (path === "/api/v1/notifications/me/read-all" && init?.method === "POST") {
      posts.push("read-all");
      feed.forEach((n) => { n.read_at = "2026-07-17T10:00:00Z"; });
      return json({ updated: feed.length, unread_total: 0 });
    }
    const read = path.match(/^\/api\/v1\/notifications\/([^/]+)\/read$/);
    if (read && init?.method === "POST") {
      posts.push(read[1]);
      const found = feed.find((n) => n.id === read[1]);
      if (found) found.read_at = "2026-07-17T10:00:00Z";
      return json(found);
    }
    return new Response("Not found", { status: 404 });
  }));
  vi.stubGlobal("fetch", fetchMock);
  return { posts, bootstraps: () => bootstraps };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  resetDefaultSyncStore();
  vi.stubGlobal("localStorage", memoryStorage());
});

const bell = () => screen.findByRole("button", { name: /^Notifications/ });

describe("the Inspector's notification bell", () => {
  it("shows the exact unread count and lists the newest, with unknown categories rendered safely", async () => {
    install([wire("n1"), wire("n2", { category: "A_NEW_CATEGORY", subject: null }), wire("n3", { read_at: "2026-07-17T09:30:00Z" })]);
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await user.click(await screen.findByRole("button", { name: "Notifications, 2 unread" }));
    const panel = screen.getByRole("dialog", { name: "Notifications" });
    expect(within(panel).getAllByRole("button", { name: /^Open/ })).toHaveLength(3);
    expect(within(panel).getByText("A new category")).toBeInTheDocument();
    expect(within(panel).getAllByText(/Unread/).length).toBeGreaterThan(0);
  });

  it("is an empty state when there is nothing", async () => {
    install([]);
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await user.click(await bell());
    expect(await screen.findByText("You are all caught up.")).toBeInTheDocument();
  });

  it("reads a notification on the server, then opens the assignment it is about", async () => {
    const { posts } = install([wire("n1", { asset_id: "asset-0891", subject_type: "inspection", subject_id: "i1" })]);
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await screen.findByRole("button", { name: /open HOS-2024-0891/i });
    await user.click(await bell());
    await user.click(screen.getByRole("button", { name: "Open unread notification Subject n1" }));
    await waitFor(() => expect(posts).toEqual(["n1"]));
    expect(await screen.findByRole("heading", { name: "HOS-2024-0891" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
  });

  it("lands safely in Work, and refreshes assignments, when it holds no such assignment", async () => {
    const { bootstraps } = install([wire("n1", { asset_id: "asset-not-ours" })]);
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await screen.findByRole("button", { name: /open HOS-2024-0891/i });
    const before = bootstraps();
    await user.click(await bell());
    await user.click(screen.getByRole("button", { name: /Open unread notification/ }));
    await waitFor(() => expect(bootstraps()).toBeGreaterThan(before));
    expect(await screen.findByLabelText("Work queue")).toBeInTheDocument();
  });

  it("marks all read in one call", async () => {
    const { posts } = install([wire("n1"), wire("n2"), wire("n3")]);
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await user.click(await screen.findByRole("button", { name: "Notifications, 3 unread" }));
    await user.click(screen.getByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument());
    expect(posts).toEqual(["read-all"]);
  });

  it("offline: the last list stays, nothing is marked read, and a notification still opens", async () => {
    const { posts } = install([wire("n1", { asset_id: "asset-0891" })]);
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await user.click(await screen.findByRole("button", { name: "Notifications, 1 unread" }));
    await user.keyboard("{Escape}");
    fireEvent(window, new Event("offline"));
    await user.click(screen.getByRole("button", { name: "Notifications, 1 unread" }));
    const panel = screen.getByRole("dialog", { name: "Notifications" });
    expect(within(panel).getByRole("status")).toHaveTextContent(/offline/i);
    expect(within(panel).getByRole("button", { name: "Mark all read" })).toBeDisabled();
    await user.click(within(panel).getByRole("button", { name: /Open unread notification/ }));
    expect(posts).toEqual([]); // the server was never told
    expect(await screen.findByRole("heading", { name: "HOS-2024-0891" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Notifications, 1 unread" })).toBeInTheDocument(); // still unread
  });

  it("closes with Escape and returns focus to the bell, and works from the keyboard", async () => {
    install([wire("n1")]);
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    const trigger = await screen.findByRole("button", { name: "Notifications, 1 unread" });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Notifications" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("asks before it abandons an unsaved capture", async () => {
    install([wire("n1", { asset_id: "asset-0201" })]);
    const user = userEvent.setup();
    render(<App initialAccessToken="test-access-token" />);
    await user.click(await screen.findByRole("button", { name: /open HOS-2024-0891/i }));
    await user.type(screen.getByLabelText("Asset tag"), "EDITED");
    await user.click(await bell());
    await user.click(screen.getByRole("button", { name: /Open unread notification/ }));
    expect(await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" })).toBeInTheDocument();
  });
});
