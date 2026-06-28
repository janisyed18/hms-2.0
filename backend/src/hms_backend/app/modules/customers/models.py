from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from hms_backend.app.models.base import Base, SyncableMixin


class Customer(SyncableMixin, Base):
    __tablename__ = "customers"

    code: Mapped[str] = mapped_column(String(40), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
