"""Development-only PKI material.

Generates a small two-tier PKI — a self-signed **root CA** and a **leaf signing
certificate** issued by that CA — so the engine produces genuinely signed PDFs
whose signatures validate as *trusted* (the CA acts as the trust anchor) with
zero setup. This is for local development and tests ONLY.

In staging/production set ``HMS_CERT_SIGNING_CERT_PATH`` / ``_KEY_PATH`` /
``_CHAIN_PATH`` from OCI Vault and leave ``HMS_CERT_DEV_AUTOGENERATE_SIGNER=false``.
Existing key material is never overwritten.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

_CA_CERT = "dev-ca.cert.pem"
_LEAF_KEY = "dev-signer.key.pem"
_LEAF_CERT = "dev-signer.cert.pem"


@dataclass(frozen=True)
class SignerMaterial:
    cert_path: Path  # leaf signing certificate
    key_path: Path  # leaf private key
    # Intermediate CA certs to EMBED in the CMS. A self-signed root is never
    # embedded — verifiers supply it as a trust anchor instead (``trust_anchor``).
    chain_paths: tuple[Path, ...]
    trust_anchor_path: Path | None = None  # root CA, for verifiers


def ensure_dev_signer(
    key_dir: Path,
    *,
    common_name: str,
    organization: str,
    validity_days: int = 825,
) -> SignerMaterial:
    """Return signer material, generating a CA + leaf on first use (idempotent)."""
    key_dir.mkdir(parents=True, exist_ok=True)
    ca_cert_path = key_dir / _CA_CERT
    leaf_cert_path = key_dir / _LEAF_CERT
    leaf_key_path = key_dir / _LEAF_KEY
    existing = [p for p in (ca_cert_path, leaf_cert_path, leaf_key_path) if p.exists()]
    if existing and len(existing) != 3:
        # A partial set means something deleted or lost part of the PKI. Never
        # mint a replacement CA silently: every certificate signed so far would
        # stop verifying against the trust anchor the backend has configured.
        raise RuntimeError(
            f"incomplete development signing material in {key_dir}; restore the "
            "missing files or remove the directory deliberately to start a new CA"
        )
    if len(existing) == 3:
        return SignerMaterial(
            cert_path=leaf_cert_path,
            key_path=leaf_key_path,
            chain_paths=(),
            trust_anchor_path=ca_cert_path,
        )

    now = dt.datetime.now(dt.UTC)

    # --- Root CA ---
    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=4096)
    ca_name = x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, f"{organization} Root CA"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, organization),
        ]
    )
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(ca_name)
        .issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        .not_valid_after(now + dt.timedelta(days=validity_days * 4))
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
            x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )

    # --- Leaf signer, issued by the CA ---
    leaf_key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    leaf_name = x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, common_name),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, organization),
            x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, "Certificate Engine"),
        ]
    )
    leaf_cert = (
        x509.CertificateBuilder()
        .subject_name(leaf_name)
        .issuer_name(ca_name)
        .public_key(leaf_key.public_key())
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
                [
                    ExtendedKeyUsageOID.EMAIL_PROTECTION,
                    # 1.3.6.1.5.5.7.3.36 = id-kp-documentSigning
                    x509.ObjectIdentifier("1.3.6.1.5.5.7.3.36"),
                ]
            ),
            critical=False,
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),
            critical=False,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(leaf_key.public_key()),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )

    ca_cert_path.write_bytes(ca_cert.public_bytes(serialization.Encoding.PEM))
    leaf_cert_path.write_bytes(leaf_cert.public_bytes(serialization.Encoding.PEM))
    leaf_key_path.write_bytes(
        leaf_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    leaf_key_path.chmod(0o600)
    return SignerMaterial(
        cert_path=leaf_cert_path,
        key_path=leaf_key_path,
        chain_paths=(),
        trust_anchor_path=ca_cert_path,
    )


def main(argv: list[str] | None = None) -> int:
    """Provision the DEV signing PKI once and print the public trust anchor path.

    Idempotent and never overwrites existing material. Store the key/cert in your
    secret manager and mount them via ``HMS_CERT_SIGNING_*``; give the backend only
    the public ``dev-ca.cert.pem`` as ``CERTIFICATE_TRUST_ANCHOR_PATH``.
    """
    import argparse

    parser = argparse.ArgumentParser(description=main.__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--organization", default="BAT Engineering Pty Ltd")
    args = parser.parse_args(argv)
    material = ensure_dev_signer(
        args.out,
        common_name=f"{args.organization} Certificate Signer",
        organization=args.organization,
    )
    print(f"trust anchor (public): {material.trust_anchor_path}")
    print(f"signing certificate:   {material.cert_path}")
    print(f"signing key (SECRET):  {material.key_path}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
