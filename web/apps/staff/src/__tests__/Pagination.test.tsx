import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

import { PaginationControls, usePagination } from "../components/Pagination";

function PaginatedRows() {
  const [items] = useState(() => Array.from({ length: 7 }, (_, index) => `Record ${index + 1}`));
  const pagination = usePagination(items);
  return (
    <>
      <ul>{pagination.items.map((item) => <li key={item}>{item}</li>)}</ul>
      <PaginationControls
        label="Test records"
        onPageChange={pagination.setPage}
        onPageSizeChange={pagination.setPageSize}
        page={pagination.page}
        pageCount={pagination.pageCount}
        pageSize={pagination.pageSize}
        start={pagination.start}
        total={pagination.total}
      />
    </>
  );
}

describe("shared pagination", () => {
  it("keeps the page controls visible for a single-page list", () => {
    render(
      <PaginationControls
        label="Single record list"
        onPageChange={() => undefined}
        onPageSizeChange={() => undefined}
        page={1}
        pageCount={1}
        pageSize={5}
        start={0}
        total={1}
      />
    );

    expect(screen.getByLabelText("Single record list rows per page")).toBeVisible();
    expect(screen.getByText("Page 1 of 1")).toBeVisible();
    expect(screen.getByText("1-1 of 1")).toBeVisible();
  });

  it("moves through records and returns to the first page when the page size changes", async () => {
    const user = userEvent.setup();
    render(<PaginatedRows />);

    expect(screen.getByText("Record 1")).toBeVisible();
    expect(screen.queryByText("Record 6")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next Test records page" }));
    expect(screen.getByText("Record 6")).toBeVisible();

    await user.selectOptions(screen.getByLabelText("Test records rows per page"), "10");
    expect(screen.getByText("Record 1")).toBeVisible();
    expect(screen.getByText("Record 7")).toBeVisible();
  });
});
