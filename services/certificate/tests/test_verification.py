from __future__ import annotations

import dataclasses

from hms_certificate.domain import (
    CertificateData,
    EndConfig,
    canonical_payload,
    compute_verification_hash,
)


def test_hash_is_deterministic(sample_data: CertificateData) -> None:
    assert compute_verification_hash(sample_data) == compute_verification_hash(
        sample_data
    )


def test_hash_is_64_char_hex(sample_data: CertificateData) -> None:
    digest = compute_verification_hash(sample_data)
    assert len(digest) == 64
    int(digest, 16)  # raises if not hex


def test_content_change_changes_hash(sample_data: CertificateData) -> None:
    baseline = compute_verification_hash(sample_data)
    mutated = dataclasses.replace(sample_data, asset_number="HA-99999")
    assert compute_verification_hash(mutated) != baseline


def test_status_change_does_not_change_hash(sample_data: CertificateData) -> None:
    # Lifecycle status is deliberately excluded so revoke/supersede keep the hash.
    revoked = dataclasses.replace(sample_data, status="REVOKED")
    assert compute_verification_hash(revoked) == compute_verification_hash(sample_data)


def test_end_ordering_does_not_change_hash(sample_data: CertificateData) -> None:
    reordered = dataclasses.replace(
        sample_data, ends=tuple(reversed(sample_data.ends))
    )
    assert compute_verification_hash(reordered) == compute_verification_hash(
        sample_data
    )


def test_canonical_payload_excludes_volatile(sample_data: CertificateData) -> None:
    payload = canonical_payload(sample_data)
    assert "status" not in payload
    assert "verify_url" not in payload
    assert payload["certificate_number"] == "CERT-2026-000123"
    assert payload["scheme"] == "hms-cert-v1"


# Pinned canonical-hash vector. The backend's verification module must reproduce
# this exact digest for the same inputs, or the public verify endpoint will
# disagree with issued certificates.
KNOWN_VECTOR_HASH = "c36c17cddbaca71684b57f161b465c263d7dbd2394f97ebd15bd4931a36bce50"


def test_known_vector() -> None:
    data = CertificateData(
        certificate_number="CERT-1",
        certificate_version=1,
        status="ISSUED",
        issued_at="2026-01-01T00:00:00Z",
        public_token="tok",
        ends=(EndConfig("A"),),
    )
    assert compute_verification_hash(data) == KNOWN_VECTOR_HASH
