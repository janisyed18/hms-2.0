"""gRPC servicer: render + sign a certificate in one call."""

from __future__ import annotations

import logging

import grpc

from hms_certificate.config import Settings
from hms_certificate.config import settings as default_settings
from hms_certificate.domain import CertificateData, compute_verification_hash
from hms_certificate.proto import certificate_pb2 as pb
from hms_certificate.proto import certificate_pb2_grpc as pb_grpc
from hms_certificate.rendering import render_certificate
from hms_certificate.signing import NullSigner, PdfSigner, build_signer

logger = logging.getLogger("hms_certificate.service")


class CertificateEngineServicer(pb_grpc.CertificateEngineServicer):
    def __init__(
        self,
        settings: Settings | None = None,
        signer: PdfSigner | NullSigner | None = None,
    ) -> None:
        self._settings = settings or default_settings
        # The signer is expensive to construct (loads key material); build once.
        self._signer = signer if signer is not None else build_signer(self._settings)

    def Render(  # noqa: N802 - gRPC method name
        self,
        request: pb.RenderRequest,
        context: grpc.ServicerContext,
    ) -> pb.RenderResponse:
        if not request.HasField("certificate"):
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "certificate is required")
        data = CertificateData.from_proto(request.certificate)
        if not data.certificate_number:
            context.abort(
                grpc.StatusCode.INVALID_ARGUMENT, "certificate_number is required"
            )

        verification_hash = compute_verification_hash(data)
        try:
            rendered = render_certificate(data, verification_hash, self._settings)
            signed = self._signer.sign(rendered.pdf)
        except Exception as exc:  # pragma: no cover - surfaced to caller
            logger.exception("render failed for %s", data.certificate_number)
            context.abort(grpc.StatusCode.INTERNAL, f"render failed: {exc}")

        logger.info(
            "rendered certificate number=%s pages=%d signed=%s hash=%s",
            data.certificate_number,
            rendered.page_count,
            signed.signed,
            verification_hash[:12],
        )
        return pb.RenderResponse(
            pdf=signed.pdf,
            verification_hash=verification_hash,
            page_count=rendered.page_count,
            signer_common_name=signed.signer_common_name,
            signed_at=signed.signed_at,
            signed=signed.signed,
        )
