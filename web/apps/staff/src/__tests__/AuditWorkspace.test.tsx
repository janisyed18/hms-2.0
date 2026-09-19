import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AuditWorkspace } from "../components/AuditWorkspace";

const client = {
  listAuditEvents: vi.fn().mockResolvedValue({
    total: 2,
    etag: '"audit-1"',
    items: [
      { sequence: 2, action: "asset.updated", actorId: "admin-1", entity: "asset", entityId: "997950", before: null, after: null, timestamp: "2026-09-19T10:00:00Z", hash: "abcdef1234567890" },
      { sequence: 1, action: "auth.login", actorId: "admin-2", entity: "user", entityId: "admin-2", before: null, after: null, timestamp: "2026-09-18T10:00:00Z", hash: "123456abcdef7890" }
    ]
  })
};

vi.mock("../api/hmsClient", () => ({
  createHmsClient: () => client,
  HmsApiError: class HmsApiError extends Error {}
}));

describe("AuditWorkspace", () => {
  it("filters immutable events without replacing live records", async () => {
    const user = userEvent.setup();
    render(<AuditWorkspace />);

    const table = await screen.findByRole("table", { name: "Audit trail events" });
    expect(within(table).getByText("Asset updated")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Audit record type"), "asset");

    expect(within(table).getByText("Asset updated")).toBeInTheDocument();
    expect(within(table).queryByText("Auth login")).not.toBeInTheDocument();
  });
});
