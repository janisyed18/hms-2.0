"""Provisioning CLI and fail-closed startup validation of signing material."""

from __future__ import annotations

import datetime as dt
import stat
from pathlib import Path

import pytest

from hms_certificate.config import Settings
from hms_certificate.pki import (
    PkiError,
    cert_pem,
    create_root,
    issue_leaf,
    key_pem,
    load_certs,
    load_key,
    main,
    root_common_name,
    signer_common_name,
    validate_signer_material,
)
from hms_certificate.signing import PdfSigner, SigningDisabledError, build_signer

ORG = "Test Org"


def _init(tmp_path: Path) -> Path:
    out = tmp_path / "pki"
    assert (
        main(["init", "--environment", "dev", "--organization", ORG, "--out", str(out)])
        == 0
    )
    return out


def _settings(out: Path, **extra: object) -> Settings:
    return Settings(
        signing_cert_path=str(out / "signer.cert.pem"),
        signing_key_path=str(out / "signer.key.pem"),
        trust_anchor_path=str(out / "root-ca.cert.pem"),
        dev_autogenerate_signer=False,
        key_dir=out / "unused-key-dir",
        **extra,  # type: ignore[arg-type]
    )


def test_hierarchy_is_named_for_the_environment() -> None:
    assert root_common_name("dev") == "HMS DEV Root CA"
    assert signer_common_name("dev") == "HMS DEV Certificate Signer"


def test_init_writes_private_files_and_validates(tmp_path: Path) -> None:
    out = _init(tmp_path)
    for name in ("signer.key.pem", "root-ca.key.pem", "pki-signer.secret.json"):
        assert stat.S_IMODE((out / name).stat().st_mode) == 0o600
    check = [
        "check",
        "--cert", str(out / "signer.cert.pem"),
        "--key", str(out / "signer.key.pem"),
        "--anchor", str(out / "root-ca.cert.pem"),
    ]  # fmt: skip
    assert main(check) == 0
    leaf = load_certs((out / "signer.cert.pem").read_bytes())[0]
    assert "HMS DEV Certificate Signer" in leaf.subject.rfc4514_string()
    # The engine never receives the root key: it is not in the signer secret.
    assert "root" not in (out / "pki-signer.secret.json").read_text().lower()


def test_init_refuses_to_overwrite(tmp_path: Path) -> None:
    out = _init(tmp_path)
    assert main(["init", "--out", str(out)]) == 2


def test_renew_keeps_the_same_root_and_old_signer_stays_valid(tmp_path: Path) -> None:
    out = _init(tmp_path)
    renewed = tmp_path / "renewed"
    code = main(
        [
            "renew-leaf", "--organization", ORG, "--out", str(renewed),
            "--root-cert", str(out / "root-ca.cert.pem"),
            "--root-key", str(out / "root-ca.key.pem"),
        ]
    )  # fmt: skip
    assert code == 0
    assert (renewed / "root-ca.cert.pem").read_bytes() == (
        out / "root-ca.cert.pem"
    ).read_bytes()
    # No new root key is written by a renewal.
    assert not (renewed / "root-ca.key.pem").exists()
    root = load_certs((out / "root-ca.cert.pem").read_bytes())[0]
    for directory in (out, renewed):
        validate_signer_material(
            cert=load_certs((directory / "signer.cert.pem").read_bytes())[0],
            key=load_key((directory / "signer.key.pem").read_bytes()),
            anchor=root,
        )
    assert (renewed / "signer.cert.pem").read_bytes() != (
        out / "signer.cert.pem"
    ).read_bytes()


def test_engine_starts_signs_and_is_trusted_with_complete_material(
    tmp_path: Path,
) -> None:
    out = _init(tmp_path)
    signer = PdfSigner(_settings(out))
    assert signer.signer_common_name == "HMS DEV Certificate Signer"


