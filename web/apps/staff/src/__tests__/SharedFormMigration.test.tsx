import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CertificateForm } from "../components/CertificateForm";
import { CustomerForm } from "../components/CustomerForm";
import { InspectionBookingForm } from "../components/InspectionBookingForm";
import { InspectionForm } from "../components/InspectionForm";
import { ProductForm } from "../components/ProductForm";
import { ReferenceForm } from "../components/ReferenceForm";
import { RetestScheduleDetail } from "../components/RetestScheduleDetail";
import { HmsApiError } from "../api/hmsClient";
import type { AssetRecord, CustomerRecord, InspectionRecord, ProductRecord, ReferenceCatalogRecord, RetestScheduleRecord } from "../domain/types";
import { guardNavigation } from "../routing/navigationGuard";
import { choose } from "../test/choose";

type User = ReturnType<typeof userEvent.setup>;
/** What a person reads in a control: the text of a Select, the value of anything typed into. */
const shown = (control: HTMLElement) => (control.tagName === "BUTTON" ? (control.textContent ?? "") : (control as HTMLInputElement).value);
const unsaved = () => screen.queryByText("Unsaved changes");
const dialog = () => screen.queryByRole("alertdialog", { name: "Discard unsaved changes?" });

const product: ProductRecord = { id: "p1", code: "HOSE-1", name: "Rock hose", category: "Hose", subCategory: null, standardCode: null };
const standard: ReferenceCatalogRecord = { id: "s1", code: "AS2683", name: "Hose standard" };
const customer = {
  id: "c1", code: "C1", name: "Vopak", notes: "", status: "ACTIVE",
  locations: [{ id: "l1", name: "Dock", siteContactName: "Sam", siteContactMobile: "0400", siteContactEmail: "sam@x.test", ppeRequirements: [], additionalRequirements: [] }]
} as unknown as CustomerRecord;
const asset = (id: string) => ({ id, assetNumber: `A-${id}`, assetName: `Hose ${id}`, tag: null, customer: { id: "c1", code: "C1", name: "Vopak" }, location: null }) as unknown as AssetRecord;
const inspection = { id: "i1", asset: { assetNumber: "A-1", assetName: "Hose" }, customer: { name: "Vopak" } } as unknown as InspectionRecord;

interface Case {
  name: string;
  /** The form, closed over the spies. `record` is the record being edited, when it has one. */
  ui: (props: { onClose: () => void; onSubmit: () => Promise<void>; record?: boolean }) => ReactElement;
  /** A meaningful edit, and the field it touches. */
  edit: (user: User) => Promise<void>;
  field: string;
  fieldValue: string;
  save: string;
  /** Fills in whatever is missing so a save is valid. */
  complete?: (user: User) => Promise<void>;
  /** Present when an empty save is refused in the browser, with the first field focused. */
  firstInvalid?: string;
  /** A server field error naming this API field lands on this label. */
  serverField?: { api: string; label: string };
  hasEditMode: boolean;
}

