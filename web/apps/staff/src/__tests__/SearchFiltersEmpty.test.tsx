import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { CustomerTable } from "../components/CustomerTable";
import { ModuleTable, activeFilterList, resultSummary } from "../components/ModuleTable";
import type { CustomerRecord } from "../domain/types";

interface Row { id: string; name: string; status: string }
const ROWS: Row[] = [
  { id: "1", name: "Alpha hose", status: "IN_SERVICE" },
  { id: "2", name: "Beta hose", status: "DUE" },
  { id: "3", name: "Gamma hose", status: "IN_SERVICE" }
];

function Table({ rows = ROWS, canAdd = true, total, loaded }: { rows?: Row[]; canAdd?: boolean; total?: number; loaded?: number }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("ALL");
  const onAdd = vi.fn();
  const items = rows.filter((row) => (status === "ALL" || row.status === status) && row.name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <ModuleTable
      actionLabel={canAdd ? "Add widget" : undefined}
      activeFilters={activeFilterList([{ id: "status", label: "Status", value: status !== "ALL" && status.replace("_", " ").toLowerCase(), onRemove: () => setStatus("ALL") }])}
      columns={[{ header: "Name", render: (row) => row.name }]}
      countLabel={`${rows.length} widgets`}
      emptyHint="Widgets appear here once they are added."
      emptyLabel="No widgets."
      exportRows={(row) => [row.name]}
      filterControls={<button onClick={() => setStatus("DUE")} type="button">Only due</button>}
      getRowKey={(row) => row.id}
      items={items}
      loadedCount={loaded ?? rows.length}
      noun="widgets"
      onAction={canAdd ? onAdd : undefined}
      onClearFilters={() => setStatus("ALL")}
      onQueryChange={setQuery}
      query={query}
      searchLabel="Search widgets"
      searchPlaceholder="Search widgets by name"
      tableLabel="Widget records"
      totalCount={total}
    />
  );
}

describe("search", () => {
  it("says what it searches, clears in one click and gives focus back to the box", async () => {
    const user = userEvent.setup();
    render(<Table />);
    const box = screen.getByRole("textbox", { name: "Search widgets" });
    expect(box).toHaveAttribute("placeholder", "Search widgets by name");
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull(); // nothing to clear yet
    await user.type(box, "beta");
    expect(screen.getAllByRole("row")).toHaveLength(2); // header + Beta
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(box).toHaveValue("");
    expect(box).toHaveFocus();
    expect(screen.getAllByRole("row")).toHaveLength(4);
  });
});

