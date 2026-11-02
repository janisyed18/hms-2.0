import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HmsApiError } from "../api/hmsClient";
import { AssetsWorkspace } from "../components/AssetsWorkspace";
import { CustomerForm } from "../components/CustomerForm";
import { ProductsWorkspace } from "../components/ProductsWorkspace";
import type { AssetRecord, ProductRecord } from "../domain/types";
import { choose } from "../test/choose";

const client = vi.hoisted(() => ({
  listAssets: vi.fn(),
  listCustomers: vi.fn(),
  listProducts: vi.fn(),
  getAssetConfigurationOptions: vi.fn(),
  createAsset: vi.fn(),
  updateAsset: vi.fn(),
  deleteAsset: vi.fn(),
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  deleteProduct: vi.fn(),
  setProductEnabled: vi.fn(),
  getCustomer: vi.fn(),
  listReferenceCatalog: vi.fn()
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

// Focus follows the render that shows the error (see FocusDeterminism.test); waitFor only absorbs the async save.
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
  client.getCustomer.mockResolvedValue(customer);
  client.listReferenceCatalog.mockResolvedValue({ total: 0, etag: null, items: [] });
  client.getAssetConfigurationOptions.mockResolvedValue({ materials: [], couplings: [], couplingAddOns: [], attachMethods: [], nominalBores: [] });
});
afterEach(() => vi.useRealTimers());

async function openAddAsset() {
  const user = userEvent.setup();
  render(<AssetsWorkspace canWrite />);
  await screen.findByText("Main Pump Hose");
  await user.click(screen.getByRole("button", { name: "Add asset" }));
  await screen.findByRole("heading", { name: "Add asset" });
  return user;
}

async function chooseRelationships(user: ReturnType<typeof userEvent.setup>) {
  await choose(user, screen.getByLabelText("Customer"), "cust-1");
  await choose(user, screen.getByLabelText("Location"), "loc-1");
  await choose(user, screen.getByLabelText("Product"), "prod-1");
}

async function fillAsset(user: ReturnType<typeof userEvent.setup>) {
  await chooseRelationships(user);
  await user.type(screen.getByLabelText("Asset Name"), "Boom Hose");
  await user.type(screen.getByLabelText("Serial Number"), "SN-77");
}

describe("Asset form", () => {
  it("marks Customer, Location, Asset Name, Serial Number and Product as required, visibly and semantically, and nothing else", async () => {
    await openAddAsset();
    for (const name of ["Customer", "Location", "Asset Name", "Serial Number", "Product"]) {
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
    await chooseRelationships(user);
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
    // Focus lands in the same commit that shows the notice.
    await waitFor(() => expect(alert).toHaveFocus(), FOCUS_WAIT);
    expect(screen.getByRole("heading", { name: "Add asset" })).toBeInTheDocument();
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
    expect(screen.queryByRole("heading", { name: "Add asset" })).toBeNull(); // drawer closes only on success
  });
});

describe("Asset delete", () => {
  const deleteButton = () => screen.getByRole("button", { name: "Delete" });

  it("offers no Delete to anyone but a Super Admin, though they can still edit", async () => {
    render(<AssetsWorkspace canWrite />);
    await screen.findByText("Main Pump Hose");
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
  });

  it("asks first, naming the asset by name and HMS number, and does nothing until confirmed", async () => {
    const user = userEvent.setup();
    render(<AssetsWorkspace canDelete canWrite />);
    await screen.findByText("Main Pump Hose");
    await user.click(deleteButton());

    const dialog = screen.getByRole("alertdialog", { name: "Delete Main Pump Hose — HMS-001842?" });
    expect(client.deleteAsset).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(client.deleteAsset).not.toHaveBeenCalled();
    expect(screen.getByText("Main Pump Hose")).toBeInTheDocument();
    await waitFor(() => expect(deleteButton()).toHaveFocus(), FOCUS_WAIT); // back where the user was
  });

  it("leaves the asset listed and the dialog open, with the reason, when archiving fails", async () => {
    client.deleteAsset.mockRejectedValue(api(409, "This asset has an open inspection."));
    const user = userEvent.setup();
    render(<AssetsWorkspace canDelete canWrite />);
    await screen.findByText("Main Pump Hose");
    await user.click(deleteButton());
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete asset" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("This asset has an open inspection.");
    expect(screen.getAllByText("Main Pump Hose").length).toBeGreaterThan(0);
    expect(screen.queryByText(/was deleted/)).toBeNull();
  });

  it("shows Deleting…, then removes the asset and says so only after the server confirms", async () => {
    const done = deferred();
    client.deleteAsset.mockReturnValue(done.promise);
    const user = userEvent.setup();
    render(<AssetsWorkspace canDelete canWrite />);
    await screen.findByText("Main Pump Hose");
    await user.click(deleteButton());
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete asset" }));

    const busy = await screen.findByRole("button", { name: "Deleting…" });
    expect(busy).toBeDisabled();
    expect(screen.queryByText(/was deleted/)).toBeNull();
    expect(screen.getByText("Main Pump Hose")).toBeInTheDocument();

    await act(async () => done.resolve());
    const notice = (await screen.findByText(/Main Pump Hose — HMS-001842 was deleted\./)).closest('[role="status"]');
    expect(notice).toHaveTextContent("Asset deleted.");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("table", { name: "Asset records" })?.textContent ?? "").not.toContain("Main Pump Hose");
    expect(client.deleteAsset).toHaveBeenCalledTimes(1);
  });

  it("can be cancelled from the keyboard", async () => {
    const user = userEvent.setup();
    render(<AssetsWorkspace canDelete canWrite />);
    await screen.findByText("Main Pump Hose");
    deleteButton().focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(client.deleteAsset).not.toHaveBeenCalled();
  });
});

describe("Product catalogue search", () => {
  it("asks the server to search and reports its total, instead of filtering the first page", async () => {
    const user = userEvent.setup();
    render(<ProductsWorkspace canManage />);
    await screen.findByText("Hydraulic Hose");
    client.listProducts.mockClear();
    client.listProducts.mockResolvedValue({ total: 157, items: [{ ...product, id: "prod-far", code: "FAR-101", name: "Far Product 101" }] });

    await user.type(screen.getByLabelText("Search products"), "FAR-101");

    expect(await screen.findByText("Far Product 101")).toBeInTheDocument();
    expect(client.listProducts).toHaveBeenLastCalledWith(expect.objectContaining({ search: "FAR-101", enabled: true }));
    expect(screen.getByText(/157 enabled products/)).toBeInTheDocument();
  });
});

describe("Product form and archive (same contract)", () => {
  async function openAddProduct() {
    const user = userEvent.setup();
    render(<ProductsWorkspace canManage />);
    await screen.findByText("Hydraulic Hose");
    await user.click(screen.getByRole("button", { name: "Add product" }));
    await screen.findByRole("heading", { name: "Add product" });
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

  it("deletes only after confirmation, names the product by name and code, and survives a failure", async () => {
    client.deleteProduct.mockRejectedValueOnce(api(404, "Not found"));
    const user = userEvent.setup();
    render(<ProductsWorkspace canDelete canManage />);
    await screen.findByText("Hydraulic Hose");
    await user.click(screen.getByRole("button", { name: "Delete Hydraulic Hose" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete Hydraulic Hose — PROD-014?" });
    expect(client.deleteProduct).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Delete product" }));
    expect(await within(await screen.findByRole("alertdialog")).findByRole("alert")).toHaveTextContent(/no longer exists/i);
    expect(screen.getByText("Hydraulic Hose")).toBeInTheDocument();
  });
});

describe("Product lifecycle", () => {
  it("offers Disable to anyone who manages products but Delete only to a Super Admin", async () => {
    render(<ProductsWorkspace canManage />);
    await screen.findByText("Hydraulic Hose");
    expect(screen.getByRole("button", { name: "Disable Hydraulic Hose" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Delete / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Archive / })).toBeNull();
  });

  it("disables with one reversible request and takes the product off the enabled list", async () => {
    client.setProductEnabled.mockResolvedValue({ ...product, enabled: false });
    const user = userEvent.setup();
    render(<ProductsWorkspace canManage />);
    await screen.findByText("Hydraulic Hose");
    await user.click(screen.getByRole("button", { name: "Disable Hydraulic Hose" }));
    await waitFor(() => expect(client.setProductEnabled).toHaveBeenCalledWith("prod-1", false, "p1"));
    expect(await screen.findByText(/was disabled/)).toBeVisible();
  });
});

describe("Customer form (same contract)", () => {
  it("marks the name and each location's contact fields required and validates inline", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<CustomerForm customer={null} onClose={vi.fn()} onSubmit={onSubmit} open />);
    for (const name of ["Name", "Location name", "Site contact name", "Site contact mobile", "Site contact email"]) {
      expect(screen.getByLabelText(name)).toBeRequired();
      expect(screen.getByLabelText(name).closest("label")!.querySelector(".required-mark")).not.toBeNull();
    }
    expect(screen.getByLabelText("Notes")).not.toBeRequired();
    await user.type(screen.getByLabelText("Location name"), "Kooragang");
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
    await user.type(screen.getByLabelText("Location name"), "Kooragang");
    await user.type(screen.getByLabelText("Site contact name"), "Sam");
    await user.type(screen.getByLabelText("Site contact mobile"), "0400000000");
    await user.type(screen.getByLabelText("Site contact email"), "sam@example.com");
    await choose(user, screen.getByLabelText("Timezone"), "Australia/Sydney");
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
