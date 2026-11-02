import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AssetForm } from "../components/AssetForm";
import { CertificateForm } from "../components/CertificateForm";
import { ProductForm } from "../components/ProductForm";
import { UserAdminDialog } from "../components/UserAdminDialog";
import type { AssetRecord, ProductRecord } from "../domain/types";
import { choose } from "../test/choose";
import { lookups, resetLookups } from "../test/lookupClient";

vi.mock("../api/hmsClient", async (original) => {
  const actual = await original<typeof import("../api/hmsClient")>();
  const { lookupClient } = await import("../test/lookupClient");
  return { ...actual, createHmsClient: (options?: Parameters<typeof actual.createHmsClient>[0]) => ({ ...actual.createHmsClient(options), ...lookupClient }) };
});

const noEnd = { fitting: "", size: "", nominalBore: null, material: null, coupling: null, couplingAddOn: null, attachMethod: null };
const options = { materials: [], couplings: [], couplingAddOns: [], attachMethods: [], nominalBores: [] };
const alpha = { id: "c-alpha", code: "ALP", name: "Alpha Marine" };
const beta = { id: "c-beta", code: "BET", name: "Beta Fuels" };
const hoseA = { id: "p-a", code: "HOSE-A", name: "Aviation hose", category: "Hose" };
const hoseB = { id: "p-b", code: "HOSE-B", name: "Bunkering hose", category: "Hose" };

function assetForm(overrides: Partial<React.ComponentProps<typeof AssetForm>> = {}) {
  return { asset: null, configurationOptions: options, open: true, onClose: vi.fn(), onSubmit: vi.fn().mockResolvedValue(undefined), ...overrides } as React.ComponentProps<typeof AssetForm>;
}

/** The same lists in a different order: if index 0 ever decided a value, one of the two orders would show it. */
const orders = [
  ["natural order", <T,>(items: T[]) => items],
  ["reversed order", <T,>(items: T[]) => [...items].reverse()]
] as const;

describe.each(orders)("Add Asset starts empty (%s)", (_label, arrange) => {
  beforeEach(() => {
    resetLookups();
    lookups.customers = arrange([alpha, beta]);
    lookups.products = arrange([hoseA, hoseB]);
    lookups.locations = { "c-alpha": arrange([{ id: "l-1", name: "Dock 1" }, { id: "l-2", name: "Dock 2" }]), "c-beta": [{ id: "l-3", name: "Only site" }] };
  });

  it("selects no customer, location or product, and says so", () => {
    render(<AssetForm {...assetForm()} />);
    expect(screen.getByLabelText("Customer")).toHaveValue("");
    expect(screen.getByLabelText("Customer")).toHaveAttribute("placeholder", "Select a customer");
    expect(screen.getByLabelText("Product")).toHaveValue("");
    expect(screen.getByLabelText("Product")).toHaveAttribute("placeholder", "Select a product");
    expect(screen.getByLabelText("Location")).toBeDisabled();
    expect(screen.getByLabelText("Location")).toHaveTextContent("Select a customer first");
  });

  it("does not choose a location for the customer, not even when it has only one", async () => {
    const user = userEvent.setup();
    render(<AssetForm {...assetForm()} />);
    await choose(user, screen.getByLabelText("Customer"), "c-beta");
    await waitFor(() => expect(screen.getByLabelText("Location")).toBeEnabled());
    expect(screen.getByLabelText("Location")).toHaveTextContent("Select a location");
  });

  it("clears the location when the customer changes and never picks another", async () => {
    const user = userEvent.setup();
    render(<AssetForm {...assetForm()} />);
    await choose(user, screen.getByLabelText("Customer"), "c-alpha");
    await waitFor(() => expect(screen.getByLabelText("Location")).toBeEnabled());
    await choose(user, screen.getByLabelText("Location"), "l-2");
    expect(screen.getByLabelText("Location")).toHaveTextContent("Dock 2");

    await choose(user, screen.getByLabelText("Customer"), "c-beta");
    await waitFor(() => expect(screen.getByLabelText("Location")).toHaveTextContent("Select a location"));
    expect(screen.getByLabelText("Location")).not.toHaveTextContent("Only site");
  });

  it("will not save until the three relationships are chosen on purpose", async () => {
    const user = userEvent.setup();
    const props = assetForm();
    render(<AssetForm {...props} />);
    fireEvent.change(screen.getByLabelText("Asset Name"), { target: { value: "Boom hose" } });
    fireEvent.change(screen.getByLabelText("Serial Number"), { target: { value: "SN-1" } });
    await user.click(screen.getByRole("button", { name: "Save asset" }));
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Customer")).toHaveAccessibleDescription("Select a customer.");
    expect(screen.getByLabelText("Product")).toHaveAccessibleDescription("Select a product.");
  });
});

