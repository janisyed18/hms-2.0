import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../App";

describe("App", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the premium staff customer workspace with mock fallback data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Customers" })).toBeVisible();
    expect(screen.getByText("Live Environment")).toBeVisible();
    expect(screen.getByText("45 customers")).toBeVisible();
    expect(screen.getByRole("row", { name: /North Sea Drilling Ltd./i })).toBeVisible();
    expect(screen.getByRole("complementary", { name: /Customer detail/i })).toHaveTextContent(
      "North Sea Drilling Ltd."
    );
  });

  it("updates the selected customer from the table", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("row", { name: /Bluewater Energy/i }));

    expect(screen.getByRole("complementary", { name: /Customer detail/i })).toHaveTextContent(
      "Bluewater Energy"
    );
  });

  it("filters customer rows from the toolbar search", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.type(await screen.findByLabelText("Search customers"), "arctic");

    await waitFor(() => {
      const table = screen.getByRole("table", { name: "Customer records" });
      expect(within(table).getByText("Arctic Offshore AS")).toBeVisible();
      expect(within(table).queryByText("North Sea Drilling Ltd.")).not.toBeInTheDocument();
    });
  });

  it("creates a local customer record when using mock data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: /Add Customer/i }));
    await user.type(screen.getByLabelText("Customer name"), "Summit Marine Group");
    await user.type(screen.getByLabelText("Customer code"), "SMG");
    await user.click(screen.getByRole("button", { name: "Save customer" }));

    expect(await screen.findByRole("row", { name: /Summit Marine Group/i })).toBeVisible();
    expect(screen.getByRole("complementary", { name: /Customer detail/i })).toHaveTextContent(
      "Summit Marine Group"
    );
  });

  it("clears the customer filter when a local customer is created", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();

    render(<App />);

    await user.type(await screen.findByLabelText("Search customers"), "arctic");
    await user.click(screen.getByRole("button", { name: /Add Customer/i }));
    await user.type(screen.getByLabelText("Customer name"), "Summit Marine Group");
    await user.type(screen.getByLabelText("Customer code"), "SMG");
    await user.click(screen.getByRole("button", { name: "Save customer" }));

    expect(await screen.findByRole("row", { name: /Summit Marine Group/i })).toBeVisible();
    expect(screen.getByLabelText("Search customers")).toHaveValue("");
  });
});