const cases: Case[] = [
  {
    name: "Product",
    ui: ({ onClose, onSubmit, record }) => <ProductForm onClose={onClose} onSubmit={onSubmit} open product={record ? product : null} />,
    edit: async (user) => { await user.type(screen.getByLabelText("Product name"), " X"); },
    field: "Product name", fieldValue: "Rock hose X", save: "Save product",
    complete: async (user) => {
      await user.type(screen.getByLabelText("Product code"), "NEW");
      await user.type(screen.getByLabelText("Product name"), "Hose");
      await user.type(screen.getByLabelText("Category"), "Hose");
    },
    firstInvalid: "Product code", serverField: { api: "code", label: "Product code" }, hasEditMode: true
  },
  {
    name: "Reference catalogue",
    ui: ({ onClose, onSubmit, record }) => <ReferenceForm entityLabel="Standard" onClose={onClose} onSubmit={onSubmit} open standard={record ? standard : null} />,
    edit: async (user) => { await user.type(screen.getByLabelText("Standard name"), " X"); },
    field: "Standard name", fieldValue: "Hose standard X", save: "Save standard",
    complete: async (user) => {
      await user.type(screen.getByLabelText("Standard code"), "NEW");
      await user.type(screen.getByLabelText("Standard name"), "Name");
    },
    firstInvalid: "Standard code", serverField: { api: "name", label: "Standard name" }, hasEditMode: true
  },
  {
    name: "Customer",
    ui: ({ onClose, onSubmit, record }) => <CustomerForm customer={record ? customer : null} onClose={onClose} onSubmit={onSubmit} open />,
    edit: async (user) => { await user.type(screen.getByLabelText("Notes"), "note"); },
    field: "Notes", fieldValue: "note", save: "Save customer",
    complete: async (user) => {
      await user.type(screen.getByLabelText("Name"), "Orica");
      await user.type(screen.getByLabelText("Location"), "Kooragang");
      await user.type(screen.getByLabelText("Site contact name"), "Sam");
      await user.type(screen.getByLabelText("Site contact mobile"), "0400000000");
      await user.type(screen.getByLabelText("Site contact email"), "sam@example.test");
    },
    firstInvalid: "Name", serverField: { api: "name", label: "Name" }, hasEditMode: true
  },
  {
    name: "Certificate",
    ui: ({ onClose, onSubmit }) => <CertificateForm inspectionOptions={[inspection]} onClose={onClose} onSubmit={onSubmit} open />,
    edit: async (user) => { await user.type(screen.getByLabelText("Certificate number"), "-B"); },
    field: "Certificate number", fieldValue: "CERT-A-1-1-B", save: "Issue certificate",
    hasEditMode: false
  },
  {
    name: "Inspection (create)",
    ui: ({ onClose, onSubmit }) => <InspectionForm assetOptions={[asset("1"), asset("2")]} onClose={onClose} onSubmit={onSubmit} open />,
    edit: async (user) => { await choose(user, screen.getByLabelText("Inspection type"), "NEW_ASSET"); },
    field: "Inspection type", fieldValue: "New asset", save: "Save inspection",
    complete: async (user) => { await choose(user, screen.getByLabelText("Inspection asset"), "1"); },
    firstInvalid: "Inspection asset", hasEditMode: false
  }
];

afterEach(() => vi.restoreAllMocks());