def test_engine_never_autogenerates_when_explicit_material_is_missing(
    tmp_path: Path,
) -> None:
    key_dir = tmp_path / "keys"
    settings = Settings(
        signing_cert_path=str(tmp_path / "missing.cert.pem"),
        signing_key_path=str(tmp_path / "missing.key.pem"),
        dev_autogenerate_signer=True,  # even if left on, explicit paths win
        key_dir=key_dir,
    )
    with pytest.raises(SigningDisabledError):
        build_signer(settings)
    assert not key_dir.exists()


@pytest.mark.parametrize("missing", ["cert", "key"])
def test_half_configured_material_fails_instead_of_autogenerating(
    tmp_path: Path, missing: str
) -> None:
    out = _init(tmp_path)
    key_dir = tmp_path / "keys"
    settings = Settings(
        signing_cert_path="" if missing == "cert" else str(out / "signer.cert.pem"),
        signing_key_path="" if missing == "key" else str(out / "signer.key.pem"),
        dev_autogenerate_signer=True,
        key_dir=key_dir,
    )
    with pytest.raises(SigningDisabledError, match="together"):
        build_signer(settings)
    assert not key_dir.exists()


def test_no_material_and_autogenerate_off_fails_closed(tmp_path: Path) -> None:
    settings = Settings(dev_autogenerate_signer=False, key_dir=tmp_path / "keys")
    with pytest.raises(SigningDisabledError):
        build_signer(settings)
    assert not (tmp_path / "keys").exists()


def test_missing_trust_anchor_file_fails_closed(tmp_path: Path) -> None:
    out = _init(tmp_path)
    settings = _settings(out).model_copy(
        update={"trust_anchor_path": str(tmp_path / "gone.pem")}
    )
    with pytest.raises(SigningDisabledError, match="trust_anchor_path"):
        PdfSigner(settings)


def test_signer_from_a_different_root_is_refused(tmp_path: Path) -> None:
    out = _init(tmp_path / "a")
    other = _init(tmp_path / "b")
    settings = _settings(out).model_copy(
        update={"trust_anchor_path": str(other / "root-ca.cert.pem")}
    )
    with pytest.raises(PkiError, match="chain|signed by"):
        PdfSigner(settings)


def test_private_key_that_does_not_match_certificate_is_refused(
    tmp_path: Path,
) -> None:
    out = _init(tmp_path / "a")
    other = _init(tmp_path / "b")
    settings = _settings(out).model_copy(
        update={"signing_key_path": str(other / "signer.key.pem")}
    )
    with pytest.raises(PkiError, match="does not match"):
        PdfSigner(settings)


def test_expired_and_future_signers_are_refused() -> None:
    now = dt.datetime.now(dt.UTC)
    root_key, root = create_root(common_name="R", organization=ORG)
    expired_key, expired = issue_leaf(
        root_key=root_key, root_cert=root, common_name="S", organization=ORG,
        validity_days=10, now=now - dt.timedelta(days=100),
    )  # fmt: skip
    with pytest.raises(PkiError, match="expired"):
        validate_signer_material(cert=expired, key=expired_key, anchor=root)
    future_key, future = issue_leaf(
        root_key=root_key, root_cert=root, common_name="S", organization=ORG,
        now=now + dt.timedelta(days=30),
    )  # fmt: skip
    with pytest.raises(PkiError, match="not valid until"):
        validate_signer_material(cert=future, key=future_key, anchor=root)


def test_ca_certificate_cannot_be_used_as_the_signer() -> None:
    root_key, root = create_root(common_name="R", organization=ORG)
    with pytest.raises(PkiError):
        validate_signer_material(cert=root, key=root_key, anchor=root)


def test_garbage_material_is_refused(tmp_path: Path) -> None:
    out = _init(tmp_path)
    (out / "signer.cert.pem").write_text("not a certificate")
    with pytest.raises(PkiError):
        PdfSigner(_settings(out))


def test_pem_round_trip_helpers() -> None:
    key, cert = create_root(common_name="R", organization=ORG)
    assert load_certs(cert_pem(cert))[0] == cert
    assert key_pem(key).startswith(b"-----BEGIN PRIVATE KEY-----")
