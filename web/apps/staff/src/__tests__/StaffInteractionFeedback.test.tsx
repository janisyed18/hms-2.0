import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HmsApiError } from "../api/hmsClient";
import { AssetsWorkspace } from "../components/AssetsWorkspace";
import { CustomerForm } from "../components/CustomerForm";
import { ProductsWorkspace } from "../components/ProductsWorkspace";
import type { AssetRecord, ProductRecord } from "../domain/types";

const client = vi.hoisted(() => ({
  listAssets: vi.fn(),
  listCustomers: vi.fn(),
  listProducts: vi.fn(),
  getAssetConfigurationOptions: vi.fn(),
  createAsset: vi.fn(),
  updateAsset: vi.fn(),
  archiveAsset: vi.fn(),
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  archiveProduct: vi.fn()
}));

vi.mock("../api/hmsClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/hmsClient")>()),
  createHmsClient: () => client
}));

const blankEnd = { fitting: "", size: "", nominalBore: null, material: null, coupling: null, couplingAddOn: null, attachMethod: null };
const customer = {
  id: "cust-1", code: "ORIC", name: "Orica", notes: null,
  locations: [{ id: "loc-1", name: "Kooragang", siteContactName: null, siteContactMobile: null, siteContactEmail: null, ppeRequirements: [], additionalRequirements: [] }]
};
const product = { id: "prod-1", code: "PROD-014", name: "Hydraulic Hose", category: "Hose", subCategory: null, standardCode: null, etag: "p1" } as unknown as ProductRecord;
const asset = {
  id: "asset-1", assetNumber: "HMS-001842", assetName: "Main Pump Hose", customerSerialNo: "SN-1", purchaseOrderNumber: null, tag: null,
  lifecycleStatus: "IN_SERVICE", nextRetestDueAt: null, notes: null, description: null, etag: "a1", lengthM: null,
  customer: { id: "cust-1", code: "ORIC", name: "Orica" },
  product: { id: "prod-1", code: "PROD-014", name: "Hydraulic Hose", category: "Hose" },
  location: { id: "loc-1", name: "Kooragang", address1: null, address2: null, city: null, state: null, country: null },
  aEnd: blankEnd, bEnd: blankEnd
} as unknown as AssetRecord;

// Focus moves in a deferred step after render; a loaded CI runner can take longer than waitFor's 1s default.
const FOCUS_WAIT = { timeout: 5000 };
const api = (status: number, message: string, details: unknown = null) => new HmsApiError(status, "code", message, details);

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  client.listAssets.mockResolvedValue({ total: 1, etag: null, items: [asset] });
  client.listCustomers.mockResolvedValue({ total: 1, etag: null, items: [customer] });
  client.listProducts.mockResolvedValue({ total: 1, etag: null, items: [product] });
  client.getAssetConfigurationOptions.mockResolvedValue({ materials: [], couplings: [], couplingAddOns: [], attachMethods: [], nominalBores: [] });
});
afterEach(() => vi.useRealTimers());

async function openAddAsset() {
  const user = userEvent.setup();
  render(<AssetsWorkspace canWrite />);
  await screen.findByText("Main Pump Hose");
  await user.click(screen.getByRole("button", { name: "Add Asset" }));
  await screen.findByRole("heading", { name: "Add Asset" });
  return user;
}

async function fillAsset(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Asset Name"), "Boom Hose");
  await user.type(screen.getByLabelText("Serial Number"), "SN-77");
}