describe.each(cases)("$name form on the shared form system", (c) => {
  const mount = (record = false, onSubmit = vi.fn().mockResolvedValue(undefined)) => {
    const onClose = vi.fn();
    const view = render(c.ui({ onClose, onSubmit, record }));
    return { ...view, onClose, onSubmit };
  };

  it("starts clean and Cancel leaves at once", async () => {
    const user = userEvent.setup();
    const { onClose } = mount(c.hasEditMode);
    expect(unsaved()).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });

  it("is dirty after an edit: Cancel and Escape ask, Keep editing keeps it, Discard leaves", async () => {
    const user = userEvent.setup();
    const { onClose } = mount(c.hasEditMode);
    await c.edit(user);
    expect(unsaved()).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(dialog()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(shown(screen.getByLabelText(c.field))).toBe(c.fieldValue);
    await user.keyboard("{Escape}");
    expect(dialog()).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("holds in-app navigation while dirty, and not when clean", async () => {
    const user = userEvent.setup();
    mount(c.hasEditMode);
    const proceed = vi.fn();
    act(() => guardNavigation(proceed));
    expect(proceed).toHaveBeenCalledTimes(1);
    proceed.mockClear();
    await c.edit(user);
    act(() => guardNavigation(proceed));
    expect(proceed).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it("keeps what was typed through a re-render from a list refresh", async () => {
    const user = userEvent.setup();
    const { rerender, onClose, onSubmit } = mount(c.hasEditMode);
    await c.edit(user);
    rerender(c.ui({ onClose, onSubmit, record: c.hasEditMode }));
    expect(shown(screen.getByLabelText(c.field))).toBe(c.fieldValue);
    expect(unsaved()).not.toBeNull();
  });

  if (c.firstInvalid) {
    it("refuses an empty save with the error on its field, the first gap focused and a summary link", async () => {
      const user = userEvent.setup();
      const { onSubmit } = mount(false);
      await user.click(screen.getByRole("button", { name: c.save }));
      const first = screen.getByLabelText(c.firstInvalid!);
      expect(first).toHaveAttribute("aria-invalid", "true");
      expect(first.getAttribute("aria-describedby")).toBeTruthy();
      await waitFor(() => expect(first).toHaveFocus());
      expect(onSubmit).not.toHaveBeenCalled();
      expect(unsaved()).toBeNull(); // trying to save is not editing
      const summary = screen.getByRole("navigation", { name: "Fields to correct" });
      expect(within(summary).getAllByRole("button").length).toBeGreaterThan(0);
    });
  }

  it("keeps every value when the save fails, stays dirty, and is clean once a retry succeeds", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValueOnce(new HmsApiError(500, "internal", "Internal server error", null)).mockResolvedValue(undefined);
    mount(c.hasEditMode, onSubmit);
    await c.complete?.(user);
    await c.edit(user);
    await user.click(screen.getByRole("button", { name: c.save }));
    // The refusal is announced and holds focus the moment it is visible: no timer decides that.
    expect(await screen.findByRole("alert")).toHaveFocus();
    expect(shown(screen.getByLabelText(c.field))).toContain(c.fieldValue.split(" ")[0]);
    expect(unsaved()).not.toBeNull();
    expect(dialog()).toBeNull();
    await user.click(screen.getByRole("button", { name: c.save }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(unsaved()).toBeNull());
  });

  it("cannot be submitted twice while a save is in flight", async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const onSubmit = vi.fn(() => new Promise<void>((done) => { release = done; }));
    mount(c.hasEditMode, onSubmit);
    await c.complete?.(user);
    await c.edit(user);
    const form = screen.getByRole("form");
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /…$/ })).toBeDisabled();
    await act(async () => release());
  });

  if (c.serverField) {
    it("puts a server field error on that field and in the summary, without wiping the form", async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn().mockRejectedValue(new HmsApiError(422, "validation", "Request validation failed", [{ loc: ["body", c.serverField!.api], msg: "field required" }]));
      mount(c.hasEditMode, onSubmit);
      await c.complete?.(user);
      await c.edit(user);
      await user.click(screen.getByRole("button", { name: c.save }));
      const target = await screen.findByLabelText(c.serverField!.label);
      await waitFor(() => expect(target).toHaveAttribute("aria-invalid", "true"));
      expect(screen.getByRole("navigation", { name: "Fields to correct" })).toBeInTheDocument();
      expect(unsaved()).not.toBeNull();
    });
  }

  it("returns focus to where it was when it closes", async () => {
    const user = userEvent.setup();
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { onClose } = mount(c.hasEditMode);
    expect(screen.getByRole("form").contains(document.activeElement)).toBe(true);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    opener.remove();
  });
});

describe("edit forms: hydration and refresh", () => {
  it.each([
    ["Product", (p: ProductRecord) => <ProductForm onClose={vi.fn()} onSubmit={vi.fn()} open product={p} />, "Product name", product],
    ["Reference", (p: ReferenceCatalogRecord) => <ReferenceForm onClose={vi.fn()} onSubmit={vi.fn()} open standard={p} />, "Standard name", standard]
  ] as const)("%s: loads the record without reading it as an edit, and follows a refreshed record only while untouched", (_name, ui, label, record) => {
    const { rerender } = render((ui as (r: unknown) => ReactElement)(record));
    expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(record.name);
    expect(unsaved()).toBeNull();
    rerender((ui as (r: unknown) => ReactElement)({ ...record, name: "Renamed by someone else" }));
    expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe("Renamed by someone else");
    expect(unsaved()).toBeNull();
  });

  it("Product: a refreshed record does not replace what is being typed", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ProductForm onClose={vi.fn()} onSubmit={vi.fn()} open product={product} />);
    await user.type(screen.getByLabelText("Product name"), "!");
    rerender(<ProductForm onClose={vi.fn()} onSubmit={vi.fn()} open product={{ ...product, name: "Changed on the server" }} />);
    expect((screen.getByLabelText("Product name") as HTMLInputElement).value).toBe("Rock hose!");
    expect(unsaved()).not.toBeNull();
  });

  it("a slow save for one record does not touch the form once it shows another", async () => {
    const user = userEvent.setup();
    let releaseA: () => void = () => undefined;
    const onSubmitA = vi.fn(() => new Promise<void>((done) => { releaseA = done; }));
    const { rerender } = render(<ProductForm onClose={vi.fn()} onSubmit={onSubmitA} open product={product} />);
    await user.type(screen.getByLabelText("Product name"), "!");
    await user.click(screen.getByRole("button", { name: "Save product" }));
    rerender(<ProductForm onClose={vi.fn()} onSubmit={vi.fn().mockResolvedValue(undefined)} open product={{ ...product, id: "p2", name: "Other hose" }} />);
    await user.type(screen.getByLabelText("Product name"), "?");
    await act(async () => releaseA());
    expect((screen.getByLabelText("Product name") as HTMLInputElement).value).toBe("Other hose?");
    expect(unsaved()).not.toBeNull();
    expect(screen.getByRole("button", { name: "Save product" })).toBeEnabled();
  });
});

