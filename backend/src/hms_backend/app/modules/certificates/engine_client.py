"""Async gRPC client for the certificate engine (services/certificate)."""

from __future__ import annotations

from dataclasses import dataclass

import grpc  # type: ignore[import-untyped]

from hms_backend.app.core.config import settings
from hms_backend.app.modules.certificates.enginepb import certificate_pb2 as pb
from hms_backend.app.modules.certificates.enginepb import (
    certificate_pb2_grpc as pb_grpc,
)


class CertificateEngineError(RuntimeError):
    """Raised when the certificate engine is unreachable or returns an error."""


@dataclass(frozen=True)
class RenderedCertificate:
    pdf: bytes
    verification_hash: str
    page_count: int
    signer_common_name: str
    signed_at: str
    signed: bool


class CertificateEngineClient:
    def __init__(self, address: str, timeout: float) -> None:
        self._address = address
        self._timeout = timeout

    async def render(self, certificate: pb.CertificateData) -> RenderedCertificate:
        try:
            async with grpc.aio.insecure_channel(self._address) as channel:
                stub = pb_grpc.CertificateEngineStub(channel)  # type: ignore[no-untyped-call]
                response = await stub.Render(
                    pb.RenderRequest(certificate=certificate),
                    timeout=self._timeout,
                )
        except grpc.aio.AioRpcError as exc:  # pragma: no cover - network path
            raise CertificateEngineError(
                f"certificate engine call failed "
                f"({exc.code().name}): {exc.details()}"
            ) from exc

        return RenderedCertificate(
            pdf=response.pdf,
            verification_hash=response.verification_hash,
            page_count=response.page_count,
            signer_common_name=response.signer_common_name,
            signed_at=response.signed_at,
            signed=response.signed,
        )


_client: CertificateEngineClient | None = None


def get_certificate_engine() -> CertificateEngineClient:
    global _client
    if _client is None:
        _client = CertificateEngineClient(
            settings.certificate_service_address,
            settings.certificate_service_timeout_seconds,
        )
    return _client