describe("active filters", () => {
  it("shows each filter that is on, takes one off, and clears them all", async () => {
    const user = userEvent.setup();
    render(<Table />);
    expect(screen.queryByRole("group", { name: "Active filters" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.click(screen.getByRole("button", { name: "Only due" }));
    const chips = screen.getByRole("group", { name: "Active filters" });
    expect(chips).toHaveTextContent("Status: due");
    expect(chips).toHaveTextContent("1 filter active");
    expect(screen.getByText("1 matching widgets")).toBeInTheDocument();
    await user.click(within(chips).getByRole("button", { name: "Remove filter Status: due" }));
    expect(screen.queryByRole("group", { name: "Active filters" })).toBeNull();
    expect(screen.getByText("3 widgets")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Only due" }));
    await user.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.queryByRole("group", { name: "Active filters" })).toBeNull();
  });

  it("the chip's remove button is reachable and operable from the keyboard", async () => {
    const user = userEvent.setup();
    render(<Table />);
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.click(screen.getByRole("button", { name: "Only due" }));
    screen.getByRole("button", { name: "Remove filter Status: due" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("group", { name: "Active filters" })).toBeNull();
  });
});

describe("empty versus no match", () => {
  it("a list with nothing in it says so, and offers the add action only to someone who may add", () => {
    const { unmount } = render(<Table rows={[]} />);
    expect(screen.getByText("No widgets yet")).toBeInTheDocument();
    // The one add button is the toolbar's; the message points at it instead of repeating it.
    expect(screen.getByText(/Widgets appear here once they are added\. Use "Add widget" above to add the first\./)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Add widget" })).toHaveLength(1);
    unmount();
    render(<Table canAdd={false} rows={[]} />);
    expect(screen.getByText("No widgets yet")).toBeInTheDocument();
    expect(screen.getByText("Widgets appear here once they are added.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add widget" })).toBeNull();
  });

  it("a search that finds nothing is a different message, with a way back", async () => {
    const user = userEvent.setup();
    render(<Table />);
    await user.type(screen.getByRole("textbox", { name: "Search widgets" }), "zzz");
    expect(screen.getByText("No matching widgets")).toBeInTheDocument();
    expect(screen.getByText("Try a different search.")).toBeInTheDocument();
    expect(screen.queryByText("No widgets yet")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("textbox", { name: "Search widgets" })).toHaveValue("");
    expect(screen.getAllByRole("row")).toHaveLength(4);
  });

  it("when a filter is the cause, the message names the filters and clearing them restores the list", async () => {
    const user = userEvent.setup();
    render(<Table rows={[ROWS[0]]} />);
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.click(screen.getByRole("button", { name: "Only due" }));
    expect(screen.getByText("No matching widgets")).toBeInTheDocument();
    expect(screen.getByText("Try changing your search or clearing one of the active filters.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("Alpha hose")).toBeInTheDocument();
  });
});

describe("counts never claim more than the page holds", () => {
  it.each([
    [{ fallback: "3 widgets", narrowed: false, noun: "widgets", shown: 3 }, "3 widgets"],
    [{ fallback: "3 widgets", narrowed: false, noun: "widgets", shown: 3, loadedCount: 3, totalCount: 3 }, "3 widgets"],
    [{ fallback: "50 widgets", narrowed: false, noun: "widgets", shown: 50, loadedCount: 50, totalCount: 130 }, "50 of 130 widgets loaded"],
    [{ fallback: "50 widgets", narrowed: true, noun: "widgets", shown: 8, loadedCount: 50, totalCount: 50 }, "8 matching widgets"],
    [{ fallback: "50 widgets", narrowed: true, noun: "widgets", shown: 8, loadedCount: 50, totalCount: 130 }, "8 matching widgets (searching the 50 of 130 loaded)"]
  ])("%j", (input, expected) => {
    expect(resultSummary(input)).toBe(expected);
  });

  it("a partly loaded list says so", () => {
    render(<Table loaded={3} total={130} />);
    expect(screen.getByText("3 of 130 widgets loaded")).toBeInTheDocument();
  });
});

const customer = (id: string, name: string, status: string, risk: string) => ({
  id, code: id.toUpperCase(), name, notes: null, locations: [], contacts: [], status, riskLevel: risk,
  metrics: { assetCount: 0, inServiceCount: 0 }
}) as unknown as CustomerRecord;

describe("the Customers list", () => {
  function Customers({ list, canWrite = true }: { list: CustomerRecord[]; canWrite?: boolean }) {
    const [query, setQuery] = useState("");
    const [status, setStatus] = useState("All");
    const [risk, setRisk] = useState("All");
    const shown = list.filter((item) => (status === "All" || item.status === status) && (risk === "All" || item.riskLevel === risk) && item.name.toLowerCase().includes(query.toLowerCase()));
    return (
      <CustomerTable allCustomers={list} canWrite={canWrite} customers={shown} onAddCustomer={() => undefined}
        onQueryChange={setQuery} onRiskFilterChange={setRisk} onSelectCustomer={() => undefined} onStatusFilterChange={setStatus}
        query={query} riskFilter={risk} selectedId={null} statusFilter={status} totalCount={list.length} />
    );
  }

  it("clears its search, and tells no customers yet from no match", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Customers list={[]} />);
    expect(screen.getByText("No customers yet")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Add customer" })).toHaveLength(1);
    unmount();

    render(<Customers list={[customer("a", "Xero Pty Ltd", "Active", "Low")]} />);
    const box = screen.getByRole("textbox", { name: "Search customers" });
    expect(box).toHaveAttribute("placeholder", "Search customers by name, code or city");
    await user.type(box, "zzz");
    expect(screen.getByText("No matching customers")).toBeInTheDocument();
    expect(screen.getByText("0 matching customers")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByRole("button", { name: /Select customer Xero Pty Ltd/ })).toBeInTheDocument();
  });

  it("no one without write access is offered Add customer from an empty list", () => {
    render(<Customers canWrite={false} list={[]} />);
    expect(screen.getByText("No customers yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add customer" })).toBeNull();
    expect(screen.queryByText(/Use "Add customer"/)).toBeNull();
  });
});
