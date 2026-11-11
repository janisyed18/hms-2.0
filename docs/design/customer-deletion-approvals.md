# Customer deletion: approval record

Status of the two decisions that had to be recorded before customer deletion can be enabled in DEV. Both are
**approved for DEV only** (2026-11-11, see below). This record is not legal sign-off, and nothing here approves
production.

Related: [design](customer-deletion-history.md) (sections 7, 10, 13, 14).

Deletion is still disabled in DEV (`CUSTOMER_DELETION_ENABLED` unset, `HISTORY_RETENTION_APPROVAL` empty) until a
separate change to enable it is reviewed and authorised. The approval itself authorises preparing the DEV-only
changes, not deploying them or enabling deletion.

## 1. Historical-certificate wording

**Status: APPROVED for DEV (2026-11-11).** The approved wording is the proposed text below. The code still carries
the older text until the alignment change (separate PR) merges.

Already specified and implemented: a certificate held by a COMPLETED customer-deletion archive (not an ordinary Archive Customer) is reported with
`historical: true` and `valid: false`; the customer name is withheld; the PDF is not publicly downloadable;
revoked, superseded and expired states keep their meaning.

Approved customer-facing wording:

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

The two differ. Aligning the code to the approved wording is a small separate change (the constant, plus any
test or screen that asserts the text). It is not part of this record.

| Field | Value |
|---|---|
| Approved wording (exact text) | The proposed wording above, unchanged |
| Approver (name and role) | Jani Syed, Senior Architect |
| Date | 2026-11-11 |
| Reference (ticket, email or minute) | https://github.com/janisyed18/hms-2.0/issues/125#issuecomment-6787691378 |

## 2. DEV retention

**Status: APPROVED for DEV only (2026-11-11).**

Approved for **DEV only**, which holds synthetic data. It matches what is deployed and what the recovery drill
(design section 14) exercised.

| Setting | Approved decision |
|---|---|
| Environment | DEV only |
| Data | Synthetic test data only |
| Retention | 30 days |
| S3 Object Lock mode | GOVERNANCE |
| Encryption | SSE-S3 |
| Production retention | **Not approved.** Needs business and legal approval; COMPLIANCE preferred once approved |

`HISTORY_RETENTION_APPROVAL` must name an actual approved decision: use the reference recorded below. It stays
empty in live DEV until the separate enablement change is authorised and deployed.

| Field | Value |
|---|---|
| Approved retention for DEV | 30 days, GOVERNANCE, SSE-S3, synthetic data only |
| Approver (name and role) | Jani Syed, Senior Architect |
| Date | 2026-11-11 |
| Reference to set in `HISTORY_RETENTION_APPROVAL` | https://github.com/janisyed18/hms-2.0/issues/125#issuecomment-6787691378 |

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
