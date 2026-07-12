"""Development-only seeding of one login account per HMS role (Task 6).

Creates the six approved role accounts with unique, hashed temporary passwords so
a developer can exercise the full browser auth flow (forced password change + MFA
enrollment) end to end. Refuses to run against production-like environments and
never writes credentials to a file — the caller prints them once to the terminal.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from hms_backend.app.core.passwords import generate_temporary_password, hash_password
from hms_backend.app.core.rbac import Role
from hms_backend.app.modules.customers.models import Customer
from hms_backend.app.modules.identity.models import (
    AccountStatus,
    BrowserAuthChallenge,
    BrowserRefreshSession,
    MfaRecoveryCode,
    User,
)

PRODUCTION_LIKE_ENVIRONMENTS = frozenset({"production", "prod", "staging"})

_SEED_CUSTOMER_CODE = "SEED-AUTH"
_SEED_CUSTOMER_NAME = "Auth Seed Customer"

# The approved role -> address mapping (spec Task 6).
AUTH_TEST_ACCOUNTS: tuple[tuple[str, Role], ...] = (
    ("super.admin@example.test", Role.SUPER_ADMIN),
    ("hms.admin@example.test", Role.HMS_ADMIN),
    ("inspector@example.test", Role.INSPECTOR),
    ("assembly@example.test", Role.ASSEMBLY),
    ("reviewer@example.test", Role.REVIEWER),
    ("customer.user@example.test", Role.CUSTOMER_USER),
)


@dataclass(frozen=True)
class SeededAccount:
    email: str
    role: Role
    customer_id: str | None
    temporary_password: str | None  # None when an existing row was left untouched
    created: bool


class ProductionSeedError(RuntimeError):
    """Raised when seeding is attempted in a production-like environment."""


async def _ensure_synthetic_customer(session: AsyncSession) -> str:
    customer = await session.scalar(
        select(Customer).where(Customer.code == _SEED_CUSTOMER_CODE)
    )
    if customer is None:
        customer = Customer(code=_SEED_CUSTOMER_CODE, name=_SEED_CUSTOMER_NAME)
        session.add(customer)
        await session.flush()
    return customer.id


async def seed_auth_test_accounts(
    session: AsyncSession,
    *,
    environment: str,
    reset_existing: bool = False,
) -> list[SeededAccount]:
    """Create (or optionally rotate) one account per role. Idempotent for account
    rows: existing accounts keep their password unless ``reset_existing`` is set."""
    if environment.strip().lower() in PRODUCTION_LIKE_ENVIRONMENTS:
        raise ProductionSeedError(
            f"Refusing to seed auth test accounts in '{environment}'."
        )

    customer_id = await _ensure_synthetic_customer(session)
    results: list[SeededAccount] = []
    for email, role in AUTH_TEST_ACCOUNTS:
        normalised = email.strip().lower()
        scoped_customer = customer_id if role is Role.CUSTOMER_USER else None
        user = await session.scalar(select(User).where(User.email == normalised))
        if user is None:
            temporary_password = generate_temporary_password()
            session.add(
                User(
                    oidc_subject=f"seed:{role.value.lower()}",
                    email=normalised,
                    role=role.value,
                    customer_id=scoped_customer,
                    password_hash=hash_password(temporary_password),
                    must_change_password=True,
                    account_status=AccountStatus.ACTIVE.value,
                    email_verified=True,
                )
            )
            results.append(
                SeededAccount(
                    normalised, role, scoped_customer, temporary_password, True
                )
            )
        elif reset_existing:
            temporary_password = generate_temporary_password()
            user.password_hash = hash_password(temporary_password)
            user.must_change_password = True
            user.password_changed_at = None
            user.mfa_enabled = False
            user.mfa_secret_ciphertext = None
            user.mfa_secret_key_version = None
            user.mfa_last_accepted_step = None
            user.failed_password_attempts = 0
            user.failed_mfa_attempts = 0
            user.locked_until = None
            user.account_status = AccountStatus.ACTIVE.value
            for model in (
                BrowserAuthChallenge,
                BrowserRefreshSession,
                MfaRecoveryCode,
            ):
                await session.execute(delete(model).where(model.user_id == user.id))
            results.append(
                SeededAccount(
                    normalised, role, user.customer_id, temporary_password, False
                )
            )
        else:
            results.append(
                SeededAccount(normalised, role, user.customer_id, None, False)
            )
    await session.flush()
    return results


def format_credentials_table(accounts: list[SeededAccount]) -> str:
    """Render a plain-text credential table for one-time terminal display."""
    header = ("Email", "Role", "Temporary password", "Customer")
    rows = [
        (
            account.email,
            account.role.value,
            account.temporary_password
            or "(unchanged — pass --reset-existing to rotate)",
            account.customer_id or "-",
        )
        for account in accounts
    ]
    widths = [
        max(len(header[i]), *(len(row[i]) for row in rows)) for i in range(len(header))
    ]

    def _line(cells: tuple[str, ...]) -> str:
        return "  ".join(cell.ljust(widths[i]) for i, cell in enumerate(cells))

    separator = "  ".join("-" * width for width in widths)
    return "\n".join(
        [
            _line(header),
            separator,
            *(_line(row) for row in rows),
            "",
            "Each account must complete a real password change and MFA enrollment "
            "on first sign-in.",
        ]
    )
