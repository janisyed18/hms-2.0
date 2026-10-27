import { HmsApiError } from "../api/hmsClient";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { InspectionDetail } from "../components/InspectionDetail";
import { InspectionForm } from "../components/InspectionForm";
import { CONDITION_CHECKS, blankFormState, buildValues, passAllConditions } from "../domain/inspectionForm";
import type { InspectionFormState } from "../domain/inspectionForm";
import type { AssetRecord, InspectionRecord } from "../domain/types";

const rated = {
  id: "asset-rated",
  assetNumber: "RATED-1",
  customer: { id: "c1", code: "C1", name: "Acme" },
  pressureRating: { workingPressureKpa: 1500, testPressureKpa: 2250 }
} as unknown as AssetRecord;
const unrated = {
  id: "asset-unrated",
  assetNumber: "PLAIN-1",
  customer: { id: "c1", code: "C1", name: "Acme" },
  pressureRating: null
} as unknown as AssetRecord;
const other = {
  id: "asset-other",
  assetNumber: "OTHER-1",
  customer: { id: "c1", code: "C1", name: "Acme" },
  pressureRating: { workingPressureKpa: 1000, testPressureKpa: 1500 }
} as unknown as AssetRecord;

function renderForm() {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(<InspectionForm assetOptions={[rated, unrated, other]} onClose={vi.fn()} onSubmit={onSubmit} open />);
  return { onSubmit };
}

const save = () => screen.getByRole("button", { name: "Save inspection" });
const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement | HTMLSelectElement;

async function fillEverything(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(field("Instruction"), "REPAIR");
  await user.selectOptions(field("Test time minutes"), "5");
  await user.selectOptions(field("Pressure test result"), "PASS");
  await user.type(field("Ohms end A"), "0.1");
  await user.type(field("Ohms end B"), "0.2");
  await user.type(field("Ohms total"), "0.3");
  await user.click(screen.getByRole("button", { name: "Pass all" }));
  await user.selectOptions(field(CONDITION_CHECKS[3].label), "FAIL");
  await user.selectOptions(field("Certificate result"), "FAIL");
  await user.type(field("Inspection notes"), "Kink near end B.");
}

