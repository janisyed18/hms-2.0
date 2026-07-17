import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HmsApp } from "../App";
import { MotionProvider } from "../motion/MotionProvider";
import type { StaffSession } from "../domain/types";

const inspectorSession: StaffSession = {
  userId: "inspector-1",
  displayName: "Taylor Inspector",
  roles: ["INSPECTOR"],
  permissions: [],
  customerIds: [],
  authMode: "bearer"
};

function dashboardFetch() {
  return vi.fn(async (url: string | URL | Request) => {
    const requestUrl = new URL(String(url), "http://test");
    if (requestUrl.pathname !== "/api/v1/dashboard") {
      throw new Error(`Unhandled URL: ${requestUrl.pathname}`);
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        total_assets: 0,
        total_customers: 0,
        in_service_assets: 0,
        due_soon_assets: 0,
        overdue_assets: 0,
        awaiting_review_inspections: 0,
        overdue_total: 0,
        overdue_limit: 5,
        overdue_offset: 0,
        overdue_retests: [],
        due_this_week: [],
        awaiting_review: []
      })
    };
  });
}

function renderShell() {
  vi.stubGlobal("fetch", dashboardFetch());
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn()
  }));

  return render(
    <MotionProvider>
      <HmsApp session={inspectorSession} />
    </MotionProvider>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Command Centre shell", () => {
  it("shows only the modules authorized by visibleModules", async () => {
    renderShell();

    await screen.findByRole("heading", { name: "Overdue Retests" });

    expect(screen.getByRole("button", { name: "Dashboard" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Assets" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Inspections" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Analytics" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Users & Roles" })).not.toBeInTheDocument();
  });

  it("opens the mobile drawer and closes it with Escape or its backdrop", async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole("button", { name: "Open navigation menu" }));
    const drawer = screen.getByRole("dialog", { name: "Navigation menu" });
    expect(drawer).toBeVisible();
    expect(within(drawer).getByRole("textbox", { name: "Search assets and customers" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Navigation menu" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open navigation menu" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Open navigation menu" }));
    await user.click(screen.getByRole("button", { name: "Close navigation menu" }));
    expect(screen.queryByRole("dialog", { name: "Navigation menu" })).not.toBeInTheDocument();
  });

  it("closes the drawer and exposes selected module content without animation timing", async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole("button", { name: "Open navigation menu" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Navigation menu" })).getByRole(
        "button",
        { name: "Assets" }
      )
    );

    expect(screen.queryByRole("dialog", { name: "Navigation menu" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Asset Register" })).toBeVisible();
  });
});
