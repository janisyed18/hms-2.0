"""gRPC server entry point for the certificate engine.

Run with::

    python -m hms_certificate.server

or via the console script ``hms-certificate-engine`` (see pyproject).
"""

from __future__ import annotations

import logging
import signal
from concurrent import futures

import grpc
from grpc_health.v1 import health, health_pb2, health_pb2_grpc
from grpc_reflection.v1alpha import reflection

from hms_certificate.config import Settings
from hms_certificate.config import settings as default_settings
from hms_certificate.proto import certificate_pb2 as pb
from hms_certificate.proto import certificate_pb2_grpc as pb_grpc
from hms_certificate.service import CertificateEngineServicer

logger = logging.getLogger("hms_certificate.server")

_SERVICE_NAME = pb.DESCRIPTOR.services_by_name["CertificateEngine"].full_name


def build_server(settings: Settings | None = None) -> grpc.Server:
    settings = settings or default_settings
    server = grpc.server(
        futures.ThreadPoolExecutor(max_workers=settings.max_workers),
        options=[
            ("grpc.max_send_message_length", 16 * 1024 * 1024),
            ("grpc.max_receive_message_length", 4 * 1024 * 1024),
        ],
    )
    pb_grpc.add_CertificateEngineServicer_to_server(
        CertificateEngineServicer(settings), server
    )

    # Standard gRPC health + reflection so orchestrators and grpcurl work.
    health_servicer = health.HealthServicer()
    health_pb2_grpc.add_HealthServicer_to_server(health_servicer, server)
    health_servicer.set(_SERVICE_NAME, health_pb2.HealthCheckResponse.SERVING)
    health_servicer.set("", health_pb2.HealthCheckResponse.SERVING)

    reflection.enable_server_reflection(
        (_SERVICE_NAME, reflection.SERVICE_NAME), server
    )

    server.add_insecure_port(settings.address)
    return server


def serve(settings: Settings | None = None) -> None:
    settings = settings or default_settings
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    server = build_server(settings)
    server.start()
    logger.info("certificate engine listening on %s", settings.address)

    # Graceful shutdown on SIGTERM/SIGINT.
    def _handle(signum, frame):  # noqa: ANN001
        logger.info("received signal %s, shutting down", signum)
        server.stop(settings.shutdown_grace_seconds)

    signal.signal(signal.SIGTERM, _handle)
    signal.signal(signal.SIGINT, _handle)
    server.wait_for_termination()


if __name__ == "__main__":
    serve()