describe("Add Asset reaches records beyond the old list limit", () => {
  beforeEach(() => {
    resetLookups();
    lookups.customers = Array.from({ length: 300 }, (_, index) => ({ id: `c-${index}`, code: `C${index}`, name: `Customer ${String(index).padStart(3, "0")}` }));
    lookups.products = Array.from({ length: 300 }, (_, index) => ({ id: `p-${index}`, code: `P${index}`, name: `Product ${String(index).padStart(3, "0")}`, category: "Hose" }));
    lookups.locations = { "c-299": [{ id: "l-far", name: "Far depot" }] };
  });

  it("finds customer 299 and product 299 by searching, and loads that customer's locations", async () => {
    const user = userEvent.setup();
    const props = assetForm();
    render(<AssetForm {...props} />);

    const customer = screen.getByLabelText("Customer");
    await user.click(customer);
    await user.type(customer, "Customer 299");
    await user.click(await screen.findByRole("option", { name: /Customer 299/ }));
    expect(customer).toHaveValue("Customer 299");

    await waitFor(() => expect(screen.getByLabelText("Location")).toBeEnabled());
    await choose(user, screen.getByLabelText("Location"), "l-far");

    const product = screen.getByLabelText("Product");
    await user.click(product);
    await user.type(product, "Product 299");
    await user.click(await screen.findByRole("option", { name: /Product 299/ }));

    fireEvent.change(screen.getByLabelText("Asset Name"), { target: { value: "Far hose" } });
    fireEvent.change(screen.getByLabelText("Serial Number"), { target: { value: "SN-299" } });
    await user.click(screen.getByRole("button", { name: "Save asset" }));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ customerId: "c-299", locationId: "l-far", productId: "p-299" })));
    // Searching asked the server by name; nothing relied on a first page of 50 or 100.
    expect(lookups.calls.some((call) => call.method === "listCustomers" && (call.options as { search?: string }).search === "Customer 299")).toBe(true);
  });
});

describe("Edit asset keeps its relationships", () => {
  it("shows the saved customer, location and product, and changes none of them on its own", async () => {
    resetLookups();
    lookups.customers = [beta, alpha];
    lookups.products = [hoseB, hoseA];
    lookups.locations = { "c-alpha": [{ id: "l-1", name: "Dock 1" }, { id: "l-2", name: "Dock 2" }] };
    const record = {
      id: "a1", assetNumber: "A-1", assetName: "Existing", customerSerialNo: "SN", purchaseOrderNumber: null, tag: null,
      lifecycleStatus: "ACTIVE", manufactureDate: null, installationDate: null, graveDate: null, nextRetestDueAt: null,
      condemnedAt: null, lengthM: null, notes: null, description: null, customer: alpha, product: hoseA,
      location: { id: "l-2", name: "Dock 2" }, retestSchedule: null, aEnd: noEnd, bEnd: noEnd, inspectionHistory: [], certificateHistory: [], etag: "e"
    } as unknown as AssetRecord;
    const props = assetForm({ asset: record });
    render(<AssetForm {...props} />);
    expect(screen.getByLabelText("Customer")).toHaveValue("Alpha Marine");
    expect(screen.getByLabelText("Product")).toHaveValue("Aviation hose");
    await waitFor(() => expect(screen.getByLabelText("Location")).toHaveTextContent("Dock 2"));
    await userEvent.setup().click(screen.getByRole("button", { name: "Save asset" }));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ customerId: "c-alpha", locationId: "l-2", productId: "p-a" })));
  });
});