describe("Asset form", () => {
  it("marks Agent, Location, Asset Name, Serial Number and Product as required, visibly and semantically, and nothing else", async () => {
    await openAddAsset();
    for (const name of ["Agent", "Location", "Asset Name", "Serial Number", "Product"]) {
      const field = screen.getByLabelText(name);
      expect(field).toBeRequired();
      expect(field).toHaveAttribute("aria-required", "true");
      expect(field.closest("label")!.querySelector(".required-mark")).toHaveAttribute("aria-hidden", "true");
    }
    expect(screen.getByText("Required fields", { exact: false })).toHaveTextContent("* Required fields");
    expect(screen.getByLabelText("Notes")).not.toBeRequired();
    expect(screen.getByLabelText("Purchase Order Number")).not.toBeRequired();
  });

  it("shows each missing field inline, focuses the first, keeps the other values and sends nothing", async () => {
    const user = await openAddAsset();
    await user.type(screen.getByLabelText("Serial Number"), "SN-77");
    await user.click(screen.getByRole("button", { name: "Save asset" }));

    const name = screen.getByLabelText("Asset Name");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription("Enter an asset name.");
    await waitFor(() => expect(name).toHaveFocus(), FOCUS_WAIT);
    expect(screen.getByLabelText("Serial Number")).toHaveValue("SN-77");
    expect(screen.getByLabelText("Serial Number")).not.toHaveAttribute("aria-invalid");
    expect(client.createAsset).not.toHaveBeenCalled();

    await user.type(name, "B");
    expect(name).not.toHaveAttribute("aria-invalid"); // clears as it is fixed
  });

  it("shows a server rejection, keeps the drawer open with every value, and explains it in plain words", async () => {
    client.createAsset.mockRejectedValue(api(409, "Serial number is already assigned to another asset."));
    const user = await openAddAsset();
    await fillAsset(user);
    await user.click(screen.getByRole("button", { name: "Save asset" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Asset could not be saved");
    expect(alert).toHaveTextContent("Serial number is already assigned to another asset.");
    // The form moves focus to the notice in a deferred step after rendering it.
    await waitFor(() => expect(alert).toHaveFocus(), FOCUS_WAIT);
    expect(screen.getByRole("heading", { name: "Add Asset" })).toBeInTheDocument();
    expect(screen.getByLabelText("Asset Name")).toHaveValue("Boom Hose");
    expect(screen.getByLabelText("Serial Number")).toHaveValue("SN-77");
    expect(screen.queryByText(/saved successfully/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Save asset" })).toBeEnabled();
  });

  it("puts a field-level server error on the field and focuses it", async () => {
    client.createAsset.mockRejectedValue(api(422, "HMS API request failed: 422", [{ loc: ["body", "customer_serial_no"], msg: "Field required", type: "missing" }]));
    const user = await openAddAsset();
    await fillAsset(user);
    await user.click(screen.getByRole("button", { name: "Save asset" }));

    const serial = screen.getByLabelText("Serial Number");
    await waitFor(() => expect(serial).toHaveFocus(), FOCUS_WAIT);
    expect(serial).toHaveAttribute("aria-invalid", "true");
    expect(serial).toHaveAccessibleDescription("This field is required.");
  });

  it.each([
    ["a server fault", api(500, "psycopg.errors.UniqueViolation: duplicate key value violates unique constraint \"assets_pkey\""), /service is unavailable/i],
    ["a lost connection", new TypeError("Failed to fetch"), /could not be reached/i],
    ["missing permission", api(403, "Missing permission: asset:write"), /do not have permission/i],
    ["rate limiting", api(429, "Too many", { retryAfterSeconds: 30 }), /try again in 30 seconds/i]
  ])("turns %s into a safe message and keeps the values", async (_label, failure, expected) => {
    client.createAsset.mockRejectedValue(failure);
    const user = await openAddAsset();
    await fillAsset(user);
    await user.click(screen.getByRole("button", { name: "Save asset" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(expected);
    expect(alert.textContent).not.toMatch(/psycopg|UniqueViolation|assets_pkey|Missing permission:/);
    expect(screen.getByLabelText("Asset Name")).toHaveValue("Boom Hose");
  });

  it("says Saving…, blocks a second press, and reports success only after the server answers", async () => {
    const save = deferred<AssetRecord>();
    client.createAsset.mockReturnValue(save.promise);
    const user = await openAddAsset();
    await fillAsset(user);
    await user.click(screen.getByRole("button", { name: "Save asset" }));

    const busy = await screen.findByRole("button", { name: "Saving…" });
    expect(busy).toBeDisabled();
    await user.click(busy);
    expect(client.createAsset).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/saved successfully|created successfully/i)).toBeNull(); // not before the answer

    await act(async () => save.resolve({ ...asset, id: "asset-2", assetName: "Boom Hose", assetNumber: "HMS-009999" }));
    const success = await screen.findByRole("status");
    expect(success).toHaveTextContent("Boom Hose — HMS-009999 created successfully.");
    expect(screen.queryByRole("heading", { name: "Add Asset" })).toBeNull(); // drawer closes only on success
  });
});

describe("Asset archive", () => {
  const archiveButton = () => screen.getByRole("button", { name: "Archive" });

  it("asks first, naming the asset by name and HMS number, and does nothing until confirmed", async () => {
    const user = userEvent.setup();
    render(<AssetsWorkspace canWrite />);
    await screen.findByText("Main Pump Hose");
    await user.click(archiveButton());

    const dialog = screen.getByRole("alertdialog", { name: "Archive Main Pump Hose — HMS-001842?" });
    expect(client.archiveAsset).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(client.archiveAsset).not.toHaveBeenCalled();
    expect(screen.getByText("Main Pump Hose")).toBeInTheDocument();
    await waitFor(() => expect(archiveButton()).toHaveFocus(), FOCUS_WAIT); // back where the user was
  });

  it("leaves the asset listed and the dialog open, with the reason, when archiving fails", async () => {
    client.archiveAsset.mockRejectedValue(api(409, "This asset has an open inspection."));
    const user = userEvent.setup();
    render(<AssetsWorkspace canWrite />);
    await screen.findByText("Main Pump Hose");
    await user.click(archiveButton());
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Archive asset" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("This asset has an open inspection.");
    expect(screen.getAllByText("Main Pump Hose").length).toBeGreaterThan(0);
    expect(screen.queryByText(/was archived/)).toBeNull();
  });

  it("shows Archiving…, then removes the asset and says so only after the server confirms", async () => {
    const done = deferred();
    client.archiveAsset.mockReturnValue(done.promise);
    const user = userEvent.setup();
    render(<AssetsWorkspace canWrite />);
    await screen.findByText("Main Pump Hose");
    await user.click(archiveButton());
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Archive asset" }));

    const busy = await screen.findByRole("button", { name: "Archiving…" });
    expect(busy).toBeDisabled();
    expect(screen.queryByText(/was archived/)).toBeNull();
    expect(screen.getByText("Main Pump Hose")).toBeInTheDocument();

    await act(async () => done.resolve());
    const notice = (await screen.findByText(/Main Pump Hose — HMS-001842 was archived\./)).closest('[role="status"]');
    expect(notice).toHaveTextContent("Asset archived.");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("table", { name: "Asset records" })?.textContent ?? "").not.toContain("Main Pump Hose");
    expect(client.archiveAsset).toHaveBeenCalledTimes(1);
  });

  it("can be cancelled from the keyboard", async () => {
    const user = userEvent.setup();
    render(<AssetsWorkspace canWrite />);
    await screen.findByText("Main Pump Hose");
    archiveButton().focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(client.archiveAsset).not.toHaveBeenCalled();
  });
});

describe("Product form and archive (same contract)", () => {
  async function openAddProduct() {
    const user = userEvent.setup();
    render(<ProductsWorkspace canManage />);
    await screen.findByText("Hydraulic Hose");
    await user.click(screen.getByRole("button", { name: "Add Product" }));
    await screen.findByRole("heading", { name: "Add Product" });
    return user;
  }

  it("marks code, name and category required and validates inline with focus on the first", async () => {
    const user = await openAddProduct();
    for (const name of ["Product code", "Product name", "Category"]) {
      expect(screen.getByLabelText(name)).toBeRequired();
      expect(screen.getByLabelText(name)).toHaveAttribute("aria-required", "true");
    }
    expect(screen.getByLabelText("Sub category")).not.toBeRequired();
    await user.type(screen.getByLabelText("Product name"), "Suction Hose");
    await user.click(screen.getByRole("button", { name: "Save product" }));
    await waitFor(() => expect(screen.getByLabelText("Product code")).toHaveFocus(), FOCUS_WAIT);
    expect(screen.getByLabelText("Product code")).toHaveAccessibleDescription("Enter a product code.");
    expect(screen.getByLabelText("Category")).toHaveAccessibleDescription("Enter a category.");
    expect(screen.getByLabelText("Product name")).toHaveValue("Suction Hose");
    expect(client.createProduct).not.toHaveBeenCalled();
  });

  it("keeps the values and shows a safe message when saving fails, then succeeds after resolve", async () => {
    client.createProduct.mockRejectedValueOnce(api(500, "sqlalchemy.exc.OperationalError: connection refused"));
    const saved = { ...product, id: "prod-2", code: "PROD-020", name: "Suction Hose" };
    const later = deferred<ProductRecord>();
    client.createProduct.mockReturnValueOnce(later.promise);
    const user = await openAddProduct();
    await user.type(screen.getByLabelText("Product code"), "prod-020");
    await user.type(screen.getByLabelText("Product name"), "Suction Hose");
    await user.type(screen.getByLabelText("Category"), "Hose");
    await user.click(screen.getByRole("button", { name: "Save product" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/service is unavailable/i);
    expect(alert.textContent).not.toMatch(/sqlalchemy|OperationalError/);
    expect(screen.getByLabelText("Product code")).toHaveValue("PROD-020");

    await user.click(screen.getByRole("button", { name: "Save product" }));
    expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.queryByText(/created successfully/)).toBeNull();
    await act(async () => later.resolve(saved as unknown as ProductRecord));
    expect(await screen.findByRole("status")).toHaveTextContent("Suction Hose — PROD-020 created successfully.");
  });

  it("archives only after confirmation, names the product by name and code, and survives a failure", async () => {
    client.archiveProduct.mockRejectedValueOnce(api(404, "Not found"));
    const user = userEvent.setup();
    render(<ProductsWorkspace canManage />);
    await screen.findByText("Hydraulic Hose");
    await user.click(screen.getByRole("button", { name: "Archive Hydraulic Hose" }));
    const dialog = screen.getByRole("alertdialog", { name: "Archive Hydraulic Hose — PROD-014?" });
    expect(client.archiveProduct).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Archive product" }));
    expect(await within(await screen.findByRole("alertdialog")).findByRole("alert")).toHaveTextContent(/no longer exists/i);
    expect(screen.getByText("Hydraulic Hose")).toBeInTheDocument();
  });
});

describe("Customer form (same contract)", () => {
  it("marks the name and each location's contact fields required and validates inline", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<CustomerForm customer={null} onClose={vi.fn()} onSubmit={onSubmit} open />);
    for (const name of ["Name", "Location", "Site contact name", "Site contact mobile", "Site contact email"]) {
      expect(screen.getByLabelText(name)).toBeRequired();
      expect(screen.getByLabelText(name).closest("label")!.querySelector(".required-mark")).not.toBeNull();
    }
    expect(screen.getByLabelText("Notes")).not.toBeRequired();
    await user.type(screen.getByLabelText("Location"), "Kooragang");
    await user.click(screen.getByRole("button", { name: "Save customer" }));

    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveFocus(), FOCUS_WAIT);
    expect(screen.getByLabelText("Name")).toHaveAccessibleDescription("Enter the customer's name.");
    expect(screen.getByLabelText("Site contact email")).toHaveAccessibleDescription("Enter the site contact's email address.");
    expect(onSubmit).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Name"), "Orica");
    await user.type(screen.getByLabelText("Site contact name"), "Sam");
    await user.type(screen.getByLabelText("Site contact mobile"), "0400000000");
    await user.type(screen.getByLabelText("Site contact email"), "not-an-email");
    await user.click(screen.getByRole("button", { name: "Save customer" }));
    await waitFor(() => expect(screen.getByLabelText("Site contact email")).toHaveFocus(), FOCUS_WAIT);
    expect(screen.getByLabelText("Site contact email")).toHaveAccessibleDescription("Enter a valid email address.");
  });

  it("keeps everything when the server refuses, with a plain explanation, and blocks double submit", async () => {
    const attempt = deferred();
    const onSubmit = vi.fn().mockReturnValueOnce(attempt.promise).mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<CustomerForm customer={null} onClose={vi.fn()} onSubmit={onSubmit} open />);
    await user.type(screen.getByLabelText("Name"), "Orica");
    await user.type(screen.getByLabelText("Location"), "Kooragang");
    await user.type(screen.getByLabelText("Site contact name"), "Sam");
    await user.type(screen.getByLabelText("Site contact mobile"), "0400000000");
    await user.type(screen.getByLabelText("Site contact email"), "sam@example.com");
    await user.click(screen.getByRole("button", { name: "Save customer" }));
    const busy = await screen.findByRole("button", { name: "Saving…" });
    await user.click(busy);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    await act(async () => attempt.reject(api(409, "A customer with this name already exists.")));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("A customer with this name already exists.");
    expect(screen.getByLabelText("Name")).toHaveValue("Orica");
    expect(screen.getByLabelText("Site contact email")).toHaveValue("sam@example.com");
    expect(screen.getByRole("button", { name: "Save customer" })).toBeEnabled();
  });
});