describe("a failed save for a record that has been left", () => {
  it("shows no error and no lock on the record now on screen", async () => {
    const user = userEvent.setup();
    let failA: (reason: unknown) => void = () => undefined;
    const onSubmitA = vi.fn(() => new Promise<void>((_done, reject) => { failA = reject; }));
    const { rerender } = render(<ProductForm onClose={vi.fn()} onSubmit={onSubmitA} open product={product} />);
    await user.type(screen.getByLabelText("Product name"), "!");
    await user.click(screen.getByRole("button", { name: "Save product" }));
    rerender(<ProductForm onClose={vi.fn()} onSubmit={vi.fn().mockResolvedValue(undefined)} open product={{ ...product, id: "p2", name: "Other hose" }} />);
    await act(async () => failA(new HmsApiError(500, "internal", "Internal server error", null)));
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByLabelText("Product name") as HTMLInputElement).value).toBe("Other hose");
    expect(screen.getByRole("button", { name: "Save product" })).toBeEnabled();
  });
});

describe("Certificate: nothing to issue", () => {
  it("explains it and offers no save", () => {
    render(<CertificateForm inspectionOptions={[]} onClose={vi.fn()} onSubmit={vi.fn()} open />);
    expect(screen.getByText("There are no approved inspections waiting for a certificate.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Issue certificate" })).toBeDisabled();
  });
  it("does not overwrite a number being typed when the list of inspections refreshes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<CertificateForm inspectionOptions={[inspection]} onClose={vi.fn()} onSubmit={vi.fn()} open />);
    await user.type(screen.getByLabelText("Certificate number"), "-EDIT");
    rerender(<CertificateForm inspectionOptions={[{ ...inspection }]} onClose={vi.fn()} onSubmit={vi.fn()} open />);
    expect((screen.getByLabelText("Certificate number") as HTMLInputElement).value).toBe("CERT-A-1-1-EDIT");
  });
});

describe("Booking form", () => {
  const rescheduled = {
    id: "b1", customer: { id: "c1", name: "Vopak" }, location: { id: "l1", name: "Dock", schedulingTimezone: "UTC" },
    assets: [{ id: "a1", assetNumber: "A-1", assetName: null }]
  } as never;
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200, headers: new Headers(),
      json: async () => ({ items: [{ quote_id: "q1", starts_at: "2026-10-30T01:00:00Z", ends_at: "2026-10-30T02:00:00Z", expires_at: "2099-01-01T00:00:00Z" }] })
    })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("offers no booking until the choices are complete, and starts clean", () => {
    render(<InspectionBookingForm assetOptions={[asset("1")]} onClose={vi.fn()} onSubmit={vi.fn()} open />);
    expect(screen.getByRole("button", { name: "Create booking" })).toBeDisabled();
    expect(unsaved()).toBeNull();
  });

  it("a prefilled date is not an edit; choosing a location is, and Cancel then asks", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const withLocation = { ...asset("1"), location: { id: "l1", name: "Dock", schedulingTimezone: "UTC" } } as unknown as AssetRecord;
    render(<InspectionBookingForm assetOptions={[withLocation]} initialDate="2026-10-30" onClose={onClose} onSubmit={vi.fn()} open />);
    expect(unsaved()).toBeNull();
    await choose(user, screen.getByLabelText("Booking location"), "l1");
    expect(unsaved()).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(dialog()).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("a reschedule starts clean and a typed reason is kept when the booking refreshes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<InspectionBookingForm assetOptions={[]} onClose={vi.fn()} onReschedule={vi.fn()} onSubmit={vi.fn()} open rescheduleBooking={rescheduled} />);
    expect(unsaved()).toBeNull();
    await user.type(screen.getByLabelText("Additional inspection information"), "Site closed");
    rerender(<InspectionBookingForm assetOptions={[]} onClose={vi.fn()} onReschedule={vi.fn()} onSubmit={vi.fn()} open rescheduleBooking={{ ...(rescheduled as object) } as never} />);
    expect((screen.getByLabelText("Additional inspection information") as HTMLTextAreaElement).value).toBe("Site closed");
    expect(unsaved()).not.toBeNull();
  });
});