describe("Add User and Certificate start empty in any option order", () => {
  it("never lets the first listed role decide", async () => {
    for (const actorRoles of [["SUPER_ADMIN"], ["HMS_ADMIN"]] as const) {
      const { unmount } = render(<UserAdminDialog open mode="create" actorRoles={[...actorRoles]} customers={[]} onSubmit={vi.fn()} onClose={vi.fn()} />);
      expect(screen.getByLabelText("Role")).toHaveTextContent("Select a role");
      unmount();
    }
  });

  it.each(orders)("keeps the certificate's inspection and number unset (%s)", async (_label, arrange) => {
    resetLookups();
    lookups.inspections = arrange([
      { id: "i-1", name: "A-1", asset: { assetNumber: "A-1", assetName: "One" }, customer: { name: "Alpha" } },
      { id: "i-2", name: "A-2", asset: { assetNumber: "A-2", assetName: "Two" }, customer: { name: "Beta" } }
    ]);
    render(<CertificateForm onClose={vi.fn()} onSubmit={vi.fn()} open />);
    expect(screen.getByLabelText("Approved inspection")).toHaveValue("");
    expect((screen.getByLabelText("Certificate number") as HTMLInputElement).value).toBe("");
    const user = userEvent.setup();
    await choose(user, screen.getByLabelText("Approved inspection"), "i-2");
    expect((screen.getByLabelText("Certificate number") as HTMLInputElement).value).toBe("CERT-A-2-1");
  });
});

describe("Product Standard", () => {
  const product: ProductRecord = { id: "p1", code: "HOSE", name: "Hose", category: "Fuel", subCategory: null, standardId: "std-2", standardCode: "EN853", enabled: true, etag: "e1" };

  beforeEach(() => {
    resetLookups();
    // The current standard is deliberately not first, and a disabled one still must be shown for this product.
    lookups.standards = [
      { id: "std-1", code: "AS2683", name: "AS 2683", enabled: true },
      { id: "std-2", code: "EN853", name: "Hydraulic standard", enabled: false }
    ];
  });

  it("shows the product's current standard when editing", async () => {
    render(<ProductForm open product={product} onClose={vi.fn()} onSubmit={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText("Standard")).toHaveValue("EN853 - Hydraulic standard"));
  });

  it("submits the standard unchanged when another field is edited, never null", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ProductForm open product={product} onClose={vi.fn()} onSubmit={onSubmit} />);
    await waitFor(() => expect(screen.getByLabelText("Standard")).toHaveValue("EN853 - Hydraulic standard"));
    await user.type(screen.getByLabelText("Product name"), " mk2");
    await user.click(screen.getByRole("button", { name: "Save product" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ name: "Hose mk2", standardId: "std-2" })));
  });

  it("clears the standard only when the person chooses No standard", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ProductForm open product={product} onClose={vi.fn()} onSubmit={onSubmit} />);
    await waitFor(() => expect(screen.getByLabelText("Standard")).toHaveValue("EN853 - Hydraulic standard"));
    await choose(user, screen.getByLabelText("Standard"), "");
    await user.click(screen.getByRole("button", { name: "Save product" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ standardId: null })));
  });

  it("does not pretend to edit pressure ratings", () => {
    render(<ProductForm open product={product} onClose={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.queryByText("Pressure ratings")).toBeNull();
    expect(screen.queryByRole("button", { name: /rating/i })).toBeNull();
  });
});
