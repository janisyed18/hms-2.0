"""Runtime configuration for the certificate engine.

All values can be overridden via environment variables (prefix ``HMS_CERT_``) or
a local ``.env`` file. In production the signing key material must come from OCI
Vault / a mounted secret — never from a committed file.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# Directory used only for locally generated development signing material. It is
# git-ignored; production deployments point HMS_CERT_SIGNING_* at real secrets.
_DEFAULT_KEY_DIR = Path.home() / ".hms" / "certificate-signing"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="HMS_CERT_",
        env_file=".env",
        env_file_encoding="utf-8",
    )

    # gRPC server
    host: str = "127.0.0.1"
    port: int = 50051
    max_workers: int = 8
    shutdown_grace_seconds: float = 10.0

    # Signing
    signing_enabled: bool = True
    # PEM files for the signing certificate and its private key. When both are
    # empty and ``dev_autogenerate_signer`` is true, a self-signed development
    # signer is created under ``key_dir``.
    signing_cert_path: str = ""
    signing_key_path: str = ""
    signing_chain_path: str = ""  # PEM bundle of intermediate/root CA certs
    signing_key_passphrase: str = ""
    dev_autogenerate_signer: bool = True
    key_dir: Path = _DEFAULT_KEY_DIR

    # Issuer identity shown on the certificate and in the signature.
    issuer_name: str = "BAT Engineering Pty Ltd"
    issuer_address: str = "Melbourne, Victoria, Australia"
    issuer_contact: str = "certificates@batengineering.example"
    issuer_identifier: str = "ABN 00 000 000 000"

    field_title: str = Field(
        default="HOSE ASSEMBLY TEST & INSPECTION CERTIFICATE",
        description="Main heading printed on the certificate.",
    )

    @property
    def address(self) -> str:
        return f"{self.host}:{self.port}"


settings = Settings()