describe("new inspection (staff)", () => {
  it("starts with no asset chosen, and saving says an asset is needed instead of doing nothing", async () => {
    const user = userEvent.setup();
    const props = renderForm();
    expect((field("Inspection asset") as HTMLSelectElement).value).toBe("");
    expect(screen.getByText("Select an asset")).toBeInTheDocument();
    expect(screen.queryByLabelText("Working pressure kPa")).not.toBeInTheDocument();
    expect(field("Inspection asset")).toBeRequired();
    await user.click(save());
    expect(field("Inspection asset")).toHaveAccessibleDescription("Select the asset being inspected.");
    expect(field("Inspection asset")).toHaveFocus();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("prefills the pressures from the chosen asset's product rating and nothing else", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.selectOptions(field("Inspection asset"), "asset-rated");

    expect(field("Working pressure kPa")).toHaveValue("1500");
    expect(field("Test pressure kPa")).toHaveValue("2250");
    expect(screen.getByText(/Product rating: 1500 kPa working, 2250 kPa test/)).toBeVisible();
    for (const label of ["Instruction", "Test time minutes", "Pressure test result", "Certificate result"]) {
      expect(field(label)).toHaveValue("");
    }
    for (const { label } of CONDITION_CHECKS) expect(field(label)).toHaveValue("");
    expect(field("Ohms end A")).toHaveValue("");
    await user.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent(/still needed.*Test time/i);
    expect(screen.getByRole("status")).toHaveTextContent("Test time");
  });

  it("invents no pressure for a product without a rating", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.selectOptions(field("Inspection asset"), "asset-unrated");
    expect(field("Working pressure kPa")).toHaveValue("");
    expect(field("Test pressure kPa")).toHaveValue("");
    expect(screen.getByText(/no rating for the hose's bore/)).toBeVisible();
  });

  it("lets the pressures be overridden and says so", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.selectOptions(field("Inspection asset"), "asset-rated");
    await user.clear(field("Test pressure kPa"));
    await user.type(field("Test pressure kPa"), "2400");
    expect(screen.getByText(/Overridden\. Product rating: 1500 kPa working, 2250 kPa test/)).toBeVisible();
  });

  it("offers exactly 1, 5 and 10 minutes for the test time", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.selectOptions(field("Inspection asset"), "asset-rated");
    const options = within(field("Test time minutes") as HTMLElement).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Select", "1 min", "5 min", "10 min"]);
  });

  it("answers all seven conditions only when asked to pass them all", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.selectOptions(field("Inspection asset"), "asset-rated");
    expect(CONDITION_CHECKS).toHaveLength(7);
    await user.click(screen.getByRole("button", { name: "Pass all" }));
    for (const { label } of CONDITION_CHECKS) expect(field(label)).toHaveValue("PASS");
    expect(field("Certificate result")).toHaveValue("");
  });

  it("saves every field the customer asked for, keeping the three results separate", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    await user.selectOptions(field("Inspection asset"), "asset-rated");
    await fillEverything(user);
    expect(save()).toBeEnabled();
    await user.click(save());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const values = onSubmit.mock.calls[0][0];
    expect(values).toMatchObject({ assetId: "asset-rated", inspectionType: "SERVICE", result: "REPAIR" });
    expect(values.pressureTest).toMatchObject({ appliedPressureKpa: 2250, holdTimeSeconds: 300, passed: true });
    const measurements = values.pressureTest.measurements;
    expect(measurements).toMatchObject({
      schema_version: 1,
      working_pressure_kpa: 1500,
      rated_working_pressure_kpa: 1500,
      rated_test_pressure_kpa: 2250,
      test_duration_minutes: 5,
      ohms_end_a: 0.1,
      ohms_end_b: 0.2,
      ohms_total: 0.3,
      certificate_result: "FAIL",
      notes: "Kink near end B."
    });
    expect(measurements.conditions.kink_or_dent).toBe("FAIL");
    expect(measurements.conditions.chemical_attack).toBe("PASS");
  });

  it("drops what was typed when another asset is chosen", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.selectOptions(field("Inspection asset"), "asset-rated");
    await user.selectOptions(field("Instruction"), "PASS");
    await user.clear(field("Test pressure kPa"));
    await user.type(field("Test pressure kPa"), "2400");
    await user.selectOptions(field("Inspection asset"), "asset-other");
    expect(field("Working pressure kPa")).toHaveValue("1000");
    expect(field("Test pressure kPa")).toHaveValue("1500");
    expect(field("Instruction")).toHaveValue("");
  });

  it("reports a save failure", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(new HmsApiError(422, "validation", "Request validation failed", null));
    render(<InspectionForm assetOptions={[rated]} onClose={vi.fn()} onSubmit={onSubmit} open />);
    await user.selectOptions(field("Inspection asset"), "asset-rated");
    await fillEverything(user);
    await user.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent("Request validation failed");
  });
});

function savedInspection(state: InspectionFormState, status = "IN_PROGRESS"): InspectionRecord {
  const built = buildValues(state)!;
  return {
    id: "insp-1",
    assetId: "asset-rated",
    inspectionType: "SERVICE",
    status,
    result: built.result,
    inspectorUserId: "inspector-1",
    reviewerUserId: null,
    submittedAt: null,
    approvedAt: null,
    rejectedAt: null,
    asset: { id: "asset-rated", assetNumber: "RATED-1", tag: null, lifecycleStatus: "IN_SERVICE" },
    customer: { id: "c1", code: "C1", name: "Acme" },
    product: { id: "p1", code: "P", name: "Hose", category: "Hydraulic" },
    pressureTest: {
      id: "pt1",
      appliedPressureKpa: built.pressureTest.appliedPressureKpa,
      holdTimeSeconds: built.pressureTest.holdTimeSeconds,
      passed: built.pressureTest.passed,
      measurements: built.pressureTest.measurements
    }
  } as unknown as InspectionRecord;
}

const completeState: InspectionFormState = {
  ...passAllConditions(blankFormState({ workingPressureKpa: 1500, testPressureKpa: 2250 })),
  instruction: "PASS",
  certificateResult: "PASS",
  pressureTestResult: "PASS",
  testMinutes: "10",
  ohmsEndA: "0.1",
  ohmsEndB: "0.2",
  ohmsTotal: "0.3",
  notes: "All good."
};

