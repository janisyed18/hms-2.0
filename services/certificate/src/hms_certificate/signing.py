"""PDF signing via pyHanko (PAdES / X.509).

Produces a PAdES-baseline (B-B) signature with a visible signature block on the
last page. The signer is loaded once and reused. Signing can be disabled
(``signing_enabled=false``) for environments that only need rendering.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.sign import signers
from pyhanko.sign.fields import SigFieldSpec, SigSeedSubFilter, append_signature_field

from hms_certificate.config import Settings
from hms_certificate.dev_ca import SignerMaterial, ensure_dev_signer

_SIG_FIELD_NAME = "CertificateSignature"


@dataclass(frozen=True)
class SignatureResult:
    pdf: bytes
    signer_common_name: str
    signed_at: str
    signed: bool


class SigningDisabledError(RuntimeError):
    """Raised when signing is requested but no signer material is configured."""


class NullSigner:
    """No-op signer used when signing is disabled."""

    signed = False

    def sign(self, pdf: bytes) -> SignatureResult:  # noqa: D401
        return SignatureResult(
            pdf=pdf,
            signer_common_name="",
            signed_at="",
            signed=False,
        )


class PdfSigner:
    """Loads signer material once and signs PDF byte streams."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        material = _resolve_signer_paths(settings)
        passphrase = (
            settings.signing_key_passphrase.encode("utf-8")
            if settings.signing_key_passphrase
            else None
        )
        signer = signers.SimpleSigner.load(
            str(material.key_path),
            str(material.cert_path),
            ca_chain_files=[str(p) for p in material.chain_paths],
            key_passphrase=passphrase,
        )
        if signer is None:  # pragma: no cover - defensive
            raise SigningDisabledError("failed to load signing material")
        self._signer = signer
        self._common_name = _common_name(signer)

    @property
    def signer_common_name(self) -> str:
        return self._common_name

    def sign(self, pdf: bytes) -> SignatureResult:
        writer = IncrementalPdfFileWriter(BytesIO(pdf))
        # Visible signature block: bottom-left of the last page (PDF points).
        append_signature_field(
            writer,
            SigFieldSpec(
                sig_field_name=_SIG_FIELD_NAME,
                on_page=-1,
                box=(40, 40, 300, 108),
            ),
        )
        signed_at = dt.datetime.now(dt.UTC)
        meta = signers.PdfSignatureMetadata(
            field_name=_SIG_FIELD_NAME,
            reason="Certifies hose assembly test & inspection results",
            location=self._settings.issuer_address,
            subfilter=SigSeedSubFilter.PADES,
            embed_validation_info=False,
        )
        out = signers.sign_pdf(writer, meta, signer=self._signer)
        return SignatureResult(
            pdf=out.getvalue(),
            signer_common_name=self._common_name,
            signed_at=signed_at.isoformat().replace("+00:00", "Z"),
            signed=True,
        )


def build_signer(settings: Settings) -> PdfSigner | NullSigner:
    if not settings.signing_enabled:
        return NullSigner()
    return PdfSigner(settings)


def _resolve_signer_paths(settings: Settings) -> SignerMaterial:
    if settings.signing_cert_path and settings.signing_key_path:
        cert_path = Path(settings.signing_cert_path)
        key_path = Path(settings.signing_key_path)
        if not cert_path.exists() or not key_path.exists():
            raise SigningDisabledError(
                "configured signing_cert_path / signing_key_path do not exist"
            )
        chain: tuple[Path, ...] = ()
        if settings.signing_chain_path:
            chain_path = Path(settings.signing_chain_path)
            if not chain_path.exists():
                raise SigningDisabledError(
                    "configured signing_chain_path does not exist"
                )
            chain = (chain_path,)
        return SignerMaterial(cert_path=cert_path, key_path=key_path, chain_paths=chain)
    if settings.dev_autogenerate_signer:
        return ensure_dev_signer(
            settings.key_dir,
            common_name=f"{settings.issuer_name} Certificate Signer",
            organization=settings.issuer_name,
        )
    raise SigningDisabledError(
        "signing enabled but no signer configured and dev autogeneration is off"
    )


def _common_name(signer: signers.SimpleSigner) -> str:
    cert = signer.signing_cert
    try:
        values = cert.subject.native.get("common_name")
        if isinstance(values, list):
            return str(values[0]) if values else ""
        return str(values) if values else ""
    except Exception:  # pragma: no cover - defensive
        return ""
