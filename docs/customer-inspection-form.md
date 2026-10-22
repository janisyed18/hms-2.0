# Customer inspection form

The customer's marked-up Inspection/Certificate form, as it maps onto HMS 2.0. The same
fields are captured in the staff app (Add Inspection, and the draft inspection detail) and
in the offline inspector app, and are read, read-only, by reviewers.

| Form field (customer's review) | Stored as | Notes |
|---|---|---|
| Instruction: Pass / Repair | `inspections.result` (`PASS` or `REPAIR`) | Separate from the pressure test result and the certificate result. `FAIL` and `REVIEW` remain valid for inspections saved before this form. |
| Test Pressure | `pressure_test_results.applied_pressure_kpa` | Defaults to the product's rated test pressure for the hose's nominal bore; overridable. |
| Working Pressure | `measurements.working_pressure_kpa` | Defaults to the product's rated working pressure for the bore; overridable. The rating used is stored beside it (`rated_working_pressure_kpa`, `rated_test_pressure_kpa`, `null` if the product has none), so an override is visible later. |
| Test Time (1 / 5 / 10 min) | `measurements.test_duration_minutes`; `hold_time_seconds` = minutes x 60 | The API rejects a mismatch. |
| Ohms End A / End B / Total | `measurements.ohms_end_a`, `ohms_end_b`, `ohms_total` | Numbers as entered, 0 or more. |
| The seven condition checks (Pass / Fail) | `measurements.conditions` | Keys below. A Pass means no defect was found. "Pass all" is a button the user presses; nothing is passed by default. |
| Certificate Result: Pass / Fail | `measurements.certificate_result` | What the certificate prints (it no longer prints the instruction). A `FAIL` also raises the failed-inspection alert on approval. |
| Notes | `measurements.notes` | Up to 2000 characters. |
| (pressure test pass/fail) | `pressure_test_results.passed` | Its own explicit Pass/Fail, not derived from the other results. |

All of `measurements` is validated server-side (`modules/inspections/measurements.py`,
schema version 1) on every write path: the staff API and the sync push from the offline
app. An unanswered field is simply absent; nothing is defaulted on the customer's behalf.

## Condition checks

| Key | Customer's wording |
|---|---|
| `chemical_attack` | Chemical attack or damage to outer carcass? |
| `rust_in_fittings` | Excessive rust inside or outside the fittings? |
| `end_fitting_damage` | End fittings show signs of damage or displacement? |
| `kink_or_dent` | Evidence of kink or dent damage? |
| `fitting_seal_damage` | Fitting ends damaged or deformed in a way that they may not form a good seal? |
| `wire_corrosion` | Outer wire shows signs of abrasion or corroding? |
| `bend_at_fitting` | Signs of hose being bent or kinked just before the fitting? |

## Submission

A draft can be saved once it has a test pressure, a test time and a pressure test result.
It can be submitted for review only when every field above is answered (the API returns 422
listing what is missing). An inspection with no pressure test at all cannot be submitted
("Pressure test" is reported as missing), by the staff API or by sync. Inspections saved
before this form that carry a pressure test in the earlier format (no `schema_version`)
submit as before.

The offline inspector's "Submit" now submits on the server: the sync push applies a
`status: "SUBMITTED"` request with the same checks, audit event and reviewer notification
as the staff API. Previously the status in the push was ignored.

## Not captured, and why

The review's remaining form fields have no supported meaning in the current domain and
were not invented:

- **Group Select**: the customer marked it with "?". No group concept exists on assets,
  customers or products.
- **Sale Order / Job number**: handwritten "Sale order" on the form. No sale order or job
  number exists in the data model.
- **Cust PO Number**: assets already carry a `purchase_order_number`; it is unchanged.
- **Inspection Date**: not annotated; the inspection's submitted/approved timestamps stand.
