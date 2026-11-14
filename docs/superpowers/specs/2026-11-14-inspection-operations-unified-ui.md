# Inspection Operations: one management area, honest filters, inspector-only field work

Branch `feature/inspection-operations-unified-ui`, PR #141. This records what the screen
promises now and why, so a reviewer can check the behaviour rather than re-derive it.

## 1. One management area

Inspection Operations used to render the booking panel and the inspection register as two
full-height sections of the same page. They are different objects — a booking is a visit,
an inspection is work on one asset — and showing both at once made the page read as two
screens stacked.

There is now one view at a time, chosen by a switch (`role="group"`, "Inspection
management view"):

- **Booking requests** — where anyone who can book or approve bookings lands.
- **Inspection records** — the register, and where an inspector or reviewer lands.

A link that names an inspection (`?view=inspections&inspection=<id>`) opens the register
whatever the role would otherwise land on, so shared links still work. `openInspections`
in the Playwright helpers waits for whichever view the role gets;
`openInspectionRecords` switches to the register for the flows that work in it.

## 2. The booking register is a table

Bookings are a register, so they are shown as one: **Inspection details · Schedule &
location · Assigned inspector · Status · Actions**, one row per booking, built to the
approved mock-up.

- The first column names the site, the customer and the booking's own reference
  (`REF: HMS-…`, the last ten characters of its id, so searching for what is printed
  finds the booking).
- The second gives the time in the site's own zone, the place as `city, state`, and what
  is booked.
- Status sits behind an explicit "Status" label with a one-line caption, and a pending
  reschedule adds who asked for it.
- Actions are the ones that state allows: **Assign inspector** on a new request,
  **Change inspector** on a confirmed one, and a menu for what changes a booking already
  agreed. A rejected or cancelled booking offers nothing.

Under the table: rows per page, the range (`1 – 10 of 24 bookings`) and page numbers.
Paging asks the server for that page; nothing is narrowed on the client.

Three things the table needed that are easy to get wrong:

- A `<td>` laid out as flex or grid **leaves the table's column algorithm**, and its
  content lands at the table's left edge instead of in its column. Each cell keeps
  `display: table-cell` and its layout lives on a wrapper inside it.
- The base stylesheet gives every `th`/`td` a fixed height and one clipped, ellipsised
  line. This table opts out of all three so a site name, a time and an email can wrap.
- The Actions menu is **React's state, not a `<details>`**. As an uncontrolled
  `<details>`, every reload of the list — an approval's refresh, the inspector roster
  arriving — reset it, so the menu shut itself the moment something else finished.

## 3. Filters that mean what they say

Every booking filter is now a server query, not a second pass over the page already
loaded. `GET /api/v1/inspection-bookings` takes `status`, `customer_id`, `location_id`,
`asset_id`, `search` and `has_pending_change`; all of them narrow the principal's visible
set in SQL, after customer scoping and inspector-assignment scoping, so paging through a
filtered list gives the matching bookings and `total` counts the matches.

- "Reschedule requested" is not a booking status. It maps to `has_pending_change=true`.
- `search` matches the customer's name or code, the site name, any booked asset's number,
  name or tag, and the booking reference.
- The line under the list reads `<total> matching bookings · <n> shown` — the server's
  count first, then what is on this page. The tiles above count what is on the page, and
  the comment in `InspectionsWorkspace` says so.
- The dropdowns keep every customer, site and asset seen in any load so far. Rebuilding
  them from the current, already-narrowed page would drop the option needed to widen the
  search again.

### Status tabs

`GET /inspection-bookings` returns `status_counts` alongside the page: how many bookings
each tab holds, counted over the same filtered set with the status filter itself left
off. Picking a tab therefore does not change what the other tabs say is waiting behind
them, and the tiles, the tabs and the range under the table all quote the same source.

"Reschedule requested" overlaps "Approved" in the data — a booking waiting on a
reschedule is still approved — so it is counted on its own and taken back out of the
approved tally, which is what the tabs mean by those words.

## 4. Statuses, origins and actions

Status reads **Requested / Approved / Rejected / Reschedule requested / Cancelled**, each
behind an explicit "Status" label.

"Requested by" comes from the stored requester. `InspectionAppointmentChangeRequest` has
always recorded `requested_by_user_id`; the API now resolves that to the user's role and
reports it as `requested_by_role`, and the card maps `CUSTOMER_USER` → Customer,
`HMS_ADMIN`/`SUPER_ADMIN` → Admin, `INSPECTOR` → Inspector. A role it has no word for, or
an identity with no user row, shows nothing at all. The old label was inferred from who
had to approve next, which is not the same question.

**Inspector-originated rescheduling is not supported, and this change does not add it.**
`POST /inspection-bookings/{id}/change-requests` requires `inspection:book`, which the
`INSPECTOR` role does not hold. Granting it would widen a permission, so it is left to a
decision of its own; the label above is already correct if such a request ever exists.

Actions follow the state:

| State | Available |
| --- | --- |
| Requested | Assign inspector, Assign & approve, Decline |
| Approved and confirmed | Change inspector (approvers), Actions → Request reschedule, Cancel booking |
| Reschedule pending | The request's time and origin, plus Approve reschedule (admin) or Confirm reschedule (customer). Reassignment and a second reschedule are refused, with the reason on screen |
| Rejected, cancelled | None |

The verb stays "Decline" because the confirmation dialog, the toast and the scheduling
drawer all say it; the status says "Rejected" because that is what the API stores. A
single rename across both is worth doing, and is not part of this change.

Availability quotes, conflict validation, active-inspector eligibility, the reassignment
dialog and the server-side concurrency locks are untouched.

### Choosing an inspector

Assigning, reassigning and approving a reschedule all pick one inspector in the same
dialog. Only a **reassignment** can be verified up front: the availability endpoint
answers for a confirmed appointment, and a booking still awaiting approval has none. So
the dialog checks and refuses to save an unverified choice when reassigning, and when
assigning it claims nothing — the server validates on approval and a refusal is shown in
place, with the choice kept.

## 5. Admins manage, inspectors inspect

Field execution is inspector-only, and only on the inspector's own confirmed assignment.
`_require_inspection_write` refuses anyone who is not inspector-scoped, so a Super Admin
is refused `create`, `start`, `PATCH`, `submit` and `rework` even though it holds every
permission. `_get_inspection_or_404` already limits an inspector to inspections on their
approved, confirmed bookings.

Review is separate: `_require_inspection_review` lets an HMS admin or a certificate
approver approve or reject submitted work, and gives neither of them field access nor the
certificate-approval permission. The Staff app mirrors this with `canPerformInspections`,
which is a convenience, not the control.

`backend/tests/test_inspection_lifecycle_postgres.py` used a Super Admin as the field
worker, which the gate now refuses. The fixture builds a real inspector with an approved
booking, a confirmed appointment and the booked asset, and every race assertion
(`[200, 409]`, one audit event, one outbox event, the audit chain) is unchanged.

## 6. The certificate-service failure

`test_pki.py::test_init_writes_private_files_and_validates` asserted
`"root" not in secret.lower()` over a JSON file that is mostly base64 PEM. A run of base64
spells "root" in some mix of cases roughly once in three hundred secrets — measured at
0.32% over the real key material — and the check tested nothing about the key. It is
unrelated to this branch: the branch touches no file in `services/certificate`, and the
job has failed once in the last twenty-five CI runs.

The assertion is now stronger and deterministic: the secret holds exactly
`certificate_pem` and `private_key_pem`, they are byte-for-byte the signer's own files,
and neither is the root's. Writing the root key into the secret fails it.