function renderDetail(inspection: InspectionRecord, extra: Partial<React.ComponentProps<typeof InspectionDetail>> = {}) {
  const props = {
    canApprove: false,
    canWrite: true,
    inspection,
    onApprove: vi.fn().mockResolvedValue(undefined),
    onBeginRework: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
    onReject: vi.fn().mockResolvedValue(undefined),
    onSaveDraft: vi.fn().mockResolvedValue(undefined),
    onStart: vi.fn().mockResolvedValue(undefined),
    onSubmit: vi.fn().mockResolvedValue(undefined),
    ...extra
  };
  render(<InspectionDetail {...props} />);
  return props;
}

describe("saved inspection (staff)", () => {
  it("reloads a draft exactly as it was saved", () => {
    renderDetail(savedInspection(completeState));
    expect(field("Instruction")).toHaveValue("PASS");
    expect(field("Working pressure kPa")).toHaveValue("1500");
    expect(field("Test pressure kPa")).toHaveValue("2250");
    expect(field("Test time minutes")).toHaveValue("10");
    expect(field("Ohms end A")).toHaveValue("0.1");
    expect(field("Ohms total")).toHaveValue("0.3");
    expect(field("Certificate result")).toHaveValue("PASS");
    expect(field("Inspection notes")).toHaveValue("All good.");
    for (const { label } of CONDITION_CHECKS) expect(field(label)).toHaveValue("PASS");
  });

  it("saves edits in progress and submits only once the whole form is filled", async () => {
    const user = userEvent.setup();
    const partial = { ...completeState, ohmsTotal: "", certificateResult: "" as const };
    const props = renderDetail(savedInspection(partial));
    const submit = screen.getByRole("button", { name: "Submit inspection" });

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Certificate result");
    expect(status).toHaveTextContent("Ohms total");
    // An incomplete form cannot be submitted, and says why instead of sitting dead.
    await user.click(submit);
    expect(props.onSubmit).not.toHaveBeenCalled();
    const gap = await screen.findByRole("alert");
    expect(gap).toHaveTextContent(/still needed.*Certificate result.*Ohms total|still needed.*Ohms total.*Certificate result/i);
    // Focus moves to the notice in a deferred step after it renders.
    await waitFor(() => expect(gap).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Save progress" }));
    expect(props.onSaveDraft).toHaveBeenCalledTimes(1);

    await user.type(field("Ohms total"), "0.3");
    await user.selectOptions(field("Certificate result"), "PASS");
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(props.onSubmit).mock.calls[0][0].pressureTest?.measurements).toMatchObject({
      ohms_total: 0.3,
      certificate_result: "PASS"
    });
  });

  it("shows a reviewer every value, read-only, with approval available", async () => {
    const user = userEvent.setup();
    const state = { ...completeState };
    state.conditions = { ...state.conditions, kink_or_dent: "FAIL" };
    const props = renderDetail(savedInspection(state, "SUBMITTED"), { canApprove: true, canWrite: false });

    expect(field("Test time minutes")).toBeDisabled();
    expect(field("Test time minutes")).toHaveValue("10");
    expect(field(CONDITION_CHECKS[3].label)).toHaveValue("FAIL");
    expect(field(CONDITION_CHECKS[3].label)).toBeDisabled();
    expect(field("Inspection notes")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Submit inspection" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve inspection" }));
    expect(props.onApprove).toHaveBeenCalled();
  });

  it("shows a submit failure from the server", async () => {
    const user = userEvent.setup();
    const props = renderDetail(savedInspection(completeState), {
      onSubmit: vi.fn().mockRejectedValue(new HmsApiError(422, "validation", "Inspection is incomplete: Ohms total", null))
    });
    await user.click(screen.getByRole("button", { name: "Submit inspection" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Inspection is incomplete"));
    expect(props.onSubmit).toHaveBeenCalled();
  });

  it("keeps a legacy draft's old measurement in the notes instead of losing it", () => {
    const legacy = savedInspection(completeState);
    legacy.pressureTest!.measurements = { leak: "none" };
    renderDetail(legacy);
    expect(field("Inspection notes")).toHaveValue("leak=none");
  });
});
