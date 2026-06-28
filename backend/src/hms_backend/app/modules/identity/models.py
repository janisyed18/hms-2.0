from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from hms_backend.app.core.rbac import Role
from hms_backend.app.models.base import Base, SyncableMixin


class User(SyncableMixin, Base):
    __tablename__ = "users"

    oidc_subject: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    email: Mapped[str] = mapped_column(String(320), nullable=False, unique=True)
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
