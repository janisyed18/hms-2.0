from sqlalchemy import Boolean, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from hms_backend.app.core.rbac import Role
from hms_backend.app.models.base import Base, SyncableMixin


class User(SyncableMixin, Base):
    __tablename__ = "users"

    oidc_subject: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    email: Mapped[str] = mapped_column(String(320), nullable=False, unique=True)
    # Argon2 password hash for local (bearer) login; null for OIDC-only users.
    # Never exposed in any API response, grid or form.
    password_hash: Mapped[str | None] = mapped_column(String(200), nullable=True)
    first_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    last_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    role: Mapped[str] = mapped_column(
        String(40),
        nullable=False,
        default=Role.CUSTOMER_USER.value,
    )
    customer_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("customers.id"),
        nullable=True,
        index=True,
    )
    # Contact verification for notifications (spec §9). A normalised E.164 phone
    # and per-address verification flags gate email/SMS delivery.
    email_verified: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    phone_e164: Mapped[str | None] = mapped_column(String(20), nullable=True)
    phone_verified: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
