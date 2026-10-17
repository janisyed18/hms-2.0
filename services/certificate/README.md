# HMS 2.0 Certificate Engine

A stateless **gRPC** service that renders hose assembly test certificates as
**archival PDFs** and **cryptographically signs** them (PAdES / X.509). It owns
document production and signing only — persistence, authorization, and object
storage stay in the backend.

## What it produces

For each `Render` call the engine returns:

- A multi-section A4 certificate PDF: issuer header, result summary band,
  customer/site, hose assembly, end configuration, pressure test, inspection &
  approval, and an authenticity block with a **QR code** to the public verify
  URL and the **SHA-256 verification hash**.
- Embedded TrueType fonts (when available) + document metadata for archival use.
- A **PAdES baseline** digital signature with a visible signature block, so any
  post-signing modification invalidates the signature.
- The deterministic verification hash, computed over the certificate's
  content-bearing fields (see `domain.canonical_payload`). The backend recomputes
  the same hash at the public verify endpoint — the algorithm is mirrored and
  guarded by a shared test vector.

## Layout

```
proto/certificate.proto        gRPC contract (source of truth)
src/hms_certificate/
  server.py      gRPC server bootstrap (+ health & reflection)
  service.py     CertificateEngine servicer: render + sign
  rendering.py   ReportLab PDF layout
  signing.py     pyHanko PAdES/X.509 signing
  dev_ca.py      dev-only self-signed CA + leaf signer generation
  domain.py      typed model + canonical verification hash
  fonts.py       embeddable-font registration
  config.py      settings (HMS_CERT_* env vars)
  proto/         generated stubs (regenerate via scripts/gen_proto.sh)
tests/           rendering, signing, hash, and servicer tests
```

## Signing trust (DEV and above)

The backend verifies every certificate PDF's signature against a **public trust
anchor** (`CERTIFICATE_TRUST_ANCHOR_PATH`, a PEM CA certificate) and refuses to
issue, or report `signed`, without one. The anchor must therefore be stable:

```bash
uv run python -m hms_certificate.dev_ca --out ./dev-pki   # idempotent, never overwrites
```

Keep `dev-signer.key.pem` / `dev-signer.cert.pem` in your secret store and mount
them with `HMS_CERT_SIGNING_CERT_PATH` / `_KEY_PATH` (set
`HMS_CERT_DEV_AUTOGENERATE_SIGNER=false` on any deployed engine so a restart can
never mint a new CA). Give the backend only the public `dev-ca.cert.pem`. If the
files are only partly present, the engine refuses to start rather than replace
the CA.

## Run locally

```bash
cd services/certificate
uv sync                    # or: pip install -e ".[dev]"
uv run hms-certificate-engine
```

On first start a **development** signing CA + leaf certificate are generated
under `~/.hms/certificate-signing/` (git-ignored). The service listens on
`127.0.0.1:50051` by default and registers gRPC health + reflection, so you can
poke it with `grpcurl`:

```bash
grpcurl -plaintext localhost:50051 list
grpcurl -plaintext localhost:50051 grpc.health.v1.Health/Check
```

The HMS backend calls this service automatically when a certificate is issued
from an approved inspection (`certificate_service_address`, default
`127.0.0.1:50051`).

## Tests & lint

```bash
uv run pytest
uv run ruff check src tests
uv run mypy src
```

## Production notes

- **Never** use the auto-generated dev signer in production. Provision a real
  signing certificate + key (and any intermediates) from **OCI Vault** and set
  `HMS_CERT_SIGNING_CERT_PATH`, `HMS_CERT_SIGNING_KEY_PATH`,
  `HMS_CERT_SIGNING_CHAIN_PATH`, and `HMS_CERT_DEV_AUTOGENERATE_SIGNER=false`.
- Consider adding a trusted timestamp authority (PAdES-T) for long-term validity.
- Signing key material and generated certificates are git-ignored and must never
  be committed.
