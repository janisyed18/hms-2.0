"""PKI building blocks shared by the engine's startup checks and the provisioning CLI.

Two audiences, one module so they cannot drift:

* the **engine** calls :func:`validate_signer_material` at boot and refuses to start
  on missing, expired, mismatched or untrusted signing material;
* an **administrator** runs ``python -m hms_certificate.pki`` (``init`` /
  ``renew-leaf`` / ``check``) on a trusted workstation. It only writes local files;
  loading them into AWS Secrets Manager is a separate, reviewable step (see
  ``docs/aws/dev-signing-pki.md``). Nothing here talks to a network.

The root CA private key is only ever handled by the provisioning CLI, never by the
running engine.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

_DOCUMENT_SIGNING_EKU = x509.ObjectIdentifier("1.3.6.1.5.5.7.3.36")
_MIN_DAYS_REMAINING_WARNING = 30


class PkiError(RuntimeError):
    """Signing material is missing, expired, inconsistent or untrusted."""


def root_common_name(environment: str) -> str:
    return f"HMS {environment.upper()} Root CA"


def signer_common_name(environment: str) -> str:
    return f"HMS {environment.upper()} Certificate Signer"


def _name(common_name: str, organization: str) -> x509.Name:
    return x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, common_name),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, organization),
        ]
    )


def create_root(
    *,
    common_name: str,
    organization: str,
    validity_days: int = 3650,
    now: dt.datetime | None = None,
) -> tuple[rsa.RSAPrivateKey, x509.Certificate]:
    now = now or dt.datetime.now(dt.UTC)
    key = rsa.generate_private_key(public_exponent=65537, key_size=4096)
    name = _name(common_name, organization)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        .not_valid_after(now + dt.timedelta(days=validity_days))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=False,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(key.public_key()),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    return key, cert


def issue_leaf(
    *,
    root_key: rsa.RSAPrivateKey,
    root_cert: x509.Certificate,
    common_name: str,
    organization: str,
    validity_days: int = 825,
    now: dt.datetime | None = None,
) -> tuple[rsa.RSAPrivateKey, x509.Certificate]:
    now = now or dt.datetime.now(dt.UTC)
    key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    builder = (
        x509.CertificateBuilder()
        .subject_name(
            x509.Name(
                [
                    x509.NameAttribute(NameOID.COMMON_NAME, common_name),
                    x509.NameAttribute(NameOID.ORGANIZATION_NAME, organization),
                    x509.NameAttribute(
                        NameOID.ORGANIZATIONAL_UNIT_NAME, "Certificate Engine"
                    ),
                ]
            )
        )
        .issuer_name(root_cert.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        .not_valid_after(now + dt.timedelta(days=validity_days))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=True,  # non-repudiation
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.ExtendedKeyUsage(
                [ExtendedKeyUsageOID.EMAIL_PROTECTION, _DOCUMENT_SIGNING_EKU]
            ),
            critical=False,
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(root_key.public_key()),
            critical=False,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(key.public_key()),
            critical=False,
        )
    )
    return key, builder.sign(root_key, hashes.SHA256())


def cert_pem(cert: x509.Certificate) -> bytes:
    return cert.public_bytes(serialization.Encoding.PEM)


def key_pem(key: rsa.RSAPrivateKey) -> bytes:
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )


def _spki(public_key: object) -> bytes:
    return public_key.public_bytes(  # type: ignore[attr-defined,no-any-return]
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )


@dataclass(frozen=True)
class SignerReport:
    subject: str
    not_after: dt.datetime
    days_remaining: int
    issuer: str


def _in_validity(cert: x509.Certificate, now: dt.datetime, label: str) -> None:
    if now < cert.not_valid_before_utc:
        raise PkiError(
            f"{label} is not valid until {cert.not_valid_before_utc:%Y-%m-%d}"
        )
    if now > cert.not_valid_after_utc:
        raise PkiError(f"{label} expired on {cert.not_valid_after_utc:%Y-%m-%d}")


def validate_signer_material(
    *,
    cert: x509.Certificate,
    key: object,
    chain: tuple[x509.Certificate, ...] = (),
    anchor: x509.Certificate | None = None,
    now: dt.datetime | None = None,
) -> SignerReport:
    """Raise :class:`PkiError` unless the signer is usable and (if ``anchor``) trusted.

    Checks the private key belongs to the certificate, the certificate is a
    non-CA signing certificate inside its validity window, and, when a trust
    anchor is supplied, that it chains to exactly that anchor.
    """
    now = now or dt.datetime.now(dt.UTC)
    if _spki(key.public_key()) != _spki(cert.public_key()):  # type: ignore[attr-defined]
        raise PkiError("the signing private key does not match the signing certificate")
    _in_validity(cert, now, "the signing certificate")
    try:
        basic = cert.extensions.get_extension_for_class(x509.BasicConstraints).value
        if basic.ca:
            raise PkiError("the signing certificate is a CA certificate")
    except x509.ExtensionNotFound:
        pass
    try:
        usage = cert.extensions.get_extension_for_class(x509.KeyUsage).value
        if not (usage.digital_signature or usage.content_commitment):
            raise PkiError("the signing certificate is not permitted to sign documents")
    except x509.ExtensionNotFound:
        pass

    if anchor is not None:
        _chain_to_anchor(cert, chain, anchor, now)
    remaining = (cert.not_valid_after_utc - now).days
    return SignerReport(
        subject=cert.subject.rfc4514_string(),
        not_after=cert.not_valid_after_utc,
        days_remaining=remaining,
        issuer=cert.issuer.rfc4514_string(),
    )


def _chain_to_anchor(
    leaf: x509.Certificate,
    chain: tuple[x509.Certificate, ...],
    anchor: x509.Certificate,
    now: dt.datetime,
) -> None:
    _in_validity(anchor, now, "the trust anchor")
    try:
        constraints = anchor.extensions.get_extension_for_class(x509.BasicConstraints)
        if not constraints.value.ca:
            raise PkiError("the trust anchor is not a CA certificate")
    except x509.ExtensionNotFound as exc:
        raise PkiError("the trust anchor is not a CA certificate") from exc

    fingerprint = anchor.fingerprint(hashes.SHA256())
    pool = [*chain, anchor]
    current = leaf
    for _ in range(len(pool) + 1):
        if current.fingerprint(hashes.SHA256()) == fingerprint:
            return
        issuer = next((c for c in pool if c.subject == current.issuer), None)
        if issuer is None:
            raise PkiError("the signing certificate does not chain to the trust anchor")
        try:
            current.verify_directly_issued_by(issuer)
        except (InvalidSignature, ValueError, TypeError) as exc:
            raise PkiError(
                "the signing certificate is not signed by the trust anchor chain"
            ) from exc
        _in_validity(issuer, now, "an issuing CA certificate")
        current = issuer
    raise PkiError("the signing certificate chain is malformed")


def load_certs(pem_bytes: bytes) -> tuple[x509.Certificate, ...]:
    try:
        return tuple(x509.load_pem_x509_certificates(pem_bytes))
    except ValueError as exc:
        raise PkiError("a certificate file is not valid PEM") from exc


def load_key(pem_bytes: bytes, passphrase: bytes | None = None) -> object:
    try:
        return serialization.load_pem_private_key(pem_bytes, password=passphrase)
    except (ValueError, TypeError) as exc:
        raise PkiError("the signing private key could not be loaded") from exc


# ----------------------------------------------------------------------- CLI


def _write_private(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)


def _emit(out: Path, signer_key: bytes, signer_cert: bytes, root_cert: bytes) -> None:
    _write_private(out / "signer.key.pem", signer_key)
    _write_private(out / "signer.cert.pem", signer_cert)
    _write_private(out / "root-ca.cert.pem", root_cert)
    # Exactly the JSON the infrastructure expects in the engine's signer secret.
    _write_private(
        out / "pki-signer.secret.json",
        json.dumps(
            {
                "certificate_pem": signer_cert.decode(),
                "private_key_pem": signer_key.decode(),
            }
        ).encode(),
    )


def _cmd_init(args: argparse.Namespace) -> int:
    out: Path = args.out
    if out.exists() and any(out.iterdir()):
        print(f"refusing to write into non-empty {out}", file=sys.stderr)
        return 2
    root_key, root_cert = create_root(
        common_name=root_common_name(args.environment),
        organization=args.organization,
    )
    leaf_key, leaf_cert = issue_leaf(
        root_key=root_key,
        root_cert=root_cert,
        common_name=signer_common_name(args.environment),
        organization=args.organization,
    )
    validate_signer_material(cert=leaf_cert, key=leaf_key, anchor=root_cert)
    _emit(out, key_pem(leaf_key), cert_pem(leaf_cert), cert_pem(root_cert))
    # The root key leaves this machine only into the restricted root-key secret.
    _write_private(out / "root-ca.key.pem", key_pem(root_key))
    print(f"wrote DEV PKI to {out}; root CA key: {out / 'root-ca.key.pem'}")
    return 0


def _cmd_renew(args: argparse.Namespace) -> int:
    out: Path = args.out
    if out.exists() and any(out.iterdir()):
        print(f"refusing to write into non-empty {out}", file=sys.stderr)
        return 2
    root_cert = load_certs(args.root_cert.read_bytes())[0]
    root_key = load_key(args.root_key.read_bytes())
    leaf_key, leaf_cert = issue_leaf(
        root_key=root_key,  # type: ignore[arg-type]
        root_cert=root_cert,
        common_name=signer_common_name(args.environment),
        organization=args.organization,
    )
    validate_signer_material(cert=leaf_cert, key=leaf_key, anchor=root_cert)
    _emit(out, key_pem(leaf_key), cert_pem(leaf_cert), cert_pem(root_cert))
    print(f"wrote renewed signer to {out}; root CA unchanged")
    return 0


def _cmd_check(args: argparse.Namespace) -> int:
    chain = load_certs(args.chain.read_bytes()) if args.chain else ()
    anchor = load_certs(args.anchor.read_bytes())[0] if args.anchor else None
    report = validate_signer_material(
        cert=load_certs(args.cert.read_bytes())[0],
        key=load_key(args.key.read_bytes()),
        chain=chain,
        anchor=anchor,
    )
    print(f"OK {report.subject} (issuer {report.issuer})")
    print(f"expires {report.not_after:%Y-%m-%d} ({report.days_remaining} days)")
    if report.days_remaining < _MIN_DAYS_REMAINING_WARNING:
        print("WARNING: renew the signer soon", file=sys.stderr)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m hms_certificate.pki", description=__doc__
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--environment", default="dev", help="names the hierarchy")
        p.add_argument("--organization", default="BAT Engineering Pty Ltd")
        p.add_argument("--out", type=Path, required=True)

    init = sub.add_parser("init", help="create a new root CA and signer")
    common(init)
    init.set_defaults(func=_cmd_init)

    renew = sub.add_parser(
        "renew-leaf", help="issue a new signer under an existing root"
    )
    common(renew)
    renew.add_argument("--root-cert", type=Path, required=True)
    renew.add_argument("--root-key", type=Path, required=True)
    renew.set_defaults(func=_cmd_renew)

    check = sub.add_parser("check", help="validate signing material")
    check.add_argument("--cert", type=Path, required=True)
    check.add_argument("--key", type=Path, required=True)
    check.add_argument("--chain", type=Path)
    check.add_argument("--anchor", type=Path)
    check.set_defaults(func=_cmd_check)

    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except PkiError as exc:
        print(f"FAILED: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
