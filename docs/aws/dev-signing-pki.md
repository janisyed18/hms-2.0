# DEV certificate signing PKI

How the AWS DEV environment signs and verifies certificates. Do **not** release the
API to DEV until this has been provisioned and verified (the deploy workflow
refuses to).

## Why

The backend refuses to issue a certificate, or report one as signed, unless the PDF
signature chains to a configured **trust anchor** (`CERTIFICATE_TRUST_ANCHOR_PEM`).
That anchor must be identical across API/worker tasks and the certificate engine,
and must survive task replacement. A CA generated inside a container does not.

## Hierarchy and who can read what

```
HMS DEV Root CA              (RSA 4096, 10 years)
  private key  -> secret hms-dev-pki-root-ca-key   provisioning only
  certificate  -> secret hms-dev-pki-root-ca-cert  backend tasks + engine (public)
HMS DEV Certificate Signer   (RSA 3072, 825 days, issued by the root)
  cert + key   -> secret hms-dev-pki-signer        certificate engine ONLY
```

| Identity | root CA key | signer key | root CA cert |
|---|---|---|---|
| backend execution/task roles | denied | denied | read |
| certificate engine execution role | denied | read | read |
| certificate engine task role | denied | denied | none |
| GitHub deploy role | denied | denied (`DescribeSecret` metadata only) | `DescribeSecret` metadata only |
| PKI provisioner (MFA, optional role or admin session) | read/write | read/write | read/write |

The root key is never handed to any ECS task. Each secret has `prevent_destroy`, and
the root-key and signer secrets carry explicit `Deny` resource policies on top of the
absence of any grant.

Terraform creates only empty secret containers. **No key material, public or
private, enters Terraform state or plan output.**

## Rollout order

The order matters: ECS will not start a task whose secret has no value.

1. **Apply infrastructure with `pki_enabled = false`** (the default). This creates
   the secrets, roles and policies and the engine task definition. Backend tasks do
   not reference the trust anchor yet, so nothing wedges. Review the plan first.
2. **Provision the PKI** (below) on a trusted workstation.
3. **Verify** the loaded material (below).
4. **Set `pki_enabled` default to `true`** in a reviewed PR, plan, review, apply.
   Backend task definitions now inject `CERTIFICATE_TRUST_ANCHOR_PEM`.
5. Set `certificate_engine_desired_count` to `1` (reviewed apply). The engine starts
   only if its material validates.
6. Only then run **Deploy AWS Dev**. Its preflight checks that both secrets hold a
   current value and that the API task definition injects the trust anchor.

## Provision (first time)

Uses `services/certificate`'s CLI. It only writes local files; loading AWS is a
separate step you can read before running. Use an empty directory on an encrypted
disk.

```bash
cd services/certificate
uv run python -m hms_certificate.pki init --environment dev --out ~/hms-dev-pki
uv run python -m hms_certificate.pki check \
  --cert ~/hms-dev-pki/signer.cert.pem --key ~/hms-dev-pki/signer.key.pem \
  --anchor ~/hms-dev-pki/root-ca.cert.pem
```

Load the secrets (assume the provisioner role / admin session with MFA first):

```bash
P=hms-dev
aws secretsmanager put-secret-value --secret-id $P-pki-root-ca-cert \
  --secret-string file://$HOME/hms-dev-pki/root-ca.cert.pem
aws secretsmanager put-secret-value --secret-id $P-pki-signer \
  --secret-string file://$HOME/hms-dev-pki/pki-signer.secret.json
aws secretsmanager put-secret-value --secret-id $P-pki-root-ca-key \
  --secret-string file://$HOME/hms-dev-pki/root-ca.key.pem
```

Then **shred the local directory** (`rm -P` / `shred`). The root key should now exist
only in `hms-dev-pki-root-ca-key`. Keep a record of the root certificate SHA-256:

```bash
openssl x509 -in ~/hms-dev-pki/root-ca.cert.pem -noout -fingerprint -sha256
```

## Verify before enabling

- `aws secretsmanager describe-secret` shows `AWSCURRENT` for the cert and signer secrets.
- The fingerprint of `get-secret-value` on `hms-dev-pki-root-ca-cert` equals the one recorded above.
- With `pki_enabled = true` and the engine count at 1: the engine log contains
  `signer ... valid until ...` and no startup error; the engine task stays healthy.
- Issue a DEV certificate, open its `/verify/<token>` URL: `valid: true`, `signed: true`.
- Tamper with a *copy* of the PDF and confirm the digest/signature checks reject it.
- Confirm a deliberately wrong secret fails closed: the engine must exit at startup
  (key/certificate mismatch, untrusted chain, expired signer), never serve.

## Renew the signer (root unchanged)

Needs the root key, so run from the provisioner identity only.

```bash
aws secretsmanager get-secret-value --secret-id hms-dev-pki-root-ca-key \
  --query SecretString --output text > /secure/root-ca.key.pem
aws secretsmanager get-secret-value --secret-id hms-dev-pki-root-ca-cert \
  --query SecretString --output text > /secure/root-ca.cert.pem
cd services/certificate
uv run python -m hms_certificate.pki renew-leaf --environment dev \
  --root-cert /secure/root-ca.cert.pem --root-key /secure/root-ca.key.pem \
  --out ~/hms-dev-pki-renewed
aws secretsmanager put-secret-value --secret-id hms-dev-pki-signer \
  --secret-string file://$HOME/hms-dev-pki-renewed/pki-signer.secret.json
```

Shred the temporary files, then force a new engine deployment. Certificates signed by
the previous signer keep verifying, because trust is evaluated at each certificate's
`issued_at` against the unchanged root. Renew before the signer's expiry; the engine
logs the remaining days at startup and `pki check` warns under 30 days.

## Replacing the root (rare, deliberate)

A new root changes the trust anchor, so every certificate issued under the old root
stops verifying until its anchor is kept. Do not do this casually: it needs a decision
about historical certificates (for example, keep the old root as an additional anchor,
which the backend does not yet support). Treat as a design change, not a rotation.

## Failure modes

| Symptom | Meaning |
|---|---|
| Engine task fails with `ResourceInitializationError` | a referenced secret has no value: provision first |
| Engine exits: key does not match certificate / does not chain to trust anchor / expired | the signer secret and root secret disagree or the signer expired |
| Issue returns 503 "not signed by a trusted signer" | backend trust anchor differs from the signer's root, or `pki_enabled` is still false |
| Deploy preflight: "no current value" | PKI not provisioned yet |

## Scope notes

DEV only. The names ("HMS DEV Root CA") deliberately cannot be confused with a future
staging or production hierarchy, which should use separate secrets, a separate root and
likely KMS/HSM-backed keys. Revocation, RFC 3161 trusted timestamping and customer-managed
KMS keys on these secrets are production hardening, not covered here.