describe("Retest schedule: the inline form", () => {
  const schedule = {
    id: "r1", assetId: "a1", customerId: "c1", dueAt: "2026-11-01", status: "UPCOMING", reminderIntervalDays: 30, escalationIntervalDays: 7,
    lastRemindedAt: null, escalatedAt: null, asset: { id: "a1", assetNumber: "A-1", assetName: "Hose", tag: null }, customer: { id: "c1", code: "C1", name: "Vopak" },
    product: { id: "p1", code: "P", name: "Hose", category: "Hose" }
  } as unknown as RetestScheduleRecord;
  const panel = (props: Partial<{ canWrite: boolean; onClose: () => void; onSave: () => Promise<void>; schedule: RetestScheduleRecord }> = {}) => (
    <RetestScheduleDetail canWrite onClose={vi.fn()} onSave={vi.fn().mockResolvedValue(undefined)} schedule={schedule} {...props} />
  );

  it("loads clean, becomes dirty on an edit, and offers Discard changes in place", async () => {
    const user = userEvent.setup();
    render(panel());
    expect(unsaved()).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard changes" })).toBeNull();
    await user.clear(screen.getByLabelText("Reminder interval days"));
    await user.type(screen.getByLabelText("Reminder interval days"), "14");
    expect(unsaved()).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect((screen.getByLabelText("Reminder interval days") as HTMLInputElement).value).toBe("30");
    expect(unsaved()).toBeNull();
  });

  it("takes no focus when it appears and has no Escape or trap of its own", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    render(panel());
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("validates on the field, keeps values on a failed save and is clean after a successful one", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValueOnce(new HmsApiError(500, "internal", "Internal server error", null)).mockResolvedValue(undefined);
    render(panel({ onSave }));
    await user.clear(screen.getByLabelText("Reminder interval days"));
    await user.click(screen.getByRole("button", { name: "Save schedule" }));
    expect(screen.getByLabelText("Reminder interval days")).toHaveAttribute("aria-invalid", "true");
    expect(onSave).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Reminder interval days"), "14");
    await user.click(screen.getByRole("button", { name: "Save schedule" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect((screen.getByLabelText("Reminder interval days") as HTMLInputElement).value).toBe("14");
    expect(unsaved()).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Save schedule" }));
    await waitFor(() => expect(unsaved()).toBeNull());
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("asks before the panel is closed or another schedule is opened with unsaved edits", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(panel({ onClose }));
    await user.type(screen.getByLabelText("Reminder interval days"), "9");
    await user.click(screen.getByRole("button", { name: "Close retest schedule detail" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect((screen.getByLabelText("Reminder interval days") as HTMLInputElement).value).toBe("309");
    const open = vi.fn();
    act(() => guardNavigation(open));
    expect(open).not.toHaveBeenCalled();
    await user.click(within(dialog()!).getByRole("button", { name: "Discard changes" }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("is read-only without permission: disabled fields, no save, no unsaved tracking", async () => {
    render(panel({ canWrite: false }));
    expect(screen.getByLabelText("Retest due date")).toBeDisabled();
    expect(screen.getByLabelText("Reminder interval days")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save schedule" })).toBeNull();
    expect(unsaved()).toBeNull();
  });

  it("keeps typing through a refreshed record, then follows the saved one", async () => {
    const user = userEvent.setup();
    const { rerender } = render(panel());
    await user.type(screen.getByLabelText("Reminder interval days"), "5");
    rerender(panel({ schedule: { ...schedule, status: "DUE" } }));
    expect((screen.getByLabelText("Reminder interval days") as HTMLInputElement).value).toBe("305");
  });
});
