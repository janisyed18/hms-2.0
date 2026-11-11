# Customer deletion: approval record

Status of the two decisions that must be recorded before customer deletion can be enabled in DEV. Both are
**pending**. Nothing here is an approval until the approver fills in the fields below. Engineering has not
invented approvers, dates or references, and this record is not legal sign-off.

Related: [design](customer-deletion-history.md) (sections 7, 10, 13, 14).

Deletion stays disabled in DEV (`CUSTOMER_DELETION_ENABLED` unset, `HISTORY_RETENTION_APPROVAL` empty) until
both decisions are approved here **and** a separate change to enable it is authorised.

## 1. Historical-certificate wording

**Status: PENDING product-owner approval.**

Already specified and implemented: a certificate held by a COMPLETED customer-deletion archive (not an ordinary Archive Customer) is reported with
`historical: true` and `valid: false`; the customer name is withheld; the PDF is not publicly downloadable;
revoked, superseded and expired states keep their meaning.

Proposed customer-facing wording:

> **Historical Certificate**
>
> This certificate is retained for historical verification only because the associated customer record has
> been removed from active HMS.
>
> This certificate is not valid for current operational use. Existing expiry, revocation or supersession
> information remains applicable.
>
> Customer details and the original certificate PDF are not publicly available.

Wording currently in the code (`HISTORICAL_MESSAGE` in `backend/src/hms_backend/app/api/public.py`):

> This certificate was originally issued by HMS. The associated customer has since been removed from active
> records. This certificate is retained for historical verification and is not valid for current operational use.

The two differ. If the proposed wording is approved, aligning the code to it is a small separate change (the
constant, plus any test or screen that asserts the text). It is not part of this record.

| Field | Value |
|---|---|
| Approved wording (exact text) | _pending_ |
| Approver (name and role) | _pending_ |
| Date | _pending_ |
| Reference (ticket, email or minute) | _pending_ |

## 2. DEV retention

**Status: PENDING approval by the responsible product or business owner.**

Engineering recommendation: approve the following for **DEV only**, which holds synthetic data. It matches what
is deployed and what the recovery drill (design section 14) exercised.

| Setting | Proposed decision |
|---|---|
| Environment | DEV only |
| Data | Synthetic test data only |
| Retention | 30 days |
| S3 Object Lock mode | GOVERNANCE |
| Encryption | SSE-S3 |
| Production retention | **Not approved.** Needs business and legal approval; COMPLIANCE preferred once approved |

`HISTORY_RETENTION_APPROVAL` must name an actual approved decision. Populate it only after the fields below are
filled in, using the reference recorded here. Do not use this recommendation, or a made-up ticket, in its place.

| Field | Value |
|---|---|
| Approved retention for DEV | _pending_ |
| Approver (name and role) | _pending_ |
| Date | _pending_ |
| Reference to set in `HISTORY_RETENTION_APPROVAL` | _pending_ |

## What is already complete (for context, not approvals)

| Item | State |
|---|---|
| DEV history bucket (versioning, Object Lock, SSE-S3, deny policy) | Applied and verified |
| Backend with migration `20261110_0029` | Deployed to DEV |
| Version-pinned write, read and integrity against the real bucket | Passed |
| Recovery drill across both stores (snapshot restore) | Passed, recorded in design section 14 |
| Customer deletion in DEV | Disabled |

## Not covered by this record

Production retention and mode, cross-region replication, bucket-loss recovery, and the enablement change itself.
