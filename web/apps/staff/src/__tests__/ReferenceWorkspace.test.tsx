import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ReferenceWorkspace } from "../components/ReferenceWorkspace";

const client = {
  archiveReferenceCatalogItem: vi.fn().mockResolvedValue(undefined),
  createReferenceCatalogItem: vi.fn().mockResolvedValue({
    id: "material-2",
    code: "CARBON_STEEL",
    name: "Carbon steel"
  }),
  listReferenceCatalog: vi.fn((category: string) =>
    Promise.resolve({
      total: 1,
      etag: '"catalog-1"',
      items: [{
        id: `${category}-1`,
        code: category === "materials" ? "COMPOSITE" : "AS2683",
        name: category === "materials" ? "Composite" : "AS 2683",
        etag: '"catalog-1"'
      }]
    })
  ),
  updateReferenceCatalogItem: vi.fn()
};

vi.mock("../api/hmsClient", () => ({
  createHmsClient: () => client,
  loadReferenceStandardsWithFallback: () =>
    Promise.resolve({
      source: "api",
      total: 1,
      items: [{ id: "standard-1", code: "AS2683", name: "AS 2683", etag: '"catalog-1"' }]
    })
}));

describe("ReferenceWorkspace", () => {
  it("loads a category and saves a new controlled catalog item", async () => {
    const user = userEvent.setup();
    render(<ReferenceWorkspace canManage />);

    await user.click(await screen.findByRole("tab", { name: "Materials" }));
    expect(await screen.findByText("Composite")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add Material" }));
    await user.type(screen.getByLabelText("Material code"), "carbon_steel");
    await user.type(screen.getByLabelText("Material name"), "Carbon steel");
    await user.click(screen.getByRole("button", { name: "Save material" }));

    await waitFor(() => {
      expect(client.createReferenceCatalogItem).toHaveBeenCalledWith("materials", {
        code: "CARBON_STEEL",
        name: "Carbon steel"
      });
    });
    expect(await screen.findByText("Carbon steel")).toBeInTheDocument();
  });
});
